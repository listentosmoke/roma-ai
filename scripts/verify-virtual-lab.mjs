#!/usr/bin/env node
// Full virtual-lab verification gauntlet:
//   1. offline simulation tests (schema/oracle/fixtures/isolation/security)
//   2. production build + bundle exclusion proof (test re-run against dist)
//   3. Mode A + Mode B smoke (simulate-virtual-hardware)
//   4. the complete scenario library through real providers
// Produces per-scenario JSON/Markdown reports in .simreports/ and exits
// nonzero if any required step fails.

import { spawnSync } from 'node:child_process';
import { loadServerEnv } from '../server/env.mjs';

const steps = [];
function run(label, command, args, { required = true } = {}) {
  console.log(`\n━━━ ${label} ━━━`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  const passed = result.status === 0;
  steps.push({ label, passed, required });
  if (!passed) console.error(`  ✖ step failed: ${label}`);
  return passed;
}

const env = loadServerEnv();
if (!env.deepgramApiKey || !env.groqApiKey) {
  console.error('verify:virtual-lab requires DEEPGRAM_API_KEY and GROQ_API_KEY — the primary scenarios use real providers by design.');
  process.exit(1);
}

run('Offline simulation tests', process.execPath, ['--test', 'test/simulation-schema.test.js', 'test/simulation-lab.test.js']);
run('Production build', process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
run('Bundle simulation-exclusion proof', process.execPath, ['--test', '--test-name-pattern', 'production bundle', 'test/simulation-lab.test.js']);
run('Mode A + Mode B closed-loop smoke', process.execPath, ['scripts/simulate-virtual-hardware.mjs']);
run('Complete scenario library (real providers)', process.execPath, ['scripts/run-virtual-scenarios.mjs']);

console.log('\n═══ verify:virtual-lab summary ═══');
for (const step of steps) console.log(`  ${step.passed ? '✅' : '❌'} ${step.label}`);
const failed = steps.filter((step) => step.required && !step.passed);
console.log(failed.length ? `\n  ${failed.length} required step(s) failed` : '\n  All required steps passed');
process.exit(failed.length ? 1 : 0);
