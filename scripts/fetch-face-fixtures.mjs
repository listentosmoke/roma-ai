#!/usr/bin/env node
// Fetch the face fixtures the live face verification needs.
//
// These are NOT committed. They are photographs of real people, and a
// repository is a bad place to keep those — so they live in a gitignored
// directory and this script pulls them on demand.
//
// Provenance: official US government portraits, which are public domain
// (17 U.S.C. § 105), mirrored in ageitgey/face_recognition's examples at a
// pinned commit. Two different photographs of the SAME person are needed —
// enrolling and verifying against the same file proves only that JPEG
// decoding is deterministic.
//
// Run: npm run fetch:face-fixtures

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'test', 'fixtures', 'faces');

const PINNED = 'https://raw.githubusercontent.com/ageitgey/face_recognition/e15120e6ba08cde1216607d2eb27e0eb0f0ea37c/examples';

export const FIXTURES = [
  { file: 'enroll.jpg', url: `${PINNED}/obama.jpg`, note: 'official portrait — enrollment' },
  { file: 'verify.jpg', url: `${PINNED}/obama2.jpg`, note: 'a DIFFERENT photograph of the same person — verification' },
  { file: 'impostor.jpg', url: `${PINNED}/biden.jpg`, note: 'a different person — must not match' },
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
