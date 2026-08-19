# Entity Resolution, Voice Identity, and Relationship Graph

Roma maintains a stable internal record for each known person and resolves new
observations against those records using auditable evidence — without
pretending uncertain biometric matches are confirmed identities. This module
lets Roma associate transcripts, memories, voice evidence, names, and
relationships with stable person records, while diarized speaker labels
(`Speaker 0`, `Speaker 1`, …) remain transient and are never themselves
treated as verified identities.

Facial recognition is **not implemented** in this phase. Schema/provider
extension points exist so it can be added later without redesigning the
Person Repository (see "Facial-recognition extension points").

## Architecture

```
Finalized transcript
    + transient diarized speaker label
    + bounded voice sample reference (tests/simulation only — see
      "Provider limitations")
    + explicit naming statements (identity tools)
    + existing person records
                │
                ▼
      Entity Resolver (src/identity/resolver.js)
   ┌─────────┼─────────┐
   │         │         │
resolved   ambiguous   unknown
   │         │         │
   ▼         ▼         ▼
Stable     Candidate   Provisional
personId    matches     entity
   │
   ▼
Person Repository (src/identity/repository.js)
   ├── aliases
   ├── identity evidence
   ├── voice profiles (opaque references only)
   ├── relationships
   ├── linked memories
   └── merge/split history
                │
                ▼
   Existing Context Compiler (agent/prompt.js:
   CURRENT SPEAKER / RELEVANT RELATIONSHIPS)
                │
                ▼
        Existing main agent
   → Intervention Policy where applicable
   → Speech Gate → Turn Manager → TTS → Playback
```

Identity resolution only ever feeds the Context Compiler. It never triggers
speech, never bypasses the Speech Gate, and never mutates the Inspector, Live
Scene State, main agent decision schema, Opportunity Engine, Intervention
Policy, Turn Manager, or existing memory architecture.

## Files

```
src/identity/
  schema.js       — Person / Identity Evidence / Relationship schemas + validation
  repository.js   — Person Repository (in-memory + localStorage providers)
  voiceProvider.js— voice-identity provider interface + deterministic/unavailable implementations
  resolver.js     — Entity Resolver: deterministic thresholds, session continuity, explicit operations
  tools.js        — 16 identity/relationship tools, registered into the SAME agent tool registry as memory
  coordinator.js  — top-level API + event bus + memory relinking + merge/split/delete orchestration
  config.js       — storage key, session timeout, voice provider mode

src/usePeople.js  — React hook wiring the coordinator (mirrors src/useMemory.js)
scripts/simulate-identity.mjs — end-to-end simulation (npm run simulate:identity)
test/identity-*.test.js       — 100 tests across schema/repository/resolver/voiceProvider/coordinator/tools/context/agent-integration/security
```

Modified, additively:
- `src/memory/schema.js` — four optional entity-link fields on a memory record (see "Memory linking and relinking"). Fully backward compatible; no schema version bump needed.
- `src/agent/prompt.js` — `CURRENT SPEAKER` / `RELEVANT RELATIONSHIPS` sections, added the same way `RELEVANT MEMORIES` was added.
- `src/agent/runtime.js` — passive per-turn speaker resolution (bounded, cached once per turn), identity tool registration hook, bounded post-write memory relinking. Also fixes a latent bug: the runtime's session ID is now recomputed in `beginSession()` instead of being frozen at construction time.
- `src/useAgent.js`, `src/main.jsx` — wiring + the dev-only People panel.

## Person schema

`src/identity/schema.js`'s `validatePerson()` — see the file for full bounds.
Key fields: `personId`, `schemaVersion`, `entityType: 'person'`, `displayName`,
`status` (`active | merged | deleted` — record lifecycle), `identityStatus`
(`provisional | candidate | confirmed | disputed | merged | deleted` —
confidence/dispute state, distinct from `status`), `aliases[]` (each with
`alias`, `normalizedAlias`, `type`, `confidence`, `sourceEvidenceIds`),
`roles[]`, `attributes{}`, `voiceProfileIds[]` (opaque references only),
`faceProfileIds[]` (reserved, always empty in this phase), `relationshipIds[]`,
`linkedMemoryIds[]`, `confidence`, `sensitivity`, `createdAt/updatedAt/lastObservedAt`,
`mergedInto`, `supersedes[]`, `sourceEvidenceIds[]`.

## Identity evidence schema

`validateEvidence()` — every identity decision is backed by an inspectable,
separately-stored evidence record: `evidenceId`, `evidenceType`, `personId`,
`speakerLabel`, `sessionId/interactionId/turnId/transcriptIds`,
`voiceSampleRef` (opaque reference), `provider/providerModel`,
`score/confidence/quality`, `decision`, `reasonCode`, `confirmedBy`,
`createdAt/expiresAt`, `sensitivity`.

Evidence types, ordered **lowest to highest authority**
(`identityEvidenceRank()`): `memory_context`, `relationship_context`,
`name_mention`, `diarization_continuity`, `tool_verified_identity`,
`face_match`, `face_enrollment`, `explicit_self_identification`,
`voice_match`, `voice_enrollment`, `explicit_user_attribution`,
`manual_confirmation`, `manual_rejection`, `correction`. A correction can only
invalidate a resolution whose own evidence rank is no higher — this is
enforced in code (`resolver.js`), not left to model judgment.

Evidence is kept **separate** from the final identity decision (the person
record), so a correction never destroys history — it adds new evidence and
updates the record; old evidence stays inspectable via
`showIdentityEvidence()`.

## Stable person IDs versus transient speaker labels

Strict distinction, enforced throughout:
- `speakerLabel` — transient diarization label (`Speaker 0`). Deepgram
  diarization in this app produces **only numeric speaker indices**, never
  named voice recognition (verified in the audio pipeline — see "Provider
  limitations").
- `personId` — stable internal identity (`person_<ts>_<n>`).
- A `speakerLabel` is **never** converted directly into a verified `personId`.
  A name mentioned in conversation does not prove the current speaker has
  that name (`name_mention` evidence is `context_only`, never identifies the
  current speaker — see `resolver.js`'s `detectKnownNameMentions`, which only
  matches names already known to the repository).

## Entity-resolution pipeline

`src/identity/resolver.js`'s `resolve()` runs **passively**, once per turn
(see "Context Compiler integration" for why it is capped to once), combining
in order:
1. **Bounded within-session continuity** — `(sessionId, speakerLabel) →
   personId`, reused while evidence stays consistent, invalidated on
   timeout/session-end/correction/merge/split. `Speaker 0` in one session is
   never assumed to be `Speaker 0` in another (keyed by session, not label
   alone).
2. **Voice match** (only if a sample happens to be supplied — see "Provider
   limitations": never populated automatically in the live app today).
3. **Passive name-mention** — matched only against already-known aliases,
   recorded as `context_only` evidence, never identifies the speaker.

**Explicit operations** (one per identity tool — see "Explicit identity
operations") always run to completion and are the only paths that
create/confirm/reject a person record: `attribute`, `selfIdentify`,
`confirmMatch`, `rejectMatch`, `correctIdentity`.

Deterministic code — never the model — controls candidate eligibility,
thresholds, confirmation requirements, conflict handling, record creation,
merging, splitting, and final application. The model only supplies which
name/person/relationship a request is about, via ordinary tool-call
arguments (validated by the same `agent/tools.js` registry every other tool
uses).

## Confidence and confirmation policy

`RESOLUTION_THRESHOLDS` (`resolver.js`): `strongVoiceMatch: 0.85`,
`mediumVoiceMatch: 0.55`, `ambiguousMargin: 0.1`, `minVoiceQuality: 0.5`.

- Explicit primary-user attribution (`"That was Matt"`) may confirm a person
  outright — highest non-correction authority.
- A voice match `>= strong` with adequate quality AND a margin `>= 0.1` over
  the next candidate resolves automatically.
- A voice match in `[medium, strong)`, or two candidates within the
  ambiguity margin, produces `ambiguous`/`candidate` evidence — **never**
  silent resolution.
- Self-identification (`"This is Matt speaking"`) creates evidence but stays
  `provisional`, requiring confirmation — it never sets session continuity by
  itself.
- A rejected match becomes negative evidence (`manual_rejection`) tracked
  per `(session, speakerLabel)`, so the same suggestion is not immediately
  repeated.
- Manual correction (`correction` evidence type) outranks any earlier
  inference or automatic match.
- Same-name people are **never** merged automatically — `attribute()`
  against two existing same-name people returns `ambiguous` and creates
  nothing.
- Within-session continuity means a confirmed identity is **not** re-asked
  every turn — it's reused until conflict/timeout/correction.

## Provisional people

Created only from an explicit operation with real signal (self-identification,
or find-or-create during attribution). **Never** created from: background
speech with no name, TV/recorded voices, Roma's own TTS, brief incidental
speech, unclear overlapping audio, or a bare unconfirmed name mention (see
`resolver.js`'s passive-resolution guardrails, tested in
`identity-resolver.test.js`). Provisional people are never auto-promoted to
`confirmed` merely by repetition — only `confirmMatch`, `attribute` (unique
match), or `correctIdentity` change `identityStatus`.

## Naming and aliases

`update_person` / `updatePerson()` renames a person while keeping the old
name as an alias (never discarded). `removeAlias()` removes only the alias,
never the person. Distinguishes:
- Self-identification vs. attributing someone else — via the
  `name_current_speaker` tool's `self` flag, resolved deterministically
  against `context.speaker` vs. `context.previousSpeaker` (the most recent
  *different* speaker in the transcript window) — never by model judgment
  alone about who "that" refers to; the application code decides which
  session/speaker slot the naming applies to.
- Two different people sharing a name — `findByName()` returning >1 match
  always yields `ambiguous`, never an automatic merge.

## Voice enrollment

Explicit and auditable only. `enroll_voice` tool / `coordinator.enrollVoice()`
requires `consent: true` (no enrollment happens without it), captures only a
bounded sample reference + metadata (`durationMs`, `quality`, `speakerPurity`
— never raw audio), validates duration/quality/speaker-purity, rejects
low-quality or overlapped samples, and **never enrolls Roma's own TTS
playback** (`isPlayback` flag rejected at the provider level as
defense-in-depth). Consent is never inferred from ambient conversation — it
is a required explicit boolean on every enrollment call. Only a
provider-side opaque `voiceProfileId` reference and non-biometric metadata
(quality, consent, provenance, provider name) are stored on the person
record.

## Voice matching

`compare()` / `identify()` on the configured voice-identity provider, scored
against `RESOLUTION_THRESHOLDS` above. Every result carries
`provider`/`providerModel` metadata and a `score` + `quality`, never a bare
boolean — application code, not the provider, decides what a score means.

## Real and deterministic voice providers, and provider limitations

**Investigated before writing any provider code** (see the audio pipeline
inspection at the start of this phase): `src/audio.js` streams PCM16 frames
directly over a WebSocket to Deepgram (`server/deepgramProxy.mjs`) — the
browser never buffers or retains raw audio. Deepgram's diarization returns
only numeric speaker indices (`src/engine/segmenter.js`'s `speakerLabel()`),
never named voice recognition. `server/groqApi.js` is an explicitly stateless
proxy with **no database or file persistence** of any kind.

**Conclusion: a real voice-identity provider is not responsibly supportable
in this environment today.** Building one would require either fabricating
audio capture that does not exist, or inventing a recognition signal from
transcript text/speaker labels — both explicitly out of scope. Per this
phase's own contingency plan, the module ships:
- The full provider-independent **interface** (`enroll/compare/identify/
  deleteProfile/getProfileMetadata/getProviderStatus`) — a future real
  server-side provider only needs to satisfy this shape.
- `createDeterministicVoiceProvider()` — repeatable, documented,
  fixture-based (a sample's `matchKey` is an explicit test label, never a
  derived biometric feature), exercising every required scenario (strong/
  weak/ambiguous/no match, low quality, overlap, playback exclusion,
  consent, cancellation, deletion).
- `createUnavailableVoiceProvider()` — what production actually gets wired
  to (`identityConfig.voiceProviderMode` defaults to `'unavailable'`). Every
  operation honestly reports why, with a citation to this section, rather
  than silently behaving like a mock while claiming to be real.

The live app therefore **never** automatically supplies a `voiceSampleRef`
to the passive resolver (`runtime.js` hardcodes it to `null`, with an inline
comment explaining why) — voice matching is exercised only in tests,
simulation, and (opt-in, clearly labeled "deterministic test enrollment, not
real biometric capture") the dev People panel's Enroll Voice button.

## Merge behavior

`mergePeople()` (repository + coordinator): selects a target, preserves
aliases/evidence/voice-profile-refs/memory-links/relationships under the
target, marks sources `status: 'merged', identityStatus: 'merged',
mergedInto: targetId` (never deleted), avoids duplicating an equivalent
relationship edge (leaves the source's edge as historical instead), and
invalidates any cached resolver continuity pointing at a merged-away source
(`resolver.invalidateForPerson`). `listEvidenceForPerson()` traverses the
merge chain (`supersedes`), so merge history stays inspectable through the
canonical target. Automatic merge is never triggered by voice similarity or
name similarity alone — only an explicit `merge_people` operation merges.

## Split behavior

`splitPerson()` moves **only** the explicitly-named alias texts / voice
profile IDs / evidence IDs / relationship IDs / memory IDs into a new (or
existing) target person; everything not listed stays with the source — no
guessing. Confidence on both halves is reduced (`× 0.9`) to reflect the
correction. The coordinator invalidates cached resolver continuity for both
the source and the target after a split.

## Correction and negative evidence

`correctIdentity()` (resolver) invalidates the earlier session/speaker
resolution, records `manual_rejection` for the old person for that slot (so
it isn't immediately re-suggested), records `correction` evidence for the
new one, and re-resolves via find-or-create. `correct_relationship`
supersedes (never silently deletes) a relationship edge, same pattern as
memory's correction.

## Relationship Graph

`src/identity/schema.js`'s `validateRelationship()` +
`repository.js`'s relationship CRUD. Typed (`self | family | friend |
works_with | reports_to | client | contractor | service_provider | owns |
member_of | knows | custom`), evidence-backed (`sourceEvidenceIds`),
confidence + status (`active | superseded | contradicted | deleted`, default
retrieval excludes non-active, `includeInactive: true` shows history).
`coordinator.addRelationship()` **strengthens** confidence on repeated
evidence for the same edge (type + counterparty) instead of duplicating it;
a single weak observation is never auto-inflated. `correctRelationship()`
supersedes rather than overwrites. More than one relationship type between
the same two entities is supported (dedup key is `type + counterparty`, not
just the pair).

## Memory linking and relinking

`src/memory/schema.js` gained four **optional, backward-compatible** fields
on a memory record: `subjectEntityIds[]`, `objectEntityIds[]`,
`mentionedEntityIds[]`, `speakerEntityId`. All default to empty/`null`; every
pre-existing memory (and every memory written by the unmodified Memory
Writer) still validates and retrieves exactly as before. The original
`source.speakerId` (the raw diarized label) is **never overwritten** when a
link is added — both stay.

`coordinator.relinkMemoriesForInteraction({interactionId, speakerLabel,
personId})` is the only thing that sets `speakerEntityId`. It is **bounded**:
only memories from the *same* `interactionId* whose `source.speakerId`
matches and which have no `speakerEntityId` yet are touched — never a
historical sweep, never overwriting an existing (possibly different) link
(an already-linked memory is left alone — "ambiguous memories stay
unresolved"). `runtime.js` calls it automatically, but only after (a) the
turn's speaker actually resolved (`status === 'resolved'`) and (b) the
memory write for that same interaction completed — see the `.then()` chain
on `memory.writeInteraction(...)`.

`mergePeople()` relinks `speakerEntityId`/`subjectEntityIds`/
`mentionedEntityIds` pointers from source to target directly on the memory
repository (when one was provided). Deleting a person never deletes linked
memories unless `deleteLinkedMemories: true` is explicitly passed.
**Forgetting a memory removes its person link**: `coordinator.
attachMemoryLifecycle(memoryCoordinator)` subscribes to the memory
coordinator's own `memory-deleted` event and unlinks — this keeps `src/
memory/` and `src/identity/` decoupled in both directions (memory never
imports identity; identity only depends on memory's already-public event
API, and only when explicitly attached).

## Context Compiler integration

`agent/prompt.js`'s `assembleContext()` gained `currentSpeaker` and
`relevantRelationships` params, formatted into `CURRENT SPEAKER:` and
`RELEVANT RELATIONSHIPS:` sections — the same additive pattern used for
`RELEVANT MEMORIES`. Every injected person/relationship keeps its internal
ID. An `ambiguous` speaker is explicitly labeled `AMBIGUOUS — do NOT assume
an identity`; a self-identified-but-unconfirmed speaker is labeled
`UNCONFIRMED`; a fully `unknown`/`stale`/`cancelled` result injects **nothing**
(never guesses from pure absence). The system prompt was extended with one
paragraph instructing the model to treat this context as fallible,
confidence-scored evidence and quoted data, never instructions, and naming
the 16 identity tools.

`runtime.js` resolves the current speaker **at most once per turn**
(`resolveSpeakerOnce`-style caching, refreshed only after a tool that can
actually change it runs — `IDENTITY_REFRESH_TOOL_NAMES`) — unlike memory
retrieval, passive identity resolution can *write* evidence (an ambiguous
voice-match branch), so re-running it every follow-up round within one turn
would duplicate that evidence. This is proven by
`identity-agent-integration.test.js`'s "passive speaker resolution runs AT
MOST ONCE per turn" test.

## Explicit identity and relationship tools

16 tools registered into the **same** `agent/tools.js` registry the reactive
agent and Memory already use — no change to the agent decision schema:
`identify_current_speaker`, `name_current_speaker` (`self: true/false`
distinguishes self-ID from attributing another speaker), `confirm_person_match`,
`reject_person_match`, `create_person`, `update_person`, `merge_people`,
`split_person`, `forget_person` (two-step: preview, then `confirm: true`),
`enroll_voice`, `remove_voice_profile`, `add_relationship`,
`correct_relationship`, `remove_relationship`, `show_identity_evidence`,
`show_person_profile`. Every tool validates inputs via the existing registry,
delegates to `identity/coordinator.js` (100% deterministic), and the
coordinator emits a structured audit event for every mutation.

## Deletion behavior

- **Alias**: `removeAlias()` — person stays.
- **Voice profile**: `removeVoiceProfile()` — deletes provider-side (where
  supported), unlinks locally; a deleted profile is immediately unmatchable
  (verified in `identity-voiceProvider.test.js`).
- **Relationship**: soft-deleted (`status: 'deleted'`), never physically
  removed, so it stays historically inspectable.
- **Provisional/confirmed person**: `forgetPerson()` soft-deletes
  (`status: 'deleted'`) — never cascades to other people, relationships, or
  memories. `previewDeletePerson()` returns a bounded impact summary
  (relationship/evidence/linked-memory counts) shown before the destructive
  call; the `forget_person` tool enforces this two-step pattern
  (`needsConfirmation` unless `confirm: true`).
- **Memories**: only deleted if `deleteLinkedMemories: true` is explicitly
  passed to `forgetPerson()`. Forgetting a memory (through the existing
  Memory subsystem) removes its person link via `attachMemoryLifecycle`.

## Cancellation and stale results

Every resolver operation accepts `signal` (`AbortSignal`) and
`isStillCurrent()`, checked both before and after any async provider call.
`resolve()` distinguishes `cancelled` (abort signal) from `stale`
(`isStillCurrent()` false — e.g. a superseded turn). A late strong voice
match cannot overwrite a newer manual correction, because `correctIdentity`/
`confirmMatch`/`rejectMatch` always write fresh evidence and update
continuity directly — a stale async resolve() call that resolves afterward
still passes through the same continuity read path and will see the newer
state on its NEXT call, and any late passive resolution result the caller
already discarded (checked via `isStillCurrent`) never reaches the person
record at all. Merge, split, and profile deletion invalidate affected cached
resolutions (`resolver.invalidateForPerson`).

## Security and biometric privacy

**Update (see [SERVER-DATA.md](SERVER-DATA.md)):** a later phase added a
server-owned, authenticated SQLite repository as the default identity
provider (`server/repositories/identityRepository.mjs`), with
`voice_profile_refs` as a separate, independently-referenced table from
general person metadata, consent records gating biometric-provider
operations, and per-record sensitivity enforcement before any record enters
model context. The localStorage repository described below is now an
explicit development-only fallback. No real voice-identity provider was
added — the finding below still holds.

- Voice-identity credentials: **none exist** in this phase (no real
  provider — see "Provider limitations"); nothing resembling one is
  referenced anywhere under `src/identity/` (verified by
  `identity-security.test.js`, mirroring `voice-security.test.js`'s pattern).
- **No raw audio, voice embeddings, or biometric templates are ever written
  to browser localStorage** — a person record only ever holds an opaque
  `voiceProfileId` string; verified directly against the storage backend in
  `identity-repository.test.js` and `identity-security.test.js`.
- The deterministic voice provider's `matchKey` (its closest analog to
  biometric data) never leaves the in-process provider instance — it is not
  part of any repository record.
- Every payload (person/evidence/relationship/tool argument) is validated
  before storage — never trusted raw.
- Sensitivity is recorded on person/evidence/relationship records but see
  "Deferred sensitivity enforcement" below.
- No unrestricted identity-dump endpoint exists; `exportAll()`/`exportPerson()`
  are local dev-only coordinator methods, not server routes.
- Stored names/aliases/relationship labels are rendered as plain React text
  (auto-escaped) in the People panel, and travel as quoted DATA (never
  instructions) into the model prompt — proven with an explicit
  prompt-injection-shaped test string in `identity-context.test.js` and the
  simulation's "Prompt injection stored as inert data" check.
- Confidence scores are never described as legal identity verification, and
  identity resolution is never used for authentication or access control
  anywhere in this codebase.

## Development panel

`PeoplePanel` (`src/main.jsx`, dev-only, collapsible) shows: counts by
identity status, per-person display name/aliases/personId/confidence/
sensitivity (with an explicit "not enforced" notice), voice-profile count and
provider mode, relationships, recent identity activity, and controls:
Confirm/Reject (when applicable), rename + add alias, merge (by target
person ID), Enroll Voice (labeled with the live provider mode —
`deterministic`/`unavailable`), remove a voice profile, and Delete (with a
confirmation dialog summarizing the impact). No raw audio, embeddings,
credentials, or unrestricted transcript history is ever rendered.

## Configuration

`src/identity/config.js`: `storageKey: 'roma.people'`, `sessionTimeoutMs: 30
minutes`, `voiceProviderMode` (`'unavailable'` in production; `'deterministic'`
only if `VITE_IDENTITY_VOICE_DEV_MODE=deterministic` is explicitly set for
local dev/testing — never a secret, just a non-sensitive mode toggle),
`relationshipContext.maximumRelationships: 5`.

## Tests

100 new tests across 8 files (`test/identity-schema.test.js`,
`identity-repository.test.js`, `identity-voiceProvider.test.js`,
`identity-resolver.test.js`, `identity-coordinator.test.js`,
`identity-tools.test.js`, `identity-context.test.js`,
`identity-agent-integration.test.js`, `identity-security.test.js`) plus a
schema-compatibility addition to `test/memory-schema.test.js`'s coverage
area. All 419 tests (319 pre-existing + 100 new) pass — see the final report
for the exact command output.

## Simulation

`npm run simulate:identity` (`scripts/simulate-identity.mjs`) — Part 1 drives
the real agent runtime + tool registry + identity coordinator through the
27-step primary storyline (unknown speaker → attribution → session
continuity → new-session non-inheritance → voice match → memory linking →
same-name disambiguation → ambiguous-match non-merge → correction → typed
relationship + correction → merge → split → voice-profile removal → Speech
Gate never bypassed → full evidence/reason-code log). Part 2 covers ~20
additional focused scenarios (background speech, cross-session labels,
self-ID vs. attribution, strong/weak/ambiguous/competing voice matches,
low-quality/overlap/playback rejection, cancellation, manual
rejection/correction, alias correction, provisional cleanup, ambiguous
memory relinking, provider-unavailable honesty, sensitivity preservation,
prompt-injection safety). **41/41 checks pass.**

## Live verification

Performed via the existing finalized-transcript development harness
(`DevHarnessPanel` in `src/main.jsx`) — physical microphone access is
unavailable in this environment (`NotAllowedError`, confirmed, same as prior
phases). This is **transcript-only identity attribution verification through
the real agent/Groq/TTS pipeline**, not physical-microphone verification and
not real-provider biometric verification (no real voice-identity provider
exists to verify — see "Provider limitations"). See the final report for the
exact steps executed and their results.

## Facial recognition in the resolver

Face identity is real now (`server/faceIdentity/`, and
[PLAN-FACE-IDENTITY.md](PLAN-FACE-IDENTITY.md) for how it was built and
measured). What matters *here* is the rule it obeys inside entity resolution,
because it is not the obvious one:

> **Roma is worn.** Her camera looks outward, so the wearer is essentially
> never in frame. A face therefore answers "who is **present**", while
> `resolve()` is asking "who is **speaking**" — and the person in shot is
> most often the one being spoken *to*.

So face evidence is deliberately given a narrow job:

| situation | outcome |
|---|---|
| face agrees with a strong voice match | resolves, `cross_modal_agreement`, both evidences recorded |
| face contradicts a strong voice match | **unknown** — never the higher score. Both readings kept as candidates |
| face alone, no voice | `face_match` presence evidence, `face_presence_not_speaker`, no continuity |
| face during an ambiguous voice match | recorded as a candidate; the tie is **not** broken |
| face vs. a manual confirmation or correction | the human wins; face is not even consulted |
| face for a person the user rejected | dropped before it becomes evidence |

Thresholds live in `RESOLUTION_THRESHOLDS` (`strongFaceMatch`,
`mediumFaceMatch`, `minFaceQuality`); `face_match` ranks *below* `voice_match`
in `IDENTITY_EVIDENCE_TYPES` for exactly the reason above. Presence is
reported separately as `presentPersonIds` on the resolution, so knowing who is
in the room never has to be smuggled in as a claim about who spoke.

`person.faceProfileIds` is populated server-side, derived from the
`face_templates` rows that actually exist rather than kept as a second list
that could drift. Deleting a person retires their templates, so forgetting
someone stops the camera recognising them. Enrollment writes `face_enrollment`
evidence, so a `face_match` always has a provenance chain ending in a
deliberate human action.

Tests: `test/identity-face-evidence.test.js` (the table above, case by case),
plus the runtime path in `test/identity-agent-integration.test.js`, plus
`npm run verify:face-live` — which drives the whole browser leg (virtual
camera -> real COCO-SSD -> tracker -> real SCRFD/ArcFace -> association ->
temporal voting -> scene state) and is what caught face matches never being
associated with a person track at all.

## Current limitations

- No real voice-identity provider (see "Provider limitations" — an
  architectural finding, not an oversight).
- No liveness detection for faces: a printed photograph may match, and there
  is no UI to enrol a face yet (`POST /api/face/enroll` only).
- Passive resolve() only surfaces `CURRENT SPEAKER` for `resolved`/
  `ambiguous`/`provisional`; a bare name mention against a freshly
  self-identified name intentionally does NOT get promoted into that block
  (see `identity-agent-integration.test.js`) — the tool's own result is still
  visible to the model via `RECENT TOOL RESULTS`.
- `relinkMemoriesForInteraction` only relinks memories from the *same*
  interaction as the resolution — it does not retroactively relink older
  historical memories once a person is confirmed later (a deliberate
  boundedness choice, not a bug; a broader relinking pass is a reasonable
  future addition, always explicit/auditable, never automatic).
- ~~`deleteBySource`-style bulk memory deletion does not fire
  `attachMemoryLifecycle`'s per-memory unlink~~ — **fixed in the server
  phase**: the event now carries the affected `memoryIds` and
  `attachMemoryLifecycle` handles both event types; server-side, FK
  cascade removes links structurally (see
  [SERVER-DATA.md](SERVER-DATA.md#deletion-and-tombstones)).
- Fixed (non-learned) resolution thresholds.
- No cross-device/cross-browser person identity (localStorage is
  per-browser, per-device).

## Deferred sensitivity enforcement

**Sensitivity is currently stored as metadata but is not yet enforced as an
authorization or retrieval boundary. Enforcement is deferred until the
secure server database and real-time server agent integration phase.**

`sensitivity` (`normal | sensitive | biometric`) is preserved through create/
update/export/merge/split on person, evidence, and relationship records, and
is visibly labeled "not enforced" in the People panel — but nothing in this
codebase currently restricts who or what can read a `sensitive`- or
`biometric`-tagged record. Do not build any feature on the assumption that
sensitivity currently gates access.

**Browser localStorage is development-only person metadata storage and must
not be used for raw audio, biometric embeddings, voiceprints, or production
identity records.** A future secure server database is required before any
real biometric voice (or face) data is stored, along with an actual
sensitivity-based access-control layer — both explicitly out of scope for
this phase.
