// LIVE vision verification — makes ONE real Groq vision call. Not part of the
// offline test suite; run manually when you want to confirm the configured
// vision model + key actually work end to end:
//
//   npm run test:vision-live                    — uses test/fixtures/tools.jpg
//   npm run test:vision-live -- --image path.jpg --target "hammer"
//
// Requires GROQ_API_KEY (env or .env; VITE_-prefixed legacy name accepted with
// a warning). Prints the validated structured result plus preparation and
// provider latency, and exits non-zero with a clear message if credentials or
// model access are missing.

import { existsSync, readFileSync } from 'node:fs';
import { loadServerEnv } from '../server/env.mjs';
import { createGroqVisionProvider, VisionProviderError } from '../src/vision/provider.js';
import { createVisionAnalyzer } from '../src/vision/analyzer.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const env = loadServerEnv();
for (const warning of env.warnings) console.error(`! ${warning}`);
if (!env.groqApiKey) {
  console.error('No GROQ_API_KEY found in the environment or .env — cannot run the live vision test.');
  process.exit(1);
}

const imagePath = arg('image', 'test/fixtures/tools.jpg');
if (!existsSync(imagePath)) {
  console.error(`Image not found: ${imagePath}`);
  process.exit(1);
}
const target = arg('target', 'adjustable wrench');
const question = arg('question', `Which visible tool or tool-like shape is most likely the ${target}, and where is it in the image?`);

const imageBytes = readFileSync(imagePath);
const frame = { dataUrl: `data:image/jpeg;base64,${imageBytes.toString('base64')}` };

console.error(`Model: ${env.visionModel}`);
console.error(`Image: ${imagePath} (${(imageBytes.length / 1024).toFixed(1)} KB)`);
console.error(`Question: ${question}\n`);

const analyzer = createVisionAnalyzer({
  provider: createGroqVisionProvider({ apiKey: env.groqApiKey, model: env.visionModel, baseUrl: env.baseUrl }),
});

try {
  const outcome = await analyzer.analyze({
    frame,
    frameAt: Date.now(),
    question,
    target,
    sceneContext: '- (no local detector hints for this test image)',
  });
  console.log('── Validated structured result ──');
  console.log(JSON.stringify(outcome.result, null, 2));
  console.log('\n── Latency ──');
  console.log(`  image preparation  ${outcome.prepMs} ms  (${outcome.prepared.bytes} bytes sent${outcome.prepared.resized ? ', resized' : ', passthrough'})`);
  console.log(`  provider           ${outcome.providerMs} ms`);
  console.log(`  total              ${outcome.totalMs} ms`);
  if (outcome.usage) console.log(`  tokens             ${outcome.usage.total_tokens ?? '?'}`);
  // Let the process exit naturally — a hard process.exit() here races undici's
  // socket teardown on Windows and trips a libuv assertion.
} catch (error) {
  if (error instanceof VisionProviderError) {
    console.error(`Vision provider error [${error.code}]: ${error.message}`);
    if (error.code === 'auth') console.error('Check GROQ_API_KEY, or whether your account has access to the configured VISION_MODEL.');
  } else {
    console.error(`Live vision test failed: ${error.message}`);
  }
  process.exitCode = 1;
}
