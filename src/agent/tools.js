// Modular tool registry. A tool is { name, description, inputSchema, execute }.
// The registry validates arguments against a small JSON-Schema-like inputSchema
// (required keys + primitive types) before ever calling execute, so a malformed
// tool_call from the model fails safely instead of running with bad args.
//
// createDefaultTools wires the two vision-escalation tools to the EXISTING frame
// buffer + deep-analysis interface built for the Inspector (src/inspector/), plus
// one deterministic no-credentials tool that proves tool execution + a bounded
// follow-up inference work end to end.

import { now } from '../clock.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === 'null') return value === null;
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'number') return typeof value === 'number';
    if (t === 'string') return typeof value === 'string';
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'object') return isPlainObject(value);
    return true;
  });
}

function validateArgs(inputSchema, args) {
  const value = isPlainObject(args) ? { ...args } : {};
  const errors = [];
  const properties = inputSchema?.properties ?? {};
  const required = inputSchema?.required ?? [];

  for (const key of required) {
    if (value[key] === undefined || value[key] === null) errors.push(`missing required argument "${key}"`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (value[key] === undefined || !spec?.type) continue;
    if (!matchesType(value[key], spec.type)) errors.push(`argument "${key}" must be of type ${spec.type}`);
  }
  return { ok: errors.length === 0, value, errors };
}

export function createToolRegistry() {
  const tools = new Map();

  return {
    register(tool) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('Tool must have a string name.');
      if (typeof tool.execute !== 'function') throw new Error(`Tool "${tool.name}" must have an execute function.`);
      tools.set(tool.name, { inputSchema: {}, description: '', ...tool });
    },

    has: (name) => tools.has(name),

    /** Descriptions handed to the model + used to build provider-facing tool listings. */
    descriptions() {
      return [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },

    /** Validate args and run a registered tool. Never throws — failures come back as { ok:false }. */
    async execute(name, args, context) {
      const startedAt = now();
      const tool = tools.get(name);
      if (!tool) return { ok: false, name, error: `Unknown tool: "${name}"`, tookMs: now() - startedAt };

      const validation = validateArgs(tool.inputSchema, args);
      if (!validation.ok) {
        return { ok: false, name, error: `Invalid arguments for "${name}": ${validation.errors.join('; ')}`, tookMs: now() - startedAt };
      }

      try {
        const result = await tool.execute(validation.value, context);
        return { ok: true, name, result, tookMs: now() - startedAt };
      } catch (error) {
        return { ok: false, name, error: error?.message ?? String(error), tookMs: now() - startedAt };
      }
    },
  };
}

const DEFAULT_MAX_FRAME_AGE_MS = 30000;
const DEFAULT_MAX_FRESH_AGE_MS = 10000;

// Normalize a deep-analysis outcome into the shape both vision tools return:
// human-readable `analysis` plus the full structured result and its metrics.
function normalizeAnalysis(outcome, entry) {
  return {
    frameAt: entry.at,
    frameAgeMs: now() - entry.at,
    analysis: outcome.description ?? outcome.result?.answer ?? null,
    result: outcome.result ?? null,
    model: outcome.model ?? null,
    prepared: outcome.prepared ?? null,
    prepMs: outcome.prepMs ?? null,
    providerMs: outcome.providerMs ?? null,
    cacheHit: outcome.cacheHit ?? false,
  };
}

/**
 * @param {{ frameBuffer: object, deepAnalyzer: { analyzeFrame: Function }, sceneStore: object,
 *           maxFrameAgeMs?: number, maxFreshAgeMs?: number }} deps
 */
export function createDefaultTools({
  frameBuffer,
  deepAnalyzer,
  sceneStore,
  maxFrameAgeMs = DEFAULT_MAX_FRAME_AGE_MS,
  maxFreshAgeMs = DEFAULT_MAX_FRESH_AGE_MS,
} = {}) {
  const registry = createToolRegistry();

  registry.register({
    name: 'inspect_current_view',
    description: 'Request detailed analysis of the most recent camera frame — use when the fast visual detector\'s label is too generic or uncertain to answer confidently (e.g. identifying a specialized tool, reading text, telling apart similar objects). Pass allow_stale: true to accept an older frame.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' }, allow_stale: { type: 'boolean' } },
      required: ['question'],
    },
    async execute({ question, allow_stale: allowStale }) {
      if (!frameBuffer || !deepAnalyzer) return { ok: false, note: 'Vision escalation is not wired up.' };
      const entry = frameBuffer.latest();
      if (!entry) return { ok: false, note: 'No camera frame is available yet.' };
      const age = now() - entry.at;
      if (age > maxFreshAgeMs && !allowStale) {
        return { ok: false, note: `The latest frame is ${Math.round(age / 1000)}s old — the camera may be stopped. Pass allow_stale: true to analyze it anyway.` };
      }
      const outcome = await deepAnalyzer.analyzeFrame(entry.frame, question, sceneStore?.getState?.(), { frameAt: entry.at });
      frameBuffer.saveKeyframe?.(entry.at, `agent: ${question}`);
      return normalizeAnalysis(outcome, entry);
    },
  });

  registry.register({
    name: 'inspect_view_at_time',
    description: 'Retrieve the frame nearest a specific past timestamp (e.g. something referenced as "that" or "the one shown earlier") and analyze it.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' }, timestampMs: { type: 'number' } },
      required: ['question', 'timestampMs'],
    },
    async execute({ question, timestampMs }) {
      if (!frameBuffer || !deepAnalyzer) return { ok: false, note: 'Vision escalation is not wired up.' };
      const entry = frameBuffer.frameAt(timestampMs);
      if (!entry || Math.abs(entry.at - timestampMs) > maxFrameAgeMs) {
        return { ok: false, note: `No buffered frame is close enough to timestamp ${timestampMs}.` };
      }
      const outcome = await deepAnalyzer.analyzeFrame(entry.frame, question, sceneStore?.getState?.(), { frameAt: entry.at });
      frameBuffer.saveKeyframe?.(entry.at, `agent: ${question}`);
      return {
        ...normalizeAnalysis(outcome, entry),
        requestedTimestampMs: timestampMs,
        timestampDeltaMs: entry.at - timestampMs,
      };
    },
  });

  registry.register({
    name: 'check_clock',
    description: 'Deterministic test tool with no external dependencies — returns the current time and scene revision. Useful for proving tool execution works.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { nowMs: now(), sceneRevision: sceneStore?.getState?.()?.revision ?? null };
    },
  });

  return registry;
}
