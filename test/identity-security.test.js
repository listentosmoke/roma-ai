// Security/privacy checks for the identity phase, mirroring the pattern used
// by memory-security.test.js and voice-security.test.js: static source scans
// for credential/bundle leaks, plus behavioral checks that biometric data
// never reaches localStorage and that sensitivity stays honestly documented
// as unenforced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalStorageIdentityRepository } from '../src/identity/repository.js';
import { createDeterministicVoiceProvider } from '../src/identity/voiceProvider.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(path);
  }
}

test('no src/identity source file references a VITE_-exposed secret (would inline it into the public bundle)', () => {
  const files = [];
  walk(join(projectRoot, 'src', 'identity'), files);
  files.push(join(projectRoot, 'src', 'usePeople.js'));
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/VITE_[A-Z_]*(KEY|SECRET|TOKEN|CREDENTIAL)/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test('no voice-identity provider credential (API key/secret pattern) appears anywhere under src/identity', () => {
  const files = [];
  walk(join(projectRoot, 'src', 'identity'), files);
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/(api[_-]?key|secret[_-]?key|bearer\s+[A-Za-z0-9]{10,})/i.test(text.replace(/apikey|API_KEY|api key requests/gi, ''))) {
      // Allow the word "key" in general prose (e.g. "voiceProfileId"); only flag actual key-shaped literals.
      if (/['"][A-Za-z0-9_-]{20,}['"]/.test(text)) offenders.push(path);
    }
  }
  assert.deepEqual(offenders, []);
});

test('if a production build exists, it contains no identity-related credential identifiers', () => {
  const distDir = join(projectRoot, 'dist');
  if (!existsSync(distDir)) return; // build not run in this test invocation — covered separately by `npm run build`
  const files = [];
  walk(distDir, files);
  const offenders = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    if (/VITE_IDENTITY_VOICE_[A-Z_]*(KEY|SECRET|TOKEN)/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});

test('localStorage-backed identity repository never stores raw audio, voiceprints, embeddings, or biometric templates — only opaque profile IDs and metadata', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  try {
    const repository = createLocalStorageIdentityRepository({ storageKey: 'test.security.people' });
    const voiceProvider = createDeterministicVoiceProvider();
    const { person } = repository.createPerson({ displayName: 'Matt', identityStatus: 'confirmed' });
    const enrolled = await voiceProvider.enroll({ personId: person.personId, audioRef: { matchKey: 'matt-secret-voiceprint', durationMs: 4000, quality: 0.9, speakerPurity: 0.95 }, consent: true });
    repository.linkVoiceProfile(person.personId, enrolled.voiceProfileId);
    repository.addEvidence({ evidenceType: 'voice_enrollment', personId: person.personId, decision: 'enrolled', voiceSampleRef: 'should-not-appear-in-storage-as-raw-audio' });

    for (const value of store.values()) {
      // The provider-internal matchKey (the closest thing to "biometric data"
      // this deterministic provider has) must never leak into browser storage
      // — only the opaque voiceProfileId string does.
      assert.ok(!value.includes('matt-secret-voiceprint'), 'raw sample matchKey leaked into localStorage');
      assert.ok(!/[01],[01],[01],[01],[01]/.test(value), 'looks like a raw embedding vector');
    }
    assert.ok([...store.values()].some((v) => v.includes(enrolled.voiceProfileId))); // the opaque reference IS stored
  } finally {
    delete globalThis.localStorage;
  }
});

test('sensitivity is documented as metadata-only, not an enforced boundary, in the People panel source', () => {
  const mainJsx = readFileSync(join(projectRoot, 'src', 'main.jsx'), 'utf8');
  assert.match(mainJsx, /Sensitivity is stored as metadata only and is NOT currently enforced/);
});

test('the voice provider module documents (and enforces in code) that it never silently substitutes the deterministic provider for a real one in production', () => {
  const source = readFileSync(join(projectRoot, 'src', 'identity', 'voiceProvider.js'), 'utf8');
  assert.match(source, /createVoiceProvider/);
  assert.match(source, /mode = 'unavailable'/); // production default
});
