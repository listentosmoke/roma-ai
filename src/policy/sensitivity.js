// Deterministic sensitivity policy engine. Pure and dependency-free, like
// every other schema.js in this codebase — no model, no I/O. This is the
// single place that decides whether a record may be used for a given action;
// nothing else (prompt text, a tool call, a model's own judgment) can weaken
// these rules. See SERVER-DATA.md "Policy rules" for the full rationale.
//
// `sensitivity` is a DIFFERENT axis from `confidence`/`importance`:
//   - importance: how useful the information is
//   - confidence: how likely it is to be correct
//   - sensitivity: how strongly access/disclosure must be restricted
// A high-confidence, high-importance record can still be `secret`.
//
// Called AFTER candidate retrieval and BEFORE Context Compiler assembly (see
// src/agent/runtime.js's `applyPolicyFilter`) — a sensitive record is never
// compiled into the prompt and left to the model's judgment to withhold.

export const SENSITIVITY_LEVELS = ['public', 'normal', 'private', 'sensitive', 'biometric', 'secret'];

export const POLICY_DECISIONS = ['allow', 'allow_redacted', 'deny', 'require_confirmation', 'require_recent_authentication', 'unavailable'];

export const POLICY_VERSION = 1;

// Actions that put a record's content in front of the model or the user in a
// broad, non-owner-initiated way — these are where sensitivity bites hardest.
const MODEL_CONTEXT_ACTIONS = new Set(['memory.context_compile', 'person.context_compile', 'relationship.context_compile', 'memory.search', 'memory.semantic_search', 'person.search']);
const BROAD_ACTIONS = new Set([...MODEL_CONTEXT_ACTIONS, 'relationship.traverse', 'proactive.suggest', 'log.write', 'memory.export', 'person.export']);
const BIOMETRIC_PROVIDER_ACTIONS = new Set(['identity.voice_enroll', 'identity.voice_compare', 'identity.voice_identify', 'identity.voice_delete']);
const DIRECT_OWNER_ACTIONS = new Set(['memory.read', 'memory.create', 'memory.update', 'memory.delete', 'person.read', 'person.create', 'person.update', 'person.delete', 'relationship.read', 'relationship.update', 'identity.voice_read_metadata', 'admin.workspace_delete', 'consent.grant', 'consent.revoke']);

const RECENT_RELEVANCE_THRESHOLD = { private: 0.35, sensitive: 0.6 };

function baseDecision({ action, resourceId, sensitivity, principal, reasonCode, decision, redactions = [] }) {
  return {
    decision,
    action,
    resourceId: resourceId ?? null,
    sensitivity,
    principalId: principal?.userId ?? null,
    workspaceId: principal?.workspaceId ?? null,
    reasonCode,
    redactions,
    policyVersion: POLICY_VERSION,
  };
}

/**
 * @param {{
 *   action: string,
 *   resource: { resourceId?: string, resourceType: string, sensitivity: string, workspaceId: string, ownerId?: string },
 *   principal: { userId: string, workspaceId: string },
 *   context?: { relevance?: number, isProactive?: boolean, confirmed?: boolean, consentActive?: boolean, explicitEligible?: boolean, recentAuthAt?: number, now?: number, recentAuthWindowMs?: number },
 * }} input
 * @returns {{decision:string, action:string, resourceId:string|null, sensitivity:string, principalId:string|null, workspaceId:string|null, reasonCode:string, redactions:string[], policyVersion:number}}
 */
export function evaluatePolicy({ action, resource, principal, context = {} }) {
  const sensitivity = SENSITIVITY_LEVELS.includes(resource?.sensitivity) ? resource.sensitivity : 'normal';
  const deny = (reasonCode, redactions) => baseDecision({ action, resourceId: resource?.resourceId, sensitivity, principal, reasonCode, decision: 'deny', redactions });
  const allow = (reasonCode) => baseDecision({ action, resourceId: resource?.resourceId, sensitivity, principal, reasonCode, decision: 'allow' });

  if (!resource) return baseDecision({ action, resourceId: null, sensitivity, principal, reasonCode: 'resource_unavailable', decision: 'unavailable' });

  // Hard boundary — never bypassable by prompt text, a tool call, or model
  // judgment: this check runs before any sensitivity-specific rule.
  if (!principal?.workspaceId || resource.workspaceId !== principal.workspaceId) {
    return deny('cross_tenant_denied');
  }

  const isDirectOwner = DIRECT_OWNER_ACTIONS.has(action);
  const isBroad = BROAD_ACTIONS.has(action);
  const isModelContext = MODEL_CONTEXT_ACTIONS.has(action);
  const isProactive = Boolean(context.isProactive);

  if (action === 'speech.deliver') {
    if (['sensitive', 'biometric', 'secret'].includes(sensitivity) && !context.explicitEligible) {
      return deny('speech_requires_explicit_eligibility');
    }
    return allow('speech_eligible');
  }

  if (action === 'admin.workspace_delete') {
    const now = context.now ?? Date.now();
    const windowMs = context.recentAuthWindowMs ?? 15 * 60 * 1000;
    if (!context.recentAuthAt || now - context.recentAuthAt > windowMs) {
      return baseDecision({ action, resourceId: resource.resourceId, sensitivity, principal, reasonCode: 'recent_authentication_required', decision: 'require_recent_authentication' });
    }
    return allow('workspace_owner_recent_auth');
  }

  if (sensitivity === 'secret') {
    if (isBroad) return deny('secret_never_in_model_context');
    if (isDirectOwner) return allow('secret_direct_owner_access');
    return deny('secret_action_not_permitted');
  }

  if (sensitivity === 'biometric') {
    if (isModelContext || action === 'proactive.suggest' || action === 'log.write') return deny('biometric_never_in_model_context');
    if (BIOMETRIC_PROVIDER_ACTIONS.has(action)) {
      if (context.consentActive === false) return deny('consent_required_or_revoked');
      return allow('biometric_provider_operation_approved');
    }
    if (action === 'identity.voice_read_metadata') {
      return baseDecision({ action, resourceId: resource.resourceId, sensitivity, principal, reasonCode: 'biometric_metadata_redacted', decision: 'allow_redacted', redactions: ['voiceSampleRef', 'rawTemplate'] });
    }
    if (isDirectOwner) return allow('biometric_direct_owner_access');
    return deny('biometric_action_not_permitted');
  }

  if (sensitivity === 'sensitive') {
    if (isProactive && (isModelContext || action === 'proactive.suggest')) return deny('sensitive_not_eligible_for_proactive');
    if (isModelContext) {
      const relevance = context.relevance ?? 0;
      if (relevance < RECENT_RELEVANCE_THRESHOLD.sensitive) return deny('sensitive_insufficient_relevance');
      if (!context.confirmed) return baseDecision({ action, resourceId: resource.resourceId, sensitivity, principal, reasonCode: 'sensitive_requires_confirmation', decision: 'require_confirmation' });
      return allow('sensitive_confirmed_relevant');
    }
    if (isDirectOwner) return allow('sensitive_direct_owner_access');
    return allow('sensitive_ordinary_access');
  }

  if (sensitivity === 'private') {
    if (isModelContext) {
      const relevance = context.relevance ?? 0;
      const threshold = isProactive ? RECENT_RELEVANCE_THRESHOLD.sensitive : RECENT_RELEVANCE_THRESHOLD.private;
      if (relevance < threshold) return deny(isProactive ? 'private_insufficient_relevance_for_proactive' : 'private_insufficient_relevance');
      return allow('private_relevant_context');
    }
    return allow('private_direct_owner_access');
  }

  // public | normal
  return allow('ordinary_authenticated_access');
}

/** Apply the policy to a list of candidate records, returning only the ones the caller may use (redacted where the decision says so), plus the full decision log for audit/observability. Never lets prompt-injection-shaped record text influence the outcome — only structural fields (sensitivity/workspaceId/relevance) are read. */
export function filterBySensitivity({ action, records, resourceType, principal, context = {}, relevanceOf = () => 0, redact = (record) => record }) {
  const allowed = [];
  const decisions = [];
  for (const record of records) {
    const resource = { resourceId: record.resourceId, resourceType, sensitivity: record.sensitivity, workspaceId: record.workspaceId };
    const decision = evaluatePolicy({ action, resource, principal, context: { ...context, relevance: relevanceOf(record) } });
    decisions.push(decision);
    if (decision.decision === 'allow') allowed.push(record);
    else if (decision.decision === 'allow_redacted') allowed.push(redact(record, decision.redactions));
    // deny / require_confirmation / require_recent_authentication / unavailable -> excluded entirely, never partially leaked
  }
  return { allowed, decisions };
}
