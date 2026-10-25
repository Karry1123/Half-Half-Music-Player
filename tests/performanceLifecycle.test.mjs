import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('engine UI timers stop hidden or idle while connected host heartbeat remains', () => {
  const source = readFileSync(new URL('../src/engine/session.js', import.meta.url), 'utf8');
  const timers = new Map(), listeners = [];
  const state = { role: null, channelOpen: false };
  const document = { hidden: false };
  let next = 0;
  const start = source.indexOf('let heartbeatTimer, statsTimer;');
  const code = source.slice(start, source.indexOf('// Signaling starts', start));
  const update = vm.runInNewContext(`${code}; updateTimers;`, {
    get: () => state, document, HEARTBEAT_MS: 1000,
    useSession: { subscribe: fn => listeners.push(fn) },
    setInterval: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearInterval: id => timers.delete(id),
  });
  assert.equal(timers.size, 0);
  Object.assign(state, { role: 'host', channelOpen: true }); listeners[0]();
  assert.deepEqual([...timers.values()].map(t => t.delay), [1000, 500]);
  document.hidden = true; update();
  assert.deepEqual([...timers.values()].map(t => t.delay), [1000]);
  state.channelOpen = false; listeners[0]();
  assert.equal(timers.size, 0);
  document.hidden = false; state.streaming = true; update();
  assert.deepEqual([...timers.values()].map(t => t.delay), [500]);
});

test('friends polling stops hidden, resumes visible, and cannot restart after unmount', async () => {
  const source = readFileSync(new URL('../public/friendsUI.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function useFriends(');
  const code = source.slice(start, source.indexOf('// Identity', start)).replace('export ', '');
  const document = new EventTarget(); document.hidden = false;
  const effects = [], timers = new Map();
  let next = 0, calls = 0, release;
  const cached = [{ id: 'bob' }];
  const client = {
    required: true, user: { id: 'alice', isActivated: true },
    getCachedFriends: () => cached, subscribeFriends: () => () => {},
    loadFriends: () => { calls++; return new Promise(resolve => { release = resolve; }); },
  };
  const useFriends = vm.runInNewContext(`${code}; useFriends;`, {
    useState: initial => [initial(), () => {}], useEffect: effect => effects.push(effect), document,
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  assert.equal(useFriends(client), cached, 'cached rows are returned before effects or requests');
  const cleanup = effects[0]();
  assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 2);
  cleanup(); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 2);
});
