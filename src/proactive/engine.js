// Opportunity Engine — event-driven proactive evaluation. Complements the
// reactive agent (runtime.js answers direct requests; this detects coaching,
// missing details, follow-ups, and planning opportunities) and NEVER speaks or
// acts on its own authority: every model output passes schema validation, the
// deterministic intervention policy, and the shared speech gate.
//
// Evaluation triggers are EVENTS (finalized turns, agent responses, meaningful
// Inspector events, task changes, tool results, manual requests) — never video
// frames. Turns are batched over a short window so a thought split across tiny
// segments is evaluated once, and an evaluation fingerprint prevents re-calling
// the model on an unchanged conversation state.

import { now as clockNow } from '../clock.js';
import { compileSceneSnapshot } from '../context/compiler.js';
import { OPPORTUNITY_EVALUATION_JSON_SCHEMA, validateOpportunities } from './schema.js';
import { assembleEvaluationContext } from './prompt.js';
import { decideDelivery } from './policy.js';
import { createSuggestionStore } from './suggestionStore.js';
import { createSpeechGate } from './speechGate.js';
import { createCapabilityRegistry } from './capabilities.js';
import { gatherContext } from './contextSource.js';
import { DEFAULT_PREFERENCES } from './preferences.js';

const FINGERPRINT_CACHE_SIZE = 100;

/**
 * @param {{
 *   provider: { infer: Function },
 *   preferences?: () => object,        // live getter — the UI can change these anytime
 *   sceneStore?: { getState: Function },
 *   speechGate?: ReturnType<typeof createSpeechGate>,
 *   speech?: { speak: Function },
 *   store?: ReturnType<typeof createSuggestionStore>,
 *   capabilities?: ReturnType<typeof createCapabilityRegistry>,
 *   contextSources?: Array,
 *   batchWindowMs?: number,
 *   transcriptWindowSize?: number,
 *   onTaskApproved?: (task: object) => void, // convert an approved proposal into local task state
 *   now?: () => number,
 * }} deps
 */
export function createOpportunityEngine({
  provider,
  preferences = () => ({ ...DEFAULT_PREFERENCES }),
  sceneStore,
  speechGate = createSpeechGate(),
  speech,
  store = createSuggestionStore(),
  capabilities = createCapabilityRegistry(),
  contextSources = [],
  batchWindowMs = 1200,
  transcriptWindowSize = 12,
  onTaskApproved,
  now = clockNow,
} = {}) {
  const transcript = []; // bounded recent turns [{ id, speaker, text, at }]
  const listeners = new Set();
  const seenFingerprints = new Set();
  const proposals = new Map(); // proposalId -> proposal record
  let pendingBatch = [];
  let batchTimer = null;
  let batchMeta = { reactiveHandled: false };
  let lastToolResultId = null;
  let taskRevision = 0;
  let nextProposalId = 1;
  let evaluating = Promise.resolve();

  const metrics = {
    evaluations: 0, fingerprintSkips: 0, modelMsTotal: 0, policyMsTotal: 0,
    intakeToEvalMsTotal: 0, turnToDisplayMsTotal: 0, displayedWithLatency: 0,
    generated: 0, displayed: 0, spokenApproved: 0, discarded: 0, duplicatesSuppressed: 0,
    speechSuppressions: 0, expired: 0, accepted: 0, dismissed: 0, proposalsCreated: 0, proposalsApproved: 0,
    errors: 0,
  };

  function emit(event) {
    for (const listener of listeners) listener({ at: now(), ...event });
  }

  // Store lifecycle events (expired/dismissed/accepted) flow out as engine
  // events. Displayed/spoken are NOT forwarded — the engine emits its own,
  // richer versions (with deliveryMode, score, policy reason) for those.
  store.subscribe((event) => {
    if (event.type === 'suggestion-expired') metrics.expired += 1;
    if (event.type === 'suggestion-dismissed') metrics.dismissed += 1;
    if (event.type === 'suggestion-accepted') metrics.accepted += 1;
    if (event.type === 'suggestion-displayed' || event.type === 'suggestion-spoken') return;
    emit(event);
  });

  function fingerprint(batch) {
    return `${batch.map((turn) => turn.id).join(',')}|task:${taskRevision}|tool:${lastToolResultId ?? '-'}`;
  }

  function rememberFingerprint(value) {
    seenFingerprints.add(value);
    if (seenFingerprints.size > FINGERPRINT_CACHE_SIZE) {
      seenFingerprints.delete(seenFingerprints.values().next().value);
    }
  }

  function createProposal(opportunity, suggestion) {
    const proposal = {
      proposalId: `proposal_${nextProposalId++}`,
      goal: opportunity.backgroundTaskProposal.goal,
      category: opportunity.backgroundTaskProposal.category,
      reason: opportunity.backgroundTaskProposal.reason || opportunity.reasonSummary,
      estimatedSteps: opportunity.backgroundTaskProposal.estimatedSteps,
      requiredCapabilities: opportunity.backgroundTaskProposal.requiredCapabilities.length
        ? opportunity.backgroundTaskProposal.requiredCapabilities
        : ['create_internal_plan'],
      status: 'awaiting_approval',
      requiresPermission: true,
      suggestionId: suggestion?.id ?? null,
      createdAt: now(),
    };
    proposals.set(proposal.proposalId, proposal);
    metrics.proposalsCreated += 1;
    emit({ type: 'task-proposed', proposalId: proposal.proposalId, proposal: { ...proposal }, suggestionId: proposal.suggestionId });
    emit({ type: 'permission-required', proposalId: proposal.proposalId, policyReason: 'background tasks never start without approval' });
    return proposal;
  }

  async function evaluateNow(batch, meta) {
    const prefs = preferences();
    if (!prefs.proactiveAssistanceEnabled) return;

    const print = fingerprint(batch);
    if (seenFingerprints.has(print)) {
      metrics.fingerprintSkips += 1;
      return;
    }
    rememberFingerprint(print);

    const evalStart = now();
    const lastTurn = batch.at(-1);
    if (lastTurn) metrics.intakeToEvalMsTotal += Math.max(0, evalStart - lastTurn.at);

    // New turns may resolve open suggestions — invalidate before evaluating.
    for (const turn of batch) store.invalidateResolvedBy(turn.text, evalStart);
    store.sweepExpired(evalStart);

    const sceneState = sceneStore?.getState?.() ?? null;
    const contextItems = await gatherContext(contextSources, {
      query: lastTurn?.text ?? '',
      entities: [],
      limit: 5,
    });

    const context = assembleEvaluationContext({
      recentTranscript: transcript.slice(-transcriptWindowSize),
      currentSpeaker: lastTurn?.speaker ?? null,
      visualContext: sceneState ? compileSceneSnapshot(sceneState, { at: evalStart }) : '',
      activeTask: meta.activeTask ?? null,
      recentSuggestions: store.all().slice(-8),
      userPreferences: prefs,
      contextItems,
      reactiveHandled: meta.reactiveHandled,
      // What the reactive agent noticed it could do for the wearer on turns it
      // stayed silent for (src/agent/runtime.js's onAssistOpportunity).
      assistHints: meta.assistHints ?? [],
      at: evalStart,
    });

    metrics.evaluations += 1;
    let response;
    try {
      response = await provider.infer({ ...context, schema: OPPORTUNITY_EVALUATION_JSON_SCHEMA });
    } catch (error) {
      metrics.errors += 1;
      emit({ type: 'error', stage: 'opportunity-model', message: error?.message ?? String(error) });
      return;
    }
    metrics.modelMsTotal += response.latencyMs ?? 0;

    const validation = validateOpportunities(response.decisionRaw);
    if (!validation.ok) {
      metrics.errors += 1;
      emit({ type: 'error', stage: 'opportunity-validate', message: validation.errors.join('; ') });
      return;
    }

    const policyStart = now();
    // Highest-value first; the per-minute visible budget then naturally keeps
    // lower-value ones silent.
    const ranked = [...validation.opportunities].sort((a, b) => (b.usefulness + b.confidence) - (a.usefulness + a.confidence));
    for (const opportunity of ranked) {
      metrics.generated += 1;
      const duplicate = store.findDuplicate(opportunity, policyStart);
      const decision = decideDelivery(opportunity, {
        preferences: prefs,
        speechGate,
        isDuplicate: Boolean(duplicate),
        reactiveHandled: meta.reactiveHandled,
        recentShownCount: store.shownSince(60000, policyStart),
        someoneSpeaking: meta.someoneSpeaking ?? false,
      });

      emit({
        type: 'opportunity-detected',
        opportunity: { ...opportunity },
        interventionScore: decision.interventionScore,
        threshold: decision.threshold,
        finalDelivery: decision.finalDelivery,
        policyReason: decision.policyReason,
        transcriptIds: batch.map((turn) => turn.id),
      });

      if (decision.suppressed || decision.finalDelivery === 'discard') {
        metrics.discarded += 1;
        if (duplicate) metrics.duplicatesSuppressed += 1;
        if (/speech/.test(decision.policyReason)) metrics.speechSuppressions += 1;
        emit({
          type: duplicate ? 'policy-suppressed' : 'opportunity-discarded',
          opportunityContent: opportunity.content,
          policyReason: decision.policyReason,
          duplicateOf: duplicate?.id ?? null,
          transcriptIds: batch.map((turn) => turn.id),
        });
        continue;
      }

      const suggestion = store.add(opportunity, {
        interventionScore: decision.interventionScore,
        finalDelivery: decision.finalDelivery,
        policyReason: decision.policyReason,
        sourceTranscriptIds: batch.map((turn) => turn.id),
        sceneRevision: sceneState?.revision ?? null,
      }, policyStart);

      if (opportunity.backgroundTaskProposal) createProposal(opportunity, suggestion);

      if (decision.finalDelivery === 'silent') {
        emit({ type: 'suggestion-retained', suggestionId: suggestion.id, policyReason: decision.policyReason });
        continue;
      }

      store.markDisplayed(suggestion.id, policyStart);
      metrics.displayed += 1;
      if (lastTurn) {
        metrics.turnToDisplayMsTotal += Math.max(0, now() - lastTurn.at);
        metrics.displayedWithLatency += 1;
      }
      emit({
        type: 'suggestion-displayed',
        suggestionId: suggestion.id,
        deliveryMode: decision.finalDelivery,
        interventionScore: decision.interventionScore,
        policyReason: decision.policyReason,
        transcriptIds: batch.map((turn) => turn.id),
      });

      if (decision.finalDelivery === 'speak_now' || decision.finalDelivery === 'speak_when_convenient') {
        // The speech gate already approved this inside decideDelivery. If a full
        // voice-delivery layer is wired in, hand it the approval so it mints an
        // authorization and drives TTS/playback (speak_when_convenient waits for
        // a real conversational gap). Otherwise fall back to the legacy stub,
        // which only speaks immediately (speak_now).
        const spokenText = suggestion.suggestedPhrase ?? suggestion.content;
        if (speech?.authorizeAndDeliver) {
          speech.authorizeAndDeliver({
            gateDecision: { approved: true, reason: decision.policyReason },
            sourceType: 'conversation_coaching',
            sourceId: suggestion.id,
            text: spokenText,
            delivery: decision.finalDelivery,
            priority: 'low',
            unprompted: true,
            maxChars: 140,
            transcriptAt: lastTurn?.at,
            isStillValid: () => store.isDeliverable(suggestion.id),
          });
          store.markSpoken(suggestion.id);
          metrics.spokenApproved += 1;
          emit({ type: 'suggestion-spoken-approved', suggestionId: suggestion.id, deliveryMode: decision.finalDelivery, policyReason: decision.policyReason });
        } else if (decision.finalDelivery === 'speak_now') {
          speech?.speak?.(spokenText);
          store.markSpoken(suggestion.id);
          metrics.spokenApproved += 1;
          emit({ type: 'suggestion-spoken-approved', suggestionId: suggestion.id, policyReason: decision.policyReason });
        }
      }
    }
    metrics.policyMsTotal += now() - policyStart;
  }

  function scheduleBatch() {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => {
      batchTimer = null;
      const batch = pendingBatch;
      const meta = batchMeta;
      pendingBatch = [];
      batchMeta = { reactiveHandled: false };
      // Serialize evaluations so metrics/fingerprints stay consistent.
      evaluating = evaluating.then(() => evaluateNow(batch, meta)).catch(() => {});
    }, batchWindowMs);
  }

  return {
    /**
     * Feed one finalized transcript turn. `meta.reactiveHandled` marks that the
     * reactive agent is answering this turn (suppresses redundant coaching);
     * `meta.activeTask` carries the agent's current task state.
     */
    observeTurn(turn, meta = {}) {
      const at = turn.at ?? now();
      const entry = { id: turn.id ?? `t_${at}_${transcript.length}`, speaker: turn.speaker, text: turn.text, at };
      transcript.push(entry);
      if (transcript.length > transcriptWindowSize * 3) transcript.shift();
      pendingBatch.push(entry);
      batchMeta = { ...batchMeta, ...meta, reactiveHandled: batchMeta.reactiveHandled || Boolean(meta.reactiveHandled) };
      scheduleBatch();
      return entry;
    },

    /**
     * Attach metadata to the pending batch — e.g. the reactive agent just
     * decided to answer the turn currently awaiting evaluation, so redundant
     * coaching about it should be suppressed.
     */
    noteMeta(meta = {}) {
      batchMeta = { ...batchMeta, ...meta, reactiveHandled: batchMeta.reactiveHandled || Boolean(meta.reactiveHandled) };
    },

    /**
     * Wearer-centered assist hint (glasses reframe — src/agent/runtime.js's
     * onAssistOpportunity). The reactive agent stayed out of a conversation
     * but noticed a genuine chance to help the WEARER. This is evaluation
     * CONTEXT only: it makes the Opportunity Engine look at the moment, it
     * does not create a suggestion, and it authorizes nothing. The
     * Intervention Policy and Speech Gate still decide whether the wearer
     * ever sees or hears anything. Bounded to the few most recent hints.
     */
    noteAssistOpportunity(hint = {}) {
      if (!hint?.hint) return;
      const hints = [...(batchMeta.assistHints ?? []), {
        hint: String(hint.hint).slice(0, 140),
        addressedTo: hint.addressedTo ?? 'unclear',
        wearerExpectedToRespond: hint.wearerExpectedToRespond === true,
        turnId: hint.turnId ?? null,
      }].slice(-3);
      batchMeta = { ...batchMeta, assistHints: hints };
      scheduleBatch();
    },

    /** Non-transcript triggers: meaningful Inspector events, task changes, tool results. */
    observeEvent(kind, payload = {}) {
      if (kind === 'tool-result') lastToolResultId = payload.id ?? `${now()}`;
      if (kind === 'task-change') taskRevision = payload.revision ?? taskRevision + 1;
      // These make the NEXT batched evaluation see fresh state; a meaningful
      // Inspector event may also warrant an evaluation of the current context.
      if (kind === 'inspector-event' && pendingBatch.length === 0 && transcript.length) {
        pendingBatch.push(transcript.at(-1));
        scheduleBatch();
      }
    },

    /** Manually request an evaluation of the current context (UI button / tests). */
    requestEvaluation(meta = {}) {
      if (!transcript.length) return this.flush();
      pendingBatch.push(transcript.at(-1));
      batchMeta = { ...batchMeta, ...meta };
      scheduleBatch();
      return this.flush();
    },

    /** Wait for pending batches/evaluations to finish (tests + simulation). */
    async flush() {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
        const batch = pendingBatch;
        const meta = batchMeta;
        pendingBatch = [];
        batchMeta = { reactiveHandled: false };
        evaluating = evaluating.then(() => evaluateNow(batch, meta)).catch(() => {});
      }
      await evaluating;
    },

    /** Approve a background-task proposal: capability-checked, then converted locally. */
    approveProposal(proposalId) {
      const proposal = proposals.get(proposalId);
      if (!proposal || proposal.status !== 'awaiting_approval') return { ok: false, reason: 'proposal not found or already decided' };
      const check = capabilities.checkExecutable(proposal.requiredCapabilities);
      if (!check.executable) {
        proposal.status = 'blocked';
        emit({ type: 'task-rejected', proposalId, policyReason: check.reason });
        return { ok: false, reason: check.reason };
      }
      proposal.status = 'approved';
      metrics.proposalsApproved += 1;
      const task = {
        active: true,
        taskId: proposalId.replace('proposal', 'task'),
        goal: proposal.goal,
        status: 'planned',
        entities: { source: 'proactive-proposal' },
      };
      onTaskApproved?.(task);
      taskRevision += 1;
      if (proposal.suggestionId) store.convertToTask(proposal.suggestionId, task.taskId);
      emit({ type: 'task-approved', proposalId, taskId: task.taskId, policyReason: 'approved by the user' });
      return { ok: true, task };
    },

    rejectProposal(proposalId) {
      const proposal = proposals.get(proposalId);
      if (!proposal || proposal.status !== 'awaiting_approval') return { ok: false, reason: 'proposal not found or already decided' };
      proposal.status = 'rejected';
      emit({ type: 'task-rejected', proposalId, policyReason: 'rejected by the user' });
      return { ok: true };
    },

    proposals: () => [...proposals.values()].map((p) => ({ ...p })),
    suggestions: store,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    metrics() {
      const averages = {
        modelMs: metrics.evaluations ? +(metrics.modelMsTotal / metrics.evaluations).toFixed(1) : 0,
        policyMs: metrics.evaluations ? +(metrics.policyMsTotal / metrics.evaluations).toFixed(1) : 0,
        intakeToEvalMs: metrics.evaluations ? +(metrics.intakeToEvalMsTotal / metrics.evaluations).toFixed(1) : 0,
        turnToDisplayMs: metrics.displayedWithLatency ? +(metrics.turnToDisplayMsTotal / metrics.displayedWithLatency).toFixed(1) : 0,
      };
      return { ...metrics, averages };
    },
  };
}
