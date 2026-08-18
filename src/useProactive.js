// React glue around the Opportunity Engine. Owns the assistance preferences
// (persisted to localStorage) and the SHARED deterministic speech gate — the
// same gate instance is handed to the reactive agent runtime, so no path to
// the speech adapter exists without policy approval.
//
// Call order in App: const proactive = useProactive(...); const agent =
// useAgent({ ..., speechGate: proactive.speechGate, getPreferences:
// proactive.getPreferences }); then wire agent.setTaskState back via
// proactive.setOnTaskApproved (breaks the hook circularity).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createOpportunityEngine } from './proactive/engine.js';
import { createSpeechGate } from './proactive/speechGate.js';
import { createSuggestionStore } from './proactive/suggestionStore.js';
import { createCapabilityRegistry } from './proactive/capabilities.js';
import { loadPreferences, savePreferences, SPEECH_BUDGET } from './proactive/preferences.js';
import { createProxyProvider, createProvider } from './agent/provider.js';
import { createSpeechOutput } from './agent/speech.js';
import { agentConfig } from './agent/config.js';

const MAX_EVENTS = 60;

const emptyEvaluation = async () => ({ opportunities: [] });

export function useProactive({ sceneStore, speech } = {}) {
  const [health, setHealth] = useState(null);
  const [preferences, setPreferences] = useState(loadPreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  const [suggestions, setSuggestions] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [events, setEvents] = useState([]);
  const [lastEvaluation, setLastEvaluation] = useState(null);
  const onTaskApprovedRef = useRef(null);
  const activeProviderRef = useRef(null);

  const shared = useMemo(() => {
    const speechGate = createSpeechGate(SPEECH_BUDGET);
    const store = createSuggestionStore({ maxActive: SPEECH_BUDGET.maxActiveSuggestions });
    const capabilities = createCapabilityRegistry();
    activeProviderRef.current = createProxyProvider({ endpoint: '/api/opportunity/evaluate' });

    const engine = createOpportunityEngine({
      provider: { infer: (request) => activeProviderRef.current.infer(request) },
      preferences: () => preferencesRef.current,
      sceneStore: { getState: () => sceneStore?.current?.getState() ?? null },
      speechGate,
      // Shared voice-delivery layer drives real TTS/playback for approved
      // proactive speech (speak_now / speak_when_convenient). Falls back to the
      // stub when no delivery layer is provided.
      speech: speech ?? createSpeechOutput(),
      store,
      capabilities,
      onTaskApproved: (task) => onTaskApprovedRef.current?.(task),
    });
    return { engine, speechGate, store, capabilities };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No server key → the engine quietly evaluates nothing instead of erroring.
  useEffect(() => {
    if (health && !health?.opportunity?.available) {
      activeProviderRef.current = createProvider({ provider: 'mock', decide: emptyEvaluation });
    }
  }, [health]);

  const refresh = useCallback(() => {
    setSuggestions(shared.store.active());
    setProposals(shared.engine.proposals());
  }, [shared]);

  useEffect(() => shared.engine.subscribe((event) => {
    setEvents((existing) => [...existing, event].slice(-MAX_EVENTS));
    if (event.type === 'opportunity-detected') setLastEvaluation(event);
    refresh();
  }), [shared, refresh]);

  // Expiry countdowns + auto-sweep while suggestions are visible.
  useEffect(() => {
    if (!suggestions.length) return undefined;
    const timer = setInterval(() => {
      shared.store.sweepExpired();
      refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [suggestions.length, shared, refresh]);

  const updatePreference = useCallback((key, value) => {
    setPreferences((existing) => {
      const next = { ...existing, [key]: value };
      savePreferences(next);
      return next;
    });
  }, []);

  return {
    preferences,
    updatePreference,
    getPreferences: () => preferencesRef.current,
    setHealth, // App forwards useAgent's /api/health result (hook-order break)
    speechGate: shared.speechGate,
    suggestions,
    proposals,
    events,
    lastEvaluation,
    metrics: () => shared.engine.metrics(),
    // engine intake — wired by App
    observeTurn: (turn, meta) => shared.engine.observeTurn(turn, meta),
    noteReactiveHandled: () => shared.engine.noteMeta({ reactiveHandled: true }),
    /** Wearer assist hint from the reactive agent (src/agent/runtime.js) — evaluation context only. */
    noteAssistOpportunity: (hint) => shared.engine.noteAssistOpportunity(hint),
    observeEvent: (kind, payload) => shared.engine.observeEvent(kind, payload),
    setOnTaskApproved: (fn) => { onTaskApprovedRef.current = fn; },
    // user actions
    accept: (id) => { shared.store.accept(id); refresh(); },
    dismiss: (id) => { shared.store.dismiss(id); refresh(); },
    convertToTask: (id) => {
      const suggestion = shared.store.all().find((s) => s.id === id);
      if (!suggestion) return;
      const task = {
        active: true,
        taskId: `task_from_${id}`,
        goal: suggestion.content,
        status: 'planned',
        entities: { source: 'suggestion' },
      };
      onTaskApprovedRef.current?.(task);
      shared.store.convertToTask(id, task.taskId);
      refresh();
    },
    approveProposal: (id) => { shared.engine.approveProposal(id); refresh(); },
    rejectProposal: (id) => { shared.engine.rejectProposal(id); refresh(); },
    clearExpired: () => { shared.store.sweepExpired(); refresh(); },
  };
}
