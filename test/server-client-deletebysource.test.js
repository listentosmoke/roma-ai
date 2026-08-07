// Client-level regression test for the (now fixed) known gap: a bulk
// deleteBySource left dangling person<->memory links because the emitted
// event only carried a count, not which memories were removed. See
// src/memory/coordinator.js's deleteBySource and
// src/identity/coordinator.js's attachMemoryLifecycle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryRepository as createMemoryRepository } from '../src/memory/repository.js';
import { createMemoryCoordinator } from '../src/memory/coordinator.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createEntityResolver } from '../src/identity/resolver.js';
import { createIdentityCoordinator } from '../src/identity/coordinator.js';

test('client-side deleteBySource unlinks every affected memory from the linked person (not just a count)', () => {
  const memRepo = createMemoryRepository();
  const memory = createMemoryCoordinator({ repository: memRepo, provider: createMockProvider(async () => ({ candidates: [] })) });
  const idRepo = createInMemoryIdentityRepository();
  const identity = createIdentityCoordinator({ repository: idRepo, resolver: createEntityResolver({ repository: idRepo }), memoryRepository: memRepo });
  identity.attachMemoryLifecycle(memory);

  const matt = identity.createPerson({ displayName: 'Matt' }).person;
  const a = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p1', summary: 'x', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated', interactionId: 'i1' }, speakerEntityId: matt.personId }).memory;
  const b = memRepo.create({ type: 'fact', subjectId: 'person_user', predicate: 'p2', summary: 'y', confidence: 0.9, importance: 0.5, source: { evidenceType: 'user_stated', interactionId: 'i1' }, speakerEntityId: matt.personId }).memory;
  idRepo.linkMemory(matt.personId, a.memoryId);
  idRepo.linkMemory(matt.personId, b.memoryId);
  assert.equal(identity.get(matt.personId).linkedMemoryIds.length, 2);

  const events = [];
  memory.subscribe((e) => events.push(e));
  const count = memory.deleteBySource('i1');
  assert.equal(count, 2);

  const bulkEvent = events.find((e) => e.type === 'memory-deleted-by-source');
  assert.deepEqual(new Set(bulkEvent.memoryIds), new Set([a.memoryId, b.memoryId]));
  assert.deepEqual(identity.get(matt.personId).linkedMemoryIds, []); // no longer dangling
});
