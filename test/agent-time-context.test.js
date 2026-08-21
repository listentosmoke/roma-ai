// Time sense: knowing what day it is, and what is about to matter.
//
// Roma had timestamps on transcript turns and no idea what DAY it was, which
// is why she could not be prudent about anything — "before Friday" is
// meaningless without knowing today is Thursday. Pure formatting tests, in the
// style of identity-context.test.js: assembleContext as a function of
// already-resolved plain objects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext } from '../src/agent/prompt.js';
import { describeNow, describeWhen } from '../src/clock.js';

const THURSDAY_MORNING = Date.parse('2026-08-20T09:15:00');
const turn = (at) => ({ currentTurn: { speaker: 'A', text: 'hello', at }, at });

test('the context states the real date, day and part of day', () => {
  const body = assembleContext(turn(THURSDAY_MORNING)).messages[0].content;
  assert.match(body, /RIGHT NOW: /);
  assert.match(body, /Thursday/, '"before Friday" depends on knowing this');
  assert.match(body, /2026/);
  assert.match(body, /morning/, 'a plan that needs a shop open depends on this');
});

test('deadlines appear whatever the conversation is about', () => {
  const body = assembleContext({
    ...turn(THURSDAY_MORNING),
    upcoming: [
      { summary: 'Send Matt the HVAC quote.', when: 'in 18 hours', overdue: false },
      { summary: 'Call the surveyor.', when: '2 days overdue', overdue: true },
    ],
  }).messages[0].content;

  assert.match(body, /COMING UP/);
  assert.match(body, /- in 18 hours: Send Matt the HVAC quote\./);
  assert.match(body, /- 2 days overdue: Call the surveyor\./);
  assert.doesNotMatch(body, /OVERDUE 2 days overdue/, 'the phrasing must not stutter');
});

test('with nothing due, no deadline section appears at all', () => {
  const body = assembleContext({ ...turn(THURSDAY_MORNING), upcoming: [] }).messages[0].content;
  assert.doesNotMatch(body, /COMING UP/);
});

test('the rules tell her to use the time and to think one step ahead — briefly', () => {
  const { system } = assembleContext(turn(THURSDAY_MORNING));
  assert.match(system, /RIGHT NOW tells you the real date/);
  assert.match(system, /THINK ONE STEP AHEAD/);
  assert.match(system, /common sense, not risk analysis/, 'not an essay about every possible outcome');
  assert.match(system, /Do not read the list out/, 'and not a recital of the deadline list');
});

// ── the clock helpers themselves ──────────────────────────────────────────

test('the time is described the way a person would say it', () => {
  const clock = describeNow(Date.parse('2026-08-22T22:40:00'));
  assert.equal(clock.weekday, 'Saturday');
  assert.equal(clock.partOfDay, 'night');
  assert.equal(clock.isWeekend, true);
});

test('parts of the day split where behaviour changes, not evenly', () => {
  const partAt = (iso) => describeNow(Date.parse(iso)).partOfDay;
  assert.equal(partAt('2026-08-20T03:00:00'), 'night');
  assert.equal(partAt('2026-08-20T08:00:00'), 'morning');
  assert.equal(partAt('2026-08-20T13:00:00'), 'afternoon');
  assert.equal(partAt('2026-08-20T18:30:00'), 'evening');
  assert.equal(partAt('2026-08-20T23:00:00'), 'night');
});

test('how far off something is reads in words, and says when it has passed', () => {
  const at = THURSDAY_MORNING;
  assert.equal(describeWhen(at + 30 * 60_000, at).text, 'in 30 minutes');
  assert.equal(describeWhen(at + 5 * 3_600_000, at).text, 'in 5 hours');
  assert.equal(describeWhen(at + 3 * 86_400_000, at).text, 'in 3 days');

  const late = describeWhen(at - 2 * 86_400_000, at);
  assert.equal(late.overdue, true);
  assert.equal(late.text, '2 days overdue');

  assert.equal(describeWhen(null, at), null);
});
