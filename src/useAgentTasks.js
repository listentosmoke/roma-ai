// React glue for background server tasks.
//
// Polls the task API, runs each snapshot through the deterministic notifier
// (src/agent/taskNotifier.js), and hands anything worth saying to the SAME
// voice-delivery layer direct answers and proactive coaching use — so a task
// update passes the Speech Gate exactly like everything else Roma says. The
// server agent never reaches the speaker; Roma decides.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDataClient } from './server/dataClient.js';
import { createTaskNotifier } from './agent/taskNotifier.js';

const POLL_INTERVAL_MS = 4000;
const MAX_EVENTS = 40;

export function useAgentTasks({ speech, speechGate, getPreferences } = {}) {
  const client = useMemo(() => createDataClient(), []);
  const notifier = useMemo(() => createTaskNotifier(), []);
  const [tasks, setTasks] = useState([]);
  // Terminal tasks leave the ACTIVE list, so keep a recent list too — the UI
  // and the lab oracle both need to see that something actually finished.
  const [recentTasks, setRecentTasks] = useState([]);
  const [events, setEvents] = useState([]);
  const [worker, setWorker] = useState(null);
  const [error, setError] = useState(null);
  const tasksRef = useRef([]);
  // The project allowlist. Roma needs to know these exist, or she reasons that
  // she has no access to any codebase and declines instead of dispatching.
  const projectsRef = useRef([]);
  const [projects, setProjects] = useState([]);

  const record = useCallback((event) => {
    setEvents((existing) => [...existing, { ...event, at: Date.now() }].slice(-MAX_EVENTS));
  }, []);

  /** Deliver one notifier decision. Speech ALWAYS goes through the gate. */
  const deliver = useCallback((decision) => {
    record(decision);
    if (decision.kind === 'silent' || decision.kind === 'visual' || !decision.text) return;
    if (!speech?.authorizeAndDeliver) return;
    const preferences = getPreferences?.() ?? {};
    const gateDecision = speechGate
      ? speechGate.requestSpeech({
        prompted: false,
        preferences,
        // A task blocked on the wearer is genuinely time-critical: nothing
        // proceeds until they answer. Completion summaries are not.
        urgent: decision.kind === 'speak_now',
      })
      : { approved: false, reason: 'no speech gate configured' };
    if (!gateDecision.approved) {
      record({ ...decision, kind: 'visual', reasonCode: `${decision.reasonCode}_gate_denied`, gateReason: gateDecision.reason });
      return;
    }
    speech.authorizeAndDeliver({
      gateDecision,
      text: decision.text,
      sourceType: 'task_update',
      sourceId: decision.taskId,
      delivery: decision.kind,
      unprompted: true,
      policyReason: decision.reasonCode,
    });
  }, [getPreferences, record, speech, speechGate]);

  const refresh = useCallback(async () => {
    try {
      const response = await client.get('/api/agent-tasks?active=true');
      const active = response.tasks ?? [];
      tasksRef.current = active;
      setTasks(active);
      setError(null);
      for (const decision of notifier.evaluateAll(active)) deliver(decision);
      return active;
    } catch (caught) {
      setError(caught.message);
      return [];
    }
  }, [client, deliver, notifier]);

  // Terminal states leave the active list, so poll the recent list too and
  // let the notifier announce completions/failures exactly once.
  const refreshRecent = useCallback(async () => {
    try {
      const response = await client.get('/api/agent-tasks?limit=10');
      setRecentTasks(response.tasks ?? []);
      for (const decision of notifier.evaluateAll(response.tasks ?? [])) deliver(decision);
    } catch { /* the active poll already surfaces connectivity problems */ }
  }, [client, deliver, notifier]);

  // The poll must NOT depend on refresh/refreshRecent directly: those
  // callbacks change identity whenever the voice/speech deps do, which is
  // many times a second while the microphone is live. Depending on them tore
  // the interval down and fired an immediate poll on every re-render — a
  // request storm that tripped the server's own rate limiter and made Roma
  // tell the wearer it was "rate-limited" (diagnosed via a lab run,
  // 2026-08-03). Refs keep the latest functions with a stable effect.
  const refreshRef = useRef(refresh);
  const refreshRecentRef = useRef(refreshRecent);
  useEffect(() => { refreshRef.current = refresh; refreshRecentRef.current = refreshRecent; }, [refresh, refreshRecent]);

  useEffect(() => {
    let cancelled = false;
    client.get('/api/agent-tasks/health').then((health) => { if (!cancelled) setWorker(health.worker ?? null); }).catch(() => {});
    client.get('/api/agent-projects').then((response) => {
      if (cancelled) return;
      projectsRef.current = response.projects ?? [];
      setProjects(projectsRef.current);
    }).catch(() => {});
    const timer = setInterval(() => {
      if (cancelled) return;
      refreshRef.current?.();
      refreshRecentRef.current?.();
    }, POLL_INTERVAL_MS);
    refreshRef.current?.();
    return () => { cancelled = true; clearInterval(timer); };
  }, [client]);

  // The tool surface handed to the agent runtime (src/agent/serverTasks.js).
  const toolApi = useMemo(() => ({
    async dispatch({ goal, project, mode }) {
      try {
        const response = await client.post('/api/agent-tasks', { goal, project, mode });
        await refresh();
        return { ok: true, task: response.task };
      } catch (caught) { return { ok: false, error: caught.message }; }
    },
    async status(taskId) {
      try {
        if (taskId) {
          const response = await client.get(`/api/agent-tasks/${encodeURIComponent(taskId)}`);
          return { ok: true, tasks: [response.task] };
        }
        const response = await client.get('/api/agent-tasks?limit=10');
        return { ok: true, tasks: response.tasks ?? [] };
      } catch (caught) { return { ok: false, error: caught.message }; }
    },
    async respond({ taskId, response, approved }) {
      try {
        const result = await client.post(`/api/agent-tasks/${encodeURIComponent(taskId)}/respond`, { response, approved });
        await refresh();
        return result;
      } catch (caught) { return { ok: false, error: caught.message }; }
    },
    async cancel(taskId) {
      try {
        const result = await client.del(`/api/agent-tasks/${encodeURIComponent(taskId)}`);
        await refresh();
        return result;
      } catch (caught) { return { ok: false, error: caught.message }; }
    },
  }), [client, refresh]);

  return {
    tasks,
    recentTasks,
    events,
    worker,
    projects,
    error,
    toolApi,
    /** Bounded read-only context: what the background agent may be pointed at. */
    registeredProjects: () => projectsRef.current,
    /** Bounded read-only context for the agent prompt (tasks blocked on the wearer). */
    pendingTasks: () => tasksRef.current.filter((task) => task.status === 'awaiting_approval' || task.status === 'awaiting_input'),
    refresh,
  };
}
