// Task notifier — Roma decides what the wearer HEARS about background work.
//
// The server agent reports status; it never speaks. This module turns task
// state changes into candidate announcements and classifies each one as
// silent, visual, or spoken. Everything it marks spoken still goes through the
// existing Intervention Policy and Speech Gate — the wearer's budgets,
// cooldowns, and preferences are unchanged and cannot be bypassed here.
//
// The governing judgement: a wearable assistant narrating every step of a
// background job is worse than useless. So:
//   progress            → silent (visible in the panel only), with at most one
//                         spoken milestone per task per interval
//   awaiting_approval   → SPOKEN question: the task is blocked on the wearer
//   awaiting_input      → SPOKEN question, same reasoning
//   completed / failed  → SPOKEN short summary, when convenient
//   cancelled           → silent (the wearer just asked for it)
//
// Pure and deterministic: same inputs, same decision, no model involved.

export const NOTIFICATION_KINDS = ['silent', 'visual', 'speak_when_convenient', 'speak_now'];

const DEFAULT_MILESTONE_INTERVAL_MS = 5 * 60 * 1000;

function shortGoal(task) {
  const text = task?.title || task?.goal || 'the background task';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * @param {{ milestoneIntervalMs?: number, now?: () => number }} [options]
 */
export function createTaskNotifier({ milestoneIntervalMs = DEFAULT_MILESTONE_INTERVAL_MS, now = Date.now } = {}) {
  // taskId -> { status, progressCount, lastSpokenAt, announcedTerminal }
  const seen = new Map();

  /**
   * Diff a task snapshot against what we last saw and decide what (if
   * anything) the wearer should be told.
   * @returns {{ kind: string, text: string|null, reasonCode: string, sourceType: string, taskId: string }|null}
   */
  function evaluate(task) {
    if (!task?.taskId) return null;
    const previous = seen.get(task.taskId);
    const progressCount = (task.progress ?? []).length;
    const record = { status: task.status, progressCount, lastSpokenAt: previous?.lastSpokenAt ?? 0, announcedTerminal: previous?.announcedTerminal ?? false };

    const decide = (kind, text, reasonCode) => {
      if (kind === 'speak_now' || kind === 'speak_when_convenient') record.lastSpokenAt = now();
      seen.set(task.taskId, record);
      return { kind, text, reasonCode, sourceType: 'task_update', taskId: task.taskId };
    };

    // First sighting of a task that is simply queued/running: nothing to say.
    if (!previous) {
      seen.set(task.taskId, record);
      if (task.status === 'queued' || task.status === 'running') return null;
    }

    const statusChanged = previous && previous.status !== task.status;

    // Blocked on the wearer — this is the whole reason to interrupt.
    if (task.status === 'awaiting_approval' && (statusChanged || !previous)) {
      const request = task.pendingRequest?.text ?? 'It needs your approval to continue.';
      return decide('speak_now', `The background task on ${shortGoal(task)} needs your approval: ${request}`, 'approval_required');
    }
    if (task.status === 'awaiting_input' && (statusChanged || !previous)) {
      const question = task.pendingRequest?.text ?? 'It has a question for you.';
      return decide('speak_now', `A question about ${shortGoal(task)}: ${question}`, 'input_required');
    }

    // Terminal outcomes: say it once, when convenient.
    if ((task.status === 'completed' || task.status === 'failed') && !record.announcedTerminal && (statusChanged || !previous)) {
      record.announcedTerminal = true;
      const text = task.status === 'completed'
        ? `Finished ${shortGoal(task)}. ${task.resultSummary ?? ''}`.trim()
        : `The task on ${shortGoal(task)} failed. ${task.error ?? ''}`.trim();
      return decide('speak_when_convenient', text, task.status === 'completed' ? 'task_completed' : 'task_failed');
    }

    // The wearer asked for the cancellation; telling them about it is noise.
    if (task.status === 'cancelled' && statusChanged) {
      seen.set(task.taskId, record);
      return { kind: 'silent', text: null, reasonCode: 'cancelled_by_wearer', sourceType: 'task_update', taskId: task.taskId };
    }

    // Progress: visible, and spoken at most once per interval per task.
    if (progressCount > (previous?.progressCount ?? 0)) {
      const latest = (task.progress ?? []).at(-1);
      const sinceSpoken = now() - (record.lastSpokenAt || 0);
      if (record.lastSpokenAt && sinceSpoken < milestoneIntervalMs) {
        seen.set(task.taskId, record);
        return { kind: 'visual', text: latest?.message ?? null, reasonCode: 'progress_within_quiet_interval', sourceType: 'task_update', taskId: task.taskId };
      }
      if (!record.lastSpokenAt) {
        // The very first progress on a task is not worth speaking either —
        // the wearer just asked for the work; they know it started.
        seen.set(task.taskId, record);
        return { kind: 'visual', text: latest?.message ?? null, reasonCode: 'progress_not_a_milestone', sourceType: 'task_update', taskId: task.taskId };
      }
      return decide('speak_when_convenient', `Update on ${shortGoal(task)}: ${latest?.message ?? 'still working'}`, 'progress_milestone');
    }

    seen.set(task.taskId, record);
    return null;
  }

  /** Evaluate a batch of task snapshots (what a poll returns). */
  function evaluateAll(tasks = []) {
    return tasks.map((task) => evaluate(task)).filter(Boolean);
  }

  function forget(taskId) { seen.delete(taskId); }
  function reset() { seen.clear(); }

  return { evaluate, evaluateAll, forget, reset };
}
