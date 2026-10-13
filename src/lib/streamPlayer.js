// StreamPlayer：边接收边播放（MediaSource Extensions + 共享 <audio>，接入同一个 AudioGraph）。
//
// 与 BufferPlayer 接口一致（playAt / stopAt / currentPosition / setRate / playing / duration），
// 会话引擎不关心当前用的是哪一种。差异：
//   - 精度：<audio> 的启动时刻不可精确调度（约 10~50ms 误差），靠 DriftController 的速率微调收敛
//   - 变速：preservesPitch 时间伸缩，不变调，所以允许更大的微调幅度
//   - 缓冲：数据没到时 <audio> 会停下等待（'waiting'），onStall 通知上层暂停漂移校正
import { now } from './clock.js';

const APPEND_BATCH = 512 * 1024; // 合并小分片再 appendBuffer，减少 updateend 往返

/** iPhone Safari 没有 MediaSource，只有 ManagedMediaSource（iOS 17.1+） */
export const MSE = typeof window !== 'undefined' ? window.MediaSource || window.ManagedMediaSource : undefined;

export class StreamPlayer {
  kind = 'stream';
  playing = false; // 意图：应该在播放（与 <audio>.paused 不同，缓冲等待时仍为 true）
  pausedAt = 0;
  rate = 1;
  received = 0;
  complete = false;
  onEnded = null;
  onStall = null; // (stalled: boolean) => void
  onBlocked = null; // 自动播放被拦截
  onError = null;

  constructor(graph, { mime, duration }) {
    this.graph = graph;
    this.mime = mime;
    this.durationHint = duration || 0;
    this.queue = [];
    this.audio = graph.connectMedia();
    if (MSE === window.ManagedMediaSource) this.audio.disableRemotePlayback = true; // ManagedMediaSource 的硬性要求
    this.ms = new MSE();
    this.url = URL.createObjectURL(this.ms);
    this.audio.src = this.url;
    this.audio.playbackRate = 1;

    this.ready = new Promise((resolve, reject) => {
      this.ms.addEventListener(
        'sourceopen',
        () => {
          try {
            this.sb = this.ms.addSourceBuffer(mime);
            // MP3 没有容器时间戳，按追加顺序拼接
            if (mime === 'audio/mpeg') this.sb.mode = 'sequence';
            this.sb.addEventListener('updateend', () => this.pump());
            this.sb.addEventListener('error', () => this.onError?.(new Error('SourceBuffer 错误')));
            if (this.durationHint) this.ms.duration = this.durationHint;
            this.pump();
            resolve();
          } catch (e) {
            reject(e);
            this.onError?.(e);
          }
        },
        { once: true },
      );
    });

    this.listeners = {
      waiting: () => this.playing && this.onStall?.(true),
      playing: () => this.onStall?.(false),
      ended: () => {
        if (!this.playing) return;
        this.playing = false;
        this.pausedAt = this.duration;
        this.onEnded?.();
      },
    };
    for (const [ev, fn] of Object.entries(this.listeners)) this.audio.addEventListener(ev, fn);
  }

  // ───────────────────────── 数据
  append(chunk) {
    this.queue.push(new Uint8Array(chunk));
    this.received += chunk.byteLength;
    this.pump();
  }

  finish() {
    this.complete = true;
    this.pump();
  }

  pump() {
    const sb = this.sb;
    if (!sb || sb.updating || this.ms.readyState !== 'open') return;
    if (this.queue.length) {
      let size = 0;
      let n = 0;
      while (n < this.queue.length && size < APPEND_BATCH) size += this.queue[n++].byteLength;
      const parts = this.queue.splice(0, n);
      const data = new Uint8Array(size);
      let o = 0;
      for (const p of parts) {
        data.set(p, o);
        o += p.byteLength;
      }
      try {
        sb.appendBuffer(data);
      } catch (e) {
        this.queue.unshift(data); // QuotaExceeded 等：稍后重试
        this.onError?.(e);
      }
    } else if (this.complete) {
      try {
        this.ms.endOfStream();
      } catch {}
    }
  }

  /** 已缓冲到的位置（秒），取包含当前播放点的那一段 */
  bufferedEnd(at = this.audio.currentTime) {
    const b = this.sb?.buffered;
    if (!b || !b.length) return 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= at + 0.1 && at <= b.end(i)) return b.end(i);
    return b.end(b.length - 1);
  }

  get duration() {
    return this.durationHint || (Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
  }

  /** 从 pos 开始能否连续播放 ahead 秒 */
  canPlayFrom(pos, ahead = 3) {
    if (this.complete && this.ms.readyState === 'ended') return true;
    return this.bufferedEnd(pos) >= Math.min(pos + ahead, this.duration || Infinity);
  }

  get stalled() {
    return this.playing && this.audio.readyState < 3; // HAVE_FUTURE_DATA
  }

  // ───────────────────────── 播放控制（与 BufferPlayer 同语义）
  playAt(localMs, pos) {
    clearTimeout(this.startTimer);
    this.playing = true;
    this.rate = 1;
    this.audio.playbackRate = 1;
    this.target = { localMs, pos };
    const start = () => {
      // 声音还要经过输出延迟才被听到，所以媒体时间要比"应听到的位置"提前这么多
      const p = Math.max(0, pos + (now() - localMs) / 1000 + this.graph.outputLatency);
      if (this.duration && p >= this.duration) return;
      this.audio.currentTime = p;
      this.audio.play().catch((e) => {
        if (e.name === 'NotAllowedError') this.onBlocked?.(e);
      });
    };
    const wait = localMs - now();
    if (wait > 8) this.startTimer = setTimeout(start, wait);
    else start();
  }

  stopAt(localMs, pos) {
    clearTimeout(this.startTimer);
    this.playing = false;
    this.pausedAt = pos;
    const stop = () => {
      this.audio.pause();
      if (Number.isFinite(pos)) this.audio.currentTime = pos;
    };
    const wait = localMs - now();
    if (wait > 8) this.startTimer = setTimeout(stop, wait);
    else stop();
  }

  setRate(r) {
    this.rate = r;
    this.audio.playbackRate = r;
  }

  currentPosition() {
    if (!this.playing) return this.pausedAt;
    if (this.audio.paused && this.target) {
      // 还没真正开始（等待调度时刻 / 等待缓冲）：按目标线性外推，进度条照常走
      return this.target.pos + (now() - this.target.localMs) / 1000;
    }
    return this.audio.currentTime - this.graph.outputLatency;
  }

  destroy() {
    clearTimeout(this.startTimer);
    this.playing = false;
    for (const [ev, fn] of Object.entries(this.listeners)) this.audio.removeEventListener(ev, fn);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    URL.revokeObjectURL(this.url);
  }
}
