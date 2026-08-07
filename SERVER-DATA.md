# Secure Server Persistence, Real-Time Agent State, and Sensitivity Enforcement

Durable memory and identity state moved from browser localStorage to a
server-owned, authenticated, SQLite-backed data layer. Tenant isolation,
sensitivity policy, consent, retention, deletion, and auditability are all
enforced server-side, before any record reaches the browser. This phase is
infrastructure and policy enforcement — **no real voice/facial recognition,
external services, device control, or unrestricted cloud audio/video
archival was implemented.**

## Architecture

```
Browser UI
    │
    ├── finalized transcripts (unchanged — Deepgram/segmenter)
    ├── current interaction state (unchanged — agent/runtime.js)
    └── authenticated repository requests (NEW — src/server/*)
                │
                ▼
      Authenticated Server Boundary (server/auth.mjs)
                │
     ┌──────────┼───────────┐
     │          │           │
Session API  Repository API  Provider routes (groqApi.js — unchanged)
(/api/session)(/api/data/...)
     │          │           │
     └──────────┼───────────┘
                ▼
      Authorization and Policy Layer (src/policy/sensitivity.js)
                │
     ┌──────────┼───────────┐
     │          │           │
Tenant scope  Sensitivity  Consent/retention
(hard, always)(evaluatePolicy)(consentRepository/retention.mjs)
     │          │           │
     └──────────┼───────────┘
                ▼
         Server Repositories (server/repositories/*.mjs)
                │
                ▼
         SQLite Database (server/db — node:sqlite)
                │
     ┌──────────┼─────────┐
     │          │         │
  Memory     Identity   Audit
  records     graph     records
```

The main agent, Context Compiler, Memory Writer, Memory Retriever, Entity
Resolver, Opportunity Engine, Speech Gate, Turn Manager, TTS, and playback
pipeline are **unchanged** — this phase only replaced *where durable state
lives* and added a policy-filtering pass between retrieval and context
assembly (see "Context Compiler enforcement").

## Database selection

**Chosen: SQLite via Node's built-in `node:sqlite` (`DatabaseSync`).**

Investigated before implementation: this repository has **no deployment
configuration of any kind** — no Dockerfile, no cloud/CI config, no
multi-instance orchestration. It runs as a single local `npm run dev`/`npm
run preview` process (`vite.config.js`'s `groqApiPlugin`/`dataApiPlugin`,
following the exact same in-process pattern already established for the
Groq/Deepgram/TTS proxy routes). This matches the phase spec's own criterion
exactly: *"SQLite is acceptable for a single-user local server
implementation if its limitations are documented and the repository
interface remains portable."*

`node:sqlite` (stable-enough/experimental-flagged in Node 24, the runtime
already in use here) was preferred over `better-sqlite3` because it requires
**zero new dependencies** — the smallest possible additive integration
point. It also provides an in-memory database (`:memory:`) out of the box,
which doubles as the deterministic test database every test file and both
simulation scripts use.

**Portability**: every repository in `server/repositories/*.mjs` uses only
parameterized SQL and standard types (TEXT/INTEGER/REAL) — no SQLite-only
syntax beyond `CREATE TABLE IF NOT EXISTS`. If this app ever gets a real
multi-tenant cloud deployment, **PostgreSQL is the documented next step**
(see "Current limitations") — the repository *interface* (not its SQL) is
what every consumer (Memory Writer, Retriever, Entity Resolver, coordinators)
depends on, so that swap would not require touching any consumer.

No vector database was added — retrieval stays keyword/structured
server-side and keyword/semantic (mock-embedder-only, honestly labeled)
client-side, exactly as MEMORY.md already documents; nothing here pretends
keyword retrieval is semantic vector search.

## Schema and migrations

`server/db/index.mjs` — `openDatabase({path|memory})` opens a connection and
runs `server/db/migrations/*.sql` in filename order, tracked in
`schema_migrations(version, applied_at)`. Idempotent: `CREATE TABLE IF NOT
EXISTS` + the migration ledger mean re-running on every server start is
always safe. `0001_init.sql` creates 17 tables: `workspaces`, `users`,
`sessions`, `interactions`, `memories`, `memory_source_links`, `people`,
`person_aliases`, `identity_evidence`, `relationships`,
`memory_entity_links`, `voice_profile_refs`, `consent_records`,
`retention_policies`, `audit_events`, `tombstones`, `operation_ids`.

Every application ID format is preserved as the TEXT primary key
(`mem_...`, `person_...`, `evidence_...`, `relationship_...`,
`session_...`) — no new surrogate keys were introduced.

**Design choice — normalized tables over denormalized JSON arrays for
identity data**: unlike the client-side localStorage repository (which
stores `person.aliases`/`voiceProfileIds`/`relationshipIds`/
`linkedMemoryIds`/`sourceEvidenceIds` as JSON blobs on the person row, kept
in sync by hand), the server schema makes `person_aliases`,
`voice_profile_refs`, `relationships`, `memory_entity_links`, and
`identity_evidence` **real foreign-keyed tables**, and
`identityRepository.getPerson()` derives those arrays via live `JOIN`
queries every read. This is what **structurally fixes** the known
`deleteBySource`-doesn't-unlink-identity gap: deleting a memory row
cascades (`ON DELETE CASCADE`) to remove its `memory_entity_links` rows
automatically, so there is no separate array to forget to update — see
`server/repositories/memoryRepository.mjs`'s doc comment and
`test/server-memory-repository.test.js`'s `deleteBySource` test.

## Authentication boundary

`server/auth.mjs` — provider-independent, two modes:

- **`development`** (default, `AUTH_MODE` unset or not `'production'`):
  every request resolves to a fixed, clearly-labeled deterministic principal
  (`DEV_PRINCIPAL_USER_ID`/`DEV_PRINCIPAL_WORKSPACE_ID`, default
  `dev_user`/`dev_workspace`). A `X-Roma-Dev-User`/`X-Roma-Dev-Workspace`
  header override exists **only** so tests/dev tooling can simulate a
  second tenant — never accepted outside development mode. The server logs
  a warning on startup: *"This is NOT production authentication."*
- **`production`** (`AUTH_MODE=production`): requires a `Bearer` token and a
  configured `verifyToken` callback. **No real token verifier exists in this
  codebase** (no IdP/login flow) — with none configured, every request
  fails closed with `401 auth_not_configured`. This is the honest,
  documented remaining requirement: a real production auth phase (OAuth/
  session cookies/JWT verification against a real identity provider) must
  be added before this app is exposed to untrusted users.

`stripClientOwnership()` deletes any `workspaceId`/`userId` field a request
body might carry **before** it reaches a repository call — every route uses
only the authenticated `principal` from `resolvePrincipal()` for ownership,
never anything the browser sent (verified in
`test/server-api-integration.test.js`'s ownership-override test).

## Tenant and workspace isolation

Every table carries `workspace_id` (most also `user_id`), and every
repository method is scoped via `forWorkspace(workspaceId, userId)` —
**there is no method on any server repository that accepts a workspace ID
from outside that closure.** A record ID alone never grants access: `get()`/
`getPerson()`/etc. all filter by `workspace_id = ?` in the SQL itself, so a
correct ID guessed against the wrong tenant returns `null`/404, identical to
a truly nonexistent ID (never distinguishable — see
`test/server-api-integration.test.js`).

## Repository providers

`server/repositories/{memoryRepository,identityRepository,auditRepository,
consentRepository,sessionRepository}.mjs` — SQLite-backed, implementing the
**exact same interface** the existing client repositories already exposed
(reusing `src/memory/schema.js`'s `validateMemory` and
`src/identity/schema.js`'s `validatePerson`/`validateEvidence`/
`validateRelationship` directly — no duplicated validation logic).

**Client-side ("browser") repository providers** — three tiers, chosen by a
startup `/api/data/health` check (mirrors the existing `useAgent.js` health-
check-swap pattern):

1. **`server`** (default/optimistic) — `src/server/{remoteMemoryRepository,
   remoteIdentityRepository}.js`. See the important architectural note
   below.
2. **`localStorage-dev-fallback`** — only in `import.meta.env.DEV`, only
   when the server is unreachable, clearly labeled in the Server Data panel.
3. **`unavailable`** (production, server unreachable) —
   `createUnavailableMemoryRepository()`/`createUnavailableIdentityRepository()`:
   every mutation fails with a clear error, every read returns empty.
   **Production never silently falls back to localStorage or an
   in-memory-only store** — this satisfies "must not silently write
   sensitive records to localStorage" by refusing to write anywhere durable
   at all when the server is down, and saying so loudly in the UI.

**Why the client-side repository is still synchronous (honest limitation)**:
`src/memory/writer.js`/`retriever.js` and `src/identity/resolver.js` call
every repository method **synchronously** (no `await`) — by design, per this
phase's explicit instruction not to redesign the Memory Writer/Retriever/
Entity Resolver. A raw async-fetch-based repository would silently return
Promises where callers expect real values. The client-side "server-backed"
repository therefore wraps a plain **synchronous local mirror** (the exact
same `createInMemoryRepository()`/`createInMemoryIdentityRepository()` used
by every existing test) — hydrated from the server once on load
(`GET /api/data/memory/export` / `GET /api/data/identity/export`), and every
local mutation is *also* fired to the server in the background
(fire-and-forget, logged on failure). **The server is authoritative for
durability** (a reload/restart/second browser re-hydrates from SQLite, never
from anything the browser itself persisted) — but a write that fails to
reach the server before the tab closes is not yet guaranteed exactly-once
from the client's perspective (no offline mutation queue in this phase; see
"Current limitations").

Deterministic **in-memory** providers (`createInMemoryRepository()`/
`createInMemoryIdentityRepository()`) are unchanged and still required for
tests — nothing was removed.

## LocalStorage migration

Explicit, user-controlled, never automatic — only runs from the Server Data
panel's buttons (`src/useServerData.js` + `src/server/migrationClient.js`).

1. **Detect**: `detectLegacyRecords()` reads the four legacy localStorage
   keys (`roma.memories`, `roma.people`, `roma.people.evidence`,
   `roma.people.relationships`) — read-only, no server call.
2. **Dry run**: `POST /api/migration/dry-run` →
   `server/migration/localStorageImport.mjs`'s `planMigration()` — validates
   every record with the SAME schema validators used everywhere else,
   classifies each as `valid`/`duplicate`/`malformed` (against what's
   already on the server), returns bounded counts + a capped preview
   (`{id, status, reason}` only — never a full sensitive payload dump).
   Nothing is written.
3. **Import**: `POST /api/migration/import` with a client-generated
   `operationId` → `applyMigration()` — imports people first (so memory
   `speakerEntityId`/`subjectEntityIds` FK-link correctly), then evidence,
   then relationships, then memories; **preserves every original ID**
   (`memoryId`/`personId`/`evidenceId`/`relationshipId` pass straight
   through to `create()`, which accepts an explicit ID); a record whose ID
   already exists is skipped, never duplicated — verified idempotent both
   for a *repeated* `operationId` (replays the cached ledger result) and a
   *different* `operationId` on the same data (record-ID-level dedup).
4. **Verify**: the import result includes `verify.memoriesPresent`/
   `peoplePresent` counts, shown in the panel before any local cleanup is
   offered.
5. **Clear local records**: `clearLegacyRecordsAfterVerification()` — only
   enabled in the UI once `migrationResult.verify` exists; a partial or
   failed migration **never** triggers this automatically.

## Server session state

`server/repositories/sessionRepository.mjs` — bounded fields only (per the
spec's list: active interaction/turn IDs, resolved speakers, engagement
state, active goals, cancellation generation, last-accepted transcript
sequence, tool/retrieval/memory-write/identity-resolution operation ID
lists, current speech-authorization reference, `expiresAt`). **No raw
unrestricted conversation history is ever stored here** — the bounded
transcript window stays exactly where it already lived, inside
`agent/runtime.js`, unchanged.

### Optimistic concurrency

Every `sessions` row carries a `version` integer. `update(sessionId, patch,
expectedVersion)` rejects (`{ok:false, reasonCode:'stale_version'}`) unless
`expectedVersion` matches the current row's version, incrementing on every
successful write. This is what makes "a late tool/memory/retrieval/identity
result cannot overwrite newer state" a real guarantee, not just a comment —
proven directly in `test/server-session.test.js` (four distinct staleness
scenarios) and `scripts/simulate-server-state.mjs` (steps 15-17).

Sessions expire (`expiresAt`, default 1 hour of inactivity); `expireStale()`
is an **explicit, callable** cleanup (see "Retention and expiration" — no
background timer). Restart behavior: sessions are file-durable (SQLite) but
**not resumed automatically** — a new `beginSession()` always starts a
genuinely new session/session ID (matching the existing identity-phase rule
that `Speaker 0` in one session is never assumed to be `Speaker 0` in
another).

## Sensitivity levels

`src/policy/sensitivity.js`'s `SENSITIVITY_LEVELS`: `public`, `normal`,
`private`, `sensitive`, `biometric`, `secret` — an ordered axis, entirely
independent of `importance` (how useful) and `confidence` (how likely to be
correct). A high-confidence, high-importance record can still be `secret`.
Existing memory/identity/relationship records default to `'normal'`
(unchanged from the prior two phases); no data migration was needed since
the value spaces are compatible supersets.

## Policy rules

`evaluatePolicy({action, resource, principal, context})` → `{decision,
action, resourceId, sensitivity, principalId, workspaceId, reasonCode,
redactions, policyVersion}`. Outcomes: `allow`, `allow_redacted`, `deny`,
`require_confirmation`, `require_recent_authentication`, `unavailable`.

Deterministic rules, in order:
1. **Cross-tenant access is always denied** — checked before anything else,
   for every action/sensitivity.
2. **`speech.deliver`** is evaluated *separately* from context-compile
   approval: `sensitive`/`biometric`/`secret` content requires
   `context.explicitEligible` regardless of whether it was already allowed
   into the prompt — speech still goes through the **existing, unchanged**
   Speech Gate on top of this.
3. **`admin.workspace_delete`** requires `context.recentAuthAt` within a
   15-minute window (`require_recent_authentication` otherwise).
4. **`secret`**: denied for every "broad" action (context-compile, search,
   log, relationship traversal, proactive suggestion, export) — allowed only
   for direct owner CRUD (create/read/update/delete by ID).
5. **`biometric`**: denied for context-compile/search/log/proactive; a
   biometric-provider operation (enroll/compare/identify/delete) requires
   `context.consentActive !== false`; a metadata *read* is `allow_redacted`
   (never the raw sample/template); direct owner CRUD otherwise allowed.
6. **`sensitive`**: proactive context-compile is always denied (stricter
   than direct recall); direct/authenticated context-compile requires
   relevance ≥ 0.6 and `context.confirmed`, else `require_confirmation`.
7. **`private`**: context-compile requires relevance ≥ 0.35 (≥ 0.6 if
   proactive — again, proactive is strictly stricter); otherwise allowed for
   direct owner access.
8. **`public`/`normal`**: ordinary allow.

Prompt injection cannot change any of this: `evaluatePolicy` only ever reads
the literal `sensitivity` enum value and structural context fields (`
relevance`, `confirmed`, `isProactive`, `consentActive`) — it never parses
record text, and unrecognized/forged context fields (e.g. a tool call
claiming `{authorized: true}`) have no effect (verified in
`policy-sensitivity.test.js`). Model tool calls are requests, never
authorization decisions — only this deterministic function decides.

## Context Compiler enforcement

Required order — retrieve → verify tenant ownership → sensitivity decision
→ redact/exclude → token budgeting → Context Compiler → main agent — is
implemented as:

- **Server-side** (hard boundary, cannot be bypassed by any client code):
  every data-API route scopes by `workspace_id` in SQL and, for
  broad/export/search routes, additionally runs `filterBySensitivity()`
  before the HTTP response is even sent — a `secret`/`biometric` record
  never leaves the server in an ordinary search/export response.
- **Client-side** (defense in depth, and the literal "before Context
  Compiler assembly" hook this app's architecture requires, since Context
  Compiler/`assembleContext()` is client-side code by this app's existing
  design): `src/agent/runtime.js`'s `applyContextPolicy()` — a new, purely
  additive step in `inferDecision()` — runs `filterBySensitivity()` again
  over `relevantMemories` and the resolved speaker's `relationships`
  **immediately before** `assembleContext()`. With no `policy.principal`
  configured (existing tests, simulations, and any caller that doesn't pass
  one), this step is a complete no-op — zero behavior change, matching every
  prior phase's "additive, optional dependency" pattern.

Denied records are **dropped entirely**, never compiled with a note asking
the model to ignore them. The model never sees a policy-decision object, a
resource's sensitivity level, or the reason it wasn't included.

## Consent

`server/repositories/consentRepository.mjs` — `grant({personId, scope,
purpose, provider})`/`revoke(consentId)`/`isActive(personId, scope)`.
Revoking a consent record additionally **freezes** (never deletes) every
`voice_profile_refs` row created under it
(`identityRepository.revokeVoiceProfile()` sets `revoked_at`) — so a
revoked consent immediately and permanently disables that profile for
future biometric-provider operations, verified in
`test/server-consent.test.js` and simulated in
`scripts/simulate-server-state.mjs` (steps 18-20).

## Biometric-readiness boundaries

`voice_profile_refs` is a **separate, independently-referenced** table from
`people` — a person's `voiceProfileIds` are derived via `JOIN`, never a
column a general person-update accidentally touches.
`identityRepository.recordVoiceProfile()`/`getVoiceProfileRef()` are the
only writes/reads. No raw audio, embeddings, or biometric templates are
columns anywhere in this schema — only opaque `voiceProfileId` strings and
non-biometric metadata (`provider`, `providerModel`, `quality`,
`consentId`, timestamps). This matches IDENTITY.md's existing finding: **no
real voice-identity provider exists in this environment** (no bounded
raw-audio-sample pipeline — unchanged this phase); this phase only prepared
the *storage and consent* boundary a future real provider would need.

## Retention and expiration

`server/repositories/retention.mjs`'s `runRetentionCleanup()` — **explicit,
callable, deterministic, idempotent** (never a background timer, per the
spec's own instruction): expires stale sessions
(`sessionRepository.expireStale()`), soft-retires provisional people with no
recent observation **and no linked memories/relationships** (real value is
never auto-expired), and removes stale unresolved identity evidence past a
configurable age. Exposed as `POST /api/retention/cleanup` and the Server
Data panel's "Run retention cleanup" button; also exercised directly in
`scripts/simulate-server-state.mjs`.

## Deletion and tombstones

- **Soft delete** (`memoryRepository.softDelete()`) — sets `deleted_at`; the
  row stays (inspectable, recoverable) but is excluded from every normal
  read. Used only by retention cleanup.
- **Hard delete** (`memoryRepository.delete()`) — the row is physically
  removed inside a transaction, dangling `supersedes`/`superseded_by`/
  `contradicts` references on other memories are cleaned up, and FK cascade
  removes `memory_entity_links`. Used for explicit user-driven forgetting.
- Both record a `tombstones` row with `deletion_kind: 'soft'|'hard'` — the
  two are always distinguishable (`test/server-memory-repository.test.js`).
- **`deleteBySource`** — hard-deletes every memory from an interaction; per-
  memory FK cascade means identity links are cleaned up for **every**
  affected memory automatically (the structural fix — see "Schema and
  migrations" above). The **client-side** repository had a parallel gap
  (the emitted `memory-deleted-by-source` event only carried a count, not
  which memories were removed, so `identity/coordinator.js`'s
  `attachMemoryLifecycle` — which only listened for single `memory-deleted`
  events — could never unlink a bulk deletion). Fixed additively:
  `memory/coordinator.js`'s `deleteBySource` now captures the affected
  `memoryIds` before deleting and includes them on the event;
  `attachMemoryLifecycle` now handles both event types
  (`test/server-client-deletebysource.test.js`).
- **Workspace deletion** (`server/repositories/deletion.mjs`) —
  `planWorkspaceDeletion()` (read-only impact counts across 11 tables) →
  `deleteWorkspace({confirm, operationId})` (requires both; transactional;
  records a tombstone + audit event; **verifies** zero records remain
  retrievable afterward before reporting success).
- Deleting a person never cascades to unrelated memories; deleting a memory
  never cascades to unrelated people — both verified directly.

## Audit events

`server/repositories/auditRepository.mjs` — **append-only** (`record()` and
`list()`/`countByOutcome()` are the only methods; no update/delete exists at
all, verified in `test/server-audit.test.js`). Every consequential mutation
route calls `audit()` with principal, action, resource type/ID, operation
ID, outcome, reason code, sensitivity, and a `redacted` flag — **never**
memory/person summary text, transcript content, audio, secrets, or
biometric material. Audited: create/update/delete (memory, person,
relationship), merge, split, correction (supersede), consent grant/revoke,
voice-profile enroll/delete, migration import, retention cleanup, workspace
deletion, and every policy `deny` outcome (so denials are inspectable
without ever exposing what was denied).

## Encryption and secret management

- **TLS**: required for any real (non-`localhost`) deployment — this app has
  no deployment target today (see "Database selection"), so this is
  documented as a requirement, not implemented infrastructure.
- **Database credentials**: none exist — SQLite is a local file, opened
  directly by the same Node process that already holds `GROQ_API_KEY`/
  `DEEPGRAM_API_KEY`/`TTS_API_KEY` (`server/env.mjs`, unchanged). No new
  connection string, host, or password was introduced.
- **No `VITE_`-prefixed data-API secrets** exist (there's nothing to expose
  — dev auth needs no secret, and production auth's `verifyToken` is a
  server-side-only callback). Verified via `test/server-security.test.js`
  and a bundle scan (`grep -rl node:sqlite dist` → no matches).
- **Log redaction**: audit records never carry content, only IDs/reason
  codes; server route error responses relay only `error.message` (already
  the existing pattern from `groqApi.js`), never a stack trace or raw SQL.
- **Encryption at rest**: not implemented — SQLite's file is unencrypted on
  disk, as is appropriate for local single-user development. Production use
  would require OS/disk-level encryption or SQLite's encryption
  extensions — an infrastructure decision, not something to fake at the
  application layer.
- **No homemade cryptography** was written. No field-level application
  encryption was implemented in this phase (no clear key-management design
  exists yet — see "Current limitations"); nothing claims otherwise.

## API design

`server/routes/dataApi.mjs` — ~35 authenticated JSON routes (memory/people/
evidence/relationships CRUD+search, session, consent, migration, retention,
audit read, workspace admin). Every route: validates via the schema
validators (never raw SQL/query-language from the browser), caps list
results (`MAX_LIST_LIMIT = 200`, default 50), strips client-supplied
ownership fields, and returns bounded/generic error bodies (no stack
traces). Mutation routes accept an `operationId` where duplication risk is
real (migration import, workspace deletion) — tracked in an
`operation_ids` idempotency ledger. No route accepts arbitrary
browser-supplied SQL filters or exposes an unrestricted dump — `GET
/api/data/memory/export` still goes through the full sensitivity-policy
pass, and `GET /api/audit` is explicitly gated to development mode only.

## Rate limiting

`server/routes/dataApi.mjs`'s `createRateLimiter()` — an in-process sliding-
window counter (120 req/10s general, 40 req/10s for mutations), sufficient
for a single local dev/preview server process. A real multi-instance
deployment would need a shared store (Redis or equivalent) — documented,
not implemented, since no such deployment exists yet.

## Development UI

The **Server Data panel** (`src/main.jsx`'s `ServerDataPanel` +
`src/useServerData.js`, dev-only, collapsible) shows: active repository
provider per subsystem (memory/identity), auth mode + principal (dev mode
only), legacy-record counts awaiting migration, migration dry-run/import
controls with a plan/report summary, retention-cleanup trigger, a redacted
recent-audit-events list, and a workspace-deletion danger zone
(preview-impact → confirm). No secrets, database paths, tokens, raw
biometric material, or hidden prompts are ever rendered.

## Tests

98 new tests were added in this phase across 10 files (`test/server-db`,
`server-memory-repository`, `server-identity-repository`, `server-auth`,
`policy-sensitivity`, `server-consent`, `server-session`,
`server-migration`, `server-retention-deletion`, `server-audit`,
`server-api-integration`, `server-security`,
`server-client-deletebysource`). The full offline suite is **562 tests**
as of the 2026-07 stabilization pass (`npm test`).

## Simulation

`npm run simulate:server-state` (`scripts/simulate-server-state.mjs`) — 3
parts: (1) authenticated session → migration dry-run/import/re-import →
policy decisions across every sensitivity level → cross-tenant/guessed-ID
denial → session staleness (3 distinct late-result scenarios) → consent
grant/revoke → `deleteBySource` + reference cleanup → retention cleanup →
audit; (2) a real file-backed database reconnect (server-restart
persistence); (3) a real HTTP server (the actual route handlers) plus the
real agent runtime proving no operation bypasses the Speech Gate.
**28/28 checks pass.**

## Live verification

See the final report for the exact steps executed against the real dev
server (real Groq inference, real Deepgram TTS, real SQLite file database)
through the existing finalized-transcript harness — physical microphone
access remains unavailable in this environment, exactly as in every prior
phase.

## Deployment requirements

Before any real (non-local, multi-tenant, internet-facing) deployment:
1. A real production authentication provider (OAuth/session/JWT
   verification) wired into `server/auth.mjs`'s `verifyToken`.
2. TLS termination in front of the server process.
3. PostgreSQL (or an equivalent managed SQL database) if more than one
   server instance/region is needed — SQLite is a single-file, single-writer
   database.
4. A shared rate-limit store if running more than one server instance.
5. Disk/volume-level encryption at rest for the database file.
6. A real biometric provider integration (still explicitly out of scope)
   plus the sensitivity-enforcement layer this phase built being extended to
   cover it.

## Stabilization update (2026-07): reliable browser/server synchronization

The fire-and-forget limitation below was closed by the release-stabilization
phase. Every server write from the browser now goes through a **reliable
mutation queue** (`src/server/mutationQueue.js`, wired in `useMemory.js`/
`usePeople.js`):

- Every mutation carries a stable operation ID (`X-Roma-Operation-Id`);
  the server's tenant-scoped idempotency ledger (`operation_ids`, composite
  primary key since migration `0003_sync_reliability` — the single-column
  key before it allowed cross-tenant clobbering) replays the recorded
  response for a duplicate, so retries create exactly one record.
- States pending → acknowledged / retrying / failed / conflicted /
  cancelled are visible in the Server Data panel; nothing is reported
  durable before server acknowledgement.
- Strict FIFO with bounded exponential backoff + jitter, bounded attempts,
  bounded queue size; a permanent failure stays visible with a
  deterministic reason code and a manual retry control.
- Submitting a delete cancels still-queued creates/updates for that entity,
  and the server refuses to recreate a tombstoned record (409
  `record_deleted`) — delayed writes cannot resurrect deletions.
- Biometric operations are never queueable; consent revocation and voice-
  profile deletion cancel pending profile-reference mutations first; the
  biometric `/api/voice` routes are deliberately excluded from idempotent
  replay so a cached success can never mask revoked consent.
- Only bounded queue metadata is persisted for refresh recovery; bodies are
  persisted only for public/normal-sensitivity data mutations under a size
  cap — anything else is restored as a visible `payload_not_restored`
  failure, never silently dropped and never written to unsafe storage.
- `GET /api/preflight` + the in-app/CLI preflight (`npm run preflight`)
  report subsystem states (never secrets).

Covered by `test/sync-reliability.test.js` (21 tests) and
`npm run simulate:recovery` (20 checks, real HTTP + file-backed SQLite +
real server interruption/restart).

## Current limitations

- No real production authentication provider exists — `AUTH_MODE=production`
  fails closed today, honestly, rather than working.
- SQLite is single-writer/single-file — fine for this app's actual (local,
  single-user) deployment shape today, not for a scaled multi-instance one.
- No field-level application encryption (no key-management design yet).
- Rate limiting is in-process only (not shared across instances).
- The client-side sensitivity-policy pass is defense-in-depth, not a hard
  boundary by itself (the hard boundary is server-side tenant scoping +
  server-side `filterBySensitivity` on broad/export routes).
- `GET /api/audit` is development-only; no production audit-read API exists
  yet (would need its own access-control policy, deliberately deferred).
