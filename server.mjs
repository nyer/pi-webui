#!/usr/bin/env node
/**
 * pi-webui — expose a pi coding-agent session to a browser.
 *
 * It spawns `pi --mode rpc` (the headless JSON protocol) and bridges it to:
 *   GET  /                 chat UI
 *   GET  /events           SSE stream of pi events + a per-client snapshot
 *   POST /prompt           { message, behavior? } -> send a prompt / steer
 *   POST /abort            abort the current run
 *   POST /ui-response      answer an extension_ui_request dialog
 *   GET  /health           liveness
 *
 * Usage:
 *   node server.mjs [--port 8787] [--host 127.0.0.1]
 *                   [--fork <session.jsonl>]      # continue *current* context, new branch
 *                   [--session <session.jsonl>]   # attach to an exact session
 *                   [--provider name] [--model id] [--thinking level]
 */
import http from 'node:http';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { piArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--fork') out.fork = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--thinking') out.thinking = argv[++i];
    else if (a === '--pi-bin') out.piBin = argv[++i];
    else out.piArgs.push(a);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const PORT = opts.port || Number(process.env.PI_WEBUI_PORT) || 8787;
const HOST = opts.host || process.env.PI_WEBUI_HOST || '127.0.0.1';
const PI_BIN = opts.piBin || process.env.PI_WEBUI_PI || 'pi';

const piArgs = ['--mode', 'rpc'];
if (opts.provider) piArgs.push('--provider', opts.provider);
if (opts.model) piArgs.push('--model', opts.model);
if (opts.thinking) piArgs.push('--thinking', opts.thinking);
if (opts.session) piArgs.push('--session', opts.session);
else if (opts.fork) piArgs.push('--fork', opts.fork);
piArgs.push(...opts.piArgs);

console.log(`[pi-webui] spawning: ${PI_BIN} ${piArgs.join(' ')}`);

/* On Windows, npm installs `pi` as pi.cmd / pi (sh shim); node's spawn can't
 * exec either (no PATHEXT resolution, .cmd needs a shell). Route through
 * %COMSPEC% instead: windowsVerbatimArguments gives exact control of the
 * command line, and the extra outer quote pair makes cmd /s strip only the
 * wrapper quotes, leaving per-arg quoting intact. */
const ON_WINDOWS = process.platform === 'win32';
const quoteCmdArg = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
function spawnPi(bin, args, opts) {
  if (!ON_WINDOWS) return spawn(bin, args, opts);
  const line = [bin, ...args].map(quoteCmdArg).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
    { ...opts, windowsVerbatimArguments: true });
}

const child = spawnPi(PI_BIN, piArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PI_CODING_AGENT: 'true' },
});

/* ------------------------------------------------------------------ */
/* pi -> server                                                        */
/* ------------------------------------------------------------------ */

let isStreaming = false;

/** @type {Set<import('node:http').ServerResponse>} */
const clients = new Set();
/** @type {Map<string, import('node:http').ServerResponse>} */
const pendingInit = new Map();
let clientSeq = 0;
let cmdSeq = 0;
let refreshPending = null;
let pendingAction = null;

function sseSend(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch { /* client went away */ }
}

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { /* ignore */ }
  }
}

function sendCommand(cmd) {
  if (!child.stdin || child.stdin.destroyed) return false;
  child.stdin.write(JSON.stringify(cmd) + '\n');
  return true;
}

/** Pending command-reply resolvers (for GET /api/models etc.). id -> { resolve, reject, timer } */
const pendingReplies = new Map();

function sendCommandAndWait(cmd, timeout = 8000) {
  const id = cmd.id || ('req-' + (++cmdSeq));
  cmd.id = id;
  return new Promise((resolve, reject) => {
    if (!child || !child.stdin || child.stdin.destroyed) return reject(new Error('pi not connected'));
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      reject(new Error('timeout'));
    }, timeout);
    pendingReplies.set(id, { resolve, reject, timer });
    if (!sendCommand(cmd)) {
      clearTimeout(timer);
      pendingReplies.delete(id);
      reject(new Error('stdin write failed'));
    }
  });
}
function refreshAllClients() {
  const base = 'refresh-' + (++cmdSeq);
  refreshPending = { stateId: base + '-state', msgsId: base + '-messages', state: null };
  sendCommand({ id: refreshPending.stateId, type: 'get_state' });
  sendCommand({ id: refreshPending.msgsId, type: 'get_messages' });
}

// Strict JSONL reader: split on \n only (per pi RPC framing rules).
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length) onLine(line);
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.length) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
  });
}

function routePiEvent(ev) {
  // Track streaming state.
  if (ev.type === 'agent_start') isStreaming = true;
  if (ev.type === 'agent_settled' || ev.type === 'agent_end') isStreaming = false;

  // Remember the active session file across every get_state response.
  if (ev.type === 'response' && ev.command === 'get_state' && ev.data && ev.data.sessionFile) {
    currentSessionPath = ev.data.sessionFile;
  }

  // Result of switch_session / new_session -> refresh everyone's view.
  if (pendingAction && ev.type === 'response' && ev.id === pendingAction.id) {
    const kind = pendingAction.kind;
    const ok = ev.success !== false && !(ev.data && ev.data.cancelled);
    pendingAction = null;
    if (ok) refreshAllClients();
    else broadcast({ type: 'stderr', text: kind + ' failed: ' + (ev.error || 'cancelled') });
    return;
  }

  // Shared refresh responses (after a session switch) -> broadcast one snapshot.
  if (refreshPending && ev.type === 'response' && ev.id) {
    if (ev.id === refreshPending.stateId) {
      refreshPending.state = ev.data || null;
      return;
    }
    if (ev.id === refreshPending.msgsId) {
      broadcast({ type: 'snapshot', messages: (ev.data && ev.data.messages) || [], state: refreshPending.state });
      refreshPending = null;
      return;
    }
  }

  // Route init responses back to the requesting client only.
  if (ev.type === 'response' && ev.id && pendingInit.has(ev.id)) {
    const res = pendingInit.get(ev.id);
    if (ev.command === 'get_state') {
      res._piState = ev.data;
      pendingInit.delete(ev.id);
    } else if (ev.command === 'get_messages') {
      sseSend(res, { type: 'snapshot', messages: ev.data?.messages ?? [], state: res._piState ?? null });
      pendingInit.delete(ev.id);
    } else {
      pendingInit.delete(ev.id);
    }
    return;
  }

  // Pending command replies (e.g., API models request).
  if (ev.type === 'response' && ev.id && pendingReplies.has(ev.id)) {
    const p = pendingReplies.get(ev.id);
    clearTimeout(p.timer);
    pendingReplies.delete(ev.id);
    p.resolve(ev.data || ev);
    return;
  }

  // After a model change, refresh all clients so the UI picks up the new model.
  if (ev.type === 'response' && ev.id && (ev.command === 'set_model' || ev.command === 'cycle_model') && ev.success !== false) {
    refreshAllClients();
    return;
  }

  broadcast(ev);
}

attachJsonlReader(child.stdout, (line) => {
  try {
    routePiEvent(JSON.parse(line));
  } catch (err) {
    console.error('[pi-webui] bad JSON from pi:', line.slice(0, 200));
  }
});

child.stderr.on('data', (d) => {
  const text = d.toString();
  process.stderr.write(text);
  broadcast({ type: 'stderr', text });
});

// Prime the active-session path so /health and /sessions are correct before any client connects.
setTimeout(() => sendCommand({ id: 'boot-' + (++cmdSeq), type: 'get_state' }), 300);

child.on('exit', (code, signal) => {
  isStreaming = false;
  console.log(`[pi-webui] pi exited code=${code} signal=${signal}`);
  broadcast({ type: 'pi_exit', code, signal });
});

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* session listing (filesystem)                                        */
/* ------------------------------------------------------------------ */

const SESSIONS_ROOT = process.env.PI_WEBUI_SESSIONS_ROOT
  || path.join(os.homedir(), '.pi', 'agent', 'sessions');

const sessionCache = new Map(); // path -> { mtime, size, info }
let currentSessionPath = null;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
  }
  return '';
}

function sessionFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(SESSIONS_ROOT, d.name);
    let files = [];
    try { files = fs.readdirSync(projDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(projDir, f);
      try {
        const st = fs.statSync(full);
        out.push({ path: full, project: d.name, mtime: st.mtimeMs, size: st.size });
      } catch { /* ignore */ }
    }
  }
  return out;
}

function readSessionInfo(entry) {
  const cached = sessionCache.get(entry.path);
  if (cached && cached.mtime === entry.mtime && cached.size === entry.size) return cached.info;

  const info = {
    path: entry.path,
    project: entry.project,
    mtime: entry.mtime,
    size: entry.size,
    id: null,
    name: null,
    cwd: null,
    parentSession: null,
    messages: 0,
    firstUser: null,
    lastTs: null,
  };

  try {
    const lines = fs.readFileSync(entry.path, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.timestamp) info.lastTs = e.timestamp;
      switch (e.type) {
        case 'session':
          info.id = e.id || null;
          info.cwd = e.cwd || null;
          info.parentSession = e.parentSession || null;
          break;
        case 'session_info':
          if (e.name) info.name = e.name;
          break;
        case 'message': {
          const m = e.message || {};
          if (m.role === 'user' || m.role === 'assistant') info.messages++;
          if (m.role === 'user' && !info.firstUser) {
            const t = textOfContent(m.content).replace(/\s+/g, ' ').trim();
            if (t) info.firstUser = t;
          }
          break;
        }
      }
    }
  } catch { /* unreadable */ }

  info.title = info.name || info.firstUser || '(空会话)';
  sessionCache.set(entry.path, { mtime: entry.mtime, size: entry.size, info });
  return info;
}

/** Validate + normalise a session path coming from a client. */
function resolveSessionPath(p) {
  const target = path.resolve(String(p || ''));
  const root = path.resolve(SESSIONS_ROOT);
  if (!target.startsWith(root + path.sep) || !target.endsWith('.jsonl')) return null;
  if (!fs.existsSync(target)) return null;
  return target;
}

/**
 * Collapse fork chains. `--fork` produces a new file each time, so the same
 * conversation ends up as N files linked by `parentSession`; keep one entry per
 * chain (preferring the active session, else the newest) and report the count.
 */
function groupSessions(infos) {
  const byPath = new Map(infos.map((i) => [i.path, i]));
  const rootOf = (info) => {
    let cur = info;
    const guard = new Set();
    while (cur && cur.parentSession && byPath.has(cur.parentSession) && !guard.has(cur.parentSession)) {
      guard.add(cur.parentSession);
      cur = byPath.get(cur.parentSession);
    }
    return cur ? cur.path : info.path;
  };

  const groups = new Map();
  for (const info of infos) {
    const root = rootOf(info);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(info);
  }

  const out = [];
  for (const members of groups.values()) {
    members.sort((a, b) => b.mtime - a.mtime);
    const rep = members.find((m) => m.path === currentSessionPath) || members[0];
    out.push({ ...rep, forks: members.length });
  }
  return out;
}

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

/**
 * Serve the app shell. Read it fresh on every request and forbid caching so a
 * reload always picks up the current UI (mobile Firefox caches HTML hard when
 * no Cache-Control is sent).
 */
function serveIndex(res) {
  fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html unavailable');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(html);
  });
}

// Locate the marked + highlight.js bundles that pi ships for its HTML export,
// so the browser gets the exact same Markdown pipeline as `pi --export`.
// A local copy under public/vendor takes priority so the webui works even when
// the pi install layout can't be auto-detected.
function isVendorDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'marked.min.js')) && fs.existsSync(path.join(dir, 'highlight.min.js'));
}

function findVendorDir() {
  const localVendor = path.join(__dirname, 'public', 'vendor');
  if (isVendorDir(localVendor)) return localVendor;

  const candidates = [];
  if (process.env.PI_WEBUI_VENDOR) candidates.push(process.env.PI_WEBUI_VENDOR);
  if (process.env.PI_WEBUI_PI) candidates.push(process.env.PI_WEBUI_PI);
  try {
    const which = ON_WINDOWS ? 'where pi' : 'command -v pi';
    execSync(which, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .split(/\r?\n/).filter(Boolean).forEach((line) => candidates.push(line));
  } catch { /* ignore */ }

  const probeDirs = [];
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      const dir = path.dirname(real);
      probeDirs.push(
        // `pi` lives next to the package: <pkg>/bin/pi -> ../dist/core/export-html/vendor
        path.join(dir, '..', 'dist', 'core', 'export-html', 'vendor'),
        // resolved npm bin shim -> <pkg>/dist/bundle/cli.js
        path.join(dir, '..', 'core', 'export-html', 'vendor'),
        // <pkg>/dist/bundle/cli.js when invoked via the package root
        path.join(dir, 'core', 'export-html', 'vendor'),
        // Windows npm global install: shim sits in <npm>/, package under node_modules
        path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'export-html', 'vendor'),
      );
      // Managed install: <agent>/bin/pi -> <agent>/install/releases/<version>/...
      const agentDir = path.dirname(dir);
      const versionFile = path.join(agentDir, 'install', 'current-version');
      if (fs.existsSync(versionFile)) {
        const version = fs.readFileSync(versionFile, 'utf8').trim();
        if (/^[0-9A-Za-z._+-]+$/.test(version)) {
          probeDirs.push(path.join(agentDir, 'install', 'releases', version,
            'node_modules', '@earendil-works', 'pi-coding-agent',
            'dist', 'core', 'export-html', 'vendor'));
        }
      }
    } catch { /* ignore */ }
  }
  for (const d of probeDirs) {
    if (isVendorDir(d)) return d;
  }

  // Last resort: scan known managed-install release directories.
  const releasesRoot = path.join(os.homedir(), '.pi', 'agent', 'install', 'releases');
  try {
    for (const rel of fs.readdirSync(releasesRoot)) {
      const d = path.join(releasesRoot, rel, 'node_modules', '@earendil-works',
        'pi-coding-agent', 'dist', 'core', 'export-html', 'vendor');
      if (isVendorDir(d)) return d;
    }
  } catch { /* ignore */ }

  return null;
}
const VENDOR_DIR = findVendorDir();
console.log(VENDOR_DIR ? `[pi-webui] markdown vendor: ${VENDOR_DIR}` : '[pi-webui] markdown vendor not found (frontend falls back to built-in renderer)');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    serveIndex(res);
    return;
  }

  // Static files under public/ (e.g. /doudizhu or /doudizhu.html).
  if (req.method === 'GET') {
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel && !rel.split(/[\\/]/).includes('..')) {
      let file = path.join(__dirname, 'public', rel);
      if (!path.extname(file)) file += '.html';
      const publicRoot = path.join(__dirname, 'public') + path.sep;
      if (file.startsWith(publicRoot) && path.basename(file) !== 'index.html' && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.webmanifest': 'application/manifest+json',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
        }[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
    const name = path.basename(url.pathname);
    const file = VENDOR_DIR && path.join(VENDOR_DIR, name);
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'vendor asset not found' });
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, streaming: isStreaming, clients: clients.size, session: currentSessionPath });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/sessions') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const sessions = groupSessions(sessionFiles().map(readSessionInfo))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    json(res, 200, { root: SESSIONS_ROOT, current: currentSessionPath, sessions });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/switch-session') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    const target = resolveSessionPath(body.path);
    if (!target) return json(res, 400, { error: 'invalid session path' });
    pendingAction = { kind: 'switch_session', id: 'switch-' + (++cmdSeq) };
    sendCommand({ id: pendingAction.id, type: 'switch_session', sessionPath: target });
    return json(res, 200, { ok: true, path: target });
  }

  if (req.method === 'POST' && url.pathname === '/new-session') {
    pendingAction = { kind: 'new_session', id: 'new-' + (++cmdSeq) };
    sendCommand({ id: pendingAction.id, type: 'new_session' });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/delete-session') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    const target = resolveSessionPath(body.path);
    if (!target) return json(res, 400, { error: 'invalid session path' });
    if (currentSessionPath && path.resolve(currentSessionPath) === target) {
      return json(res, 409, { error: '当前会话正在使用，无法删除' });
    }
    if (!fs.existsSync(target)) return json(res, 404, { error: 'not found' });
    let via = 'unlink';
    try {
      execFileSync('trash', [target], { stdio: 'ignore' }); // recoverable when available
      via = 'trash';
    } catch {
      try { fs.unlinkSync(target); } catch (err) { return json(res, 500, { error: String(err.message || err) }); }
    }
    sessionCache.delete(target);
    if (currentSessionPath === target) currentSessionPath = null;
    return json(res, 200, { ok: true, via });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);

    const clientId = `c${++clientSeq}`;
    const stateId = `${clientId}-state`;
    const msgsId = `${clientId}-messages`;
    pendingInit.set(stateId, res);
    pendingInit.set(msgsId, res);
    sendCommand({ id: stateId, type: 'get_state' });
    sendCommand({ id: msgsId, type: 'get_messages' });

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      pendingInit.delete(stateId);
      pendingInit.delete(msgsId);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/prompt') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    const cmd = { type: 'prompt' };
    const message = (body.message ?? '').toString().trim();
    const images = body.images;
    if (!message && (!images || !images.length)) return json(res, 400, { error: 'empty message' });
    if (message) cmd.message = message;
    if (isStreaming) cmd.streamingBehavior = body.behavior === 'followUp' ? 'followUp' : 'steer';
    if (images && Array.isArray(images) && images.length) {
      cmd.images = images.map((img) => ({
        type: 'image',
        data: String(img.data || ''),
        mimeType: String(img.mimeType || 'image/png'),
      }));
    }
    sendCommand(cmd);
    return json(res, 200, { ok: true, streaming: isStreaming });
  }

  if (req.method === 'POST' && url.pathname === '/abort') {
    sendCommand({ type: 'abort' });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/ui-response') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    sendCommand({ type: 'extension_ui_response', ...body });
    return json(res, 200, { ok: true });
  }

  /* ---- model API ---- */

  if (req.method === 'POST' && url.pathname === '/api/cycle-model') {
    sendCommand({ id: 'cycle-model-' + (++cmdSeq), type: 'cycle_model' });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/set-model') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    if (!body.provider || !body.modelId) return json(res, 400, { error: 'provider and modelId required' });
    sendCommand({ id: 'set-model-' + (++cmdSeq), type: 'set_model', provider: body.provider, modelId: body.modelId });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    (async () => {
      try {
        const [state, modelsResp] = await Promise.all([
          sendCommandAndWait({ type: 'get_state' }),
          sendCommandAndWait({ type: 'get_available_models' }),
        ]);
        json(res, 200, {
          model: state?.model || null,
          thinkingLevel: state?.thinkingLevel || null,
          models: modelsResp?.models || [],
        });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
    })();
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[pi-webui] listening on http://${HOST}:${PORT}`);
  console.log('[pi-webui] open that URL in your browser');
});

function shutdown() {
  console.log('\n[pi-webui] shutting down');
  try {
    if (ON_WINDOWS && child.pid) {
      // pi sits under the cmd.exe wrapper spawned by spawnPi; kill the tree
      const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
