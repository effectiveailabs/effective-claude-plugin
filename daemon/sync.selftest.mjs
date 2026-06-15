// daemon/sync.selftest.mjs — end-to-end self-test for the sync daemon.
//
// Spins up an in-memory mock of the 3 claude-sync endpoints, points the daemon
// at it via env, creates a fake transcript, drives ticks directly, and asserts
// the contract behaviour (PUT-then-POST, redaction, offset advance, delta-only
// upload, partial-line buffering).
//
// Run: node daemon/sync.selftest.mjs
//
// This file is NOT imported by the daemon and never runs during normal startup.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- set up isolated temp dirs + env BEFORE importing the daemon -----------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-sync-selftest-'));
const syncHome = path.join(tmpRoot, 'sync-home');
const claudeHome = path.join(tmpRoot, 'claude');
const projectsDir = path.join(claudeHome, 'projects');
const encodedProject = '-Users-test-git-myrepo';
const sessionDir = path.join(projectsDir, encodedProject);
const fileId = 'b3f1c0de-0000-4000-8000-000000000001';
const transcript = path.join(sessionDir, `${fileId}.jsonl`);

fs.mkdirSync(syncHome, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });

process.env.EFFECTIVE_SYNC_HOME = syncHome;
process.env.CLAUDE_CONFIG_DIR = claudeHome;

// --- mock server ------------------------------------------------------------

const received = {
  putCalls: [],   // {fileId, body}
  postCalls: [],  // {fileId, body}
  cursorCalls: [],
  order: [],      // sequence of 'PUT' / 'POST' for ordering assertions
  events: [],     // flat list of all accepted event strings
};

let cursor = 0;
let eventCount = 0;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  // /api/v1/claude-sync/sessions/:fileId[/events|/cursor]
  const auth = req.headers['authorization'] || '';
  const id = decodeURIComponent(parts[4] || '');
  const sub = parts[5];

  res.setHeader('Content-Type', 'application/json');

  if (!auth.startsWith('Bearer ')) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'missing bearer' }));
    return;
  }

  if (req.method === 'PUT' && parts[3] === 'sessions' && !sub) {
    const body = await readBody(req);
    received.putCalls.push({ fileId: id, body });
    received.order.push('PUT');
    res.statusCode = 200;
    res.end(JSON.stringify({ fileId: id, effectiveSessionId: 'eff_sess_123', cursor }));
    return;
  }

  if (req.method === 'POST' && parts[3] === 'sessions' && sub === 'events') {
    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events : [];
    received.postCalls.push({ fileId: id, body });
    received.order.push('POST');
    for (const e of events) received.events.push(e);
    eventCount += events.length;
    cursor += events.length;
    res.statusCode = 200;
    res.end(JSON.stringify({ accepted: events.length, duplicates: 0, cursor }));
    return;
  }

  if (req.method === 'GET' && parts[3] === 'sessions' && sub === 'cursor') {
    received.cursorCalls.push({ fileId: id });
    res.statusCode = 200;
    res.end(JSON.stringify({ fileId: id, cursor, eventCount }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

// --- assertion helpers ------------------------------------------------------

const results = [];
function assert(label, cond, detail = '') {
  results.push({ label, pass: !!cond, detail });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? `  — ${detail}` : ''}`);
}

const line = (obj) => JSON.stringify(obj) + '\n';

// --- main -------------------------------------------------------------------

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const apiBase = `http://127.0.0.1:${port}`;

  // Import the daemon AFTER env is set so configHome()/transcriptDir() resolve
  // to our temp dirs.
  const sync = await import('./sync.mjs');

  // Write config pointing at the mock.
  sync.writeConfig({
    apiBase,
    token: 'sk-eai-faketoken-abcdefg',
    enabled: true,
    paused: false,
  });

  // --- Phase 1: initial lines, one with secrets, plus a partial trailing line.
  const secretLine = line({
    type: 'user',
    message: { role: 'user', content: 'my key is sk-ABCDEFGHIJKLMNOP and password=hunter2 ok' },
  });
  const normalLine = line({
    type: 'assistant',
    message: { role: 'assistant', content: 'understood' },
  });
  fs.writeFileSync(transcript, secretLine + normalLine);
  // Append a partial line with NO trailing newline.
  fs.appendFileSync(transcript, '{"type":"user","message":{"content":"incomplete');

  console.log('Phase 1: initial sync (2 complete lines + 1 partial)');
  await sync.tick(() => {});

  // (a) PUT then POST.
  assert('a) mock received a PUT', received.putCalls.length === 1,
    `putCalls=${received.putCalls.length}`);
  assert('a) mock received a POST', received.postCalls.length === 1,
    `postCalls=${received.postCalls.length}`);
  assert('a) PUT happened before POST',
    received.order[0] === 'PUT' && received.order[1] === 'POST',
    `order=${received.order.join(',')}`);
  assert('a) PUT/POST used the transcript fileId',
    received.putCalls[0].fileId === fileId && received.postCalls[0].fileId === fileId,
    `put=${received.putCalls[0].fileId}`);

  // Only the 2 complete lines uploaded (NOT the partial).
  const firstBatch = received.postCalls[0].body.events;
  assert('e) partial trailing line NOT uploaded', firstBatch.length === 2,
    `uploaded ${firstBatch.length} events (expected 2)`);

  // (b) Secrets redacted.
  const joined = firstBatch.join('\n');
  assert('b) sk- API key replaced with [REDACTED]',
    !joined.includes('sk-ABCDEFGHIJKLMNOP') && joined.includes('[REDACTED]'),
    'sk-... removed');
  assert('b) password=... value redacted',
    !joined.includes('hunter2') && /password=\[REDACTED\]/.test(joined),
    'hunter2 removed');

  // PUT metadata sanity: cwd reconstructed from encoded dir name.
  const meta = received.putCalls[0].body;
  assert('PUT cwd reconstructed from encoded dir', meta.cwd === '/Users/test/git/myrepo',
    `cwd=${meta.cwd}`);
  assert('PUT project is the encoded dir name', meta.project === encodedProject,
    `project=${meta.project}`);

  // (c) Offset advanced to the byte count of the 2 complete lines only.
  const stateAfter1 = sync.readState();
  const fs1 = stateAfter1.files[fileId];
  const expectedOffset = Buffer.byteLength(secretLine + normalLine);
  assert('c) offset advanced to end of complete lines',
    fs1 && fs1.offset === expectedOffset,
    `offset=${fs1 ? fs1.offset : 'none'} expected=${expectedOffset}`);
  assert('c) lastSeq counts uploaded events', fs1 && fs1.lastSeq === 2,
    `lastSeq=${fs1 ? fs1.lastSeq : 'none'}`);

  // --- Phase 2: tick again with no new complete lines — should upload nothing.
  console.log('Phase 2: re-tick with only the partial line pending');
  const postsBefore = received.postCalls.length;
  await sync.tick(() => {});
  assert('e) re-tick uploads nothing while only partial pending',
    received.postCalls.length === postsBefore,
    `posts now=${received.postCalls.length} (was ${postsBefore})`);

  // --- Phase 3: complete the partial line + add a fresh line; only NEW lines.
  console.log('Phase 3: complete the partial line + append a new line');
  // Finish the partial line started in phase 1, then add another full line.
  fs.appendFileSync(transcript, '"}}\n');
  const newLine = line({ type: 'assistant', message: { role: 'assistant', content: 'second reply' } });
  fs.appendFileSync(transcript, newLine);

  const eventsBefore = received.events.length;
  await sync.tick(() => {});
  const lastPost = received.postCalls[received.postCalls.length - 1].body.events;

  assert('d) second tick uploaded only the 2 new lines', lastPost.length === 2,
    `uploaded ${lastPost.length} new events (expected 2)`);
  assert('d) new upload contains the now-completed partial line',
    lastPost.some((l) => l.includes('incomplete')),
    'completed partial present');
  assert('d) new upload contains the freshly appended line',
    lastPost.some((l) => l.includes('second reply')),
    'new line present');
  assert('d) total accepted events is 4 (no re-send of old lines)',
    received.events.length === eventsBefore + 2 && received.events.length === 4,
    `total events=${received.events.length}`);

  const stateAfter3 = sync.readState();
  const fs3 = stateAfter3.files[fileId];
  const finalSize = fs.statSync(transcript).size;
  assert('d) offset now equals full file size (all complete)',
    fs3.offset === finalSize,
    `offset=${fs3.offset} fileSize=${finalSize}`);
  assert('d) cursor recorded from server', typeof fs3.cursor === 'number',
    `cursor=${fs3.cursor}`);
  assert('no lastError after successful syncs', !fs3.lastError,
    fs3.lastError || 'clean');

  // --- teardown ---
  server.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`Self-test complete: ${results.length - failed.length}/${results.length} assertions passed.`);
  if (failed.length) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  - ${f.label} (${f.detail})`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('self-test crashed:', err && err.stack ? err.stack : err);
  try { server.close(); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
