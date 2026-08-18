// Wearer resolution + turn_analysis validation — the glasses reframe's
// deterministic half. The model never decides who the wearer is, and a
// malformed/missing analysis must degrade safely rather than invent one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWearerResolver, formatWearerContext } from '../src/agent/wearer.js';
import { validateTurnAnalysis, validateDecision, AGENT_DECISION_JSON_SCHEMA, SPEAKER_ROLES, ADDRESSED_TO } from '../src/agent/schema.js';

// ── resolver ────────────────────────────────────────────────────────────────

test('an unresolved wearer stays unknown — never guessed from a single utterance', () => {
  const resolver = createWearerResolver();
  assert.equal(resolver.resolve().confidence, 'unknown');
  resolver.record({ speaker: 'Speaker 0', level: 0.9 });
  assert.equal(resolver.resolve().confidence, 'unknown', 'one loud sentence is not enough evidence');
  assert.equal(resolver.isWearer('Speaker 0'), null, 'unknown must be null, never a false "no"');
});

test('a dominant close-microphone speaker is ASSUMED to be the wearer after enough evidence', () => {
  const resolver = createWearerResolver();
  for (let i = 0; i < 4; i += 1) resolver.record({ speaker: 'Speaker 0', level: 0.8 });
  resolver.record({ speaker: 'Speaker 1', level: 0.5 });
  const state = resolver.resolve();
  assert.equal(state.confidence, 'assumed');
  assert.equal(state.speaker, 'Speaker 0');
  assert.equal(resolver.isWearer('Speaker 1'), false);
});

test('no single speaker dominating means no wearer is assumed', () => {
  const resolver = createWearerResolver();
  for (let i = 0; i < 3; i += 1) {
    resolver.record({ speaker: 'Speaker 0', level: 0.7 });
    resolver.record({ speaker: 'Speaker 1', level: 0.7 });
  }
  assert.equal(resolver.resolve().confidence, 'unknown', 'a two-way conversation must not pick a wearer');
});

test('distant speech does not count toward the wearer heuristic', () => {
  const resolver = createWearerResolver();
  for (let i = 0; i < 6; i += 1) resolver.record({ speaker: 'Speaker 3', level: 0.02 });
  assert.equal(resolver.resolve().confidence, 'unknown');
});

test('explicit identity confirmation outranks the close-mic heuristic', () => {
  const resolver = createWearerResolver();
  for (let i = 0; i < 5; i += 1) resolver.record({ speaker: 'Speaker 1', level: 0.9 });
  assert.equal(resolver.resolve().speaker, 'Speaker 1');
  resolver.confirm({ speaker: 'Speaker 0', personId: 'person_wearer', displayName: 'Nathan' });
  const state = resolver.resolve();
  assert.equal(state.confidence, 'confirmed');
  assert.equal(state.speaker, 'Speaker 0');
  assert.equal(state.personId, 'person_wearer');
  assert.equal(resolver.isWearer('Speaker 1'), false);
});

test('confirmation requires both a label and a person id — a bare name never confirms a wearer', () => {
  const resolver = createWearerResolver();
  assert.equal(resolver.confirm({ speaker: 'Speaker 0' }), false);
  assert.equal(resolver.confirm({ personId: 'person_x' }), false);
  assert.equal(resolver.resolve().confidence, 'unknown');
});

test('identity can NAME the wearer we already resolved — but can never promote someone into the role', () => {
  const resolver = createWearerResolver();
  // Nobody resolved yet: naming must do nothing at all.
  assert.equal(resolver.nameWearer({ speaker: 'Speaker 0', personId: 'person_a', displayName: 'Alex' }), false);
  assert.equal(resolver.resolve().confidence, 'unknown');

  for (let i = 0; i < 4; i += 1) resolver.record({ speaker: 'Speaker 0', level: 0.8 });
  // A DIFFERENT speaker's identity must not attach to the wearer.
  assert.equal(resolver.nameWearer({ speaker: 'Speaker 3', personId: 'person_b', displayName: 'Sam' }), false);
  assert.equal(resolver.resolve().displayName, null);

  assert.equal(resolver.nameWearer({ speaker: 'Speaker 0', personId: 'person_a', displayName: 'Alex' }), true);
  const state = resolver.resolve();
  assert.equal(state.displayName, 'Alex');
  assert.equal(state.personId, 'person_a');
  assert.equal(state.confidence, 'assumed', 'naming adds a label, it does not upgrade the evidence');
  assert.match(formatWearerContext(state), /Alex/);
});

test('a name does not follow the wearer slot to a different speaker', () => {
  const resolver = createWearerResolver({ windowSize: 6 });
  for (let i = 0; i < 4; i += 1) resolver.record({ speaker: 'Speaker 0', level: 0.8 });
  resolver.nameWearer({ speaker: 'Speaker 0', personId: 'person_a', displayName: 'Alex' });
  // The room changes and a different voice now dominates the close mic.
  for (let i = 0; i < 6; i += 1) resolver.record({ speaker: 'Speaker 5', level: 0.9 });
  const state = resolver.resolve();
  assert.equal(state.speaker, 'Speaker 5');
  assert.equal(state.displayName, null, 'the previous wearer\'s name must not transfer');
});

test('naming requires an actual name', () => {
  const resolver = createWearerResolver();
  for (let i = 0; i < 4; i += 1) resolver.record({ speaker: 'Speaker 0', level: 0.8 });
  assert.equal(resolver.nameWearer({ speaker: 'Speaker 0', personId: 'person_a', displayName: '' }), false);
  assert.equal(resolver.resolve().displayName, null);
});

test('the observation window is bounded', () => {
  const resolver = createWearerResolver({ windowSize: 10 });
  for (let i = 0; i < 50; i += 1) resolver.record({ speaker: `Speaker ${i % 3}`, level: 0.6 });
  assert.equal(resolver.observationCount(), 10);
});

test('the rendered wearer block states its own confidence honestly', () => {
  assert.match(formatWearerContext(null), /unidentified/i);
  assert.match(formatWearerContext({ speaker: 'Speaker 0', confidence: 'unknown' }), /unidentified/i);
  assert.match(formatWearerContext({ speaker: 'Speaker 0', confidence: 'assumed' }), /assumed|not certain/i);
  const confirmed = formatWearerContext({ speaker: 'Speaker 0', confidence: 'confirmed', displayName: 'Nathan' });
  assert.match(confirmed, /Nathan/);
  assert.match(confirmed, /confirmed/i);
});

// ── turn_analysis validation ────────────────────────────────────────────────

test('turn_analysis is bounded and normalized; unknown enum values are never trusted', () => {
  const analysis = validateTurnAnalysis({
    speaker_role: 'not_a_role',
    addressed_to: 'the_dog',
    wearer_expected_to_respond: 'yes',
    assist_opportunity: 'x'.repeat(400),
  });
  assert.equal(analysis.speakerRole, 'unknown');
  assert.equal(analysis.addressedTo, 'unclear');
  assert.equal(analysis.wearerExpectedToRespond, false, 'only a real boolean true counts');
  assert.ok(analysis.assistOpportunity.length <= 140);
});

test('a missing turn_analysis degrades safely instead of failing the decision', () => {
  const result = validateDecision({
    decision: 'ignore',
    response: null,
    reason_summary: 'ambient',
    task_update: null,
    tool_calls: [],
    visual_analysis_request: null,
    scene_revision_used: null,
  });
  assert.equal(result.ok, true, 'observational metadata must never invalidate an otherwise valid decision');
  assert.equal(result.decision.turnAnalysis.speakerRole, 'unknown');
  assert.equal(result.decision.turnAnalysis.provided, false);
});

test('a well-formed turn_analysis reaches the decision intact', () => {
  const result = validateDecision({
    decision: 'ignore',
    response: null,
    reason_summary: 'the wearer was asked about the quote',
    task_update: null,
    tool_calls: [],
    visual_analysis_request: null,
    turn_analysis: {
      speaker_role: 'other_person',
      addressed_to: 'wearer',
      wearer_expected_to_respond: true,
      assist_opportunity: 'the wearer stored the quote total earlier',
    },
    scene_revision_used: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision.turnAnalysis, {
    speakerRole: 'other_person',
    addressedTo: 'wearer',
    wearerExpectedToRespond: true,
    assistOpportunity: 'the wearer stored the quote total earlier',
    provided: true,
  });
});

test('an empty assist_opportunity string is null, not an empty suggestion', () => {
  assert.equal(validateTurnAnalysis({ speaker_role: 'wearer', addressed_to: 'roma', wearer_expected_to_respond: false, assist_opportunity: '   ' }).assistOpportunity, null);
});

test('the wearer analysis fields are FLAT top-level scalars in the provider schema', () => {
  // Deliberately flat, not a nested object: a nested turn_analysis object
  // destabilized Groq's constrained decoding badly enough that whole turns
  // failed generation and direct questions went unanswered (virtual-lab
  // diagnosis, 2026-07-25). Flat scalars carry the same information cheaply.
  const properties = AGENT_DECISION_JSON_SCHEMA.properties;
  assert.equal(properties.turn_analysis, undefined, 'the nested object must stay gone');
  assert.deepEqual(properties.addressed_to.enum, ADDRESSED_TO);
  assert.equal(properties.wearer_expected_to_respond.type, 'boolean');
  assert.deepEqual(properties.assist_opportunity.type, ['string', 'null']);
  for (const field of ['addressed_to', 'wearer_expected_to_respond', 'assist_opportunity']) {
    assert.ok(AGENT_DECISION_JSON_SCHEMA.required.includes(field), `strict mode requires ${field}`);
  }
  // speaker_role is no longer asked of the model; the deterministic wearer
  // resolver answers that question instead.
  assert.equal(properties.speaker_role, undefined);
  assert.ok(SPEAKER_ROLES.includes('wearer'), 'the role vocabulary still exists for internal use');
});
