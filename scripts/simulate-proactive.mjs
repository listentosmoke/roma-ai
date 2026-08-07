// End-to-end PROACTIVE-ASSISTANCE simulation. Demonstrates the full policy
// pipeline with a scripted opportunity model (or the real Groq model with
// `--provider groq`): ambient speech ignored → a price without inclusions
// produces private visual coaching → a rephrased duplicate is suppressed → the
// conversation answers the question and the suggestion invalidates → a Friday
// deadline produces a background-task proposal that waits for approval → the
// approved proposal becomes local task state → a direct question still gets a
// normal reactive-agent answer. No speech, no external actions.
//
//   npm run simulate:proactive-agent

import { readFileSync, existsSync } from 'node:fs';
import { createOpportunityEngine } from '../src/proactive/engine.js';
import { createSpeechGate } from '../src/proactive/speechGate.js';
import { DEFAULT_PREFERENCES } from '../src/proactive/preferences.js';
import { OPPORTUNITY_SYSTEM_PROMPT } from '../src/proactive/prompt.js';
import { createMockProvider, createGroqProvider } from '../src/agent/provider.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { now } from '../src/clock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Scripted opportunity model (keyword-matched on the CURRENT conversation) ──
function currentTail(messages) {
  const conversation = /RECENT CONVERSATION \(most recent last\):\n([\s\S]*?)\n\nCURRENT SPEAKER/.exec(messages[0].content)?.[1] ?? '';
  return conversation.split('\n').at(-1) ?? '';
}

function scriptedEvaluate({ messages }) {
  const tail = currentTail(messages);
  const base = {
    suggestedPhrase: null, urgency: 'medium', timeSensitivity: 'immediate',
    relatedEntities: [], deliveryRecommendation: 'visual_only', expiresInMs: 30000,
    requiresPermission: false, backgroundTaskProposal: null,
  };
  if (/\$800/.test(tail) && /cost/.test(tail)) {
    return { opportunities: [{ ...base, type: 'missing_information', content: 'Ask whether the price includes materials.', suggestedPhrase: 'Does that $800 include materials and labor?', confidence: 0.91, usefulness: 0.88, reasonSummary: 'A price was given without defining what is included.', relatedEntities: [{ name: 'quoted_price', value: '$800' }] }] };
  }
  if (/pretty firm on that number/.test(tail)) {
    // Same useful idea, different words — must be deduplicated.
    return { opportunities: [{ ...base, type: 'missing_information', content: 'Clarify if the $800 price includes materials.', confidence: 0.9, usefulness: 0.85, reasonSummary: 'Price inclusions still unclear.', relatedEntities: [{ name: 'quoted_price', value: '$800' }] }] };
  }
  if (/before Friday/.test(tail)) {
    return { opportunities: [{ ...base, type: 'planning', content: 'I can help create a checklist and timeline for finishing this before Friday.', confidence: 0.9, usefulness: 0.9, timeSensitivity: 'soon', reasonSummary: 'The user mentioned a deadline but has no visible plan.', requiresPermission: true, backgroundTaskProposal: { goal: 'Create a checklist and timeline for completing the repair before Friday.', category: 'planning', reason: 'Deadline mentioned with no visible plan.', estimatedSteps: ['Identify required work', 'Determine missing information', 'Create timeline', 'Present plan'], requiredCapabilities: ['create_internal_plan'] } }] };
  }
  return { opportunities: [] };
}

const useGroq = process.argv.includes('--provider') && process.argv[process.argv.indexOf('--provider') + 1] === 'groq';
let opportunityProvider = createMockProvider(async (ctx) => scriptedEvaluate(ctx));
if (useGroq) {
  const env = existsSync('.env') ? Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).map((l) => l.split('=')).filter((p) => p.length === 2)) : {};
  const key = process.env.GROQ_API_KEY ?? env.GROQ_API_KEY ?? process.env.VITE_GROQ_API_KEY ?? env.VITE_GROQ_API_KEY;
  if (key) {
    const model = process.env.OPPORTUNITY_MODEL ?? env.OPPORTUNITY_MODEL ?? env.GROQ_MODEL ?? env.VITE_GROQ_MODEL ?? 'openai/gpt-oss-20b';
    console.error(`Using the REAL Groq opportunity model (${model}).\n`);
    opportunityProvider = createGroqProvider({ apiKey: key.trim(), model });
  } else {
    console.error('No GROQ_API_KEY found — using the scripted mock.\n');
  }
}

// ── Shared deterministic pieces: gate, preferences, engine, reactive agent ────
const preferences = { ...DEFAULT_PREFERENCES }; // spokenSuggestionsEnabled: false (default)
const speechGate = createSpeechGate();
const spokenOutput = [];
const speech = { speak: (text) => spokenOutput.push(text) };

const approvedTasks = [];
const reactiveAgent = createAgentRuntime({
  provider: createMockProvider(async ({ messages }) => {
    const asksRoma = /Roma, where/.test(messages[0].content.split('<- CURRENT TURN')[0].split('\n').at(-1) ?? '');
    return asksRoma
      ? { decision: 'respond', response: 'The hammer is in the upper-left of the toolbox.', reason_summary: 'direct question', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null }
      : { decision: 'ignore', response: null, reason_summary: 'ambient', task_update: null, tool_calls: [], visual_analysis_request: null, scene_revision_used: null };
  }),
  speech,
  speechGate,
  preferences: () => preferences,
});
const agentEvents = [];
reactiveAgent.subscribeOutput((e) => agentEvents.push(e));

const engine = createOpportunityEngine({
  provider: opportunityProvider,
  preferences: () => preferences,
  speechGate,
  speech,
  batchWindowMs: 10,
  onTaskApproved: (task) => { approvedTasks.push(task); reactiveAgent.setTaskState(task); },
});
const events = [];
engine.subscribe((event) => events.push(event));

// ── The scripted scene ─────────────────────────────────────────────────────────
const t0 = now();
const script = [
  { speaker: 'Jon', text: 'I went to the store yesterday and the traffic was terrible.' },
  { speaker: 'Bob (contractor)', text: 'The repair will cost $800.' },
  { speaker: 'Bob (contractor)', text: 'And I am pretty firm on that number.' },
  { speaker: 'Bob (contractor)', text: 'To be clear, that $800 price includes all materials and labor.' },
  { speaker: 'Jon', text: 'Okay. I need to finish this before Friday.' },
];

console.log('── Conversation → Opportunity Engine ──');
let step = 0;
for (const turn of script) {
  step += 1;
  console.log(`  ${turn.speaker}: ${turn.text}`);
  engine.observeTurn({ ...turn, at: t0 + step * 2000 });
  // eslint-disable-next-line no-await-in-loop
  await engine.flush();
  // eslint-disable-next-line no-await-in-loop
  await sleep(5);
}

console.log('\n── Proactive events ──');
for (const event of events) {
  if (event.type === 'suggestion-displayed') console.log(`  [shown/${event.deliveryMode}] score ${event.interventionScore} — ${event.policyReason}`);
  else if (event.type === 'policy-suppressed') console.log(`  [suppressed] "${event.opportunityContent}" — ${event.policyReason}`);
  else if (event.type === 'opportunity-discarded') console.log(`  [discarded] "${event.opportunityContent ?? ''}" — ${event.policyReason}`);
  else if (event.type === 'suggestion-expired') console.log(`  [invalidated] "${event.suggestion?.content}" — ${event.suggestion?.expiredReason}`);
  else if (event.type === 'task-proposed') console.log(`  [proposal] ${event.proposal.goal} (${event.proposal.status})`);
  else if (event.type === 'error') console.log(`  [error/${event.stage}] ${event.message}`);
}

// Approve the planning proposal (simulating the user's click).
const proposal = engine.proposals().find((p) => p.status === 'awaiting_approval');
const tasksBeforeApproval = approvedTasks.length;
if (proposal) {
  console.log(`\n  User approves: "${proposal.goal}"`);
  engine.approveProposal(proposal.proposalId);
}

// A direct question still flows through the reactive agent.
console.log('\n── Direct question → reactive agent ──');
console.log('  Jon: Roma, where is the hammer?');
await reactiveAgent.handleTurn({ speaker: 'Jon', text: 'Roma, where is the hammer?', startedAt: 12, endedAt: 12.5 });
const directAnswer = agentEvents.find((e) => e.type === 'response');
console.log(`  Roma: ${directAnswer?.text} (spoken approved: ${directAnswer?.spokenApproved})`);

// ── Checks ─────────────────────────────────────────────────────────────────────
const displayed = events.filter((e) => e.type === 'suggestion-displayed');
const suggestions = engine.suggestions.all();
const materialsSuggestion = suggestions.find((s) => /materials/.test(s.content));
const checks = [
  ['Ambient statement produced no suggestion', !suggestions.some((s) => /traffic/.test(s.content))],
  ['Price-without-inclusions produced the coaching suggestion', Boolean(materialsSuggestion)],
  ['Suggestion was displayed privately (visual_only), not spoken', displayed.some((e) => e.deliveryMode === 'visual_only') && engine.metrics().spokenApproved === 0 && materialsSuggestion?.spoken === false],
  ['Semantically duplicate suggestion was suppressed', engine.metrics().duplicatesSuppressed >= 1],
  ['Conversation answering the question invalidated the suggestion', materialsSuggestion?.status === 'expired' && materialsSuggestion?.expiredReason === 'resolved by the conversation'],
  ['Friday deadline produced a planning proposal', events.some((e) => e.type === 'task-proposed')],
  ['Proposal waited for approval (nothing ran automatically)', tasksBeforeApproval === 0 && events.some((e) => e.type === 'permission-required')],
  ['Approval created an internal planning task', approvedTasks.length === 1 && reactiveAgent.taskState().goal.includes('checklist')],
  ['No external communication or device action occurred', !events.some((e) => /send|device|purchase/.test(e.type))],
  ['Direct question got a normal reactive answer', Boolean(directAnswer) && /upper-left/.test(directAnswer.text)],
  ['Direct answer passed the shared speech gate', directAnswer?.spokenApproved === true && spokenOutput.length === 1],
  ['No unsolicited speech occurred', spokenOutput.length === 1],
];
console.log('\n── Checks ──');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}

// ── Metrics ────────────────────────────────────────────────────────────────────
const metrics = engine.metrics();
console.log(`\n── Metrics (${useGroq ? 'REAL Groq opportunity model' : 'scripted mock model'}) ──`);
console.log(`  evaluations                 ${metrics.evaluations} (fingerprint skips: ${metrics.fingerprintSkips})`);
console.log(`  opportunities generated     ${metrics.generated}`);
console.log(`  displayed / discarded       ${metrics.displayed} / ${metrics.discarded}`);
console.log(`  duplicates suppressed       ${metrics.duplicatesSuppressed}`);
console.log(`  spoken approved             ${metrics.spokenApproved}`);
console.log(`  expired (incl. resolved)    ${metrics.expired}`);
console.log(`  proposals created/approved  ${metrics.proposalsCreated} / ${metrics.proposalsApproved}`);
console.log(`  avg model latency           ${metrics.averages.modelMs} ms`);
console.log(`  avg policy latency          ${metrics.averages.policyMs} ms`);
console.log(`  avg turn→display latency    ${metrics.averages.turnToDisplayMs} ms`);

process.exitCode = failed ? 1 : 0;
