import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const DEFAULT_SAMPLE_LIMITS = Object.freeze({
  sampleRate: 16000,
  channels: 1,
  bytesPerSample: 2,
  minDurationMs: 2500,
  maxDurationMs: 12000,
  maxBytes: 16000 * 2 * 12,
  operationTtlMs: 60000,
  maxConcurrent: 4,
});

function safeTokenEqual(actual, expected) {
  try {
    const a = Buffer.from(actual ?? '', 'base64url');
    const b = Buffer.from(expected ?? '', 'base64url');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function analyzePcm16(pcm, limits) {
  const sampleCount = Math.floor(pcm.length / 2);
  const durationMs = Math.round((sampleCount / limits.sampleRate) * 1000);
  if (!sampleCount) return { durationMs: 0, usableSpeechMs: 0, quality: 0, silenceRatio: 1, clippingRatio: 0, rms: 0 };

  const frameSamples = Math.max(1, Math.round(limits.sampleRate * 0.02));
  const frameRms = [];
  let squareSum = 0;
  let clipped = 0;
  for (let start = 0; start < sampleCount; start += frameSamples) {
    let frameSquare = 0;
    const end = Math.min(sampleCount, start + frameSamples);
    for (let i = start; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768;
      squareSum += value * value;
      frameSquare += value * value;
      if (Math.abs(value) >= 0.985) clipped += 1;
    }
    frameRms.push(Math.sqrt(frameSquare / Math.max(1, end - start)));
  }

  const rms = Math.sqrt(squareSum / sampleCount);
  const sorted = [...frameRms].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  // Cap the adaptive threshold: a continuous voiced passage has no quiet
  // 20th-percentile frame, so treating that percentile as pure noise would
  // otherwise classify perfectly usable steady speech as silence.
  const speechThreshold = Math.max(0.012, Math.min(0.05, noiseFloor * 2.5));
  const speechFrames = frameRms.filter((value) => value >= speechThreshold).length;
  const silenceRatio = 1 - speechFrames / Math.max(1, frameRms.length);
  const usableSpeechMs = Math.round(speechFrames * 20);
  const clippingRatio = clipped / sampleCount;

  const levelScore = Math.min(1, Math.max(0, (rms - 0.012) / 0.09));
  const speechScore = Math.min(1, usableSpeechMs / Math.max(1, limits.minDurationMs));
  const silencePenalty = Math.max(0, (silenceRatio - 0.55) / 0.45);
  const clippingPenalty = Math.min(1, clippingRatio / 0.02);
  const quality = Math.max(0, Math.min(1, 0.45 * levelScore + 0.55 * speechScore - 0.35 * silencePenalty - 0.5 * clippingPenalty));
  return { durationMs, usableSpeechMs, quality, silenceRatio, clippingRatio, rms, noiseFloor, speechThreshold };
}

function rejectionFor(operation, analysis, limits) {
  if (operation.romaSpeaking || operation.playbackActive) return 'roma_playback_excluded';
  if (operation.overlapDetected) return 'overlapping_speech_detected';
  if (analysis.durationMs < limits.minDurationMs) return 'sample_too_short';
  if (analysis.durationMs > limits.maxDurationMs) return 'sample_too_long';
  if (analysis.usableSpeechMs < limits.minDurationMs) return 'insufficient_usable_speech';
  if (analysis.silenceRatio > 0.65) return 'silence_dominated';
  if (analysis.clippingRatio > 0.02) return 'clipped_audio';
  if (analysis.quality < 0.55) return 'low_quality_sample';
  return null;
}

export function createBoundedAudioSampleManager({ now = Date.now, limits: overrides = {} } = {}) {
  const limits = Object.freeze({ ...DEFAULT_SAMPLE_LIMITS, ...overrides });
  const operations = new Map();
  const recentFingerprints = new Map();

  function expire() {
    const at = now();
    for (const [id, operation] of operations) {
      if (operation.expiresAt <= at) operations.delete(id);
    }
    for (const [fingerprint, expiresAt] of recentFingerprints) {
      if (expiresAt <= at) recentFingerprints.delete(fingerprint);
    }
  }

  function publicStatus(operation) {
    if (!operation) return null;
    return {
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      interactionId: operation.interactionId,
      speakerLabel: operation.speakerLabel,
      personId: operation.personId,
      purpose: operation.purpose,
      state: operation.state,
      bytesCaptured: operation.bytesCaptured,
      durationMs: Math.round((operation.bytesCaptured / (limits.sampleRate * limits.bytesPerSample)) * 1000),
      expiresAt: operation.expiresAt,
      reasonCode: operation.reasonCode ?? null,
    };
  }

  function begin({ workspaceId, userId, sessionId, interactionId = null, speakerLabel = null, personId = null, purpose, consentId = null, romaSpeaking = false, playbackActive = false, overlapDetected = false, operationId = randomUUID() } = {}) {
    expire();
    if (!workspaceId || !userId || !sessionId || !purpose) return { ok: false, reasonCode: 'invalid_operation' };
    if (!['enrollment', 'verification', 'identification', 'profile_update', 'quality_check'].includes(purpose)) return { ok: false, reasonCode: 'invalid_purpose' };
    if (operations.has(operationId)) return { ok: false, reasonCode: 'duplicate_operation_id' };
    const active = [...operations.values()].filter((operation) => operation.workspaceId === workspaceId && operation.state === 'capturing');
    if (active.length >= limits.maxConcurrent) return { ok: false, reasonCode: 'capture_capacity_reached' };

    const operation = {
      operationId,
      captureToken: randomBytes(32).toString('base64url'),
      workspaceId,
      userId,
      sessionId,
      interactionId,
      speakerLabel,
      personId,
      purpose,
      consentId,
      romaSpeaking: Boolean(romaSpeaking),
      playbackActive: Boolean(playbackActive),
      overlapDetected: Boolean(overlapDetected),
      chunks: [],
      bytesCaptured: 0,
      state: 'capturing',
      createdAt: now(),
      expiresAt: now() + limits.operationTtlMs,
      reasonCode: null,
    };
    operations.set(operationId, operation);
    return { ok: true, operationId, captureToken: operation.captureToken, limits, status: publicStatus(operation) };
  }

  function findByToken(operationId, captureToken) {
    expire();
    const operation = operations.get(operationId);
    return operation && safeTokenEqual(captureToken, operation.captureToken) ? operation : null;
  }

  function append({ operationId, captureToken, chunk }) {
    const operation = findByToken(operationId, captureToken);
    if (!operation) return { ok: false, reasonCode: 'capture_not_found' };
    if (operation.state !== 'capturing') return { ok: false, reasonCode: 'capture_not_active' };
    const bytes = Buffer.from(chunk ?? []);
    if (!bytes.length || bytes.length % limits.bytesPerSample !== 0) return { ok: false, reasonCode: 'invalid_pcm_frame' };
    if (operation.bytesCaptured + bytes.length > limits.maxBytes) {
      operation.state = 'rejected';
      operation.reasonCode = 'sample_byte_limit_exceeded';
      operation.chunks.length = 0;
      return { ok: false, reasonCode: operation.reasonCode };
    }
    operation.chunks.push(Buffer.from(bytes));
    operation.bytesCaptured += bytes.length;
    return { ok: true, bytesCaptured: operation.bytesCaptured };
  }

  function setFlags(operationId, workspaceId, flags = {}) {
    const operation = operations.get(operationId);
    if (!operation || operation.workspaceId !== workspaceId) return { ok: false, reasonCode: 'capture_not_found' };
    for (const key of ['romaSpeaking', 'playbackActive', 'overlapDetected']) {
      if (key in flags) operation[key] = Boolean(flags[key]);
    }
    return { ok: true, status: publicStatus(operation) };
  }

  function finalize(operationId, workspaceId) {
    expire();
    const operation = operations.get(operationId);
    if (!operation || operation.workspaceId !== workspaceId) return { ok: false, reasonCode: 'capture_not_found' };
    if (operation.state !== 'capturing') return { ok: false, reasonCode: operation.reasonCode ?? 'capture_not_active' };
    const pcm = Buffer.concat(operation.chunks, operation.bytesCaptured);
    operation.chunks.length = 0;
    const analysis = analyzePcm16(pcm, limits);
    const reasonCode = rejectionFor(operation, analysis, limits);
    const fingerprint = createHash('sha256').update(pcm).digest('base64url');
    const possibleReplay = recentFingerprints.has(fingerprint);
    operation.analysis = { ...analysis, possibleReplay, overlapDetected: operation.overlapDetected, playbackExcluded: operation.romaSpeaking || operation.playbackActive };
    operation.fingerprint = fingerprint;
    operation.pcm = reasonCode ? null : pcm;
    operation.state = reasonCode ? 'rejected' : 'ready';
    operation.reasonCode = reasonCode;
    if (!reasonCode) recentFingerprints.set(fingerprint, now() + 10 * 60 * 1000);
    return { ok: !reasonCode, reasonCode, operationId, quality: operation.analysis, status: publicStatus(operation) };
  }

  function consume(operationId, workspaceId) {
    expire();
    const operation = operations.get(operationId);
    if (!operation || operation.workspaceId !== workspaceId || operation.state !== 'ready' || !operation.pcm) return null;
    operations.delete(operationId);
    return {
      operationId,
      workspaceId: operation.workspaceId,
      userId: operation.userId,
      sessionId: operation.sessionId,
      interactionId: operation.interactionId,
      speakerLabel: operation.speakerLabel,
      personId: operation.personId,
      purpose: operation.purpose,
      consentId: operation.consentId,
      pcm: operation.pcm,
      quality: operation.analysis,
      fingerprint: operation.fingerprint,
      sampleRate: limits.sampleRate,
      channels: limits.channels,
      encoding: 'linear16',
    };
  }

  function cancel(operationId, workspaceId, reasonCode = 'cancelled') {
    const operation = operations.get(operationId);
    if (!operation || operation.workspaceId !== workspaceId) return { ok: false, reasonCode: 'capture_not_found' };
    operations.delete(operationId);
    operation.chunks.length = 0;
    operation.pcm = null;
    return { ok: true, operationId, reasonCode };
  }

  return {
    begin,
    append,
    setFlags,
    finalize,
    consume,
    cancel,
    expire,
    get(operationId, workspaceId) {
      expire();
      const operation = operations.get(operationId);
      return operation?.workspaceId === workspaceId ? publicStatus(operation) : null;
    },
    limits: () => limits,
    activeCount: () => { expire(); return operations.size; },
  };
}

export { analyzePcm16 };
