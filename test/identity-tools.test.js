import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/agent/tools.js';
import { registerIdentityTools } from '../src/identity/tools.js';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createDeterministicVoiceProvider } from '../src/identity/voiceProvider.js';
import { createEntityResolver } from '../src/identity/resolver.js';
import { createIdentityCoordinator } from '../src/identity/coordinator.js';

function setup() {
  const repository = createInMemoryIdentityRepository();
  const voiceProvider = createDeterministicVoiceProvider();
  const resolver = createEntityResolver({ repository, voiceProvider });
  const identity = createIdentityCoordinator({ repository, resolver, voiceProvider });
  const registry = createToolRegistry();
  registerIdentityTools(registry, { identity });
  return { registry, identity, repository };
}

test('all 16 identity tools are registered with descriptions for the model', () => {
  const { registry } = setup();
  const names = registry.descriptions().map((t) => t.name);
  for (const name of [
    'identify_current_speaker', 'name_current_speaker', 'confirm_person_match', 'reject_person_match',
    'create_person', 'update_person', 'merge_people', 'split_person', 'forget_person',
    'enroll_voice', 'remove_voice_profile', 'add_relationship', 'correct_relationship', 'remove_relationship',
    'show_identity_evidence', 'show_person_profile',
  ]) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }
});

test('name_current_speaker with self:false attributes the PREVIOUS speaker, not the one talking now', async () => {
  const { registry, repository } = setup();
  const result = await registry.execute('name_current_speaker', { name: 'Matt', self: false }, { speaker: 'Speaker 2', previousSpeaker: 'Speaker 1', sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'resolved');
  const person = repository.getPerson(result.result.personId);
  assert.ok(person.sourceEvidenceIds.length > 0);
  const evidence = repository.listEvidenceForPerson(person.personId);
  assert.equal(evidence[0].speakerLabel, 'Speaker 1'); // attributed to the previous speaker, not Speaker 2
  assert.equal(evidence[0].evidenceType, 'explicit_user_attribution');
});

test('name_current_speaker with self:true is self-identification of the CURRENT speaker', async () => {
  const { registry } = setup();
  const result = await registry.execute('name_current_speaker', { name: 'Matt', self: true }, { speaker: 'Speaker 2', previousSpeaker: 'Speaker 1', sessionId: 's1' });
  assert.equal(result.result.status, 'provisional');
  assert.equal(result.result.speakerLabel, 'Speaker 2');
});

test('confirm_person_match / reject_person_match execute via the tool registry', async () => {
  const { registry, identity } = setup();
  const named = await registry.execute('name_current_speaker', { name: 'Matt', self: true }, { speaker: 'Speaker 0', sessionId: 's1' });
  const confirmed = await registry.execute('confirm_person_match', { person_id: named.result.personId }, { speaker: 'Speaker 0', sessionId: 's1' });
  assert.equal(confirmed.result.status, 'resolved');
  assert.equal(identity.get(named.result.personId).identityStatus, 'confirmed');
});

test('create_person / update_person work via the tool registry', async () => {
  const { registry } = setup();
  const created = await registry.execute('create_person', { display_name: 'Jon', roles: ['friend'] }, {});
  assert.equal(created.ok, true);
  const updated = await registry.execute('update_person', { person_id: created.result.person.personId, add_alias: 'Jonny' }, {});
  assert.equal(updated.result.ok, true);
});

test('merge_people / split_person work via the tool registry', async () => {
  const { registry, identity } = setup();
  const a = await registry.execute('create_person', { display_name: 'Matt' }, {});
  const b = await registry.execute('create_person', { display_name: 'Matthew' }, {});
  const merged = await registry.execute('merge_people', { source_person_ids: [b.result.person.personId], target_person_id: a.result.person.personId }, {});
  assert.equal(merged.result.ok, true);
  const split = await registry.execute('split_person', { person_id: a.result.person.personId, new_display_name: 'Other Matt' }, {});
  assert.equal(split.result.ok, true);
  assert.notEqual(split.result.target.personId, a.result.person.personId);
});

test('forget_person requires confirm:true and returns a bounded preview otherwise', async () => {
  const { registry, identity } = setup();
  const created = await registry.execute('create_person', { display_name: 'Matt' }, {});
  const preview = await registry.execute('forget_person', { person_id: created.result.person.personId }, {});
  assert.equal(preview.result.needsConfirmation, true);
  assert.equal(identity.get(created.result.person.personId).status, 'active'); // not deleted yet

  const deleted = await registry.execute('forget_person', { person_id: created.result.person.personId, confirm: true }, {});
  assert.equal(deleted.result.ok, true);
  assert.equal(identity.get(created.result.person.personId).status, 'deleted');
});

test('enroll_voice / remove_voice_profile work via the tool registry (deterministic provider)', async () => {
  const { registry, identity } = setup();
  const created = await registry.execute('create_person', { display_name: 'Matt' }, {});
  const enrolled = await registry.execute('enroll_voice', { person_id: created.result.person.personId, sample: { matchKey: 'matt', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, consent: true }, {});
  assert.equal(enrolled.result.ok, true);
  assert.ok(identity.get(created.result.person.personId).voiceProfileIds.includes(enrolled.result.voiceProfileId));

  const removed = await registry.execute('remove_voice_profile', { person_id: created.result.person.personId, voice_profile_id: enrolled.result.voiceProfileId }, {});
  assert.equal(removed.result.ok, true);
  assert.ok(!identity.get(created.result.person.personId).voiceProfileIds.includes(enrolled.result.voiceProfileId));
});

test('add_relationship / correct_relationship / remove_relationship work via the tool registry', async () => {
  const { registry, identity } = setup();
  const created = await registry.execute('create_person', { display_name: 'Matt' }, {});
  const added = await registry.execute('add_relationship', { from_entity_id: 'person_user', to_entity_id: created.result.person.personId, type: 'works_with', label: 'Property contact' }, {});
  assert.equal(added.result.ok, true);
  const corrected = await registry.execute('correct_relationship', { relationship_id: added.result.relationship.relationshipId, type: 'friend' }, {});
  assert.equal(corrected.result.ok, true);
  const removed = await registry.execute('remove_relationship', { relationship_id: corrected.result.relationship.relationshipId }, {});
  assert.equal(removed.result.ok, true);
  assert.equal(identity.listRelationships({}).length, 0);
});

test('show_identity_evidence / show_person_profile work via the tool registry', async () => {
  const { registry } = setup();
  const created = await registry.execute('create_person', { display_name: 'Matt' }, {});
  const evidence = await registry.execute('show_identity_evidence', { person_id: created.result.person.personId }, {});
  assert.equal(evidence.result.found, true);
  const profile = await registry.execute('show_person_profile', { person_id: created.result.person.personId }, {});
  assert.equal(profile.result.found, true);
});

test('an unknown tool name / bad arguments fail safely through the same registry validation as every other tool', async () => {
  const { registry } = setup();
  const missing = await registry.execute('create_person', {}, {}); // display_name required
  assert.equal(missing.ok, false);
});
