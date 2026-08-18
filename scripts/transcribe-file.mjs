// Offline transcription + diarization of an audio/video file via Deepgram's
// pre-recorded API (more accurate than streaming for a whole file — it can look
// at all the audio to place speaker boundaries). Handy for checking accuracy
// against a reference.
//
//   node scripts/transcribe-file.mjs path/to/audio.wav [--model nova-3]
//
// Reads the key from VITE_DEEPGRAM_API_KEY (env or a local .env file).

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadKey() {
  if (process.env.VITE_DEEPGRAM_API_KEY) return process.env.VITE_DEEPGRAM_API_KEY;
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = /^\s*VITE_DEEPGRAM_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (match) return match[1].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/transcribe-file.mjs <audio-file> [--model nova-3]');
  process.exit(1);
}
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'nova-3';

const key = await loadKey();
if (!key) {
  console.error('No Deepgram key. Set VITE_DEEPGRAM_API_KEY in env or .env');
  process.exit(1);
}

const audio = await readFile(file);
const contentType = path.extname(file).toLowerCase() === '.wav' ? 'audio/wav'
  : path.extname(file).toLowerCase() === '.mp3' ? 'audio/mpeg'
  : path.extname(file).toLowerCase() === '.m4a' ? 'audio/mp4'
  : 'application/octet-stream';

const params = new URLSearchParams({
  model,
  diarize: 'true',
  punctuate: 'true',
  smart_format: 'true',
  utterances: 'true',
  language: 'en',
});

console.error(`Transcribing ${file} (${(audio.length / 1e6).toFixed(1)} MB) with Deepgram ${model}…`);
const started = Date.now();
const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
  method: 'POST',
  headers: { Authorization: `Token ${key}`, 'Content-Type': contentType },
  body: audio,
});
const payload = await response.json();
if (!response.ok) {
  console.error('Deepgram error:', JSON.stringify(payload));
  process.exit(1);
}

const utterances = payload.results?.utterances ?? [];
console.error(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s · ${utterances.length} utterances\n`);

// Collapse consecutive utterances from the same speaker into readable turns.
let currentSpeaker = null;
const lines = [];
for (const utterance of utterances) {
  const speaker = `Speaker ${(utterance.speaker ?? 0) + 1}`;
  if (speaker !== currentSpeaker) {
    lines.push(`\n[${speaker}] ${utterance.transcript}`);
    currentSpeaker = speaker;
  } else {
    lines[lines.length - 1] += ` ${utterance.transcript}`;
  }
}
console.log(lines.join('\n').trim());
const speakerCount = new Set(utterances.map((u) => u.speaker)).size;
console.error(`\n— ${speakerCount} speaker(s) detected —`);
