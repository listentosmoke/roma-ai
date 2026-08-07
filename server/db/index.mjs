// SQLite connection + versioned migration runner.
//
// DATABASE CHOICE — see SERVER-DATA.md "Database selection" for the full
// writeup. Summary: this repository has no deployment configuration of any
// kind (no Dockerfile, no cloud config, no CI) and runs as a single local
// `npm run dev`/`npm run preview` process. That is exactly the case the
// phase spec calls out as acceptable for SQLite ("a single-user local server
// implementation"). Node 24 (this environment's runtime) ships `node:sqlite`
// (DatabaseSync) as a built-in — no new dependency, zero extra install
// surface, and it supports an in-memory (`:memory:`) database out of the box,
// which doubles as the deterministic test database. If this app ever gets a
// real multi-tenant cloud deployment, PostgreSQL is the documented next step
// (see SERVER-DATA.md) — the repository interfaces in server/repositories/
// were written portably (parameterized SQL, no SQLite-only syntax beyond
// `INTEGER PRIMARY KEY`-free TEXT keys) specifically so that swap does not
// require touching any repository consumer.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), path: join(MIGRATIONS_DIR, name) }));
}

/** Apply every migration not yet recorded in schema_migrations, in filename order. Safe to call on every server start — already-applied versions are skipped. Idempotent by construction (CREATE TABLE IF NOT EXISTS + the schema_migrations ledger). */
export function runMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const results = [];
  for (const { version, path } of listMigrations()) {
    if (applied.has(version)) { results.push({ version, applied: false }); continue; }
    const sql = readFileSync(path, 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
      db.exec('COMMIT');
      results.push({ version, applied: true });
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} failed: ${error.message}`);
    }
  }
  return results;
}

export function currentSchemaVersion(db) {
  const row = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  return row?.version ?? null;
}

/**
 * @param {{ path?: string, memory?: boolean }} options `memory: true` (or
 *   `path: ':memory:'`) opens a deterministic in-process database — used by
 *   every test and by scripts/simulate-server-state.mjs. A file path opens
 *   (creating if needed) durable local storage for `npm run dev`/`preview`.
 */
export function openDatabase({ path, memory = false } = {}) {
  const target = memory ? ':memory:' : (path ?? resolve(process.cwd(), 'data', 'roma.db'));
  if (target !== ':memory:') {
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec('PRAGMA foreign_keys = ON');
  if (target !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  runMigrations(db);
  return db;
}

let sharedDb = null;
/** One shared connection per server process (mirrors server/groqApi.js's provider-singleton pattern). */
export function getSharedDatabase(options) {
  sharedDb ??= openDatabase(options);
  return sharedDb;
}

/** Test-only: force a fresh shared connection (e.g. between test files that each want their own :memory: DB). */
export function resetSharedDatabase() {
  try { sharedDb?.close(); } catch { /* already closed */ }
  sharedDb = null;
}
