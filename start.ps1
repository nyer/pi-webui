#requires -Version 5
# pi-webui control script (Windows PowerShell port of start.sh)
#
#   .\start.ps1 start     start in the background (default)
#   .\start.ps1 stop      stop the running instance
#   .\start.ps1 restart   stop then start
#   .\start.ps1 status    show status + health
#   .\start.ps1 logs      tail the log file
#
# Extra arguments are forwarded to server.mjs, e.g.
#   .\start.ps1 restart --session ~\.pi\agent\sessions\xxx.jsonl
#
# The server is launched detached behind a hidden cmd.exe wrapper whose
# stdout/stderr go to .run\pi-webui.log (the pid file tracks the wrapper;
# `stop` kills the whole tree with taskkill /T).

if ($env:OS -ne 'Windows_NT') {
    Write-Error '[pi-webui] start.ps1 targets Windows; use start.sh instead.'
    exit 1
}

# ---------------------------------------------------------------- setup

$script:App        = 'pi-webui'
$script:Root       = $PSScriptRoot
$script:Server     = Join-Path $script:Root 'server.mjs'
$script:RunDir     = Join-Path $script:Root '.run'
$script:PidFile    = Join-Path $script:RunDir ($script:App + '.pid')
$script:PortFile   = Join-Path $script:RunDir ($script:App + '.port')
$script:HostFile   = Join-Path $script:RunDir ($script:App + '.host')
$script:LogFile    = Join-Path $script:RunDir ($script:App + '.log')
$script:NodeBin    = if ($env:NODE_BIN) { $env:NODE_BIN } else { 'node' }
$script:Port       = if ($env:PI_WEBUI_PORT) { $env:PI_WEBUI_PORT } else { 8787 }
$script:ListenHost = if ($env:PI_WEBUI_HOST) { $env:PI_WEBUI_HOST } else { '127.0.0.1' }
$script:ExitCode   = 0

New-Item -ItemType Directory -Path $script:RunDir -Force | Out-Null
Set-Location -LiteralPath $script:Root

function Show-Usage {
    Write-Host @'
Usage: .\start.ps1 <command> [server options]

Commands:
  start      Start pi-webui in the background (default)
  stop       Stop the running instance (and any stray server.mjs)
  restart    Stop then start
  status     Show pid, URL, and health
  logs       Tail .run\pi-webui.log (Ctrl+C to stop)

Server options are forwarded to server.mjs, e.g. --port, --host,
--session, --provider, --model, --thinking.

start.ps1 options:
  --public   bind to 0.0.0.0 (accessible from other devices on the network)
             Shorthand for --host 0.0.0.0 -- but the server has NO built-in
             auth, so do not expose publicly without adding your own.

Environment:
  PI_WEBUI_PORT          listen port           (default 8787)
  PI_WEBUI_HOST          bind host             (default 127.0.0.1)
  PI_WEBUI_SESSIONS_ROOT sessions directory    (default ~\.pi\agent\sessions)
  PI_WEBUI_FORK=1        always fork PI_SESSION_FILE into a new session
                         (default: reuse this project's newest session)
  PI_SESSION_FILE        session to fork for context (auto-detected)
  PI_PROVIDER            provider              (auto-detected)
  PI_MODEL               model                 (auto-detected)
  PI_REASONING_LEVEL     thinking level        (auto-detected)
  NODE_BIN               node binary           (default: node)

Examples:
  .\start.ps1
  .\start.ps1 restart
  $env:PI_WEBUI_PORT = '9000'; .\start.ps1 restart
  .\start.ps1 start --session ~\.pi\agent\sessions\xxx.jsonl
  .\start.ps1 start --public       # listen on all interfaces (0.0.0.0)
'@
}

# ---------------------------------------------------------------- helpers

function Get-TrackedPid {
    if (-not (Test-Path -LiteralPath $script:PidFile)) { return $null }
    $v = Get-Content -LiteralPath $script:PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $n = 0
    if ($v -and [int]::TryParse("$v".Trim(), [ref]$n)) { return $n }
    return $null
}

function Test-Running {
    $appPid = Get-TrackedPid
    if (-not $appPid) { return $false }
    return [bool](Get-Process -Id $appPid -ErrorAction SilentlyContinue)
}

# server.mjs processes not tracked by our pid file (started by hand, etc.)
function Get-StrayPids {
    $found = @()
    try {
        $found = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and ($_.CommandLine -match 'server\.mjs') } |
            ForEach-Object { [int]$_.ProcessId }
    } catch { }
    return @($found)
}

function Get-Health {
    $checkHost = $script:ListenHost
    if ($checkHost -eq '0.0.0.0') { $checkHost = '127.0.0.1' }
    $url = "http://${checkHost}:$($script:Port)/health"
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { return [string]$resp.Content }
    } catch { }
    return $null
}

# status/logs should reflect the port/host the instance was actually started with
function Update-RuntimeEnv {
    if (Test-Path -LiteralPath $script:PortFile) {
        $v = Get-Content -LiteralPath $script:PortFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($v) { $script:Port = "$v".Trim() }
    }
    if (Test-Path -LiteralPath $script:HostFile) {
        $v = Get-Content -LiteralPath $script:HostFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($v) { $script:ListenHost = "$v".Trim() }
    }
}

function Wait-Gone {
    param([int]$ProcId, [int]$Attempts = 25)
    for ($i = 0; $i -lt $Attempts; $i++) {
        if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue))
}

function Stop-Tree {
    param([int]$ProcId, [switch]$Force)
    $taskArgs = @('/PID', $ProcId, '/T')
    if ($Force) { $taskArgs += '/F' }
    & "$env:SystemRoot\System32\taskkill.exe" @taskArgs 2>$null | Out-Null
}

# ---------------------------------------------------------------- commands

function Invoke-Start {
    param([string[]]$Fwd = @())

    Update-RuntimeEnv   # report the port/host the instance actually runs on
    if (Test-Running) {
        Write-Host "[$($script:App)] already running (pid $(Get-TrackedPid)) -> http://$($script:ListenHost):$($script:Port)"
        return
    }
    Remove-Item -LiteralPath $script:PidFile -ErrorAction SilentlyContinue

    # let --port/--host in the forwarded args drive the health check too
    for ($i = 0; $i -lt ($Fwd.Count - 1); $i++) {
        if ($Fwd[$i] -eq '--port') { $script:Port = $Fwd[$i + 1] }
        elseif ($Fwd[$i] -eq '--host') { $script:ListenHost = $Fwd[$i + 1] }
    }

    # Reuse this project's most recent session instead of forking a fresh copy
    # on every restart (which piled up duplicate fork chains). Set
    # PI_WEBUI_FORK=1 to force a new fork of PI_SESSION_FILE.
    $serverArgs = New-Object 'System.Collections.Generic.List[string]'
    $sessionsRoot = if ($env:PI_WEBUI_SESSIONS_ROOT) { $env:PI_WEBUI_SESSIONS_ROOT }
                    else { Join-Path $HOME '.pi\agent\sessions' }
    # project dir name mirrors pi: C:\Users\x\proj -> --C--Users-x--proj--
    $projName = ($script:Root -replace '^[\\/]', '') -replace '[\\/:]', '-'
    $projDir = Join-Path $sessionsRoot "--$projName--"
    $newest = Get-ChildItem -LiteralPath $projDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1

    if ($env:PI_WEBUI_FORK -eq '1' -and $env:PI_SESSION_FILE) {
        $serverArgs.AddRange([string[]]@('--fork', $env:PI_SESSION_FILE))
    } elseif ($newest) {
        $serverArgs.AddRange([string[]]@('--session', $newest.FullName))
    } elseif ($env:PI_SESSION_FILE) {
        $serverArgs.AddRange([string[]]@('--fork', $env:PI_SESSION_FILE))
    }

    if ($env:PI_PROVIDER)        { $serverArgs.AddRange([string[]]@('--provider', $env:PI_PROVIDER)) }
    if ($env:PI_MODEL)           { $serverArgs.AddRange([string[]]@('--model', $env:PI_MODEL)) }
    if ($env:PI_REASONING_LEVEL) { $serverArgs.AddRange([string[]]@('--thinking', $env:PI_REASONING_LEVEL)) }
    if ($Fwd -and $Fwd.Count -gt 0) { $serverArgs.AddRange([string[]]$Fwd) }

    # server.mjs falls back to these env vars; pass the effective values
    $env:PI_WEBUI_PORT = "$($script:Port)"
    $env:PI_WEBUI_HOST = "$($script:ListenHost)"

    # hidden cmd.exe wrapper: node ... > log 2>&1, detached from this console
    $argParts = foreach ($a in $serverArgs) { if ("$a" -match '\s') { '"{0}"' -f $a } else { "$a" } }
    $argString = (@($argParts) -join ' ').Trim()
    $cmdLine = '/d /s /c ""{0}" "{1}"{2} > "{3}" 2>&1"' -f $script:NodeBin, $script:Server, `
        $(if ($argString) { ' ' + $argString } else { '' }), $script:LogFile

    Write-Host "[$($script:App)] starting on $($script:ListenHost):$($script:Port)"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = $cmdLine
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.WorkingDirectory = $script:Root
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Write-Host "[$($script:App)] failed to start: $($_.Exception.Message)"
        $script:ExitCode = 1
        return
    }
    $procId = $proc.Id

    Set-Content -LiteralPath $script:PidFile  -Value $procId
    Set-Content -LiteralPath $script:PortFile -Value $script:Port
    Set-Content -LiteralPath $script:HostFile -Value $script:ListenHost

    for ($i = 0; $i -lt 40; $i++) {
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
            Write-Host "[$($script:App)] failed to start. Last log lines:"
            if (Test-Path -LiteralPath $script:LogFile) {
                Get-Content -LiteralPath $script:LogFile -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue |
                    ForEach-Object { Write-Host $_ }
            }
            Remove-Item -LiteralPath $script:PidFile, $script:PortFile, $script:HostFile -ErrorAction SilentlyContinue
            $script:ExitCode = 1
            return
        }
        if (Get-Health) {
            Write-Host "[$($script:App)] started (pid $procId) -> http://$($script:ListenHost):$($script:Port)"
            Write-Host "[$($script:App)] log: $($script:LogFile)"
            return
        }
        Start-Sleep -Milliseconds 200
    }
    Write-Host "[$($script:App)] started (pid $procId) but health check timed out; see $($script:LogFile)"
}

function Invoke-Stop {
    $stopped = $false

    if (Test-Running) {
        $appPid = Get-TrackedPid
        Write-Host "[$($script:App)] stopping (pid $appPid)"
        Stop-Tree -ProcId $appPid
        if (-not (Wait-Gone -ProcId $appPid -Attempts 10)) {
            Write-Host "[$($script:App)] force killing (pid $appPid)"
            Stop-Tree -ProcId $appPid -Force
            Wait-Gone -ProcId $appPid | Out-Null
        }
        $stopped = $true
    }
    Remove-Item -LiteralPath $script:PidFile, $script:PortFile, $script:HostFile -ErrorAction SilentlyContinue

    $stray = Get-StrayPids
    if ($stray.Count -gt 0) {
        Write-Host "[$($script:App)] stopping stray instance(s): $($stray -join ' ')"
        foreach ($sp in $stray) { Stop-Tree -ProcId $sp }
        Start-Sleep -Seconds 1
        $stray = Get-StrayPids
        if ($stray.Count -gt 0) { foreach ($sp in $stray) { Stop-Tree -ProcId $sp -Force } }
        $stopped = $true
    }

    if ($stopped) { Write-Host "[$($script:App)] stopped" } else { Write-Host "[$($script:App)] not running" }
}

function Show-Status {
    Update-RuntimeEnv
    if (Test-Running) {
        Write-Host "[$($script:App)] running (pid $(Get-TrackedPid))"
        Write-Host "  url:    http://$($script:ListenHost):$($script:Port)"
        $h = Get-Health
        Write-Host "  health: $(if ($h) { $h } else { 'unreachable' })"
        Write-Host "  log:    $($script:LogFile)"
    } else {
        Write-Host "[$($script:App)] stopped"
        $stray = Get-StrayPids
        if ($stray.Count -gt 0) {
            Write-Host "  note: untracked server.mjs running: $($stray -join ' ')"
        }
    }
}

function Show-Logs {
    Update-RuntimeEnv
    if (-not (Test-Path -LiteralPath $script:LogFile)) {
        Write-Host "[$($script:App)] no log yet ($($script:LogFile))"
        $script:ExitCode = 1
        return
    }
    Write-Host "[$($script:App)] tailing $($script:LogFile) (Ctrl+C to stop)"
    Get-Content -LiteralPath $script:LogFile -Tail 50 -Wait -Encoding UTF8
}

# ---------------------------------------------------------------- dispatch

$cmd = 'start'
$fwd = @()
if ($args.Count -gt 0) { $cmd = [string]$args[0] }
if ($args.Count -gt 1) { $fwd = $args[1..($args.Count - 1)] }

# --public: shorthand for binding to 0.0.0.0 (filter before forwarding)
$newFwd = @()
foreach ($a in $fwd) {
    if ($a -eq '--public') { $script:ListenHost = '0.0.0.0' }
    else { $newFwd += $a }
}
$fwd = $newFwd

switch ($cmd) {
    'start'   { Invoke-Start -Fwd $fwd }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Stop; Invoke-Start -Fwd $fwd }
    'status'  { Show-Status }
    'logs'    { Show-Logs }
    { $_ -in @('-h', '--help', 'help') } { Show-Usage }
    default {
        Write-Host "[$($script:App)] unknown command: $cmd"
        Write-Host ''
        Show-Usage
        $script:ExitCode = 1
    }
}

exit $script:ExitCode
