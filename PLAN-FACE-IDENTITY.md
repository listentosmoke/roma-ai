# Plan — Facial recognition

Status: **planning**, written 2026-08-07 against the repository at `8bf8e44`.
Facial recognition was deferred until stabilization, the virtual hardware lab,
and the wearer/server-agent phase were all done. They are.

This plan is grounded in what was actually checked, not assumed. Three findings
shaped it before a line was written:

1. **There is no face-recognition model for transformers.js.** The library Roma
   already uses for WavLM has, on the Hub, exactly four `transformers.js` models
   matching "face" — all of them face *parsing* (segmentation). The voice
   subsystem's "pipeline + model id" pattern does not transfer.
2. **A production-grade ONNX pack does exist**: `immich-app/buffalo_l` ships
   `detection/model.onnx` (SCRFD) and `recognition/model.onnx` (ArcFace
   w600k_r50, 512-d). It is the InsightFace pack Immich uses in production.
3. **Both runtimes needed are already installed** — `onnxruntime-node@1.24.3`
   and `sharp@0.34.5` arrive today as dependencies of
   `@huggingface/transformers`. No new download; they will be promoted to
   direct dependencies so we are not relying on a transitive one.

## Licensing — read this before shipping

InsightFace models are released for **non-commercial research use**. That is
compatible with a personal, local assistant and incompatible with selling this.
The provider therefore pins the model by environment variable exactly as voice
identity does, so a differently-licensed encoder can replace it without touching
anything else. The constraint gets stated plainly in README and IDENTITY.md
rather than buried.

## The rule this phase must not break

Voice identity already established it, and face identity inherits it verbatim:

> A biometric match is **evidence, never authentication.**

Nothing about a face may grant access, unlock anything, or override an explicit
human statement. It enters the same evidence-ranked resolver as everything else
and can be corrected by a person's own words.

## What already exists to build on

The codebase was left with real seams, not vague intentions:

- `src/inspector/faces.js` — the recognizer interface the Inspector already
  calls each cycle (`identify(frame, personTracks)`), currently returning
  "nobody" honestly.
- `IDENTITY_EVIDENCE_TYPES` contained `future_face_match` (now `face_match`), parked at a
  rank just below `explicit_self_identification` and above
  `tool_verified_identity`.
- `person.faceProfileIds` exists on the schema and in the repository, reserved
  and never populated.
- `server/voiceIdentity/` is a complete worked example of the whole shape:
  provider, sample manager, AES-256-GCM crypto, consent gating, audit,
  bounded routes, and a diagnostics trace.

## Sequencing

Each phase has a gate. Nothing proceeds past a red gate.

### F1 — provider, proven in isolation

`server/faceIdentity/provider.mjs`: load SCRFD + ArcFace through
`onnxruntime-node`, detect faces with `sharp` preprocessing, align to the
112×112 ArcFace input, and produce L2-normalized 512-d embeddings. Model files
are fetched once from the Hub and cached under the existing model cache; the
run that downloads them is the only one that may.

**Gate:** a script proves the mechanics — the models load, a face image yields a
512-d unit vector, the *same* image yields a bit-identical embedding, a
*different* image yields a different one, and cosine similarity is symmetric and
bounded. This proves the pipeline, **not accuracy** (see "Honest limits").

### F2 — storage, consent, and encryption

Migration `0005_face_identity` adds `face_templates`, mirroring `voice_templates`
column for column, including the encryption key version. Templates are
AES-256-GCM encrypted with the **same** `BIOMETRIC_ENCRYPTION_KEY` and the same
cipher module — one key management story, not two. `faceProfileIds` starts being
populated. Consent is a distinct purpose from voice: consenting to voice
enrollment must not silently enrol a face. Revoking either freezes its own
templates.

**Gate:** unit tests prove templates are unreadable without the key, that a
missing key fails the subsystem closed, that revoked consent freezes profiles,
and that deleting a person cascades to their face templates.

### F3 — evidence and resolution — **DONE**

`future_face_match` became `face_match`, plus `face_enrollment` paralleling
`voice_enrollment`. The resolver takes `faceObservations` through its existing
`resolve()` interface. Cross-modal agreement resolves with
`cross_modal_agreement`; disagreement resolves to **unknown**, never to the
higher-scoring guess.

One thing the plan got wrong and building it corrected: face evidence cannot
be treated as a general-purpose identity signal, because **the camera is worn
and looks outward**. It answers "who is present", not "who is speaking" — the
person in frame is usually the one being spoken *to*. So face evidence
corroborates or contradicts a voice match and is otherwise recorded as
presence (`presentPersonIds`); it never resolves a speaker alone and never
breaks a voice tie. That is why `face_match` ranks below `voice_match` rather
than beside it. The full case table is in [IDENTITY.md](IDENTITY.md)
"Facial recognition in the resolver".

**Gate: green.** `test/identity-face-evidence.test.js` — 18 tests including
the disagreement case, the manual-confirmation and correction cases, the
rejected-person case, and quality/threshold gating; plus the live runtime path
in `test/identity-agent-integration.test.js`.

### F4 — the live path

`src/inspector/faces.js` gets a real implementation behind its existing
contract: crop tracked person boxes, send to the local server, receive
candidates. Runs only when the camera is already on AND consent is active.
Enrollment is explicit, through the People panel, exactly like voice.

**Gate:** the app runs with the camera on, no console errors, and identification
is visibly gated on consent.

### F5 — adversarial and lab work — **partly done**

`npm run verify:face-live` drives the whole browser leg through the virtual
hardware lab: a photograph rendered into the virtual room, a REAL
MediaStreamTrack, Roma's unmodified camera source, real COCO-SSD, the tracker,
the recognizer, real SCRFD + ArcFace on the server, association back onto the
person track, temporal voting, and the scene state the agent reads. 19 checks,
including enrollment driven by clicking the actual panel button.

It found the bug that mattered: **face matches could never be associated with
a person track at all** (the two halves measure boxes in different units), and
the unit test that "covered" it had invented a track shape the tracker never
produces. Nothing failed loudly — recognition just silently never happened.

The verification also caught itself over-claiming. A first version reported a
cross-photograph similarity of ~1.00, because votes carried over from the
enrollment frames; it now empties the room between phases and asserts the score
is in the cross-photograph range (measured: **0.77**, against 0.79 server-side).

**Photo-replay needs no exploit here — it IS the test.** The lab recognises a
photograph of a person as that person, which is exactly the documented
limitation: there is no liveness detection. That is stated in the README, in
IDENTITY.md, and in the People panel itself rather than left to be discovered.

Fixtures are photographs of real people and are NOT committed:
`npm run fetch:face-fixtures` pulls public-domain official portraits into a
gitignored directory, and the verification skips with instructions if they are
absent.

**Still open:** consent-enrollment and revocation scenarios (consent
enforcement is off in this build, so there is nothing to assert yet), and
cross-modal face+voice timing in the lab.

## Honest limits, stated up front

- **The lab cannot verify face accuracy.** COCO-SSD detected rendered geometry
  happily; a face encoder cannot be fed coloured rectangles and produce a
  meaningful claim. Lab scenarios will verify *plumbing, consent, and gating*
  using a small set of clearly-labelled fixture images. Accuracy claims require
  real faces on real hardware, and belong in HARDWARE-VERIFICATION.md alongside
  the voice-identity checklist — which is still outstanding.
- **No liveness detection.** A printed photo may well match. This must be said
  in the docs and in the UI copy, not discovered by a user.
- **Demographic performance is unmeasured.** ArcFace error rates are known to
  vary across skin tone, age, and gender. With no evaluation set, the honest
  statement is that this is unmeasured here — which is another reason the
  output is evidence a human can correct, never an authentication decision.
- **This is the most invasive thing Roma does.** Everything else needs someone
  to speak; a face is captured by being present. Consent must be explicit,
  visible, revocable, and enrollment must never be a side effect of anything.
