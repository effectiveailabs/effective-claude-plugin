#!/usr/bin/env node
// bin/effective.mjs — the session-sync CLI.
//
// Subcommands: enable, disable, pause, resume, status, daemon-ensure, daemon-run.
//
// Pure Node built-ins only.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

import {
  paths,
  readConfig,
  writeConfig,
  readState,
  readPid,
  daemonRunning,
  isPidAlive,
  runDaemon,
} from '../daemon/sync.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_API_BASE = 'https://api.effective.ai';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function maskToken(token) {
  if (!token) return '(none)';
  const last4 = token.slice(-4);
  const prefix = token.startsWith('sk-eai-') ? 'sk-eai-' : token.slice(0, 3);
  return `${prefix}…${last4}`;
}

async function promptStdin(question) {
  // Only attempt interactive prompt if stdin is a TTY.
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return answer.trim();
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// daemon spawn
// ---------------------------------------------------------------------------

function spawnDaemon() {
  const { log } = paths();
  // Ensure the log file exists / is openable for the detached child's stdio.
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [__filename, 'daemon-run'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  // Close our copy of the fd; the child keeps its own.
  try { fs.closeSync(out); } catch {}
  return child.pid;
}

function daemonEnsure() {
  const config = readConfig();
  if (!config.enabled) return false;
  const running = daemonRunning();
  if (running) return running;
  return spawnDaemon();
}

function stopDaemon() {
  const pid = readPid();
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      return pid;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdEnable(flags) {
  let token = flags.token || process.env.EFFECTIVE_API_KEY || '';
  if (!token) {
    token = await promptStdin('Enter your Effective API key (sk-eai-...): ');
  }
  if (!token) {
    console.error('Error: no API key provided. Pass --token sk-eai-..., set EFFECTIVE_API_KEY, or run interactively.');
    process.exit(1);
  }

  const apiBase = flags.api || process.env.EFFECTIVE_API_BASE || DEFAULT_API_BASE;
  const { config } = paths();

  console.log('');
  console.log('=== CONSENT DISCLOSURE ===');
  console.log('Enabling session-sync will upload your Claude Code conversation');
  console.log('transcripts to the Effective backend. This INCLUDES:');
  console.log('  - your prompts and Claude\'s responses');
  console.log('  - code, file contents, and diffs shown in the conversation');
  console.log('  - shell commands and their output / tool results');
  console.log('');
  console.log('Secrets matching common patterns (API keys, AWS keys, GitHub');
  console.log('tokens, Bearer tokens, PEM private keys, password/secret=...) are');
  console.log('redacted to [REDACTED] before upload on a best-effort basis. This');
  console.log('is NOT a guarantee that all sensitive data is removed.');
  console.log('');
  console.log('Uploads happen out of band via a background daemon and never block');
  console.log('your conversation. To stop at any time: `effective disable`');
  console.log('(or `effective pause` to keep the daemon but stop uploads).');
  console.log('==========================');
  console.log('');

  writeConfig({ apiBase, token, enabled: true, paused: false });

  const pid = daemonEnsure();

  console.log('session-sync ENABLED.');
  console.log(`  API base : ${apiBase}`);
  console.log(`  Token    : ${maskToken(token)}`);
  console.log(`  Config   : ${config}`);
  console.log(`  Daemon   : ${pid ? `running (pid ${pid})` : 'not started'}`);
  console.log('');
  console.log('Check status any time with: effective status');
}

function cmdDisable() {
  writeConfig({ enabled: false });
  const stopped = stopDaemon();
  console.log('session-sync DISABLED.');
  if (stopped) {
    console.log(`  Stopped daemon (pid ${stopped}).`);
  } else {
    console.log('  Daemon was not running.');
  }
}

function cmdPause() {
  const config = readConfig();
  if (!config.enabled) {
    console.log('session-sync is not enabled. Run `effective enable` first.');
    return;
  }
  writeConfig({ paused: true });
  console.log('session-sync PAUSED. The daemon keeps running but uploads nothing.');
  console.log('Resume with: effective resume');
}

function cmdResume() {
  const config = readConfig();
  if (!config.enabled) {
    console.log('session-sync is not enabled. Run `effective enable` first.');
    return;
  }
  writeConfig({ paused: false });
  daemonEnsure();
  console.log('session-sync RESUMED. Uploads will continue.');
}

function cmdStatus() {
  const config = readConfig();
  const state = readState();
  const p = paths();
  const running = daemonRunning();

  console.log('session-sync status');
  console.log(`  API base : ${config.apiBase}`);
  console.log(`  Token    : ${maskToken(config.token)}`);
  console.log(`  Enabled  : ${config.enabled ? 'yes' : 'no'}`);
  console.log(`  Paused   : ${config.paused ? 'yes' : 'no'}`);
  console.log(`  Daemon   : ${running ? `running (pid ${running})` : 'not running'}`);
  console.log(`  Config   : ${p.config}`);
  console.log(`  State    : ${p.state}`);
  console.log(`  Log      : ${p.log}`);

  const files = Object.entries(state.files || {});
  if (files.length === 0) {
    console.log('  Files    : (none synced yet)');
  } else {
    console.log('  Files    :');
    let lastError = null;
    for (const [fileId, fs_] of files) {
      const offset = fs_.offset || 0;
      const lastSeq = fs_.lastSeq || 0;
      const at = fs_.lastSyncedAt || 'never';
      console.log(`    - ${fileId}`);
      console.log(`        offset=${offset}B  lastSeq=${lastSeq}  lastSyncedAt=${at}`);
      if (fs_.lastError) lastError = `${fileId}: ${fs_.lastError}`;
    }
    if (lastError) {
      console.log(`  Last error: ${lastError}`);
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  switch (cmd) {
    case 'enable':
      await cmdEnable(flags);
      break;
    case 'disable':
      cmdDisable();
      break;
    case 'pause':
      cmdPause();
      break;
    case 'resume':
      cmdResume();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'daemon-ensure': {
      const pid = daemonEnsure();
      if (pid) console.log(String(pid));
      break;
    }
    case 'daemon-run':
      runDaemon();
      break;
    default:
      console.log('Usage: effective <command>');
      console.log('');
      console.log('Commands:');
      console.log('  enable   [--token sk-eai-...] [--api <url>]   Enable sync and start the daemon');
      console.log('  disable                                       Disable sync and stop the daemon');
      console.log('  pause                                         Keep daemon running but stop uploads');
      console.log('  resume                                        Resume uploads');
      console.log('  status                                        Show config, daemon, and per-file sync state');
      console.log('  daemon-ensure                                 Start the daemon if enabled and not running');
      console.log('  daemon-run                                    Run the daemon loop (used internally)');
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
