// Security: neither the Deepgram key nor any TTS key may be referenceable from
// client code (a referenced VITE_ var is inlined into the public bundle), and if
// a built bundle exists it must not contain the forbidden identifiers either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Only VITE_-prefixed identifiers are inlined into the bundle by Vite, so those
// are the ones that would leak a secret if referenced from client code. (Plain
// DEEPGRAM_API_KEY / TTS_API_KEY appearing in comments or error strings is
// harmless — it is never a value read in the browser.) We assert client code
// references none of the legacy VITE_ key names.
const FORBIDDEN_IN_SRC = [
  'VITE_DEEPGRAM_API_KEY',
  'VITE_GROQ_API_KEY',
  'VITE_TTS_API_KEY',
];

function scan(dir, predicate, offenders) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path, predicate, offenders);
    else if (/\.(js|jsx|mjs)$/.test(name)) {
      const text = readFileSync(path, 'utf8');
      for (const needle of FORBIDDEN_IN_SRC) if (predicate(text, needle)) offenders.push(`${path} :: ${needle}`);
    }
  }
}

test('no client source file references a Deepgram or TTS key identifier', () => {
  const offenders = [];
  scan('src', (text, needle) => text.includes(needle), offenders);
  assert.deepEqual(offenders, [], `forbidden key identifier(s) found in client source:\n${offenders.join('\n')}`);
});

// If a production bundle has been built, prove the literal identifiers are absent
// from it too. Skipped (not failed) when there is no dist/ yet.
test('built client bundle contains no Deepgram or TTS key identifier', (t) => {
  if (!existsSync('dist')) { t.skip('no dist/ — run `npm run build` first'); return; }
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|css|html)$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        for (const needle of ['VITE_DEEPGRAM_API_KEY', 'VITE_GROQ_API_KEY', 'VITE_TTS_API_KEY']) {
          if (text.includes(needle)) offenders.push(`${path} :: ${needle}`);
        }
      }
    }
  };
  walk('dist');
  assert.deepEqual(offenders, [], `forbidden identifier(s) found in built bundle:\n${offenders.join('\n')}`);
});
