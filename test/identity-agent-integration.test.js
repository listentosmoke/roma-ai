// Runtime-integration tests: identity resolution feeding the Context Compiler
// through the EXISTING extension point (agent/prompt.js), exactly like
// memory-agent-integration.test.js does for memory. Covers: identity tools
// executing through the normal bounded tool-call loop, no bypass of the
// Speech Gate, the once-per-turn passive-resolution cache (no duplicate
// evidence across follow-up rounds within one turn), and the bounded
// memory<->identity relinking that fires after a completed write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createMockProvider } from '../src/agent/provider.js';
import { createIdentityCoordinator } from '../src/identity/coordinator.js';
import { createInMemoryIdentityRepository } from '../src/identity/repository.js';
import { createEntityResolver } from '../src/identity/resolver.js';
import { createDeterministicVoiceProvider } from '../src/identity/voiceProvider.js';
import { createMemoryCoordinator } from '../src/memory/coordinator.js';
import { createInMemoryRepository as createMemoryRepository } from '../src/memory/repository.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { createToolRegistry } from '../src/agent/tools.js';
import { registerIdentityTools } from '../src/identity/tools.js';
import { createSceneStore } from '../src/inspector/sceneStore.js';

function respondDecision(text) {
  return { decision: 'respond', response: text, reason_summary: 'relevant request', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
}
function toolCallDecision(name, args) {
  return { decision: 'tool_call', response: null, reason_summary: 'need a tool', task_update: null, tool_calls: [{ name, arguments: args }], visual_analysis_request: null, scene_revision_used: null };
}

function makeIdentity({ memoryRepository = null } = {}) {
  const repository = createInMemoryIdentityRepository();
  const voiceProvider = createDeterministicVoiceProvider();
  const resolver = createEntityResolver({ repository, voiceProvider });
  const identity = createIdentityCoordinator({ repository, resolver, voiceProvider, memoryRepository });
  return { repository, identity };
}

test('an identity tool call executes through the normal bounded tool-call loop, and its result reaches the follow-up round', async () => {
  const { identity } = makeIdentity();
  let contentByRound = [];
  let round = 0;
  const agentProvider = createMockProvider(async ({ messages }) => {
    round += 1;
    contentByRound.push(messages[0].content);
    if (round === 1) return toolCallDecision('name_current_speaker', { name: 'Matt', self: true });
    return respondDecision('Nice to meet you, Matt.');
  });
  const tools = createToolRegistry();
  registerIdentityTools(tools, { identity });
  const runtime = createAgentRuntime({ provider: agentProvider, identity, tools, maxToolRounds: 3 });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 5', text: "Roma, this is Matt speaking", startedAt: 0.1, endedAt: 0.4 });

  assert.equal(round, 2);
  assert.doesNotMatch(contentByRound[0], /CURRENT SPEAKER:/); // nothing known yet on round 1
  // The tool's own provisional result reaches round 2 via RECENT TOOL RESULTS —
  // self-identification alone is deliberately NOT promoted into a CURRENT
  // SPEAKER "resolved"/"provisional" claim by the passive resolver (a bare
  // name mention against the freshly-created alias is correctly weaker
  // evidence and stays 'unknown' — see identity-resolver.test.js's "a name
  // mention does NOT identify the current speaker").
  assert.match(contentByRound[1], /name_current_speaker:.*"status":"provisional"/);
  assert.doesNotMatch(contentByRound[1], /CURRENT SPEAKER:/);
});

test('identity resolution never bypasses the Speech Gate — a denied gate still blocks speech even with a resolved speaker', async () => {
  const { identity } = makeIdentity();
  identity.attribute({ sessionId: 'session_1000', speakerLabel: 'Speaker 0', name: 'Matt' });
  const speechGate = createSpeechGate();
  const denyingPreferences = () => ({ directAnswersMaySpeak: false });
  const agentProvider = createMockProvider(async () => respondDecision('Hello Matt.'));
  const runtime = createAgentRuntime({ provider: agentProvider, identity, speechGate, preferences: denyingPreferences });
  const events = [];
  runtime.subscribeOutput((e) => events.push(e));
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 0', text: 'what time is it?', startedAt: 0.1, endedAt: 0.4 });

  const response = events.find((e) => e.type === 'response');
  assert.ok(response);
  assert.equal(response.spokenApproved, false);
});

test('passive speaker resolution runs AT MOST ONCE per turn — a multi-round turn does not write duplicate name-mention evidence', async () => {
  const { identity, repository } = makeIdentity();
  const matt = identity.createPerson({ displayName: 'Matt' }).person;

  let round = 0;
  const agentProvider = createMockProvider(async () => {
    round += 1;
    if (round === 1) return toolCallDecision('check_clock', {}); // a non-identity tool, forces a second inferDecision this turn
    return respondDecision('OK.');
  });
  const runtime = createAgentRuntime({ provider: agentProvider, identity, maxToolRounds: 3 });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 7', text: 'Matt mentioned something about the schedule', startedAt: 0.1, endedAt: 0.4 });

  assert.equal(round, 2); // confirms resolve() had two opportunities to run if it weren't cached
  const nameMentionEvidence = repository.listEvidenceForPerson(matt.personId).filter((e) => e.evidenceType === 'name_mention');
  assert.equal(nameMentionEvidence.length, 1); // written once, not once per round
});

test('after a completed write, memories from the SAME interaction are relinked to the resolved speaker', async () => {
  const memoryRepository = createMemoryRepository();
  const extractionProvider = createMockProvider(async () => ({
    candidates: [{
      action: 'store', type: 'commitment', subject_id: 'person_user', predicate: 'send_quote', object: [],
      summary: 'The user agreed to send Matt the quote.', confidence: 0.9, importance: 0.8, evidence_type: 'user_stated', supersedes_memory_id: null, reason_code: 'explicit', tags: ['matt'],
    }],
  }));
  const memory = createMemoryCoordinator({ repository: memoryRepository, provider: extractionProvider });
  const { identity } = makeIdentity({ memoryRepository });
  identity.attribute({ sessionId: 'session_1000', speakerLabel: 'Speaker 2', name: 'Matt' });

  const agentProvider = createMockProvider(async () => respondDecision('Got it.'));
  const runtime = createAgentRuntime({ provider: agentProvider, memory, identity });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 2', text: 'remind me to send Matt the quote', startedAt: 0.1, endedAt: 0.4 });
  await runtime.pendingMemoryWrite();

  const stored = memoryRepository.exportAll()[0];
  assert.ok(stored);
  const matt = identity.get(memoryRepository.exportAll()[0].speakerEntityId);
  assert.equal(matt?.displayName, 'Matt');
});

test('with no identity configured, the runtime behaves exactly as before (no CURRENT SPEAKER section, no crash)', async () => {
  let seenContent;
  const agentProvider = createMockProvider(async ({ messages }) => { seenContent = messages[0].content; return respondDecision('Sure.'); });
  const runtime = createAgentRuntime({ provider: agentProvider }); // no identity
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 0', text: 'what time is it?', startedAt: 0.1, endedAt: 0.4 });
  assert.doesNotMatch(seenContent, /CURRENT SPEAKER:/);
});

// ── face evidence reaching the resolver through the live runtime (F3) ──────

test('who the camera can see reaches the identity resolver as presence, not as the speaker', async () => {
  const { identity, repository } = makeIdentity();
  const matt = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' }).person;
  const store = createSceneStore();
  store.update({
    objects: [],
    people: [{ id: 'track_1', identity: 'Matt', personId: matt.personId, faceProfileId: 'face_1', confidence: 0.86, quality: 0.9, lastSeenAt: 1000 }],
    sceneLabel: 'room',
    summary: 'One person is present.',
  }, 1000);

  const resolutions = [];
  identity.subscribe((event) => { if (event.type === 'identity-resolved') resolutions.push(event); });
  const provider = createMockProvider(async () => respondDecision('Sure.'));
  const runtime = createAgentRuntime({ provider, identity, sceneStore: store });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 0', text: 'Can you note that down?', startedAt: 0.1, endedAt: 0.4 });

  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].status, 'unknown', 'a face in frame is not proof of who is talking');
  assert.equal(resolutions[0].reasonCode, 'face_presence_not_speaker');

  const evidence = repository.listEvidenceForPerson(matt.personId);
  assert.equal(evidence.at(-1).evidenceType, 'face_match');
  assert.equal(evidence.at(-1).faceProfileId, 'face_1');
});

test('an unidentified person in frame produces no face evidence at all', async () => {
  const { identity, repository } = makeIdentity();
  const store = createSceneStore();
  store.update({
    objects: [],
    people: [{ id: 'track_1', identity: null, personId: null, confidence: 0, quality: 0, lastSeenAt: 1000 }],
    sceneLabel: 'room',
    summary: 'Someone is present.',
  }, 1000);

  const provider = createMockProvider(async () => respondDecision('Sure.'));
  const runtime = createAgentRuntime({ provider, identity, sceneStore: store });
  runtime.beginSession(1000);
  await runtime.handleTurn({ speaker: 'Speaker 0', text: 'Anything on the calendar?', startedAt: 0.1, endedAt: 0.4 });

  assert.deepEqual(repository.exportAll().evidence, [], 'perceiving a stranger must not create a record about them');
});
