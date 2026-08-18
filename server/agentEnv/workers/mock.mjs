// Deterministic scripted worker. Satisfies the full adapter contract with no
// network, no subprocess, and no filesystem access — this is what every test
// and virtual-lab scenario runs against, so dispatch/approval/cancellation
// behavior is verified without depending on a real model's mood.
//
// It is explicitly labeled `mock` everywhere it surfaces: a lab report that
// used this worker says so, and never claims real-worker verification.

const DEFAULT_SCRIPT = [
  { type: 'progress', message: 'Reading the project structure.', afterMs: 10 },
  { type: 'progress', message: 'Located the relevant module and its tests.', afterMs: 10 },
  { type: 'result', summary: 'Reviewed the module and found no failing tests.', testsRun: 'node --test (12 passed)', learnings: [{ kind: 'codebase', title: 'Module layout', body: 'The module keeps its logic pure and its IO at the edges.' }], afterMs: 10 },
];

/** A script that pauses for approval before doing anything consequential. */
export const APPROVAL_SCRIPT = [
  { type: 'progress', message: 'Inspected the migration and the affected table.', afterMs: 10 },
  { type: 'approval_request', request: 'May I apply the migration to the development database?', detail: 'Adds one column; reversible.', afterMs: 10 },
  { type: 'progress', message: 'Applying the migration.', afterMs: 10, requiresApproval: true },
  { type: 'result', summary: 'Migration applied and verified; 3 tables updated.', testsRun: 'node --test (all passed)', afterMs: 10, requiresApproval: true },
];

export const FAILURE_SCRIPT = [
  { type: 'progress', message: 'Starting the build.', afterMs: 10 },
  { type: 'error', message: 'Build failed: unresolved import in module graph.', afterMs: 10 },
];

export const SLOW_SCRIPT = [
  { type: 'progress', message: 'Working…', afterMs: 50 },
  { type: 'progress', message: 'Still working…', afterMs: 100000 }, // long enough to be cancelled/timed out
];

export function createMockWorker({ script = DEFAULT_SCRIPT } = {}) {
  return {
    name: 'mock',
    describe: () => ({ engine: 'mock', real: false, note: 'deterministic scripted worker — not a real coding agent' }),

    startTask({ onEvent, approvalGate = null }) {
      let cancelled = false;
      // Every pending wait registers a waker here. Cancelling MUST settle them:
      // a cancelled worker whose promise never resolves would hang the
      // dispatcher's `await finished` forever (found by the first test run).
      const wakers = new Set();

      function sleep(ms) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => { wakers.delete(waker); resolve(); }, ms);
          const waker = () => { clearTimeout(timer); wakers.delete(waker); resolve(); };
          wakers.add(waker);
        });
      }

      // One grant covers the work that follows it, until the worker asks
      // again. Re-gating every subsequent step would leave the task waiting
      // for an approval nobody was ever asked for (found on the first run).
      let granted = false;

      const finished = (async () => {
        for (const step of script) {
          if (cancelled) return { cancelled: true };
          // Steps flagged requiresApproval wait for the wearer's decision,
          // which arrives through the dispatcher, never from the worker.
          if (step.requiresApproval && approvalGate && !granted) {
            // The gate resolves with { approved, response } so a real engine can
            // resume with the wearer's words; a bare boolean is still accepted.
            const decision = await approvalGate();
            const approved = decision === true || decision?.approved === true;
            if (cancelled) return { cancelled: true };
            if (!approved) {
              onEvent({ type: 'error', message: 'Not approved — stopping without making changes.' });
              return { cancelled: false };
            }
            granted = true;
          }
          if (step.type === 'approval_request') granted = false; // a new ask resets the grant
          await sleep(step.afterMs ?? 5);
          if (cancelled) return { cancelled: true };
          const { afterMs, requiresApproval, ...event } = step;
          onEvent(event);
        }
        return { cancelled: false };
      })();

      return {
        cancel() {
          cancelled = true;
          for (const waker of [...wakers]) waker();
        },
        finished,
      };
    },
  };
}
