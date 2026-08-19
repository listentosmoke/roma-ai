// Face identity — storage, encryption, and matching policy.
//
// These run OFFLINE against a deterministic fake encoder. The real 190 MB
// InsightFace model is exercised by scripts/verify-face-provider.mjs, which is
// opt-in: `npm test` must never download a model or need a camera.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db/index.mjs';
import { createTemplateCipher } from '../server/voiceIdentity/crypto.mjs';
import { createFaceTemplateRepository } from '../server/faceIdentity/templateRepository.mjs';
import { createFaceIdentityService } from '../server/faceIdentity/service.mjs';
import { cosineSimilarity, averageEmbeddings, faceQuality } from '../server/faceIdentity/provider.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');
const DIMS = 512;

/** A unit vector that is deterministic per seed and near-orthogonal across seeds. */
function vector(seed) {
  const raw = Float32Array.from({ length: DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1) * 0.7331));
  const norm = Math.hypot(...raw) || 1;
  return Float32Array.from(raw, (v) => v / norm);
}

function fixture({ requireConsent = false } = {}) {
  const db = openDatabase({ memory: true });
  const ins = db.prepare("INSERT INTO people (person_id, workspace_id, user_id, schema_version, display_name, status, identity_status, confidence, created_at, updated_at) VALUES (?,'ws','u',1,?,'active','resolved',1.0,1,1)");
  ins.run('p1', 'Person One');
  ins.run('p2', 'Person Two');

  // The "image" is a list of face seeds; the fake encoder just reads them.
  const provider = {
    describe: () => ({ provider: 'fake', repo: 'fake/model', revision: 'rev0', dims: DIMS, liveness: false }),
    async detect(buffer) {
      // Boxes are deliberately large enough to clear the quality gate; a test that
      // enrolled 10px faces would be testing a path real frames never take.
      return JSON.parse(buffer.toString()).map((face, index) => ({ score: face.score ?? 0.9, x1: index * 200, y1: 0, x2: index * 200 + 120, y2: 120, seed: face.seed, landmarks: [] }));
    },
    async embed(buffer, face) { return vector(face.seed); },
  };
  const repository = createFaceTemplateRepository({ db });
  const service = createFaceIdentityService({ db, provider, repository, requireConsent });
  const image = (list) => Buffer.from(JSON.stringify(list));
  return { db, service, repository, image };
}

test('a template round-trips exactly through storage', async () => {
  const f = fixture();
  const result = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) });
  assert.equal(result.ok, true);
  const stored = f.repository.forWorkspace('ws').openTemplate(result.profile.faceProfileId);
  assert.equal(stored.length, DIMS);
  assert.ok(cosineSimilarity(stored, vector(1)) > 0.9999, 'the stored template must be the embedding, undamaged');
  assert.equal(result.profile.template, undefined, 'the returned profile carries no template');
  f.db.close();
});

test('templates are stored WITHOUT at-rest encryption — a deliberate, recorded trade', async () => {
  // Decision: the device uses full-disk encryption, so the application layer was
  // removed (migration 0006). This test exists so that is a visible property of
  // the system rather than something discovered by reading a schema. It also
  // pins what was given up: the old AES-GCM layer bound a template to its
  // person, so a row edited to point elsewhere failed to open. It no longer can.
  const f = fixture();
  const enrolled = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) });
  const row = f.db.prepare('SELECT * FROM face_templates').get();
  assert.equal(row.encryption_algorithm, 'none');
  assert.ok(row.template_plain, 'the template is stored in the plaintext column');
  assert.equal(f.repository.status().atRestEncryption, false);

  f.db.prepare("UPDATE face_templates SET person_id = 'p2' WHERE face_profile_id = ?").run(enrolled.profile.faceProfileId);
  assert.notEqual(f.repository.forWorkspace('ws').openTemplate(enrolled.profile.faceProfileId), null,
    'a moved row now opens — the integrity binding went with the encryption');
  f.db.close();
});

test('a malformed template identifies nobody rather than scoring against anything', async () => {
  const f = fixture();
  const enrolled = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) });
  f.db.prepare('UPDATE face_templates SET template_plain = ? WHERE face_profile_id = ?').run('bm90LWEtdGVtcGxhdGU=', enrolled.profile.faceProfileId);
  assert.equal(f.repository.forWorkspace('ws').openTemplate(enrolled.profile.faceProfileId), null);
  f.db.close();
});

test('face identity no longer needs an encryption key to work', async () => {
  const f = fixture();
  assert.equal(f.repository.configured, true);
  assert.equal((await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) })).ok, true);
  f.db.close();
});

test('enrollment refuses an image with no face, or with more than one', async () => {
  const f = fixture();
  assert.equal((await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([]) })).reasonCode, 'no_face_detected');
  const many = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }, { seed: 2 }]) });
  assert.equal(many.reasonCode, 'multiple_faces', 'enrolling from a crowd could bind the wrong face to a name');
  f.db.close();
});

test('a known face matches and an unknown one matches nobody', async () => {
  const f = fixture();
  await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) });

  const known = await f.service.identify({ workspaceId: 'ws', imageBuffer: f.image([{ seed: 1 }]) });
  assert.equal(known.faces[0].match.personId, 'p1');
  assert.equal(known.faces[0].reasonCode, 'matched');

  const stranger = await f.service.identify({ workspaceId: 'ws', imageBuffer: f.image([{ seed: 42 }]) });
  assert.equal(stranger.faces[0].match, null);
  assert.equal(stranger.faces[0].reasonCode, 'below_threshold');
  f.db.close();
});

test('an ambiguous face resolves to NOBODY, never to whoever scored highest', async () => {
  // Two people enrolled on near-identical templates: the top score clears the
  // threshold, but not the runner-up by enough to be worth acting on.
  const f = fixture();
  const repo = f.repository.forWorkspace('ws');
  const near = vector(1);
  const alsoNear = Float32Array.from(near, (v, i) => (i === 0 ? v * 0.999 : v));
  repo.enroll({ personId: 'p1', embedding: near, provider: 'fake', model: 'm', modelRevision: 'r' });
  repo.enroll({ personId: 'p2', embedding: alsoNear, provider: 'fake', model: 'm', modelRevision: 'r' });

  const result = await f.service.identify({ workspaceId: 'ws', imageBuffer: f.image([{ seed: 1 }]) });
  assert.equal(result.faces[0].match, null, 'two lookalikes must not be collapsed into one');
  assert.equal(result.faces[0].reasonCode, 'ambiguous');
  assert.ok(result.faces[0].bestSimilarity > 0.4);
  f.db.close();
});

test('identification is workspace-scoped, so another tenant is invisible', async () => {
  const f = fixture();
  await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) });
  const other = await f.service.identify({ workspaceId: 'other_ws', imageBuffer: f.image([{ seed: 1 }]) });
  assert.equal(other.reasonCode, 'no_enrolled_profiles');
  f.db.close();
});

test('revoking stops a profile matching; deleting a person destroys the biometric', async () => {
  const f = fixture();
  const enrolled = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: f.image([{ seed: 1 }]) });
  f.repository.forWorkspace('ws').revoke(enrolled.profile.faceProfileId);
  const afterRevoke = await f.service.identify({ workspaceId: 'ws', imageBuffer: f.image([{ seed: 1 }]) });
  assert.equal(afterRevoke.reasonCode, 'no_enrolled_profiles');

  f.db.prepare('PRAGMA foreign_keys = ON').run();
  f.db.prepare("DELETE FROM people WHERE person_id = 'p1'").run();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM face_templates').get().n, 0, 'deleting a person must destroy their face template');
  f.db.close();
});

test('consent enforcement is a switch, and it is currently OFF', async () => {
  // Deliberate, documented state: face identity was integrated with consent
  // enforcement disabled. This test exists so turning it back on is a decision
  // someone makes on purpose, and so the default cannot drift unnoticed.
  const off = fixture({ requireConsent: false });
  assert.equal(off.service.describe().requireConsent, false);
  assert.match(off.service.describe().note, /CONSENT NOT ENFORCED/);
  assert.equal((await off.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: off.image([{ seed: 1 }]) })).ok, true);
  off.db.close();

  const on = fixture({ requireConsent: true });
  const blocked = await on.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffer: on.image([{ seed: 1 }]) });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reasonCode, 'active_consent_required', 'with the switch on, no consent record means no enrollment');
  on.db.close();
});

test('the encoder reports honestly that it does not do liveness', () => {
  const f = fixture();
  assert.equal(f.service.describe().liveness, false, 'a printed photograph may match; nothing may claim otherwise');
  f.db.close();
});

test('cosine similarity is bounded, symmetric, and 1 for an identical vector', () => {
  const a = vector(1);
  const b = vector(2);
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(a, b) - cosineSimilarity(b, a)) < 1e-9);
  assert.ok(cosineSimilarity(a, b) >= -1.0001 && cosineSimilarity(a, b) <= 1.0001);
  assert.equal(cosineSimilarity(a, null), 0);
  assert.equal(cosineSimilarity(a, new Float32Array(8)), 0, 'a dimension mismatch is never a match');
});

// ── browser-side recognizer ─────────────────────────────────────────────────

import { createFaceRecognizer, createServerFaceRecognizer } from '../src/inspector/faces.js';

const track = (id, box) => ({ id, bbox: box });

test('the default recognizer still labels nobody, honestly', async () => {
  const result = await createFaceRecognizer().identify({}, [track('t1', [0, 0, 10, 10])]);
  assert.deepEqual(result, [{ id: 't1', identity: null, personId: null, faceProfileId: null, confidence: 0, quality: 0 }]);
});

test('the server recognizer maps a matched face onto the person track it overlaps', async () => {
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'BASE64',
    post: async () => ({ faces: [{ box: { x1: 2, y1: 2, x2: 8, y2: 8 }, match: { personId: 'p1', faceProfileId: 'fp1', similarity: 0.91 }, quality: { ok: true, value: 0.88 } }] }),
    describePerson: (id) => (id === 'p1' ? 'Matt' : null),
    minIntervalMs: 0,
  });
  await recognizer.identify({}, [track('t1', [0, 0, 10, 10]), track('t2', [100, 100, 110, 110])]);
  const result = await recognizer.identify({}, [track('t1', [0, 0, 10, 10]), track('t2', [100, 100, 110, 110])]);
  assert.deepEqual(result, [
    { id: 't1', identity: 'Matt', personId: 'p1', faceProfileId: 'fp1', confidence: 0.91, quality: 0.88 },
    { id: 't2', identity: null, personId: null, faceProfileId: null, confidence: 0, quality: 0 },
  ]);
});

test('recognition is throttled and never queues a backlog of stale frames', async () => {
  let calls = 0;
  let clock = 10_000;
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'BASE64',
    post: async () => { calls += 1; return { faces: [{ box: { x1: 0, y1: 0, x2: 10, y2: 10 }, match: { personId: 'p1', similarity: 0.9 } }] }; },
    minIntervalMs: 1500,
    now: () => clock,
  });
  const tracks = [track('t1', [0, 0, 10, 10])];
  await recognizer.identify({}, tracks);
  await recognizer.identify({}, tracks);
  await recognizer.identify({}, tracks);
  assert.equal(calls, 1, 'three cycles inside the interval make one request');

  clock += 2000;
  const later = await recognizer.identify({}, tracks);
  assert.equal(calls, 2);
  assert.equal(later[0].personId, 'p1');
});

test('a skipped cycle keeps the previous label instead of flickering to unknown', async () => {
  let clock = 10_000;
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'BASE64',
    post: async () => ({ faces: [{ box: { x1: 0, y1: 0, x2: 10, y2: 10 }, match: { personId: 'p1', similarity: 0.9 } }] }),
    minIntervalMs: 1500,
    now: () => clock,
  });
  const tracks = [track('t1', [0, 0, 10, 10])];
  // Two spaced observations to confirm the identity…
  await recognizer.identify({}, tracks);
  clock += 2000;
  assert.equal((await recognizer.identify({}, tracks))[0].personId, 'p1');
  // …then a throttled cycle, which must report the settled vote, not a blank.
  assert.equal((await recognizer.identify({}, tracks))[0].personId, 'p1', 'throttled cycles keep the label');
});

test('a server failure degrades to unidentified, never breaking perception', async () => {
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'BASE64',
    post: async () => { throw new Error('offline'); },
  });
  const result = await recognizer.identify({}, [track('t1', [0, 0, 10, 10])]);
  assert.deepEqual(result, [{ id: 't1', identity: null, personId: null, faceProfileId: null, confidence: 0, quality: 0 }]);
});

test('recognition does not run at all when the camera or feature is off', async () => {
  let calls = 0;
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => { calls += 1; return 'BASE64'; },
    post: async () => ({ faces: [] }),
    enabled: () => false,
  });
  const result = await recognizer.identify({}, [track('t1', [0, 0, 10, 10])]);
  assert.equal(calls, 0, 'a disabled recognizer must not even encode the frame');
  assert.equal(result[0].identity, null);
});

test('a single frame never names anyone — identity needs repeated agreement', async () => {
  // Measured on a real 3 fps clip: per-frame identity is noisy, and a scene cut
  // can put a different person in the same track. One observation is a guess.
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'B',
    post: async () => ({ faces: [{ box: { x1: 0, y1: 0, x2: 10, y2: 10 }, match: { personId: 'p1', similarity: 0.9 } }] }),
    minIntervalMs: 0,
  });
  const tracks = [track('t1', [0, 0, 10, 10])];
  assert.equal((await recognizer.identify({}, tracks))[0].personId, null, 'one sighting is not an identification');
  assert.equal((await recognizer.identify({}, tracks))[0].personId, 'p1', 'two agreeing sightings are');
});

test('a confirmed identity survives one disagreeing frame but not a sustained one', async () => {
  let personId = 'p1';
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'B',
    post: async () => ({ faces: [{ box: { x1: 0, y1: 0, x2: 10, y2: 10 }, match: { personId, similarity: 0.9 } }] }),
    minIntervalMs: 0,
  });
  const tracks = [track('t1', [0, 0, 10, 10])];
  await recognizer.identify({}, tracks);
  assert.equal((await recognizer.identify({}, tracks))[0].personId, 'p1');

  personId = 'p2';
  assert.equal((await recognizer.identify({}, tracks))[0].personId, 'p1', 'one contrary frame must not rename someone');
  await recognizer.identify({}, tracks);
  await recognizer.identify({}, tracks);
  const settled = await recognizer.identify({}, tracks);
  assert.notEqual(settled[0].personId, 'p1', 'sustained disagreement does take effect');
});

test('a person who leaves is forgotten rather than remembered forever', async () => {
  let hasFace = true;
  const recognizer = createServerFaceRecognizer({
    encodeFrame: async () => 'B',
    post: async () => ({ faces: hasFace ? [{ box: { x1: 0, y1: 0, x2: 10, y2: 10 }, match: { personId: 'p1', similarity: 0.9 } }] : [] }),
    minIntervalMs: 0,
  });
  const tracks = [track('t1', [0, 0, 10, 10])];
  await recognizer.identify({}, tracks);
  assert.equal((await recognizer.identify({}, tracks))[0].personId, 'p1');

  hasFace = false;
  await recognizer.identify({}, tracks);
  await recognizer.identify({}, tracks);
  assert.equal((await recognizer.identify({}, tracks))[0].personId, null, 'the label decays once the face is gone');
});

// ── enrollment capture (the pure half of the People-panel flow) ─────────────

import { captureEnrollmentFrames, summarizeEnrollment, MAX_ENROLLMENT_IMAGES } from '../src/inspector/faceEnrollment.js';

test('enrollment captures several spaced frames, not one snapshot', async () => {
  // One frame binds a person to one pose and one lighting condition. The
  // spacing is the point: it is what gives the averaged template variety.
  const waits = [];
  let grabbed = 0;
  const images = await captureEnrollmentFrames({
    grabFrame: () => ({ id: (grabbed += 1) }),
    encodeFrame: async (frame) => `image_${frame.id}`,
    count: 5,
    intervalMs: 600,
    wait: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(images, ['image_1', 'image_2', 'image_3', 'image_4', 'image_5']);
  assert.deepEqual(waits, [600, 600, 600, 600], 'four gaps between five frames');
});

test('a frame the camera could not produce is skipped, not fatal', async () => {
  let call = 0;
  const images = await captureEnrollmentFrames({
    grabFrame: () => { call += 1; return call === 2 ? null : { id: call }; },
    encodeFrame: async (frame) => (frame.id === 3 ? null : `image_${frame.id}`),
    count: 4,
    wait: async () => {},
  });
  assert.deepEqual(images, ['image_1', 'image_4'], 'losing frames must not make the user start over');
});

test('an encoder that throws loses its frame and nothing else', async () => {
  const images = await captureEnrollmentFrames({
    grabFrame: () => ({}),
    encodeFrame: async () => { throw new Error('canvas is tainted'); },
    count: 3,
    wait: async () => {},
  });
  assert.deepEqual(images, []);
});

test('enrollment never posts more images than the server will average', async () => {
  const images = await captureEnrollmentFrames({
    grabFrame: () => ({}),
    encodeFrame: async () => 'image',
    count: 50,
    wait: async () => {},
  });
  assert.equal(images.length, MAX_ENROLLMENT_IMAGES);
});

test('the enrollment summary says what was dropped and why', () => {
  assert.match(
    summarizeEnrollment({ ok: true, samplesUsed: 3, rejected: ['no_face_detected', 'face_turned_away'] }, { captured: 5 }),
    /Enrolled from 3 of 5 frames\. Dropped 2: no face in shot, the face was turned away\./,
  );
  assert.match(summarizeEnrollment({ ok: false, reasonCode: 'face_too_small' }), /too far from the camera.*Nothing was stored/);
  assert.match(summarizeEnrollment(null), /did not complete/);
});
