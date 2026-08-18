// Background task store. Durable record of every dispatched server-agent
// task, its bounded progress, whatever it is blocked on, and its outcome.
//
// Two properties matter most:
//   1. BOUNDED. Progress is a fixed-size ring, not a transcript of everything
//      the worker thought. Roma should never receive — or have to summarize —
//      unbounded worker chatter.
//   2. HONEST ON RESTART. A `running` task whose process died with the server
//      is marked `failed(interrupted)` on the next start. It is never left
//      looking alive, and never silently resumed.

export const TASK_STATUSES = ['queued', 'running', 'awaiting_approval', 'awaiting_input', 'completed', 'failed', 'cancelled'];
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const TASK_MODES = ['readonly', 'write'];

const MAX_PROGRESS_ENTRIES = 50;
const MAX_PROGRESS_CHARS = 300;
const MAX_GOAL_CHARS = 2000;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 2000;

function bounded(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}
function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(text, fallback) { try { return JSON.parse(text ?? ''); } catch { return fallback; } }

function rowToTask(row) {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    mode: row.mode,
    progress: fromJson(row.progress, []),
    pendingRequest: fromJson(row.pending_request, null),
    resultSummary: row.result_summary,
    error: row.error,
    operationId: row.operation_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function createTaskStore({ db, now = Date.now } = {}) {
  let counter = 0;

  function forWorkspace(workspaceId, userId) {
    const api = {
      create({ title, goal, projectId = null, mode = 'readonly', operationId = null }) {
        const cleanGoal = bounded(goal, MAX_GOAL_CHARS);
        if (!cleanGoal) return { ok: false, errors: ['goal is required'] };
        if (!TASK_MODES.includes(mode)) return { ok: false, errors: [`mode must be one of: ${TASK_MODES.join(', ')}`] };
        counter += 1;
        const taskId = `task_${now()}_${counter}`;
        const at = now();
        db.prepare('INSERT INTO agent_tasks (task_id, workspace_id, user_id, project_id, title, goal, status, mode, progress, pending_request, result_summary, error, operation_id, version, created_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 1, ?, ?, NULL)')
          .run(taskId, workspaceId, userId, projectId, bounded(title, MAX_TITLE_CHARS) || cleanGoal.slice(0, 60), cleanGoal, 'queued', mode, '[]', operationId, at, at);
        return { ok: true, task: api.get(taskId) };
      },

      get(taskId) {
        const row = db.prepare('SELECT * FROM agent_tasks WHERE task_id = ? AND workspace_id = ?').get(taskId, workspaceId);
        return row ? rowToTask(row) : null;
      },

      list({ status = null, limit = 25 } = {}) {
        const clauses = ['workspace_id = ?'];
        const params = [workspaceId];
        if (status) { clauses.push('status = ?'); params.push(status); }
        return db.prepare(`SELECT * FROM agent_tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
          .all(...params, Math.min(limit, 100)).map(rowToTask);
      },

      /** Tasks Roma may still need to tell the wearer about. */
      listActive() {
        return db.prepare("SELECT * FROM agent_tasks WHERE workspace_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at").all(workspaceId).map(rowToTask);
      },

      /**
       * Optimistic-concurrency update. `expectedVersion` (when supplied) makes
       * "a late worker event cannot overwrite newer state" a real guarantee
       * rather than a comment — the same pattern the session repository uses.
       */
      update(taskId, patch = {}, expectedVersion = null) {
        const existing = api.get(taskId);
        if (!existing) return { ok: false, reasonCode: 'not_found' };
        if (expectedVersion != null && existing.version !== expectedVersion) {
          return { ok: false, reasonCode: 'stale_version', task: existing };
        }
        if (patch.status && !TASK_STATUSES.includes(patch.status)) return { ok: false, reasonCode: 'invalid_status' };
        // A terminal task is finished. Late events must not revive it.
        if (TERMINAL_STATUSES.has(existing.status) && patch.status && patch.status !== existing.status) {
          return { ok: false, reasonCode: 'already_terminal', task: existing };
        }

        const status = patch.status ?? existing.status;
        const at = now();
        const finishedAt = TERMINAL_STATUSES.has(status) ? (existing.finishedAt ?? at) : null;
        db.prepare('UPDATE agent_tasks SET status = ?, progress = ?, pending_request = ?, result_summary = ?, error = ?, version = version + 1, updated_at = ?, finished_at = ? WHERE task_id = ? AND workspace_id = ?')
          .run(
            status,
            toJson(patch.progress ?? existing.progress),
            patch.pendingRequest === undefined ? toJson(existing.pendingRequest) : toJson(patch.pendingRequest),
            patch.resultSummary === undefined ? existing.resultSummary : bounded(patch.resultSummary, MAX_SUMMARY_CHARS),
            patch.error === undefined ? existing.error : bounded(patch.error, MAX_SUMMARY_CHARS),
            at,
            finishedAt,
            taskId,
            workspaceId,
          );
        return { ok: true, task: api.get(taskId) };
      },

      /** Append one bounded progress entry (ring-buffered). */
      appendProgress(taskId, { message, kind = 'progress' }) {
        const existing = api.get(taskId);
        if (!existing) return { ok: false, reasonCode: 'not_found' };
        const entry = { at: now(), kind, message: bounded(message, MAX_PROGRESS_CHARS) };
        const progress = [...existing.progress, entry].slice(-MAX_PROGRESS_ENTRIES);
        return api.update(taskId, { progress });
      },

      /**
       * Server restart honesty: anything that was mid-flight died with the
       * process. Mark it failed and visible — never leave a task looking alive,
       * never silently resume work the wearer did not re-authorize.
       */
      failInterrupted() {
        const rows = db.prepare("SELECT task_id FROM agent_tasks WHERE workspace_id = ? AND status IN ('running', 'queued')").all(workspaceId);
        for (const row of rows) {
          api.update(row.task_id, { status: 'failed', error: 'Interrupted: the server restarted while this task was in flight.' });
        }
        return rows.length;
      },
    };
    return api;
  }

  /** Restart sweep across every workspace (called once at server start). */
  function failInterruptedEverywhere() {
    const rows = db.prepare("SELECT DISTINCT workspace_id, user_id FROM agent_tasks WHERE status IN ('running', 'queued')").all();
    let total = 0;
    for (const row of rows) total += forWorkspace(row.workspace_id, row.user_id).failInterrupted();
    return total;
  }

  return { forWorkspace, failInterruptedEverywhere };
}
