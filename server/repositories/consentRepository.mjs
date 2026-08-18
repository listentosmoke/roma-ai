// Consent records for biometric-readiness. Grant/revoke only — nothing here
// implements real biometric processing (see IDENTITY.md "Provider
// limitations"); this is the enforceable record that a future real
// voice/face provider integration would gate on.

let counter = 0;
function generateConsentId(now) { counter += 1; return `consent_${now}_${counter}`; }

function rowToConsent(row) {
  return { consentId: row.consent_id, workspaceId: row.workspace_id, userId: row.user_id, personId: row.person_id, scope: row.scope, purpose: row.purpose, provider: row.provider, grantedAt: row.granted_at, revokedAt: row.revoked_at, status: row.status };
}

export function createSqliteConsentRepository({ db, now = Date.now }) {
  function forWorkspace(workspaceId, userId) {
    return {
      grant({ personId, scope, purpose, provider = null }) {
        if (!personId || !scope || !purpose) return { ok: false, errors: ['personId, scope, and purpose are required'] };
        const consentId = generateConsentId(now());
        const at = now();
        db.prepare('INSERT INTO consent_records (consent_id, workspace_id, user_id, person_id, scope, purpose, provider, granted_at, revoked_at, status) VALUES (?,?,?,?,?,?,?,?,NULL,?)')
          .run(consentId, workspaceId, userId, personId, scope, purpose, provider, at, 'active');
        return { ok: true, consent: rowToConsent(db.prepare('SELECT * FROM consent_records WHERE consent_id = ?').get(consentId)) };
      },

      revoke(consentId) {
        const row = db.prepare('SELECT * FROM consent_records WHERE consent_id = ? AND workspace_id = ?').get(consentId, workspaceId);
        if (!row) return { ok: false, errors: [`no consent record ${consentId}`] };
        db.prepare("UPDATE consent_records SET status = 'revoked', revoked_at = ? WHERE consent_id = ?").run(now(), consentId);
        return { ok: true, consent: rowToConsent(db.prepare('SELECT * FROM consent_records WHERE consent_id = ?').get(consentId)) };
      },

      /** Is there an ACTIVE (not revoked) consent covering this person + scope? Used by the sensitivity policy engine's `context.consentActive`. */
      isActive(personId, scope) {
        const row = db.prepare("SELECT 1 FROM consent_records WHERE workspace_id = ? AND person_id = ? AND scope = ? AND status = 'active' LIMIT 1").get(workspaceId, personId, scope);
        return Boolean(row);
      },

      listForPerson(personId) {
        return db.prepare('SELECT * FROM consent_records WHERE workspace_id = ? AND person_id = ? ORDER BY granted_at DESC').all(workspaceId, personId).map(rowToConsent);
      },

      get(consentId) {
        const row = db.prepare('SELECT * FROM consent_records WHERE consent_id = ? AND workspace_id = ?').get(consentId, workspaceId);
        return row ? rowToConsent(row) : null;
      },
    };
  }
  return { forWorkspace };
}
