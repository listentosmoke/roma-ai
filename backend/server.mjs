import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkTranscript, formatPercent, summarizeBenchmarkCases } from '../src/benchmark.js';

const PORT = Number(process.env.PORT ?? process.env.ROMA_BACKEND_PORT ?? 8787);
const MAX_AUDIO_BYTES = Number(process.env.ROMA_MAX_AUDIO_BYTES ?? 80 * 1024 * 1024);
const COMMAND = process.env.ROMA_STT_DIARIZE_COMMAND ?? '';

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Accept',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`Request body exceeded ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function extensionFor(contentType = '') {
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('ogg')) return '.ogg';
  if (contentType.includes('flac')) return '.flac';
  return '.audio';
}

function renderCommand(template, audioPath, outputPath) {
  return template
    .replaceAll('{audio}', JSON.stringify(audioPath))
    .replaceAll('{output}', JSON.stringify(outputPath));
}

function runCommand(command, timeoutMs = Number(process.env.ROMA_STT_TIMEOUT_MS ?? 30 * 60 * 1000)) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function handleBenchmark(request, response) {
  const body = await readBody(request);
  const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
  const metrics = benchmarkTranscript(payload);
  sendJson(response, 200, { metrics });
}

async function handleSelfBenchmark(response) {
  const summary = summarizeBenchmarkCases();
  sendJson(response, 200, {
    summary,
    report: {
      averageWer: formatPercent(summary.averageWer),
      averageDer: formatPercent(summary.averageDer),
      totalReferenceWords: summary.totalReferenceWords,
      totalReferenceDurationMs: summary.totalReferenceDurationMs,
    },
  });
}

async function handleTranscribeDiarize(request, response) {
  if (!COMMAND) {
    sendJson(response, 501, {
      error: 'Backend diarization command is not configured.',
      configure:
        'Set ROMA_STT_DIARIZE_COMMAND, for example: python backend/whisperx_diarize.py --audio {audio} --output {output} --model small --hf-token $HF_TOKEN',
    });
    return;
  }

  const contentType = request.headers['content-type'] ?? '';
  const audio = await readBody(request, MAX_AUDIO_BYTES);
  if (!audio.length) {
    sendJson(response, 400, { error: 'Upload raw audio bytes with an audio/* Content-Type.' });
    return;
  }

  const workspace = path.join(tmpdir(), `roma-ai-${randomUUID()}`);
  const audioPath = path.join(workspace, `input${extensionFor(contentType)}`);
  const outputPath = path.join(workspace, 'output.json');

  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(audioPath, audio);
    const startedAt = performance.now();
    const command = renderCommand(COMMAND, audioPath, outputPath);
    const { stdout, stderr } = await runCommand(command);
    const processingSeconds = (performance.now() - startedAt) / 1000;
    const output = JSON.parse(await readFile(outputPath, 'utf8'));

    sendJson(response, 200, {
      ...output,
      processingSeconds,
      backend: {
        commandConfigured: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function route(request, response) {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      commandConfigured: Boolean(COMMAND),
      maxAudioBytes: MAX_AUDIO_BYTES,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/self-benchmark') {
    await handleSelfBenchmark(response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/benchmark') {
    await handleBenchmark(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/transcribe-diarize') {
    await handleTranscribeDiarize(request, response);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

const { createServer } = await import('node:http');
const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    sendJson(response, 500, {
      error: error.message,
      stderr: error.stderr,
      stdout: error.stdout,
    });
  });
});

server.listen(PORT, () => {
  const filename = fileURLToPath(import.meta.url);
  console.log(`Roma AI backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Server: ${filename}`);
  console.log(`True diarization command configured: ${Boolean(COMMAND)}`);
});
