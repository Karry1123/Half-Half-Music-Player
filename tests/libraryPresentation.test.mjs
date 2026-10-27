import test from 'node:test';
import assert from 'node:assert/strict';
import { recentListening } from '../public/libraryPresentation.js';

test('recent listening uses actual positive listening time, deduplicates and orders newest first', () => {
  const records = [
    { trackId: 'a', timestamp: 10, durationPlayed: 2 },
    { trackId: 'b', timestamp: 20, durationPlayed: 4 },
    { trackId: 'a', timestamp: 30, durationPlayed: 1 },
    { trackId: 'c', timestamp: 40, durationPlayed: 0 },
  ];
  const recent = recentListening(records, { a: { title: 'A' }, b: { title: 'B' } }, [{ id: 'new-a', hash: 'hash-a' }]);
  assert.deepEqual(recent.map(t => t.id), ['a', 'b']);
  assert.equal(recent[0].available, false);
  assert.deepEqual(recentListening([], {}, [{ id: 'a' }]), []);
});

test('recent listening resolves saved metadata to the current local library without inventing playback', () => {
  const recent = recentListening([{ trackId: 'old', timestamp: 1, durationPlayed: 2 }], { old: { title: 'Song', hash: 'same' } }, [{ id: 'new', hash: 'same', title: 'Song' }]);
  assert.equal(recent[0].id, 'new');
  assert.equal(recent[0].available, true);
});
