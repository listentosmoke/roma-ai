-- Server agent environment: engineering memory + background task dispatch.
--
-- SEPARATION OF CONCERNS: these tables are deliberately NOT part of the
-- personal-memory schema. `memories` is about the wearer — conversations,
-- people, preferences, commitments — and is compiled into Roma's
-- conversational context. `eng_memory` is about CODEBASES — architecture,
-- build commands, fixes, known bugs, decisions, failed approaches — and is
-- only ever compiled into a worker's task brief. Nothing routes eng_memory
-- into assembleContext(), and nothing routes personal memories into a task
-- brief.

CREATE TABLE IF NOT EXISTS eng_projects (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Absolute path a worker may operate inside. Explicitly registered, never
  -- inferred from a task description: this is the allowlist boundary.
  root_path TEXT NOT NULL,
  default_test_cmd TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eng_projects_workspace ON eng_projects(workspace_id, name);

CREATE TABLE IF NOT EXISTS eng_memory (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT REFERENCES eng_projects(project_id) ON DELETE CASCADE,
  -- codebase | architecture | commands | db_structure | fix | known_bug |
  -- decision | failed_approach | deployment | task_note
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eng_memory_project ON eng_memory(workspace_id, project_id, kind);

CREATE TABLE IF NOT EXISTS agent_tasks (
  task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT REFERENCES eng_projects(project_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  -- queued | running | awaiting_approval | awaiting_input | completed |
  -- failed | cancelled
  status TEXT NOT NULL,
  -- readonly | write — write tasks require explicit wearer approval before the
  -- worker may modify anything (enforced in the dispatcher, not the prompt).
  mode TEXT NOT NULL DEFAULT 'readonly',
  -- Bounded ring of progress entries as JSON; never unbounded worker chatter.
  progress TEXT NOT NULL DEFAULT '[]',
  -- Pending question/approval the worker is blocked on, as JSON, or NULL.
  pending_request TEXT,
  result_summary TEXT,
  error TEXT,
  operation_id TEXT,
  -- Optimistic concurrency, same pattern as `sessions`: a late worker event
  -- can never overwrite newer state.
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workspace ON agent_tasks(workspace_id, status, created_at);
