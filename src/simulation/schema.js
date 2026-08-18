// Declarative scenario schema + validation for the virtual-hardware lab.
// Pure module (no browser/Node globals) shared by the in-page director
// runtime, the Node controller, and the test suite.
//
// SAFETY: a scenario file is DATA. Every action is a whitelisted verb with
// bounded, type-checked arguments — there is no expression language, no
// code field, no eval of any kind. Unknown verbs, unknown condition names,
// unbounded timeouts, and oversized payloads all fail validation.

export const VISUAL_TIERS = ['deterministic_geometric', 'recognition_compatible', 'recorded_photorealistic'];

export const VERIFICATION_LEVELS = [
  'unit_verified',
  'deterministic_provider_verified',
  'transcript_harness_verified',
  'virtual_microphone_verified',
  'virtual_camera_verified',
  'rendered_environment_verified',
  'closed_loop_simulation_verified',
  'real_cloud_provider_verified',
  'physical_device_verified',
  'unverified',
];

import { ENVIRONMENTS } from './environments.js';

export const ROOM_PROFILES = Object.keys(ENVIRONMENTS);

export const OBJECT_KINDS = ['stop sign', 'clock', 'sports ball', 'cup', 'chair', 'book', 'laptop', 'bottle', 'tv', 'person_figure', 'photo_asset'];

export const VOICE_SOURCES = /^(aura:[a-z0-9-]+|fixture:[a-z0-9-]+|synth:[a-z0-9_]+)$/;

/** Wait/assert conditions the oracle + director understand. Each maps to an observable fact — never to a model's self-report. */
export const CONDITIONS = [
  'roma.listening',
  'roma.interim_seen',
  'roma.segment_finalized',
  'roma.turn_completed',
  'roma.decision_ignore',
  'roma.decision_respond',
  'roma.decision_clarify',
  'roma.decision_answered',
  // ── wearer-centered behavior (glasses reframe) ────────────────────────────
  'roma.turn_classified', // param: "addressed_to=wearer" | "speaker_role=other_person" | "wearer_expected_to_respond"
  'roma.assist_opportunity_seen', // Roma stayed silent but noticed it could help the wearer
  'roma.suggestion_spoken', // a proactive suggestion actually reached the speaker
  'roma.suggestion_visual_only', // ...or was deliberately kept private
  // ── background server-agent tasks ─────────────────────────────────────────
  'roma.task_dispatched', // work was handed to the server agent, not attempted inline
  'roma.task_completed', // a dispatched task reached a terminal state
  'roma.task_awaiting_approval', // the worker is blocked on the wearer
  'roma.no_progress_chatter', // progress updates did not become spoken noise
  'roma.no_response',
  'roma.speech_authorized',
  'roma.speech_denied',
  'roma.tts_requested',
  'roma.playback_started',
  'roma.playback_completed',
  'roma.playback_stopped',
  'roma.playback_blocked',
  'roma.echo_suppressed',
  'roma.no_echo_response',
  'roma.barge_in',
  'roma.engagement_active',
  'roma.engagement_expired',
  'roma.memory_written',
  'roma.memory_recalled',
  'roma.queue_acknowledged',
  'roma.queue_pending',
  'roma.queue_recovered',
  'roma.scene_object_visible',
  'roma.scene_object_missing',
  'roma.scene_person_visible',
  'roma.scene_updated',
  'roma.detection_ran',
  'roma.no_console_errors',
  'roma.error_event',
  'sim.audio_level_nonzero',
  'sim.frames_advancing',
];

const ACTION_SPECS = {
  'environment.load': { profile: 'string?', lighting: 'number?', visualTier: 'string?' },
  'room.setProfile': { profile: 'string' },
  'lighting.set': { level: 'number' },
  'camera.move': { panX: 'number?', panY: 'number?', zoom: 'number?' },
  'person.add': { person: 'string', voice: 'string?', name: 'string?', x: 'number?', y: 'number?', distance: 'number?', visible: 'boolean?' },
  'person.remove': { person: 'string' },
  'person.move': { person: 'string', x: 'number?', y: 'number?', distance: 'number?', visible: 'boolean?' },
  'person.speak': { person: 'string', text: 'string', gainDb: 'number?', rate: 'number?', overlapsWith: 'string?' },
  'person.interrupt': { person: 'string', text: 'string', afterPlaybackMs: 'number?' },
  'person.stop': { person: 'string' },
  'object.add': { object: 'string', kind: 'string', x: 'number?', y: 'number?', width: 'number?', occludes: 'string?' },
  'object.move': { object: 'string', x: 'number?', y: 'number?' },
  'object.remove': { object: 'string' },
  'noise.set': { kind: 'string?', gain: 'number' },
  'echo.configure': { enabled: 'boolean?', gain: 'number?', delayMs: 'number?', lowpassHz: 'number?' },
  'microphone.setGain': { gain: 'number' },
  'fault.trigger': { fault: 'string', durationMs: 'number?' },
  'fault.clear': { fault: 'string' },
  // Register a project the background server agent may work in. Projects are
  // an explicit allowlist, so a dispatch scenario must set one up first —
  // exactly as a real wearer would have done once.
  'project.register': { name: 'string', rootPath: 'string?', testCmd: 'string?' },
  'wait': { ms: 'number' },
  'wait_for': { condition: 'string', timeoutMs: 'number', param: 'string?' },
  'assert': { condition: 'string', timeoutMs: 'number?', message: 'string?', negate: 'boolean?', param: 'string?', required: 'boolean?', scope: 'string?' },
  'ui.click': { control: 'string' },
  'branch': { condition: 'string', timeoutMs: 'number?', param: 'string?', then: 'array?', else: 'array?' },
};

export const FAULT_KINDS = [
  'deepgram_block', 'agent_block', 'tts_block', 'data_api_block', 'network_offline',
  'audio_dropout', 'camera_freeze', 'audio_track_end', 'video_track_end',
];

const MAX_EVENTS = 200;
const MAX_TEXT = 500;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BRANCH_DEPTH = 3;

function typeOk(value, spec) {
  const optional = spec.endsWith('?');
  const base = optional ? spec.slice(0, -1) : spec;
  if (value === undefined || value === null) return optional;
  if (base === 'array') return Array.isArray(value);
  return typeof value === base;
}

function validateEvent(event, index, errors, depth = 0) {
  if (!event || typeof event !== 'object') { errors.push(`events[${index}]: not an object`); return; }
  const spec = ACTION_SPECS[event.action];
  if (!spec) { errors.push(`events[${index}]: unknown action "${event.action}"`); return; }
  for (const [key, value] of Object.entries(event)) {
    if (key === 'action' || key === 'note' || key === 'addressedToRoma' || key === 'groundTruth') continue; // oracle-only metadata, never sent to Roma
    if (!(key in spec)) { errors.push(`events[${index}] (${event.action}): unknown field "${key}"`); continue; }
    if (!typeOk(value, spec[key])) errors.push(`events[${index}] (${event.action}): field "${key}" must be ${spec[key]}`);
  }
  for (const [key, fieldSpec] of Object.entries(spec)) {
    if (!fieldSpec.endsWith('?') && (event[key] === undefined || event[key] === null)) {
      errors.push(`events[${index}] (${event.action}): missing required field "${key}"`);
    }
  }
  if (typeof event.text === 'string' && event.text.length > MAX_TEXT) errors.push(`events[${index}]: text exceeds ${MAX_TEXT} chars`);
  if (typeof event.timeoutMs === 'number' && (event.timeoutMs <= 0 || event.timeoutMs > MAX_TIMEOUT_MS)) errors.push(`events[${index}]: timeoutMs must be 1..${MAX_TIMEOUT_MS}`);
  if (event.action === 'wait' && (event.ms <= 0 || event.ms > MAX_TIMEOUT_MS)) errors.push(`events[${index}]: wait ms must be 1..${MAX_TIMEOUT_MS}`);
  if (event.action === 'wait_for' && !CONDITIONS.includes(event.condition)) errors.push(`events[${index}]: unknown condition "${event.condition}"`);
  if (event.action === 'assert' && !CONDITIONS.includes(event.condition)) errors.push(`events[${index}]: unknown condition "${event.condition}"`);
  if (event.action === 'fault.trigger' && !FAULT_KINDS.includes(event.fault)) errors.push(`events[${index}]: unknown fault "${event.fault}"`);
  if (event.action === 'fault.clear' && !FAULT_KINDS.includes(event.fault)) errors.push(`events[${index}]: unknown fault "${event.fault}"`);
  if (event.action === 'branch') {
    if (!CONDITIONS.includes(event.condition)) errors.push(`events[${index}]: unknown condition "${event.condition}"`);
    if (depth >= MAX_BRANCH_DEPTH) errors.push(`events[${index}]: branch nesting exceeds ${MAX_BRANCH_DEPTH}`);
    else {
      for (const [branchIndex, sub] of (event.then ?? []).entries()) validateEvent(sub, `${index}.then.${branchIndex}`, errors, depth + 1);
      for (const [branchIndex, sub] of (event.else ?? []).entries()) validateEvent(sub, `${index}.else.${branchIndex}`, errors, depth + 1);
    }
  }
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function validateScenario(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['scenario is not an object'] };
  if (typeof raw.scenarioId !== 'string' || !/^[a-z0-9_]{3,64}$/.test(raw.scenarioId)) errors.push('scenarioId must be 3-64 chars of [a-z0-9_]');
  if (raw.version !== undefined && typeof raw.version !== 'number') errors.push('version must be a number');
  // Which background worker engine the run needs. `mock` is the default and
  // the only value that costs nothing; `qwen` marks a scenario as opt-in
  // because it spawns a real coding agent and spends real tokens.
  if (raw.worker !== undefined && !['mock', 'qwen'].includes(raw.worker)) errors.push('worker must be "mock" or "qwen"');
  const env = raw.environment ?? {};
  if (env.roomProfile && !ROOM_PROFILES.includes(env.roomProfile)) errors.push(`unknown roomProfile "${env.roomProfile}"`);
  if (env.visualTier && !VISUAL_TIERS.includes(env.visualTier)) errors.push(`unknown visualTier "${env.visualTier}"`);
  if (env.lighting !== undefined && (typeof env.lighting !== 'number' || env.lighting < 0 || env.lighting > 1)) errors.push('lighting must be 0..1');
  for (const [index, person] of (raw.people ?? []).entries()) {
    if (typeof person.simulationId !== 'string' || !/^sim_[a-z0-9_]{1,32}$/.test(person.simulationId)) errors.push(`people[${index}]: simulationId must match sim_[a-z0-9_]+`);
    if (person.voice && !VOICE_SOURCES.test(person.voice)) errors.push(`people[${index}]: voice must be aura:<voice>|fixture:<name>|synth:<profile>`);
    if (person.romaPersonId !== undefined && person.romaPersonId !== null && typeof person.romaPersonId !== 'string') errors.push(`people[${index}]: romaPersonId must be a string when present`);
  }
  const events = raw.events ?? [];
  if (!Array.isArray(events)) errors.push('events must be an array');
  else if (events.length > MAX_EVENTS) errors.push(`events exceed ${MAX_EVENTS}`);
  else for (const [index, event] of events.entries()) validateEvent(event, index, errors);
  // Explicitly forbid anything code-shaped anywhere in the document.
  const serialized = JSON.stringify(raw);
  for (const marker of ['"__proto__"', '"constructor"', 'javascript:', '<script']) {
    if (serialized.toLowerCase().includes(marker)) errors.push(`forbidden content: ${marker}`);
  }
  return { ok: errors.length === 0, errors };
}
