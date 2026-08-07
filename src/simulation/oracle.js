// Deterministic test oracle for the virtual-hardware lab. Pure functions over
// bounded observability snapshots (src/simulation/index.js `snapshot()`):
// every condition is a fact about counters, event types, scene state, or
// engine signals — never a model's self-report and never scenario metadata.
// Claude designs scenarios; THIS decides pass/fail.

function countByType(events = []) {
  const counts = {};
  for (const event of events ?? []) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function agentDelta(current, baseline, type) {
  const now = countByType(current.app?.agentEvents)[type] ?? 0;
  const before = countByType(baseline.app?.agentEvents)[type] ?? 0;
  return Math.max(0, now - before);
}

function metric(snapshot, key) {
  return snapshot.app?.deliveryMetrics?.[key] ?? 0;
}

function playbackMetric(snapshot, key) {
  return snapshot.app?.deliveryMetrics?.playback?.[key] ?? 0;
}

function metricDelta(current, baseline, key) {
  return Math.max(0, metric(current, key) - metric(baseline, key));
}

function playbackDelta(current, baseline, key) {
  return Math.max(0, playbackMetric(current, key) - playbackMetric(baseline, key));
}

function segmentsGrew(current, baseline) {
  const currentSegments = current.app?.segments ?? [];
  const baselineSegments = baseline.app?.segments ?? [];
  if (currentSegments.length > baselineSegments.length) return true;
  const lastCurrent = currentSegments.at(-1);
  const lastBaseline = baselineSegments.at(-1);
  return Boolean(lastCurrent && (!lastBaseline || lastCurrent.endedAt !== lastBaseline.endedAt || lastCurrent.text !== lastBaseline.text));
}

function sceneObjects(snapshot) {
  return snapshot.app?.scene?.objects ?? [];
}

/**
 * @param {string} name       condition name (schema CONDITIONS)
 * @param {{ current: object, baseline: object, param?: string }} input
 * @returns {{ pass: boolean, detail: string }}
 */
export function evaluateCondition(name, { current, baseline, param = null }) {
  const result = (pass, detail) => ({ pass: Boolean(pass), detail });
  switch (name) {
    case 'roma.listening':
      return result(current.app?.listening === true, `listening=${current.app?.listening}`);
    case 'roma.interim_seen':
      return result((current.app?.interim ?? '').length > 0 || segmentsGrew(current, baseline), `interim="${(current.app?.interim ?? '').slice(0, 40)}"`);
    case 'roma.segment_finalized':
      return result(segmentsGrew(current, baseline), `segments=${current.app?.segments?.length ?? 0}`);
    case 'roma.turn_completed': {
      const total = agentDelta(current, baseline, 'response') + agentDelta(current, baseline, 'clarification') + agentDelta(current, baseline, 'ignored-turn') + agentDelta(current, baseline, 'error');
      return result(total > 0, `new agent outcomes=${total}`);
    }
    case 'roma.decision_respond':
      return result(agentDelta(current, baseline, 'response') > 0, 'new response event');
    case 'roma.decision_clarify':
      return result(agentDelta(current, baseline, 'clarification') > 0, 'new clarification event');
    case 'roma.decision_answered':
      // respond OR clarify — for prompts where either is a legitimate model
      // judgment (e.g. "who am I?" against an unconfirmed provisional identity).
      return result(agentDelta(current, baseline, 'response') > 0 || agentDelta(current, baseline, 'clarification') > 0, 'new response/clarification event');
    case 'roma.decision_ignore':
      return result(agentDelta(current, baseline, 'ignored-turn') > 0, 'new ignored-turn event');
    case 'roma.no_response':
      return result(agentDelta(current, baseline, 'response') === 0 && agentDelta(current, baseline, 'clarification') === 0, 'no response/clarification since baseline');
    case 'roma.speech_authorized':
      return result(metricDelta(current, baseline, 'approved') > 0, `approved +${metricDelta(current, baseline, 'approved')}`);
    case 'roma.speech_denied':
      return result(metricDelta(current, baseline, 'denied') > 0, `denied +${metricDelta(current, baseline, 'denied')}`);
    case 'roma.tts_requested':
      return result(metricDelta(current, baseline, 'ttsRequests') > 0, `ttsRequests +${metricDelta(current, baseline, 'ttsRequests')}`);
    case 'roma.playback_started':
      return result(playbackDelta(current, baseline, 'started') > 0, `playback.started +${playbackDelta(current, baseline, 'started')}`);
    case 'roma.playback_completed':
      return result(playbackDelta(current, baseline, 'completed') > 0, `playback.completed +${playbackDelta(current, baseline, 'completed')}`);
    case 'roma.playback_stopped':
      return result(playbackDelta(current, baseline, 'stopped') > 0, `playback.stopped +${playbackDelta(current, baseline, 'stopped')}`);
    case 'roma.playback_blocked':
      return result(playbackDelta(current, baseline, 'blocked') > 0, `playback.blocked +${playbackDelta(current, baseline, 'blocked')}`);
    case 'roma.echo_suppressed':
      return result(metricDelta(current, baseline, 'echoesSuppressed') > 0, `echoesSuppressed +${metricDelta(current, baseline, 'echoesSuppressed')}`);
    case 'roma.no_echo_response':
      return result(agentDelta(current, baseline, 'response') === 0 && agentDelta(current, baseline, 'clarification') === 0, 'no self-triggered response after echo');
    case 'roma.barge_in':
      return result(metricDelta(current, baseline, 'bargeIns') > 0, `bargeIns +${metricDelta(current, baseline, 'bargeIns')}`);
    case 'roma.engagement_active':
      return result(current.app?.engagement?.active === true, `engagement=${JSON.stringify(current.app?.engagement)?.slice(0, 60)}`);
    case 'roma.engagement_expired':
      return result(current.app?.engagement?.active !== true, `engagement=${JSON.stringify(current.app?.engagement)?.slice(0, 60)}`);
    case 'roma.memory_written':
      return result((current.app?.memoryCounts?.total ?? 0) > (baseline.app?.memoryCounts?.total ?? 0), `memories ${baseline.app?.memoryCounts?.total ?? 0} -> ${current.app?.memoryCounts?.total ?? 0}`);
    case 'roma.memory_recalled': {
      const responded = agentDelta(current, baseline, 'response') > 0 || agentDelta(current, baseline, 'clarification') > 0;
      return result(responded, 'agent answered (recall content checked semantically in the report)');
    }
    case 'roma.queue_acknowledged':
      return result((current.app?.memoryQueue?.open ?? 0) === 0 && (current.app?.memoryQueue?.acknowledged ?? 0) > (baseline.app?.memoryQueue?.acknowledged ?? 0), `queue=${JSON.stringify(current.app?.memoryQueue)?.slice(0, 80)}`);
    case 'roma.queue_pending':
      return result((current.app?.memoryQueue?.open ?? 0) > 0, `open=${current.app?.memoryQueue?.open}`);
    case 'roma.queue_recovered':
      return result((current.app?.memoryQueue?.open ?? 0) === 0 && (current.app?.memoryQueue?.failed ?? 0) === 0 && (current.app?.memoryQueue?.acknowledged ?? 0) > (baseline.app?.memoryQueue?.acknowledged ?? 0), `queue=${JSON.stringify(current.app?.memoryQueue)?.slice(0, 80)}`);
    case 'roma.scene_object_visible': {
      const match = sceneObjects(current).find((o) => o.visibility === 'visible' && (!param || o.label.includes(param)));
      return result(Boolean(match), match ? `visible: ${match.label} (${match.position})` : `no visible object${param ? ` matching "${param}"` : ''}`);
    }
    case 'roma.scene_object_missing': {
      const visible = sceneObjects(current).find((o) => o.visibility === 'visible' && param && o.label.includes(param));
      return result(!visible, visible ? `still visible: ${visible.label}` : `no visible "${param}"`);
    }
    case 'roma.scene_person_visible': {
      const person = sceneObjects(current).find((o) => o.visibility === 'visible' && o.label === 'person');
      return result(Boolean(person) || (current.app?.scene?.people ?? 0) > 0, person ? `person at ${person.position}` : 'no visible person');
    }
    case 'roma.scene_updated':
      return result((current.app?.scene?.revision ?? 0) > (baseline.app?.scene?.revision ?? 0), `revision ${baseline.app?.scene?.revision ?? 0} -> ${current.app?.scene?.revision ?? 0}`);
    case 'roma.detection_ran':
      return result((current.app?.scene?.revision ?? 0) > 0, `revision=${current.app?.scene?.revision ?? 0}`);
    // ── wearer-centered behavior (glasses reframe) ──────────────────────────
    // These read the addressee-decision events the runtime already emits, which
    // now carry the model's per-turn turn_analysis. `param` is a "key=value"
    // filter, e.g. "addressed_to=wearer".
    case 'roma.turn_classified': {
      const [key, value] = String(param ?? '').split('=');
      const baselineCount = (baseline.app?.addresseeDecisions ?? []).length;
      const fresh = (current.app?.addresseeDecisions ?? []).slice(baselineCount);
      const field = { addressed_to: 'addressedTo', speaker_role: 'speakerRole', wearer_expected_to_respond: 'wearerExpectedToRespond', reason_code: 'reasonCode' }[key] ?? 'addressedTo';
      const match = fresh.find((decision) => (value === undefined ? decision[field] === true : String(decision[field]) === value));
      return result(Boolean(match), match
        ? `classified ${field}=${match[field]} (reason ${match.reasonCode})`
        : `no new turn with ${key}=${value ?? 'true'}; saw ${fresh.map((d) => `${d.addressedTo}/${d.reasonCode}`).join(', ') || 'nothing'}`);
    }
    case 'roma.assist_opportunity_seen': {
      const baselineCount = (baseline.app?.addresseeDecisions ?? []).length;
      const fresh = (current.app?.addresseeDecisions ?? []).slice(baselineCount);
      const withHint = fresh.find((decision) => decision.assistOpportunity && !decision.addressedToRoma);
      return result(Boolean(withHint), withHint ? `hint: "${String(withHint.assistOpportunity).slice(0, 80)}"` : 'no assist opportunity recorded on a silent turn');
    }
    case 'roma.suggestion_spoken': {
      // A proactive (unprompted) suggestion that actually reached playback.
      const spokenDelta = metricDelta(current, baseline, 'approved');
      const started = playbackDelta(current, baseline, 'started');
      const proactive = (current.app?.voiceEvents ?? []).some((event) => event.type === 'spoken' && event.sourceType && event.sourceType !== 'direct_response');
      return result(spokenDelta > 0 && started > 0 && proactive, `approved +${spokenDelta}, playback +${started}, proactive source: ${proactive}`);
    }
    case 'roma.suggestion_visual_only':
      return result((current.app?.suggestionCount ?? 0) > (baseline.app?.suggestionCount ?? 0) && playbackDelta(current, baseline, 'started') === 0,
        `suggestions ${baseline.app?.suggestionCount ?? 0} -> ${current.app?.suggestionCount ?? 0}, no playback`);
    // ── background server-agent tasks ───────────────────────────────────────
    case 'roma.task_dispatched': {
      const tasks = current.app?.serverTasks ?? [];
      return result(tasks.length > (baseline.app?.serverTasks ?? []).length || tasks.length > 0,
        tasks.length ? `tasks: ${tasks.map((t) => `${t.taskId}:${t.status}`).join(', ')}` : 'no server task was created');
    }
    case 'roma.task_awaiting_approval': {
      const waiting = (current.app?.serverTasks ?? []).find((t) => t.status === 'awaiting_approval');
      return result(Boolean(waiting), waiting ? `awaiting approval: ${waiting.pendingRequest ?? ''}` : 'no task is awaiting approval');
    }
    case 'roma.task_completed': {
      const done = (current.app?.serverTasks ?? []).find((t) => t.status === 'completed' || t.status === 'failed');
      return result(Boolean(done), done ? `${done.taskId} -> ${done.status}` : 'no task reached a terminal state');
    }
    case 'roma.no_progress_chatter': {
      // Every spoken task update must be a milestone, approval, or outcome —
      // never a routine progress line.
      const chatter = (current.app?.taskNotifications ?? []).filter((n) => (n.kind === 'speak_now' || n.kind === 'speak_when_convenient') && n.reasonCode?.startsWith('progress_') && n.reasonCode !== 'progress_milestone');
      return result(chatter.length === 0, chatter.length ? `spoke routine progress: ${chatter.map((c) => c.reasonCode).join(', ')}` : 'no routine progress was spoken');
    }
    case 'roma.no_console_errors':
      return result((current.sim?.consoleErrorCount ?? 0) === (baseline.sim?.consoleErrorCount ?? 0), `errors ${baseline.sim?.consoleErrorCount ?? 0} -> ${current.sim?.consoleErrorCount ?? 0}: ${(current.sim?.consoleErrors ?? []).slice(-2).join(' | ')}`);
    case 'roma.error_event':
      return result(agentDelta(current, baseline, 'error') > 0, 'agent error event');
    case 'sim.audio_level_nonzero':
      return result((current.sim?.audioLevel ?? 0) > 0.0005, `level=${current.sim?.audioLevel?.toFixed(5)}`);
    case 'sim.frames_advancing':
      return result((current.sim?.frameTick ?? 0) > (baseline.sim?.frameTick ?? 0) && current.sim?.frameSignature !== baseline.sim?.frameSignature, `tick ${baseline.sim?.frameTick} -> ${current.sim?.frameTick}`);
    default:
      return result(false, `unknown condition ${name}`);
  }
}
