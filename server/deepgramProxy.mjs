// Server-side Deepgram streaming proxy. The browser opens a WebSocket to the dev
// server at /api/deepgram/stream (no credentials); this module accepts it and
// opens a matching upstream WebSocket to Deepgram authenticated with the
// server-side DEEPGRAM_API_KEY, then pipes audio frames up and transcription
// messages down. The key never reaches the client — and unlike temporary-token
// grants, this works with any Deepgram key (streaming keys can't always mint
// grant tokens).
//
// Attached to Vite's underlying Node httpServer via the 'upgrade' event, so it
// runs inside `npm run dev` / `npm run preview` with no second process.

import { WebSocketServer, WebSocket } from 'ws';

const STREAM_PATH = '/api/deepgram/stream';
const DEEPGRAM_WS = 'wss://api.deepgram.com/v1/listen';

export function attachDeepgramProxy(httpServer, { apiKey, log = console, voiceIdentity = null, WebSocketImpl = WebSocket } = {}) {
  if (!httpServer || httpServer.__romaDeepgramProxy) return; // attach once
  httpServer.__romaDeepgramProxy = true;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return; }
    if (pathname !== STREAM_PATH) return; // let Vite HMR and others handle their own upgrades

    if (!apiKey) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => bridge(client, req, apiKey, log, voiceIdentity, WebSocketImpl));
  });
}

export function bridgeDeepgramClient(client, req, apiKey, log, voiceIdentity, WebSocketImpl = WebSocket) {
  // Forward the browser's query params (model, diarize, endpointing, …) upstream.
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstream = new WebSocketImpl(`${DEEPGRAM_WS}${query}`, ['token', apiKey]);

  const pendingToUpstream = [];
  let upstreamOpen = false;
  let activeCapture = null;

  upstream.addEventListener('open', () => {
    upstreamOpen = true;
    for (const chunk of pendingToUpstream) upstream.send(chunk);
    pendingToUpstream.length = 0;
  });
  upstream.addEventListener('message', (event) => {
    if (client.readyState === client.OPEN) client.send(event.data);
  });
  upstream.addEventListener('close', (event) => {
    if (client.readyState === client.OPEN) client.close(event.code === 1006 ? 1011 : event.code, event.reason);
  });
  upstream.addEventListener('error', () => {
    log.warn?.('[deepgram-proxy] upstream error');
    if (client.readyState === client.OPEN) client.close(1011, 'upstream error');
  });

  client.on('message', (data, isBinary) => {
    // Audio PCM frames (binary) and control JSON (text, e.g. CloseStream).
    const payload = isBinary ? data : data.toString();
    if (!isBinary) {
      let control = null;
      try { control = JSON.parse(payload); } catch { /* ordinary Deepgram control */ }
      if (control?.type === 'VoiceCaptureStart') {
        activeCapture = { operationId: control.operationId, captureToken: control.captureToken };
        client.send(JSON.stringify({ type: 'VoiceCaptureStatus', operationId: control.operationId, state: 'capturing' }));
        return;
      }
      if (control?.type === 'VoiceCaptureStop') {
        const operationId = activeCapture?.operationId ?? control.operationId;
        activeCapture = null;
        client.send(JSON.stringify({ type: 'VoiceCaptureStatus', operationId, state: 'stopped' }));
        return;
      }
    }
    if (isBinary && activeCapture && voiceIdentity) {
      const captured = voiceIdentity.appendFrame({ ...activeCapture, chunk: data });
      if (!captured.ok) {
        client.send(JSON.stringify({ type: 'VoiceCaptureStatus', operationId: activeCapture.operationId, state: 'rejected', reasonCode: captured.reasonCode }));
        activeCapture = null;
      }
    }
    if (upstreamOpen) upstream.send(payload);
    else pendingToUpstream.push(payload);
  });
  client.on('close', () => { try { upstream.close(); } catch { /* noop */ } });
  client.on('error', () => { try { upstream.close(); } catch { /* noop */ } });
}

const bridge = bridgeDeepgramClient;
