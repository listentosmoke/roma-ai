// Scenario report generation: machine-readable JSON + human-readable
// Markdown, written to .simreports/ (gitignored). Redaction rules: no
// secrets, no biometric templates, no raw audio/video payloads — only
// bounded event/counter/transcript summaries.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPORT_DIR = join(process.cwd(), '.simreports');
const FORBIDDEN_KEY = /(template|embedding|ciphertext|plaintextKey|apiKey|authorization_header|audioBase64|wavBase64)/i;

/** Deep-copy while dropping any forbidden key and truncating long strings. */
export function redact(value, depth = 0) {
  if (depth > 8) return '[depth-capped]';
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 400).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) { out[key] = '[redacted]'; continue; }
      out[key] = redact(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function writeReports(result) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(REPORT_DIR, `${result.scenarioId}_${stamp}`);
  const safe = redact(result);
  writeFileSync(`${base}.json`, JSON.stringify(safe, null, 2));
  writeFileSync(`${base}.md`, toMarkdown(safe));
  return { json: `${base}.json`, markdown: `${base}.md` };
}

function toMarkdown(r) {
  const lines = [];
  lines.push(`# Scenario report — ${r.scenarioId} ${r.passed ? '✅ PASSED' : '❌ FAILED'}`);
  lines.push('');
  lines.push(`- Run: ${r.startedAt} → ${r.finishedAt} (${r.durationMs} ms)`);
  lines.push(`- Verification level: **${r.verificationLevel}**`);
  lines.push(`- Realism tier: ${r.visualTier ?? '(none)'} · environment: ${r.environment ?? '(none)'} · seed: ${r.seed ?? '(none)'}`);
  lines.push(`- Browser: ${r.browser ?? 'unknown'} · server: ${r.serverBaseUrl ?? 'unknown'} (isolated tenant ${r.workspaceId ?? '?'})`);
  lines.push('');
  lines.push('## Real vs simulated components');
  for (const [component, status] of Object.entries(r.components ?? {})) lines.push(`- ${component}: **${status}**`);
  lines.push('');
  lines.push('## Assertions');
  for (const a of r.assertions ?? []) {
    lines.push(`- ${a.pass ? '✅' : '❌'} \`${a.condition}\`${a.param ? ` (${a.param})` : ''}${a.negate ? ' [negated]' : ''} — ${a.detail}${a.message ? ` · ${a.message}` : ''}`);
  }
  lines.push('');
  lines.push('## What Roma heard (finalized transcript, from Deepgram — not injected)');
  for (const s of r.transcript ?? []) lines.push(`- [${s.speaker ?? '?'}] ${s.text}`);
  lines.push('');
  lines.push('## Ground truth (what the simulated people actually said)');
  for (const g of r.groundTruth ?? []) lines.push(`- [${g.person}] "${g.text}" (${g.provider})`);
  lines.push('');
  if (r.agentEvents?.length) {
    lines.push('## Agent decisions');
    for (const e of r.agentEvents) {
      lines.push(`- ${e.type}${e.turnId != null ? ` (turn ${e.turnId})` : ''}${e.decision ? ` → ${e.decision}` : ''}${e.reasonCode ? ` · ${e.reasonCode}` : ''}${e.stage ? ` · stage ${e.stage}` : ''}${e.message ? ` · ${e.message}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Timeline');
  for (const t of (r.timeline ?? []).slice(0, 150)) lines.push(`- +${t.atMs}ms ${t.kind}: ${t.detail}`);
  if (r.consoleErrors?.length) {
    lines.push('');
    lines.push('## Console errors');
    for (const e of r.consoleErrors) lines.push(`- ${e}`);
  }
  if (r.screenshots?.length) {
    lines.push('');
    lines.push('## Screenshots');
    for (const s of r.screenshots) lines.push(`- ${s}`);
  }
  if (r.notes?.length) {
    lines.push('');
    lines.push('## Notes / limitations');
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}
