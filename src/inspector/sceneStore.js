// Live Scene State store — the shared, structured source of truth the Inspector
// writes continuously and the Context Compiler reads on demand. Lives OUTSIDE the
// main agent's context window; nothing here touches conversation history.
//
// Pure and dependency-free (runs in browser + Node tests). update() replaces the
// object/people arrays wholesale (the tracker owns identity), diffs against the
// previous state to promote NOTABLE changes into a bounded recent-events queue
// (dedup + cooldown so normal churn stays silent), and notifies subscribers.

import { now } from '../clock.js';

export function emptySceneState() {
  return {
    revision: 0,
    updatedAt: 0,
    scene: { label: 'no scene detected', summary: '' },
    objects: [],   // [{ id, label, confidence, position, visibility, firstSeenAt, lastSeenAt }]
    people: [],    // [{ id, identity|null, confidence, lastSeenAt }]
    recentEvents: [], // [{ at, type, message }]
    keyframes: [],    // [{ at, reason }] — frames themselves live in the frame buffer
  };
}

/**
 * @param {{ maxEvents?: number, eventCooldownMs?: number, maxKeyframes?: number }} [options]
 */
export function createSceneStore({ maxEvents = 20, eventCooldownMs = 8000, maxKeyframes = 20 } = {}) {
  let state = emptySceneState();
  const listeners = new Set();
  const lastEventAt = new Map(); // `${type}:${key}` -> epoch ms, for dedup/rate-limiting
  let eventCounter = 0;

  function notify() {
    for (const listener of listeners) listener(state);
  }

  function promote(type, message, key, at) {
    const dedupKey = `${type}:${key}`;
    const last = lastEventAt.get(dedupKey);
    if (last !== undefined && at - last < eventCooldownMs) return;
    lastEventAt.set(dedupKey, at);
    eventCounter += 1;
    // Events carry their own identity. Two people entering in the same frame
    // produce two events of the same type at the same millisecond, so
    // type+timestamp does not identify one — which is what made React warn
    // about duplicate keys during camera sessions.
    state.recentEvents = [...state.recentEvents, { id: `scene_event_${at}_${eventCounter}`, at, type, message }].slice(-maxEvents);
  }

  function diffAndPromote(previous, next, at) {
    const prevPeople = new Set(previous.people.map((p) => p.id));
    for (const person of next.people) {
      if (!prevPeople.has(person.id)) {
        promote('person-entered', `${person.identity ?? 'An unidentified person'} entered the scene`, person.identity ?? person.id, at);
      }
    }

    const prevVisibility = new Map(previous.objects.map((o) => [o.id, o.visibility]));
    for (const object of next.objects) {
      const before = prevVisibility.get(object.id);
      if (before === undefined && object.visibility === 'visible') {
        promote('object-appeared', `A ${object.label} became visible (${object.position})`, object.label, at);
      } else if (before === 'visible' && object.visibility === 'missing') {
        promote('object-lost', `The ${object.label} is no longer visible`, object.label, at);
      }
    }
  }

  return {
    /** Full fast-path write: replaces objects/people/scene, promotes events, bumps revision. */
    update({ objects = [], people = [], sceneLabel, summary } = {}, at = now()) {
      const previous = state;
      state = {
        ...previous,
        revision: previous.revision + 1,
        updatedAt: at,
        scene: {
          label: sceneLabel ?? previous.scene.label,
          summary: summary ?? previous.scene.summary,
        },
        objects,
        people,
      };
      diffAndPromote(previous, state, at);
      notify();
      return state;
    },

    /** Out-of-band notable event (e.g. a frame escalated for deep analysis). */
    recordEvent(type, message, key = message, at = now()) {
      promote(type, message, key, at);
      state = { ...state, revision: state.revision + 1 };
      notify();
    },

    /** Remember that a keyframe exists at `at` (the frame lives in the frame buffer). */
    recordKeyframe(at, reason) {
      state = { ...state, keyframes: [...state.keyframes, { at, reason }].slice(-maxKeyframes) };
      notify();
    },

    /** JSON-safe snapshot; safe to hand to the Context Compiler or serialize. */
    getState() {
      return structuredClone(state);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
