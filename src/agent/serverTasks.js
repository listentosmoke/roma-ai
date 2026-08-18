// Server-task tools — how Roma hands engineering work to the background
// agent. Additive entries in the SAME registry the vision/memory/identity
// tools use; no change to the agent decision schema.
//
// The division of labour these tools encode: Roma answers what it can answer
// from what it already knows, and dispatches anything that means reading a
// codebase, running tests, touching a database, or working for minutes rather
// than seconds. Roma never pretends to have done that work itself, and never
// reports a result it has not actually received.

/**
 * @param {ReturnType<typeof import('./tools.js').createToolRegistry>} registry
 * @param {{ tasks: { dispatch: Function, status: Function, respond: Function, cancel: Function } }} deps
 */
export function registerServerTaskTools(registry, { tasks }) {
  const unavailable = { ok: false, note: 'The server agent is not available right now.' };

  registry.register({
    name: 'dispatch_server_task',
    // The old wording ended "do not use this for questions you can already
    // answer", which the model read too broadly: asked what a source file was
    // for, it decided that was an ordinary question, found it had no file
    // access, and apologised instead of dispatching. YOU CANNOT READ FILES is
    // the fact that settles it.
    description: 'Hand engineering work to the background server agent, which CAN read files and run commands inside a registered project. You cannot read files or run anything yourself, so ANY request that needs looking at code, running tests, database work, or debugging must come here — including "what does this file do" and other questions that sound small. Give the goal in one clear sentence and the project name. Use "write" mode ONLY when the user clearly wants files changed; the wearer is asked to approve before anything is modified. Never answer from guesswork about code you have not been shown.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string' }, project: { type: 'string' }, mode: { type: 'string' } },
      required: ['goal'],
    },
    async execute({ goal, project = null, mode = 'readonly' }) {
      if (!tasks) return unavailable;
      const result = await tasks.dispatch({ goal, project, mode: mode === 'write' ? 'write' : 'readonly' });
      if (!result?.ok) return { ok: false, note: result?.error ?? 'Could not start the task.' };
      // Roma tells the wearer it STARTED — never that it finished.
      return { ok: true, taskId: result.task.taskId, status: result.task.status, note: 'Started in the background. You will be told when it needs you or finishes.' };
    },
  });

  registry.register({
    name: 'check_task_status',
    description: 'Check what the background server agent is doing right now, or the state of one task. Use this when the user asks how something is going.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: [] },
    async execute({ task_id = null }) {
      if (!tasks) return unavailable;
      const result = await tasks.status(task_id);
      if (!result?.ok) return { ok: false, note: 'Could not read task status.' };
      return {
        ok: true,
        tasks: (result.tasks ?? []).map((task) => ({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          latestProgress: (task.progress ?? []).at(-1)?.message ?? null,
          pendingRequest: task.pendingRequest?.text ?? null,
          resultSummary: task.resultSummary ?? null,
          error: task.error ?? null,
        })),
      };
    },
  });

  registry.register({
    name: 'answer_task_question',
    description: 'Give the background agent the answer or the approval it is waiting for. Use approve=true only when the user actually agreed. If they declined, pass approve=false — the task stops without changing anything.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, response: { type: 'string' }, approve: { type: 'boolean' } },
      required: ['task_id'],
    },
    async execute({ task_id, response = null, approve = null }) {
      if (!tasks) return unavailable;
      const result = await tasks.respond({ taskId: task_id, response, approved: approve });
      if (!result?.ok) return { ok: false, note: result?.reasonCode === 'not_awaiting' ? 'That task is not waiting on anything.' : 'Could not deliver the answer.' };
      return { ok: true, status: result.task.status };
    },
  });

  registry.register({
    name: 'cancel_server_task',
    description: 'Stop a running background task because the user asked you to.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    async execute({ task_id }) {
      if (!tasks) return unavailable;
      const result = await tasks.cancel(task_id);
      if (!result?.ok) return { ok: false, note: 'Could not cancel that task.' };
      return { ok: true, status: result.task.status };
    },
  });
}

/**
 * Render the bounded pending-task block for context assembly, so a spoken
 * "yes, go ahead" on the next turn resolves to the right task. Returns '' when
 * there is nothing outstanding — Roma is not reminded of work it need not
 * mention.
 */
/**
 * Render the registered-project allowlist for context assembly.
 *
 * Without this Roma has no idea any project exists. Asked to look at "the roma
 * project" she concluded she had no access to it and apologised — technically
 * true of herself, but wrong, because a background agent was standing by with
 * that exact repository registered. Naming what is dispatchable is what makes
 * the capability usable.
 */
export function formatRegisteredProjects(projects = []) {
  if (!projects.length) return '';
  return projects.slice(0, 10).map((project) => `- ${project.name}${project.defaultTestCmd ? ` (tests: ${project.defaultTestCmd})` : ''}`).join('\n');
}

export function formatPendingTasks(tasks = []) {
  const waiting = tasks.filter((task) => task.status === 'awaiting_approval' || task.status === 'awaiting_input');
  if (!waiting.length) return '';
  return waiting
    .map((task) => `- ${task.taskId} (${task.status === 'awaiting_approval' ? 'needs your approval' : 'has a question'}): ${task.pendingRequest?.text ?? task.title}`)
    .join('\n');
}
