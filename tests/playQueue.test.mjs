import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayQueue, shuffleInPlace } from '../public/playQueue.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i}`);

/** 可复现的伪随机（mulberry32） */
function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模拟"播完自动下一首"直到停止或达到 max 次 */
function play(q, max, auto = true) {
  const out = [];
  for (let k = 0; k < max; k++) {
    const id = q.peekNext({ auto });
    if (!id) break;
    q.moveTo(id, auto ? 'auto' : 'next');
    out.push(id);
  }
  return out;
}

test('顺序播放：播到最后停止', () => {
  const q = new PlayQueue({ mode: 'order' }).setTracks(ids(4), 't0');
  assert.deepEqual(play(q, 10), ['t1', 't2', 't3']);
  assert.equal(q.peekNext(), null);
  assert.equal(q.peekPrev(), 't2');
});

test('列表循环：最后一首后回到第一首', () => {
  const q = new PlayQueue({ mode: 'loopAll' }).setTracks(ids(3), 't1');
  assert.deepEqual(play(q, 5), ['t2', 't0', 't1', 't2', 't0']);
  q.moveTo('t0', 'select');
  assert.equal(q.peekPrev(), 't2'); // 第一首的上一首 = 最后一首
});

test('单曲循环：自然播完重播当前，手动下一首切走', () => {
  const q = new PlayQueue({ mode: 'loopOne' }).setTracks(ids(3), 't1');
  assert.equal(q.peekNext({ auto: true }), 't1');
  assert.equal(q.peekNext({ auto: false }), 't2');
});

test('随机：一轮内每首恰好一次，轮与轮之间不连续重复', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const all = ids(7);
    const q = new PlayQueue({ mode: 'order', random: seeded(seed) }).setTracks(all, 't3');
    q.setMode('shuffle');
    const seq = ['t3', ...play(q, 6 * 5 + 6)];
    // 第一轮：当前曲目 + 其余 6 首各一次
    assert.deepEqual([...seq.slice(0, 7)].sort(), [...all].sort(), `seed ${seed} 第一轮`);
    for (let r = 1; r < 5; r++) {
      const round = seq.slice(r * 7, r * 7 + 7);
      assert.equal(new Set(round).size, 7, `seed ${seed} 第 ${r + 1} 轮有重复`);
    }
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `seed ${seed} 连续播放了同一首`);
  }
});

test('随机：每次操作前都 setTracks（集成时的调用方式）也保持整轮', () => {
  const all = ids(5);
  const q = new PlayQueue({ mode: 'shuffle', random: seeded(9) }).setTracks(all, 't0');
  const seq = ['t0'];
  for (let k = 0; k < 24; k++) {
    q.setTracks(all, q.current);
    const id = q.peekNext({ auto: true });
    q.moveTo(id, 'auto');
    seq.push(id);
  }
  for (let r = 0; r < 5; r++) assert.equal(new Set(seq.slice(r * 5, r * 5 + 5)).size, 5, `第 ${r + 1} 轮有重复：${seq.slice(r * 5, r * 5 + 5)}`);
});

test('随机：开启时当前曲目不变，歌单顺序不变', () => {
  const list = ids(5);
  const q = new PlayQueue().setTracks(list, 't2');
  q.setMode('shuffle');
  assert.equal(q.current, 't2');
  assert.deepEqual(q.ids, list);
  assert.ok(!q.bag.includes('t2'));
});

test('随机：上一首回到真正听过的歌，再下一首原路返回', () => {
  const q = new PlayQueue({ mode: 'shuffle', random: seeded(7) }).setTracks(ids(8), 't0');
  const heard = ['t0', ...play(q, 4, false)];
  // 后退两步
  for (const expect of [heard[3], heard[2]]) {
    const p = q.peekPrev();
    assert.equal(p, expect);
    q.moveTo(p, 'prev');
  }
  // 前进两步：原路返回
  for (const expect of [heard[3], heard[4]]) {
    const n = q.peekNext();
    assert.equal(n, expect);
    q.moveTo(n, 'next');
  }
  // 再往后才是新的随机曲目，而且不会是本轮听过的
  const fresh = q.peekNext();
  assert.ok(!heard.includes(fresh));
});

test('随机：中途加歌本轮就能播到，删掉的歌不会再出现', () => {
  const q = new PlayQueue({ mode: 'shuffle', random: seeded(3) }).setTracks(ids(4), 't0');
  q.moveTo(q.peekNext(), 'next');
  q.setTracks([...ids(4), 'new1'].filter((x) => x !== 't2'));
  const rest = play(q, 10).slice(0, 3);
  assert.ok(rest.includes('new1'), '新歌应在本轮');
  assert.ok(!play(q, 30).includes('t2'), '删掉的歌不应再出现');
});

test('随机：点播过的歌本轮不再随机到', () => {
  const q = new PlayQueue({ mode: 'shuffle', random: seeded(11) }).setTracks(ids(6), 't0');
  q.moveTo('t4', 'select');
  const round = play(q, 4);
  assert.ok(!round.includes('t4'));
  assert.equal(new Set(round).size, 4);
});

test('只有一首歌的随机 / 空歌单', () => {
  const one = new PlayQueue({ mode: 'shuffle' }).setTracks(['a'], 'a');
  assert.equal(one.peekNext(), 'a');
  assert.equal(new PlayQueue({ mode: 'shuffle' }).setTracks([], null).peekNext(), null);
});

test('洗牌分布大致均匀', () => {
  const counts = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let k = 0; k < 20000; k++) shuffleInPlace([0, 1, 2, 3]).forEach((v, pos) => counts[v][pos]++);
  for (const row of counts) for (const c of row) assert.ok(Math.abs(c - 5000) < 400, `分布偏差过大：${row}`);
});

test('序列化后恢复，继续同一轮', () => {
  const q = new PlayQueue({ mode: 'shuffle', random: seeded(5) }).setTracks(ids(6), 't0');
  q.moveTo(q.peekNext(), 'next');
  const r = PlayQueue.from(JSON.parse(JSON.stringify(q))).setTracks(ids(6));
  assert.deepEqual(r.bag, q.bag);
  assert.equal(r.peekNext(), q.peekNext());
});
