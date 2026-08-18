# Real Voice Identity

## Status and boundary

Roma supports explicit, consented speaker enrollment plus bounded verification and identification. Voice similarity is probabilistic evidence for conversational entity resolution. It is **not authentication**, liveness proof, legal identity, or authority to access sensitive data or perform external actions. Facial recognition, covert enrollment, continuous audio storage, and global matching are not implemented.

The application is currently a local Windows/Vite deployment. In `AUTH_MODE=development`, every biometric route additionally requires a loopback client. `AUTH_MODE=production` fails closed until `server/auth.mjs` is constructed with a real `verifyToken`; this is not production-deployment readiness.

## Architecture

```text
browser microphone (mono PCM16, 16 kHz)
  +--> unchanged Deepgram WebSocket forwarding
  +--> capture-token-scoped bounded copy (only during an operation)
         --> frame VAD and signal-quality checks
         --> local WavLM speaker encoder
              +--> AES-256-GCM encrypted SQLite template (enrollment/update)
              +--> bounded candidate cosine comparison (match)
                     --> voice_match evidence --> existing Entity Resolver
                     --> resolved / ambiguous / unknown
                     --> bounded session continuity
                     --> existing Context Compiler (safe metadata only)
```

`server/deepgramProxy.mjs` forwards each binary frame to Deepgram unchanged. During a valid `VoiceCaptureStart`, it also gives a copied frame to `audioSampleManager.mjs`. No operation means no buffer. Capture rejection stops the biometric copy but not transcription.

## Provider

- Provider: `local_wavlm`
- Model: `Xenova/wavlm-base-plus-sv`
- Pinned revision: `e61029603001bd11295c36d878698708bf59190f`
- Runtime: `@huggingface/transformers` 4.2.0, quantized `q8`, Node CPU
- Output: normalized 512-element `Float32Array`
- Audio: mono linear PCM16 at 16 kHz
- Execution: local server; identification audio/embeddings are not sent to Groq or Deepgram
- Plain template payload before encryption: 2,052 bytes (dimension plus 512 float32 values)
- License: the upstream Microsoft model card points to the UniSpeech/WavLM code and CC BY-SA 3.0 license; review redistribution obligations before packaging weights

This is speaker embedding, not speech-to-text or Deepgram diarization. Verification asks whether one claimed profile matches; identification ranks at most 12 relevant same-tenant candidates. Neither is voice authentication.

CPU inference is sufficient for the actual single-user local deployment. On the Ryzen 5 PRO 6650U, the end-to-end simulation's first extraction was about 2.6 s and warmed extractions about 1.1-1.2 s; a separate cold load plus inference was about 9.6 s. Candidate comparison is sub-millisecond at this scale. Work is single-flight with a four-item total queue, and stale results are rejected.

## Audio lifecycle and quality

Each operation is scoped to workspace, user, session, interaction, speaker label, person, purpose, operation ID, and a random 256-bit capture token. Defaults are 2,500 ms minimum usable speech, 12,000 ms maximum duration, 384,000 maximum bytes, 60-second expiry, mono PCM16 at 16 kHz, and four simultaneous captures per workspace.

The buffer exists only in process memory. It is copied, consumed once, zeroed after extraction, or deleted on cancellation, rejection, and expiry. Raw PCM is never logged, returned through HTTP, stored in SQLite/localStorage, or compiled into a prompt.

Frame analysis reports RMS, adaptive noise floor, usable speech, silence ratio, clipping ratio, and quality. It rejects short, insufficient-speech, silence-dominated, clipped, low-quality, overlap-flagged, Roma-speaking, and playback-active samples. This is a conservative heuristic VAD/overlap input, not neural source separation.

Roma playback is checked before and during capture. An exact SHA-256 fingerprint is held in memory for ten minutes only to flag exact recent reuse; it is not a voiceprint and is never persisted. Suspicious matching requires confirmation; suspicious enrollment requires a new sample. There is no synthetic-speech detector or verified liveness mechanism.

## Enrollment, consent, and updates

The People panel shows intended stable person ID, provider/model, key readiness, microphone/capture state, explicit consent wording, and safe profile metadata. **Enroll Voice (I consent)** creates or reuses an active `voice_identity` consent, then starts a purpose-specific capture. Ambient speech, self-identification, transcripts, diarization continuity, model suggestions, and unrelated audio cannot enroll anyone.

Profiles can gain another sample only for a confirmed person, with active consent, compatible model version, a passing new sample, and either strong verification or explicit confirmation. Compatible vectors use a deterministic sample-count-weighted normalized average. Exact replay and ambiguous verification cannot update a profile.

## Storage, encryption, and keys

`voice_templates` is separate from ordinary identity tables. General people keep opaque references; ordinary hydration/export strips them and excludes biometric evidence. Safe metadata endpoints never return plaintext or ciphertext.

Templates use AES-256-GCM and a fresh random 96-bit nonce. AAD authenticates workspace, person, voice profile, provider, model, model version, and template version. The key is server-only `BIOMETRIC_ENCRYPTION_KEY` (32-byte base64 or 64 hex characters), with `BIOMETRIC_ENCRYPTION_KEY_VERSION`. There is no default; operations fail closed without it. `createTemplateCipher().rotate()` provides explicit tested re-encryption using an old-key keyring; rotation is not automated.

Development setup:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:BIOMETRIC_ENCRYPTION_KEY = [Convert]::ToBase64String($bytes)
$env:BIOMETRIC_ENCRYPTION_KEY_VERSION = '1'
npm run dev
```

For durable profiles, use a server secret manager or gitignored `.env`. Losing the key makes profiles undecryptable. Backups contain ciphertext but still need encrypted-volume and deletion controls.

## Thresholds and accuracy

| Setting | Value |
|---|---:|
| strong match | 0.86 |
| candidate | 0.80 |
| non-match reference | 0.65 |
| ambiguity margin | 0.04 |
| minimum quality | 0.55 |
| candidate cap | 12 |

Scores are cosine similarities, not probabilities; `calibratedConfidence` stays `null`. These initial development thresholds use provider guidance and local fixtures, not universal biometric guarantees. Two eligible candidates within 0.04 remain ambiguous. Below candidate threshold stays unknown/non-match.

The recorded conversation fixture produced 0.9722 for two non-overlapping Dan clips and 0.4940 for Dan versus Vanessa. An earlier Dan window produced a false rejection (0.5709), showing capture sensitivity and the need for retry. No false acceptance appeared in this tiny check, which is far too small to establish an error rate.

## Entity Resolver and context

The service never assigns a person directly from the top score. It temporarily stores the bounded outcome, lets the existing Entity Resolver validate the candidate pool, writes `voice_match` evidence, and receives resolved/ambiguous/unknown. Manual confirmation, rejection, and correction use that resolver; rejected candidates are excluded from immediate same-session reuse, corrections invalidate continuity, and valid continuity skips redundant identification.

The browser may mirror an already server-validated resolution using person/evidence IDs only. The agent sees a bounded `CURRENT SPEAKER` statement with safe identity and evidence metadata. It never sees PCM, embeddings, ciphertext, keys, fingerprints, or unrestricted diagnostics. Speech still uses the Speech Gate and existing TTS pipeline.

## Revocation, deletion, and model versions

Consent revocation marks templates revoked, freezes references, removes candidates, and invalidates voice-derived continuity. Hard deletion removes the encrypted row/reference and leaves a non-biometric tombstone; person records and ordinary memories remain. Re-enrollment requires new consent.

Provider, model revision/version (`revision:dtype`), dimensions, and template version are stored. Comparison skips incompatible versions. Profile listing marks incompatible active rows `requires_reenrollment`; no vector conversion is claimed.

## Routes and UI

Authenticated, rate-limited routes include provider status and development diagnostics; capture begin/status/flags/cancel; enrollment, matching, and profile-update finalization; safe person profile metadata; profile deletion; and resolution confirmation/rejection/correction under `/api/voice/*`. Ownership comes only from the auth principal. Biometric routes are separately limited to 12 operations/minute per principal. Legacy direct opaque-profile create/delete routes return `410` so they cannot fake enrollment.

The UI exposes consent, provider/model, readiness, duration, required speech, safe quality/version/count/last-match metadata, enrollment, add-sample, verification, revocation, deletion, candidate confirmation/rejection, cancellation, and development-only warnings. It never renders raw biometric material.

## Verification

- Focused suite: `test/voice-identity.test.js` (26/26)
- Simulation: `npm run simulate:voice-identity` (33/33). Uses ffmpeg to cut
  clips from `.testdata/conversation.m4a` when available; without ffmpeg it
  falls back to the pre-extracted `.testdata/*.pcm` fixtures (same speakers,
  measured 2026-07: same-speaker 0.9722, different-speaker 0.5525)
- Real local fixture: same 0.9722, different 0.4940
- Browser: provider/encryption ready on loopback, mic start/stop worked, zero console warnings/errors
- Real Groq context check: 274 ms and 223 tokens; only bounded Matt/evidence/memory context was supplied
- Physical microphone: browser access/streaming worked, but no controlled enrolled speaker was present, so physical-microphone recognition accuracy is **not claimed**
- Virtual hardware lab (2026-07): conversational identity through real virtual-mic speech is covered (`npm run simulate:virtual-identity`); the People-panel enrollment click-through is not yet automated — the WavLM/encryption/consent path stays verified by `simulate:voice-identity` (see [VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md) "Current limitations"). Synthetic or replayed voices prove pipeline behavior only, never human biometric accuracy

Run `npm test`, `npm run build`, and `npm run simulate:voice-identity`.

## Limitations and production requirements

- Calibration is small; microphone, room, noise, language, health, age, and distance can shift scores.
- Overlap is conservative detection/input, not speaker separation.
- Exact replay checking is narrow and does not establish liveness or detect arbitrary synthetic audio.
- Initial model load may take seconds and may download/cache weights.
- Matching occurs only for explicit bounded operations, not every interim audio chunk.
- SQLite and in-process queues/limits fit local single-process use, not a multi-instance service.
- Production requires a real token verifier, TLS, managed secrets/key rotation, backup deletion policy, shared distributed limits/queues, and representative calibration before biometric exposure.

