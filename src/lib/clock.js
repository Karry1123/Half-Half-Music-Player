// NTP 风格时钟同步。Guest 发起，Host 应答。
//
//   guest t0 ──sync_ping──▶ host t1
//   guest t3 ◀──sync_pong── host t2
//
//   rtt    = (t3 - t0) - (t2 - t1)
//   offset = ((t1 - t0) + (t2 - t3)) / 2      // hostClock ≈ localClock + offset
//
// 单次测量会被网络抖动 / 事件循环延迟污染，所以保留最近 N 个样本，
// 只取 RTT 最小的 1/4（排队最少、最对称），再取其 offset 中位数。

/** 本地单调时钟（毫秒，epoch 基准），不受系统改时影响 */
export const now = () => performance.timeOrigin + performance.now();

const MAX_SAMPLES = 30;
const BURST = 10; // 刚连上时快速采样，尽快收敛
const BURST_INTERVAL = 100;
const INTERVAL = 2000; // 之后定期采样，跟踪两台设备晶振的频率漂移

export class ClockSync {
  constructor(send) {
    this.send = send;
    this.samples = [];
    this.offset = 0;
    this.rtt = 0;
    this.ready = false;
    this.timer = null;
  }

  start() {
    this.stop();
    this.samples = [];
    this.ready = false;
    let n = 0;
    const tick = () => {
      this.send({ type: 'sync_ping', t0: now(), rtt: this.rtt });
      this.timer = setTimeout(tick, ++n < BURST ? BURST_INTERVAL : INTERVAL);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** Host 侧：收到 ping 立即回 pong */
  reply(msg) {
    const t1 = now();
    this.send({ type: 'sync_pong', t0: msg.t0, t1, t2: now() });
  }

  /** Guest 侧：收到 pong 更新估计 */
  handlePong({ t0, t1, t2 }) {
    const t3 = now();
    const rtt = t3 - t0 - (t2 - t1);
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    this.samples.push({ rtt, offset });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 4)));
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    this.offset = offsets[offsets.length >> 1];
    this.rtt = byRtt[byRtt.length >> 1].rtt; // RTT 用全体中位数，用于估算指令提前量
    this.ready = this.samples.length >= 3;
  }

  toLocal(hostMs) {
    return hostMs - this.offset;
  }

  toHost(localMs) {
    return localMs + this.offset;
  }
}
