// React glue around the main-agent runtime. Builds the runtime once (provider +
// tools wired to the Inspector's pieces via live-reading proxies, since the
// camera — and therefore the frame buffer/deep analyzer/scene store — may start
// AFTER this hook mounts), subscribes to output events, and exposes a single
// handleSegment(segment) call for the audio side to feed finalized turns into.
//
// The model provider is the server proxy (/api/agent/infer): the GROQ key
// lives only in the dev-server process. A startup /api/health check decides
// whether the proxy is usable; if not, the runtime falls back to a mock
// provider and the status says so.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createAgentRuntime } from './agent/runtime.js';
import { createProvider } from './agent/provider.js';
import { createDefaultTools } from './agent/tools.js';
import { registerMemoryTools } from './memory/tools.js';
import { registerIdentityTools } from './identity/tools.js';
import { registerServerTaskTools } from './agent/serverTasks.js';
import { agentConfig } from './agent/config.js';

const MAX_EVENTS = 100; // each turn now also emits an addressee-decision event
const MAX_ERRORS = 10;

export function useAgent({ sceneStore, frameBuffer, deepAnalyzer, speechGate, getPreferences, speech, memory, identity, principal, onAssistOpportunity, serverTasks, pendingTasks } = {}) {
  const [thinking, setThinking] = useState(false);
  const [events, setEvents] = useState([]);
  const [lastTurn, setLastTurn] = useState(null);
  const [taskState, setTaskState] = useState(null);
  const [errors, setErrors] = useState([]);
  const [health, setHealth] = useState(null); // /api/health payload, or {ok:false}
  const activeProviderRef = useRef(createProvider(agentConfig)); // optimistic: proxy
  // `principal` (workspaceId/userId — from useMemory's data-API health check)
  // arrives asynchronously, after the runtime below is already built. A ref +
  // getter object lets src/policy/sensitivity.js's context-filter pass
  // (src/agent/runtime.js's applyContextPolicy) always read the CURRENT
  // principal without rebuilding the runtime — same live-reference pattern
  // already used for sceneStore/frameBuffer/deepAnalyzer above.
  const principalRef = useRef(principal ?? null);
  useEffect(() => { principalRef.current = principal ?? null; }, [principal]);
  const assistListenerRef = useRef(onAssistOpportunity ?? null);
  useEffect(() => { assistListenerRef.current = onAssistOpportunity ?? null; }, [onAssistOpportunity]);
  // Same live-ref pattern: the task hook's API and pending list arrive with
  // the first render but the runtime is built once.
  const serverTasksRef = useRef(serverTasks ?? null);
  useEffect(() => { serverTasksRef.current = serverTasks ?? null; }, [serverTasks]);
  const pendingTasksRef = useRef(pendingTasks ?? null);
  useEffect(() => { pendingTasksRef.current = pendingTasks ?? null; }, [pendingTasks]);

  const runtime = useMemo(() => {
    // Proxies dereference the ref's CURRENT value on every call, so tools keep
    // working after the camera (and the pieces it builds) starts later.
    const sceneStoreProxy = { getState: () => sceneStore?.current?.getState() ?? null };
    const frameBufferProxy = {
      latest: () => frameBuffer?.current?.latest(),
      frameAt: (at) => frameBuffer?.current?.frameAt(at),
      saveKeyframe: (at, reason) => frameBuffer?.current?.saveKeyframe(at, reason),
    };
    const deepAnalyzerProxy = { analyzeFrame: (...args) => deepAnalyzer?.current?.analyzeFrame(...args) };

    const tools = createDefaultTools({ frameBuffer: frameBufferProxy, deepAnalyzer: deepAnalyzerProxy, sceneStore: sceneStoreProxy });
    // Memory tools (remember_this/recall_memories/forget_memory/correct_memory/
    // explain_memory) register into the SAME registry the vision tools use —
    // no change to the agent decision schema was needed (src/memory/tools.js).
    if (memory) registerMemoryTools(tools, { memory });
    // Identity tools (identify_current_speaker/name_current_speaker/confirm_
    // person_match/... — src/identity/tools.js) register into the SAME
    // registry, same reasoning as memory tools above.
    if (identity) registerIdentityTools(tools, { identity });
    // Background server-agent tools (dispatch/status/answer/cancel) — same
    // registry again. Roma dispatches engineering work rather than attempting
    // it inline; the worker never reaches speech (src/agent/serverTasks.js).
    if (serverTasksRef.current) registerServerTaskTools(tools, { tasks: {
      dispatch: (args) => serverTasksRef.current?.dispatch(args),
      status: (id) => serverTasksRef.current?.status(id),
      respond: (args) => serverTasksRef.current?.respond(args),
      cancel: (id) => serverTasksRef.current?.cancel(id),
    } });
    // Delegating provider so the health check can swap proxy → mock without
    // rebuilding the runtime.
    const provider = { infer: (request) => activeProviderRef.current.infer(request) };

    return createAgentRuntime({
      sceneStore: sceneStoreProxy,
      provider,
      tools,
      maxToolRounds: agentConfig.maxToolRounds,
      transcriptWindowSize: agentConfig.transcriptWindowSize,
      transcriptWindowMs: agentConfig.transcriptWindowMs,
      // Shared deterministic speech gate (from useProactive) — direct answers
      // and proactive suggestions pass the same policy before any speech.
      speechGate,
      preferences: getPreferences,
      // Shared voice-delivery layer (from useVoiceDelivery): a gate-approved
      // direct answer mints an authorization and drives TTS + playback here.
      speech,
      // Memory coordinator (from useMemory): retrieval feeds the Context
      // Compiler only; writes fire after a completed respond/clarify turn.
      // It can never reach TTS directly (src/memory/coordinator.js).
      memory,
      // Identity coordinator (from usePeople): speaker resolution feeds the
      // Context Compiler only — it can never reach TTS directly either
      // (src/identity/coordinator.js).
      identity,
      // Sensitivity-policy principal (src/policy/sensitivity.js) — a live
      // getter, not a snapshot, so it reflects the health-check result even
      // though it resolves after this runtime is constructed.
      policy: { get principal() { return principalRef.current; } },
      // Wearer-centered assist hints (glasses reframe): when Roma stays out of
      // a conversation but sees a genuine chance to help the person wearing
      // the glasses, the hint goes to the proactive pipeline as CONTEXT. Same
      // live-ref pattern as `principal` — the listener is supplied by App and
      // may change without rebuilding the runtime. It never speaks: the
      // Intervention Policy and Speech Gate still decide everything.
      onAssistOpportunity: (hint) => assistListenerRef.current?.(hint),
      pendingTasks: () => pendingTasksRef.current?.() ?? [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Startup health check: does the server have a key for agent + vision?
  useEffect(() => {
    let cancelled = false;
    fetch(agentConfig.healthEndpoint)
      .then((response) => response.json())
      .then((body) => {
        if (cancelled) return;
        setHealth(body);
        if (!body?.agent?.available) activeProviderRef.current = createProvider({ provider: 'mock' });
      })
      .catch(() => {
        if (cancelled) return;
        setHealth({ ok: false });
        activeProviderRef.current = createProvider({ provider: 'mock' });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => runtime.subscribeOutput((event) => {
    setEvents((existing) => [...existing, event].slice(-MAX_EVENTS));
    if (event.type === 'response' || event.type === 'clarification' || event.type === 'ignored-turn') setLastTurn(event);
    if (event.type === 'task-updated') setTaskState(event.taskState);
    if (event.type === 'error') setErrors((existing) => [...existing, event].slice(-MAX_ERRORS));
  }), [runtime]);

  async function handleSegment(segment) {
    setThinking(true);
    try {
      await runtime.handleTurn(segment);
    } finally {
      setThinking(false);
    }
  }

  const providerLabel = health == null
    ? 'Checking server…'
    : health?.agent?.available
      ? `Groq · ${health.agent.model}`
      : 'Mock provider (server has no GROQ_API_KEY)';

  return {
    status: thinking ? 'Thinking…' : `Ready · ${providerLabel}`,
    health,
    events,
    lastTurn,
    taskState,
    errors,
    beginSession: (at) => runtime.beginSession(at),
    handleSegment,
    setTaskState: (update) => runtime.setTaskState(update),
    metrics: () => runtime.metrics(),
    lastAssembledInput: () => runtime.lastAssembledInput(),
    /** Deterministic engagement window (src/agent/engagement.js) — for diagnostics/UI. */
    engagementState: () => runtime.engagementState(),
    /** Who Roma believes is wearing the glasses (src/agent/wearer.js) — diagnostics/UI. */
    wearerState: () => runtime.wearerState(),
    /** Explicit wearer confirmation (identity-driven; never inferred from a name mention). */
    confirmWearer: (args) => runtime.confirmWearer(args),
    /** Deterministic exit — call before forwarding a detected stop phrase to the agent. */
    exitEngagement: (reason) => runtime.exitEngagement(reason),
  };
}
