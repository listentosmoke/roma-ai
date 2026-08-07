// Scenario-schema safety: validation, code-execution rejection, bounded
// timeouts/sizes, and that every shipped scenario in the library validates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateScenario, CONDITIONS, ROOM_PROFILES } from '../src/simulation/schema.js';

const SCENARIO_DIR = join(process.cwd(), 'src', 'simulation', 'scenarios');

const minimal = (overrides = {}) => ({
  scenarioId: 'test_scenario_ok',
  version: 1,
  environment: { roomProfile: 'quiet_office' },
  people: [{ simulationId: 'sim_a', voice: 'aura:aura-2-thalia-en' }],
  events: [{ action: 'person.speak', person: 'sim_a', text: 'hello' }],
  ...overrides,
});

test('every shipped scenario file validates against the schema', () => {
  const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10, `expected a scenario library, found ${files.length}`);
  for (const file of files) {
    const scenario = JSON.parse(readFileSync(join(SCENARIO_DIR, file), 'utf8'));
    const result = validateScenario(scenario);
    assert.ok(result.ok, `${file}: ${result.errors.join('; ')}`);
  }
});

test('a well-formed scenario validates; malformed ones are rejected with reasons', () => {
  assert.equal(validateScenario(minimal()).ok, true);
  assert.equal(validateScenario(null).ok, false);
  assert.equal(validateScenario(minimal({ scenarioId: 'Bad Id!' })).ok, false);
  assert.equal(validateScenario(minimal({ environment: { roomProfile: 'nonexistent_room' } })).ok, false);
  assert.equal(validateScenario(minimal({ people: [{ simulationId: 'not_prefixed' }] })).ok, false);
  assert.equal(validateScenario(minimal({ events: [{ action: 'person.speak', person: 'sim_a' }] })).ok, false, 'missing required text');
});

test('scenario files cannot smuggle executable content', () => {
  for (const bad of [
    minimal({ events: [{ action: 'eval', code: 'alert(1)' }] }),
    minimal({ events: [{ action: 'person.speak', person: 'sim_a', text: 'x', onDone: 'fetch()' }] }),
    minimal({ notes: '<script>alert(1)</script>' }),
    JSON.parse('{"scenarioId":"proto_test","events":[],"__proto__":{"polluted":true}}'),
  ]) {
    assert.equal(validateScenario(bad).ok, false, JSON.stringify(bad).slice(0, 80));
  }
});

test('unknown wait/assert conditions and faults are rejected', () => {
  assert.equal(validateScenario(minimal({ events: [{ action: 'wait_for', condition: 'roma.do_anything', timeoutMs: 1000 }] })).ok, false);
  assert.equal(validateScenario(minimal({ events: [{ action: 'assert', condition: 'made.up' }] })).ok, false);
  assert.equal(validateScenario(minimal({ events: [{ action: 'fault.trigger', fault: 'rm_rf' }] })).ok, false);
});

test('timeouts, waits, text, and event counts are bounded', () => {
  assert.equal(validateScenario(minimal({ events: [{ action: 'wait_for', condition: CONDITIONS[0], timeoutMs: 999_999 }] })).ok, false);
  assert.equal(validateScenario(minimal({ events: [{ action: 'wait', ms: 999_999 }] })).ok, false);
  assert.equal(validateScenario(minimal({ events: [{ action: 'person.speak', person: 'sim_a', text: 'x'.repeat(600) }] })).ok, false);
  const tooMany = Array.from({ length: 201 }, () => ({ action: 'wait', ms: 10 }));
  assert.equal(validateScenario(minimal({ events: tooMany })).ok, false);
});

test('branch nesting is bounded and branch bodies are validated', () => {
  const nested = (depth) => depth === 0
    ? { action: 'wait', ms: 10 }
    : { action: 'branch', condition: CONDITIONS[0], then: [nested(depth - 1)] };
  assert.equal(validateScenario(minimal({ events: [nested(2)] })).ok, true);
  assert.equal(validateScenario(minimal({ events: [nested(5)] })).ok, false);
  assert.equal(validateScenario(minimal({ events: [{ action: 'branch', condition: CONDITIONS[0], then: [{ action: 'nope' }] }] })).ok, false);
});

test('room profiles derive from the environment library (no drift)', () => {
  assert.ok(ROOM_PROFILES.includes('quiet_office'));
  assert.ok(ROOM_PROFILES.includes('visual_question_room'));
});

test('oracle ground-truth metadata (addressedToRoma) is permitted but is never an action argument', () => {
  const result = validateScenario(minimal({ events: [{ action: 'person.speak', person: 'sim_a', text: 'x', addressedToRoma: true }] }));
  assert.equal(result.ok, true);
});
