// Streaming diarization test harness.
//
// Streams a section of a local audio/video file to Deepgram's REALTIME WebSocket
// exactly like the browser app (same params, same PCM16 framing, same segmenter),
// then prints the speaker-labeled turns. This lets you iterate on diarization
// quality WITHOUT a live microphone.
//
//   node scripts/stream-test.mjs <audio-file> [--start 95] [--duration 160]
//                                [--speed 4] [--model nova-3]
//                                [--endpointing 300] [--utterance-end 1000]
//                                [--max-speakers 2]
//
// --speed N sends audio N× faster than real time (default 4; use 1 for the most
// faithful endpointing behaviour). Requires ffmpeg on PATH and VITE_DEEPGRAM_API_KEY
// in env or .env.

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { deepgramParams } from '../src/engine/deepgram.js';
import { createSegmenter } from '../src/engine/segmenter.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function loadKey() {
  if (process.env.VITE_DEEPGRAM_API_KEY) return process.env.VITE_DEEPGRAM_API_KEY;
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*VITE_DEEPGRAM_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('Usage: node scripts/stream-test.mjs <audio-file> [--start 95] [--duration 160] [--speed 4]');
  process.exit(1);
}
const start = Number(arg('start', 0));
const duration = Number(arg('duration', 160));
// Deepgram is a realtime service — sending much faster than ~2× real time means
// it hasn't ingested the later audio by the time we CloseStream, so results get
// cut off. 2× balances fidelity and iteration speed; use 1 for exact behaviour.
const speed = Number(arg('speed', 2));
const closeWaitMs = Number(arg('close-wait', Math.max(20000, Math.ceil((duration - (duration / Math.max(speed, 1)) + 10) * 1000))));
const settings = {
  model: arg('model', 'nova-3'),
  endpointingMs: Number(arg('endpointing', 300)),
  utteranceEndMs: Number(arg('utterance-end', 1000)),
};
const maxSpeakersArg = arg('max-speakers', '2');
const maxSpeakers = ['unlimited', 'none', 'false', '0'].includes(String(maxSpeakersArg).toLowerCase())
  ? undefined
  : Number(maxSpeakersArg);
const debugWords = flag('debug-words');

const key = loadKey();
if (!key) { console.error('No Deepgram key (VITE_DEEPGRAM_API_KEY in env or .env)'); process.exit(1); }

// Decode the requested section to mono 16 kHz signed-16 PCM via ffmpeg.
function decodePcm() {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', file, '-t', String(duration), '-ar', '16000', '-ac', '1', '-f', 's16le', '-']);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => process.stderr.write(d));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pcm = await decodePcm();
console.error(`Streaming ${(pcm.length / 32000).toFixed(1)}s of audio (${file} @${start}s) to Deepgram ${settings.model} at ${speed}× …\n`);

const segments = [];
const segmenter = createSegmenter((s) => {
  segments.push(s);
  const clock = `${String(Math.floor(s.startedAt / 60)).padStart(2, '0')}:${String(Math.floor(s.startedAt % 60)).padStart(2, '0')}`;
  console.log(`[${clock}] ${s.speaker}: ${s.text}`);
}, { maxSpeakers });

const url = `wss://api.deepgram.com/v1/listen?${deepgramParams(settings, 'en-US')}`;
const ws = new WebSocket(url, ['token', key]);

ws.addEventListener('message', (event) => {
  let msg; try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.type === 'UtteranceEnd') { segmenter.flush(); return; }
  if (msg.type !== 'Results') return;
  const alt = msg.channel?.alternatives?.[0];
  if (msg.is_final && alt?.words?.length) {
    if (debugWords) {
      const grouped = alt.words.map((word) => `${word.punctuated_word ?? word.word}/${word.speaker ?? 0}`).join(' ');
      console.error(`RAW ${msg.speech_final ? 'speech_final' : 'final'}: ${grouped}`);
    }
    segmenter.ingest(alt.words);
  }
});
ws.addEventListener('error', (e) => console.error('WS error:', e.message ?? e));

const closed = new Promise((resolve) => ws.addEventListener('close', (e) => {
  if (e.code !== 1000) console.error(`\nWS closed code=${e.code} reason=${e.reason || '(none)'} — 4xxx codes usually mean a bad API key.`);
  resolve();
}));

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

// Stream 100 ms frames, paced at real-time / speed.
const FRAME_BYTES = 3200; // 1600 samples * 2 bytes = 100 ms @16kHz
for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
  ws.send(pcm.subarray(offset, offset + FRAME_BYTES));
  await sleep(100 / speed);
}
// Tell Deepgram to finalize and close; wait for it to actually close so we
// receive the trailing results instead of cutting them off.
ws.send(JSON.stringify({ type: 'CloseStream' }));
await Promise.race([closed, sleep(closeWaitMs)]);
segmenter.flush();

const speakerCount = new Set(segments.map((s) => s.speaker)).size;
console.log(`\n— ${segments.length} turns, ${speakerCount} speaker(s) —`);
try { ws.close(); } catch { /* noop */ }
process.exit(0);
