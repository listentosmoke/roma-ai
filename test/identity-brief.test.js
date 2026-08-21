// The person brief — what Roma knows about someone, at the moment she sees them.
//
// Recognition on its own returns a person id, which tells you nothing. These
// tests pin the thing that makes it useful: pulling together the record, the
// relationship, what is still open, and what you know — from stores that
// already hold it, with no model call and no inference.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createInMemoryRepository as createMemoryRepository } from '../src/memory/repository.js';
import { buildPersonBrief, buildBriefsForPresent, formatPersonBrief, memoryMentionsPerson } from '../src/identity/brief.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function setup() {
  const identityRepository = createInMemoryIdentityRepository();
  const memoryRepository = createMemoryRepository();
  const person = identityRepository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed', roles: ['contractor'], lastObservedAt: NOW - 2 * DAY }).person;
  return { identityRepository, memoryRepository, person };
}

function remember(memoryRepository, overrides = {}) {
  return memoryRepository.create({
    type: 'fact', subjectId: 'person_user', predicate: 'p', object: {},
    summary: 'something', confidence: 0.9, importance: 0.5, tags: [],
    source: { evidenceType: 'user_stated' }, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  }).memory;
}

// ── what counts as being "about" someone ──────────────────────────────────

test('a memory is about a person however they are linked to it', () => {
  const id = 'person_1';
  assert.equal(memoryMentionsPerson({ speakerEntityId: id }, id), true, 'they said it');
  assert.equal(memoryMentionsPerson({ subjectId: id }, id), true, 'it is about them');
  assert.equal(memoryMentionsPerson({ subjectEntityIds: [id] }, id), true);
  assert.equal(memoryMentionsPerson({ mentionedEntityIds: ['x', id] }, id), true, 'they came up');
  assert.equal(memoryMentionsPerson({ mentionedEntityIds: ['x'] }, id), false);
  assert.equal(memoryMentionsPerson(null, id), false);
  assert.equal(memoryMentionsPerson({ subjectId: id }, null), false);
});

// ── the brief itself ──────────────────────────────────────────────────────

test('an unknown person has no brief at all', () => {
  const { identityRepository, memoryRepository } = setup();
  assert.equal(buildPersonBrief('person_nobody', { identityRepository, memoryRepository }), null);
});

test('someone with nothing recorded gets a brief that says so, rather than implying familiarity', () => {
  const { identityRepository, memoryRepository, person } = setup();
  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });

  assert.equal(brief.displayName, 'Matt');
  assert.deepEqual(brief.roles, ['contractor']);
  assert.equal(brief.thin, true);
  assert.equal(brief.counts.memories, 0);
  assert.match(formatPersonBrief(brief), /Nothing recorded about them yet/);
});

test('what is still open with someone comes before what you merely know about them', () => {
  const { identityRepository, memoryRepository, person } = setup();
  remember(memoryRepository, { type: 'fact', summary: 'Matt is allergic to peanuts.', importance: 0.9, mentionedEntityIds: [person.personId] });
  remember(memoryRepository, { type: 'commitment', summary: 'Send Matt the Building 5 HVAC quote.', importance: 0.4, mentionedEntityIds: [person.personId] });

  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });

  assert.equal(brief.open.length, 1);
  assert.match(brief.open[0].summary, /HVAC quote/, 'a commitment is what you owe them');
  assert.equal(brief.knownFor.length, 1);
  assert.match(brief.knownFor[0].summary, /allergic to peanuts/);
  assert.equal(brief.thin, false);

  const rendered = formatPersonBrief(brief);
  assert.ok(rendered.indexOf('Still open') < rendered.indexOf('What you know'), 'open items lead');
});

test('the most important thing about someone is the first thing said', () => {
  const { identityRepository, memoryRepository, person } = setup();
  remember(memoryRepository, { summary: 'Matt drinks flat whites.', importance: 0.2, mentionedEntityIds: [person.personId] });
  remember(memoryRepository, { summary: 'Matt is the structural engineer on Building 5.', importance: 0.95, mentionedEntityIds: [person.personId] });

  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });
  assert.match(brief.knownFor[0].summary, /structural engineer/);
});

test('a brief never includes other people\'s memories', () => {
  const { identityRepository, memoryRepository, person } = setup();
  const other = identityRepository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;
  remember(memoryRepository, { summary: 'About Matt.', mentionedEntityIds: [person.personId] });
  remember(memoryRepository, { summary: 'About Jon.', mentionedEntityIds: [other.personId] });

  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });
  assert.equal(brief.counts.memories, 1);
  assert.match(brief.knownFor[0].summary, /About Matt/);
});

test('a forgotten memory is not in the brief', () => {
  const { identityRepository, memoryRepository, person } = setup();
  const memory = remember(memoryRepository, { summary: 'Old news about Matt.', mentionedEntityIds: [person.personId] });
  memoryRepository.delete(memory.memoryId);

  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });
  assert.equal(brief.counts.memories, 0);
});

test('relationships are included, and only the active ones', () => {
  const { identityRepository, memoryRepository, person } = setup();
  identityRepository.createRelationship({ fromEntityId: 'person_user', toEntityId: person.personId, type: 'works_with', label: 'Building 5' });
  const stale = identityRepository.createRelationship({ fromEntityId: 'person_user', toEntityId: person.personId, type: 'client' }).relationship;
  identityRepository.updateRelationship(stale.relationshipId, { status: 'superseded' });

  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });
  assert.equal(brief.relationships.length, 1);
  assert.equal(brief.relationships[0].type, 'works_with');
  assert.match(formatPersonBrief(brief), /works_with \(Building 5\)/);
});

test('a brief is bounded — a long history does not become an unbounded prompt', () => {
  const { identityRepository, memoryRepository, person } = setup();
  for (let i = 0; i < 40; i += 1) {
    remember(memoryRepository, { summary: `Fact ${i} about Matt.`, importance: 0.5, mentionedEntityIds: [person.personId] });
    remember(memoryRepository, { type: 'commitment', summary: `Owed ${i}.`, importance: 0.5, mentionedEntityIds: [person.personId] });
  }
  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });
  assert.ok(brief.knownFor.length <= 6, `knownFor was ${brief.knownFor.length}`);
  assert.ok(brief.open.length <= 5, `open was ${brief.open.length}`);
  assert.equal(brief.counts.memories, 80, 'but the true count is still reported honestly');
});

test('how long ago you saw someone is stated in words, not timestamps', () => {
  const { identityRepository, memoryRepository, person } = setup();
  const brief = buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW });
  assert.equal(brief.lastSeen, '2 days ago');
  assert.match(formatPersonBrief(brief), /Last seen: 2 days ago/);
});

test('an unconfirmed identity says so, so Roma cannot assert it as certain', () => {
  const identityRepository = createInMemoryIdentityRepository();
  const memoryRepository = createMemoryRepository();
  const person = identityRepository.createPerson({ displayName: 'Maybe Matt', identityStatus: 'provisional' }).person;

  const rendered = formatPersonBrief(buildPersonBrief(person.personId, { identityRepository, memoryRepository, now: NOW }));
  assert.match(rendered, /Identity is provisional, not confirmed/);
});

// ── several people at once ────────────────────────────────────────────────

test('briefs for a room are bounded and de-duplicated', () => {
  const { identityRepository, memoryRepository, person } = setup();
  const second = identityRepository.createPerson({ displayName: 'Jon', identityStatus: 'confirmed' }).person;
  const third = identityRepository.createPerson({ displayName: 'Sam', identityStatus: 'confirmed' }).person;
  const fourth = identityRepository.createPerson({ displayName: 'Kim', identityStatus: 'confirmed' }).person;

  const briefs = buildBriefsForPresent({
    personIds: [person.personId, person.personId, second.personId, third.personId, fourth.personId, null],
    identityRepository,
    memoryRepository,
    now: NOW,
    limit: 3,
  });

  assert.equal(briefs.length, 3);
  assert.deepEqual(briefs.map((b) => b.displayName), ['Matt', 'Jon', 'Sam']);
});

test('a person who no longer exists is skipped rather than crashing the room', () => {
  const { identityRepository, memoryRepository, person } = setup();
  const briefs = buildBriefsForPresent({ personIds: ['person_deleted', person.personId], identityRepository, memoryRepository, now: NOW });
  assert.equal(briefs.length, 1);
});

test('with no memory store at all, the brief is still the person record', () => {
  const { identityRepository, person } = setup();
  const brief = buildPersonBrief(person.personId, { identityRepository });
  assert.equal(brief.displayName, 'Matt');
  assert.equal(brief.counts.memories, 0);
});
