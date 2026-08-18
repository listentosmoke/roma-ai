import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { openDatabase, runMigrations, currentSchemaVersion, listMigrations } from '../server/db/index.mjs';

test('migrations apply from an empty database', () => {
  const db = openDatabase({ memory: true });
  assert.equal(currentSchemaVersion(db), '0006_face_plaintext_templates');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const expected of ['memories', 'people', 'relationships', 'identity_evidence', 'sessions', 'audit_events', 'consent_records', 'voice_profile_refs', 'voice_templates', 'face_templates', 'tombstones', 'operation_ids', 'schema_migrations']) {
    assert.ok(tables.includes(expected), `missing table: ${expected}`);
  }
  db.close();
});

test('migrations are idempotent — running twice applies nothing new the second time', () => {
  const db = openDatabase({ memory: true });
  const first = runMigrations(db);
  const second = runMigrations(db);
  assert.ok(first.every((m) => m.applied === false)); // already applied by openDatabase() itself
  assert.ok(second.every((m) => m.applied === false));
  db.close();
});

test('at least one migration file exists and is tracked', () => {
  assert.ok(listMigrations().length >= 1);
});

test('repository records survive a reconnect to the SAME file-backed database (server restart simulation)', () => {
  const path = `${process.cwd()}/data/.test-restart-${Date.now()}.db`;
  const db1 = openDatabase({ path });
  db1.prepare("INSERT INTO workspaces (workspace_id, display_name, created_at) VALUES ('w_restart', 'x', ?)").run(Date.now());
  db1.close();

  const db2 = openDatabase({ path });
  const row = db2.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get('w_restart');
  assert.ok(row);
  db2.close();

  // cleanup
  for (const suffix of ['', '-shm', '-wal']) { try { unlinkSync(path + suffix); } catch { /* best-effort */ } }
});
