import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackHandler, pushBackLayer } from '../public/mobileRuntime.js';

test('back closes layers last-in-first-out before navigation and double exit', () => {
  const calls = [];
  let time = 100, secondary = true;
  const back = createBackHandler({ keyboard: () => false,
    navigate: () => { if (!secondary) return false; secondary = false; calls.push('navigate'); return true; },
    notify: () => calls.push('hint'), exit: () => calls.push('exit'), now: () => time });
  const a = pushBackLayer(() => { calls.push('a'); a(); });
  const b = pushBackLayer(() => { calls.push('b'); b(); });
  back(); back(); back(); back(); time += 1999; back();
  assert.deepEqual(calls, ['b', 'a', 'navigate', 'hint', 'exit']);
});

test('keyboard or navigation invalidates pending exit; timed-out press only hints', () => {
  let time = 0, keyboard = false, hints = 0, exits = 0;
  const back = createBackHandler({ keyboard: () => keyboard, navigate: () => false,
    notify: () => hints++, exit: () => exits++, now: () => time });
  back(); time = 2001; back(); keyboard = true; back(); keyboard = false; back();
  assert.equal(hints, 3); assert.equal(exits, 0);
});
