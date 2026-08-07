// Structured agent-decision schema + validation. Pure and dependency-free — used
// by every provider (Groq's strict json_schema response_format is built directly
// from AGENT_DECISION_JSON_SCHEMA below) and by the runtime to validate whatever
// comes back before executing it. Invalid output must fail safely rather than be
// treated as an instruction: validateDecision() never throws, it reports errors.

export const DECISIONS = ['ignore', 'respond', 'clarify', 'tool_call', 'inspect_vision', 'update_task'];

// Wearer-centered turn analysis (glasses reframe). Roma runs on glasses worn by
// ONE person; most speech it hears is other people talking TO that wearer, not
// to Roma. The decision enum deliberately does NOT grow — `decision` still
// governs what Roma DOES (and therefore whether anything can be spoken), while
// `turn_analysis` records what Roma UNDERSTOOD about the moment. An `ignore`
// decision with a filled analysis is the normal, expected case: Roma stays
// quiet in the conversation but may still surface a private assist suggestion
// through the existing Opportunity Engine -> Intervention Policy -> Speech Gate
// path. Nothing here authorizes speech or any action by itself.
export const SPEAKER_ROLES = ['wearer', 'other_person', 'unknown'];
export const ADDRESSED_TO = ['roma', 'wearer', 'another_person', 'group', 'unclear'];

const MAX_REASON_CHARS = 300;
const MAX_RESPONSE_CHARS = 2000;
const MAX_GOAL_CHARS = 200;
const MAX_ENTITY_KEYS = 10;
const MAX_ENTITY_VALUE_CHARS = 200;
const MAX_TOOL_CALLS = 3;
const MAX_ASSIST_HINT_CHARS = 140;

// Strict structured-output mode (Groq/OpenAI) requires additionalProperties:false
// on EVERY object, which forbids free-form maps — so open key/value data
// (task entities, tool arguments) travels as {name, value} pair arrays on the
// wire and is converted back to plain objects during validation.
const KEY_VALUE_PAIRS = {
  type: 'array',
  description: 'Key/value pairs, each as {"name": ..., "value": ...}.',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: ['string', 'number', 'boolean', 'null'] } },
    required: ['name', 'value'],
    additionalProperties: false,
  },
};

// JSON Schema handed to providers that support structured/JSON-schema output
// (e.g. Groq's `response_format: { type: 'json_schema', strict: true, schema }`).
export const AGENT_DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: DECISIONS },
    response: { type: ['string', 'null'] },
    reason_summary: { type: 'string' },
    task_update: {
      type: ['object', 'null'],
      properties: {
        active: { type: 'boolean' },
        taskId: { type: 'string' },
        goal: { type: 'string' },
        status: { type: 'string' },
        entities: KEY_VALUE_PAIRS,
      },
      required: ['active', 'taskId', 'goal', 'status', 'entities'],
      additionalProperties: false,
    },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, arguments: KEY_VALUE_PAIRS },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
    visual_analysis_request: {
      type: ['object', 'null'],
      properties: { question: { type: 'string' }, timestampMs: { type: ['number', 'null'] } },
      required: ['question', 'timestampMs'],
      additionalProperties: false,
    },
    // Wearer analysis as FLAT top-level scalars, not a nested object. A nested
    // object here measurably destabilized Groq's constrained decoding — turns
    // began failing generation at `/tool_calls/...` (HTTP 400), exhausting
    // retries and leaving direct questions unanswered. Flattening keeps the
    // same information at a fraction of the decoding cost. `speaker_role` was
    // dropped entirely: src/agent/wearer.js already resolves who the wearer is
    // deterministically, which is more trustworthy than asking the model.
    // Diagnosed from virtual-lab runs, 2026-07-25.
    addressed_to: { type: 'string', enum: ADDRESSED_TO, description: 'Who this turn was aimed at. Fill on EVERY decision, including ignore.' },
    wearer_expected_to_respond: { type: 'boolean', description: 'Is the wearer now expected to answer or act?' },
    assist_opportunity: { type: ['string', 'null'], description: 'One short note on how you could help the wearer here, or null.' },
    scene_revision_used: { type: ['integer', 'null'] },
  },
  required: ['decision', 'response', 'reason_summary', 'task_update', 'tool_calls', 'visual_analysis_request', 'addressed_to', 'wearer_expected_to_respond', 'assist_opportunity', 'scene_revision_used'],
  additionalProperties: false,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Accept either a plain object map (mocks/tests) or the strict-mode wire format
// (array of {name, value} pairs) and normalize to a plain object.
function pairsToObject(value) {
  if (isPlainObject(value)) return value;
  if (Array.isArray(value)) {
    const object = {};
    for (const pair of value) {
      if (isPlainObject(pair) && typeof pair.name === 'string') object[pair.name] = pair.value;
    }
    return object;
  }
  return null;
}

function truncate(text, max) {
  return typeof text === 'string' && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Validate + bound a proposed task_update. Never throws. */
export function validateTaskUpdate(update) {
  if (update === null || update === undefined) return { ok: true, value: null, errors: [] };
  if (!isPlainObject(update)) return { ok: false, value: null, errors: ['task_update must be an object or null'] };

  // Strict structured-output mode requires every declared property, so a model
  // with NO task change to report has to emit the object anyway — in practice
  // as empty strings ({active:false, taskId:"", goal:"", status:""}). Treating
  // that as invalid discarded the entire decision and left direct questions
  // unanswered (virtual-lab diagnosis, 2026-07-25). An empty update means "no
  // task update", which is exactly what null means.
  // Narrow on purpose: only a NON-active, entirely blank update is "nothing to
  // report". `{active: true}` with no id/goal/status is incoherent — the model
  // claimed to start a task but named none — and must still fail loudly.
  const blank = (value) => typeof value !== 'string' || !value.trim();
  if (update.active !== true && blank(update.taskId) && blank(update.goal) && blank(update.status)) {
    return { ok: true, value: null, errors: [] };
  }

  const errors = [];
  if (typeof update.active !== 'boolean') errors.push('task_update.active must be a boolean');
  if (typeof update.taskId !== 'string' || !update.taskId) errors.push('task_update.taskId must be a non-empty string');
  if (typeof update.goal !== 'string' || !update.goal) errors.push('task_update.goal must be a non-empty string');
  if (typeof update.status !== 'string' || !update.status) errors.push('task_update.status must be a non-empty string');

  let entities = {};
  if (update.entities !== undefined && update.entities !== null) {
    const map = pairsToObject(update.entities);
    if (!map) {
      errors.push('task_update.entities must be an object or an array of {name, value} pairs');
    } else {
      const keys = Object.keys(map).slice(0, MAX_ENTITY_KEYS);
      if (Object.keys(map).length > MAX_ENTITY_KEYS) errors.push(`task_update.entities must have at most ${MAX_ENTITY_KEYS} keys`);
      for (const key of keys) {
        const value = map[key];
        entities[key] = typeof value === 'string' ? truncate(value, MAX_ENTITY_VALUE_CHARS) : String(value ?? '');
      }
    }
  }

  if (errors.length) return { ok: false, value: null, errors };
  return {
    ok: true,
    errors: [],
    value: {
      active: update.active,
      taskId: update.taskId,
      goal: truncate(update.goal, MAX_GOAL_CHARS),
      status: update.status,
      entities,
    },
  };
}

/**
 * Validate + bound a proposed turn_analysis. Never throws, and NEVER fails the
 * whole decision: a missing or malformed analysis degrades to an
 * `unknown/unclear` record rather than discarding an otherwise valid decision
 * (the analysis is observational metadata, not an instruction). Unrecognized
 * enum values are normalized rather than trusted.
 */
export function validateTurnAnalysis(analysis) {
  // Accepts the flat wire shape (top-level fields on the decision) and, for
  // back-compat with mock providers and older fixtures, a nested
  // `turn_analysis` object.
  const source = isPlainObject(analysis?.turn_analysis) ? analysis.turn_analysis : analysis;
  if (!isPlainObject(source)) {
    return { speakerRole: 'unknown', addressedTo: 'unclear', wearerExpectedToRespond: false, assistOpportunity: null, provided: false };
  }
  const hint = typeof source.assist_opportunity === 'string' ? source.assist_opportunity.trim() : '';
  const provided = ADDRESSED_TO.includes(source.addressed_to)
    || typeof source.wearer_expected_to_respond === 'boolean'
    || typeof source.assist_opportunity === 'string';
  return {
    // speaker_role is no longer requested from the model — src/agent/wearer.js
    // resolves the wearer deterministically. Kept in the shape (as 'unknown')
    // so existing consumers/tests keep working.
    speakerRole: SPEAKER_ROLES.includes(source.speaker_role) ? source.speaker_role : 'unknown',
    addressedTo: ADDRESSED_TO.includes(source.addressed_to) ? source.addressed_to : 'unclear',
    wearerExpectedToRespond: source.wearer_expected_to_respond === true,
    assistOpportunity: hint ? truncate(hint, MAX_ASSIST_HINT_CHARS) : null,
    provided,
  };
}

/**
 * Validate a raw model decision. Returns { ok, decision, errors }.
 * `decision` is null unless ok is true — never partially trust malformed output.
 */
export function validateDecision(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, decision: null, errors: ['decision must be a JSON object'] };
  if (!DECISIONS.includes(raw.decision)) errors.push(`decision must be one of: ${DECISIONS.join(', ')}`);

  const needsResponse = raw.decision === 'respond' || raw.decision === 'clarify';
  let response = null;
  if (needsResponse) {
    if (typeof raw.response !== 'string' || !raw.response.trim()) errors.push(`response is required for decision "${raw.decision}"`);
    else response = truncate(raw.response.trim(), MAX_RESPONSE_CHARS);
  } else if (raw.response != null && typeof raw.response !== 'string') {
    errors.push('response must be a string or null');
  }

  const reasonSummary = typeof raw.reason_summary === 'string' ? truncate(raw.reason_summary.trim(), MAX_REASON_CHARS) : '';

  const taskUpdateResult = validateTaskUpdate(raw.task_update ?? null);
  if (!taskUpdateResult.ok) errors.push(...taskUpdateResult.errors);

  let toolCalls = [];
  if (raw.tool_calls !== undefined && raw.tool_calls !== null) {
    if (!Array.isArray(raw.tool_calls)) errors.push('tool_calls must be an array');
    else {
      // Cap rather than reject — an over-eager model asking for too many tools
      // at once is bounded, not treated as invalid output.
      for (const call of raw.tool_calls.slice(0, MAX_TOOL_CALLS)) {
        if (!isPlainObject(call) || typeof call.name !== 'string' || !call.name) {
          errors.push('each tool_call needs a string name');
          continue;
        }
        toolCalls.push({ name: call.name, arguments: pairsToObject(call.arguments) ?? {} });
      }
    }
  }
  if (raw.decision === 'tool_call' && toolCalls.length === 0) errors.push('tool_call decisions require at least one entry in tool_calls');

  let visualAnalysisRequest = null;
  if (raw.decision === 'inspect_vision') {
    if (!isPlainObject(raw.visual_analysis_request) || typeof raw.visual_analysis_request.question !== 'string' || !raw.visual_analysis_request.question.trim()) {
      errors.push('inspect_vision decisions require visual_analysis_request.question');
    } else {
      const timestampMs = raw.visual_analysis_request.timestampMs;
      visualAnalysisRequest = {
        question: raw.visual_analysis_request.question.trim(),
        timestampMs: typeof timestampMs === 'number' && Number.isFinite(timestampMs) ? timestampMs : null,
      };
    }
  } else if (raw.visual_analysis_request != null && !isPlainObject(raw.visual_analysis_request)) {
    errors.push('visual_analysis_request must be an object or null');
  }

  const sceneRevisionUsed = Number.isInteger(raw.scene_revision_used) ? raw.scene_revision_used : null;
  const turnAnalysis = validateTurnAnalysis(raw);

  if (errors.length) return { ok: false, decision: null, errors };

  return {
    ok: true,
    errors: [],
    decision: {
      decision: raw.decision,
      response,
      reasonSummary,
      taskUpdate: taskUpdateResult.value,
      toolCalls,
      visualAnalysisRequest,
      turnAnalysis,
      sceneRevisionUsed,
    },
  };
}
