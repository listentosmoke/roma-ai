// Reliable outbound mutation queue — the bounded, observable replacement for
// the fire-and-forget server sync the remote repositories used before the
// stabilization phase (see SERVER-DATA.md "Browser/server synchronization").
//
// Guarantees (each tested in test/sync-reliability.test.js):
//   - Every mutation carries a stable operation ID, reused across retries;
//     the server's tenant-scoped idempotency ledger makes duplicate delivery
//     produce exactly one record.
//   - A mutation is `pending`/`retrying` until the server acknowledges it —
//     the local mirror's optimistic result is never reported as durable
//     (status is inspectable via status()/list()/subscribe()).
//   - Strict FIFO with a single request in flight: mutations reach the server
//     in the order they were created locally, so an earlier retry can never
//     overwrite a later correction. A retrying head BLOCKS the queue (it
//     keeps its place); only terminal states (acknowledged/failed/
//     conflicted/cancelled) unblock it.
//   - Bounded exponential backoff with jitter; bounded attempts; bounded
//     queue size — nothing grows or retries forever.
//   - Submitting a delete cancels still-queued creates/updates for the same
//     entity (`superseded_by_delete`) — a delayed local write can never
//     resurrect a deletion (the server's tombstone check is the second,
//     authoritative layer of the same guarantee).
//   - Biometric material can never enter the queue: category 'biometric',
//     sensitivity 'biometric', and payloads with template/embedding-shaped
//     keys are rejected at submit() time.
//   - Persistence (optional, localStorage in the browser) stores only safe
//     queue metadata for restart recovery. Bodies are persisted ONLY for
//     public/normal-sensitivity data mutations under a size cap; anything
//     else is restored as a VISIBLE failure (`payload_not_restored`), never
//     silently dropped and never written to unsafe storage. The queue is an
//     outbox, not authoritative storage — the server stays the source of
//     truth for durable state.
//
// This module is framework-free and deterministic under injected
// now/schedule/random, so every behavior is unit-testable in Node.

const TERMINAL_STATUSES = new Set(['acknowledged', 'failed', 'conflicted', 'cancelled']);
const OPEN_STATUSES = new Set(['pending', 'retrying']);

// Keys that indicate biometric/raw-signal material. Matched against object
// KEYS (never values — a memory summary that merely mentions "audio" is fine).
const FORBIDDEN_KEY_PATTERN = /^(template|templates|embedding|embeddings|ciphertext|plaintext|pcm|rawaudio|audiodata|audiobytes|voiceprint|biometrictemplate)$/i;

export class MutationQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MutationQueueError';
    this.code = code;
  }
}

function scanForForbiddenKeys(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) return key;
    const nested = scanForForbiddenKeys(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function createMutationQueue({
  dataClient,
  storage = null,
  storageKey = 'roma.sync.queue',
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  random = Math.random,
  maxQueue = 100,
  maxAttempts = 5,
  baseBackoffMs = 500,
  maxBackoffMs = 30_000,
  maxPersistedBodyBytes = 8192,
  maxHistory = 50,
  label = 'sync',
} = {}) {
  if (!dataClient) throw new MutationQueueError('createMutationQueue requires a dataClient.', 'missing_data_client');

  /** @type {Array<object>} insertion-ordered; open ops keep their position */
  const queue = [];
  const listeners = new Set();
  let counter = 0;
  let processing = false;
  let wakeScheduled = false;

  function nextOperationId() {
    counter += 1;
    return `op_${now()}_${counter}_${Math.floor(random() * 0xffffff).toString(16)}`;
  }

  function emit(type, op) {
    const view = publicView(op);
    for (const listener of listeners) {
      try { listener({ type, op: view, at: now() }); } catch { /* listener errors never break the queue */ }
    }
  }

  function publicView(op) {
    // Never expose the body through observability surfaces.
    const { body, ...rest } = op;
    return { ...rest, hasBody: body != null };
  }

  function transition(op, status, reasonCode = null) {
    op.status = status;
    if (reasonCode) op.reasonCode = reasonCode;
    op.updatedAt = now();
    if (status === 'acknowledged') op.acknowledgedAt = op.updatedAt;
    persist();
    emit('status-changed', op);
  }

  function canPersistBody(op) {
    if (op.category !== 'data') return false;
    if (op.sensitivity !== 'public' && op.sensitivity !== 'normal') return false;
    if (op.body == null) return false;
    try { return JSON.stringify(op.body).length <= maxPersistedBodyBytes; } catch { return false; }
  }

  function persist() {
    if (!storage) return;
    try {
      const open = queue.filter((op) => OPEN_STATUSES.has(op.status));
      const visible = queue.filter((op) => op.status === 'failed' || op.status === 'conflicted').slice(-maxHistory);
      const ops = [...open, ...visible].map((op) => ({
        operationId: op.operationId,
        kind: op.kind,
        method: op.method,
        path: op.path,
        entityType: op.entityType,
        entityId: op.entityId,
        category: op.category,
        sensitivity: op.sensitivity,
        status: op.status,
        reasonCode: op.reasonCode,
        attempts: op.attempts,
        createdAt: op.createdAt,
        ...(OPEN_STATUSES.has(op.status) && canPersistBody(op) ? { body: op.body } : { bodyOmitted: op.body != null }),
      }));
      storage.setItem(storageKey, JSON.stringify({ version: 1, savedAt: now(), ops }));
    } catch { /* persistence is best-effort; the server ledger is the durable guarantee */ }
  }

  function restore() {
    if (!storage) return;
    let saved = null;
    try { saved = JSON.parse(storage.getItem(storageKey) ?? 'null'); } catch { saved = null; }
    if (!saved || saved.version !== 1 || !Array.isArray(saved.ops)) return;
    for (const record of saved.ops.slice(0, maxQueue)) {
      if (!record?.operationId) continue;
      const base = {
        operationId: record.operationId,
        kind: record.kind ?? 'unknown',
        method: record.method ?? 'post',
        path: record.path ?? '',
        body: record.body ?? null,
        entityType: record.entityType ?? 'record',
        entityId: record.entityId ?? null,
        category: record.category ?? 'data',
        sensitivity: record.sensitivity ?? 'normal',
        attempts: 0,
        createdAt: record.createdAt ?? now(),
        updatedAt: now(),
        reasonCode: record.reasonCode ?? null,
        restored: true,
      };
      if (OPEN_STATUSES.has(record.status)) {
        if (record.body != null) queue.push({ ...base, status: 'pending' });
        else queue.push({ ...base, status: 'failed', reasonCode: 'payload_not_restored' });
      } else {
        // failed/conflicted stay visible after a refresh so nothing silently disappears
        queue.push({ ...base, status: record.status, attempts: record.attempts ?? 0 });
      }
    }
  }

  function backoffMs(attempts) {
    const exponential = Math.min(baseBackoffMs * 2 ** Math.max(0, attempts - 1), maxBackoffMs);
    return Math.round(exponential * (0.5 + random() * 0.5));
  }

  function classifyFailure(op, error) {
    const status = error?.status;
    if (typeof status === 'number') {
      if (status === 409) { transition(op, 'conflicted', error.code ?? 'conflict'); return; }
      if (status !== 429 && status < 500) { transition(op, 'failed', error.code ?? `http_${status}`); return; }
    }
    // network error / timeout / 429 / 5xx — transient
    if (op.attempts >= maxAttempts) { transition(op, 'failed', 'max_retries_exhausted'); return; }
    op.nextAttemptAt = now() + backoffMs(op.attempts);
    transition(op, 'retrying', typeof status === 'number' ? `http_${status}` : 'network_error');
  }

  async function dispatch(op) {
    op.attempts += 1;
    try {
      const options = { operationId: op.operationId };
      const result = op.method === 'del'
        ? await dataClient.del(op.path, options)
        : await dataClient[op.method](op.path, op.body, options);
      // If the op reached a terminal state while the request was in flight
      // (e.g. cancelWhere during consent revocation), that decision stands —
      // a late result must never resurrect a cancelled operation.
      if (!OPEN_STATUSES.has(op.status)) return;
      op.replayed = result?.replayedOperation === true;
      transition(op, 'acknowledged');
    } catch (error) {
      if (!OPEN_STATUSES.has(op.status)) return;
      classifyFailure(op, error);
    }
  }

  function nextDispatchable() {
    // Strict FIFO: the first open op is the only candidate. If it is
    // retrying and not yet due, the whole queue waits — that ordering is
    // what makes "an old retry cannot overwrite a newer correction" true.
    const head = queue.find((op) => OPEN_STATUSES.has(op.status));
    if (!head) return { op: null, waitMs: null };
    if (head.status === 'retrying' && head.nextAttemptAt > now()) return { op: null, waitMs: head.nextAttemptAt - now() };
    return { op: head, waitMs: null };
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        const { op, waitMs } = nextDispatchable();
        if (!op) {
          if (waitMs != null && !wakeScheduled) {
            wakeScheduled = true;
            schedule(() => { wakeScheduled = false; void processQueue(); }, Math.max(1, waitMs));
          }
          return;
        }
        await dispatch(op);
      }
    } finally {
      processing = false;
    }
  }

  function pruneHistory() {
    const terminal = queue.filter((op) => TERMINAL_STATUSES.has(op.status));
    if (terminal.length <= maxHistory) return;
    const drop = new Set(terminal.slice(0, terminal.length - maxHistory).filter((op) => op.status === 'acknowledged' || op.status === 'cancelled').map((op) => op.operationId));
    for (let i = queue.length - 1; i >= 0; i -= 1) if (drop.has(queue[i].operationId)) queue.splice(i, 1);
  }

  function submit({ kind, method, path, body = null, entityType = 'record', entityId = null, category = 'data', sensitivity = 'normal' }) {
    if (category === 'biometric' || sensitivity === 'biometric') {
      throw new MutationQueueError('Biometric operations are never queueable — they must be explicit, direct, consent-checked requests.', 'biometric_operation_not_queueable');
    }
    const forbiddenKey = scanForForbiddenKeys(body);
    if (forbiddenKey) {
      throw new MutationQueueError(`Payload contains a biometric/raw-signal field ("${forbiddenKey}") and cannot enter the mutation queue.`, 'biometric_payload_rejected');
    }
    if (!['post', 'patch', 'del'].includes(method)) throw new MutationQueueError(`Unsupported method "${method}".`, 'unsupported_method');

    const op = {
      operationId: nextOperationId(),
      kind, method, path, body, entityType, entityId, category, sensitivity,
      status: 'pending', reasonCode: null, attempts: 0,
      createdAt: now(), updatedAt: now(),
    };

    if (queue.filter((o) => OPEN_STATUSES.has(o.status)).length >= maxQueue) {
      op.status = 'failed';
      op.reasonCode = 'queue_full';
      queue.push(op);
      persist();
      emit('rejected', op);
      return publicView(op);
    }

    if (kind === 'delete' && entityId) {
      cancelWhere((other) => other.entityId === entityId && (other.kind === 'create' || other.kind === 'update') && OPEN_STATUSES.has(other.status), 'superseded_by_delete');
    }

    queue.push(op);
    pruneHistory();
    persist();
    emit('submitted', op);
    void processQueue();
    return publicView(op);
  }

  function cancelWhere(predicate, reasonCode = 'cancelled') {
    let count = 0;
    for (const op of queue) {
      if (!OPEN_STATUSES.has(op.status)) continue;
      let matches = false;
      try { matches = Boolean(predicate(publicView(op))); } catch { matches = false; }
      if (matches) { transition(op, 'cancelled', reasonCode); count += 1; }
    }
    return count;
  }

  function retryFailed(operationId = null) {
    let count = 0;
    for (const op of queue) {
      if (op.status !== 'failed') continue;
      if (operationId && op.operationId !== operationId) continue;
      if (op.body == null && op.method !== 'del' && op.kind !== 'delete' && op.reasonCode === 'payload_not_restored') continue; // unrecoverable — the payload is gone
      op.attempts = 0;
      op.nextAttemptAt = 0;
      transition(op, 'pending', 'manual_retry');
      count += 1;
    }
    if (count) void processQueue();
    return count;
  }

  function status() {
    const byStatus = { pending: 0, retrying: 0, acknowledged: 0, failed: 0, conflicted: 0, cancelled: 0 };
    let oldestOpenAt = null;
    for (const op of queue) {
      byStatus[op.status] = (byStatus[op.status] ?? 0) + 1;
      if (OPEN_STATUSES.has(op.status) && (oldestOpenAt === null || op.createdAt < oldestOpenAt)) oldestOpenAt = op.createdAt;
    }
    return {
      label,
      ...byStatus,
      open: byStatus.pending + byStatus.retrying,
      total: queue.length,
      oldestPendingAgeMs: oldestOpenAt === null ? null : now() - oldestOpenAt,
    };
  }

  function list({ limit = 20, statuses = null } = {}) {
    const filtered = statuses ? queue.filter((op) => statuses.includes(op.status)) : queue;
    return filtered.slice(-Math.max(1, Math.min(limit, 100))).map(publicView);
  }

  /** Drains every currently-dispatchable op (test/simulation helper — production dispatch is schedule-driven). */
  async function flush() {
    await processQueue();
  }

  restore();
  if (queue.some((op) => OPEN_STATUSES.has(op.status))) void processQueue();

  return {
    submit,
    cancelWhere,
    retryFailed,
    status,
    list,
    flush,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
