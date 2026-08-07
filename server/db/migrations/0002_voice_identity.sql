CREATE TABLE IF NOT EXISTS voice_templates (
  voice_profile_id TEXT PRIMARY KEY REFERENCES voice_profile_refs(voice_profile_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  model_version TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  dimensions INTEGER NOT NULL,
  encrypted_template TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL,
  encryption_nonce TEXT NOT NULL,
  encryption_auth_tag TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  aggregate_quality REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  consent_id TEXT NOT NULL REFERENCES consent_records(consent_id),
  last_matched_at INTEGER,
  last_similarity REAL,
  last_quality REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  deleted_at INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'biometric'
);

CREATE INDEX IF NOT EXISTS idx_voice_templates_workspace_person
  ON voice_templates(workspace_id, person_id, status);

CREATE INDEX IF NOT EXISTS idx_voice_templates_consent
  ON voice_templates(workspace_id, consent_id);
