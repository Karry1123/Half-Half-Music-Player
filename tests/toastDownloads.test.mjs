import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { create } from 'zustand';
import { randomUUID } from 'node:crypto';

const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

test('rapid same-key toasts replace content and restart the dismissal timer', () => {
  let sequence = 0;
  const timers = new Map();
  const ctx = vm.createContext({ create, setTimeout: (fn) => { timers.set(++sequence, fn); return sequence; }, clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(`${source('store/useToast.js')};globalThis.api = { toast, useToast };`, ctx);
  ctx.api.toast('单曲循环', { icon: 'repeat', key: 'play-mode' });
  ctx.api.toast('随机播放', { icon: 'shuffle', key: 'play-mode' });
  assert.equal(ctx.api.useToast.getState().current.text, '随机播放');
  assert.equal(ctx.api.useToast.getState().current.icon, 'shuffle');
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(ctx.api.useToast.getState().current, null);
});

function harness(saved = null) {
  let persisted = saved, events;
  const notices = [], calls = [];
  const musicApi = {
    health: async () => ({ ffmpeg: true }), library: async () => [],
    subscribe: (handlers) => { events = handlers; return () => {}; },
    download: async (...args) => { calls.push(args); throw new Error('网络断开'); },
  };
  const ctx = vm.createContext({ create, musicApi, toast: (...args) => notices.push(args), crypto: { randomUUID },
    localStorage: { getItem: () => persisted, setItem: (_, value) => { persisted = value; } } });
  vm.runInContext(`${source('store/useMusic.js')};globalThis.store = useMusic;`, ctx);
  return { store: ctx.store, musicApi, notices, calls, saved: () => persisted, events: () => events };
}

test('request failure retains metadata, survives reload and retries without search in the original format', async () => {
  const h = harness();
  h.store.setState({ format: 'm4a', result: { results: [{ id: 'bilibili:BV1', title: '晴天', artist: '周杰伦', cover: 'cover.jpg' }] } });
  await h.store.getState().download('bilibili:BV1');
  const failed = Object.values(h.store.getState().jobs)[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, '网络断开');
  assert.equal(failed.cover, 'cover.jpg');
  assert.match(h.notices.at(-1)[0], /晴天.*下载失败/);
  const restored = harness(h.saved());
  restored.store.setState({ format: 'mp3', result: { results: [] } });
  restored.musicApi.download = async (...args) => {
    restored.calls.push(args);
    return { job: { id: 'server1', trackId: args[0], status: 'queued', format: args[1], createdAt: Date.now() } };
  };
  await restored.store.getState().download(failed.trackId, { jobId: failed.id });
  assert.equal(restored.calls[0][0], 'bilibili:BV1');
  assert.equal(restored.calls[0][1], 'm4a');
  assert.equal(restored.calls[0][2].title, '晴天');
  const jobs = Object.values(restored.store.getState().jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].cover, 'cover.jpg');
  assert.equal(jobs[0].status, 'queued');
});

test('SSE completion before HTTP response stays completed; cleared jobs do not return on snapshot', async () => {
  const h = harness();
  await h.store.getState().init();
  h.store.setState({ result: { results: [{ id: 'youtube:a', title: '歌曲', cover: 'art' }] } });
  h.musicApi.download = async () => {
    h.events().onJob({ id: 's1', trackId: 'youtube:a', title: '歌曲', format: 'mp3', status: 'done', progress: 1 });
    return { job: { id: 's1', trackId: 'youtube:a', status: 'queued', format: 'mp3' } };
  };
  await h.store.getState().download('youtube:a');
  assert.equal(Object.keys(h.store.getState().jobs).length, 1);
  assert.equal(h.store.getState().jobs.s1.status, 'done');
  h.store.getState().clearCompleted();
  h.events().onSnapshot([{ id: 's1', trackId: 'youtube:a', status: 'done' }]);
  assert.equal(Object.keys(h.store.getState().jobs).length, 0);
});

test('snapshot merges retained errors and active jobs, and later failure notifies once', async () => {
  const h = harness();
  h.store.setState({ jobs: { failed: { id: 'failed', trackId: 'a', title: '旧歌', status: 'error', format: 'mp3' } } });
  await h.store.getState().init();
  h.events().onSnapshot([{ id: 'running', trackId: 'b', title: '新歌', status: 'downloading', format: 'mp3', progress: 0.4 }]);
  assert.equal(Object.keys(h.store.getState().jobs).length, 2);
  const job = { id: 'running', trackId: 'b', title: '新歌', status: 'error', error: '转码失败' };
  h.events().onJob(job);
  h.events().onJob(job);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0][0], /新歌.*下载失败/);
});
