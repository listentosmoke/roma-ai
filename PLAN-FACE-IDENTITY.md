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
- `IDENTITY_EVIDENCE_TYPES` already contains `future_face_match`, parked at a
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

### F3 — evidence and resolution

`future_face_match` becomes `face_match` — a name that lies about being
hypothetical once it is not — keeping its rank position, plus `face_enrollment`
paralleling `voice_enrollment`. The resolver gains face evidence through its
existing interface. Cross-modal agreement (face and voice both pointing at one
person) raises confidence; disagreement resolves to **unknown**, never to the
higher-scoring guess.

**Gate:** resolver tests, including the disagreement case, and a test that no
face evidence can override `manual_confirmation` or `correction`.

### F4 — the live path

`src/inspector/faces.js` gets a real implementation behind its existing
contract: crop tracked person boxes, send to the local server, receive
candidates. Runs only when the camera is already on AND consent is active.
Enrollment is explicit, through the People panel, exactly like voice.

**Gate:** the app runs with the camera on, no console errors, and identification
is visibly gated on consent.

### F5 — adversarial and lab work

Photo-replay is the obvious attack: hold up a photograph. Voice has an
exact-fingerprint replay check that is explicitly *not* liveness; face gets the
same honesty — duplicate-frame detection, documented as anti-replay, **not**
anti-spoofing. Lab scenarios cover enrollment-with-consent, revocation, and
cross-modal face+voice timing.

**Gate:** `verify:virtual-lab` stays green, and the new scenarios pass.

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
