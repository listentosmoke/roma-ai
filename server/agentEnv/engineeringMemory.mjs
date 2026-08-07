// Engineering memory — what the SERVER AGENT knows about codebases.
//
// Deliberately separate from src/memory/ (the wearer's personal memory).
// Personal memory is about people, preferences, commitments, and
// conversations, and it is compiled into Roma's conversational context.
// Engineering memory is about repositories: architecture, build/test
// commands, database structure, fixes that worked, bugs that are known,
// decisions that were made, approaches that FAILED, deployment facts. It is
// only ever compiled into a worker's task brief.
//
// There is no code path from here into assembleContext(), and none from
// personal memory into a task brief. That separation is structural (different
// tables, different module tree), not a convention.

import { createKeywordScorer } from '../../src/memory/embeddings.js';

export const ENG_MEMORY_KINDS = [
  'codebase', 'architecture', 'commands', 'db_structure', 'fix',
  'known_bug', 'decision', 'failed_approach', 'deployment', 'task_note',
];

const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_TAGS = 10;
const MAX_TAG = 40;

function bounded(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? text.slice(0, max) : text;
}

function toJson(value) { return JSON.stringify(value ?? []); }
function fromJson(text, fallback) { try { return JSON.parse(text ?? ''); } catch { return fallback; } }

function rowToMemory(row) {
  return {
    memoryId: row.memory_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: fromJson(row.tags, []),
    sourceTaskId: row.source_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEngineeringMemory({ db, now = Date.now } = {}) {
  let counter = 0;

  function forWorkspace(workspaceId, userId) {
    const api = {
      // ── projects (the allowlist of places a worker may operate) ──────────
      createProject({ name, rootPath, defaultTestCmd = null, projectId = null }) {
        const cleanName = bounded(name, 120);
        const cleanRoot = bounded(rootPath, 500);
        if (!cleanName || !cleanRoot) return { ok: false, errors: ['project name and rootPath are required'] };
        counter += 1;
        const id = projectId || `proj_${now()}_${counter}`;
        const at = now();
        db.prepare('INSERT OR REPLACE INTO eng_projects (project_id, workspace_id, user_id, name, root_path, default_test_cmd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, workspaceId, userId, cleanName, cleanRoot, defaultTestCmd ? bounded(defaultTestCmd, 200) : null, at, at);
        return { ok: true, project: api.getProject(id) };
      },

      getProject(projectId) {
        const row = db.prepare('SELECT * FROM eng_projects WHERE project_id = ? AND workspace_id = ?').get(projectId, workspaceId);
        if (!row) return null;
        return { projectId: row.project_id, name: row.name, rootPath: row.root_path, defaultTestCmd: row.default_test_cmd, createdAt: row.created_at };
      },

      findProjectByName(name) {
        const row = db.prepare('SELECT * FROM eng_projects WHERE workspace_id = ? AND LOWER(name) = LOWER(?)').get(workspaceId, String(name ?? ''));
        return row ? api.getProject(row.project_id) : null;
      },

      listProjects() {
        return db.prepare('SELECT * FROM eng_projects WHERE workspace_id = ? ORDER BY created_at').all(workspaceId)
          .map((row) => ({ projectId: row.project_id, name: row.name, rootPath: row.root_path, defaultTestCmd: row.default_test_cmd }));
      },

      // ── memory records ───────────────────────────────────────────────────
      remember({ projectId = null, kind, title, body, tags = [], sourceTaskId = null }) {
        if (!ENG_MEMORY_KINDS.includes(kind)) return { ok: false, errors: [`kind must be one of: ${ENG_MEMORY_KINDS.join(', ')}`] };
        const cleanTitle = bounded(title, MAX_TITLE);
        const cleanBody = bounded(body, MAX_BODY);
        if (!cleanTitle || !cleanBody) return { ok: false, errors: ['title and body are required'] };
        const cleanTags = (Array.isArray(tags) ? tags : []).slice(0, MAX_TAGS).map((tag) => bounded(tag, MAX_TAG)).filter(Boolean);
        counter += 1;
        const id = `engmem_${now()}_${counter}`;
        const at = now();
        db.prepare('INSERT INTO eng_memory (memory_id, workspace_id, user_id, project_id, kind, title, body, tags, source_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, workspaceId, userId, projectId, kind, cleanTitle, cleanBody, toJson(cleanTags), sourceTaskId, at, at);
        return { ok: true, memory: api.get(id) };
      },

      get(memoryId) {
        const row = db.prepare('SELECT * FROM eng_memory WHERE memory_id = ? AND workspace_id = ?').get(memoryId, workspaceId);
        return row ? rowToMemory(row) : null;
      },

      list({ projectId = null, kind = null, limit = 50 } = {}) {
        const clauses = ['workspace_id = ?'];
        const params = [workspaceId];
        if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
        if (kind) { clauses.push('kind = ?'); params.push(kind); }
        return db.prepare(`SELECT * FROM eng_memory WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
          .all(...params, Math.min(limit, 200)).map(rowToMemory);
      },

      /**
       * Ranked retrieval for a task brief. Reuses the SAME keyword scorer the
       * personal-memory retriever uses (src/memory/embeddings.js) rather than
       * duplicating relevance logic — but over a different corpus entirely.
       */
      retrieveForBrief({ goal, projectId = null, maximum = 8 }) {
        const scorer = createKeywordScorer();
        const candidates = api.list({ projectId, limit: 200 });
        const scored = candidates
          .map((memory) => ({ memory, score: scorer.score(String(goal ?? ''), `${memory.title} ${memory.body} ${memory.tags.join(' ')}`) }))
          // Failed approaches and known bugs are disproportionately valuable to
          // a worker (they prevent repeated dead ends), so they clear a lower bar.
          .map((entry) => ({ ...entry, score: entry.memory.kind === 'failed_approach' || entry.memory.kind === 'known_bug' ? entry.score + 0.1 : entry.score }))
          // A real relevance floor: token-overlap scoring gives a nonzero
          // score to notes sharing only filler words, and a brief padded with
          // irrelevant notes is worse than a short one.
          .filter((entry) => entry.score >= 0.25)
          .sort((a, b) => b.score - a.score)
          .slice(0, maximum);
        return scored.map((entry) => ({ ...entry.memory, relevance: +entry.score.toFixed(3) }));
      },

      delete(memoryId) {
        const result = db.prepare('DELETE FROM eng_memory WHERE memory_id = ? AND workspace_id = ?').run(memoryId, workspaceId);
        return result.changes > 0;
      },

      counts() {
        const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM eng_memory WHERE workspace_id = ? GROUP BY kind').all(workspaceId);
        const byKind = {};
        let total = 0;
        for (const row of rows) { byKind[row.kind] = row.n; total += row.n; }
        return { total, byKind };
      },
    };
    return api;
  }

  return { forWorkspace };
}

/** Render retrieved engineering memory into the text block a worker brief carries. */
export function formatEngineeringContext(memories = []) {
  if (!memories.length) return '(no prior engineering notes for this project)';
  return memories
    .map((memory) => `- [${memory.kind}] ${memory.title}: ${memory.body.slice(0, 400)}`)
    .join('\n');
}
