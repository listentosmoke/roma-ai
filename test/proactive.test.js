import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOpportunities, OPPORTUNITY_EVALUATION_JSON_SCHEMA } from '../src/proactive/schema.js';
import { createSuggestionStore, normalizeTokens } from '../src/proactive/suggestionStore.js';
import { scoreOpportunity, decideDelivery } from '../src/proactive/policy.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { createCapabilityRegistry } from '../src/proactive/capabilities.js';
import { DEFAULT_PREFERENCES, MODE_POLICIES } from '../src/proactive/preferences.js';
import { createMockContextSource, gatherContext } from '../src/proactive/contextSource.js';

export function makeOpportunity(overrides = {}) {
  return {
    type: 'conversation_coaching',
    content: 'Ask whether the price includes materials.',
    suggestedPhrase: 'Does that price include all materials?',
    confidence: 0.9,
    usefulness: 0.88,
    urgency: 'medium',
    timeSensitivity: 'immediate',
    reasonSummary: 'A price was given without defining what is included.',
    relatedEntities: [{ name: 'quoted_price', value: '$800' }],
    deliveryRecommendation: 'visual_only',
    expiresInMs: 15000,
    requiresPermission: false,
    backgroundTaskProposal: null,
    ...overrides,
  };
}

const prefs = (overrides = {}) => ({ ...DEFAULT_PREFERENCES, ...overrides });
const permissiveGate = () => createSpeechGate({ now: () => 1_000_000 });

// ── schema ────────────────────────────────────────────────────────────────────

test('opportunity schema accepts a valid evaluation and an empty one', () => {
  const full = validateOpportunities({ opportunities: [makeOpportunity()] });
  assert.equal(full.ok, true);
  assert.equal(full.opportunities.length, 1);
  assert.equal(full.opportunities[0].relatedEntities[0].value, '$800');

  const empty = validateOpportunities({ opportunities: [] });
  assert.equal(empty.ok, true);
  assert.equal(empty.opportunities.length, 0);
});

test('invalid opportunity output fails safely: garbage rejected, bad entries dropped, extras capped', () => {
  assert.equal(validateOpportunities(null).ok, false);
  assert.equal(validateOpportunities({ nope: 1 }).ok, false);

  const mixed = validateOpportunities({
    opportunities: [makeOpportunity(), { type: 'not_a_type', content: 'x' }, { type: 'follow_up' }],
  });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.opportunities.length, 1, 'invalid entries dropped');
  assert.ok(mixed.errors.length >= 2);

  const overfull = validateOpportunities({ opportunities: Array.from({ length: 6 }, () => makeOpportunity()) });
  assert.ok(overfull.opportunities.length <= 3);
});

test('a proposal-bearing opportunity always requires permission', () => {
  const { opportunities } = validateOpportunities({
    opportunities: [makeOpportunity({
      type: 'planning',
      requiresPermission: false,
      backgroundTaskProposal: { goal: 'Create a checklist', category: 'planning', reason: 'deadline', estimatedSteps: ['a'], requiredCapabilities: ['create_internal_plan'] },
    })],
  });
  assert.equal(opportunities[0].requiresPermission, true);
});

test('strict-mode schema has no open objects (additionalProperties false everywhere)', () => {
  const check = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
      assert.equal(node.additionalProperties, false, `open object found: ${JSON.stringify(node).slice(0, 80)}`);
    }
    for (const value of Object.values(node)) check(value);
  };
  check(OPPORTUNITY_EVALUATION_JSON_SCHEMA.properties.opportunities.items);
});

// ── suggestion store ──────────────────────────────────────────────────────────

test('rephrased duplicates are detected (normalized tokens + stemming)', () => {
  const store = createSuggestionStore({ now: () => 1000 });
  store.add(makeOpportunity({ content: 'Ask whether materials are included.' }), { interventionScore: 0.8, finalDelivery: 'visual_only', policyReason: 'x' }, 1000);
  const duplicate = store.findDuplicate(makeOpportunity({ content: 'Clarify if the price includes materials.', relatedEntities: [] }), 2000);
  assert.ok(duplicate, 'semantically equivalent phrasing should be a duplicate');
  const unrelated = store.findDuplicate(makeOpportunity({ content: 'Ask for a specific completion date.', suggestedPhrase: null, relatedEntities: [] }), 2000);
  assert.equal(unrelated, null);
});

test('entity overlap within the cooldown also marks duplicates', () => {
  const store = createSuggestionStore({ now: () => 1000 });
  store.add(makeOpportunity(), { interventionScore: 0.8, finalDelivery: 'visual_only', policyReason: 'x' }, 1000);
  const duplicate = store.findDuplicate(makeOpportunity({ content: 'Completely different words here.', relatedEntities: [{ name: 'p', value: '$800' }] }), 30000);
  assert.ok(duplicate);
  // …but not after the dedup window has passed.
  const later = store.findDuplicate(makeOpportunity({ content: 'Completely different words here.' }), 1000 + 100000);
  assert.equal(later, null);
});

test('the queue stays bounded: weakest active suggestion is evicted when full', () => {
  let t = 1000;
  const store = createSuggestionStore({ maxActive: 2, now: () => t });
  const meta = (score) => ({ interventionScore: score, finalDelivery: 'visual_only', policyReason: 'x' });
  store.add(makeOpportunity({ content: 'alpha one', relatedEntities: [] }), meta(0.9), t);
  store.add(makeOpportunity({ content: 'beta two', relatedEntities: [] }), meta(0.5), t);
  store.add(makeOpportunity({ content: 'gamma three', relatedEntities: [] }), meta(0.8), t);
  const active = store.active(t);
  assert.equal(active.length, 2);
  assert.ok(!active.some((s) => s.content === 'beta two'), 'lowest score evicted');
});

test('expired suggestions sweep out and cannot be displayed late', () => {
  let t = 1000;
  const store = createSuggestionStore({ now: () => t });
  const s = store.add(makeOpportunity({ expiresInMs: 500 }), { interventionScore: 0.8, finalDelivery: 'visual_only', policyReason: 'x' }, t);
  t = 2000;
  const expired = store.sweepExpired(t);
  assert.equal(expired.length, 1);
  assert.equal(store.markDisplayed(s.id, t), null, 'expired suggestions are not displayable');
});

test('a later transcript turn that resolves the issue invalidates the suggestion', () => {
  const store = createSuggestionStore({ now: () => 1000 });
  store.add(makeOpportunity(), { interventionScore: 0.8, finalDelivery: 'visual_only', policyReason: 'x' }, 1000);
  const invalidated = store.invalidateResolvedBy('Yes, the $800 includes all materials and labor.', 2000);
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].expiredReason, 'resolved by the conversation');
  assert.equal(store.active(2000).length, 0);
});

test('lifecycle statuses: accept, dismiss, convert-to-task, spoken', () => {
  const store = createSuggestionStore({ now: () => 1000 });
  const meta = { interventionScore: 0.8, finalDelivery: 'visual_only', policyReason: 'x' };
  const a = store.add(makeOpportunity({ content: 'first idea here', relatedEntities: [] }), meta, 1000);
  const b = store.add(makeOpportunity({ content: 'second concept entirely', relatedEntities: [], type: 'follow_up' }), meta, 1000);
  const c = store.add(makeOpportunity({ content: 'third notion altogether', relatedEntities: [], type: 'planning' }), meta, 1000);
  store.accept(a.id);
  store.dismiss(b.id);
  store.convertToTask(c.id, 'task_9');
  const all = store.all();
  assert.equal(all.find((s) => s.id === a.id).status, 'accepted');
  assert.equal(all.find((s) => s.id === b.id).status, 'dismissed');
  assert.equal(all.find((s) => s.id === c.id).status, 'converted_to_task');
  assert.equal(all.find((s) => s.id === c.id).relatedTaskId, 'task_9');
});

test('normalizeTokens strips stop words and stems suffixes', () => {
  const tokens = normalizeTokens('Ask whether the price includes materials.');
  assert.ok(tokens.has('price'));
  assert.ok(tokens.has('includ'));
  assert.ok(tokens.has('material'));
  assert.ok(!tokens.has('ask'));
  assert.ok(!tokens.has('whether'));
});

// ── speech gate ───────────────────────────────────────────────────────────────

test('unsolicited speech is blocked when spoken suggestions are disabled', () => {
  const gate = permissiveGate();
  const result = gate.requestSpeech({ prompted: false, preferences: prefs({ spokenSuggestionsEnabled: false }), urgent: true });
  assert.equal(result.approved, false);
  assert.match(result.reason, /disabled/);
});

test('prompted (direct-answer) speech is allowed and separately controllable', () => {
  const gate = permissiveGate();
  assert.equal(gate.requestSpeech({ prompted: true, preferences: prefs() }).approved, true);
  assert.equal(gate.requestSpeech({ prompted: true, preferences: prefs({ directAnswersMaySpeak: false }) }).approved, false);
});

test('speech budget: per-minute cap and minimum gap between spoken outputs', () => {
  let t = 1_000_000;
  const gate = createSpeechGate({ maxUnpromptedPerMinute: 1, minMsBetweenSpoken: 20000, now: () => t });
  const spoken = prefs({ spokenSuggestionsEnabled: true });
  assert.equal(gate.requestSpeech({ preferences: spoken, urgent: true }).approved, true);
  t += 5000;
  assert.equal(gate.requestSpeech({ preferences: spoken, urgent: true }).approved, false, 'min gap not met');
  t += 20000;
  assert.equal(gate.requestSpeech({ preferences: spoken, urgent: true }).approved, false, 'minute budget used');
  t += 40000;
  assert.equal(gate.requestSpeech({ preferences: spoken, urgent: true }).approved, true, 'budget window rolled over');
});

test('speech gate refuses while someone is speaking and for non-urgent asks', () => {
  const gate = permissiveGate();
  const spoken = prefs({ spokenSuggestionsEnabled: true });
  assert.equal(gate.requestSpeech({ preferences: spoken, urgent: true, someoneSpeaking: true }).approved, false);
  assert.equal(gate.requestSpeech({ preferences: spoken, urgent: false }).approved, false);
});

// ── intervention policy ───────────────────────────────────────────────────────

test('scoring is transparent and penalizes crowding', () => {
  const opp = makeOpportunity();
  const alone = scoreOpportunity(opp, { isNovel: true, recentShownCount: 0 });
  const crowded = scoreOpportunity(opp, { isNovel: true, recentShownCount: 3 });
  assert.ok(alone > crowded);
  assert.ok(alone > 0 && alone <= 1);
});

test('conversation coaching defaults to visual_only even when the model recommends speech', () => {
  const decision = decideDelivery(makeOpportunity({ deliveryRecommendation: 'speak_now' }), {
    preferences: prefs({ spokenSuggestionsEnabled: false }),
    speechGate: permissiveGate(),
  });
  assert.equal(decision.finalDelivery, 'visual_only');
  assert.equal(decision.suppressed, false);
  assert.match(decision.policyReason, /shown privately|speech denied/);
});

test('a model recommendation cannot bypass the deterministic gate — but urgency + enabled speech can pass it', () => {
  const blocked = decideDelivery(makeOpportunity({ deliveryRecommendation: 'speak_now', type: 'risk_or_concern', urgency: 'high' }), {
    preferences: prefs({ spokenSuggestionsEnabled: false }),
    speechGate: permissiveGate(),
  });
  assert.notEqual(blocked.finalDelivery, 'speak_now');

  const allowed = decideDelivery(makeOpportunity({ deliveryRecommendation: 'speak_now', type: 'risk_or_concern', urgency: 'high', timeSensitivity: 'immediate', usefulness: 0.95, confidence: 0.95 }), {
    preferences: prefs({ spokenSuggestionsEnabled: true }),
    speechGate: permissiveGate(),
  });
  assert.equal(allowed.finalDelivery, 'speak_now');
});

test('quiet mode suppresses ordinary opportunities; balanced shows high-value ones', () => {
  const good = makeOpportunity({ usefulness: 0.85, confidence: 0.85 });
  const quiet = decideDelivery(good, { preferences: prefs({ assistanceMode: 'quiet' }), speechGate: permissiveGate() });
  assert.equal(quiet.suppressed, true);
  assert.equal(quiet.threshold, MODE_POLICIES.quiet.scoreThreshold);

  const balanced = decideDelivery(good, { preferences: prefs({ assistanceMode: 'balanced' }), speechGate: permissiveGate() });
  assert.equal(balanced.finalDelivery, 'visual_only');
});

test('proactive mode lowers the bar but still respects visible-per-minute limits', () => {
  const modest = makeOpportunity({ usefulness: 0.7, confidence: 0.8, timeSensitivity: 'soon' });
  const shown = decideDelivery(modest, { preferences: prefs({ assistanceMode: 'proactive' }), speechGate: permissiveGate() });
  assert.equal(shown.finalDelivery, 'visual_only');

  const capped = decideDelivery(makeOpportunity({ usefulness: 0.95, confidence: 0.95 }), {
    preferences: prefs({ assistanceMode: 'proactive' }),
    speechGate: permissiveGate(),
    recentShownCount: MODE_POLICIES.proactive.maxVisiblePerMinute,
  });
  assert.equal(capped.finalDelivery, 'silent');
  assert.equal(capped.suppressed, true);
});

test('duplicates, low confidence, disabled features, and direct responses are discarded with reasons', () => {
  const gate = permissiveGate();
  assert.match(decideDelivery(makeOpportunity(), { preferences: prefs(), speechGate: gate, isDuplicate: true }).policyReason, /duplicate/);
  assert.match(decideDelivery(makeOpportunity({ confidence: 0.5 }), { preferences: prefs(), speechGate: gate }).policyReason, /below the user minimum/);
  assert.match(decideDelivery(makeOpportunity(), { preferences: prefs({ conversationCoachingEnabled: false }), speechGate: gate }).policyReason, /coaching is disabled/);
  assert.match(decideDelivery(makeOpportunity({ type: 'direct_response' }), { preferences: prefs(), speechGate: gate }).policyReason, /reactive agent/);
  assert.match(decideDelivery(makeOpportunity(), { preferences: prefs(), speechGate: gate, reactiveHandled: true }).policyReason, /already answering/);
});

test('proposal-bearing opportunities are routed to ask_permission', () => {
  const decision = decideDelivery(makeOpportunity({
    type: 'planning', usefulness: 0.9, confidence: 0.9,
    backgroundTaskProposal: { goal: 'Plan it', category: 'planning', reason: 'deadline', estimatedSteps: [], requiredCapabilities: ['create_internal_plan'] },
    requiresPermission: true,
  }), { preferences: prefs(), speechGate: permissiveGate() });
  assert.equal(decision.finalDelivery, 'ask_permission');
});

// ── capabilities ──────────────────────────────────────────────────────────────

test('external capabilities are blocked; internal planning is executable', () => {
  const registry = createCapabilityRegistry();
  assert.equal(registry.checkExecutable(['create_internal_plan']).executable, true);
  const sendBlocked = registry.checkExecutable(['send_message']);
  assert.equal(sendBlocked.executable, false, 'no implementation exists — cannot run even with confirmation');
  assert.equal(registry.checkExecutable(['search_approved_sources']).executable, false);
  assert.equal(registry.levelFor('made_up_capability'), 'not_available');
  assert.equal(registry.requiresConfirmation(['send_message']), true);
});

// ── context sources ───────────────────────────────────────────────────────────

test('mock context source filters by relevance and tolerates absence', async () => {
  const source = createMockContextSource('notes', [
    { summary: 'Repair quote from Bob was $800' },
    { summary: 'Grocery list for the weekend' },
  ]);
  const hits = await source.getRelevantContext({ query: 'repair price', entities: ['$800'] });
  assert.equal(hits.length, 1);
  assert.match(hits[0].summary, /Repair quote/);
  assert.deepEqual(await gatherContext([], { query: 'x' }), []);
});
