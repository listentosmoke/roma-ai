// Dependency-free Chrome automation for the virtual-hardware lab: launches an
// ISOLATED headless Chrome (temporary profile, controlled flags) and drives it
// over the DevTools protocol using Node 24's built-in WebSocket. Playwright
// 1.61 exists in the machine's tool cache but is deliberately not required —
// this keeps the lab runnable with zero new dependencies.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.ROMA_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('No Chrome/Edge executable found. Set ROMA_CHROME_PATH.');
}

/**
 * @param {{ headless?: boolean, fakeDevices?: boolean, fakeAudioFile?: string, fakeVideoFile?: string, extraFlags?: string[] }} options
 */
export async function launchChrome({ headless = true, fakeDevices = false, fakeAudioFile = null, fakeVideoFile = null, extraFlags = [] } = {}) {
  const executable = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'roma-lab-profile-'));
  const flags = [
    ...(headless ? ['--headless=new'] : []),
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--use-fake-ui-for-media-stream', // auto-grant permission prompts (isolated profile only)
    ...(fakeDevices ? ['--use-fake-device-for-media-stream'] : []),
    ...(fakeAudioFile ? [`--use-file-for-fake-audio-capture=${fakeAudioFile}`] : []),
    ...(fakeVideoFile ? [`--use-file-for-fake-video-capture=${fakeVideoFile}`] : []),
    ...extraFlags,
    'about:blank',
  ];
  const child = spawn(executable, flags, { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  let waited = 0;
  while (!existsSync(portFile) && waited < 20000) { await new Promise((resolve) => setTimeout(resolve, 100)); waited += 100; }
  if (!existsSync(portFile)) { child.kill(); throw new Error('Chrome did not expose DevToolsActivePort.'); }
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0].trim());
  return {
    executable,
    profile,
    port,
    process: child,
    async close() {
      try { child.kill(); } catch { /* already gone */ }
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 400)); }
      }
    },
  };
}

/** Minimal CDP session over the browser's page target. */
export async function connectPage(port, { pageUrl = null } = {}) {
  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResponse.json();
  const page = targets.find((t) => t.type === 'page' && (!pageUrl || t.url.startsWith(pageUrl))) ?? targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target available.');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket failed.')); });

  let nextId = 0;
  const pending = new Map();
  const eventListeners = new Map();
  const consoleMessages = [];
  const networkFailures = [];

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method) {
      if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'error' || message.params.type === 'warning')) {
        if (consoleMessages.length < 300) consoleMessages.push({ type: message.params.type, text: (message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        if (consoleMessages.length < 300) consoleMessages.push({ type: 'exception', text: String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? '').slice(0, 300) });
      }
      if (message.method === 'Network.loadingFailed') {
        if (networkFailures.length < 300) networkFailures.push({ url: '', errorText: message.params.errorText, canceled: message.params.canceled });
      }
      const listener = eventListeners.get(message.method);
      if (listener) listener(message.params);
    }
  };

  function send(method, params = {}) {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(`CDP ${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  return {
    send,
    on: (method, listener) => eventListeners.set(method, listener),
    consoleMessages,
    networkFailures,
    /** Evaluate an expression; returns by value; throws on page exception. */
    async evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
      const result = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('evaluate timed out')), timeoutMs)),
      ]);
      if (result.exceptionDetails) throw new Error(`Page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      return result.result?.value;
    },
    async navigate(url) {
      await send('Page.navigate', { url });
      for (let waited = 0; waited < 20000; waited += 200) {
        const ready = await this.evaluate('document.readyState', { awaitPromise: false }).catch(() => null);
        if (ready === 'complete') return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('Page never reached readyState=complete');
    },
    async injectOnNewDocument(source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
    /** Block URLs matching the given patterns (real network-boundary fault injection). */
    async setBlockedUrls(patterns) { await send('Network.setBlockedURLs', { urls: patterns }); },
    async setOffline(offline) { await send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); },
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
}

/** Poll an in-page expression until it is truthy or the bounded timeout elapses. */
export async function waitForPage(cdp, expression, { timeoutMs = 15000, stepMs = 200, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await cdp.evaluate(expression).catch(() => null);
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`Timed out waiting for: ${label} (last=${JSON.stringify(lastValue)?.slice(0, 120)})`);
}
