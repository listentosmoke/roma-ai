// Explicit, callable retention cleanup — deliberately NOT a background timer
// (see SERVER-DATA.md "Retention and expiration": "avoid uncontrolled
// background jobs in this phase"). A route (`POST /api/retention/cleanup`)
// and scripts/simulate-server-state.mjs both call `runRetentionCleanup`
// directly. Idempotent: running it twice in a row with no time passing
// finds nothing new to clean up the second time.

const DEFAULT_POLICIES = {
  session: 60 * 60 * 1000, // 1 hour
  provisional_person: 30 * 24 * 60 * 60 * 1000, // 30 days
  identity_evidence: 180 * 24 * 60 * 60 * 1000, // 180 days
};

/**
 * @param {{ db: object, sessionRepository, identityRepository, memoryRepository, auditRepository, workspaceId, userId, now?: Function, policies?: object }} deps
 */
export function runRetentionCleanup({ db, sessionRepository, identityRepository, workspaceId, userId, now = Date.now, policies = {} }) {
  const effective = { ...DEFAULT_POLICIES, ...policies };
  const at = now();
  const result = { expiredSessions: 0, expiredProvisionalPeople: [], staleIdentityEvidence: 0 };

  const sessions = sessionRepository.forWorkspace(workspaceId, userId);
  result.expiredSessions = sessions.expireStale(at);

  // Provisional people with no observation inside the policy window are
  // soft-retired (identityStatus stays 'provisional', status flips to
  // 'deleted' so ordinary listPeople() excludes them) — never a confirmed
  // person, never anything with linked memories/relationships (those
  // indicate real value and are left alone).
  const idRepo = identityRepository.forWorkspace(workspaceId, userId);
  const cutoff = at - effective.provisional_person;
  for (const person of idRepo.listPeople({ identityStatus: 'provisional' })) {
    const lastActivity = person.lastObservedAt ?? person.createdAt;
    if (lastActivity < cutoff && person.linkedMemoryIds.length === 0 && person.relationshipIds.length === 0) {
      idRepo.deletePerson(person.personId);
      result.expiredProvisionalPeople.push(person.personId);
    }
  }

  const evidenceCutoff = at - effective.identity_evidence;
  const staleEvidence = db.prepare("SELECT evidence_id FROM identity_evidence WHERE workspace_id = ? AND created_at < ? AND decision != 'resolved'").all(workspaceId, evidenceCutoff);
  if (staleEvidence.length) {
    db.prepare(`DELETE FROM identity_evidence WHERE workspace_id = ? AND evidence_id IN (${staleEvidence.map(() => '?').join(',')})`).run(workspaceId, ...staleEvidence.map((r) => r.evidence_id));
    result.staleIdentityEvidence = staleEvidence.length;
  }

  return result;
}
