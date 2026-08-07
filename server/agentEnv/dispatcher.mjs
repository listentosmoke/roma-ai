// Task dispatcher — the boundary between Roma and a worker engine.
//
// Responsibilities:
//   - one task in flight at a time (a wearable assistant reporting on five
//     concurrent background jobs is noise, not help),
//   - normalize worker events into bounded task-store state,
//   - enforce the wall clock and hard cancellation,
//   - gate WRITE-mode work on explicit wearer approval,
//   - harvest structured `learnings` into engineering memory,
//   - audit every consequential transition.
//
// What it deliberately does NOT do: speak, decide what the wearer hears, or
// let a worker reach any of Roma's subsystems. Worker output lands in the task
// store; src/agent/taskNotifier.js decides whether Roma mentions it, and the
// existing Speech Gate decides whether that may be spoken.

import { normalizeWorkerEvent, buildTaskBrief } from './workers/adapter.mjs';
import { formatEngineeringContext } from './engineeringMemory.mjs';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export function createDispatcher({ taskStore, engineeringMemory, worker, auditRepository = null, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // taskId -> { cancel, resolveApproval, timer }
  const running = new Map();
  let queue = Promise.resolve();

  function audit(principal, fields) {
    try {
      auditRepository?.forWorkspace(principal.workspaceId)?.record({ principalId: principal.userId, ...fields });
    } catch { /* auditing must never break dispatch */ }
  }

  /**
   * Dispatch a task. Returns immediately with the queued task; the work runs
   * in the background and the caller polls the task store.
   */
  function dispatch(principal, { taskId }) {
    const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
    const task = tasks.get(taskId);
    if (!task) return { ok: false, reasonCode: 'not_found' };
    if (task.status !== 'queued') return { ok: false, reasonCode: 'not_queued', task };

    audit(principal, { action: 'agent_task.dispatch', resourceType: 'agent_task', resourceId: taskId, outcome: 'started', reasonCode: task.mode, operationId: task.operationId });

    queue = queue.then(() => runTask(principal, taskId)).catch(() => {});
    return { ok: true, task: tasks.get(taskId) };
  }

  async function runTask(principal, taskId) {
    const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
    const memory = engineeringMemory.forWorkspace(principal.workspaceId, principal.userId);
    let task = tasks.get(taskId);
    if (!task || task.status !== 'queued') return;

    const project = task.projectId ? memory.getProject(task.projectId) : null;
    const relevant = memory.retrieveForBrief({ goal: task.goal, projectId: task.projectId });
    const brief = buildTaskBrief({
      goal: task.goal,
      project,
      engineeringContext: formatEngineeringContext(relevant),
      mode: task.mode,
    });

    tasks.update(taskId, { status: 'running' });

    let approvalResolver = null;
    const handle = worker.startTask({
      brief,
      cwd: project?.rootPath ?? null,
      mode: task.mode,
      timeoutMs,
      onEvent: (raw) => {
        const event = normalizeWorkerEvent(raw);
        if (!event) return; // unknown event types are dropped, never trusted
        handleWorkerEvent(principal, taskId, event, memory);
      },
      // WRITE-mode steps and unanswered questions block here until the wearer
      // decides, through Roma. The resolved value carries the wearer's actual
      // words as well as the yes/no, so a worker that had to ask something can
      // resume with the answer instead of just being told to carry on.
      approvalGate: () => new Promise((resolve) => { approvalResolver = resolve; }),
    });

    const timer = setTimeout(() => {
      handle.cancel();
      tasks.update(taskId, { status: 'failed', error: `Timed out after ${Math.round(timeoutMs / 1000)}s.` });
      audit(principal, { action: 'agent_task.timeout', resourceType: 'agent_task', resourceId: taskId, outcome: 'failed', reasonCode: 'wall_clock' });
    }, timeoutMs);

    running.set(taskId, {
      cancel: handle.cancel,
      timer,
      approve: (approved, response = null) => { approvalResolver?.({ approved, response }); approvalResolver = null; },
      hasPendingApproval: () => Boolean(approvalResolver),
    });

    try {
      await handle.finished;
    } catch (error) {
      tasks.update(taskId, { status: 'failed', error: String(error?.message ?? error).slice(0, 300) });
    } finally {
      clearTimeout(timer);
      running.delete(taskId);
      // A worker that ended without a terminal event is a failure, not a
      // silent success — never leave a task looking alive.
      const finalTask = tasks.get(taskId);
      if (finalTask && !['completed', 'failed', 'cancelled'].includes(finalTask.status)) {
        tasks.update(taskId, { status: 'failed', error: 'The worker stopped without reporting a result.' });
      }
    }
  }

  function handleWorkerEvent(principal, taskId, event, memory) {
    const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
    switch (event.type) {
      case 'progress':
      case 'log':
        tasks.appendProgress(taskId, { message: event.message, kind: event.type });
        break;
      case 'question':
        tasks.update(taskId, { status: 'awaiting_input', pendingRequest: { kind: 'question', text: event.question, at: now() } });
        audit(principal, { action: 'agent_task.question', resourceType: 'agent_task', resourceId: taskId, outcome: 'awaiting_input' });
        break;
      case 'approval_request':
        tasks.update(taskId, { status: 'awaiting_approval', pendingRequest: { kind: 'approval', text: event.request, detail: event.detail, at: now() } });
        audit(principal, { action: 'agent_task.approval_request', resourceType: 'agent_task', resourceId: taskId, outcome: 'awaiting_approval' });
        break;
      case 'result': {
        tasks.update(taskId, { status: 'completed', resultSummary: event.summary, pendingRequest: null });
        // Harvest what the worker learned into ENGINEERING memory (never the
        // wearer's personal memory).
        for (const learning of event.learnings ?? []) {
          const task = tasks.get(taskId);
          memory.remember({ projectId: task?.projectId ?? null, kind: learning.kind, title: learning.title, body: learning.body, sourceTaskId: taskId });
        }
        audit(principal, { action: 'agent_task.completed', resourceType: 'agent_task', resourceId: taskId, outcome: 'completed', reasonCode: `learnings_${(event.learnings ?? []).length}` });
        break;
      }
      case 'error':
        tasks.update(taskId, { status: 'failed', error: event.message, pendingRequest: null });
        audit(principal, { action: 'agent_task.failed', resourceType: 'agent_task', resourceId: taskId, outcome: 'failed' });
        break;
      default:
        break;
    }
  }

  /** The wearer answered a question or granted/denied approval (through Roma). */
  function respond(principal, { taskId, response = null, approved = null }) {
    const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
    const task = tasks.get(taskId);
    if (!task) return { ok: false, reasonCode: 'not_found' };
    if (!['awaiting_approval', 'awaiting_input'].includes(task.status)) return { ok: false, reasonCode: 'not_awaiting', task };

    const active = running.get(taskId);
    if (task.status === 'awaiting_approval') {
      const granted = approved === true;
      audit(principal, { action: 'agent_task.approval', resourceType: 'agent_task', resourceId: taskId, outcome: granted ? 'approved' : 'rejected' });
      if (!granted) {
        active?.cancel();
        tasks.update(taskId, { status: 'cancelled', error: 'The wearer did not approve this step.', pendingRequest: null });
        active?.approve(false);
        return { ok: true, task: tasks.get(taskId) };
      }
      tasks.update(taskId, { status: 'running', pendingRequest: null });
      active?.approve(true);
      return { ok: true, task: tasks.get(taskId) };
    }

    // awaiting_input — the answer is logged AND handed back to the worker, so
    // an engine that supports resuming picks up where it stopped.
    tasks.update(taskId, { status: 'running', pendingRequest: null });
    tasks.appendProgress(taskId, { kind: 'log', message: `Wearer answered: ${String(response ?? '').slice(0, 200)}` });
    active?.approve(true, response ?? null);
    return { ok: true, task: tasks.get(taskId) };
  }

  function cancel(principal, { taskId, reason = 'cancelled by the wearer' }) {
    const tasks = taskStore.forWorkspace(principal.workspaceId, principal.userId);
    const task = tasks.get(taskId);
    if (!task) return { ok: false, reasonCode: 'not_found' };
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return { ok: false, reasonCode: 'already_terminal', task };
    const active = running.get(taskId);
    active?.cancel();
    active?.approve(false);
    if (active?.timer) clearTimeout(active.timer);
    running.delete(taskId);
    tasks.update(taskId, { status: 'cancelled', error: reason, pendingRequest: null });
    audit(principal, { action: 'agent_task.cancel', resourceType: 'agent_task', resourceId: taskId, outcome: 'cancelled', reasonCode: reason.slice(0, 60) });
    return { ok: true, task: tasks.get(taskId) };
  }

  return {
    dispatch,
    respond,
    cancel,
    describeWorker: () => worker.describe?.() ?? { engine: worker.name ?? 'unknown', real: false },
    activeCount: () => running.size,
    /** Test/simulation helper: wait for the in-flight queue to drain. */
    drain: () => queue,
  };
}
