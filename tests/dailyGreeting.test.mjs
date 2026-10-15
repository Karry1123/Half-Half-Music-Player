import test from 'node:test';
import assert from 'node:assert/strict';
import { GREETINGS, greetingBucket, localGreetingDate, claimDailyGreeting, greetingStorage } from '../public/dailyGreeting.js';
test('greeting buckets cover every local hour and boundaries', () => {
  const expected = ['midnight','midnight','midnight','midnight','midnight','dawn','dawn','dawn','dawn','dawn','dawn','afternoon','afternoon','afternoon','dusk','dusk','dusk','dusk','dusk','evening','evening','evening','evening','evening'];
  expected.forEach((bucket, hour) => assert.equal(greetingBucket(hour), bucket));
});
test('every bucket has at least three distinct lines and none uses Karry as speaker', () => {
  const lines = Object.values(GREETINGS).flatMap(g => g.lines);
  Object.values(GREETINGS).forEach(g => assert.ok(g.lines.length >= 3));
  lines.forEach(line => assert.doesNotMatch(line, /Karry/));
  assert.equal(new Set(lines).size, lines.length);
});
test('greeting appears once per local date, including concurrent claims, and resets at midnight', async () => {
  let saved;
  const storage = { get: async () => saved, set: async value => { saved = value; } };
  const date = new Date(2026, 9, 15, 23, 59);
  const results = await Promise.all([claimDailyGreeting({date, storage}), claimDailyGreeting({date, storage})]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(saved, '2026-10-15');
  assert.equal(await claimDailyGreeting({date, storage}), null);
  assert.ok(await claimDailyGreeting({date: new Date(2026, 9, 16, 0), storage}));
  assert.equal(localGreetingDate(new Date(2026, 0, 2)), '2026-01-02');
});
test('persisted date suppresses greeting; unavailable storage stays safe offline', async () => {
  const date = new Date(2026, 9, 15, 8);
  assert.equal(await claimDailyGreeting({date, storage: {get: async () => '2026-10-15', set: () => assert.fail()}}), null);
  const storage = {get: async () => {throw Error('offline');}, set: async () => {throw Error('full');}};
  assert.ok(await claimDailyGreeting({date, storage, random: () => 0}));
  assert.equal(await claimDailyGreeting({date, storage}), null);
  await greetingStorage().get(); await greetingStorage().set('2026-10-15');
});
