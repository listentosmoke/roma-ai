// Client half of the single bounded development preflight. Merges the
// server's subsystem report (GET /api/preflight — states/versions/booleans
// only, never secrets) with the checks only the browser can perform:
// microphone/camera permission state, audio readiness, active repository
// providers, and mutation-queue status. Pure data in, pure data out — the
// Server Data panel renders the result; nothing here mutates anything.
//
// States: ready | degraded | unavailable | blocked | misconfigured.
// The point is to distinguish, honestly and without crashing anything:
//   core conversation available · voice output unavailable · durable storage
//   unavailable · voice identity unavailable · camera unavailable ·
//   production authentication unavailable.

async function permissionState(name) {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
    const result = await navigator.permissions.query({ name });
    return result.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'unknown';
  }
}

function queueSection(status) {
  if (!status) return { state: 'unavailable', reason: 'queue not constructed' };
  if (status.failed > 0 || status.conflicted > 0) return { state: 'degraded', ...status };
  if (status.open > 0) return { state: 'degraded', reason: 'mutations awaiting server acknowledgement', ...status };
  return { state: 'ready', ...status };
}

export async function runPreflight({ dataClient, audioReadiness = null, repositoryProviders = {}, queueStatuses = [] } = {}) {
  const report = { generatedAt: Date.now(), sections: {} };

  let server = null;
  try {
    server = await dataClient.get('/api/preflight');
    report.sections.server = { state: 'ready' };
  } catch (error) {
    report.sections.server = { state: 'unavailable', reason: error.message };
  }
  if (server) {
    for (const key of ['node', 'database', 'auth', 'groq', 'deepgram', 'tts', 'biometricEncryption', 'voiceIdentity']) {
      if (server[key]) report.sections[key] = server[key];
    }
    report.envWarnings = server.envWarnings ?? [];
  }

  const [microphone, camera] = await Promise.all([permissionState('microphone'), permissionState('camera')]);
  report.sections.microphone = { state: microphone === 'granted' ? 'ready' : microphone === 'denied' ? 'blocked' : 'degraded', permission: microphone };
  report.sections.camera = { state: camera === 'granted' ? 'ready' : camera === 'denied' ? 'blocked' : 'degraded', permission: camera };

  if (audioReadiness) {
    report.sections.audioPlayback = {
      state: audioReadiness === 'ready' ? 'ready' : audioReadiness === 'blocked' ? 'blocked' : audioReadiness === 'error' ? 'unavailable' : 'degraded',
      readiness: audioReadiness,
    };
  }

  report.sections.repositories = {
    state: Object.values(repositoryProviders).every((mode) => mode === 'server') ? 'ready'
      : Object.values(repositoryProviders).some((mode) => mode === 'unavailable') ? 'unavailable' : 'degraded',
    ...repositoryProviders,
  };

  for (const status of queueStatuses) {
    if (status?.label) report.sections[`${status.label}Queue`] = queueSection(status);
  }

  const states = Object.values(report.sections).map((section) => section.state);
  report.overall = states.includes('unavailable') || states.includes('blocked') || states.includes('misconfigured')
    ? 'degraded'
    : states.includes('degraded') ? 'degraded' : 'ready';
  return report;
}
