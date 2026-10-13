// 共享的音频输出图：所有播放器（BufferPlayer / StreamPlayer）都接到这里
//
//   AudioBufferSourceNode ─┐
//   <audio>(MSE) ──────────┴→ gain(本地音量) → analyser(频谱) → destination
//
// 也负责浏览器自动播放策略（Autoplay Policy）：
//   - AudioContext 只有在用户手势里 resume() 才会进入 running
//   - iOS Safari 的 <audio> 元素需要在手势里 play() 过一次才"解锁"，之后才能程序化播放
//   - iOS 静音拨片会让 Web Audio 静音；Audio Session API 设为 playback 可避免（Safari 16.4+）
import { now } from './clock.js';

// 44 字节的静音 WAV（1 个采样），用于在手势中解锁 <audio>
const SILENT_WAV = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

export class AudioGraph {
  ctx = null;
  gain = null;
  analyser = null;
  volume = 1;
  /** 所有流式播放共用同一个 <audio>：iOS 上每个元素都要单独解锁，复用可避免切歌后被拦 */
  media = null;
  mediaNode = null;
  onStateChange = null;

  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.ctx.onstatechange = () => this.onStateChange?.(this.ctx.state);
    }
    return this.ctx;
  }

  get state() {
    return this.ctx?.state ?? 'none';
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  /**
   * 必须在用户手势（click / keydown / pointerdown）的同步调用栈里调用。
   * 返回 Promise<boolean>：是否已进入可发声状态。
   */
  unlock() {
    const ctx = this.ensure();
    try {
      if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; // iOS 静音拨片下也出声
    } catch {}
    // Safari 需要在手势里真的播放点什么，resume() 才算数
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    silent.connect(ctx.destination);
    silent.start();

    const el = this.mediaElement();
    let elPromise = Promise.resolve();
    if (el.paused && !el.dataset.unlocked) {
      el.src = SILENT_WAV;
      elPromise = el
        .play()
        .then(() => {
          el.pause();
          el.dataset.unlocked = '1';
        })
        .catch(() => {});
    }
    return Promise.all([ctx.resume().catch(() => {}), elPromise]).then(() => this.running);
  }

  /** 非手势场景下尝试恢复（标签页切回前台等）；被策略拦截时返回 false */
  async tryResume() {
    if (!this.ctx) return false;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    return this.running;
  }

  mediaElement() {
    if (!this.media) {
      this.media = new Audio();
      this.media.preload = 'auto';
      this.media.preservesPitch = true; // 变速微调时不变调
      this.media.crossOrigin = 'anonymous';
    }
    return this.media;
  }

  /** 把共享 <audio> 接入音频图（只能接一次） */
  connectMedia() {
    const ctx = this.ensure();
    if (!this.mediaNode) {
      this.mediaNode = ctx.createMediaElementSource(this.mediaElement());
      this.mediaNode.connect(this.gain);
    }
    return this.mediaElement();
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** 输出延迟（秒）：蓝牙耳机可达 0.1~0.3s */
  get outputLatency() {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /**
   * 本地时钟（ms）→ AudioContext 时间轴（s），对准"扬声器真正发声"的时刻。
   * getOutputTimestamp() 给出 (contextTime, performanceTime)：performanceTime 时扬声器正在输出 contextTime 处的采样，
   * 用它换算能自动补偿输出延迟。
   */
  ctxTimeAt(localMs) {
    const ctx = this.ctx;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) {
      const perfMs = localMs - performance.timeOrigin;
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - this.outputLatency + (localMs - now()) / 1000;
  }
}
