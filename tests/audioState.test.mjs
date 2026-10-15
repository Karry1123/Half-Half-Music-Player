import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAudio } from '../public/audioState.js';
test('paused background, replay, metadata and native foreground read real media state', async () => {
  const audio = Object.assign(new EventTarget(), { currentTime: 48, duration: 100, paused: true });
  const doc = Object.assign(new EventTarget(), { hidden: true });
  let state, native;
  const stop = observeAudio(audio, s => state = s, doc, { addListener: async (_, fn) => { native = fn; return { remove() {} }; } });
  audio.currentTime = 0; audio.dispatchEvent(new Event('seeked'));
  assert.equal(state.position, 0);
  audio.duration = 220; audio.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(state.duration, 220);
  audio.currentTime = 7; doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(state.position, 7); assert.equal(state.playing, false);
  audio.currentTime = 9; audio.paused = false; native({ isActive: true });
  assert.equal(state.position, 9); assert.equal(state.playing, true);
  await Promise.resolve(); stop();
});
