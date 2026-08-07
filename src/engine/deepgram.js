// Deepgram streaming engine: real-time transcription + speaker diarization +
// endpointing (pause/turn detection), all server-side.
//
// Mic → PCM16 @16kHz → WebSocket → Deepgram. Deepgram streams finalized words with
// speaker indices; the shared segmenter (segmenter.js) turns those into clean
// speaker turns. That same segmenter runs in scripts/stream-test.mjs, so the Node
// harness tests exactly this logic.

import { createMicCapture } from '../audio.js';
import { createSegmenter } from './segmenter.js';

// Query params used for the Deepgram realtime connection. Shared with the test
// harness so both connect identically.
export function deepgramParams(settings, language) {
  return new URLSearchParams({
    model: settings.model ?? 'nova-3',
    language: language ?? 'en-US',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: String(settings.endpointingMs ?? 300),
    utterance_end_ms: String(settings.utteranceEndMs ?? 1000),
    vad_events: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });
}

export function createDeepgramEngine(config) {
  const settings = config.deepgram ?? {};
  const capture = createMicCapture();
  let socket = null;
  let handlers = null;
  let listening = false;
  const speakersSeen = new Set();
  const captureWaiters = new Map();

  let segmenter = null;

  // Build the streaming URL. By default the browser connects to the LOCAL proxy
  // path (server/deepgramProxy.mjs), which authenticates to Deepgram with the
  // server-side key — the key never reaches the client. A directly-configured
  // apiKey (manual override, not a VITE_ var) still connects straight to Deepgram.
  function streamTarget() {
    const params = deepgramParams(settings, config.language);
    if (settings.apiKey) {
      return { url: `${settings.endpoint}?${params}`, protocols: ['token', settings.apiKey] };
    }
    const proxyPath = settings.proxyPath ?? '/api/deepgram/stream';
    const wsProtocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof location !== 'undefined' ? location.host : 'localhost:5173';
    return { url: `${wsProtocol}//${host}${proxyPath}?${params}`, protocols: undefined };
  }

  async function start(nextHandlers) {
    handlers = nextHandlers;
    listening = true;
    speakersSeen.clear();
    segmenter = createSegmenter((segment) => {
      speakersSeen.add(segment.speaker);
      handlers?.onSegment?.({ id: crypto.randomUUID(), ...segment });
      handlers?.onSpeakers?.([...speakersSeen]);
      handlers?.onInterim?.('');
    }, { maxSpeakers: settings.maxSpeakers });

    handlers.onStatus?.('Connecting to Deepgram…');
    const { url, protocols } = streamTarget();
    socket = new WebSocket(url, protocols);

    socket.onopen = async () => {
      try {
        await capture.start(
          (pcm16) => { if (listening && socket.readyState === WebSocket.OPEN) socket.send(pcm16); },
          (level) => handlers.onLevel?.(level),
        );
        handlers.onStatus?.('Listening · Deepgram');
      } catch (error) {
        handlers.onError?.(error.message || 'Microphone error.');
        stop();
      }
    };

    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      if (message.type === 'VoiceCaptureStatus') {
        handlers?.onVoiceCaptureStatus?.(message);
        const waiter = captureWaiters.get(`${message.operationId}:${message.state}`);
        if (waiter) { captureWaiters.delete(`${message.operationId}:${message.state}`); waiter(message); }
        return;
      }

      if (message.type === 'UtteranceEnd') {
        segmenter?.flush(); // longer-silence backstop closes the current turn
        return;
      }
      if (message.type !== 'Results') return;

      const alternative = message.channel?.alternatives?.[0];
      if (message.is_final) {
        // We deliberately do NOT flush on speech_final (a 300ms pause) — that
        // fragmented one turn into many. Turns close on a real speaker change
        // (inside these words) or an UtteranceEnd.
        if (alternative?.words?.length) segmenter?.ingest(alternative.words);
      } else if (alternative?.transcript) {
        handlers.onInterim?.(alternative.transcript);
      }
    };

    socket.onerror = () => handlers.onError?.('Deepgram socket error. Check the API key and network.');
    socket.onclose = (event) => {
      if (listening) {
        handlers.onStatus?.(event.wasClean ? 'Disconnected.' : `Disconnected (${event.code}). Check the API key.`);
        listening = false;
        capture.stop();
      }
    };
  }

  function stop() {
    listening = false;
    segmenter?.flush(); // flush the final open turn so it isn't lost
    segmenter = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* noop */ }
    }
    try { socket?.close(); } catch { /* noop */ }
    socket = null;
    capture.stop();
  }

  function waitForCaptureStatus(operationId, state, timeoutMs = 2000) {
    return new Promise((resolve) => {
      const key = `${operationId}:${state}`;
      const timer = setTimeout(() => { captureWaiters.delete(key); resolve({ type: 'VoiceCaptureStatus', operationId, state: 'timeout' }); }, timeoutMs);
      captureWaiters.set(key, (message) => { clearTimeout(timer); resolve(message); });
    });
  }

  async function startVoiceCapture({ operationId, captureToken }) {
    if (!operationId || !captureToken || socket?.readyState !== WebSocket.OPEN) return { state: 'unavailable' };
    const acknowledged = waitForCaptureStatus(operationId, 'capturing');
    socket.send(JSON.stringify({ type: 'VoiceCaptureStart', operationId, captureToken }));
    return acknowledged;
  }

  async function stopVoiceCapture(operationId) {
    if (socket?.readyState !== WebSocket.OPEN) return { state: 'unavailable' };
    const acknowledged = waitForCaptureStatus(operationId, 'stopped');
    socket.send(JSON.stringify({ type: 'VoiceCaptureStop', operationId }));
    return acknowledged;
  }

  return { mode: 'deepgram', start, stop, startVoiceCapture, stopVoiceCapture, labels: () => [...speakersSeen] };
}
