#!/usr/bin/env node
// Fetch the face fixtures the live face verification needs.
//
// These are NOT committed. They are photographs of real people, and a
// repository is a bad place to keep those — so they live in a gitignored
// directory and this script pulls them on demand.
//
// Provenance: ageitgey/face_recognition's example assets, at pinned commits.
// The stills are official US government portraits (public domain, 17 U.S.C.
// § 105); the clips are the project's own example footage of a stage cast.
//
// Two DIFFERENT recordings of the same people are needed — enrolling and
// verifying against the same file proves only that decoding is deterministic.
// The clips also contain several people across scene cuts, which is what
// makes correct REJECTION testable rather than assumed.
//
// Run: npm run fetch:face-fixtures

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'test', 'fixtures', 'faces');

// Pinned per file: the stills and the clips were last touched by different
// commits, and a ref that has one does not necessarily have the other.
const RAW = 'https://raw.githubusercontent.com/ageitgey/face_recognition';
const STILLS = 'e15120e6ba08cde1216607d2eb27e0eb0f0ea37c';
const CLIPS = 'f37e636e22306d4efcc35fb1ef33d47183cfc5e7';

export const FIXTURES = [
  { file: 'enroll.mp4', url: `${RAW}/${CLIPS}/examples/short_hamilton_clip.mp4`, note: 'live footage — enrollment through the camera' },
  { file: 'verify.mp4', url: `${RAW}/${CLIPS}/examples/hamilton_clip.mp4`, note: 'a DIFFERENT, longer recording of the same people — verification' },
  { file: 'enroll.jpg', url: `${RAW}/${STILLS}/examples/obama.jpg`, note: 'official portrait — still-image fallback' },
  { file: 'verify.jpg', url: `${RAW}/${STILLS}/examples/obama2.jpg`, note: 'a DIFFERENT photograph of the same person' },
  { file: 'impostor.jpg', url: `${RAW}/${STILLS}/examples/biden.jpg`, note: 'a different person — must not match' },
];

/** @returns {{ ready: boolean, missing: string[] }} */
export function fixtureState() {
  const missing = FIXTURES.filter(({ file }) => {
    const path = join(FIXTURE_DIR, file);
    return !existsSync(path) || statSync(path).size < 1024;
  }).map(({ file }) => file);
  return { ready: missing.length === 0, missing };
}

export function fixturePath(file) {
  return join(FIXTURE_DIR, file);
}

async function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const { file, url, note } of FIXTURES) {
    const path = join(FIXTURE_DIR, file);
    if (existsSync(path) && statSync(path).size > 1024) {
      console.log(`  have  ${file}  (${note})`);
      continue;
    }
    process.stdout.write(`  fetch ${file}  (${note}) ... `);
    const response = await fetch(url);
    if (!response.ok) { console.log(`FAILED ${response.status}`); process.exitCode = 1; continue; }
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    console.log(`${statSync(path).size} bytes`);
  }
  console.log(`\nFixtures in ${FIXTURE_DIR} (gitignored).`);
}

// Runs directly (`node scripts/fetch-face-fixtures.mjs`) but stays importable,
// so the verification script can ask whether the fixtures are present.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
