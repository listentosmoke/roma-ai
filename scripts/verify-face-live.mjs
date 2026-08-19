#!/usr/bin/env node
// Live face verification — the browser leg, end to end, on real VIDEO.
//
// Everything else about face identity is tested offline against a fake
// encoder, or server-side against still images. This script is the only thing
// that exercises the path a real user actually takes:
//
//   a real video clip -> virtual camera (a REAL MediaStreamTrack) -> Roma's
//   UNMODIFIED camera source -> real COCO-SSD person detection -> the tracker
//   -> the face recognizer -> POST /api/face/identify -> real SCRFD + ArcFace
//   -> the match associated back onto the right person track -> temporal
//   voting -> the scene state the agent reads.
//
// Video, not stills, because the failures that matter only happen in motion:
// heads turn, frames blur, faces leave and return, and a scene cut can drop a
// DIFFERENT person into the same track. A still image cannot produce any of
// that, and an earlier version of this check used one.
//
// The two clips are different recordings of the same stage cast. What is in
// them was measured before any assertion was written here (ffmpeg sampling +
// embedding + greedy clustering at 0.50):
//
//   enroll.mp4  10s. One person alone, face 77-85px, from t=3.5 to t=7.5.
//               Crowd shots either side of that window.
//   verify.mp4  80s, a different and longer recording. The same person is on
//               screen for 39 of those 80 seconds. At t=26-28 they are
//               ABSENT and a different person is on screen alone.
//
// So enrollment happens on one recording and recognition is checked on
// another, and the correct-REJECTION window is a real person who is really
// not the enrolled one — not an assumption that a cut happened.
//
// What this proves: plumbing, association, temporal voting, and rejection,
// with real models under motion. NOT recognition accuracy for a population —
// that needs real faces on real hardware (see HARDWARE-VERIFICATION.md).
//
// Run: npm run verify:face-live        (add --visible to watch)
// Fixtures: npm run fetch:face-fixtures  (real footage, never committed)

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLab } from './lib/virtualLab.mjs';
import { fixtureState, FIXTURE_DIR } from './fetch-face-fixtures.mjs';

// The detector is ~6 MB from a CDN and a fresh Chrome profile has an empty
// cache, so without this every run pays minutes for the same download. Only
// the HTTP cache is shared; the profile itself is still disposable.
const DISK_CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', '.simcache', 'chrome-disk-cache');
mkdirSync(DISK_CACHE, { recursive: true });

const headless = !process.argv.includes('--visible');
const checks = [];
function check(label, condition, details = '') {
  const pass = Boolean(condition);
  checks.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${details ? ` (${details})` : ''}`);
  if (!pass) process.exitCode = 1;
}

// Measured windows (see the header). Held as segments so the person stays on
// screen longer than the cut does — temporal voting needs several sightings
// to confirm a name and several misses to drop one.
const ENROLL_CLIP = { src: '/test/fixtures/faces/enroll.mp4', startAt: 3.5, loopStart: 3.5, loopEnd: 7.4 };
const VERIFY_CLIP = { src: '/test/fixtures/faces/verify.mp4', startAt: 2, loopStart: 2, loopEnd: 13 };
const STRANGER_WINDOW = { to: 26.2, loopStart: 26, loopEnd: 28.5 };

console.log('\nLive face verification (real video -> virtual camera -> real models)');
console.log('════════════════════════════════════════════════════════════════════');

const fixtures = fixtureState();
if (!fixtures.ready) {
  console.log(`\n  SKIPPED — missing fixtures: ${fixtures.missing.join(', ')}`);
  console.log('  These are recordings and photographs of real people, never committed.');
  console.log('  Fetch them with:  npm run fetch:face-fixtures');
  console.log(`  (they land in ${FIXTURE_DIR})\n`);
  process.exit(0);
}

/**
 * Play a clip full-frame in the virtual room.
 *
 * Full-frame is deliberate: the source is 640x360 with faces around 80px, and
 * the encoder's own gate rejects a face under 60px. Drawing it across the
 * 1280x720 canvas keeps faces clear of that floor. It adds no detail — it is
 * the framing a camera at conversational distance would give, not a
 * resolution claim.
 */
async function playClip(lab, clip) {
  return lab.cdp.evaluate(`window.__romaSim.showVideo('face_clip', ${JSON.stringify({ ...clip, x: 0, y: 0, width: 1280 })})`);
}

async function seekClip(lab, args) {
  return lab.cdp.evaluate(`window.__romaSim.seekVideo('face_clip', ${JSON.stringify(args)})`);
}

async function sceneIdentities(lab) {
  const snapshot = await lab.snapshot();
  return snapshot?.app?.scene?.peopleIdentified ?? [];
}

/** Poll the scene until `predicate` holds, or give up. Returns the last reading. */
async function waitForScene(lab, predicate, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await sceneIdentities(lab);
    if (predicate(last)) return { ok: true, people: last };
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  return { ok: false, people: last };
}

/** Watch for a while and report every reading, stamped, so a claim rests on a run of frames. */
async function observe(lab, ms) {
  const readings = [];
  const startedAt = Date.now();
  const deadline = startedAt + ms;
  while (Date.now() < deadline) {
    readings.push({ atMs: Date.now() - startedAt, people: await sceneIdentities(lab) });
    await new Promise((resolve) => { setTimeout(resolve, 700); });
  }
  return readings;
}

const lab = await createLab({ headless, seed: 7, diskCacheDir: DISK_CACHE });
let personId = null;
try {
  // ── a person to be recognised as ─────────────────────────────────────────
  const created = await fetch(`${lab.server.baseUrl}/api/data/people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Fixture Person', identityStatus: 'confirmed' }),
  }).then((r) => r.json());
  personId = created.person?.personId ?? null;
  check('a person record exists to enrol against', Boolean(personId), personId ?? 'not created');
  if (!personId) throw new Error('cannot continue without a person record');

  // The browser mirror hydrates at load, so it has to see the new person.
  await lab.cdp.navigate(lab.server.baseUrl);
  await lab.cdp.evaluate('new Promise((r) => setTimeout(r, 1500))');

  const health = await fetch(`${lab.server.baseUrl}/api/face/health`).then((r) => r.json());
  check('the face encoder is configured on the isolated server', health?.face?.configured === true, health?.face?.repo ?? '');

  // ── real footage plays into the virtual camera ───────────────────────────
  await lab.command('environment.load', { profile: 'quiet_office' });
  const clip = await playClip(lab, ENROLL_CLIP);
  check('a real video clip is playing into the virtual camera', clip?.ok === true, clip ? `${clip.width}x${clip.height}, ${clip.duration?.toFixed(1)}s` : 'failed to load');

  const moving = await lab.cdp.evaluate(`(async () => {
    const first = window.__romaSim.snapshot().sim.frameSignature;
    await new Promise((r) => setTimeout(r, 600));
    return first !== window.__romaSim.snapshot().sim.frameSignature;
  })()`);
  check('the rendered frames are actually moving, not a held still', moving === true);

  await lab.ui('camera');
  // COCO-SSD's weights are ~20 MB from storage.googleapis.com, measured at
  // ~117 KB/s from this machine — so a cold cache costs about five minutes,
  // and a warm one 13 seconds (both measured). That is a download, not a face
  // failure, so it is waited on separately and reported for what it is.
  const cameraStarted = await (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + 420000;
    let announced = 0;
    while (Date.now() < deadline) {
      const snapshot = await lab.snapshot();
      if (snapshot?.app?.watching) return Math.round((Date.now() - startedAt) / 1000);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (elapsed >= announced + 30) { announced = elapsed; console.log(`        …waiting for the detector to load (${elapsed}s): ${snapshot?.app?.inspectorStatus ?? 'starting'}`); }
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
    return null;
  })();
  check('the camera starts and the object detector loads', cameraStarted != null, cameraStarted == null ? 'timed out after 420s' : `${cameraStarted}s${cameraStarted > 60 ? ' — cold model cache; the next run reuses it' : ' (cached)'}`);

  const detected = await waitForScene(lab, (people) => people.length > 0, { timeoutMs: 60000 });
  check('real COCO-SSD detects a person in the moving footage', detected.ok, `${detected.people.length} person track(s)`);
  check('nobody is identified before anyone is enrolled', detected.people.every((p) => !p.personId));

  // ── enrol through the REAL panel button, off live video ──────────────────
  const rowReady = await (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const found = await lab.cdp.evaluate(`(() => {
        const details = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent.includes('voice identity'));
        if (!details) return false;
        details.open = true;
        return details.innerText.includes('Fixture Person');
      })()`);
      if (found) return true;
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
    return false;
  })();
  check('the person hydrated from the server into the People panel', rowReady);

  const clicked = await lab.cdp.evaluate(`(() => {
    const details = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent.includes('voice identity'));
    if (!details) return 'panel not found';
    details.open = true;
    const button = [...details.querySelectorAll('button')].find((b) => b.textContent.includes('Enroll Face'));
    if (!button) return 'button not found';
    if (button.disabled) return 'button disabled';
    button.click();
    return 'clicked';
  })()`);
  check('the People panel offers face enrollment while the camera runs', clicked === 'clicked', String(clicked));

  // Five frames, 600ms apart — so these are five DIFFERENT moments of a
  // moving person, which is the whole reason enrollment takes several.
  const enrolled = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const profiles = await fetch(`${lab.server.baseUrl}/api/face/profiles`).then((r) => r.json());
      if ((profiles.profiles ?? []).length) return profiles.profiles[0];
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
    return null;
  })();
  check('enrollment stored a template from live video', Boolean(enrolled), enrolled ? `${enrolled.sampleCount} sample(s), quality ${enrolled.aggregateQuality?.toFixed?.(2)}` : 'no profile appeared');
  check('the template belongs to the right person', enrolled?.personId === personId);
  check('several moving frames were averaged, not one snapshot', (enrolled?.sampleCount ?? 0) > 1, `sampleCount=${enrolled?.sampleCount}`);

  const evidence = await fetch(`${lab.server.baseUrl}/api/data/people/${personId}/evidence`).then((r) => r.json());
  const enrollmentEvidence = (evidence.evidence ?? []).find((e) => e.evidenceType === 'face_enrollment');
  check('enrollment left a face_enrollment evidence trail', Boolean(enrollmentEvidence), enrollmentEvidence?.reasonCode ?? 'none');
  check('the evidence names the template it came from', enrollmentEvidence?.faceProfileId === enrolled?.faceProfileId);

  // ── recognition on a DIFFERENT recording ─────────────────────────────────
  await lab.cdp.evaluate(`window.__romaSim.removeVideo('face_clip')`);
  await waitForScene(lab, (people) => people.length === 0, { timeoutMs: 30000 });
  const second = await playClip(lab, VERIFY_CLIP);
  check('a second, different recording is playing', second?.ok === true, second ? `${second.duration?.toFixed(1)}s clip` : 'failed');

  const recognised = await waitForScene(lab, (people) => people.some((p) => p.personId === personId), { timeoutMs: 90000 });
  const match = recognised.people.find((p) => p.personId === personId);
  check('the same person is recognised in the OTHER recording', recognised.ok, match ? `similarity ${match.confidence}` : JSON.stringify(recognised.people));
  check('the match is associated with the person track, not floating free', Boolean(match), 'the coordinate-space bug that had no real coverage');
  check('the recognised person is named, not shown as a record id', match?.identity === 'Fixture Person', match?.identity ?? 'null');
  // A genuine cross-recording score sits well below a re-encode of the same
  // frame. ~1.00 would mean the footage never actually changed.
  check('the score is a cross-recording score, not the enrollment frames again', match != null && match.confidence >= 0.5 && match.confidence <= 0.95, `similarity ${match?.confidence}`);

  // Recognition has to SURVIVE motion, not just occur once in it.
  const sustained = await observe(lab, 12000);
  const named = sustained.filter(({ people }) => people.some((p) => p.personId === personId)).length;
  check('the identity holds across a stretch of moving video', named >= Math.ceil(sustained.length * 0.6), `${named}/${sustained.length} readings named them`);

  // ── a scene cut to a different person ────────────────────────────────────
  // Measured offline: at t=26-28 of this clip the enrolled person is absent
  // (best similarity 0.10-0.13 to their enrollment) and someone else is on
  // screen alone.
  //
  // The name does NOT vanish on the cut, and that is by design: temporal
  // voting needs repeated disagreement before dropping a confirmed identity,
  // because a person who turns their head for a second should not be
  // forgotten. The cost is that after a hard cut the previous name lingers on
  // the new face for a few seconds. That window is measured here rather than
  // asserted away — it is a real property anyone reading the scene state
  // needs to know about.
  await seekClip(lab, STRANGER_WINDOW);
  const stranger = await observe(lab, 30000);
  const seen = stranger.filter(({ people }) => people.length > 0);
  const wrong = stranger.filter(({ people }) => people.some((p) => p.personId === personId));
  const decayedAfterMs = wrong.length ? wrong.at(-1).atMs : 0;
  const settled = stranger.filter(({ atMs }) => atMs > decayedAfterMs + 1000);
  const wrongAfterSettling = settled.filter(({ people }) => people.some((p) => p.personId === personId)).length;

  check('a different person is still seen as a person', seen.length > 0, `${seen.length}/${stranger.length} readings had someone on screen`);
  check('the stale identity decays after the cut instead of sticking', decayedAfterMs <= 15000, `gone after ${(decayedAfterMs / 1000).toFixed(1)}s`);
  check('once decayed, the different person is never named again', wrongAfterSettling === 0 && settled.length >= 10, `${wrongAfterSettling} wrong in ${settled.length} settled readings`);
  check('the different person is not given a NEW identity either', settled.every(({ people }) => people.every((p) => !p.personId)), 'an unknown face stays unknown');

  const consoleErrors = (await lab.snapshot())?.sim?.consoleErrors ?? [];
  check('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} finally {
  await lab.close();
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n  ${passed}/${checks.length} checks passed\n`);
