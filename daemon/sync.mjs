// daemon/sync.mjs — core of the session-sync daemon.
//
// Responsibilities:
//   - resolve config/state/pid/log paths under EFFECTIVE_SYNC_HOME or
//     $HOME/.config/effective-sync/
//   - read config (apiBase, token, enabled, paused, redact)
//   - tail Claude Code transcript .jsonl files and upload deltas out of band
//   - redact secrets before upload
//   - never throw out of the polling loop; one bad file must not crash the loop
//
// Pure Node built-ins only. No npm dependencies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function configHome() {
  if (process.env.EFFECTIVE_SYNC_HOME && process.env.EFFECTIVE_SYNC_HOME.trim()) {
    return process.env.EFFECTIVE_SYNC_HOME;
  }
  return path.join(os.homedir(), '.config', 'effective-sync');
}

export function paths() {
  const home = configHome();
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    pid: path.join(home, 'daemon.pid'),
    log: path.join(home, 'daemon.log'),
  };
}

// Registry of agent transcript sources. Each source knows its own root dir, how
// to recognise its transcript files, and how to derive a stable fileId from a
// file path. State keys are namespaced by source.name so the two never collide.
export function sources() {
  const claudeBase = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()
    ? process.env.CLAUDE_CONFIG_DIR.trim()
    : path.join(os.homedir(), '.claude');
  const codexBase = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : path.join(os.homedir(), '.codex');
  return [
    {
      name: 'claude-code',
      root: path.join(claudeBase, 'projects'),
      matches: (f) => f.endsWith('.jsonl'),
      fileId: (p) => path.basename(p, '.jsonl'),
    },
    {
      name: 'codex',
      root: path.join(codexBase, 'sessions'),
      matches: (f) => /^rollout-.*\.jsonl$/.test(path.basename(f)),
      fileId: (p) => {
        const m = path.basename(p).match(/([0-9a-fA-F-]{36})\.jsonl$/);
        return m ? m[1] : path.basename(p, '.jsonl');
      },
    },
  ];
}

function ensureHome() {
  const { home } = paths();
  fs.mkdirSync(home, { recursive: true });
}

// ---------------------------------------------------------------------------
// Config + state I/O
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://api.effective.ai';

export function readConfig() {
  const { config } = paths();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
  } catch {
    cfg = {};
  }
  return {
    apiBase: cfg.apiBase || DEFAULT_API_BASE,
    token: cfg.token || '',
    enabled: cfg.enabled === true,
    paused: cfg.paused === true,
    redact: Array.isArray(cfg.redact) ? cfg.redact : [],
    ...cfg,
  };
}

export function writeConfig(patch) {
  ensureHome();
  const { config } = paths();
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(config, 'utf8'));
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  const tmp = config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, config);
  return next;
}

export function readState() {
  const { state } = paths();
  try {
    const s = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (!s.files || typeof s.files !== 'object') s.files = {};
    return s;
  } catch {
    return { files: {} };
  }
}

export function writeState(state) {
  ensureHome();
  const { state: statePath } = paths();
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, statePath);
}

// ---------------------------------------------------------------------------
// Pidfile / single-instance lock
// ---------------------------------------------------------------------------

export function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err && err.code === 'EPERM';
  }
}

export function readPid() {
  const { pid } = paths();
  try {
    const raw = fs.readFileSync(pid, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function daemonRunning() {
  const pid = readPid();
  return isPidAlive(pid) ? pid : null;
}

function writePidfile() {
  ensureHome();
  const { pid } = paths();
  fs.writeFileSync(pid, String(process.pid) + '\n');
}

function removePidfile() {
  const { pid } = paths();
  try {
    // Only remove if it still points at us.
    const cur = readPid();
    if (cur === process.pid) fs.unlinkSync(pid);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

// Built-in patterns. Order matters a little (run more specific first), but all
// are applied. Each is a global regex producing [REDACTED] for the secret.
function defaultRedactors() {
  return [
    // PEM private key blocks (multi-line handled separately on the whole text).
    {
      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
      replace: () => '[REDACTED]',
    },
    // OpenAI / Effective style keys: sk-...
    { re: /sk-[A-Za-z0-9-]{12,}/g, replace: () => '[REDACTED]' },
    // AWS access key id
    { re: /AKIA[0-9A-Z]{16}/g, replace: () => '[REDACTED]' },
    // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => '[REDACTED]' },
    // Bearer tokens
    { re: /Bearer\s+[A-Za-z0-9._-]{16,}/g, replace: () => 'Bearer [REDACTED]' },
    // key=value / key: value style secrets
    {
      re: /(?<key>(?:password|api[_-]?key|secret|token))(?<sep>\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      replace: (m, key, sep) => `${key}${sep}[REDACTED]`,
    },
  ];
}

export function buildRedactors(config) {
  const redactors = defaultRedactors();
  const extra = (config && Array.isArray(config.redact)) ? config.redact : [];
  for (const pat of extra) {
    try {
      const re = new RegExp(pat, 'g');
      redactors.push({ re, replace: () => '[REDACTED]' });
    } catch {
      // skip invalid user-supplied pattern
    }
  }
  return redactors;
}

export function redactLine(line, redactors) {
  let out = line;
  for (const r of redactors) {
    // Reset lastIndex defensively (global regexes are stateful).
    r.re.lastIndex = 0;
    out = out.replace(r.re, r.replace);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project / cwd derivation from the encoded transcript dir name
// ---------------------------------------------------------------------------

// Claude Code encodes the project's absolute path as the directory name by
// replacing path separators with '-'. e.g. /Users/me/git/foo ->
// "-Users-me-git-foo". This is lossy (real '-' in path segments is
// indistinguishable from a separator), so we reconstruct best-effort:
//   - leading '-' => leading '/'
//   - remaining '-' => '/'
// We expose both the raw encoded name (project) and the reconstructed path (cwd).
export function deriveProjectInfo(encodedDirName) {
  const project = encodedDirName;
  let cwd = encodedDirName;
  if (cwd.startsWith('-')) {
    cwd = '/' + cwd.slice(1);
  }
  cwd = cwd.replace(/-/g, '/');
  return { project, cwd };
}

// Best-effort title: first user message text, else the project basename.
function deriveTitle(lines, fallback) {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const msg = obj && obj.message;
      if (obj && obj.type === 'user' && msg) {
        let content = msg.content;
        if (typeof content === 'string') {
          const t = content.trim();
          if (t) return t.slice(0, 200);
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              const t = part.text.trim();
              if (t) return t.slice(0, 200);
            }
          }
        }
      }
    } catch {
      // not JSON or unexpected shape — ignore
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Transcript discovery
// ---------------------------------------------------------------------------

export function findTranscripts(dir, matches = (f) => f.endsWith('.jsonl')) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        out.push(...findTranscripts(full, matches));
      } else if (ent.isFile() && matches(full)) {
        out.push(full);
      }
    } catch {
      // skip unreadable entry
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function requestJson(method, urlStr, token, bodyObj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj));
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function syncBase(apiBase) {
  return apiBase.replace(/\/+$/, '') + '/api/v1/agent-sync';
}

export async function postSync(apiBase, token, source, fileId, metadata, events) {
  const url = `${syncBase(apiBase)}/sync`;
  return requestJson('POST', url, token, { source, fileId, metadata, events });
}

// ---------------------------------------------------------------------------
// Line buffering: read only new bytes from offset to EOF, split into complete
// lines, keep any trailing partial line for next time.
// ---------------------------------------------------------------------------

// Returns { lines: string[], consumed: number } where `consumed` is the number
// of bytes that were turned into complete lines (i.e. up to and including the
// last newline). An incomplete trailing line is NOT consumed.
export function splitCompleteLines(buf) {
  const lastNl = buf.lastIndexOf('\n');
  if (lastNl === -1) {
    return { lines: [], consumed: 0 };
  }
  const complete = buf.subarray(0, lastNl + 1).toString('utf8');
  const consumed = Buffer.byteLength(buf.subarray(0, lastNl + 1));
  const lines = complete.split('\n');
  // Last element is '' because the slice ends in '\n'; drop it.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  // Drop any empty lines (blank JSONL rows carry nothing to upload).
  return { lines: lines.filter((l) => l.length > 0), consumed };
}

function readDelta(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size <= offset) {
      return { buf: Buffer.alloc(0), size };
    }
    const len = size - offset;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return { buf: buf.subarray(0, read), size: offset + read };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// One processing pass over a single file. Exported for the self-test so we can
// drive a deterministic tick without setInterval.
// ---------------------------------------------------------------------------

export async function processFile(file, source, config, state, redactors, log = () => {}) {
  const fileId = source.fileId(file);
  const stateKey = `${source.name}:${fileId}`;
  const encodedDir = path.basename(path.dirname(file));
  const fileState = state.files[stateKey] || { offset: 0, lastSeq: 0, cursor: null };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return; // file vanished
  }

  // If the file shrank (truncated/rotated), restart from 0.
  if (stat.size < fileState.offset) {
    fileState.offset = 0;
    fileState.cursor = null;
  }

  if (stat.size <= fileState.offset) {
    state.files[stateKey] = fileState;
    return; // nothing new
  }

  const { buf } = readDelta(file, fileState.offset);
  const { lines, consumed } = splitCompleteLines(buf);

  if (lines.length === 0) {
    // Only a partial trailing line so far — do not advance offset.
    state.files[stateKey] = fileState;
    return;
  }

  const redacted = lines.map((l) => redactLine(l, redactors));

  let metadata = { client: source.name };
  if (source.name === 'claude-code') {
    const { project, cwd } = deriveProjectInfo(encodedDir);
    metadata = {
      ...metadata,
      title: deriveTitle(lines, path.basename(cwd) || project),
      cwd,
      project,
    };
  }

  let res;
  try {
    res = await postSync(config.apiBase, config.token, source.name, fileId, metadata, redacted);
  } catch (err) {
    fileState.lastError = `sync failed: ${err.message}`;
    state.files[stateKey] = fileState;
    log(`sync ${fileId} error: ${err.message}`);
    return;
  }
  if (!res || res.status < 200 || res.status >= 300) {
    fileState.lastError = `sync status ${res ? res.status : 'none'}`;
    state.files[stateKey] = fileState;
    log(`sync ${fileId} non-2xx: ${res ? res.status : 'none'}`);
    return;
  }

  // Success: advance offset by exactly the consumed (complete-line) bytes.
  const appended = res.json && typeof res.json.appended === 'number'
    ? res.json.appended
    : redacted.length;
  fileState.offset += consumed;
  fileState.lastSeq = (fileState.lastSeq || 0) + appended;
  fileState.lastSyncedAt = new Date().toISOString();
  if (res.json && res.json.sessionId) {
    fileState.sessionId = res.json.sessionId;
  }
  delete fileState.lastError;
  state.files[stateKey] = fileState;
  log(`synced ${stateKey}: +${appended} events, offset=${fileState.offset}`);
}

// ---------------------------------------------------------------------------
// One full tick over all transcript files. Exported for the self-test.
// ---------------------------------------------------------------------------

export async function tick(log = () => {}) {
  const config = readConfig();
  if (!config.enabled) return;
  if (config.paused) return;
  if (!config.token) {
    log('no token configured; skipping');
    return;
  }

  const state = readState();
  const redactors = buildRedactors(config);

  for (const source of sources()) {
    const files = findTranscripts(source.root, source.matches);
    for (const file of files) {
      try {
        await processFile(file, source, config, state, redactors, log);
      } catch (err) {
        log(`processFile ${file} crashed: ${err && err.stack ? err.stack : err}`);
      }
    }
  }

  try {
    writeState(state);
  } catch (err) {
    log(`writeState failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Long-lived daemon loop.
// ---------------------------------------------------------------------------

const POLL_MS = 3000;

export function runDaemon() {
  ensureHome();

  // Single-instance lock.
  const existing = readPid();
  if (isPidAlive(existing) && existing !== process.pid) {
    // Another daemon already owns the lock.
    process.exit(0);
  }
  writePidfile();

  const { log: logPath } = paths();
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const log = (msg) => {
    try {
      logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // ignore logging failures
    }
  };

  log(`daemon started pid=${process.pid}`);

  let running = false;
  const safeTick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      await tick(log);
    } catch (err) {
      log(`tick crashed: ${err && err.stack ? err.stack : err}`);
    } finally {
      running = false;
    }
  };

  // fs.watch as a hint only; polling is the source of truth.
  for (const source of sources()) {
    try {
      fs.mkdirSync(source.root, { recursive: true });
      fs.watch(source.root, { recursive: true }, () => { safeTick(); });
    } catch (err) {
      log(`fs.watch unavailable for ${source.name} (${err.message}); polling only`);
    }
  }

  const interval = setInterval(safeTick, POLL_MS);
  // Kick once immediately.
  safeTick();

  const shutdown = () => {
    clearInterval(interval);
    log(`daemon stopping pid=${process.pid}`);
    removePidfile();
    try { logStream.end(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', removePidfile);
}
