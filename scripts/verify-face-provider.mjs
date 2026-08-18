// F1 gate — prove the face encoder's MECHANICS.
//
//   node scripts/verify-face-provider.mjs                  # mechanics only
//   node scripts/verify-face-provider.mjs --images <dir>   # also detection
//
// What this proves: the pinned models download, pass their SHA-256 check, load,
// and produce well-formed L2-normalized 512-d embeddings that are deterministic
// for identical input and different for different input.
//
// What this does NOT prove: that the model recognises anyone correctly. That is
// an accuracy question, it needs real faces belonging to real people who agreed
// to it, and it belongs in HARDWARE-VERIFICATION.md — not in a script that
// could quietly turn into a false claim.
//
// No face images ship with this repository. Point --images at your own if you
// want the detection checks; a phase about consent should not begin by using
// someone's face without it.

import fs from 'node:fs';
import path from 'node:path';
import { createFaceProvider, cosineSimilarity, EMBED_DIMS, REPO, REVISION } from '../server/faceIdentity/provider.mjs';

const args = process.argv.slice(2);
const imagesDir = args.includes('--images') ? args[args.indexOf('--images') + 1] : null;

const checks = [];
function check(label, passed, detail = '') {
  checks.push({ label, passed });
  console.log(`  ${passed ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** A deterministic non-face image, for mechanics that must not need a face. */
async function syntheticImage(seed) {
  const { default: sharp } = await import('sharp');
  const size = 256;
  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    pixels[i * 3] = (i * 7 + seed * 53) % 256;
    pixels[i * 3 + 1] = (i * 13 + seed * 97) % 256;
    pixels[i * 3 + 2] = (i * 29 + seed * 11) % 256;
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

/** Landmarks roughly where a face would be, so embed() can run without detection. */
const SYNTHETIC_FACE = {
  score: 1,
  x1: 60, y1: 60, x2: 200, y2: 200,
  landmarks: [[100, 110], [160, 110], [130, 145], [105, 175], [155, 175]],
};

async function main() {
  console.log(`\nFace provider — ${REPO} @ ${REVISION.slice(0, 12)}`);
  const provider = createFaceProvider({ allowDownload: true });
  const described = provider.describe();
  console.log(`License: ${described.license} · liveness: ${described.liveness ? 'yes' : 'NO'}\n`);

  console.log('MECHANICS');
  let embeddingA;
  try {
    const imageA = await syntheticImage(1);
    embeddingA = await provider.embed(imageA, SYNTHETIC_FACE);
    check('the pinned models download, verify, and load', true);
    check(`the embedding is ${EMBED_DIMS}-dimensional`, embeddingA.length === EMBED_DIMS, `${embeddingA.length}`);
    const norm = Math.hypot(...embeddingA);
    check('the embedding is L2-normalized', Math.abs(norm - 1) < 1e-4, `‖v‖ = ${norm.toFixed(6)}`);
    check('the embedding is finite', embeddingA.every(Number.isFinite));

    const again = await provider.embed(imageA, SYNTHETIC_FACE);
    check('identical input gives an identical embedding', cosineSimilarity(embeddingA, again) > 0.99999, `cos = ${cosineSimilarity(embeddingA, again).toFixed(8)}`);

    const imageB = await syntheticImage(2);
    const embeddingB = await provider.embed(imageB, SYNTHETIC_FACE);
    const across = cosineSimilarity(embeddingA, embeddingB);
    check('different input gives a different embedding', across < 0.99, `cos = ${across.toFixed(4)}`);
    check('similarity is symmetric', Math.abs(across - cosineSimilarity(embeddingB, embeddingA)) < 1e-6);
    check('similarity is bounded to -1..1', across >= -1.0001 && across <= 1.0001);
  } catch (error) {
    check('the pinned models download, verify, and load', false, error.message);
  }

  console.log('\nINTEGRITY');
  try {
    const strict = createFaceProvider({ allowDownload: false });
    await strict.embed(await syntheticImage(3), SYNTHETIC_FACE);
    check('a cached, verified model loads without re-downloading', true);
  } catch (error) {
    check('a cached, verified model loads without re-downloading', false, error.message);
  }

  if (!imagesDir) {
    console.log('\nDETECTION — skipped. Pass --images <dir> with your own photographs to run it.');
    console.log('This script ships no faces, and detection cannot be judged without real ones.');
  } else {
    console.log(`\nDETECTION (${imagesDir})`);
    const files = fs.readdirSync(imagesDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
    check('the directory contains images', files.length > 0, `${files.length} file(s)`);
    const embeddings = [];
    for (const file of files) {
      const buffer = fs.readFileSync(path.join(imagesDir, file));
      const faces = await provider.detect(buffer);
      console.log(`    ${file}: ${faces.length} face(s)${faces.length ? ` (best score ${Math.max(...faces.map((f) => f.score)).toFixed(3)})` : ''}`);
      if (faces.length) {
        const best = faces.sort((a, b) => b.score - a.score)[0];
        embeddings.push({ file, vector: await provider.embed(buffer, best) });
      }
    }
    check('a face was detected in at least one image', embeddings.length > 0);
    if (embeddings.length > 1) {
      console.log('\n    pairwise cosine similarity (interpret yourself — this is not an accuracy claim):');
      for (let i = 0; i < embeddings.length; i += 1) {
        for (let j = i + 1; j < embeddings.length; j += 1) {
          console.log(`      ${embeddings[i].file} ↔ ${embeddings[j].file}: ${cosineSimilarity(embeddings[i].vector, embeddings[j].vector).toFixed(4)}`);
        }
      }
    }
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.label}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error('\nVerification crashed:', error); process.exit(1); });
