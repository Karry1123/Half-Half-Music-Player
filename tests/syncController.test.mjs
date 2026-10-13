import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DriftController, RATE_LIMITS, SYNC_DEFAULTS } from '../src/lib/syncController.js';

test('死区内保持 1.0x', () => {
  const c = new DriftController();
  for (const d of [0.005, -0.01, 0.012]) assert.equal(c.update(d, 0).rate, 1);
});

test('0.3s 以内只微调速率，方向正确且限幅', () => {
  const c = new DriftController();
  let r;
  for (let i = 0; i < 3; i++) r = c.update(0.2, i * 1000); // 本地超前 200ms → 放慢
  assert.equal(r.action, 'rate');
  assert.equal(r.zone, 'soft');
  assert.ok(r.rate < 1 && r.rate >= 1 - SYNC_DEFAULTS.maxRate);

  const c2 = new DriftController();
  for (let i = 0; i < 3; i++) r = c2.update(-0.2, i * 1000); // 落后 → 加速
  assert.ok(r.rate > 1);

  const c3 = new DriftController();
  for (let i = 0; i < 3; i++) r = c3.update(0.2, i * 1000, RATE_LIMITS.buffer);
  assert.equal(r.rate, 1 - RATE_LIMITS.buffer, 'BufferPlayer 的速率上限更小（避免变调）');
});

test('0.3~0.5s 以最大速率修正，不跳转', () => {
  const c = new DriftController();
  let r;
  for (let i = 0; i < 3; i++) r = c.update(0.4, i * 1000);
  assert.equal(r.action, 'rate');
  assert.equal(r.zone, 'strong');
  assert.equal(r.rate, 1 - SYNC_DEFAULTS.maxRate);
});

test('超过 0.5s 直接 seek，冷却期内不重复 seek', () => {
  const c = new DriftController();
  let r;
  for (let i = 0; i < 2; i++) r = c.update(0.8, i * 100); // 中位数需要连续超阈值
  assert.equal(r.action, 'seek');
  r = c.update(0.8, 500);
  r = c.update(0.8, 600);
  assert.equal(r.action, 'rate', '冷却期内退化为最大速率追赶');
  r = c.update(0.8, 4000);
  assert.equal(r.action, 'seek');
});

test('单个异常测量值（网络抖动）不会触发 seek', () => {
  const c = new DriftController();
  c.update(0.01, 0);
  c.update(0.02, 1000);
  const r = c.update(0.9, 2000); // 一次 900ms 的离群值
  assert.notEqual(r.action, 'seek');
});

test('迟滞：进入修正后回到 deadZone/2 才恢复 1.0x', () => {
  const c = new DriftController({ window: 1 });
  assert.notEqual(c.update(0.05, 0).rate, 1);
  assert.notEqual(c.update(0.012, 1000).rate, 1, '仍在修正中，12ms 未到 7.5ms 不停');
  assert.equal(c.update(0.005, 2000).rate, 1);
});

/** 闭环仿真：实际位置按 rate 前进，期望位置按 1x 前进，每秒测量一次（带 ±8ms 噪声） */
function simulate({ initialDrift, maxRate, seconds = 60, noise = 0.008, seed = 1 }) {
  const c = new DriftController();
  let rand = seed;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let drift = initialDrift;
  let rate = 1;
  let seeks = 0;
  const trace = [];
  for (let t = 1; t <= seconds; t++) {
    drift += (rate - 1) * 1; // 一秒内累积的偏差
    const r = c.update(drift + rnd() * noise, t * 1000, maxRate);
    if (r.action === 'seek') {
      drift = rnd() * 0.02; // 硬跳转后残余 ±20ms（<audio> 启动误差）
      seeks++;
      rate = 1;
    } else rate = r.rate;
    trace.push(drift);
  }
  return { final: drift, seeks, trace };
}

test('仿真：250ms 漂移在 StreamPlayer 上 15s 内收敛到 20ms 以内，且不 seek', () => {
  const { trace, seeks } = simulate({ initialDrift: 0.25, maxRate: RATE_LIMITS.stream });
  assert.equal(seeks, 0);
  assert.ok(Math.abs(trace[14]) < 0.02, `15s 时漂移 ${(trace[14] * 1000).toFixed(1)}ms`);
  assert.ok(trace.slice(20).every((d) => Math.abs(d) < 0.025), '之后保持稳定');
});

test('仿真：BufferPlayer 80ms 漂移靠 1% 微调消除', () => {
  const { trace, seeks } = simulate({ initialDrift: 0.08, maxRate: RATE_LIMITS.buffer, seconds: 30 });
  assert.equal(seeks, 0);
  assert.ok(Math.abs(trace.at(-1)) < 0.02, `30s 时漂移 ${(trace.at(-1) * 1000).toFixed(1)}ms`);
});

test('仿真：1.2s 大漂移一次 seek 解决', () => {
  const { seeks, final } = simulate({ initialDrift: 1.2, maxRate: RATE_LIMITS.stream });
  assert.equal(seeks, 1);
  assert.ok(Math.abs(final) < 0.025);
});

test('仿真：只有测量噪声（±8ms）时速率几乎不动', () => {
  const c = new DriftController();
  let rand = 7;
  const rnd = () => ((rand = (rand * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let changes = 0;
  for (let t = 0; t < 120; t++) if (c.update(rnd() * 0.008, t * 1000).rate !== 1) changes++;
  assert.equal(changes, 0);
});
