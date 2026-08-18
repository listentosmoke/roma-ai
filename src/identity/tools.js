// Identity/relationship tools — additive entries in the SAME tool registry
// the reactive agent and Memory already use (agent/tools.js's
// createToolRegistry). No change to the agent decision schema: the model
// recognizes an explicit identity/naming/relationship request like any other
// request and issues a normal `tool_call` decision. Every tool here only
// validates inputs and delegates to identity/coordinator.js, which is 100%
// deterministic — the model never decides candidate eligibility, thresholds,
// merges, splits, or the final identity state; it only supplies WHICH name /
// person / relationship the user is talking about.

/**
 * @param {ReturnType<typeof import('../agent/tools.js').createToolRegistry>} registry
 * @param {{ identity: ReturnType<typeof import('./coordinator.js').createIdentityCoordinator> }} deps
 */
export function registerIdentityTools(registry, { identity }) {
  if (!identity) return;

  registry.register({
    name: 'identify_current_speaker',
    description: 'Resolve who is currently speaking, using existing session continuity and evidence. Use before answering a question like "who am I talking to" or when you need to know the current speaker\'s identity before responding.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute(_args, context) {
      return identity.identifyCurrentSpeaker({
        sessionId: context?.sessionId ?? null,
        interactionId: context?.interactionId ?? null,
        turnId: context?.turnId ?? null,
        speakerLabel: context?.speaker ?? null,
        transcriptIds: context?.transcriptIds ?? [],
        transcriptText: context?.transcriptText ?? '',
      });
    },
  });

  registry.register({
    name: 'name_current_speaker',
    description: 'Record an explicit naming statement. Pass self:true when the CURRENT speaker is identifying themselves (e.g. "Roma, this is Matt speaking"). Pass self:false (default) when the user is naming a DIFFERENT speaker, e.g. "That was Matt" or "Speaker 1 is Matt" — this refers to the most recent other speaker in the transcript, not the person talking right now.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, self: { type: 'boolean' } }, required: ['name'] },
    async execute({ name, self }, context) {
      const speakerLabel = self ? (context?.speaker ?? null) : (context?.previousSpeaker ?? context?.speaker ?? null);
      const args = { sessionId: context?.sessionId ?? null, interactionId: context?.interactionId ?? null, turnId: context?.turnId ?? null, speakerLabel, name, transcriptIds: context?.transcriptIds ?? [] };
      return self ? identity.selfIdentify(args) : identity.attribute(args);
    },
  });

  registry.register({
    name: 'confirm_person_match',
    description: 'Confirm a previously suggested candidate person match for the current speaker (e.g. the user says "yes, that\'s him").',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' } }, required: ['person_id'] },
    async execute({ person_id: personId }, context) {
      return identity.confirmMatch({ sessionId: context?.sessionId ?? null, interactionId: context?.interactionId ?? null, turnId: context?.turnId ?? null, speakerLabel: context?.speaker ?? null, personId });
    },
  });

  registry.register({
    name: 'reject_person_match',
    description: 'Reject a suggested candidate person match (e.g. the user says "no, that\'s not him"). Creates negative evidence so the same suggestion is not immediately repeated.',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' } }, required: ['person_id'] },
    async execute({ person_id: personId }, context) {
      return identity.rejectMatch({ sessionId: context?.sessionId ?? null, interactionId: context?.interactionId ?? null, turnId: context?.turnId ?? null, speakerLabel: context?.speaker ?? null, personId });
    },
  });

  registry.register({
    name: 'create_person',
    description: 'Create a new person record explicitly (rarely needed directly — naming a speaker already creates one if none exists). Use only for an explicit request like "add a contact named Jon".',
    inputSchema: { type: 'object', properties: { display_name: { type: 'string' }, roles: { type: 'array' } }, required: ['display_name'] },
    async execute({ display_name: displayName, roles }) {
      return identity.createPerson({ displayName, roles: roles ?? [] });
    },
  });

  registry.register({
    name: 'update_person',
    description: 'Rename a person or add an alias/nickname (e.g. "call him Mike", "his full name is Matthew Reed"). The previous name is kept as an alias, never discarded.',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' }, display_name: { type: 'string' }, add_alias: { type: 'string' }, roles: { type: 'array' } }, required: ['person_id'] },
    async execute({ person_id: personId, display_name: displayName, add_alias: addAlias, roles }) {
      return identity.updatePerson({ personId, displayName, addAlias, roles });
    },
  });

  registry.register({
    name: 'merge_people',
    description: 'Merge two or more person records that refer to the same real person into one (e.g. "Matt and Matthew are the same person"). Preserves all aliases, evidence, relationships, and memory links under the target.',
    inputSchema: { type: 'object', properties: { source_person_ids: { type: 'array' }, target_person_id: { type: 'string' } }, required: ['source_person_ids', 'target_person_id'] },
    async execute({ source_person_ids: sourcePersonIds, target_person_id: targetPersonId }) {
      return identity.mergePeople({ sourcePersonIds, targetPersonId });
    },
  });

  registry.register({
    name: 'split_person',
    description: 'Undo an incorrect merge or separate two people accidentally combined into one record (e.g. "those are two different Matts"). Pass the specific alias texts / evidence IDs / voice profile IDs / relationship IDs / memory IDs that belong to the OTHER person — everything not listed stays with the original record.',
    inputSchema: {
      type: 'object',
      properties: {
        person_id: { type: 'string' },
        new_display_name: { type: 'string' },
        target_person_id: { type: 'string' },
        alias_texts: { type: 'array' },
        voice_profile_ids: { type: 'array' },
        evidence_ids: { type: 'array' },
        relationship_ids: { type: 'array' },
        memory_ids: { type: 'array' },
      },
      required: ['person_id'],
    },
    async execute({ person_id: personId, new_display_name: newDisplayName, target_person_id: targetPersonId, alias_texts: aliasTexts, voice_profile_ids: voiceProfileIds, evidence_ids: evidenceIds, relationship_ids: relationshipIds, memory_ids: memoryIds }) {
      return identity.splitPerson({ personId, splitPlan: { newDisplayName, targetPersonId, aliasTexts, voiceProfileIds, evidenceIds, relationshipIds, memoryIds } });
    },
  });

  registry.register({
    name: 'forget_person',
    description: 'Delete a person record (e.g. "forget that contact"). Without confirm:true this only returns a bounded impact summary (linked evidence/relationships/memories) and deletes nothing — call again with confirm:true to actually delete. Deleting a person never deletes linked memories unless delete_linked_memories:true is also passed.',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' }, confirm: { type: 'boolean' }, delete_linked_memories: { type: 'boolean' } }, required: ['person_id'] },
    async execute({ person_id: personId, confirm, delete_linked_memories: deleteLinkedMemories }) {
      if (!confirm) return { ok: true, needsConfirmation: true, preview: identity.previewDeletePerson(personId) };
      return identity.forgetPerson({ personId, deleteLinkedMemories: Boolean(deleteLinkedMemories) });
    },
  });

  registry.register({
    name: 'enroll_voice',
    description: 'Explicitly enroll a voice sample for a person (e.g. "remember my voice as Alex", "enroll Matt\'s voice"). Requires consent:true. In this environment voice matching runs on a deterministic test provider, not real biometric recognition — see get_person_profile / the People panel for provider status.',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' }, sample: { type: 'object' }, consent: { type: 'boolean' } }, required: ['person_id', 'consent'] },
    async execute({ person_id: personId, sample, consent }) {
      if (identity.voiceProviderStatus?.().mode !== 'deterministic') {
        return { ok: false, reasonCode: 'bounded_voice_capture_required', actionRequired: 'Open the People panel and complete Enroll Voice (I consent).' };
      }
      return identity.enrollVoice({ personId, sample, consent });
    },
  });

  registry.register({
    name: 'remove_voice_profile',
    description: 'Delete an enrolled voice profile (e.g. "remove my voice profile"). Future voice matching can no longer use it.',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' }, voice_profile_id: { type: 'string' } }, required: ['person_id', 'voice_profile_id'] },
    async execute({ person_id: personId, voice_profile_id: voiceProfileId }) {
      return identity.removeVoiceProfile({ personId, voiceProfileId });
    },
  });

  registry.register({
    name: 'add_relationship',
    description: 'Record a relationship between two entities (e.g. "Matt is our property contact" -> from person_user to Matt, type works_with, label "Property contact"). from_entity_id/to_entity_id are person IDs ("person_user" for the primary user).',
    inputSchema: { type: 'object', properties: { from_entity_id: { type: 'string' }, to_entity_id: { type: 'string' }, type: { type: 'string' }, label: { type: 'string' } }, required: ['from_entity_id', 'to_entity_id', 'type'] },
    async execute({ from_entity_id: fromEntityId, to_entity_id: toEntityId, type, label }) {
      return identity.addRelationship({ fromEntityId, toEntityId, type, label });
    },
  });

  registry.register({
    name: 'correct_relationship',
    description: 'Correct an existing relationship (e.g. "Matt isn\'t our contractor anymore, he\'s just a friend now"). Supersedes the old relationship edge rather than deleting it.',
    inputSchema: { type: 'object', properties: { relationship_id: { type: 'string' }, type: { type: 'string' }, label: { type: 'string' } }, required: ['relationship_id'] },
    async execute({ relationship_id: relationshipId, type, label }) {
      return identity.correctRelationship({ relationshipId, patch: { type, label } });
    },
  });

  registry.register({
    name: 'remove_relationship',
    description: 'Remove a relationship (e.g. "forget that Matt works with us").',
    inputSchema: { type: 'object', properties: { relationship_id: { type: 'string' } }, required: ['relationship_id'] },
    async execute({ relationship_id: relationshipId }) {
      return identity.removeRelationship({ relationshipId });
    },
  });

  registry.register({
    name: 'show_identity_evidence',
    description: 'Explain why/how a person was identified — their evidence and provenance (e.g. "why do you think that was Matt?").',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' } }, required: ['person_id'] },
    async execute({ person_id: personId }) {
      return identity.showIdentityEvidence(personId);
    },
  });

  registry.register({
    name: 'show_person_profile',
    description: 'Show a person\'s full profile — aliases, relationships, and linked memories (e.g. "what do you know about Matt?").',
    inputSchema: { type: 'object', properties: { person_id: { type: 'string' } }, required: ['person_id'] },
    async execute({ person_id: personId }) {
      return identity.showPersonProfile(personId);
    },
  });
}
