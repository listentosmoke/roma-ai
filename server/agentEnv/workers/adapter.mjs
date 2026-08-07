// Worker-engine contract.
//
// Roma does not do engineering work itself: its live model is a
// conversational front-end. Real coding, testing, database work, and
// long-running reasoning are handed to a WORKER — by default the locally
// installed Qwen Code CLI, but the point of this file is that the worker is
// replaceable. Anything satisfying this interface (OpenCode, Claude Code, a
// future in-house agent) drops in via configuration alone.
//
// Roma keeps, and never delegates:
//   conversation understanding · speech · task dispatch · notifications ·
//   permission handling · personal memory · privacy · cancellation
//
// The worker gets, and never controls anything else:
//   coding · project inspection · testing · database work · debugging ·
//   long-running background execution
//
// EVENT CONTRACT — a worker emits ONLY these, and nothing it emits can speak,
// authorize speech, or reach the wearer directly. The dispatcher normalizes
// them into task-store state; Roma decides what (if anything) is worth
// saying out loud.
//
//   { type: 'progress',  message }            bounded status line
//   { type: 'log',       message }            diagnostic detail (stored, never spoken)
//   { type: 'question',  question }           needs information from the wearer
//   { type: 'approval_request', request, detail? }  needs permission to proceed
//   { type: 'result',    summary, filesChanged?, testsRun?, learnings?, artifacts? }
//   { type: 'error',     message }
//
// startTask returns { cancel(): void } and resolves when the task ends.

export const WORKER_EVENT_TYPES = ['progress', 'log', 'question', 'approval_request', 'result', 'error'];

const MAX_MESSAGE = 300;
const MAX_SUMMARY = 2000;
const MAX_LEARNINGS = 10;

function bounded(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Validate and bound one worker event. Unknown types are dropped rather than
 * trusted — a worker cannot invent a new kind of thing to make Roma do.
 * @returns {object|null}
 */
export function normalizeWorkerEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!WORKER_EVENT_TYPES.includes(raw.type)) return null;
  switch (raw.type) {
    case 'progress':
    case 'log':
      return { type: raw.type, message: bounded(raw.message, MAX_MESSAGE) };
    case 'question':
      return { type: 'question', question: bounded(raw.question, MAX_MESSAGE) };
    case 'approval_request':
      return { type: 'approval_request', request: bounded(raw.request, MAX_MESSAGE), detail: bounded(raw.detail, MAX_MESSAGE) || null };
    case 'error':
      return { type: 'error', message: bounded(raw.message, MAX_MESSAGE) || 'worker failed' };
    case 'result':
      return {
        type: 'result',
        summary: bounded(raw.summary, MAX_SUMMARY),
        filesChanged: Array.isArray(raw.filesChanged) ? raw.filesChanged.slice(0, 50).map((f) => bounded(f, 200)).filter(Boolean) : [],
        testsRun: bounded(raw.testsRun, MAX_MESSAGE) || null,
        // Structured facts worth keeping in engineering memory. The dispatcher
        // writes these back; the worker cannot write to memory itself.
        learnings: Array.isArray(raw.learnings)
          ? raw.learnings.slice(0, MAX_LEARNINGS).map((learning) => ({
            kind: bounded(learning?.kind, 40) || 'task_note',
            title: bounded(learning?.title, 200),
            body: bounded(learning?.body, 2000),
          })).filter((learning) => learning.title && learning.body)
          : [],
        artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.slice(0, 20).map((a) => bounded(a, 300)).filter(Boolean) : [],
      };
    default:
      return null;
  }
}

/**
 * Build the brief handed to a worker. Engineering memory only — no personal
 * memories, no transcript, no identity data, and no credentials ever appear
 * in a brief.
 */
export function buildTaskBrief({ goal, project = null, engineeringContext = '', mode = 'readonly' }) {
  return [
    'You are a background engineering agent working on behalf of a user who is not watching you work.',
    '',
    `TASK: ${goal}`,
    '',
    project ? `PROJECT: ${project.name} (root: ${project.rootPath})${project.defaultTestCmd ? ` · tests: ${project.defaultTestCmd}` : ''}` : 'PROJECT: (none registered — do not assume a location)',
    '',
    `MODE: ${mode}${mode === 'readonly' ? ' — investigate and report only; do NOT modify files.' : ' — you may modify files inside the project root; changes are reviewed before they are kept.'}`,
    '',
    'WHAT IS ALREADY KNOWN ABOUT THIS PROJECT (prior engineering notes):',
    engineeringContext || '(none)',
    '',
    'Work independently. Do not narrate every step. Report meaningful progress only.',
    'If you need information or permission you cannot obtain yourself, ask ONE clear question and stop.',
    'When finished, give a short factual summary of what you did and what you found.',
    '',
    // Without this the model reports and forgets: the first real-worker run
    // came back with a correct analysis and an empty `learnings` array, so the
    // next task on the same project would have started from nothing.
    'Also record any DURABLE facts about this project worth keeping for future tasks: how something is',
    'structured, a command that works, a bug you confirmed, a decision, or an approach that failed and why.',
    'Skip anything obvious, one-off, or already listed above. Record nothing if you genuinely learned nothing.',
  ].join('\n');
}
