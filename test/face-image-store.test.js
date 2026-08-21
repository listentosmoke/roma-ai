// Enrollment images kept as redundancy for the face templates.
//
// This reverses an earlier "no image is ever stored" decision, so the tests
// that matter are the boundaries: only enrollment frames, never recognition
// frames; deletion really deletes; and nothing can write outside the store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFaceImageStore } from '../server/faceIdentity/imageStore.mjs';
import { createFaceIdentityService } from '../server/faceIdentity/service.mjs';
import { createFaceTemplateRepository } from '../server/faceIdentity/templateRepository.mjs';
import { openDatabase } from '../server/db/index.mjs';

/** Smallest thing that passes a JPEG sniff: SOI … EOI. */
function jpeg(payload = 'x') {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(payload.repeat(64)), Buffer.from([0xff, 0xd9])]);
}

function store() {
  return createFaceImageStore({ root: mkdtempSync(join(tmpdir(), 'roma-face-images-')) });
}

test('enrollment images are written, listed, and read back byte for byte', () => {
  const images = store();
  const original = jpeg('abc');
  assert.deepEqual(images.save({ workspaceId: 'w1', faceProfileId: 'face_1', images: [original, jpeg('def')] }), { ok: true, stored: 2 });

  const listed = images.list({ workspaceId: 'w1', faceProfileId: 'face_1' });
  assert.equal(listed.length, 2);
  assert.deepEqual(images.read({ workspaceId: 'w1', faceProfileId: 'face_1', name: listed[0].name }), original);
});

test('anything that is not actually an image is refused', () => {
  const images = store();
  const result = images.save({ workspaceId: 'w1', faceProfileId: 'face_1', images: [Buffer.from('<html>not an image</html>'), Buffer.alloc(0)] });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'no_usable_images');
});

test('an id that is not an id cannot reach the filesystem', () => {
  const images = store();
  for (const faceProfileId of ['../escape', 'a/b', '..', 'x'.repeat(200), '']) {
    assert.equal(images.save({ workspaceId: 'w1', faceProfileId, images: [jpeg()] }).ok, false, `accepted ${faceProfileId}`);
    assert.equal(images.read({ workspaceId: 'w1', faceProfileId, name: '00.jpg' }), null);
  }
  assert.equal(images.read({ workspaceId: 'w1', faceProfileId: 'face_1', name: '../../secret.txt' }), null);
});

test('deleting a profile deletes its pictures — not just its row', () => {
  const images = store();
  images.save({ workspaceId: 'w1', faceProfileId: 'face_1', images: [jpeg(), jpeg('b')] });
  const removed = images.remove({ workspaceId: 'w1', faceProfileId: 'face_1' });
  assert.deepEqual(removed, { ok: true, removed: 2 });
  assert.deepEqual(images.list({ workspaceId: 'w1', faceProfileId: 'face_1' }), []);
});

test('one workspace cannot see another workspace\'s enrollments', () => {
  const images = store();
  images.save({ workspaceId: 'w1', faceProfileId: 'face_1', images: [jpeg()] });
  assert.deepEqual(images.list({ workspaceId: 'w2', faceProfileId: 'face_1' }), []);
  assert.equal(images.read({ workspaceId: 'w2', faceProfileId: 'face_1', name: '00.jpg' }), null);
});

test('a store that cannot be written to does not fail the enrollment', () => {
  // The template is what identifies someone; the pictures are the backup.
  const broken = createFaceImageStore({ root: '\0invalid' });
  const result = broken.save({ workspaceId: 'w1', faceProfileId: 'face_1', images: [jpeg()] });
  assert.equal(result.ok, false);
  assert.equal(result.stored, 0);
});

// ── the boundary that matters: only ENROLLMENT frames ─────────────────────

const DIMS = 512;
function vector(seed) {
  const raw = Float32Array.from({ length: DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1) * 0.7331));
  const norm = Math.hypot(...raw) || 1;
  return Float32Array.from(raw, (v) => v / norm);
}

function fixture() {
  const db = openDatabase({ memory: true });
  db.prepare("INSERT INTO people (person_id, workspace_id, user_id, schema_version, display_name, status, identity_status, confidence, created_at, updated_at) VALUES ('p1','ws','u',1,'Person One','active','resolved',1.0,1,1)").run();
  const provider = {
    describe: () => ({ provider: 'fake', repo: 'fake/model', revision: 'rev0', dims: DIMS, liveness: false }),
    async detect(buffer) {
      // The "image" carries its seed after the JPEG header bytes.
      const seed = Number(buffer.subarray(2, buffer.length - 2).toString().replace(/[^0-9]/g, '') || 1);
      return [{ score: 0.9, x1: 0, y1: 0, x2: 120, y2: 120, seed, landmarks: [] }];
    },
    async embed(buffer, face) { return vector(face.seed); },
  };
  const imageStore = store();
  const service = createFaceIdentityService({ db, provider, repository: createFaceTemplateRepository({ db }), imageStore });
  return { db, service, imageStore };
}

test('enrolling keeps the frames the template came from', async () => {
  const f = fixture();
  const result = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffers: [jpeg('1'), jpeg('1')] });
  assert.equal(result.ok, true);
  assert.equal(result.imagesStored, 2);
  assert.equal(f.imageStore.list({ workspaceId: 'ws', faceProfileId: result.profile.faceProfileId }).length, 2);
  f.db.close();
});

test('IDENTIFYING keeps nothing — the continuous frames are still dropped', async () => {
  const f = fixture();
  const enrolled = await f.service.enroll({ workspaceId: 'ws', personId: 'p1', imageBuffers: [jpeg('1')] });
  const before = f.imageStore.counts({ workspaceId: 'ws' });

  for (let i = 0; i < 5; i += 1) await f.service.identify({ workspaceId: 'ws', imageBuffer: jpeg('1') });

  assert.deepEqual(f.imageStore.counts({ workspaceId: 'ws' }), before, 'recognition must never accumulate a recording');
  assert.equal(before.images, 1);
  assert.ok(enrolled.ok);
  f.db.close();
});

test('the service reports whether it is keeping images at all', async () => {
  const f = fixture();
  assert.equal(f.service.describe().keepsEnrollmentImages, true);

  const db = openDatabase({ memory: true });
  const withoutStore = createFaceIdentityService({ db, provider: { describe: () => ({ provider: 'fake', repo: 'r', revision: 'v', dims: DIMS, liveness: false }), detect: async () => [], embed: async () => vector(1) }, repository: createFaceTemplateRepository({ db }) });
  assert.equal(withoutStore.describe().keepsEnrollmentImages, false);
  db.close();
  f.db.close();
});
