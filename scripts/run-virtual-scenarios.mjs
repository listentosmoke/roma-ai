#!/usr/bin/env node
// Generic virtual-lab scenario runner. Loads declarative scenarios from
// src/simulation/scenarios/ (plus any --file path), validates them against
// the schema, runs each against an isolated lab (fresh server+browser per
// scenario by default; --shared reuses one lab for speed), evaluates every
// assertion through the deterministic oracle, and writes JSON + Markdown
// reports to .simreports/. Exit code 1 if any required assertion failed.
//
//   node scripts/run-virtual-scenarios.mjs --family room
//   node scripts/run-virtual-scenarios.mjs --scenario echo_suppression_closed_loop
//   node scripts/run-virtual-scenarios.mjs --file my-scenario.json --visible

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateScenario } from '../src/simulation/schema.js';
import { createLab, runScenario, captureFailureArtifacts, writeReports } from './lib/virtualLab.mjs';
import { loadServerEnv } from '../server/env.mjs';

const SCENARIO_DIR = join(process.cwd(), 'src', 'simulation', 'scenarios');
const args = process.argv.slice(2);
const argValue = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const family = argValue('--family');
const scenarioName = argValue('--scenario');
const filePath = argValue('--file');
const headless = !args.includes('--visible');
const shared = args.includes('--shared');

const env = loadServerEnv();
if (!env.deepgramApiKey || !env.groqApiKey) {
  console.error('Virtual-lab scenarios need DEEPGRAM_API_KEY and GROQ_API_KEY (see .env.example). Aborting honestly instead of degrading to mocks.');
  process.exit(1);
}

function loadScenarios() {
  const scenarios = [];
  if (filePath) {
    scenarios.push(JSON.parse(readFileSync(filePath, 'utf8')));
  } else {
    for (const file of readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json')).sort()) {
      const scenario = JSON.parse(readFileSync(join(SCENARIO_DIR, file), 'utf8'));
      if (scenarioName && scenario.scenarioId !== scenarioName) continue;
      if (family && scenario.family !== family) continue;
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

const scenarios = loadScenarios();
if (!scenarios.length) { console.error('No scenarios matched.'); process.exit(1); }

console.log(`\nVirtual-lab scenario run — ${scenarios.length} scenario(s)${family ? ` (family: ${family})` : ''}`);
console.log('═══════════════════════════════════════════════════');

for (const scenario of scenarios) {
  const validation = validateScenario(scenario);
  if (!validation.ok) { console.error(`INVALID ${scenario.scenarioId ?? '?'}:\n  ${validation.errors.join('\n  ')}`); process.exit(1); }
}

let failures = 0;
let lab = null;
const summaries = [];
for (const scenario of scenarios) {
  console.log(`\n▶ ${scenario.scenarioId} — ${scenario.description ?? ''}`);
  try {
    lab ??= await createLab({ headless, seed: scenario.seed ?? 1 });
    const result = await runScenario(lab, scenario);
    const reports = writeReports(result);
    summaries.push({ scenarioId: scenario.scenarioId, passed: result.passed, report: reports.markdown });
    if (!result.passed) {
      failures += 1;
      const screenshot = await captureFailureArtifacts(lab, scenario.scenarioId);
      if (screenshot) console.log(`    failure screenshot: ${screenshot}`);
    }
    console.log(`  ${result.passed ? '✅ PASSED' : '❌ FAILED'} (${result.durationMs} ms) — report: ${reports.markdown}`);
  } catch (error) {
    failures += 1;
    summaries.push({ scenarioId: scenario.scenarioId, passed: false, error: error.message });
    console.log(`  ❌ ERROR: ${error.message.slice(0, 300)}`);
    if (lab) { await captureFailureArtifacts(lab, scenario.scenarioId).catch(() => {}); }
  }
  if (!shared && lab) { await lab.close().catch(() => {}); lab = null; }
  // Courtesy pause between scenarios: back-to-back runs stress CPU (fresh
  // Chrome + Vite + detector loads) and cloud-provider rate budgets, which
  // shows up as timing flakiness in playback/echo scenarios.
  await new Promise((resolve) => setTimeout(resolve, 8000));
}
if (lab) await lab.close().catch(() => {});

console.log('\n═══ Summary ═══');
for (const summary of summaries) console.log(`  ${summary.passed ? '✅' : '❌'} ${summary.scenarioId}${summary.error ? ` — ${summary.error.slice(0, 120)}` : ''}`);
console.log(`  ${summaries.filter((s) => s.passed).length}/${summaries.length} scenarios passed`);
process.exit(failures ? 1 : 0);
