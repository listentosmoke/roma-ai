// Capability + permission registry for current and FUTURE actions. This phase
// establishes the policy surface, not the integrations: everything external
// (messaging, calendar, devices, purchases) is either requires_confirmation or
// not_available, and there is no code path that could execute them anyway —
// approving a proposal that needs an unavailable capability is refused here,
// deterministically, regardless of what any model asks for.

export const PERMISSION_LEVELS = ['allowed_automatically', 'allowed_with_notification', 'requires_confirmation', 'not_available'];

export const DEFAULT_CAPABILITIES = {
  read_local_context: 'allowed_automatically',
  create_internal_plan: 'allowed_automatically',
  draft_message: 'allowed_automatically',
  search_approved_sources: 'not_available',
  send_message: 'requires_confirmation',
  modify_calendar: 'requires_confirmation',
  control_device: 'requires_confirmation',
  make_purchase: 'requires_confirmation',
  delete_data: 'requires_confirmation',
};

// Capabilities with any integration behind them today. Everything else is
// policy-only: even "requires_confirmation" cannot run because nothing
// implements it yet.
const IMPLEMENTED = new Set(['read_local_context', 'create_internal_plan', 'draft_message']);

export function createCapabilityRegistry(overrides = {}) {
  const levels = { ...DEFAULT_CAPABILITIES, ...overrides };

  return {
    levelFor(name) {
      return levels[name] ?? 'not_available';
    },

    /**
     * Can a proposal needing these capabilities be EXECUTED (after any required
     * user confirmation)? Returns the blocking capability when not.
     */
    checkExecutable(requiredCapabilities = []) {
      for (const name of requiredCapabilities) {
        const level = levels[name] ?? 'not_available';
        if (level === 'not_available') return { executable: false, blockedBy: name, reason: `capability "${name}" is not available` };
        if (!IMPLEMENTED.has(name)) return { executable: false, blockedBy: name, reason: `capability "${name}" has no implementation yet` };
      }
      return { executable: true, blockedBy: null, reason: null };
    },

    /** Does running these capabilities require explicit user confirmation first? */
    requiresConfirmation(requiredCapabilities = []) {
      return requiredCapabilities.some((name) => (levels[name] ?? 'not_available') === 'requires_confirmation');
    },

    list() {
      return Object.entries(levels).map(([name, level]) => ({ name, level, implemented: IMPLEMENTED.has(name) }));
    },
  };
}
