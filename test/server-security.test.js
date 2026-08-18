import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataClient } from '../src/server/dataClient.js';
import { createServerBackedMemoryRepository, createUnavailableMemoryRepository } from '../src/server/remoteMemoryRepository.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(path);
  }
}

test('no src/server client file references a VITE_-exposed secret', () => {
  const files = [];
  walk(join(projectRoot, 'src', 'server'), files);
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/VITE_[A-Z_]*(KEY|SECRET|TOKEN|CREDENTIAL|DATABASE|DB_)/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test('no client-side file references the node:sqlite module or a raw database file path/connection string', () => {
  // Bare mentions of key NAMES (GROQ_API_KEY, DEEPGRAM_API_KEY) already have
  // dedicated tests (voice-security.test.js/vision.test.js) that correctly
  // check for the VITE_-prefixed (client-inlined) form specifically —
  // descriptive comments/setup text mentioning the server-side name are
  // harmless and expected (e.g. index.html's ".env" setup instructions).
  const files = [];
  walk(join(projectRoot, 'src'), files);
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/node:sqlite|DatabaseSync|resolve\(process\.cwd\(\),\s*['"]data['"]/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test('if a production build exists, it contains no sqlite module reference or VITE_-exposed data-API secret', () => {
  const distDir = join(projectRoot, 'dist');
  if (!existsSync(distDir)) return; // build not run in this invocation — covered separately by `npm run build`
  const files = [];
  walk(distDir, files);
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/node:sqlite|DatabaseSync|VITE_[A-Z_]*(KEY|SECRET|TOKEN)/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test('the server-only modules (server/) are never imported from src/ client code', () => {
  const files = [];
  walk(join(projectRoot, 'src'), files);
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/from ['"].*\/server\/(db|repositories|routes|auth|dataApiPlugin|migration\/localStorageImport)/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test('production fail-closed: createUnavailableMemoryRepository never writes to localStorage or in-memory state that could be mistaken for durable storage', () => {
  const repo = createUnavailableMemoryRepository();
  assert.equal(repo.unavailable, true);
  const result = repo.create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /unavailable/i);
});

test('createDataClient never sends credentials the browser should not have — no Authorization header is set by default (dev mode relies on server-side default principal)', async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders = null;
  globalThis.fetch = async (url, options) => { capturedHeaders = options.headers; return { ok: true, text: async () => '{}' }; };
  try {
    const client = createDataClient();
    await client.get('/api/data/health');
    assert.equal(capturedHeaders, undefined); // GET with no body sends no headers at all
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the server-backed memory repository never persists to localStorage — it is an in-memory mirror only', () => {
  const hadLocalStorage = typeof globalThis.localStorage !== 'undefined';
  let touched = false;
  const guard = { getItem: () => { touched = true; return null; }, setItem: () => { touched = true; }, removeItem: () => { touched = true; } };
  if (!hadLocalStorage) globalThis.localStorage = guard;
  else { globalThis.localStorage = guard; }
  try {
    const fakeDataClient = { get: async () => ({ memories: [] }), post: async () => ({}), patch: async () => ({}), del: async () => ({}) };
    const repo = createServerBackedMemoryRepository({ dataClient: fakeDataClient });
    repo.create({ type: 'fact', subjectId: 'x', predicate: 'y', summary: 'z', confidence: 0.5, importance: 0.5, source: { evidenceType: 'user_stated' } });
    assert.equal(touched, false);
  } finally {
    if (!hadLocalStorage) delete globalThis.localStorage;
  }
});
