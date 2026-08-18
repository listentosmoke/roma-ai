-- Initial schema. SQLite via Node's built-in node:sqlite (see server/db.mjs
-- for why SQLite was chosen — single-user local server, no deployment target
-- in this repo, zero new dependency). All durable identifiers reuse the
-- application's existing ID formats (mem_..., person_..., evidence_..., etc.)
-- as TEXT primary keys rather than inventing new surrogate keys.
--
-- Every tenant-owned table carries workspace_id (and usually user_id)
-- directly on the row — every query in server/repositories/*.mjs filters by
-- it. This is the hard tenant-isolation boundary; nothing above the
-- repository layer can bypass it (see server/auth.mjs + SERVER-DATA.md).

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  display_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active_interaction_id TEXT,
  active_turn_id TEXT,
  current_resolved_speakers TEXT,
  engagement_state TEXT,
  active_goals TEXT,
  cancellation_generation INTEGER NOT NULL DEFAULT 0,
  last_accepted_transcript_seq INTEGER NOT NULL DEFAULT 0,
  current_tool_operation_ids TEXT,
  pending_retrieval_ids TEXT,
  pending_memory_write_ids TEXT,
  pending_identity_resolution_ids TEXT,
  current_speech_authorization_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, status);

CREATE TABLE IF NOT EXISTS interactions (
  interaction_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  turn_ids TEXT,
  created_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_interactions_workspace ON interactions(workspace_id);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  valid_from INTEGER,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  source_interaction_id TEXT,
  source_turn_ids TEXT,
  source_transcript_ids TEXT,
  source_scene_event_ids TEXT,
  source_speaker_id TEXT,
  source_evidence_type TEXT NOT NULL,
  source_extraction_method TEXT,
  source_model TEXT,
  supersedes TEXT,
  superseded_by TEXT,
  contradicts TEXT,
  tags TEXT,
  subject_entity_ids TEXT,
  object_entity_ids TEXT,
  mentioned_entity_ids TEXT,
  speaker_entity_id TEXT,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_workspace_status ON memories(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_source_interaction ON memories(workspace_id, source_interaction_id);
CREATE INDEX IF NOT EXISTS idx_memories_speaker_entity ON memories(workspace_id, speaker_entity_id);

CREATE TABLE IF NOT EXISTS memory_source_links (
  link_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_source_links_memory ON memory_source_links(memory_id);

CREATE TABLE IF NOT EXISTS people (
  person_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'person',
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  identity_status TEXT NOT NULL,
  roles TEXT,
  attributes TEXT,
  voice_profile_ids TEXT,
  face_profile_ids TEXT,
  relationship_ids TEXT,
  linked_memory_ids TEXT,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_observed_at INTEGER,
  merged_into TEXT,
  supersedes TEXT,
  source_evidence_ids TEXT,
  provisional_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_workspace_status ON people(workspace_id, status);

CREATE TABLE IF NOT EXISTS person_aliases (
  alias_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_evidence_ids TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_aliases_person ON person_aliases(person_id);
CREATE INDEX IF NOT EXISTS idx_person_aliases_lookup ON person_aliases(workspace_id, normalized_alias);

CREATE TABLE IF NOT EXISTS identity_evidence (
  evidence_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  evidence_type TEXT NOT NULL,
  person_id TEXT,
  speaker_label TEXT,
  session_id TEXT,
  interaction_id TEXT,
  turn_id TEXT,
  transcript_ids TEXT,
  voice_sample_ref TEXT,
  provider TEXT,
  provider_model TEXT,
  score REAL,
  confidence REAL,
  quality REAL,
  decision TEXT,
  reason_code TEXT,
  confirmed_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_identity_evidence_person ON identity_evidence(workspace_id, person_id);

CREATE TABLE IF NOT EXISTS relationships (
  relationship_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  valid_from INTEGER,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_evidence_ids TEXT,
  linked_memory_ids TEXT,
  supersedes TEXT,
  contradicts TEXT
);
CREATE INDEX IF NOT EXISTS idx_relationships_workspace_status ON relationships(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(workspace_id, from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(workspace_id, to_entity_id);

CREATE TABLE IF NOT EXISTS memory_entity_links (
  link_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_memory_entity_links_person ON memory_entity_links(person_id);
CREATE INDEX IF NOT EXISTS idx_memory_entity_links_memory ON memory_entity_links(memory_id);

-- Provider profile references — deliberately separate from `people`, and
-- access-controlled independently (see server/policy: voice_profile_ref
-- reads always require the biometric rule, never the ordinary person-record
-- rule). No raw audio, embeddings, or templates are ever columns here — see
-- IDENTITY.md "Provider limitations" for why no real provider exists yet.
CREATE TABLE IF NOT EXISTS voice_profile_refs (
  voice_profile_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_model TEXT,
  quality REAL,
  consent_id TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'biometric'
);
CREATE INDEX IF NOT EXISTS idx_voice_profile_refs_person ON voice_profile_refs(person_id);

CREATE TABLE IF NOT EXISTS consent_records (
  consent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_consent_person ON consent_records(workspace_id, person_id, scope);

CREATE TABLE IF NOT EXISTS retention_policies (
  policy_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  max_age_ms INTEGER NOT NULL,
  applies_to_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retention_workspace ON retention_policies(workspace_id, resource_type);

-- Append-only. No UPDATE/DELETE statement in server/repositories/auditRepository.mjs
-- targets this table — only INSERT and SELECT.
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  operation_id TEXT,
  at INTEGER NOT NULL,
  policy_decision_id TEXT,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  source_ids TEXT,
  sensitivity TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,
  provider_operation_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_at ON audit_events(workspace_id, at);

CREATE TABLE IF NOT EXISTS tombstones (
  tombstone_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  deletion_kind TEXT NOT NULL,
  operation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tombstones_resource ON tombstones(workspace_id, resource_type, resource_id);

-- Idempotency ledger: a mutation route checks this before writing, and
-- records its (bounded) result here so a retried request with the SAME
-- operation_id replays the cached outcome instead of writing twice.
CREATE TABLE IF NOT EXISTS operation_ids (
  operation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
);
