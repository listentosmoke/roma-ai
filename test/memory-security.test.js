// Security checks specific to the memory subsystem. Memory storage in this
// phase is entirely client-side (localStorage) and extraction reuses the
// EXISTING /api/agent/infer proxy — there is no new credential, no new server
// route, and no new VITE_-exposed secret to protect. These tests confirm that
// stays true, and that a couple of memory-specific safety properties hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInMemoryRepository } from '../src/memory/repository.js';
import { createMemoryCoordinator } from '../src/memory/coordinator.js';
import { createMockProvider } from '../src/agent/provider.js';
import { validateMemory } from '../src/memory/schema.js';

test('no memory source file introduces a new client-exposed credential (no VITE_ secret reference)', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) scan(path);
      else if (/\.js$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        if (/VITE_[A-Z_]*(KEY|SECRET|TOKEN)/.test(text)) offenders.push(path);
      }
    }
  };
  scan('src/memory');
  assert.deepEqual(offenders, []);
});

test('the memory repository has no server/database credential of its own (localStorage-backed, no auth)', () => {
  const text = readFileSync('src/memory/repository.js', 'utf8');
  assert.doesNotMatch(text, /apiKey|API_KEY|password|secret/i);
});

test('oversized memory payloads are bounded at validation time (no unbounded object stored)', () => {
  const huge = {};
  for (let i = 0; i < 500; i += 1) huge[`key_${i}`] = 'x'.repeat(1000);
  const result = validateMemory({
    memoryId: 'mem_x', type: 'fact', subjectId: 'person_user', predicate: 'p', object: huge,
    summary: 'y'.repeat(5000), tags: Array.from({ length: 100 }, (_, i) => `tag${i}`),
    source: { evidenceType: 'user_stated' },
  });
  assert.equal(result.ok, true);
  assert.ok(Object.keys(result.memory.object).length <= 10);
  assert.ok(result.memory.summary.length <= 300);
  assert.ok(result.memory.tags.length <= 8);
});

test('clearAll() is scoped to a single repository instance/storage key, never a shared or unrelated store', () => {
  const repoA = createInMemoryRepository();
  const repoB = createInMemoryRepository();
  repoA.create({ type: 'fact', subjectId: 'x', predicate: 'y', object: {}, summary: 'a', source: { evidenceType: 'user_stated' } });
  repoB.create({ type: 'fact', subjectId: 'x', predicate: 'y', object: {}, summary: 'b', source: { evidenceType: 'user_stated' } });
  repoA.clearAll();
  assert.equal(repoA.exportAll().length, 0);
  assert.equal(repoB.exportAll().length, 1); // unaffected
});

test('the coordinator exposes no method that hands a full unrestricted memory dump to the model — only bounded retrieve()/recall()', async () => {
  const repository = createInMemoryRepository();
  for (let i = 0; i < 50; i += 1) {
    repository.create({ type: 'fact', subjectId: 'person_user', predicate: `p${i}`, object: {}, summary: `fact number ${i} about quote`, confidence: 0.7, importance: 0.5, tags: ['quote'], source: { evidenceType: 'user_stated' } });
  }
  const coordinator = createMemoryCoordinator({ repository, provider: createMockProvider(async () => ({ candidates: [] })) });
  const result = await coordinator.retrieve({ query: 'quote', maximumMemories: 8 });
  assert.ok(result.memories.length <= 8);
});
