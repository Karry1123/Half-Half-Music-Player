import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricsCache } from '../public/lyrics.js';
import { installNativeLyrics } from '../public/nativeLyrics.js';

const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function harness({ fetchLyrics = async () => ({ synced: '[00:01]One\n[00:02]Two\n[00:02.1]Three', plain: 'Full lyrics' }), cached } = {}) {
  const db = new Map(), cache = createLyricsCache({ storage: { getItem: k => db.get(k), setItem: (k,v) => db.set(k,v) } });
  if (cached) cache.set('local-a', cached);
  let time = 0, position = 0;
  const state = { library: [{ id: 'a', localId: 'local-a', title: 'Song', artist: 'Artist' }], currentId: 'a', duration: 10 };
  const subscriptions = new Set(), events = new Map(), timers = new Map(), updates = [];
  const dispose = installNativeLyrics({
    plugin: { updateLyrics: async value => updates.push(value) },
    store: { subscribe: fn => { subscriptions.add(fn); return () => subscriptions.delete(fn); } }, get: () => state,
    session: { position: () => position, out: { audio: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) } } },
    cache, fetchLyrics, now: () => time, schedule: (fn, delay) => { const id = {}; timers.set(id, { fn, at: time + delay }); return id; }, cancel: id => timers.delete(id), warn() {},
  });
  const advance = async (seconds, ms) => {
    position = seconds; time = ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    events.get('timeupdate')?.(); await drain();
  };
  return { state, cache, updates, timers, events, dispose, advance, publish: patch => { Object.assign(state, patch); subscriptions.forEach(fn => fn()); } };
}

test('external lyrics load without opening a sheet, retain title metadata, and send only changed lines at most once/second', async () => {
  const h = harness(); await drain();
  assert.equal(h.updates.at(-1).enabled, true); assert.equal(h.updates.at(-1).lyrics, 'Full lyrics');
  assert.equal(h.updates.at(-1).lines.length, 3);
  assert.equal(h.updates.at(-1).title, undefined); // Does not overwrite native title/artist.
  await h.advance(1,1000); assert.equal(h.updates.at(-1).currentLine,'One');
  const count = h.updates.length;
  await h.advance(1.5,1500); assert.equal(h.updates.length,count);
  await h.advance(2,1600); assert.equal(h.updates.length,count);
  await h.advance(2.2,1900); assert.equal(h.updates.length,count);
  await h.advance(2.3,2000); assert.equal(h.updates.length,count+1); assert.equal(h.updates.at(-1).currentLine,'Three');
  h.dispose(); assert.equal(h.events.size,0); assert.equal(h.timers.size,0);
});

test('cached lyrics and the same per-track offset are exported; disabling clears all lyric metadata', async () => {
  let requests = 0;
  const h=harness({cached:{synced:'[00:01]One\n[00:02]Two'},fetchLyrics:async()=>{requests++;}}); await drain();
  assert.equal(requests,0);
  await h.advance(1,1000); h.cache.setOffset('local-a',1); await drain();
  assert.equal(h.updates.at(-1).offset,1);assert.equal(h.updates.at(-1).currentLine,'Two');
  h.publish({externalLyricsEnabled:false}); await drain();
  assert.equal(h.updates.at(-1).enabled,false);assert.equal(h.updates.at(-1).lyrics,'');assert.deepEqual(h.updates.at(-1).lines,[]);
  const count=h.updates.length;await h.advance(4,5000);assert.equal(h.updates.length,count);
  h.dispose();
});

test('a late response from an old track cannot replace current lyrics and track changes clear stale lines', async () => {
  const requests=[];
  const h=harness({fetchLyrics:query=>new Promise(resolve=>requests.push({query,resolve}))});await drain();
  h.publish({currentId:'b',library:[{id:'b',title:'Other',artist:'Artist'}]});await drain();
  assert.equal(h.updates.at(-1).trackId,'b');assert.equal(h.updates.at(-1).currentLine,'');
  requests[0].resolve({plain:'Old'});await drain();assert.equal(h.updates.at(-1).lyrics,'');
  requests[1].resolve({plain:'New'});await drain();assert.equal(h.updates.at(-1).lyrics,'New');
  h.dispose();
});
