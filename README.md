# pi-webui

Browser access to a **pi** coding-agent session.

`pi` itself has no HTTP server — it runs as a TUI or as an RPC protocol over
stdin/stdout (`docs/rpc.md`). This tiny bridge spawns `pi --mode rpc` and exposes
it over HTTP + SSE so you can chat with the agent from a browser.

## Run

Recommended: use the control script.

```bash
./start.sh            # start in the background (default)
./start.sh status     # pid, url, health
./start.sh restart    # stop then start
./start.sh stop       # stop (also cleans up stray server.mjs)
./start.sh logs       # tail the log
./start.sh help       # full usage
```

It writes `.run/pi-webui.pid`, `.run/pi-webui.port`, `.run/pi-webui.host`, and
`.run/pi-webui.log`. `start` is idempotent, waits for `/health` before returning,
and auto-detects `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` /
`PI_REASONING_LEVEL` so it can fork the session you are currently in.

```bash
PI_WEBUI_PORT=9000 ./start.sh restart          # custom port
./start.sh start --session ~/.pi/agent/sessions/xxx.jsonl
./start.sh restart --provider anthropic --model claude-sonnet-4
```

Or run the server directly:

```bash
node server.mjs \
  --fork ~/.pi/agent/sessions/--Users-leiting--/<session>.jsonl \
  --provider deepseek --model deepseek-flash --thinking high
```

Then open <http://127.0.0.1:8787>.

`--fork <session.jsonl>` gives the web session the **current conversation context
as a new branch**, so it never touches the live TUI session. Use `--session <file>`
to attach to an exact session instead (avoid while a TUI is actively writing it).

`start.sh` reuses this project's newest session via `--session` instead of forking
a new copy on every restart (which is what created the duplicate fork chains).
Set `PI_WEBUI_FORK=1` to force a fresh `--fork` of `PI_SESSION_FILE`.

### Windows

On Windows, use the PowerShell port (`start.ps1`; same commands and env vars):

```powershell
.\start.ps1            # start in the background (default)
.\start.ps1 status     # pid, url, health
.\start.ps1 restart    # stop then start
.\start.ps1 stop       # stop (also cleans up stray server.mjs)
.\start.ps1 logs       # tail the log
.\start.ps1 restart --port 8790
```

It writes the same `.run\pi-webui.*` files. `start` launches the server behind
a hidden `cmd.exe` wrapper so it survives closing the terminal, waits for
`/health`, and writes the same pid/port/host files. `stop` kills the whole tree
(`taskkill /T`, graceful attempt then force) plus any untracked `server.mjs`
node processes. On Windows `server.mjs` also runs `pi` (an npm `.cmd` shim)
through `%COMSPEC%`, since node's `spawn` cannot exec `.cmd` shims directly.

### Options / env

| flag | env | default |
|---|---|---|
| `--host` | `PI_WEBUI_HOST` | `127.0.0.1` |
| `--port` | `PI_WEBUI_PORT` | `8787` |
| `--pi-bin` | `PI_WEBUI_PI` | `pi` |
| `--fork` | `PI_SESSION_FILE` (auto, via start.sh) | — |
| `--session` | | — |
| `--provider` / `--model` / `--thinking` | `PI_PROVIDER` / `PI_MODEL` / `PI_REASONING_LEVEL` (auto, via start.sh) | pi defaults |
| | `PI_WEBUI_SESSIONS_ROOT` (server) | `~/.pi/agent/sessions` |
| | `NODE_BIN` (start.sh only) | `node` |

Any extra args are forwarded to `pi`.

## UI

## UI

- **Left sidebar — 历史会话**: lists pi sessions under `~/.pi/agent/sessions/**`
  (title from the session name or first user prompt, project, message count,
  relative time). **Fork chains are collapsed** — repeated `--fork` restarts create
  a new file per run, so files linked by `parentSession` are merged into one entry
  with a `＋N 分支` badge (the active one is preferred as the representative).
  - click a session → switch the running session, then the newest body-text reply
    is revealed and the composer is focused
  - `＋` starts a **new session**, `⟳` refreshes, `×` (hover) moves a session to the
    Trash; the active session can't be deleted
  - the `☰` button in the header collapses/expands the sidebar (auto-collapsed on
    narrow screens, remembered in `localStorage`)
- **Markdown** rendering (pi's bundled `marked` + `highlight.js`), code highlighting,
  tables, task lists; raw HTML is escaped and link schemes are allow-listed.
- Each user turn renders as **one merged reply**: thinking steps and tool calls are
  combined into a single collapsed **“思考与工具调用”** block (click to expand);
  body text stays visible.
- Floating control above the composer: `▲ / ▼` jump between replies with a `n/total`
  counter, `☰` opens the **历史输入** list to jump to any past input. It is positioned
  above the input box so it never covers the composer or Send button.

## Endpoints

| method | path | purpose |
|---|---|---|
| GET | `/` | chat UI |
| GET | `/events` | SSE: pi events + a per-client `snapshot` of history |
| POST | `/prompt` | `{ "message": "...", "behavior": "steer"\|"followUp" }` |
| POST | `/abort` | abort the current run |
| POST | `/ui-response` | answer an `extension_ui_request` dialog |
| GET | `/health` | liveness + streaming flag + current session path |
| GET | `/sessions` | list session files (newest first) + the active one |
| POST | `/switch-session` | `{ "path": "<session.jsonl>" }` — switch session; broadcasts a fresh snapshot to all clients |
| POST | `/new-session` | start a fresh session; broadcasts a snapshot |
| POST | `/delete-session` | `{ "path": "<session.jsonl>" }` — move to Trash (`trash` CLI, else unlink); refuses the active session (409) |

## Notes

- Streaming is text/thinking/toolcalls via `message_update`; tool output via
  `tool_execution_*`; extension dialogs (select/confirm/input/editor) are surfaced
  as a browser modal.
- The RPC JSONL framing is read strictly on `\n` only, per pi's spec.
- Bind is localhost by default. Do not expose publicly without adding auth.
- Session switching writes to the same on-disk session files the TUI uses; the
  server only accepts paths inside `PI_WEBUI_SESSIONS_ROOT` (default
  `~/.pi/agent/sessions`) ending in `.jsonl`.
