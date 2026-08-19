#!/usr/bin/env node
// Live face verification — the browser leg, end to end, with real models.
//
// Everything else about face identity is tested offline against a fake
// encoder, or server-side against still images. This script is the only thing
// that exercises the path a real user actually takes:
//
//   virtual camera (a REAL MediaStreamTrack) -> Roma's UNMODIFIED camera
//   source -> real COCO-SSD person detection -> the tracker -> the face
//   recognizer -> POST /api/face/identify -> real SCRFD + ArcFace -> the
//   match associated back onto the right person track -> temporal voting ->
//   the scene state the agent reads.
//
// That association step is why this exists: the two halves measure boxes in
// different units, and when they disagreed nothing failed loudly — every face
// simply went unrecognised. A unit test with an invented track shape had
// "covered" it.
//
// A photograph is drawn into the virtual room large enough for COCO-SSD to
// see a person and for SCRFD to find the face inside it. It is a photograph of
// a photograph, and it is honest about being one: what it proves is plumbing,
// association, and voting with real models — NOT recognition accuracy, which
// needs real faces on real hardware (see HARDWARE-VERIFICATION.md). It is also
// a live demonstration that a printed photograph matches: there is no liveness
// check, and this script is what that fact looks like.
//
// Run: npm run verify:face-live        (add --visible to watch)
// Fixtures: npm run fetch:face-fixtures  (photographs, never committed)

import { readFileSync } from 'node:fs';
import { createLab } from './lib/virtualLab.mjs';
import { fixtureState, fixturePath, FIXTURE_DIR } from './fetch-face-fixtures.mjs';

const headless = !process.argv.includes('--visible');
const checks = [];
function check(label, condition, details = '') {
  const pass = Boolean(condition);
  checks.push({ label, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${details ? ` (${details})` : ''}`);
  if (!pass) process.exitCode = 1;
}

console.log('\nLive face verification (virtual camera -> real models -> scene state)');
console.log('═════════════════════════════════════════════════════════════════════');

const fixtures = fixtureState();
if (!fixtures.ready) {
  console.log(`\n  SKIPPED — missing fixtures: ${fixtures.missing.join(', ')}`);
  console.log(`  These are photographs of real people and are never committed.`);
  console.log(`  Fetch them with:  npm run fetch:face-fixtures`);
  console.log(`  (they land in ${FIXTURE_DIR})\n`);
  process.exit(0);
}

const dataUrl = (file) => `data:image/jpeg;base64,${readFileSync(fixturePath(file)).toString('base64')}`;

/** Draw a photograph into the virtual room, replacing whatever was there. */
async function showFace(lab, file) {
  return lab.cdp.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(dataUrl(file))});
    const bitmap = await createImageBitmap(await response.blob());
    window.__romaSim.removeObject('face_photo');
    // Centred and large: the frame is 1280x720, and a face has to clear the
    // encoder's minimum size after the camera's own scaling.
    window.__romaSim.addObject('face_photo', { kind: 'photo_asset', x: 470, y: 120, width: 340, asset: bitmap, z: 100000 });
    return true;
  })()`);
}

/** Empty the room and wait until the scene agrees it is empty. */
async function clearRoom(lab) {
  await lab.cdp.evaluate(`window.__romaSim.removeObject('face_photo')`);
  return waitForScene(lab, (people) => people.length === 0, { timeoutMs: 30000, label: 'room empty' });
}

async function sceneIdentities(lab) {
  const snapshot = await lab.snapshot();
  return snapshot?.app?.scene?.peopleIdentified ?? [];
}

/** Poll the scene until `predicate` holds, or give up. Returns the last reading. */
async function waitForScene(lab, predicate, { timeoutMs = 25000, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await sceneIdentities(lab);
    if (predicate(last)) return { ok: true, people: last };
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  return { ok: false, people: last, label };
}

const lab = await createLab({ headless, seed: 7 });
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

  // ── the camera sees a person with a real face ────────────────────────────
  await lab.command('environment.load', { profile: 'quiet_office' });
  check('a photograph is drawn into the virtual room', await showFace(lab, 'enroll.jpg'));

  await lab.ui('camera');
  // Every lab run gets a fresh Chrome profile, so the first camera start
  // downloads and warms COCO-SSD (~6 MB) from a CDN. That routinely takes
  // minutes here, and it is worth waiting out rather than reporting as a
  // face failure — so it is waited on separately, with progress.
  const cameraStarted = await (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + 300000;
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
  check('the camera starts and the object detector loads', cameraStarted != null, cameraStarted != null ? `${cameraStarted}s` : 'timed out after 300s');

  const detected = await waitForScene(lab, (people) => people.length > 0, { timeoutMs: 60000, label: 'person detected' });
  check('real COCO-SSD detects a person in the rendered frame', detected.ok, `${detected.people.length} person track(s)`);
  check('nobody is identified before anyone is enrolled', detected.people.every((p) => !p.personId));

  // ── enrol through the REAL panel button ──────────────────────────────────
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

  // Five frames, 600ms apart, then a round trip through the encoder.
  const enrolled = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const profiles = await fetch(`${lab.server.baseUrl}/api/face/profiles`).then((r) => r.json());
      if ((profiles.profiles ?? []).length) return profiles.profiles[0];
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }
    return null;
  })();
  check('enrollment stored a template from the live camera', Boolean(enrolled), enrolled ? `${enrolled.sampleCount} sample(s), quality ${enrolled.aggregateQuality?.toFixed?.(2)}` : 'no profile appeared');
  check('the template belongs to the right person', enrolled?.personId === personId);
  check('several frames were averaged, not one snapshot', (enrolled?.sampleCount ?? 0) > 1, `sampleCount=${enrolled?.sampleCount}`);

  const evidence = await fetch(`${lab.server.baseUrl}/api/data/people/${personId}/evidence`).then((r) => r.json());
  const enrollmentEvidence = (evidence.evidence ?? []).find((e) => e.evidenceType === 'face_enrollment');
  check('enrollment left a face_enrollment evidence trail', Boolean(enrollmentEvidence), enrollmentEvidence?.reasonCode ?? 'none');
  check('the evidence names the template it came from', enrollmentEvidence?.faceProfileId === enrolled?.faceProfileId);

  // ── recognition of a DIFFERENT photograph of the same person ─────────────
  // Empty the room first. Votes are dropped when a track disappears, so the
  // next reading is a fresh judgement about the NEW photograph rather than a
  // confidence carried over from the enrollment frames — without this the
  // check reports ~1.00 and quietly proves much less than it claims.
  await clearRoom(lab);
  await showFace(lab, 'verify.jpg');
  const recognised = await waitForScene(lab, (people) => people.some((p) => p.personId === personId), { timeoutMs: 60000, label: 'recognised' });
  const match = recognised.people.find((p) => p.personId === personId);
  check('a DIFFERENT photograph of the same person is recognised through the camera', recognised.ok, match ? `similarity ${match.confidence}` : JSON.stringify(recognised.people));
  check('the match is associated with the person track, not floating free', Boolean(match), 'this is the coordinate-space bug that had no real coverage');
  check('the recognised person is named, not shown as a record id', match?.identity === 'Fixture Person', match?.identity ?? 'null');
  // A genuine cross-photograph score sits well below a re-encode of the same
  // image. A ~1.00 here would mean the room never actually changed.
  check('the score is a cross-photograph score, not the enrollment image again', match != null && match.confidence >= 0.5 && match.confidence <= 0.95, `similarity ${match?.confidence}`);

  // ── an impostor must not inherit the label ───────────────────────────────
  await clearRoom(lab);
  await showFace(lab, 'impostor.jpg');
  const forgotten = await waitForScene(lab, (people) => people.every((p) => p.personId !== personId), { timeoutMs: 40000, label: 'forgotten' });
  check('a different person does NOT inherit the enrolled identity', forgotten.ok, JSON.stringify(forgotten.people));

  const consoleErrors = (await lab.snapshot())?.sim?.consoleErrors ?? [];
  check('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} finally {
  await lab.close();
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n  ${passed}/${checks.length} checks passed\n`);
