import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubeRunner, isYoutubeBotError, bilibiliAlternative } from '../src/lib/youtube.js';
import { classifyYtdlpError } from '../src/lib/tools.js';

test('bot check has actionable Chinese code and does not swallow ordinary failures', () => {
  for (const text of ["ERROR: Sign in to confirm you’re not a bot", "Sign in to confirm you're not a bot"]) {
    assert.ok(isYoutubeBotError(text));
    const error = classifyYtdlpError(text);
    assert.equal(error.code, 'YOUTUBE_BOT_CHECK');
    assert.match(error.message, /验证身份/);
  }
  assert.equal(isYoutubeBotError('Video unavailable'), false);
  assert.equal(classifyYtdlpError('HTTP Error 429').code, 'BLOCKED');
});

test('YouTube lane serializes, retries alternate clients and caches metadata results', async () => {
  const waits = [];
  const run = createYoutubeRunner({ sleep: async ms => waits.push(ms), random: () => 0, now: () => 1000 });
  let active = 0, maximum = 0, calls = 0;
  const execute = async (args, { onLine }) => {
    maximum = Math.max(maximum, ++active);
    calls++;
    await Promise.resolve();
    active--;
    if (calls === 1) {
      assert.match(args[1], /player_client=default/);
      return { code: 1, stderr: "Sign in to confirm you're not a bot" };
    }
    assert.match(args[1], /web_safari,mweb/);
    onLine('{"id":"video"}');
    return { code: 0, stderr: '' };
  };
  const output = [];
  const args = ['-J', '--', 'https://www.youtube.com/watch?v=abcdefghijk'];
  await Promise.all([run(args, { onLine: x => output.push(x) }, execute), run(args, { onLine: x => output.push(x) }, execute)]);
  assert.equal(maximum, 1);
  assert.equal(calls, 2);
  assert.equal(output.length, 2);
  assert.deepEqual(waits, [4000]);
});

test('failed tasks do not poison lane; aborted queued requests never start', async () => {
  const run = createYoutubeRunner({ sleep: async () => {} });
  await assert.rejects(run([], {}, async () => { throw new Error('failed'); }));
  const controller = new AbortController();
  controller.abort();
  assert.equal((await run([], { signal: controller.signal }, () => assert.fail('must not execute'))).aborted, true);
  assert.equal((await run([], {}, async () => ({ code: 0 }))).code, 0);
});

test('Bilibili fallback requires matching artist, title, version and duration', () => {
  const track = { title: 'Song', artist: 'Artist', duration: 180, version: 'original' };
  const cover = { ...track, id: 'bilibili:cover', source: 'bilibili', version: 'cover' };
  const match = { ...track, id: 'bilibili:match', source: 'bilibili' };
  assert.equal(bilibiliAlternative(track, [cover, match]), match);
  assert.equal(bilibiliAlternative({ title: 'Song' }, [match]), undefined);
});
