import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Bot, CheckCircle2, Copy, Download, Eye, KeyRound, Lightbulb, Loader2, Mic, Radio, Square, Users, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { useVoice } from './useVoice.js';
import { useInspector } from './useInspector.js';
import { useAgent } from './useAgent.js';
import { useProactive } from './useProactive.js';
import { useVoiceDelivery } from './useVoiceDelivery.js';
import { useMemory } from './useMemory.js';
import { usePeople } from './usePeople.js';
import { useVoiceIdentity } from './useVoiceIdentity.js';
import { useFaceIdentity } from './useFaceIdentity.js';
import { useServerData } from './useServerData.js';
import { useAgentTasks } from './useAgentTasks.js';
import { runPreflight } from './server/preflight.js';
import { createDataClient } from './server/dataClient.js';
import { buildDiagnosticTrace } from './voice/diagnosticsTrace.js';
import { compileSceneSnapshot } from './context/compiler.js';
import { formatAge } from './clock.js';
import './styles.css';

function speakerColor(label) {
  const match = /(\d+)/.exec(label ?? '');
  return match ? (Number(match[1]) - 1) % 6 : 0;
}

// Live Scene panel: what the Inspector currently believes, plus the exact compact
// snapshot the Context Compiler would attach to a main-agent inference right now.
function ScenePanel({ inspector }) {
  const { scene, metrics, watching } = inspector;
  const visible = scene?.objects.filter((o) => o.visibility === 'visible') ?? [];
  const snapshot = useMemo(() => (scene ? compileSceneSnapshot(scene) : ''), [scene]);

  if (!watching) return null;
  return (
    <section className="scene">
      <div className="scene-head">
        <div className="title"><Eye size={14} /> Live scene</div>
        {scene && (
          <span className="scene-meta">
            {scene.scene.label} · updated {formatAge(Date.now() - scene.updatedAt)} ago
            {metrics ? ` · ${metrics.averageMs.cycle} ms/cycle` : ''}
          </span>
        )}
      </div>
      {!scene ? (
        <div className="empty">Warming up the detector…</div>
      ) : (
        <>
          <p className="scene-summary">{scene.scene.summary || 'Nothing recognized yet.'}</p>
          {(visible.length > 0 || scene.people.length > 0) && (
            <div className="scene-chips">
              {scene.people.map((p) => (
                <span key={p.id} className="chip person">{p.identity ?? 'unknown person'}</span>
              ))}
              {visible.map((o) => (
                <span key={o.id} className="chip object">{o.label} · {o.position}</span>
              ))}
            </div>
          )}
          {scene.recentEvents.length > 0 && (
            <ul className="scene-events">
              {scene.recentEvents.slice(-3).map((e) => (
                <li key={`${e.type}-${e.at}`}>{e.message}</li>
              ))}
            </ul>
          )}
          {snapshot && (
            <details className="scene-snapshot">
              <summary>Agent snapshot (attached per inference)</summary>
              <pre>{snapshot}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}

const DECISION_LABEL = { response: 'respond', clarification: 'clarify', 'ignored-turn': 'ignore' };

// Agent panel: the main agent's status, its latest decision, the freshness of
// the visual context it used, tool activity, timing, and any errors — plus a
// dev-only view of the exact assembled model input (no secrets, no chain-of-thought).
function AgentPanel({ agent, lastSegment }) {
  const metrics = agent.metrics();
  const lastToolEvents = useMemo(
    () => (agent.lastTurn ? agent.events.filter((e) => e.turnId === agent.lastTurn.turnId && (e.type === 'tool-started' || e.type === 'tool-completed')) : []),
    [agent.events, agent.lastTurn],
  );
  const debugInput = useMemo(() => agent.lastAssembledInput(), [agent.lastTurn]);

  return (
    <section className="agent">
      <div className="agent-head">
        <div className="title"><Bot size={14} /> Agent</div>
        <span className="agent-status">{agent.status}</span>
      </div>

      {!agent.lastTurn ? (
        <div className="empty">Waiting for a completed transcript turn…</div>
      ) : (
        <>
          {lastSegment && <p className="agent-heard"><strong>{lastSegment.speaker ?? 'Speaker'}:</strong> {lastSegment.text}</p>}
          <div className="agent-decision-row">
            <span className={`chip decision-${agent.lastTurn.type}`}>{DECISION_LABEL[agent.lastTurn.type] ?? agent.lastTurn.type}</span>
            <span className="agent-meta">
              rev {agent.lastTurn.sceneRevisionUsed ?? '—'} · visual age {agent.lastTurn.visualAgeMs != null ? formatAge(agent.lastTurn.visualAgeMs) : '—'}
              {agent.lastTurn.possiblyOutdated ? ' · possibly outdated' : ''} · model {agent.lastTurn.modelMs ?? 0}ms · total {agent.lastTurn.totalMs ?? 0}ms
            </span>
          </div>
          {agent.lastTurn.text && <p className="agent-response">{agent.lastTurn.text}</p>}
          <p className="agent-reason muted">{agent.lastTurn.reasonSummary}</p>

          {lastToolEvents.length > 0 && (
            <ul className="agent-tools">
              {lastToolEvents.map((e, i) => {
                if (e.type === 'tool-started') return <li key={i}>→ {e.name}({JSON.stringify(e.arguments)})</li>;
                const r = e.result;
                const visionMeta = r?.prepared
                  ? ` · ${r.prepared.width ?? '?'}×${r.prepared.height ?? '?'} · ${Math.round((r.prepared.bytes ?? 0) / 1024)} KB · vision ${r.providerMs ?? '?'}ms · ${r.cacheHit ? 'cache hit' : 'cache miss'}`
                  : '';
                const frameMeta = r?.frameAt ? ` · frame ${formatAge(r.frameAgeMs ?? 0)} old` : '';
                return (
                  <li key={i}>
                    {e.ok ? '✓' : '✗'} {e.name} ({e.tookMs}ms{frameMeta}{visionMeta}){e.error ? `: ${e.error}` : ''}
                    {r?.result?.answer && (
                      <div className="agent-tool-answer">
                        “{r.result.answer}”{typeof r.result.target?.confidence === 'number' ? ` (${Math.round(r.result.target.confidence * 100)}%)` : ''}
                        {r.result.uncertainty ? ` — unsure: ${r.result.uncertainty}` : ''}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {agent.taskState?.active && (
        <div className="agent-task">
          <strong>Active task:</strong> {agent.taskState.goal} <span className="muted">({agent.taskState.status})</span>
        </div>
      )}

      {agent.errors.length > 0 && (
        <ul className="agent-errors">
          {agent.errors.slice(-3).map((e, i) => <li key={i}><AlertTriangle size={12} /> {e.stage}: {e.message}</li>)}
        </ul>
      )}

      <div className="agent-metrics muted">
        {metrics.turns} turn{metrics.turns === 1 ? '' : 's'} · avg intake {metrics.averageMs.intake}ms · assemble {metrics.averageMs.assemble}ms
        · model {metrics.averageMs.model}ms · tool {metrics.averageMs.tool}ms · total {metrics.averageMs.total}ms
      </div>
      <div className="agent-metrics muted">
        vision: {agent.health == null ? 'checking…' : agent.health?.vision?.available ? agent.health.vision.model : 'unavailable (server has no GROQ_API_KEY)'}
      </div>

      {import.meta.env.DEV && debugInput && (
        <details className="agent-debug">
          <summary>Assembled model input (dev only)</summary>
          <pre>{debugInput.system}\n\n{debugInput.messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')}</pre>
        </details>
      )}
    </section>
  );
}

// Proactive Assistance panel: preferences, the live suggestion queue with
// scores/deliveries/expiry, background-task proposals awaiting approval, and
// recent policy decisions (including suppressions) — model recommendations vs.
// the deterministic policy's final call are both visible. No chain-of-thought.
function ProactivePanel({ proactive }) {
  const { preferences, suggestions, proposals, events, lastEvaluation } = proactive;
  const metrics = proactive.metrics();
  const recentDecisions = useMemo(
    () => events.filter((e) => e.type === 'opportunity-discarded' || e.type === 'policy-suppressed' || e.type === 'suggestion-spoken-approved').slice(-3),
    [events],
  );
  const openProposals = proposals.filter((p) => p.status === 'awaiting_approval');

  return (
    <section className="proactive">
      <div className="proactive-head">
        <div className="title"><Lightbulb size={14} /> Proactive assistance</div>
        <div className="proactive-controls">
          <select value={preferences.assistanceMode} onChange={(e) => proactive.updatePreference('assistanceMode', e.target.value)} title="Assistance mode">
            <option value="quiet">quiet</option>
            <option value="balanced">balanced</option>
            <option value="proactive">proactive</option>
          </select>
          <label><input type="checkbox" checked={preferences.conversationCoachingEnabled} onChange={(e) => proactive.updatePreference('conversationCoachingEnabled', e.target.checked)} /> coaching</label>
          <label><input type="checkbox" checked={preferences.planningSuggestionsEnabled} onChange={(e) => proactive.updatePreference('planningSuggestionsEnabled', e.target.checked)} /> planning</label>
          <label><input type="checkbox" checked={preferences.spokenSuggestionsEnabled} onChange={(e) => proactive.updatePreference('spokenSuggestionsEnabled', e.target.checked)} /> spoken</label>
        </div>
      </div>

      {suggestions.length === 0 ? (
        <div className="empty">No active suggestions — Roma stays quiet unless something is genuinely useful.</div>
      ) : (
        <ul className="proactive-suggestions">
          {suggestions.map((s) => (
            <li key={s.id}>
              <div className="suggestion-main">
                <span className={`chip suggestion-type-${s.deliveryMode}`}>{s.type.replace(/_/g, ' ')}</span>
                <div className="suggestion-body">
                  <p>{s.content}</p>
                  {s.suggestedPhrase && <p className="suggestion-phrase">“{s.suggestedPhrase}”</p>}
                  <span className="suggestion-meta">
                    score {s.interventionScore} · conf {Math.round(s.confidence * 100)}% · useful {Math.round(s.usefulness * 100)}% · {s.urgency}
                    · {s.deliveryMode}{s.spoken ? ' · spoken ✓' : ''} · expires in {Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000))}s
                  </span>
                  <span className="suggestion-meta muted">{s.policyReason}</span>
                </div>
              </div>
              <div className="suggestion-actions">
                <button type="button" onClick={() => proactive.accept(s.id)}>Accept</button>
                <button type="button" onClick={() => proactive.dismiss(s.id)}>Dismiss</button>
                <button type="button" onClick={() => proactive.convertToTask(s.id)}>→ Task</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {openProposals.length > 0 && (
        <div className="proactive-proposals">
          {openProposals.map((p) => (
            <div key={p.proposalId} className="proposal">
              <div>
                <strong>Proposed task:</strong> {p.goal}
                <span className="suggestion-meta"> {p.reason} · needs: {p.requiredCapabilities.join(', ')} · requires approval</span>
                {p.estimatedSteps.length > 0 && <span className="suggestion-meta muted">steps: {p.estimatedSteps.join(' → ')}</span>}
              </div>
              <div className="suggestion-actions">
                <button type="button" onClick={() => proactive.approveProposal(p.proposalId)}>Approve</button>
                <button type="button" onClick={() => proactive.rejectProposal(p.proposalId)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {recentDecisions.length > 0 && (
        <ul className="proactive-decisions muted">
          {recentDecisions.map((e, i) => (
            <li key={i}>
              {e.type === 'suggestion-spoken-approved' ? '🔊 speech approved' : e.duplicateOf ? 'duplicate suppressed' : 'discarded'}
              {e.opportunityContent ? `: “${e.opportunityContent}”` : ''} — {e.policyReason}
            </li>
          ))}
        </ul>
      )}

      <div className="agent-metrics muted">
        {metrics.evaluations} evals · {metrics.generated} found · {metrics.displayed} shown · {metrics.discarded} discarded
        · {metrics.duplicatesSuppressed} dupes · {metrics.spokenApproved} spoken · {metrics.fingerprintSkips} fingerprint skips
        · model {metrics.averages.modelMs}ms · policy {metrics.averages.policyMs}ms
        {lastEvaluation ? ` · last: ${lastEvaluation.finalDelivery} (score ${lastEvaluation.interventionScore}/${lastEvaluation.threshold})` : ''}
        {suggestions.length > 0 && <button type="button" className="link-btn" onClick={proactive.clearExpired}>clear expired</button>}
      </div>
    </section>
  );
}

const AUDIO_STATE_LABEL = {
  locked: 'not yet unlocked',
  ready: 'ready',
  blocked: 'blocked by the browser',
  error: 'unavailable in this browser',
};

// Pending speak_when_convenient card: authorization details while Roma waits
// for a real conversational gap. No hidden reasoning — only the concise
// pending text, why it's waiting, and a cancel control. Disappears immediately
// once resolved (played / expired / revoked / superseded / cancelled).
function PendingSpeechCard({ pending, someoneElseSpeaking, onCancel }) {
  const [, force] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!pending) return null;
  const secondsLeft = pending.expiresAt ? Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)) : null;
  return (
    <div className="pending-speech">
      <div className="pending-speech-head">
        <span className="chip">waiting to speak</span>
        <span className="muted">{pending.sourceType} · priority {pending.priority} · auth {pending.authorizationId}</span>
      </div>
      <p className="pending-speech-text">“{pending.text}”</p>
      <span className="suggestion-meta muted">
        {pending.waitingReason}{someoneElseSpeaking ? ' · someone else is currently speaking' : ''}
        {secondsLeft != null ? ` · expires in ${secondsLeft}s` : ''}
      </span>
      <div className="suggestion-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Voice-delivery panel: Turn Manager state, the active authorization, TTS
// provider/voice + selector, waiting-for-gap + voice-activity status, audio
// readiness, pending speak_when_convenient details, latency metrics, the
// latest spoken text, and the manual controls. No keys, no base64, no
// chain-of-thought — only what the deterministic pipeline decided and did.
function VoicePanel({ voiceDelivery, proactive, health }) {
  const { preferences } = proactive;
  const metrics = voiceDelivery.metrics();
  const ttsHealth = health?.tts;
  const speaking = voiceDelivery.voiceActivity.romaSpeaking;
  const audioBlocked = voiceDelivery.audioState === 'blocked' || voiceDelivery.audioState === 'error';

  return (
    <section className="voice">
      <div className="voice-head">
        <div className="title">{speaking ? <Volume2 size={14} /> : <VolumeX size={14} />} Voice delivery</div>
        <span className="voice-status">
          turn: {metrics.turnState}{voiceDelivery.turnState === 'waiting_for_gap' ? ' · waiting for a gap' : ''}
        </span>
      </div>

      {audioBlocked && (
        <div className="audio-warning">
          <AlertTriangle size={14} />
          <span>
            Audio playback is {AUDIO_STATE_LABEL[voiceDelivery.audioState]} — Roma's replies stay visible as text, but you won't hear them.
          </span>
          <button type="button" onClick={() => voiceDelivery.unlockAudio()}>Enable Audio</button>
        </div>
      )}

      <div className="voice-controls">
        <label><input type="checkbox" checked={preferences.directAnswersMaySpeak} onChange={(e) => proactive.updatePreference('directAnswersMaySpeak', e.target.checked)} /> spoken answers</label>
        <label><input type="checkbox" checked={preferences.spokenSuggestionsEnabled} onChange={(e) => proactive.updatePreference('spokenSuggestionsEnabled', e.target.checked)} /> spoken coaching</label>
        <label><input type="checkbox" checked={preferences.bargeInEnabled !== false} onChange={(e) => proactive.updatePreference('bargeInEnabled', e.target.checked)} /> barge-in</label>
        <select
          value={voiceDelivery.selectedVoice ?? ''}
          onChange={(e) => voiceDelivery.selectVoice(e.target.value)}
          disabled={!voiceDelivery.voiceCatalog}
          title="Voice (applies to the next thing Roma says)"
        >
          {!voiceDelivery.voiceCatalog && <option value="">loading voices…</option>}
          {voiceDelivery.voiceCatalog?.voices.map((v) => (
            <option key={v.id} value={v.id}>{v.displayName}</option>
          ))}
        </select>
        <button type="button" onClick={() => voiceDelivery.testTts()}>Test TTS</button>
        <button type="button" onClick={() => voiceDelivery.stopAll()}>Stop Roma</button>
        <button type="button" onClick={() => voiceDelivery.clearPending()}>Clear pending</button>
      </div>

      <div className="voice-meta muted">
        TTS: {ttsHealth == null ? 'checking…' : ttsHealth.available ? `${ttsHealth.provider} · ${ttsHealth.model} · ${ttsHealth.voice}` : 'unavailable (server has no TTS key) — text only'}
        {voiceDelivery.voiceCatalog?.fallback ? ' (limited voice metadata)' : ''}
        {' · '}voice activity: {voiceDelivery.voiceActivity.speaking ? 'someone speaking' : 'quiet'}
        {' · '}audio: {AUDIO_STATE_LABEL[voiceDelivery.audioState]}
      </div>

      {voiceDelivery.lastSpoken && (
        <p className="voice-spoken">
          🔊 “{voiceDelivery.lastSpoken.text}”{' '}
          <span className="muted">({voiceDelivery.lastSpoken.provider} · {voiceDelivery.lastSpoken.model} · {voiceDelivery.lastSpoken.voice} · {voiceDelivery.lastSpoken.ttsLatencyMs ?? '?'}ms)</span>
        </p>
      )}

      <PendingSpeechCard
        pending={voiceDelivery.pendingSpeech}
        someoneElseSpeaking={voiceDelivery.someoneElseSpeaking()}
        onCancel={() => voiceDelivery.cancelPendingSpeech()}
      />

      <div className="agent-metrics muted">
        {metrics.approved} authorized · {metrics.denied} denied · {metrics.expiredBeforePlay} expired · {metrics.echoesSuppressed} echoes suppressed
        · {metrics.bargeIns} barge-ins ({metrics.avgBargeInStopMs}ms stop) · {metrics.stopCommands} stop cmds · {metrics.lateDiscarded} late discarded
      </div>
      <div className="agent-metrics muted">
        tts {metrics.avgTtsLatencyMs}ms · gap wait {metrics.avgGapWaitMs}ms · transcript→audio {metrics.avgTranscriptToAudioMs}ms
        · playback start {metrics.playback.avgStartLatencyMs}ms · autoplay fails {metrics.playback.autoplayFailures}
      </div>
    </section>
  );
}

// Dev-only live-voice diagnostic trace (src/voice/diagnosticsTrace.js). Shows
// every stage a direct response or proactive suggestion passes through —
// transcript -> addressee decision -> Speech Gate -> authorization -> Turn
// Manager -> TTS -> playback -> completion/cancellation — so a response can
// never silently disappear between stages. No keys, no full prompts, no
// hidden reasoning: only short operational fields.
function DiagnosticsPanel({ agentEvents, deliveryEvents }) {
  const trace = useMemo(() => buildDiagnosticTrace(agentEvents, deliveryEvents), [agentEvents, deliveryEvents]);
  if (!trace.length) return null;
  return (
    <details className="agent-debug">
      <summary>Live voice diagnostic trace (dev only, {trace.length} events)</summary>
      <ul className="diagnostic-trace">
        {trace.map((row, i) => (
          <li key={i}>
            <span className="muted">{new Date(row.at).toISOString().slice(11, 23)}</span>{' '}
            <span className={`chip trace-${row.source}`}>{row.source}</span>{' '}
            <strong>{row.kind}</strong>{' '}
            {Object.entries(row).filter(([k]) => !['at', 'source', 'kind'].includes(k) && row[k] != null).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}
          </li>
        ))}
      </ul>
    </details>
  );
}

const MEMORY_ACTION_LABEL = {
  'memory-store': 'stored', 'memory-merge': 'merged', 'memory-supersede': 'superseded', 'memory-discard': 'discarded',
  'memory-deleted': 'deleted', 'memory-retrieved': 'retrieved', 'memory-forget-ambiguous': 'forget: ambiguous',
  'memory-forget-not-found': 'forget: not found', 'memory-cleared-all': 'cleared all', 'memory-write-skipped': 'write skipped',
};

// Dev-only Memory panel (src/useMemory.js): counts by type, recent write/
// retrieval decisions with reason codes, provenance, active/superseded/deleted
// state, and delete/clear-all controls. Collapsible so it never crowds the
// primary interaction UI. No raw prompts, no hidden reasoning — only the
// structured outcomes the coordinator already emits.
function MemoryPanel({ memory }) {
  const active = useMemo(() => memory.list({}).slice(-20).reverse(), [memory.counts]);
  const recentEvents = memory.events.slice(-12).reverse();

  return (
    <details className="agent-debug">
      <summary>
        Memory ({memory.counts.total} total, {memory.counts.active} active) — embeddings: {memory.embedderStatus.configured ? memory.embedderStatus.name : 'none (keyword/structured fallback)'}
      </summary>
      {Object.keys(memory.counts.byType).length > 0 && (
        <p className="suggestion-meta muted">
          {Object.entries(memory.counts.byType).map(([type, count]) => `${type}: ${count}`).join(' · ')}
        </p>
      )}
      {active.length > 0 && (
        <ul className="diagnostic-trace">
          {active.map((m) => (
            <li key={m.memoryId}>
              <span className={`chip ${m.status === 'active' ? 'trace-agent' : 'trace-voice'}`}>{m.status}</span>{' '}
              <strong>[{m.type}]</strong> {m.summary}{' '}
              <span className="muted">(conf {Math.round(m.confidence * 100)}% · {m.source.evidenceType} · {m.memoryId})</span>{' '}
              <button type="button" className="link-btn" onClick={() => memory.deleteMemory(m.memoryId)}>delete</button>
            </li>
          ))}
        </ul>
      )}
      {active.length === 0 && <div className="empty">No memories stored yet.</div>}
      {recentEvents.length > 0 && (
        <>
          <p className="suggestion-meta muted" style={{ marginTop: '0.5rem' }}>Recent memory activity:</p>
          <ul className="diagnostic-trace">
            {recentEvents.map((e, i) => (
              <li key={i}>
                <span className="muted">{new Date(e.at).toISOString().slice(11, 23)}</span>{' '}
                <span className="chip trace-agent">{MEMORY_ACTION_LABEL[e.type] ?? e.type}</span>{' '}
                {e.summary ? `“${e.summary}”` : e.query ? `query: "${e.query}"` : ''}{' '}
                {e.reasonCode ? <span className="muted">({e.reasonCode})</span> : null}
                {e.count != null ? <span className="muted"> · {e.count} match{e.count === 1 ? '' : 'es'} ({e.matchType})</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="suggestion-actions">
        <button type="button" onClick={memory.clearAll}>Clear all (dev)</button>
      </div>
    </details>
  );
}

const VOICE_MODE_LABEL = {
  real: 'real biometric provider',
  local_real: 'local WavLM speaker recognition',
  deterministic: 'deterministic test provider (NOT real biometric recognition)',
  unavailable: 'unavailable — no server-side voice-identity provider is configured in this environment',
};

// One person row: identity status, aliases, confidence, voice-profile/
// relationship/evidence counts, and the required dev controls (rename/alias,
// confirm/reject, merge, enroll/remove voice, delete). All content the user
// or model supplied (names, aliases) renders as plain text via JSX — React
// escapes it automatically, so a stored name can never become markup.
function PersonRow({ person, people, onShowEvidence, evidenceOpen, evidence }) {
  const [renameText, setRenameText] = useState('');
  const [aliasText, setAliasText] = useState('');
  const [mergeSourceId, setMergeSourceId] = useState('');

  const needsConfirmation = person.identityStatus === 'provisional' || person.identityStatus === 'candidate';

  return (
    <li>
      <div className="agent-decision-row">
        <span className={`chip ${person.identityStatus === 'confirmed' ? 'trace-agent' : person.identityStatus === 'disputed' ? 'trace-voice' : 'chip'}`}>{person.identityStatus}</span>
        <strong>{person.displayName}</strong>
        <span className="muted">[{person.personId}] · conf {Math.round(person.confidence * 100)}%</span>
      </div>
      {person.aliases.length > 0 && <p className="suggestion-meta muted">aliases: {person.aliases.map((a) => a.alias).join(', ')}</p>}
      {person.roles.length > 0 && <p className="suggestion-meta muted">roles: {person.roles.join(', ')}</p>}
      <p className="suggestion-meta muted">
        voice profiles: {person.voiceProfileIds.length} · relationships: {person.relationshipIds.length} · linked memories: {person.linkedMemoryIds.length}
        {' · sensitivity: '}{person.sensitivity} (not enforced)
      </p>

      <div className="suggestion-actions">
        {needsConfirmation && (
          <>
            <button type="button" onClick={() => people.confirmMatch({ personId: person.personId })}>Confirm</button>
            <button type="button" onClick={() => people.rejectMatch({ personId: person.personId })}>Reject</button>
          </>
        )}
        <button type="button" className="link-btn" onClick={() => onShowEvidence(person.personId)}>{evidenceOpen ? 'hide evidence' : 'show evidence'}</button>
        <button
          type="button"
          onClick={async () => {
            const preview = people.previewDeletePerson(person.personId);
            // eslint-disable-next-line no-alert
            if (window.confirm(`Delete ${preview.displayName}? Linked: ${preview.relationshipCount} relationships, ${preview.linkedMemoryCount} memories, ${preview.evidenceCount} evidence records. Memories are kept unless you choose otherwise.`)) {
              await people.forgetPerson({ personId: person.personId, deleteLinkedMemories: false });
            }
          }}
        >
          Delete
        </button>
      </div>

      <div className="suggestion-actions">
        <input value={renameText} onChange={(e) => setRenameText(e.target.value)} placeholder="rename to…" />
        <button type="button" disabled={!renameText.trim()} onClick={() => { people.updatePerson({ personId: person.personId, displayName: renameText.trim() }); setRenameText(''); }}>Rename</button>
        <input value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="add alias…" />
        <button type="button" disabled={!aliasText.trim()} onClick={() => { people.updatePerson({ personId: person.personId, addAlias: aliasText.trim() }); setAliasText(''); }}>Add alias</button>
      </div>

      <div className="suggestion-actions">
        <input value={mergeSourceId} onChange={(e) => setMergeSourceId(e.target.value)} placeholder="other personId to merge in…" />
        <button type="button" disabled={!mergeSourceId.trim()} onClick={() => { people.mergePeople({ sourcePersonIds: [mergeSourceId.trim()], targetPersonId: person.personId }); setMergeSourceId(''); }}>Merge into this</button>
        {person.voiceProfileIds.map((id) => (
          <button key={id} type="button" className="link-btn" onClick={() => people.removeVoiceProfile({ personId: person.personId, voiceProfileId: id })}>remove voice {id.slice(-6)}</button>
        ))}
        <button
          type="button"
          disabled={people.voiceProviderStatus.mode === 'unavailable'}
          title={people.voiceProviderStatus.mode === 'unavailable' ? 'No voice-identity provider is configured in this environment' : 'Deterministic test enrollment — not real biometric capture'}
          onClick={() => people.enrollVoice({ personId: person.personId, consent: true, sample: { matchKey: person.personId, durationMs: 4000, quality: 0.9, speakerPurity: 0.95 } })}
        >
          Enroll Voice ({people.voiceProviderStatus.mode})
        </button>
      </div>

      {evidenceOpen && evidence && (
        <ul className="diagnostic-trace">
          {evidence.evidence.map((e) => (
            <li key={e.evidenceId}>
              <span className="chip trace-voice">{e.evidenceType}</span> {e.decision}
              {e.confidence != null && <span className="muted"> · conf {Math.round(e.confidence * 100)}%</span>}
              {e.score != null && <span className="muted"> · score {Math.round(e.score * 100)}%</span>}
              <span className="muted"> · {e.reasonCode} · {e.evidenceId}</span>
            </li>
          ))}
          {evidence.evidence.length === 0 && <li className="muted">No evidence recorded.</li>}
        </ul>
      )}
    </li>
  );
}

// Dev-only People & Relationships panel (src/usePeople.js): stable person
// records independent of transient diarized speaker labels, each with
// identity status, aliases, evidence/provenance, voice-profile status, and
// relationships — plus the confirm/reject/rename/merge/enroll/delete
// controls. Collapsible so it never crowds the primary interaction UI. No
// raw audio, embeddings, or credentials are ever rendered here — only the
// structured outcomes the coordinator already emits. Sensitivity is clearly
// labeled as metadata only (not yet an enforced access boundary — see
// IDENTITY.md "Deferred sensitivity enforcement").
function PeoplePanel({ people }) {
  const active = useMemo(() => people.list({}).slice(-20).reverse(), [people.counts]);
  const relationships = useMemo(() => people.listRelationships({}), [people.counts]);
  const recentEvents = people.events.slice(-12).reverse();
  const [evidenceFor, setEvidenceFor] = useState(null);
  const evidence = useMemo(() => (evidenceFor ? people.showIdentityEvidence(evidenceFor) : null), [evidenceFor, people.counts]);

  return (
    <details className="agent-debug">
      <summary>
        People ({people.counts.total} total, {people.counts.active} active) — voice identity: {VOICE_MODE_LABEL[people.voiceProviderStatus.mode] ?? people.voiceProviderStatus.mode}
      </summary>
      <p className="suggestion-meta muted">
        Sensitivity is stored as metadata only and is NOT currently enforced as an access-control or retrieval boundary (see IDENTITY.md).
        {' '}Browser localStorage holds only non-biometric person metadata — never raw audio, voiceprints, or embeddings.
      </p>
      {Object.keys(people.counts.byIdentityStatus).length > 0 && (
        <p className="suggestion-meta muted">
          {Object.entries(people.counts.byIdentityStatus).map(([status, count]) => `${status}: ${count}`).join(' · ')}
        </p>
      )}
      {active.length > 0 ? (
        <ul className="diagnostic-trace">
          {active.map((person) => (
            <PersonRow
              key={person.personId}
              person={person}
              people={people}
              onShowEvidence={(id) => setEvidenceFor(evidenceFor === id ? null : id)}
              evidenceOpen={evidenceFor === person.personId}
              evidence={evidenceFor === person.personId ? evidence : null}
            />
          ))}
        </ul>
      ) : (
        <div className="empty">No people resolved yet.</div>
      )}

      {relationships.length > 0 && (
        <>
          <p className="suggestion-meta muted" style={{ marginTop: '0.5rem' }}>Relationships:</p>
          <ul className="diagnostic-trace">
            {relationships.map((r) => (
              <li key={r.relationshipId}>
                <span className="chip">{r.type}</span> {r.fromEntityId} → {r.toEntityId}{r.label ? ` (${r.label})` : ''}
                <span className="muted"> · conf {Math.round(r.confidence * 100)}% · {r.relationshipId}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {recentEvents.length > 0 && (
        <>
          <p className="suggestion-meta muted" style={{ marginTop: '0.5rem' }}>Recent identity activity:</p>
          <ul className="diagnostic-trace">
            {recentEvents.map((e, i) => (
              <li key={i}>
                <span className="muted">{new Date(e.at).toISOString().slice(11, 23)}</span>{' '}
                <span className="chip trace-agent">{e.type.replace('identity-', '')}</span>{' '}
                {e.status ? <span className="muted">{e.status}</span> : null}
                {e.reasonCode ? <span className="muted"> ({e.reasonCode})</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="suggestion-actions">
        <button type="button" onClick={people.clearAll}>Clear all (dev)</button>
      </div>
    </details>
  );
}

function VoicePersonRow({ person, people, voiceIdentity, voice, faceIdentity, cameraOn, grabFrame, onShowEvidence, evidenceOpen, evidence }) {
  const [renameText, setRenameText] = useState('');
  const [aliasText, setAliasText] = useState('');
  const [mergeSourceId, setMergeSourceId] = useState('');
  const profiles = voiceIdentity.profilesByPerson[person.personId] ?? [];
  const captureBusy = Boolean(voiceIdentity.operation);
  const providerReady = Boolean(voiceIdentity.status?.ready);
  const faceProfiles = faceIdentity.profilesFor(person.personId);
  const faceBusy = Boolean(faceIdentity.busyPersonId);
  const faceBusyHere = faceIdentity.busyPersonId === person.personId;
  const faceReady = faceIdentity.ready;
  const needsConfirmation = person.identityStatus === 'provisional' || person.identityStatus === 'candidate';

  useEffect(() => {
    voiceIdentity.loadProfiles(person.personId).catch(() => {});
    // The hook refreshes this list after every biometric write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.personId]);

  return (
    <li>
      <div className="agent-decision-row">
        <span className={`chip ${person.identityStatus === 'confirmed' ? 'trace-agent' : person.identityStatus === 'disputed' ? 'trace-voice' : 'chip'}`}>{person.identityStatus}</span>
        <strong>{person.displayName}</strong>
        <span className="muted">[{person.personId}] / confidence {Math.round(person.confidence * 100)}%</span>
      </div>
      {person.aliases.length > 0 && <p className="suggestion-meta muted">aliases: {person.aliases.map((alias) => alias.alias).join(', ')}</p>}
      <p className="suggestion-meta muted">voice profiles: {profiles.length} / face profiles: {faceProfiles.length} / relationships: {person.relationshipIds.length} / linked memories: {person.linkedMemoryIds.length} / sensitivity: {person.sensitivity}</p>

      <div className="suggestion-actions">
        {needsConfirmation && <button type="button" onClick={() => people.confirmMatch({ personId: person.personId })}>Confirm identity</button>}
        {needsConfirmation && <button type="button" onClick={() => people.rejectMatch({ personId: person.personId })}>Reject identity</button>}
        <button type="button" className="link-btn" onClick={() => onShowEvidence(person.personId)}>{evidenceOpen ? 'hide evidence' : 'show evidence'}</button>
        <button type="button" onClick={async () => {
          const preview = people.previewDeletePerson(person.personId);
          // eslint-disable-next-line no-alert
          if (window.confirm(`Delete ${preview.displayName}? Biometric profiles and identity links will also be removed.`)) await people.forgetPerson({ personId: person.personId, deleteLinkedMemories: false });
        }}>Delete person</button>
      </div>

      <div className="suggestion-actions">
        <input value={renameText} onChange={(event) => setRenameText(event.target.value)} placeholder="rename to..." />
        <button type="button" disabled={!renameText.trim()} onClick={() => { people.updatePerson({ personId: person.personId, displayName: renameText.trim() }); setRenameText(''); }}>Rename</button>
        <input value={aliasText} onChange={(event) => setAliasText(event.target.value)} placeholder="add alias..." />
        <button type="button" disabled={!aliasText.trim()} onClick={() => { people.updatePerson({ personId: person.personId, addAlias: aliasText.trim() }); setAliasText(''); }}>Add alias</button>
      </div>

      <div className="suggestion-actions">
        <input value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)} placeholder="other personId to merge..." />
        <button type="button" disabled={!mergeSourceId.trim()} onClick={() => { people.mergePeople({ sourcePersonIds: [mergeSourceId.trim()], targetPersonId: person.personId }); setMergeSourceId(''); }}>Merge into this</button>
        <button
          type="button"
          disabled={!providerReady || !voice.listening || captureBusy}
          title={!voice.listening ? 'Start the microphone first' : 'Capture a bounded real voice sample after explicit consent'}
          onClick={() => voiceIdentity.enroll(person.personId).catch(() => {})}
        >
          Enroll Voice (I consent)
        </button>
        <button
          type="button"
          disabled={!faceReady || !cameraOn || faceBusy}
          title={!cameraOn ? 'Start the camera first — enrollment only ever uses the camera you can see running' : 'Capture a few frames and average them into one template'}
          onClick={() => faceIdentity.enroll({ personId: person.personId, grabFrame }).catch(() => {})}
        >
          {faceBusyHere ? `Capturing ${faceIdentity.progress?.attempted ?? 0}/${faceIdentity.progress?.total ?? 0}...` : 'Enroll Face (I consent)'}
        </button>
      </div>

      {faceProfiles.map((profile) => (
        <div className="suggestion-actions" key={profile.faceProfileId}>
          <span className="muted">
            face {profile.faceProfileId.slice(-6)} / {profile.status} / {profile.model} / {profile.sampleCount} sample{profile.sampleCount === 1 ? '' : 's'}
            {profile.lastSimilarity != null ? ` / last match ${Math.round(profile.lastSimilarity * 100)}%` : ' / never matched'}
          </span>
          <button type="button" className="link-btn" onClick={() => faceIdentity.forgetFace({ personId: person.personId, faceProfileId: profile.faceProfileId }).catch(() => {})}>Forget this face</button>
        </div>
      ))}

      {profiles.map((profile) => (
        <div className="suggestion-actions" key={profile.voiceProfileId}>
          <span className="muted">
            voice {profile.voiceProfileId.slice(-6)} / {profile.status} / {profile.model} / {profile.sampleCount} sample{profile.sampleCount === 1 ? '' : 's'}
            {' / quality '}{Math.round(profile.aggregateQuality * 100)}%
            {profile.lastSimilarity != null ? ` / last similarity ${Math.round(profile.lastSimilarity * 100)}%` : ''}
          </span>
          <button type="button" disabled={!providerReady || !voice.listening || captureBusy || profile.status !== 'active'} onClick={() => voiceIdentity.verify(person.personId, profile.voiceProfileId).catch(() => {})}>Test current voice</button>
          <button type="button" disabled={!providerReady || !voice.listening || captureBusy || profile.status !== 'active' || person.identityStatus !== 'confirmed'} onClick={() => voiceIdentity.improve(person.personId, profile.voiceProfileId).catch(() => {})}>Add enrollment sample</button>
          <button type="button" className="link-btn" onClick={() => voiceIdentity.deleteProfile(person.personId, profile.voiceProfileId).catch(() => {})}>Delete template</button>
        </div>
      ))}
      {profiles.some((profile) => profile.status === 'active') && <div className="suggestion-actions"><button type="button" className="link-btn" onClick={() => voiceIdentity.revokeConsent(person.personId).catch(() => {})}>Revoke voice consent</button></div>}

      {evidenceOpen && evidence && (
        <ul className="diagnostic-trace">
          {evidence.evidence.map((item) => <li key={item.evidenceId}><span className="chip trace-voice">{item.evidenceType}</span> {item.decision}{item.score != null ? ` / score ${Math.round(item.score * 100)}%` : ''}<span className="muted"> / {item.reasonCode}</span></li>)}
          {evidence.evidence.length === 0 && <li className="muted">No evidence recorded.</li>}
        </ul>
      )}
    </li>
  );
}

function VoicePeoplePanel({ people, voiceIdentity, voice, faceIdentity, inspector }) {
  const active = useMemo(() => people.list({}).slice(-20).reverse(), [people.counts]);
  const relationships = useMemo(() => people.listRelationships({}), [people.counts]);
  const [evidenceFor, setEvidenceFor] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const evidence = useMemo(() => (evidenceFor ? people.showIdentityEvidence(evidenceFor) : null), [evidenceFor, people.counts]);

  useEffect(() => {
    if (!voiceIdentity.operation) { setElapsedMs(0); return undefined; }
    const tick = () => setElapsedMs(Date.now() - voiceIdentity.operation.startedAt);
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [voiceIdentity.operation]);

  return (
    <details className="agent-debug">
      <summary>People ({people.counts.total} total, {people.counts.active} active) - voice identity: {VOICE_MODE_LABEL[voiceIdentity.status?.mode] ?? voiceIdentity.status?.mode ?? 'checking'}</summary>
      <p className="suggestion-meta muted">Voice identity is probabilistic and is not authentication. Enrollment requires explicit consent. Raw samples are bounded and discarded; encrypted templates stay server-side and never enter browser storage.</p>
      <p className="suggestion-meta muted">Provider: {voiceIdentity.status?.provider ?? 'checking'} / {voiceIdentity.status?.model ?? 'checking'} / encryption: {voiceIdentity.status?.encryption?.configured ? 'ready' : 'missing key'} / microphone: {voice.listening ? 'streaming' : 'stopped'}</p>
      <p className="suggestion-meta muted">Face: {faceIdentity.status?.provider ?? 'checking'} / {faceIdentity.status?.repo ?? 'checking'} / {faceIdentity.enrolledCount} enrolled / camera: {inspector.watching ? 'running' : 'off'} / recognition {inspector.watching && faceIdentity.enrolledCount > 0 ? 'active' : 'idle'}</p>
      <div className="audio-warning">
        <AlertTriangle size={14} />
        <span>
          Face recognition has <strong>no liveness check</strong> — a printed photograph may match — and consent enforcement is currently OFF in this build.
          A match is evidence, never authentication: because the camera is worn and looks outward, a recognised face means someone is <em>present</em>, not that they are the one speaking.
          Enrollment needs the camera you can see running, captures a few frames, and stores one averaged template server-side. No image is kept, by either side.
        </span>
      </div>
      {faceIdentity.status && !faceIdentity.ready && <div className="error"><AlertTriangle size={16} /> Face recognition is unavailable: {faceIdentity.status.reason ?? 'the template store is not configured'}.</div>}
      {faceIdentity.lastResult && <p className="suggestion-meta muted">Latest face result: {faceIdentity.lastResult}</p>}
      {faceIdentity.error && <div className="error"><AlertTriangle size={16} /> {faceIdentity.error}</div>}
      {voiceIdentity.status?.developmentOnly && <div className="audio-warning"><AlertTriangle size={14} /><span>Development-only biometric operation: restricted to loopback. Production routes remain disabled until real token verification is configured.</span></div>}
      {voiceIdentity.status && !voiceIdentity.status.ready && <div className="error"><AlertTriangle size={16} /> Voice enrollment is unavailable. Check the server-only biometric key and provider health.</div>}

      {voiceIdentity.operation && (
        <div className="audio-warning">
          <Radio size={14} />
          <span>Capturing {voiceIdentity.operation.purpose} for {voiceIdentity.operation.personId} / {(elapsedMs / 1000).toFixed(1)}s of 12s. Speak naturally for at least 2.5s with one speaker and no playback.</span>
          <button type="button" disabled={elapsedMs < 2500} onClick={() => voiceIdentity.finish().catch(() => {})}>Finish sample</button>
          <button type="button" className="link-btn" onClick={() => voiceIdentity.cancel().catch(() => {})}>Cancel</button>
        </div>
      )}
      {voiceIdentity.result && <p className="suggestion-meta muted">Latest voice result: {voiceIdentity.result.reasonCode ?? voiceIdentity.result.decision ?? 'complete'}{voiceIdentity.result.matches?.[0]?.score != null ? ` / similarity ${Math.round(voiceIdentity.result.matches[0].score * 100)}%` : ''}</p>}
      {voiceIdentity.result?.decision === 'ambiguous' && voiceIdentity.result.matches?.slice(0, 3).map((match) => <div className="suggestion-actions" key={match.personId}><span className="muted">Candidate {match.personId} / similarity {Math.round(match.score * 100)}%</span><button type="button" onClick={() => voiceIdentity.confirmCandidate(match.personId).catch(() => {})}>Confirm</button><button type="button" className="link-btn" onClick={() => voiceIdentity.rejectCandidate(match.personId).catch(() => {})}>Reject</button></div>)}
      {voiceIdentity.error && <div className="error"><AlertTriangle size={16} /> {voiceIdentity.error}</div>}

      {active.length > 0 ? (
        <ul className="diagnostic-trace">
          {active.map((person) => <VoicePersonRow key={person.personId} person={person} people={people} voiceIdentity={voiceIdentity} voice={voice} faceIdentity={faceIdentity} cameraOn={inspector.watching} grabFrame={inspector.grabFrame} onShowEvidence={(id) => setEvidenceFor(evidenceFor === id ? null : id)} evidenceOpen={evidenceFor === person.personId} evidence={evidenceFor === person.personId ? evidence : null} />)}
        </ul>
      ) : <div className="empty">No people resolved yet.</div>}

      {relationships.length > 0 && <><p className="suggestion-meta muted">Relationships:</p><ul className="diagnostic-trace">{relationships.map((relationship) => <li key={relationship.relationshipId}><span className="chip">{relationship.type}</span> {relationship.fromEntityId} to {relationship.toEntityId}{relationship.label ? ` (${relationship.label})` : ''}</li>)}</ul></>}
    </details>
  );
}

const PROVIDER_MODE_LABEL = {
  server: 'server (SQLite, authenticated)',
  'localStorage-dev-fallback': 'localStorage — DEV FALLBACK ONLY (server unreachable)',
  unavailable: 'UNAVAILABLE — durable writes are disabled (production fail-closed)',
};

// Dev-only Server Data panel (src/useServerData.js + useMemory/usePeople's
// dataProviderStatus): which repository provider is actually active, DB/auth
// status, the localStorage -> server migration flow (dry run -> import ->
// verify -> optional local cleanup), retention cleanup, a redacted audit
// log, and the workspace-deletion danger zone. No secrets, database URLs,
// tokens, or raw biometric material are ever rendered here.
function QueueStatusLine({ status }) {
  if (!status) return null;
  const open = status.pending + status.retrying;
  return (
    <p className="suggestion-meta muted">
      {status.label} sync queue: {open > 0 ? `${open} awaiting server acknowledgement` : 'all acknowledged'}
      {' '}· acked {status.acknowledged} · retrying {status.retrying} · failed {status.failed} · conflicted {status.conflicted} · cancelled {status.cancelled}
    </p>
  );
}

function ServerDataPanel({ memory, people, serverData, preflight }) {
  return (
    <details className="agent-debug">
      <summary>
        Server Data — memory: {PROVIDER_MODE_LABEL[memory.dataProviderStatus.mode] ?? memory.dataProviderStatus.mode} · identity: {PROVIDER_MODE_LABEL[people.dataProviderStatus.mode] ?? people.dataProviderStatus.mode}
        {(memory.queueStatus?.open > 0 || people.queueStatus?.open > 0) ? ' · syncing…' : ''}
        {(memory.queueStatus?.failed > 0 || people.queueStatus?.failed > 0 || memory.queueStatus?.conflicted > 0 || people.queueStatus?.conflicted > 0) ? ' · SYNC ISSUES' : ''}
      </summary>

      {memory.dataProviderStatus.mode !== 'server' && (
        <div className="audio-warning">
          <AlertTriangle size={14} />
          <span>Not using the authenticated server repository — see the mode above. Durable data is {memory.dataProviderStatus.mode === 'unavailable' ? 'NOT being written anywhere' : 'only in this browser\'s localStorage'}.</span>
        </div>
      )}

      <QueueStatusLine status={memory.queueStatus} />
      <QueueStatusLine status={people.queueStatus} />
      {(memory.queueStatus?.failed > 0 || people.queueStatus?.failed > 0) && (
        <div className="suggestion-actions">
          <button type="button" onClick={() => { memory.mutationQueue.retryFailed(); people.mutationQueue.retryFailed(); }}>Retry failed sync operations</button>
        </div>
      )}

      {preflight && (
        <>
          <div className="suggestion-actions" style={{ marginTop: '0.5rem' }}>
            <button type="button" disabled={preflight.busy} onClick={preflight.run}>Run preflight</button>
          </div>
          {preflight.report && (
            <ul className="diagnostic-trace">
              <li><strong>overall</strong>: {preflight.report.overall}</li>
              {Object.entries(preflight.report.sections).map(([name, section]) => (
                <li key={name}>
                  <strong>{name}</strong>: {section.state}
                  {section.reason ? ` — ${section.reason}` : ''}
                  {section.mode ? ` · mode ${section.mode}` : ''}
                  {section.schemaVersion ? ` · schema ${section.schemaVersion}` : ''}
                  {section.permission ? ` · permission ${section.permission}` : ''}
                </li>
              ))}
              {(preflight.report.envWarnings ?? []).map((warning, i) => <li key={`warn-${i}`} className="muted">env: {warning}</li>)}
            </ul>
          )}
        </>
      )}
      {memory.dataProviderStatus.authMode === 'development' && (
        <p className="suggestion-meta muted">Auth mode: development (deterministic principal{memory.dataProviderStatus.principal ? ` — ${memory.dataProviderStatus.principal.userId}/${memory.dataProviderStatus.principal.workspaceId}` : ''}). This is NOT production authentication.</p>
      )}

      <p className="suggestion-meta muted" style={{ marginTop: '0.5rem' }}>
        Legacy browser records awaiting migration: {serverData.legacyCounts.memories} memories · {serverData.legacyCounts.people} people · {serverData.legacyCounts.evidence} evidence · {serverData.legacyCounts.relationships} relationships
      </p>
      <div className="suggestion-actions">
        <button type="button" disabled={serverData.busy} onClick={serverData.runDryRun}>Dry-run migration</button>
        <button type="button" disabled={serverData.busy || !serverData.migrationPlan} onClick={serverData.runImport}>Import (confirmed)</button>
        <button type="button" disabled={!serverData.migrationResult?.verify} onClick={serverData.clearLocal}>Clear local records (after verified import)</button>
      </div>
      {serverData.migrationPlan && (
        <ul className="diagnostic-trace">
          {Object.entries(serverData.migrationPlan.plan).filter(([k]) => k !== 'generatedAt').map(([type, summary]) => (
            <li key={type}>
              <strong>{type}</strong>: {summary.total} total — {summary.counts.valid} valid, {summary.counts.duplicate} duplicate, {summary.counts.malformed} malformed
            </li>
          ))}
        </ul>
      )}
      {serverData.migrationResult && (
        <p className="suggestion-meta muted">
          Import result: {JSON.stringify(serverData.migrationResult.report)} {serverData.migrationResult.alreadyApplied ? '(replayed from a prior identical operation)' : ''}
        </p>
      )}

      <div className="suggestion-actions" style={{ marginTop: '0.5rem' }}>
        <button type="button" disabled={serverData.busy} onClick={serverData.runRetentionCleanup}>Run retention cleanup</button>
        <button type="button" disabled={serverData.busy} onClick={serverData.loadAudit}>Load recent audit events</button>
      </div>
      {serverData.retentionResult && (
        <p className="suggestion-meta muted">
          Retention: {serverData.retentionResult.expiredSessions} sessions expired · {serverData.retentionResult.expiredProvisionalPeople.length} provisional people expired · {serverData.retentionResult.staleIdentityEvidence} stale evidence records removed
        </p>
      )}
      {serverData.auditEvents.length > 0 && (
        <ul className="diagnostic-trace">
          {serverData.auditEvents.map((e) => (
            <li key={e.auditId}>
              <span className="muted">{new Date(e.at).toISOString().slice(11, 23)}</span>{' '}
              <span className="chip trace-agent">{e.action}</span>{' '}
              {e.resourceType}{e.resourceId ? ` (${e.resourceId})` : ''} — {e.outcome}{e.reasonCode ? ` · ${e.reasonCode}` : ''}
              {e.redacted ? <span className="muted"> · content redacted</span> : null}
            </li>
          ))}
        </ul>
      )}

      {serverData.error && <div className="error"><AlertTriangle size={16} /> {serverData.error}</div>}

      <details style={{ marginTop: '0.5rem' }}>
        <summary>Danger zone — delete all workspace data</summary>
        <div className="suggestion-actions">
          <button type="button" disabled={serverData.busy} onClick={serverData.loadWorkspacePlan}>Preview impact</button>
          {serverData.workspacePlan && (
            <button
              type="button"
              onClick={() => {
                // eslint-disable-next-line no-alert
                if (window.confirm(`Permanently delete ALL workspace data? ${JSON.stringify(serverData.workspacePlan.counts)}`)) serverData.confirmWorkspaceDelete();
              }}
            >
              Confirm delete everything
            </button>
          )}
        </div>
        {serverData.workspacePlan && <p className="suggestion-meta muted">Impact: {JSON.stringify(serverData.workspacePlan.counts)}</p>}
      </details>
    </details>
  );
}

// Development-only live-loop harness (no real microphone available in this
// environment). It injects a finalized transcript segment through the EXACT
// same per-segment pipeline a real Deepgram segment traverses (App's
// `processSegment`) — echo classification, barge-in/stop handling, the agent
// runtime's public handleSegment entry point, and the Opportunity Engine. It
// never calls the Speech Gate, TTS provider, or playback controller directly;
// those only run because the runtime/engine invoke them internally, exactly as
// they would for a real microphone segment.
function DevHarnessPanel({ onInject, lastSpokenText, log }) {
  const [speaker, setSpeaker] = useState('Harness');
  const [text, setText] = useState('Roma, what time is it?');
  return (
    <details className="agent-debug">
      <summary>Dev harness — inject a finalized transcript (no real microphone in this environment)</summary>
      <div className="harness-row">
        <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="speaker label" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="finalized utterance text" />
        <button type="button" onClick={() => onInject(speaker, text)}>Inject</button>
        <button type="button" disabled={!lastSpokenText} onClick={() => onInject(speaker, lastSpokenText)}>Inject Roma's last reply as mic echo</button>
      </div>
      {log.length > 0 && (
        <ul className="diagnostic-trace">
          {log.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </details>
  );
}

function App() {
  const voice = useVoice();
  // People come before the Inspector: the face recognizer the Inspector runs
  // needs to turn person ids into names, and the camera must never start
  // before the thing that decides whether recognition may run at all.
  const memory = useMemory();
  const people = usePeople({ memoryRepository: memory.repository, memoryCoordinator: memory.coordinator });
  const cameraOnRef = useRef(false);
  const faceIdentity = useFaceIdentity({ people, cameraOn: () => cameraOnRef.current });
  const inspector = useInspector({ faces: faceIdentity.recognizer });
  cameraOnRef.current = inspector.watching;
  const voiceDelivery = useVoiceDelivery();
  const proactive = useProactive({ sceneStore: inspector.sceneStore, speech: voiceDelivery.delivery });
  // identityMutationQueue lets consent revocation / profile deletion cancel
  // still-pending queued voice-profile mutations (see useVoiceIdentity.js).
  const voiceIdentity = useVoiceIdentity(voice, { romaSpeaking: voiceDelivery.voiceActivity.romaSpeaking, identityMutationQueue: people.mutationQueue });
  const serverData = useServerData();
  // Background server-agent tasks. The notifier inside this hook decides what
  // is worth saying; anything spoken passes the SAME Speech Gate as every
  // other utterance (src/agent/taskNotifier.js, src/useAgentTasks.js).
  const agentTasks = useAgentTasks({
    speech: voiceDelivery.delivery,
    speechGate: proactive.speechGate,
    getPreferences: proactive.getPreferences,
  });
  const [preflightReport, setPreflightReport] = useState(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const preflightClient = useMemo(() => createDataClient(), []);
  const preflight = {
    report: preflightReport,
    busy: preflightBusy,
    run: async () => {
      setPreflightBusy(true);
      try {
        setPreflightReport(await runPreflight({
          dataClient: preflightClient,
          audioReadiness: voiceDelivery.audioState,
          repositoryProviders: { memory: memory.dataProviderStatus.mode, identity: people.dataProviderStatus.mode },
          queueStatuses: [memory.queueStatus, people.queueStatus].filter(Boolean),
        }));
      } finally {
        setPreflightBusy(false);
      }
    },
  };
  const agent = useAgent({
    sceneStore: inspector.sceneStore,
    frameBuffer: inspector.frameBuffer,
    deepAnalyzer: inspector.deepAnalyzer,
    speechGate: proactive.speechGate,
    getPreferences: proactive.getPreferences,
    speech: voiceDelivery.delivery,
    memory: memory.coordinator,
    identity: people.coordinator,
    principal: memory.dataProviderStatus.principal,
    // Glasses reframe: when Roma stays out of a conversation but notices it
    // could help the WEARER, the hint becomes evaluation context for the
    // Opportunity Engine. It is never speech — the Intervention Policy and
    // Speech Gate still decide whether anything is delivered at all.
    onAssistOpportunity: (hint) => proactive.noteAssistOpportunity(hint),
    // Background tasks: the tool surface Roma dispatches through, plus the
    // bounded pending list so a spoken approval resolves to the right task.
    serverTasks: agentTasks.toolApi,
    pendingTasks: agentTasks.pendingTasks,
    // What the background agent can be pointed at. Without this Roma decides
    // she has no access to any codebase and apologises instead of dispatching.
    registeredProjects: agentTasks.registeredProjects,
  });
  const [copied, setCopied] = useState(false);
  const [harnessLog, setHarnessLog] = useState([]);
  const peakLevelRef = useRef(0); // peak mic level since the last finalized turn (wearer heuristic)

  // Virtual-hardware lab observability bridge (DEV + simulation session only):
  // registers a BOUNDED read-only snapshot of state the panels already render.
  // The lab never mutates anything through this — see src/simulation/index.js.
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window.__romaSimAttach !== 'function') return undefined;
    window.__romaSimAttach({
      getState: () => ({
        listening: voice.listening,
        interim: (voice.interim ?? '').slice(0, 200),
        segments: (voice.segments ?? []).slice(-12).map((s) => ({ speaker: s.speaker, text: String(s.text ?? '').slice(0, 200), endedAt: s.endedAt })),
        speakers: voice.speakers,
        agentEvents: (agent.events ?? []).slice(-25).map((e) => ({
          type: e.type, turnId: e.turnId, decision: e.decision,
          text: typeof e.text === 'string' ? e.text.slice(0, 200) : undefined,
          spokenApproved: e.spokenApproved, reason: e.reason, stage: e.stage,
          reasonCode: e.reasonCode, corrected: e.corrected,
          message: typeof e.message === 'string' ? e.message.slice(0, 160) : undefined,
        })),
        // Wearer-centered classification per turn (glasses reframe): what Roma
        // understood about who was speaking to whom, and whether it saw a
        // chance to help — including on turns it deliberately stayed out of.
        addresseeDecisions: (agent.events ?? [])
          .filter((e) => e.type === 'addressee-decision')
          .slice(-20)
          .map((e) => ({
            turnId: e.turnId,
            decision: e.decision,
            addressedToRoma: e.addressedToRoma,
            reasonCode: e.reasonCode,
            speakerRole: e.speakerRole,
            addressedTo: e.addressedTo,
            wearerExpectedToRespond: e.wearerExpectedToRespond,
            assistOpportunity: typeof e.assistOpportunity === 'string' ? e.assistOpportunity.slice(0, 160) : null,
          })),
        wearer: agent.wearerState?.() ?? null,
        suggestionCount: (proactive.suggestions ?? []).length,
        // Background server-agent tasks and what Roma decided to say about
        // them (src/agent/taskNotifier.js) — bounded, read-only.
        serverTasks: [...(agentTasks.recentTasks ?? []), ...(agentTasks.tasks ?? [])]
          .filter((task, index, all) => all.findIndex((other) => other.taskId === task.taskId) === index)
          .slice(-10)
          .map((task) => ({
          taskId: task.taskId, status: task.status, title: task.title,
          progressCount: (task.progress ?? []).length,
          pendingRequest: task.pendingRequest?.text ?? null,
          resultSummary: typeof task.resultSummary === 'string' ? task.resultSummary.slice(0, 200) : null,
        })),
        taskNotifications: (agentTasks.events ?? []).slice(-20).map((event) => ({ kind: event.kind, reasonCode: event.reasonCode, taskId: event.taskId })),
        taskWorker: agentTasks.worker ?? null,
        taskState: agent.taskState ? { active: agent.taskState.active, goal: agent.taskState.goal } : null,
        engagement: agent.engagementState(),
        turnState: voiceDelivery.turnState,
        voiceEvents: (voiceDelivery.events ?? []).slice(-30).map((e) => ({
          type: e.type, authorizationId: e.authorizationId, turnId: e.turnId,
          reason: typeof e.reason === 'string' ? e.reason.slice(0, 120) : undefined,
          provider: e.provider, sourceType: e.sourceType,
        })),
        deliveryMetrics: voiceDelivery.metrics(),
        audioState: voiceDelivery.audioState,
        scene: inspector.scene ? {
          revision: inspector.scene.revision,
          updatedAt: inspector.scene.updatedAt,
          objects: (inspector.scene.objects ?? []).slice(0, 15).map((o) => ({ label: o.label, position: o.position, visibility: o.visibility, confidence: +(o.confidence ?? 0).toFixed(2) })),
          people: (inspector.scene.people ?? []).length,
          // Bounded identity view for the lab's face checks: who the camera
          // has settled on, never a name the browser could not look up.
          peopleIdentified: (inspector.scene.people ?? []).slice(0, 8).map((person) => ({
            identity: person.identity ?? null,
            personId: person.personId ?? null,
            confidence: +(person.confidence ?? 0).toFixed(2),
          })),
        } : null,
        inspectorStatus: inspector.status,
        watching: inspector.watching,
        memoryCounts: memory.counts,
        memoryQueue: memory.queueStatus,
        identityQueue: people.queueStatus,
        peopleCounts: people.counts,
        dataProvider: memory.dataProviderStatus.mode,
      }),
    });
    return undefined;
  });
  const handledCountRef = useRef(0);
  const sessionStartRef = useRef(Date.now());

  useEffect(() => {
    const resolution = voiceIdentity.result?.resolution;
    if (resolution?.status !== 'resolved') return;
    people.coordinator.acceptServerVoiceResolution({ ...resolution, sessionId: voiceIdentity.result.sessionId, speakerLabel: resolution.speakerLabel ?? voiceIdentity.result.speakerLabel });
  }, [people.coordinator, voiceIdentity.result]);

  // Approved proposals / converted suggestions become local agent task state.
  useEffect(() => {
    proactive.setOnTaskApproved((task) => agent.setTaskState(task));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forward the server health check (agent hook owns it) to the proactive +
  // voice-delivery hooks so they fall back to silent/mock providers when the
  // server has no key.
  useEffect(() => {
    if (agent.health) { proactive.setHealth(agent.health); voiceDelivery.setHealth(agent.health); memory.setHealth(agent.health); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.health]);

  // Feed the mic level + interim transcript into voice-activity detection so the
  // gap detector and barge-in logic have a real signal.
  // The same level stream also feeds the wearer heuristic: we keep the PEAK
  // level seen since the last finalized turn, because the person wearing the
  // glasses is consistently the loudest voice at the microphone. Peak (not the
  // instantaneous value at finalization, which has already decayed) is what
  // makes that comparison meaningful. See src/agent/wearer.js.
  useEffect(() => {
    voiceDelivery.pushLevel(voice.level);
    if (voice.level > peakLevelRef.current) peakLevelRef.current = voice.level;
  }, [voice.level, voiceDelivery]);
  useEffect(() => { if (voice.interim) voiceDelivery.pushInterim(voice.interim); }, [voice.interim, voiceDelivery]);

  // The reactive agent's decision reaches the pending proactive batch so the
  // two systems never produce duplicate output for the same turn.
  useEffect(() => {
    const latest = agent.events.at(-1);
    if (latest && (latest.type === 'response' || latest.type === 'clarification')) proactive.noteReactiveHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.events]);

  // The single per-segment pipeline: echo classification -> barge-in/stop
  // handling -> engagement exit -> the agent runtime's real entry point
  // (handleSegment) -> the Opportunity Engine. Used by the real mic-driven
  // effect below AND by the dev-only harness (DevHarnessPanel), so a harness-
  // injected utterance traverses the EXACT same production path a real
  // Deepgram segment would, echo suppression included — it never calls the
  // Speech Gate, TTS provider, or playback controller directly; those only
  // ever run because the runtime/engine invoke them internally.
  const processSegment = useCallback((segment) => {
    const startedAtMs = sessionStartRef.current + Math.round((segment.startedAt ?? 0) * 1000);
    const endedAtMs = sessionStartRef.current + Math.round((segment.endedAt ?? segment.startedAt ?? 0) * 1000);
    const durationMs = Math.max(0, endedAtMs - startedAtMs);

    // Is this Roma's own playback echoing back through the mic? If so, drop it
    // before it reaches the reactive agent and the Opportunity Engine.
    const echo = voiceDelivery.classifyTranscript({ text: segment.text, startedAt: startedAtMs, endedAt: endedAtMs });
    // Barge-in / deterministic stop while Roma may be speaking (real user only).
    const handling = echo.isEcho
      ? { forward: false }
      : voiceDelivery.handleUserSpeech({ text: segment.text, durationMs, at: endedAtMs, speaker: segment.speaker, startedAt: startedAtMs, endedAt: endedAtMs, bargeInEnabled: proactive.preferences.bargeInEnabled !== false });
    // Close the current voice-activity burst either way.
    voiceDelivery.pushSegment({ speaker: segment.speaker, at: endedAtMs });

    if (handling.forward === false) return { ...handling, echo: true };

    // A deterministic stop phrase ("stop", "never mind", …) exits the
    // conversation-engagement window immediately — a follow-up afterward
    // needs the wake word again, it doesn't ride the old window.
    if (handling.stopCommand) agent.exitEngagement('stop phrase');

    // `level` is the peak microphone level observed during this turn — the
    // deterministic wearer heuristic's only real signal (src/agent/wearer.js).
    // Reset per turn so each speaker is judged on their own loudness.
    const peakLevel = peakLevelRef.current;
    peakLevelRef.current = 0;
    agent.handleSegment({ speaker: segment.speaker, text: segment.text, startedAt: segment.startedAt, endedAt: segment.endedAt, level: peakLevel });
    // The Opportunity Engine sees the same finalized turns (batched +
    // fingerprinted internally — this does not mean one model call per turn).
    proactive.observeTurn({ speaker: segment.speaker, text: segment.text, at: startedAtMs });
    return { ...handling, echo: false, forwardedToAgent: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceDelivery, agent, proactive]);

  // Feed each NEWLY finalized transcript segment to the agent runtime exactly
  // once, in order — the runtime automatically attaches the latest visual
  // snapshot and decides whether to respond, without a voice trigger.
  useEffect(() => {
    const freshSegments = voice.segments.slice(handledCountRef.current);
    handledCountRef.current = voice.segments.length;
    for (const segment of freshSegments) processSegment(segment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.segments]);

  // Dev harness: same processSegment() pipeline, manually triggered instead of
  // by a real Deepgram segment. Logs what happened (forwarded / suppressed as
  // echo / stop command / barge-in) so the harness is self-verifying.
  const injectHarnessSegment = useCallback((speaker, text) => {
    if (!text) return;
    const nowSec = (Date.now() - sessionStartRef.current) / 1000;
    const segment = { id: `harness_${Date.now()}`, speaker, text, startedAt: nowSec, endedAt: nowSec + Math.max(0.4, text.length / 15) };
    const result = processSegment(segment);
    const outcome = result.stopCommand ? 'stop command (playback cancelled, still forwarded)' : result.echo ? 'suppressed — classified as Roma\'s own echo' : result.bargeIn ? 'barge-in (playback stopped) + forwarded to agent' : 'forwarded to agent';
    setHarnessLog((existing) => [...existing, `${new Date().toISOString().slice(11, 19)}  "${speaker}: ${text}"  →  ${outcome}`].slice(-20));
  }, [processSegment]);

  const startAll = useCallback(() => {
    handledCountRef.current = 0;
    sessionStartRef.current = Date.now();
    agent.beginSession(sessionStartRef.current);
    // Unlock browser audio playback using THIS click's user gesture, before any
    // await — so a real HTMLAudioElement.play() later in the session isn't
    // blocked by autoplay policy. Visual delivery still works even if this fails.
    voiceDelivery.unlockAudio();
    voice.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice]);

  // turnId is 1-based and assigned in the same order segments are handed to the
  // agent, so turnId - 1 maps directly back to the segment that caused it.
  const responseBySegmentIndex = useMemo(() => {
    const map = new Map();
    for (const event of agent.events) {
      if (event.type === 'response' || event.type === 'clarification') map.set(event.turnId - 1, event);
    }
    return map;
  }, [agent.events]);

  const transcriptText = useMemo(
    () => voice.segments.map((segment) => `${segment.speaker ?? 'Speaker ?'}: ${segment.text}`).join('\n'),
    [voice.segments],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(transcriptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  }, [transcriptText]);

  const download = useCallback(() => {
    const blob = new Blob([transcriptText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `roma-transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }, [transcriptText]);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo"><Mic size={18} /></span>
          <div>
            <strong>Roma AI</strong>
            <small>Real-time transcription &amp; diarization · Deepgram</small>
          </div>
        </div>
        <span className={`status-pill ${voice.listening ? 'live' : ''}`}>
          <Radio size={13} /> {voice.status}
        </span>
      </header>

      {!voice.hasApiKey && (
        <section className="setup">
          <KeyRound size={18} />
          <div>
            <strong>Add your Deepgram API key.</strong>
            <p>Create a gitignored <code>.env</code> file in the project root, then restart <code>npm run dev</code>:</p>
            <code>DEEPGRAM_API_KEY=your_key_here</code>
            <p className="muted">Server-side only — the browser mints a short-lived token per session. Get a free key at console.deepgram.com (includes free credit).</p>
          </div>
        </section>
      )}

      <section className="console">
        <button
          type="button"
          className={`record ${voice.listening ? 'recording' : ''}`}
          onClick={voice.listening ? voice.stop : startAll}
          disabled={voice.starting || !voice.hasApiKey}
        >
          {voice.starting ? <Loader2 size={20} className="spin" /> : voice.listening ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}
          <span>{voice.starting ? 'Connecting…' : voice.listening ? 'Stop' : 'Start'}</span>
        </button>

        <div className="console-meta">
          <div className="meter"><span style={{ width: `${Math.round(voice.level * 100)}%` }} /></div>
          <div className="interim">{voice.interim || (voice.listening ? 'Listening…' : 'Press Start and begin speaking.')}</div>
        </div>

        <div className="speaker-count"><Users size={15} /> {voice.speakers.length || '—'}</div>

        <button
          type="button"
          className={`watch ${inspector.watching ? 'watching' : ''}`}
          onClick={inspector.watching ? inspector.stopWatching : inspector.startWatching}
          disabled={inspector.startingCamera}
          title={inspector.watching ? 'Stop the camera' : 'Start the camera (Inspector)'}
        >
          {inspector.startingCamera ? <Loader2 size={16} className="spin" /> : inspector.watching ? <VideoOff size={16} /> : <Video size={16} />}
        </button>
      </section>

      {voice.error && <div className="error"><AlertTriangle size={16} /> {voice.error}</div>}
      {inspector.inspectorError && <div className="error"><AlertTriangle size={16} /> {inspector.inspectorError}</div>}

      <ScenePanel inspector={inspector} />
      <AgentPanel agent={agent} lastSegment={agent.lastTurn ? voice.segments[agent.lastTurn.turnId - 1] : null} />
      <ProactivePanel proactive={proactive} />
      <VoicePanel voiceDelivery={voiceDelivery} proactive={proactive} health={agent.health} />
      {import.meta.env.DEV && <DiagnosticsPanel agentEvents={agent.events} deliveryEvents={voiceDelivery.events} />}
      {import.meta.env.DEV && <MemoryPanel memory={memory} />}
      {import.meta.env.DEV && <VoicePeoplePanel people={people} voiceIdentity={voiceIdentity} voice={voice} faceIdentity={faceIdentity} inspector={inspector} />}
      {import.meta.env.DEV && <ServerDataPanel memory={memory} people={people} serverData={serverData} preflight={preflight} />}
      {import.meta.env.DEV && <DevHarnessPanel onInject={injectHarnessSegment} lastSpokenText={voiceDelivery.lastSpoken?.text} log={harnessLog} />}

      <section className="transcript">
        <div className="transcript-head">
          <div className="title">Transcript</div>
          {voice.segments.length > 0 && (
            <div className="transcript-stats">
              <span><Users size={13} /> {voice.speakers.length} {voice.speakers.length === 1 ? 'speaker' : 'speakers'}</span>
              <button type="button" onClick={copy}>{copied ? <CheckCircle2 size={14} /> : <Copy size={14} />} Copy</button>
              <button type="button" onClick={download}><Download size={14} /> Export</button>
            </div>
          )}
        </div>

        {voice.segments.length === 0 ? (
          <div className="empty">No transcript yet. Speaker-labeled turns appear as people speak, split on pauses.</div>
        ) : (
          <ol className="turns">
            {voice.segments.map((segment, index) => (
              <React.Fragment key={segment.id}>
                <li className={`turn color-${speakerColor(segment.speaker)}`}>
                  <span className="chip">{segment.speaker}</span>
                  <p>{segment.text}</p>
                </li>
                {responseBySegmentIndex.has(index) && (
                  <li className="turn roma">
                    <span className="chip roma-chip"><Bot size={12} /> Roma</span>
                    <p>{responseBySegmentIndex.get(index).text}</p>
                  </li>
                )}
              </React.Fragment>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

async function boot() {
  // Virtual-hardware lab (development only — see src/simulation/index.js and
  // VIRTUAL-HARDWARE.md). Activates ONLY when the automation controller
  // injected window.__ROMA_SIMULATION__ before load; the import itself is
  // inside an import.meta.env.DEV guard, so production builds contain none of
  // this code (enforced by test/simulation-security.test.js). Activation runs
  // BEFORE first render so the virtual getUserMedia boundary is in place
  // before any capture can start.
  if (import.meta.env.DEV && window.__ROMA_SIMULATION__) {
    const { activateSimulation } = await import('./simulation/index.js');
    activateSimulation();
  }
  createRoot(document.getElementById('root')).render(<App />);
}
boot();
