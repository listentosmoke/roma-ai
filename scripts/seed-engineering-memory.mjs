// Register this repository as a project the background worker may run in, and
// seed engineering memory with what we already know about it.
//
//   node scripts/seed-engineering-memory.mjs [--db data/roma.db] [--dry-run]
//
// Why this exists: projects are an explicit ALLOWLIST (a worker is never handed
// a filesystem path invented in conversation), so until something registers
// "roma", asking Roma to run the tests here is correctly refused. And a worker
// that starts with no engineering memory re-derives the same facts — and
// repeats the same dead ends — on every task.
//
// Everything written here is a fact verified in this repository, not a guess.
// Re-running is safe: entries are matched by title and skipped if present.

import { openDatabase } from '../server/db/index.mjs';
import { createEngineeringMemory } from '../server/agentEnv/engineeringMemory.mjs';
import { loadAuthEnv } from '../server/auth.mjs';

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : undefined;
const dryRun = args.includes('--dry-run');

const PROJECT = {
  name: 'roma',
  rootPath: process.cwd(),
  defaultTestCmd: 'npm test',
};

const ENTRIES = [
  {
    kind: 'commands',
    title: 'Test, build, and verification commands',
    body: '`npm test` runs the full offline suite (681 tests, ~3s, no network or keys). `npm run build` produces the production bundle. `npm run preflight` reports subsystem states without printing secrets. `npm run verify:virtual-lab` is the full hardware-in-the-loop gauntlet and needs real Deepgram/Groq keys. `npm run verify:qwen-worker -- --write` verifies the real background worker end to end. The live scripts cost credits and are deliberately NOT part of `npm test`.',
    tags: ['testing', 'build'],
  },
  {
    kind: 'architecture',
    title: 'Browser does perception, in-process server holds the secrets',
    body: 'This is a Vite + React app whose API server runs as Vite plugins inside the SAME process — there is no second server and no extra port. Every provider key and the SQLite database live on the server side; the browser reaches them only through /api/* routes. Adding a route means adding it to a plugin in server/, not standing up a new service.',
    tags: ['architecture'],
  },
  {
    kind: 'db_structure',
    title: 'SQLite schema, migrations, and the agent-environment tables',
    body: 'SQLite through the built-in node:sqlite (Node 24+), at data/roma.db in WAL mode, or :memory: in tests. Migrations live in server/db/migrations/ (0001_init, 0002_voice_identity, 0003_sync_reliability, 0004_agent_environment), run on every open, and are idempotent and tracked in schema_migrations. Application IDs are TEXT primary keys. The agent environment owns eng_projects, eng_memory and agent_tasks — deliberately separate tables from the personal `memories` table, with no join between them.',
    tags: ['database', 'migrations'],
  },
  {
    kind: 'decision',
    title: 'Models advise; deterministic code decides',
    body: 'Speech approval (the Speech Gate is the sole authorizer), identity resolution, memory evidence rules, sensitivity policy and sync conflict handling are all plain code. A model recommendation can only ever be downgraded, never escalated. When changing behavior here, change the deterministic layer — do not try to fix it in the prompt.',
    tags: ['invariant'],
  },
  {
    kind: 'decision',
    title: 'Engineering memory must stay separate from personal memory',
    body: 'There is no code path from eng_memory into the conversational context builder (assembleContext), and none from personal memories into a worker task brief. The wearer\'s life and the project\'s build commands never mix, in either direction. A worker also cannot write memory itself — the dispatcher harvests structured `learnings` from its result.',
    tags: ['privacy', 'invariant'],
  },
  {
    kind: 'failed_approach',
    title: 'Nested objects in the Groq decision schema break constrained decoding',
    body: 'A nested `turn_analysis` object destabilized Groq structured output: runs failed with HTTP 400 failed_generation at /tool_calls/0/arguments, which exhausted provider retries and killed whole turns. It presented as the model "intermittently ignoring direct questions" about half the time. The fix was flattening to top-level scalars (addressed_to, wearer_expected_to_respond, assist_opportunity). A second attempt — making `arguments` a nullable union type — made it strictly worse and was reverted. Keep the decision schema flat.',
    tags: ['groq', 'schema'],
  },
  {
    kind: 'failed_approach',
    title: 'Blank task_update treated as fatal discarded whole decisions',
    body: 'Strict schema mode forces the model to emit a `task_update` object even when there is nothing to update. validateTaskUpdate treated that empty object as a validation failure and threw away the entire decision. A non-active, all-blank update now means "no update" and returns null.',
    tags: ['groq', 'schema'],
  },
  {
    kind: 'fix',
    title: 'A React hook once DOSed our own API and looked like a provider rate limit',
    body: 'useAgentTasks polled on an effect that depended on refresh/refreshRecent, whose identities change whenever the voice/speech deps do — many times a second while the microphone is live. Every re-render tore down the interval and fired an immediate poll, and the request storm tripped the app\'s OWN rate limiter, after which Roma truthfully told the wearer she was "rate-limited". Fixed by holding the callbacks in refs so the effect depends only on the client. Lesson: check your own request volume before blaming a provider.',
    tags: ['react', 'performance'],
  },
  {
    kind: 'known_bug',
    title: 'React duplicate-key warning during camera sessions',
    body: 'Running the Inspector (camera) produces a React duplicate-key warning in the console. Surfaced by the virtual hardware lab; not yet diagnosed. Harmless so far, but it means some list is keyed on a value that is not unique per render.',
    tags: ['react', 'inspector'],
  },
  {
    kind: 'known_bug',
    title: 'Deepgram does not separate synthetic Aura voices in the lab',
    body: 'When the virtual hardware lab plays multiple simulated speakers using Deepgram Aura TTS voices, Deepgram diarization tends to merge them into one speaker — the synthetic voices are too acoustically similar. Recorded human fixtures do separate correctly. Do not treat a diarization failure in a synthetic-voice scenario as a regression in the segmenter.',
    tags: ['deepgram', 'lab', 'diarization'],
  },
  {
    kind: 'codebase',
    title: 'Where things live',
    body: 'src/ holds the browser app, one directory per subsystem (engine, inspector, agent, proactive, voice, memory, identity, policy, simulation, server) plus one use*.js React hook each, composed in src/main.jsx. server/ holds the in-process API: routes/, repositories/ (all forWorkspace()-scoped), db/, voiceIdentity/, agentEnv/. scripts/ holds simulations and verification harnesses. test/ holds 56 offline test files run by `node --test`. Each subsystem has a matching *.md design doc at the repo root; HANDOFF.md is the orientation document.',
    tags: ['layout'],
  },
  {
    kind: 'decision',
    title: 'The background worker is restricted, verified, and cannot reach the wearer',
    body: 'Qwen Code offers a headless run 56 tools by default, including 35 computer_use__* tools that drive the real desktop, plus send_message, cron_*, web_fetch and subagent spawning. Roma narrows this with --core-tools, --exclude-tools and a system-settings overlay, then VERIFIES the tool list the CLI actually advertises and refuses to run if it is wider. Readonly mode relies on Qwen plan mode, which removes the write and shell tools from the registry entirely. Write mode requires explicit wearer approval and runs in a disposable git worktree, returning a patch. See AGENT-ENV.md.',
    tags: ['worker', 'security'],
  },
  {
    kind: 'deployment',
    title: 'Configuration and the fail-safe worker default',
    body: 'All configuration is in .env (gitignored; names documented in .env.example). AGENT_WORKER selects the background engine and defaults to `mock`; AGENT_WORKER=qwen runs the real CLI and needs AGENT_WORKER_API_KEY, which is the worker\'s own credential — it runs with a private QWEN_HOME and cannot borrow the developer\'s ~/.qwen login. selectWorker() forces the mock in any test run whatever .env says, because putting AGENT_WORKER=qwen in .env once turned `npm test` into a run that spawned five live CLI processes and spent real tokens.',
    tags: ['config', 'worker'],
  },
];

const db = openDatabase(dbPath ? { path: dbPath } : {});
const auth = loadAuthEnv();
const memory = createEngineeringMemory({ db }).forWorkspace(auth.devWorkspaceId, auth.devUserId);

console.log(`\nSeeding engineering memory for ${auth.devWorkspaceId}/${auth.devUserId}${dryRun ? ' (dry run)' : ''}`);

let project = memory.findProjectByName(PROJECT.name);
if (project) {
  console.log(`  project "${PROJECT.name}" already registered → ${project.rootPath}`);
} else if (dryRun) {
  console.log(`  would register project "${PROJECT.name}" → ${PROJECT.rootPath}`);
} else {
  const created = memory.createProject(PROJECT);
  if (!created.ok) { console.error('  failed to register project:', created.errors); process.exit(1); }
  project = created.project;
  console.log(`  registered project "${project.name}" → ${project.rootPath} (tests: ${project.defaultTestCmd})`);
}

const existingTitles = new Set(memory.list({ projectId: project?.projectId ?? null, limit: 200 }).map((entry) => entry.title));
let added = 0;
let skipped = 0;
for (const entry of ENTRIES) {
  if (existingTitles.has(entry.title)) { skipped += 1; continue; }
  if (dryRun) { console.log(`  would add [${entry.kind}] ${entry.title}`); added += 1; continue; }
  const result = memory.remember({ projectId: project.projectId, ...entry });
  if (!result.ok) { console.error(`  REJECTED [${entry.kind}] ${entry.title}:`, result.errors); continue; }
  console.log(`  + [${entry.kind}] ${entry.title}`);
  added += 1;
}

const counts = memory.counts();
console.log(`\n${added} added, ${skipped} already present. Engineering memory now holds ${counts.total} entries:`);
for (const [kind, n] of Object.entries(counts.byKind)) console.log(`  ${kind.padEnd(16)} ${n}`);
db.close();
