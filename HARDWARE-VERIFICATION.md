# Real-Hardware Verification Checklist

**Status: OPTIONAL for integration correctness · RECOMMENDED for hardware
compatibility and room acoustics · REQUIRED before biometric-accuracy claims.**

Since the virtual-hardware phase ([VIRTUAL-HARDWARE.md](VIRTUAL-HARDWARE.md),
2026-07), the complete software integration path — microphone boundary →
real Deepgram → real Groq → Speech Gate → real TTS → playback → echo
suppression → barge-in, plus camera boundary → real COCO-SSD → Inspector →
agent — is **closed-loop verified through real `MediaStream` devices**
(virtual rooms, real providers, isolated servers). What the lab cannot
prove: your specific microphone/camera hardware, driver quirks, real-room
acoustics/echo behavior, physical speaker-to-mic coupling, and any human
biometric accuracy. That is what this checklist is for. **Transcript
injection is NOT a substitute for either** — it was only ever a
pipeline-bench tool.

How to run: `npm run dev` (or ask Claude to start it), open
http://localhost:5173 in Chrome/Edge **on this machine**, then walk the
sections below in order. Record results inline (each `[ ]` plus the
measurement lines). The dev panels at the bottom of the page (Voice
delivery, Diagnostics trace, Server Data) show every number asked for.

Before starting, for the voice-identity section set the biometric key
(PowerShell, same terminal that runs `npm run dev`):

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:BIOMETRIC_ENCRYPTION_KEY = [Convert]::ToBase64String($bytes)
$env:BIOMETRIC_ENCRYPTION_KEY_VERSION = '1'
```

(For durable profiles, put those two values in `.env` instead — see
`.env.example`. Without the key, voice identity fails closed by design.)

## 1. Microphone + conversation loop

- [ ] Click **Start**; grant microphone permission. Audio readiness indicator
      shows unlocked (the Start click unlocks autoplay).
- [ ] Speak ambient conversation NOT addressed to Roma (e.g. read a sentence
      aloud to yourself). Roma stays silent; the Agent panel shows `ignore`.
- [ ] Say: **"Roma, what time is it?"** → transcript appears, addressee
      decision `respond`, Speech Gate approval, audible spoken reply.
- [ ] Ask a follow-up WITHOUT the wake word (e.g. "and what day is it?")
      within ~20 s → Roma still answers (engagement window).
- [ ] Ask a long question, then interrupt Roma mid-playback by speaking →
      playback stops (barge-in), your new words become a fresh turn.
- [ ] Say **"stop"** during another reply → immediate cancellation (no LLM
      round-trip — should feel instant).
- [ ] Confirm Roma's own spoken reply does NOT appear as a new user turn
      (echo suppression; check the Diagnostics trace for `echo` entries).
- [ ] Try quiet speech, then ordinary background noise (fan/music), then a
      second person speaking nearby. Transcript labels speakers as
      `Speaker N` (transient diarization labels — never auto-named).
- [ ] Confirm no response plays twice, and zero console errors (F12).

Record: browser+version · mic device · noise conditions · latencies from the
Voice panel (`tts`, `transcript→audio`, `playback start`) and Agent panel
(`model`, `total`) · any false/missed responses.

## 2. Camera + Inspector

- [ ] Click the camera button; grant permission. Live Scene panel activates.
- [ ] Stand in frame → a person appears in scene state.
- [ ] Show 2–3 distinct objects (cup, phone, book) → detected with grid
      positions; moving an object keeps its track id (continuity).
- [ ] Remove an object from frame → it goes `missing`, then an
      `object-lost` event.
- [ ] Briefly cover the lens (occlusion), then uncover → recovery without
      errors.
- [ ] Dim the lights → note detection quality (COCO-SSD degrades; that is
      expected and should be honest, not crash).
- [ ] Move the camera → tracking re-settles.
- [ ] With the mic ALSO running, ask "Roma, what do you see?" → the reply
      uses the compact scene snapshot (and `inspect_vision` may fire one
      bounded Groq vision call — visible in the Agent panel).
- [ ] Stop the camera → voice interaction keeps working (camera failure
      never breaks voice).
- [ ] Zero console errors.

Known placeholders (expected, do not file as bugs): face identification
returns nobody (`faces.js` placeholder); the scene interpreter is
template-based; detection is COCO-SSD's 80 generic classes; tracking is
greedy IoU (no re-identification after long occlusion).

## 3. Voice identity (needs the biometric key + ideally two people)

- [ ] In the People panel, create/select a person; click **Enroll Voice
      (I consent)** — purpose/consent wording is shown; speak naturally
      ~5–10 s.
- [ ] Try a too-short sample (~1 s) → rejected with a retry prompt.
- [ ] Try enrolling while Roma is speaking → capture is blocked.
- [ ] Successful enrollment shows profile metadata (never raw audio).
- [ ] New session (refresh), speak naturally, run **Identify** → correct
      candidate proposed with a score; confirm it. Session continuity then
      skips re-asking.
- [ ] Second speaker talks; identify → non-match or their own profile,
      never a silent wrong match.
- [ ] Repeat at ~2 m distance and with moderate background noise; note
      score shifts.
- [ ] Play a RECORDING of the enrollment phrase → flagged as possible
      replay (heuristic — exact-fingerprint only; this is not liveness).
- [ ] Reject a proposed identity → it is not immediately re-proposed.
- [ ] Correct an identity → correction sticks over the voice match.
- [ ] Revoke consent → matching stops working for that person.
- [ ] Delete the profile → template gone (People panel), matching impossible.

Record: sample count/duration · same-speaker scores · different-speaker
scores · false accepts/rejects · match latency. Thresholds for reference:
strong 0.86, candidate 0.80, ambiguity margin 0.04, min quality 0.55.
Do NOT generalize accuracy from this tiny sample.

## 4. Already verified without hardware (for the record)

- Scenario B (memory remember→pending→SQLite→recall→correct→forget→restart):
  live-verified via dev harness + real Groq + mutation queue + SQLite export,
  plus `npm run simulate:recovery` (20/20).
- Scenario E (server interruption/retry/no-duplicate/no-resurrection):
  `npm run simulate:recovery` (20/20).
- Scenario D (sensitivity): `npm run simulate:server-state` (28/28) + live
  secret-record exclusion check.
- Scenario F (degraded subsystems): voice identity fails closed without its
  key (observed live); missing Groq key → labeled mock provider (tested);
  camera blocked → app runs (observed live); server down → visible
  unavailable state, never silent localStorage (tested).
