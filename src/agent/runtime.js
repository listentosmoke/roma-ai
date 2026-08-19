// Main-agent runtime — the orchestration layer between perception and reasoning.
//
// Two APIs live here side by side:
//
//  - LEGACY (kept verbatim for back-compat): beginSession/observeTranscript/
//    respond/history — the original snapshot-injection proof. `infer` is a plain
//    fn(request) => string.
//
//  - NEW pipeline: handleTurn(segment) is the single entry point the audio engine
//    calls per finalized speaker turn. It runs the full decide/execute loop:
//    bounded transcript window → context assembly (prompt.js) → structured
//    decision from a pluggable `provider` (provider.js) → schema validation
//    (schema.js) → execute (ignore / respond / clarify / tool_call /
//    inspect_vision / update_task) → output events (subscribeOutput).
//
// Constants: the Inspector writes continuously; this runtime reads the latest
// Live Scene State at think-time via the Context Compiler and attaches it
// EPHEMERALLY. Visual snapshots and ambient transcript turns never permanently
// grow model-facing history — only turns the agent actually engages with do
// (conversationHistory). Turns are processed strictly in order via a single-
// flight FIFO queue, so a slow inference can never let a later turn's response
// arrive first.

import { now, toEpochMs } from '../clock.js';
import { compileSceneSnapshot, isStale, STALE_AFTER_MS } from '../context/compiler.js';
import { faceObservationsFromScene } from '../inspector/faces.js';
import { assembleContext } from './prompt.js';
import { validateDecision, validateTaskUpdate, AGENT_DECISION_JSON_SCHEMA } from './schema.js';
import { createProvider } from './provider.js';
import { createSpeechOutput } from './speech.js';
import { createEngagementTracker } from './engagement.js';
import { classifyAddressee, hasWakeWord } from './addressee.js';
import { createWearerResolver } from './wearer.js';
import { checkDirectAddress, checkEngineeringDispatch, buildCorrectionNote, buildDispatchCorrectionNote, correctionSucceeded } from './directAddress.js';
import { filterBySensitivity } from '../policy/sensitivity.js';

const mockInfer = async ({ input, visualContext }) =>
  `[mock agent] Heard: "${input}". Visual context attached: ${visualContext ? 'yes' : 'no'}.`;

// Tool names that themselves write memory (src/memory/tools.js). Kept as a
// small local set (not an import from memory/tools.js) to avoid coupling the
// agent module to which memory tools happen to be registered.
const MEMORY_WRITE_TOOL_NAMES = new Set(['remember_this', 'correct_memory']);

// Tool names that can change the CURRENT SPEAKER's resolution (src/identity/
// tools.js) — after any of these run, the cached per-turn resolution below is
// refreshed once more for the next follow-up round. Everything else reuses
// the turn's first resolution rather than re-resolving (see
// `resolveSpeakerOnce` below for why: re-running the passive resolver on
// every follow-up round could otherwise write duplicate ambiguous/voice-match
// evidence for the same turn).
const IDENTITY_REFRESH_TOOL_NAMES = new Set(['name_current_speaker', 'confirm_person_match', 'reject_person_match', 'merge_people', 'split_person']);

function emptyTaskState() {
  return { active: false, taskId: null, goal: '', status: '', entities: {}, updatedAt: 0 };
}

/**
 * @param {{
 *   sceneStore?: { getState: () => object },
 *   infer?: Function,                 // legacy back-compat inference fn
 *   provider?: { infer: Function },    // new: provider.js adapter (defaults to a no-op mock)
 *   tools?: { descriptions: Function, execute: Function },
 *   compile?: Function,
 *   maxHistory?: number,
 *   transcriptWindowSize?: number,
 *   transcriptWindowMs?: number,
 *   maxToolRounds?: number,            // total inferences allowed per turn (initial + follow-ups)
 *   staleAfterMs?: number,
 *   speech?: { speak: Function },
 *   speechGate?: { requestSpeech: Function },  // shared deterministic gate (proactive/speechGate.js)
 *   preferences?: () => object,                // live assistance preferences for the gate
 *   engagement?: ReturnType<typeof createEngagementTracker>,  // deterministic engagement window (engagement.js)
 *   engagementTimeoutMs?: number,
 * }} [options]
 */
export function createAgentRuntime({
  sceneStore,
  infer,
  provider,
  tools,
  compile = compileSceneSnapshot,
  maxHistory = 40,
  transcriptWindowSize = 30,
  transcriptWindowMs = 5 * 60 * 1000,
  maxToolRounds = 2,
  staleAfterMs = STALE_AFTER_MS,
  speech = createSpeechOutput(),
  speechGate,
  preferences,
  engagement = createEngagementTracker({ timeoutMs: 20000 }),
  // Optional Memory coordinator (src/memory/coordinator.js). Additive: with no
  // memory configured the runtime behaves exactly as before. When present,
  // retrieval only ever feeds the Context Compiler (assembleContext) — it can
  // never speak or bypass the Speech Gate — and the write boundary only fires
  // after a turn actually completes with a respond/clarify decision.
  memory,
  // Optional Identity coordinator (src/identity/coordinator.js). Additive,
  // same rule as memory: resolution only ever feeds the Context Compiler,
  // never speech directly. `sessionId` scopes bounded within-session speaker
  // continuity — a fresh runtime instance is a fresh session, so `Speaker 0`
  // in one run of the app is never assumed to be `Speaker 0` in another.
  identity,
  // Optional sensitivity-policy principal (src/policy/sensitivity.js). Additive:
  // with no policy configured, retrieval behaves exactly as before (every
  // memory/identity/relationship phase already ships bounded, relevance-gated
  // retrieval — this only adds an EXTRA, sensitivity-aware exclusion pass).
  // When configured, `policy.principal` scopes the pass — see `applyContextPolicy`
  // below. This runs AFTER retrieval and BEFORE assembleContext, per
  // SERVER-DATA.md "Context Compiler enforcement": denied records are
  // dropped here, never handed to the model to "decide" whether to use them.
  policy,
  // Wearer resolution (src/agent/wearer.js). Roma runs on glasses worn by one
  // person; knowing which diarized label is that person is what separates
  // "someone is asking the WEARER something" from "someone is asking ROMA
  // something". Deterministic, injectable for tests, never a model judgment.
  wearerResolver = createWearerResolver(),
  // Called when the model records a genuine chance to help the wearer on a turn
  // it otherwise stayed out of. This is a HINT into the proactive pipeline
  // (Opportunity Engine -> Intervention Policy -> Speech Gate), never speech
  // and never an action — the deterministic layers still decide everything.
  onAssistOpportunity,
  // Live getter for background tasks waiting on the wearer (see
  // src/agent/serverTasks.js). Read-only context; dispatch/approval happen
  // through tools, never through this.
  pendingTasks = () => [],
  // Live getter for the project allowlist. Roma cannot read files; this is the
  // list of places a background agent can, so she knows what is dispatchable
  // instead of concluding she has no access.
  registeredProjects = () => [],
} = {}) {
  // ── legacy state (unchanged behaviour) ──────────────────────────────────────
  const history = []; // [{ role, speaker?, content, at }] — text only, no scene data
  let sessionStartMs = now();
  // Identity session ID (src/identity/coordinator.js's bounded within-session
  // speaker continuity) — recomputed in beginSession() below, NOT fixed at
  // construction time. A runtime is typically built once but beginSession()
  // is called per listening session (mic Start); each one is a genuinely new
  // identity session, so `Speaker 0` from a previous session is never reused.
  let runtimeSessionId = `session_${sessionStartMs}`;

  // ── new-pipeline state ───────────────────────────────────────────────────────
  const transcriptWindow = []; // bounded ring of finalized turns, OUTSIDE the model
  const conversationHistory = []; // grows ONLY on agent-involved exchanges (respond/clarify)
  const outputListeners = new Set();
  let taskState = emptyTaskState();
  let turnCounter = 0;
  let queue = Promise.resolve(); // single-flight FIFO — guarantees in-order delivery
  let lastAssembled = null;
  const metricsTotals = { intake: 0, assemble: 0, model: 0, tool: 0, total: 0 };
  let metricsCount = 0;
  // Memory writes run fire-and-forget (extraction is a second, slower model
  // call and must never delay the next queued turn or the Speech Gate/TTS
  // path). Kept here so tests/simulation can `await
  // runtime.pendingMemoryWrite()` for a deterministic check instead of racing it.
  let lastMemoryWrite = Promise.resolve();

  const activeProvider = provider ?? createProvider({});

  function trimHistory() {
    if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
  }
  function trimConversation() {
    if (conversationHistory.length > maxHistory) conversationHistory.splice(0, conversationHistory.length - maxHistory);
  }
  function trimWindow(at) {
    const cutoff = at - transcriptWindowMs;
    while (transcriptWindow.length && transcriptWindow[0].at < cutoff) transcriptWindow.shift();
    while (transcriptWindow.length > transcriptWindowSize) transcriptWindow.shift();
  }

  function emit(event) {
    for (const listener of outputListeners) listener(event);
  }

  // ── legacy API (kept for existing tests/back-compat) ────────────────────────
  function beginSession(at = now()) {
    sessionStartMs = at;
    runtimeSessionId = `session_${at}`;
  }

  function observeTranscript(segment) {
    const at = toEpochMs(sessionStartMs, segment.startedAt);
    const endedAtMs = toEpochMs(sessionStartMs, segment.endedAt);
    const entry = { role: 'user', speaker: segment.speaker, content: segment.text, at, endedAtMs };
    history.push(entry);
    trimHistory();
    transcriptWindow.push({ speaker: segment.speaker, text: segment.text, at, endedAtMs, final: true, transcriptId: segment.id ?? null });
    trimWindow(at);
    return entry;
  }

  async function respond(input, at = now()) {
    const visualContext = sceneStore ? compile(sceneStore.getState(), { at }) : '';
    const request = { history: [...history], visualContext, input, at };
    const reply = await (infer ?? mockInfer)(request);
    history.push({ role: 'user', content: input, at });
    history.push({ role: 'assistant', content: reply, at: now() });
    trimHistory();
    return { reply, visualContext, request };
  }

  // ── new pipeline ─────────────────────────────────────────────────────────────

  function currentSceneInfo(at) {
    const state = sceneStore?.getState?.() ?? null;
    return {
      state,
      revision: state?.revision ?? null,
      updatedAt: state?.updatedAt ?? null,
      snapshot: compile(state, { at }),
      stale: isStale(state, at, staleAfterMs),
    };
  }

  async function runToolCalls(calls, turnId, toolContext = {}) {
    const results = [];
    for (const call of calls) {
      if (!tools) {
        results.push({ name: call.name, ok: false, error: 'No tools are registered.' });
        continue;
      }
      emit({ type: 'tool-started', turnId, name: call.name, arguments: call.arguments });
      const result = await tools.execute(call.name, call.arguments, { sceneStore, ...toolContext });
      results.push({ name: call.name, ok: result.ok, result: result.result, error: result.error, tookMs: result.tookMs ?? 0 });
      emit({ type: 'tool-completed', turnId, name: call.name, ok: result.ok, result: result.result, error: result.error, tookMs: result.tookMs ?? 0 });
    }
    return results;
  }

  function applyTaskUpdate(update, turnId) {
    if (!update) return;
    taskState = { ...update, updatedAt: now() };
    emit({ type: 'task-updated', turnId, taskState: { ...taskState } });
  }

  // Sensitivity-policy pass (src/policy/sensitivity.js) — runs AFTER
  // retrieval, BEFORE assembleContext. Tenant isolation is already a hard
  // guarantee at the server (a client-side mirror never contains another
  // tenant's records at all — see src/server/remoteMemoryRepository.js), so
  // this pass is specifically the SENSITIVITY exclusion required by
  // SERVER-DATA.md "Context Compiler enforcement": secret/biometric records
  // never reach this point in usable form, sensitive/private records need
  // real relevance, and every excluded record is dropped entirely rather
  // than handed to the model with a note to ignore it.
  function applyContextPolicy(relevantMemories, currentSpeaker) {
    if (!policy?.principal) return { relevantMemories, currentSpeaker };
    const { allowed: allowedMemories } = filterBySensitivity({
      action: 'memory.context_compile',
      records: relevantMemories.map((m) => ({ resourceId: m.memoryId, sensitivity: m.memory.sensitivity, workspaceId: policy.principal.workspaceId, item: m })),
      resourceType: 'memory', principal: policy.principal,
      context: { isProactive: false },
      relevanceOf: (r) => Math.min(1, r.item.relevanceScore ?? 0.5),
    });
    let filteredSpeaker = currentSpeaker;
    if (currentSpeaker?.relationships?.length) {
      const { allowed: allowedRelationships } = filterBySensitivity({
        action: 'relationship.context_compile',
        records: currentSpeaker.relationships.map((r) => ({ resourceId: r.relationshipId, sensitivity: r.sensitivity ?? 'normal', workspaceId: policy.principal.workspaceId, item: r })),
        resourceType: 'relationship', principal: policy.principal,
        context: { isProactive: false, relevance: 1 },
        relevanceOf: () => 1,
      });
      filteredSpeaker = { ...currentSpeaker, relationships: allowedRelationships.map((r) => r.item) };
    }
    return { relevantMemories: allowedMemories.map((r) => r.item), currentSpeaker: filteredSpeaker };
  }

  async function inferDecision({ currentTurn, toolResults, sceneInfo, at, turnId, interactionId, currentSpeaker: currentSpeakerInput, correctionNote = null }) {
    const assembleStart = now();
    // Memory retrieval feeds the Context Compiler ONLY — it is read here and
    // formatted into the prompt exactly like the visual snapshot; it can never
    // reach the Speech Gate or TTS directly (src/memory/coordinator.js).
    let relevantMemories = [];
    if (memory) {
      const retrieval = await memory.retrieve({
        query: currentTurn.text,
        currentTurnId: turnId,
        interactionId,
        speakerIds: currentTurn.speaker ? [currentTurn.speaker] : [],
        entityIds: [],
        currentGoals: taskState.active ? [taskState.goal] : [],
        time: at,
      });
      if (!retrieval.aborted) relevantMemories = retrieval.memories;
    }
    const policed = applyContextPolicy(relevantMemories, currentSpeakerInput);
    relevantMemories = policed.relevantMemories;
    const currentSpeaker = policed.currentSpeaker;
    const context = assembleContext({
      currentTurn,
      transcriptWindow,
      taskState: taskState.active ? taskState : null,
      visualContext: sceneInfo.snapshot,
      sceneRevision: sceneInfo.revision,
      visualUpdatedAt: sceneInfo.updatedAt,
      toolResults,
      tools: tools?.descriptions() ?? [],
      relevantMemories,
      // Identity/relationship context (src/identity/coordinator.js) — same
      // rule as memory: this is READ ONLY here, resolved once per turn by
      // processTurn (see resolveSpeakerOnce), and formatted exactly like the
      // visual snapshot. It can never reach the Speech Gate or TTS directly.
      currentSpeaker,
      relevantRelationships: currentSpeaker?.relationships ?? [],
      // Who is wearing the glasses (src/agent/wearer.js) — resolved in code
      // from identity evidence or close-mic dominance, never guessed by the
      // model. Everything the model concludes about "who was spoken to"
      // depends on this line being honest about its own confidence.
      wearer: wearerResolver.resolve(),
      // Background work blocked on the wearer (src/agent/serverTasks.js) — a
      // bounded, read-only list so a spoken "yes, go ahead" resolves to the
      // right task. Dispatch and approval happen through tools, never here.
      pendingTasks: typeof pendingTasks === 'function' ? (pendingTasks() ?? []) : [],
      registeredProjects: typeof registeredProjects === 'function' ? (registeredProjects() ?? []) : [],
      // Deterministic engagement signal — informs the model only; it does not
      // override the model's ignore/respond/clarify judgment (engagement.js).
      engagementActive: engagement.isActive(at),
      engagementRemainingMs: engagement.remainingMs(at),
      // Deterministic direct-address correction (src/agent/directAddress.js),
      // present only on a recheck pass. It states a contradiction with
      // observable facts; it never dictates what to say.
      correctionNote,
      at,
    });
    const assembleMs = now() - assembleStart;
    lastAssembled = context;
    const result = await activeProvider.infer({ ...context, schema: AGENT_DECISION_JSON_SCHEMA });
    return { ...result, assembleMs, context, relevantMemories };
  }

  /** Most recent speaker in the transcript window that ISN'T the current turn's speaker — used so "that was Matt" (identity/tools.js's name_current_speaker with self:false) attributes the right slot, not the person talking right now. */
  function previousSpeakerLabel(currentTurn) {
    for (let i = transcriptWindow.length - 2; i >= 0; i -= 1) {
      const entry = transcriptWindow[i];
      if (entry.speaker && entry.speaker !== currentTurn.speaker) return entry.speaker;
    }
    return null;
  }

  function toolCallsFor(decision) {
    if (decision.decision === 'tool_call') return decision.toolCalls;
    const request = decision.visualAnalysisRequest;
    const name = request.timestampMs != null ? 'inspect_view_at_time' : 'inspect_current_view';
    const args = request.timestampMs != null
      ? { question: request.question, timestampMs: request.timestampMs }
      : { question: request.question };
    return [{ name, arguments: args }];
  }

  function recordMetrics(sample) {
    metricsCount += 1;
    for (const key of Object.keys(metricsTotals)) metricsTotals[key] += sample[key] ?? 0;
  }

  async function processTurn(segment, enqueuedAt) {
    turnCounter += 1;
    const turnId = turnCounter;
    const interactionId = `interaction_${turnId}`;
    const processingStartedAt = now();
    const intakeMs = processingStartedAt - enqueuedAt;

    const entry = observeTranscript(segment);
    const currentTurn = { speaker: segment.speaker, text: segment.text, at: entry.at };
    // Feed the wearer resolver every finalized turn. `level` (when the caller
    // supplies it) is the mic level for this turn — the wearer's own voice is
    // consistently the loudest at glasses range. Bounded and deterministic.
    wearerResolver.record({ speaker: segment.speaker, level: segment.level ?? null, at: entry.at });
    const sceneInfoAtStart = currentSceneInfo(processingStartedAt);

    let toolResults = [];
    let assembleMs = 0;
    let modelMs = 0;
    let toolMs = 0;
    let decision = null;
    let inferenceCount = 0;
    let loopCapped = false;
    // If the model already used an explicit memory-writing tool this turn
    // (remember_this / correct_memory — src/memory/tools.js), the automatic
    // write boundary below is skipped: writing the SAME turn twice would fire
    // a second, redundant extraction model call and could race with the
    // explicit one. Everything else (respond/clarify without a memory tool)
    // still goes through the automatic boundary as normal.
    let memoryToolInvoked = false;
    // Passive speaker resolution (src/identity/coordinator.js) is computed AT
    // MOST once per turn and cached here, refreshed only after a tool call
    // that can actually change it (IDENTITY_REFRESH_TOOL_NAMES). Unlike
    // memory.retrieve(), identity resolution can WRITE evidence (e.g. an
    // ambiguous/candidate voice match) — re-running it on every follow-up
    // round within the same turn would duplicate that evidence, so it is
    // deliberately NOT re-run every loop iteration the way memory retrieval is.
    let resolvedSpeaker = null;
    let needsSpeakerResolution = Boolean(identity);

    while (inferenceCount < maxToolRounds) {
      inferenceCount += 1;
      if (needsSpeakerResolution) {
        resolvedSpeaker = await identity.resolveSpeakerForTurn({
          sessionId: runtimeSessionId,
          interactionId,
          turnId,
          speakerLabel: currentTurn.speaker,
          transcriptIds: [segment.id ?? null].filter(Boolean),
          transcriptText: currentTurn.text,
          // No bounded raw-audio-sample pipeline exists in this environment
          // (src/audio.js streams PCM directly to Deepgram; nothing buffers
          // it) — see identity/voiceProvider.js "FEASIBILITY FINDING". Voice
          // matching is exercised only in tests/simulation, which call the
          // resolver/coordinator directly with a sample reference.
          voiceSampleRef: null,
          // Who the camera can see right now. The resolver treats this as
          // presence, not speech (see its header): it corroborates or
          // contradicts a voice match and otherwise only records that someone
          // was there. Empty whenever the camera is off.
          faceObservations: faceObservationsFromScene(sceneInfoAtStart.state),
          time: currentTurn.at,
        });
        needsSpeakerResolution = false;
        // If identity resolved this speaker to a named person AND we already
        // believe this label is the wearer, teach the wearer resolver the
        // name. This never promotes anyone to wearer — it only names the
        // wearer we had already identified, which is what lets Roma tell
        // "Hey Alex, can you…" apart from a request aimed at itself.
        if (resolvedSpeaker?.person?.displayName) {
          wearerResolver.nameWearer({
            speaker: currentTurn.speaker,
            personId: resolvedSpeaker.person.personId,
            displayName: resolvedSpeaker.person.displayName,
          });
        }
      }

      let inferResult;
      try {
        inferResult = await inferDecision({ currentTurn, toolResults, sceneInfo: sceneInfoAtStart, at: now(), turnId, interactionId, currentSpeaker: resolvedSpeaker });
      } catch (error) {
        emit({ type: 'error', turnId, stage: 'model', message: error?.message ?? String(error) });
        return;
      }
      assembleMs += inferResult.assembleMs;
      modelMs += inferResult.latencyMs ?? 0;

      const validation = validateDecision(inferResult.decisionRaw);
      if (!validation.ok) {
        emit({ type: 'error', turnId, stage: 'validate', message: `Invalid model output: ${validation.errors.join('; ')}` });
        return;
      }
      decision = validation.decision;
      if (decision.taskUpdate) applyTaskUpdate(decision.taskUpdate, turnId);

      const wantsFollowUp = decision.decision === 'tool_call' || decision.decision === 'inspect_vision';
      if (!wantsFollowUp) break;

      if (inferenceCount >= maxToolRounds) loopCapped = true;

      const calls = toolCallsFor(decision);
      if (calls.some((c) => MEMORY_WRITE_TOOL_NAMES.has(c.name))) memoryToolInvoked = true;
      if (identity && calls.some((c) => IDENTITY_REFRESH_TOOL_NAMES.has(c.name))) needsSpeakerResolution = true;
      const toolStart = now();
      const results = await runToolCalls(calls, turnId, {
        turnId,
        interactionId,
        speaker: currentTurn.speaker,
        sessionId: runtimeSessionId,
        previousSpeaker: previousSpeakerLabel(currentTurn),
        transcriptIds: [segment.id ?? null].filter(Boolean),
        transcriptText: currentTurn.text,
      });
      toolMs += now() - toolStart;
      toolResults = [...toolResults, ...results];

      if (loopCapped) break;
    }

    // ── direct-address guard (src/agent/directAddress.js) ────────────────────
    // Roma runs on glasses and is taught that most speech is not for it. The
    // one failure that is never acceptable is being asked something and
    // staying silent. If the final decision is `ignore` but deterministic
    // evidence says the turn WAS for Roma — the wake word was spoken, an
    // interaction window is open, or the model's own turn_analysis says
    // addressed_to="roma" — we ask the model ONCE more with the contradiction
    // stated. Nothing is fabricated: the retry may legitimately ignore again,
    // and that second answer stands.
    const wakeWordPresent = hasWakeWord(currentTurn.text);
    const engagementActiveNow = engagement.isActive(currentTurn.at);
    // Two deterministic consistency checks share one bounded recheck slot:
    // a request that went unanswered, or engineering work that was answered
    // instead of dispatched to the server agent. Both only ASK the model
    // again; neither dictates the outcome.
    const addressCheck = checkDirectAddress({
      decision,
      hasWakeWord: wakeWordPresent,
      engagementActive: engagementActiveNow,
    });
    const dispatchCheck = addressCheck.inconsistent
      ? { inconsistent: false }
      : checkEngineeringDispatch({ decision, text: currentTurn.text, toolResults });
    const directCheck = addressCheck.inconsistent ? addressCheck : dispatchCheck;
    const buildNote = addressCheck.inconsistent ? buildCorrectionNote : buildDispatchCorrectionNote;
    if (directCheck.inconsistent && inferenceCount < maxToolRounds + 1) {
      emit({ type: 'direct-address-recheck', turnId, reasonCode: directCheck.reasonCode, evidence: directCheck.evidence });
      try {
        inferenceCount += 1;
        const retry = await inferDecision({
          currentTurn,
          toolResults,
          sceneInfo: sceneInfoAtStart,
          at: now(),
          turnId,
          interactionId,
          currentSpeaker: resolvedSpeaker,
          correctionNote: buildNote(directCheck.evidence),
        });
        assembleMs += retry.assembleMs;
        modelMs += retry.latencyMs ?? 0;
        const retryValidation = validateDecision(retry.decisionRaw);
        if (retryValidation.ok) {
          const corrected = correctionSucceeded(retryValidation.decision);
          if (corrected) {
            decision = retryValidation.decision;
            if (decision.taskUpdate) applyTaskUpdate(decision.taskUpdate, turnId);
            // A retry that asks for a tool still needs its tools run, exactly
            // like the main loop would have done.
            if (decision.decision === 'tool_call' || decision.decision === 'inspect_vision') {
              const retryCalls = toolCallsFor(decision);
              if (retryCalls.some((c) => MEMORY_WRITE_TOOL_NAMES.has(c.name))) memoryToolInvoked = true;
              const retryToolStart = now();
              const retryResults = await runToolCalls(retryCalls, turnId, {
                turnId,
                interactionId,
                speaker: currentTurn.speaker,
                sessionId: runtimeSessionId,
                previousSpeaker: previousSpeakerLabel(currentTurn),
                transcriptIds: [segment.id ?? null].filter(Boolean),
                transcriptText: currentTurn.text,
              });
              toolMs += now() - retryToolStart;
              toolResults = [...toolResults, ...retryResults];
              const finalTry = await inferDecision({ currentTurn, toolResults, sceneInfo: sceneInfoAtStart, at: now(), turnId, interactionId, currentSpeaker: resolvedSpeaker });
              assembleMs += finalTry.assembleMs;
              modelMs += finalTry.latencyMs ?? 0;
              const finalValidation = validateDecision(finalTry.decisionRaw);
              if (finalValidation.ok) {
                decision = finalValidation.decision;
                if (decision.taskUpdate) applyTaskUpdate(decision.taskUpdate, turnId);
              }
            }
          }
          emit({ type: 'direct-address-resolved', turnId, reasonCode: directCheck.reasonCode, corrected, decision: decision.decision });
        }
      } catch (error) {
        // A failed recheck must never lose the original decision.
        emit({ type: 'error', turnId, stage: 'direct-address-recheck', message: error?.message ?? String(error) });
      }
    }

    const finishAt = now();
    const latestRevision = sceneStore?.getState?.()?.revision ?? null;
    const possiblyOutdated = sceneInfoAtStart.revision != null && latestRevision != null && latestRevision !== sceneInfoAtStart.revision;
    if (possiblyOutdated) {
      // eslint-disable-next-line no-console
      console.warn(`[agent] scene revision changed (${sceneInfoAtStart.revision} -> ${latestRevision}) while processing turn ${turnId}`);
    }

    const totalMs = finishAt - enqueuedAt;
    recordMetrics({ intake: intakeMs, assemble: assembleMs, model: modelMs, tool: toolMs, total: totalMs });

    const visualAgeMs = sceneInfoAtStart.updatedAt ? processingStartedAt - sceneInfoAtStart.updatedAt : null;
    const meta = {
      turnId,
      sceneRevisionUsed: sceneInfoAtStart.revision,
      visualAgeMs,
      possiblyOutdated,
      modelMs, toolMs, totalMs,
    };

    if (loopCapped && (decision.decision === 'tool_call' || decision.decision === 'inspect_vision')) {
      emit({ type: 'error', stage: 'loop-cap', message: 'Exceeded the maximum follow-up inference rounds for this turn.', ...meta });
      return;
    }

    // Deterministic addressee/engagement overlay (src/agent/addressee.js,
    // src/agent/engagement.js) — observability only. It never changes
    // `decision.decision`; it classifies WHY the model's own choice counts as
    // addressed-to-Roma or not, and lets a respond/clarify/update_task turn open
    // a bounded window so a follow-up needn't repeat the wake word.
    const engagementWasActive = engagement.isActive(currentTurn.at);
    const addressee = classifyAddressee({
      text: currentTurn.text,
      decision: decision.decision,
      engagementActive: engagementWasActive,
      turnAnalysis: decision.turnAnalysis,
    });
    if (decision.decision === 'respond' || decision.decision === 'clarify' || decision.decision === 'update_task') {
      engagement.markEngaged(turnId, currentTurn.at);
    }
    emit({
      type: 'addressee-decision',
      turnId,
      transcriptId: segment.id ?? null,
      speaker: currentTurn.speaker,
      text: currentTurn.text,
      decision: addressee.decision,
      addressedToRoma: addressee.addressedToRoma,
      confidence: addressee.confidence,
      reasonCode: addressee.reasonCode,
      engagementActive: engagementWasActive,
      // Wearer-centered analysis (schema.js turn_analysis). Observability only:
      // it records what Roma UNDERSTOOD about the moment, never what it did.
      speakerRole: addressee.speakerRole,
      addressedTo: addressee.addressedTo,
      wearerExpectedToRespond: addressee.wearerExpectedToRespond,
      assistOpportunity: addressee.assistOpportunity,
      wearer: wearerResolver.resolve(),
    });

    // A chance to help the wearer on a turn Roma stayed out of. Handed to the
    // proactive pipeline as CONTEXT for evaluation — the Opportunity Engine
    // decides whether it is worth surfacing, the Intervention Policy decides
    // how, and the Speech Gate decides whether it may be spoken. Nothing here
    // speaks, and a failure in the listener can never break the turn.
    if (addressee.assistOpportunity && !addressee.addressedToRoma && typeof onAssistOpportunity === 'function') {
      try {
        onAssistOpportunity({
          turnId,
          hint: addressee.assistOpportunity,
          speaker: currentTurn.speaker,
          text: currentTurn.text,
          addressedTo: addressee.addressedTo,
          wearerExpectedToRespond: addressee.wearerExpectedToRespond,
          at: currentTurn.at,
        });
      } catch (error) {
        console.warn('[agent] assist-opportunity listener failed:', error?.message ?? error);
      }
    }

    switch (decision.decision) {
      case 'respond':
      case 'clarify': {
        conversationHistory.push({ role: 'user', speaker: currentTurn.speaker, content: currentTurn.text, at: currentTurn.at });
        conversationHistory.push({ role: 'assistant', content: decision.response, at: now() });
        trimConversation();

        // Memory write boundary: a completed user-agent interaction (this is
        // one of the defined boundaries — NOT run per video frame or per
        // ambient/ignored turn). Fire-and-forget: extraction must never delay
        // the Speech Gate/TTS path below. A turn that fails validation/model
        // inference above already returned early, so only a genuinely
        // completed respond/clarify reaches here (src/memory/coordinator.js).
        if (memory && !memoryToolInvoked) {
          const recentSegments = transcriptWindow.slice(-6).map((t) => ({ speaker: t.speaker, text: t.text, at: t.at, transcriptId: t.transcriptId ?? null }));
          lastMemoryWrite = memory.writeInteraction({
            interactionId,
            turnIds: [turnId],
            transcriptIds: [segment.id ?? null].filter(Boolean),
            sceneEventIds: [],
            speakerId: currentTurn.speaker,
            transcriptSegments: recentSegments,
            sceneSnapshot: sceneInfoAtStart.snapshot,
            userText: currentTurn.text,
            agentResponse: decision.response,
            toolResults,
            model: activeProvider?.model ?? activeProvider?.name ?? null,
            completed: true,
          }).then((result) => {
            // Bounded, explicit relinking (src/identity/coordinator.js): only
            // the memory(ies) just written for THIS interaction, only when
            // this turn's speaker actually resolved to a confirmed/known
            // person — never a historical sweep, never a guess across
            // unrelated memories.
            if (identity && resolvedSpeaker?.status === 'resolved' && resolvedSpeaker.personId) {
              identity.relinkMemoriesForInteraction({ interactionId, speakerLabel: currentTurn.speaker, personId: resolvedSpeaker.personId });
            }
            return result;
          }).catch((error) => {
            emit({ type: 'error', turnId, stage: 'memory-write', message: error?.message ?? String(error) });
          });
        }

        // Direct answers are PROMPTED speech, but still pass the shared
        // deterministic gate — no model decision reaches the speech adapter
        // without policy approval. Without a gate configured, prompted speech
        // is allowed (original behavior).
        const gateDecision = speechGate
          ? speechGate.requestSpeech({ prompted: true, preferences: preferences?.() ?? {} })
          : { approved: true, reason: 'no speech gate configured' };
        // If a full voice-delivery layer is wired in (browser / voice sim), it
        // mints the authorization from this same gate decision and drives
        // TTS + playback. Otherwise fall back to the legacy speak() stub. Either
        // way, nothing speaks without gate approval.
        let authorizationId = null;
        if (speech?.authorizeAndDeliver) {
          const delivery = speech.authorizeAndDeliver({
            gateDecision,
            sourceType: 'direct_response',
            sourceId: `turn_${turnId}`,
            text: decision.response,
            delivery: 'speak_now',
            priority: 'normal',
            turnId,
            unprompted: false,
            transcriptAt: currentTurn.at,
          });
          authorizationId = delivery.authorizationId ?? null;
        } else if (gateDecision.approved) {
          speech.speak(decision.response);
        }
        emit({
          type: decision.decision === 'respond' ? 'response' : 'clarification',
          text: decision.response,
          reasonSummary: decision.reasonSummary,
          spokenApproved: gateDecision.approved,
          speechReason: gateDecision.reason,
          authorizationId,
          ...meta,
        });
        break;
      }
      case 'ignore':
        emit({ type: 'ignored-turn', reasonSummary: decision.reasonSummary, ...meta });
        break;
      case 'update_task':
        // task-updated already emitted above by applyTaskUpdate.
        break;
      default:
        break;
    }
  }

  /** Single entry point for finalized speaker turns from the audio engine. */
  function handleTurn(segment) {
    const enqueuedAt = now();
    const turnPromise = queue.then(
      () => processTurn(segment, enqueuedAt),
      () => processTurn(segment, enqueuedAt), // a previous turn's rejection must not block this one
    );
    queue = turnPromise;
    return turnPromise;
  }

  function subscribeOutput(listener) {
    outputListeners.add(listener);
    return () => outputListeners.delete(listener);
  }

  function metrics() {
    if (!metricsCount) return { turns: 0, averageMs: { intake: 0, assemble: 0, model: 0, tool: 0, total: 0 } };
    const averageMs = {};
    for (const key of Object.keys(metricsTotals)) averageMs[key] = +(metricsTotals[key] / metricsCount).toFixed(1);
    return { turns: metricsCount, averageMs };
  }

  return {
    // legacy
    beginSession,
    observeTranscript,
    respond,
    history: () => [...history],
    // new pipeline
    handleTurn,
    subscribeOutput,
    /** Externally set task state (e.g. an approved proactive proposal); validated like a model task_update. */
    setTaskState(update) {
      const validation = validateTaskUpdate(update);
      if (!validation.ok) return { ok: false, errors: validation.errors };
      applyTaskUpdate(validation.value, 0);
      return { ok: true, taskState: { ...taskState } };
    },
    taskState: () => ({ ...taskState }),
    transcriptWindow: () => [...transcriptWindow],
    conversationHistory: () => [...conversationHistory],
    lastAssembledInput: () => (lastAssembled ? { ...lastAssembled } : null),
    /** The current (or most recent) fire-and-forget memory write — await for deterministic tests/simulation. */
    pendingMemoryWrite: () => lastMemoryWrite,
    /** Deterministic engagement window (src/agent/engagement.js) — for UI/diagnostics. */
    engagementState: () => engagement.state(),
    /** Who Roma currently believes is wearing the glasses (src/agent/wearer.js) — for UI/diagnostics/tests. */
    wearerState: () => wearerResolver.resolve(),
    /** Explicit wearer confirmation from the identity subsystem (never inferred from a name mention). */
    confirmWearer: (args) => wearerResolver.confirm(args),
    /** Deterministic exit — e.g. a stop phrase detected before this turn reaches the model. */
    exitEngagement(reason) {
      engagement.markExited(reason);
      emit({ type: 'engagement-exit', reason });
    },
    metrics,
  };
}
