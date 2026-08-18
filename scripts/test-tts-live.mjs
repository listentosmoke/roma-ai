// LIVE TTS verification — makes ONE real speech-synthesis call through the same
// provider the server route uses, then plays or saves the audio through the
// normal playback/provider path. Not part of the offline test suite; run
// manually to confirm the configured TTS provider + key + voice work end to end:
//
//   npm run test:tts-live
//   npm run test:tts-live -- --text "Hello from Roma." --voice Fritz-PlayAI --out roma.wav
//
// Requires server-side TTS credentials (TTS_API_KEY, or GROQ_API_KEY as the
// default). Prints provider, model, voice, content type, byte size, duration,
// and latency, and exits clearly if the provider is unavailable. The audio is
// written to a .wav so you can listen (no speaker is available in Node).

import { writeFileSync } from 'node:fs';
import { loadServerEnv } from '../server/env.mjs';
import { createTtsProvider, TtsProviderError } from '../src/voice/ttsProvider.js';
import { prepareSpeechText } from '../src/voice/speechPrep.js';
import { createAuthorizationRegistry } from '../src/voice/authorization.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const env = loadServerEnv();
for (const warning of env.warnings) console.error(`! ${warning}`);
if (!env.tts.apiKey) {
  console.error('No TTS credentials found (TTS_API_KEY or GROQ_API_KEY) in the environment or .env — cannot run the live TTS test.');
  process.exit(1);
}

const rawText = arg('text', 'Roma voice check. The wrench is in the lower-right.');
const voice = arg('voice', env.tts.voice);
const model = arg('model', env.tts.model);
// Deepgram Aura returns MP3 by default; Groq PlayAI returns WAV. Pick a sensible
// default extension for the provider (overridable with --out).
const defaultOut = (env.tts.provider === 'groq' || env.tts.provider === 'groq-tts') ? 'roma-tts.wav' : 'roma-tts.mp3';
const outPath = arg('out', defaultOut);

// Prepare exactly as the delivery layer would (strip markdown, refuse junk).
const prep = prepareSpeechText(rawText);
if (!prep.ok) { console.error(`Refusing to synthesize: ${prep.reason}`); process.exit(1); }

// Mint an authorization the way the pipeline does — proving nothing synthesizes
// without a gate-approved authorization even in this manual path.
const registry = createAuthorizationRegistry();
const authorization = registry.mint({ approved: true, reason: 'manual live TTS test' }, {
  sourceType: 'test', sourceId: 'tts_live', text: prep.text, delivery: 'speak_now', lifetimeMs: 60000,
});

console.error(`Provider: ${env.tts.provider}`);
console.error(`Model: ${model} · Voice: ${voice}`);
console.error(`Text: "${prep.text}"\n`);

const provider = createTtsProvider({ provider: env.tts.provider, apiKey: env.tts.apiKey, model, voice, baseUrl: env.tts.baseUrl });

try {
  if (!registry.canStart(authorization.authorizationId)) throw new Error('authorization was not valid');
  const out = await provider.synthesize({ text: prep.text, voice, model, authorizationId: authorization.authorizationId, turnId: 'tts_live' });
  registry.consume(authorization.authorizationId);
  writeFileSync(outPath, out.audio);
  console.log('── Synthesized ──');
  console.log(`  provider       ${out.provider}`);
  console.log(`  model          ${out.model}`);
  console.log(`  voice          ${out.voice}`);
  console.log(`  content type   ${out.contentType}`);
  console.log(`  byte size      ${out.byteLength} bytes (${(out.byteLength / 1024).toFixed(1)} KB)`);
  console.log(`  duration       ${out.durationMs ?? 'unknown'} ms`);
  console.log(`  provider latency ${out.providerLatencyMs} ms`);
  console.log(`\n  saved to       ${outPath}  (open it to listen)`);
  // Let the process exit naturally — a hard process.exit() here races undici's
  // socket teardown on Windows and trips a libuv assertion.
} catch (error) {
  if (error instanceof TtsProviderError) {
    console.error(`TTS provider error [${error.code}]: ${error.message}`);
    if (error.code === 'auth') console.error('Check TTS_API_KEY / GROQ_API_KEY, or whether your account has access to the configured TTS_MODEL/voice.');
  } else {
    console.error(`Live TTS test failed: ${error.message}`);
  }
  process.exitCode = 1;
}
