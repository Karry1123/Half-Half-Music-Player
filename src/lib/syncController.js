// 漂移控制器：根据"实际播放位置 − 应在位置"决定微调速率还是硬跳转。纯逻辑，无 DOM，便于单元测试。
//
//   |漂移| ≤ deadZone            保持 1.0x（死区，避免测量噪声引起来回调整）
//   deadZone < |漂移| < hardSeek  比例控制：rate = 1 − 漂移 / correctionTime，限幅 ±maxRate
//                                 （漂移 < 0.3s 时在 ~4s 内悄悄追平；0.3~0.5s 之间以最大速率修正）
//   |漂移| ≥ hardSeek             直接跳转（seek），并进入冷却期
//
// 测量值先做中位数滤波：时钟同步的单次误差、网络抖动造成的心跳延迟都不会直接触发动作。
// 已经在修正时，回到 deadZone/2 以内才恢复 1.0x（迟滞），防止在死区边缘反复切换。

export const SYNC_DEFAULTS = {
  deadZone: 0.015, // 15ms 以内人耳无法分辨两台设备的先后
  softMax: 0.3, // 用户要求：0.3s 以内只做微调
  hardSeek: 0.5, // 用户要求：超过 0.5s 直接跳
  correctionTime: 4, // 希望在多少秒内消除漂移（决定比例系数）
  maxRate: 0.05, // 速率最大偏离 ±5%
  window: 3, // 中位数滤波窗口
  cooldownMs: 3000, // 两次硬跳转的最小间隔
};

/** 不同播放器的速率上限：AudioBufferSourceNode 变速会变调，<audio> 有 preservesPitch */
export const RATE_LIMITS = { buffer: 0.01, stream: 0.05 };

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class DriftController {
  constructor(opts = {}) {
    this.opts = { ...SYNC_DEFAULTS, ...opts };
    this.reset();
    this.lastSeekAt = -Infinity;
  }

  /** 切歌 / 播放 / 暂停 / 跳转后调用：旧测量值不再有效 */
  reset() {
    this.samples = [];
    this.correcting = false;
    this.rate = 1;
  }

  /**
   * @param {number} drift 秒，> 0 表示本地超前（需要放慢）
   * @param {number} nowMs 当前时间（用于冷却判断）
   * @param {number} [maxRate] 覆盖默认速率上限（按播放器类型）
   * @returns {{ action: 'seek'|'rate', rate: number, drift: number, zone: 'ok'|'soft'|'strong'|'seek' }}
   */
  update(drift, nowMs, maxRate = this.opts.maxRate) {
    const o = this.opts;
    this.samples.push(drift);
    if (this.samples.length > o.window) this.samples.shift();
    const d = median(this.samples);
    const abs = Math.abs(d);

    if (abs >= o.hardSeek) {
      // 至少两次测量都超阈值才跳：刚 reset 后的单个离群值不足为据
      if (this.samples.length >= 2 && nowMs - this.lastSeekAt >= o.cooldownMs) {
        this.lastSeekAt = nowMs;
        this.reset();
        return { action: 'seek', rate: 1, drift: d, zone: 'seek' };
      }
      // 冷却中：先以最大速率追
    }

    const threshold = this.correcting ? o.deadZone / 2 : o.deadZone;
    if (abs <= threshold) {
      this.correcting = false;
      this.rate = 1;
      return { action: 'rate', rate: 1, drift: d, zone: 'ok' };
    }

    this.correcting = true;
    const delta = Math.max(-maxRate, Math.min(maxRate, d / o.correctionTime));
    this.rate = 1 - delta;
    return { action: 'rate', rate: this.rate, drift: d, zone: abs < o.softMax ? 'soft' : 'strong' };
  }
}
