# Roma's Proactive Assistance & Intervention Policy

This layer turns Roma from a purely reactive answerer into a quiet, continuously
aware assistant. The central principle:

> **Observe continuously, think proactively, prepare freely, interrupt
> sparingly, and act externally only with the appropriate permission.**

The critical design split — and who decides what:

| Decision | Made by |
|---|---|
| "Is there a useful opportunity here?" (content, category, phrasing) | **Model** (Opportunity Engine provider) |
| "Should the user experience it, and how?" (discard / silent / visual / notify / speak / ask permission) | **Deterministic runtime policy** — [policy.js](src/proactive/policy.js) + [speechGate.js](src/proactive/speechGate.js). A model recommendation carries no authority and can only be **downgraded**, never upgraded. |

## Data flow

```
finalized transcript turns ── batched (≈1.2 s window) ──┐   agent responses,
scene state (Context Compiler) ─────────────────────────┤   meaningful Inspector
active task state ──────────────────────────────────────┤   events, tool results,
recent suggestions + user preferences ──────────────────┤   manual requests
                                                        ▼
                       evaluation FINGERPRINT (skip if state unchanged)
                                                        ▼
                 Opportunity Engine model (Groq via /api/opportunity/evaluate)
                       → validated opportunities (0–3; 0 is normal)
                                                        ▼
                 deterministic INTERVENTION POLICY (per opportunity)
                   score = 0.4·usefulness + 0.25·confidence + 0.15·urgency
                         + 0.1·timeSensitivity + 0.1·novelty − crowding
                   ├── discard (duplicate / below threshold / disabled / expired
                   │            / reactive agent already answering)
                   ├── silent          (internal continuity only)
                   ├── visual_only    (DEFAULT for unsolicited coaching)
                   ├── notification
                   ├── speak_* ──► SPEECH GATE (budget, cooldown, preferences)
                   │                 denied → falls back to visual_only
                   └── ask_permission ──► background-task proposal
                                                        ▼
                 suggestion store (bounded, dedup, expiry, invalidation)
                                → UI panel / output events / stubbed TTS
```

## Modules (`src/proactive/`)

| Module | Role |
|---|---|
| [schema.js](src/proactive/schema.js) | Opportunity categories, strict-mode JSON schema, `validateOpportunities()` — invalid output never triggers anything |
| [prompt.js](src/proactive/prompt.js) | Conversation Coach system prompt (short, specific, natural, non-generic, no repeats, no late coaching) + evaluation-context assembly |
| [policy.js](src/proactive/policy.js) | Transparent intervention scoring + final delivery decision (score, threshold, and reason exposed in events/UI) |
| [speechGate.js](src/proactive/speechGate.js) | THE speech authorizer — shared by proactive suggestions AND reactive direct answers; budgets: 1 unprompted/min, ≥20 s between spoken outputs |
| [suggestionStore.js](src/proactive/suggestionStore.js) | Bounded queue (max 5 active), lifecycle statuses, dedup (stemmed-token + entity overlap within 90 s), expiry sweep, resolved-by-conversation invalidation |
| [engine.js](src/proactive/engine.js) | Event-driven orchestrator: batching, fingerprints, policy application, proposals, output events, metrics |
| [capabilities.js](src/proactive/capabilities.js) | Permission registry — external capabilities (send_message, control_device, …) are requires_confirmation or not_available AND unimplemented: they cannot run regardless of approval |
| [preferences.js](src/proactive/preferences.js) | User preferences (localStorage) + quiet/balanced/proactive mode interpretations (score thresholds + visible-per-minute limits) |
| [contextSource.js](src/proactive/contextSource.js) | FUTURE-source interface (texts/calendar/notes/email) + mock — nothing real connected |

Browser wiring: [useProactive.js](src/useProactive.js) owns the preferences and
the shared speech gate (handed to `useAgent` so both systems pass one gate); the
Proactive Assistance panel in [main.jsx](src/main.jsx) shows the queue, scores,
final deliveries with policy reasons, suppressions, proposals, and metrics —
with accept / dismiss / convert-to-task / approve / reject controls. The model
runs server-side via `POST /api/opportunity/evaluate`
([server/groqApi.js](server/groqApi.js)); `OPPORTUNITY_MODEL` env-overrides it
(defaults to the main-agent model, `openai/gpt-oss-20b`).

## Opportunity schema (wire format)

```jsonc
{
  "opportunities": [{                       // at most 3; [] is the normal result
    "type": "conversation_coaching",        // 10 categories, see schema.js
    "content": "Ask whether the price includes materials.",
    "suggestedPhrase": "Does that price include all materials?",  // or null
    "confidence": 0.91, "usefulness": 0.88,
    "urgency": "medium", "timeSensitivity": "immediate",
    "reasonSummary": "A price was given without defining what is included.",
    "relatedEntities": [{ "name": "quoted_price", "value": "$800" }],
    "deliveryRecommendation": "visual_only",   // ADVISORY only
    "expiresInMs": 15000,
    "requiresPermission": false,
    "backgroundTaskProposal": null             // or { goal, category, reason, estimatedSteps, requiredCapabilities }
  }]
}
```

## Speech policy (deterministic, model-proof)

Unsolicited speech requires ALL of: `spokenSuggestionsEnabled` (default **off**),
nobody currently speaking, ≥20 s since Roma last spoke, within the 1/minute
unprompted budget, and the suggestion is `immediate` + `high` urgency. Denied
speech falls back to `visual_only`, never silently disappears. Direct answers
(user addressed Roma) are *prompted* speech: allowed while
`directAnswersMaySpeak` is on, uncharged against the unprompted budget, but
still routed through the same gate — **no code path reaches the speech adapter
without gate approval** (TTS itself is still a stub; approval shows as
`spokenApproved` on events and "speech approved" in the UI). Unsolicited
coaching during a conversation with another person is capped at `visual_only`
(`publicConversationSuggestions`) so the other person can't hear it; a private
earpiece mode can lift that cap later without changing the architecture.

## Background-task proposals

A planning opportunity may carry a proposal → surfaced as `ask_permission`,
status `awaiting_approval`. Approval runs a capability check
([capabilities.js](src/proactive/capabilities.js)): internal planning
(`create_internal_plan`) converts into local agent task state
(`runtime.setTaskState`, validated); anything external is refused with the
blocking capability named. Rejection just records. Nothing executes before
approval; nothing external can execute at all in this phase.

Engineering-scale work is a different path: Roma dispatches it to the
background worker in the server process (`dispatch_server_task`) and its
updates come back through this same policy as `sourceType: 'task_update'`.
Routine progress is silent, completions are `speak_when_convenient`, and only a
task actually *blocked* on the wearer may `speak_now`. See
[AGENT-ENV.md](AGENT-ENV.md).

## Running / verifying

```bash
npm run simulate:proactive-agent        # scripted model — 12/12 checks: ambient
                                        # ignored, coaching shown privately,
                                        # duplicate suppressed, resolved-by-
                                        # conversation invalidation, proposal
                                        # awaits approval → local task, direct
                                        # question still answered + spoken
npm run simulate:proactive-agent -- --provider groq   # real model (needs key)
npm test                                # full offline suite (562 tests as of the
                                        # 2026-07 stabilization pass; 65 proactive)
```

Real-model observation (2026-07, `openai/gpt-oss-20b`): it generated "Ask
whether the $800 includes materials and labor", the policy showed it privately
(score 0.735), and the store invalidated it when the contractor answered —
and it avoided re-suggesting the duplicate on its own because recent
suggestions are in its context.

## Speech delivery

When the policy + Speech Gate approve speech (`speak_now` /
`speak_when_convenient`), the approval is handed to the **Selective Voice
Delivery** layer, which mints an authorization, schedules it (waiting for a real
conversational gap for `speak_when_convenient`), synthesizes via a real TTS
provider, and plays it — with barge-in, a deterministic stop path, and echo
suppression. The Speech Gate stays the sole authorizer; the voice layer only
executes an already-approved decision. See [VOICE.md](VOICE.md).

## Limitations (this phase)

Dedup/invalidation are lexical heuristics (stemmed-token + entity overlap), not
semantic embeddings; no permanent memory or vector retrieval; no external
sources or actions connected (interfaces only); speaker identity is diarization
labels, not verified identity. (Real TTS, barge-in, and conversational-gap
detection now exist — see [VOICE.md](VOICE.md).)
