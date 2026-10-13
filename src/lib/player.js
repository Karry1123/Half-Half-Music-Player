// BufferPlayer：整首解码成 AudioBuffer 后用 Web Audio 精确调度（采样级），Host 和"已完整接收"的 Guest 使用。
// 所有操作都是"在本地时刻 T 让播放位置等于 P"，两端可以对准同一个未来时刻。
//
// 软同步：setRate() 微调 playbackRate。AudioBufferSourceNode 变速会轻微变调，所以上限设得很小（见 syncController）；
// 变速后位置不再是 pos + elapsed，而是分段线性：每次变速在当时位置重新打锚点。
import { now } from './clock.js';

const MIN_LEAD = 0.03; // 调度到 AudioContext 至少要留的余量（秒）

export class BufferPlayer {
  kind = 'buffer';
  buffer = null;
  src = null;
  anchor = null; // { when: ctx 时间, pos: 该时刻对应的曲目位置 }
  rate = 1;
  pausedAt = 0;
  onEnded = null;

  constructor(graph) {
    this.graph = graph;
  }

  async load(arrayBuffer) {
    const ctx = this.graph.ensure();
    this.stopNow();
    this.buffer = null;
    this.buffer = await ctx.decodeAudioData(arrayBuffer);
    this.pausedAt = 0;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  get playing() {
    return !!this.src;
  }

  /** 在本地时刻 localMs 让播放位置为 pos；若该时刻已过去，则跳到"现在应该在的位置" */
  playAt(localMs, pos) {
    if (!this.buffer) return;
    const ctx = this.graph.ensure();
    this.stopNow();
    this.rate = 1; // 硬同步后从原速开始，由 DriftController 重新决定
    let when = this.graph.ctxTimeAt(localMs);
    const earliest = ctx.currentTime + MIN_LEAD;
    if (when < earliest) {
      pos += earliest - when;
      when = earliest;
    }
    pos = Math.max(0, pos);
    if (pos >= this.duration) {
      this.pausedAt = this.duration;
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.graph.gain);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.pausedAt = this.duration;
      this.onEnded?.();
    };
    src.start(when, pos);
    this.src = src;
    this.anchor = { when, pos };
  }

  /** 在本地时刻 localMs 停止，停止后位置记为 pos */
  stopAt(localMs, pos) {
    if (this.src) {
      const src = this.src;
      this.src = null;
      src.onended = null;
      src.stop(Math.max(this.graph.ctx.currentTime, this.graph.ctxTimeAt(localMs)));
    }
    this.pausedAt = pos;
  }

  /** 微调播放速率（软同步） */
  setRate(r) {
    if (!this.src || Math.abs(r - this.rate) < 1e-5) {
      if (!this.src) this.rate = r;
      return;
    }
    const t = this.graph.ctx.currentTime;
    if (t > this.anchor.when) {
      // 在变速时刻重新打锚点：此前按旧速率走过的距离结算进 pos
      this.anchor = { when: t, pos: this.anchor.pos + (t - this.anchor.when) * this.rate };
    }
    this.rate = r;
    this.src.playbackRate.setValueAtTime(r, Math.max(t, this.anchor.when));
  }

  /** 当前"耳朵听到的"播放位置（秒）。调度尚未开始时是线性外推值。 */
  currentPosition() {
    if (!this.src) return this.pausedAt;
    return this.anchor.pos + (this.graph.ctxTimeAt(now()) - this.anchor.when) * this.rate;
  }

  stopNow() {
    if (!this.src) return;
    this.src.onended = null;
    try {
      this.src.stop();
    } catch {}
    this.src.disconnect();
    this.src = null;
  }
}
