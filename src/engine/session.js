import { accessToken } from '../account.js';
// 会话引擎：把 信令 / WebRTC / 时钟同步 / 文件传输 / 播放器 串起来，
// 并把所有需要展示的状态写进 useSession（React 只读 store，通过本模块的方法发起操作）。
//
// ─────────────────────────────── 同步协议（ctrl DataChannel，JSON） ───────────────────────────────
// Host 是唯一权威。播放状态用"锚点"描述：{ trackId, playing, position, at }
//   = 在 Host 时钟 `at` 毫秒时，曲目 trackId 的播放位置是 position 秒，playing 时按 1x 前进。
//
//   hello        双向   { name, color }                  交换昵称/头像色
//   playlist     H→G    { items, currentId }             播放列表（只有元数据，不含音频）
//   track        H→G    { id, title, artist, cover, duration, by, quiet }  切歌
//   need_file    G→H    { id }                           Guest 本地没有缓存，请求传输
//   track_ready  G→H    { id, streaming }                Guest 可以开始播放（已解码，或流式缓冲足够）
//   play/pause/seek H→G 锚点 + { by, quiet }              at 设在未来 LEAD ms，双方同时生效
//   state        H→G    锚点（at = 发送时刻）              每秒心跳：漂移校正 / 中途加入
//   request      G→H    { action, position?, itemId? }    Guest 的操作交给 Host 裁决再广播
//   sync_ping/pong      NTP 式时钟同步（见 lib/clock.js）
//
// ─────────────────────────────── 播放器 ───────────────────────────────
//   BufferPlayer  整首解码，采样级精确调度。Host 永远用它；Guest 在本地有完整文件（缓存命中）时用它
//   StreamPlayer  边收边播（MSE）。Guest 接收中且格式可流式（MP3 / 分片 MP4 / WebM）时用它
// 两者接口相同，this.out 指向当前使用的那个。
//
// ─────────────────────────────── 漂移校正（Guest） ───────────────────────────────
// 每秒心跳算出 漂移 = 实际位置 − 应在位置，交给 DriftController：
//   < 15ms 不动；< 0.5s 微调 playbackRate（Buffer ±1%，Stream ±5%）；≥ 0.5s 硬跳转
import { ClockSync, now } from '../lib/clock.js';
import { AudioGraph } from '../lib/audioGraph.js';
import { BufferPlayer } from '../lib/player.js';
import { createPeer } from '../lib/rtc.js';
import { Signaling } from '../lib/signaling.js';
import { sniffAudio } from '../lib/sniff.js';
import { MSE, StreamPlayer } from '../lib/streamPlayer.js';
import { DriftController, RATE_LIMITS } from '../lib/syncController.js';
import { FileReceiver, sendFile } from '../lib/transfer.js';
import { useMusic } from '../store/useMusic.js';
import { saveProfile, saveVolume, useSession } from '../store/useSession.js';
import { musicApi } from './musicApi.js';
import { toast } from '../store/useToast.js';
import { parseNetsim } from './netsim.js';

const HEARTBEAT_MS = 1000;
const PEER_WAIT_MS = 15000; // 切歌后最多等 Guest 缓冲这么久再开始播放
const NOTICE_MS = 2200;
const GUEST_CACHE_SIZE = 6; // Guest 缓存最近几首的音频，来回切歌不用重传
const SNIFF_BYTES = 64 * 1024; // 收到这么多字节后判断格式能否流式播放
const STREAM_START_AHEAD = 3; // 流式播放：当前位置之后至少缓冲 3 秒才开始
const SLOW_CONNECT_MS = 12000;

const get = useSession.getState;
const set = useSession.setState;

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const meta = (item) => ({ id: item.id, title: item.title, artist: item.artist, cover: item.cover, duration: item.duration });

/** "周杰倫 - 告白氣球.m4a" → { artist, title } */
function parseFileName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1], title: m[2] } : { artist: '', title: base };
}

function concat(chunks, size) {
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c), o);
    o += c.byteLength;
  }
  return out;
}

class SessionEngine {
  graph = new AudioGraph();
  bufferPlayer = new BufferPlayer(this.graph);
  stream = null; // 当前曲目的 StreamPlayer（Guest 流式接收中）
  out = this.bufferPlayer; // 当前用于发声的播放器
  clock = new ClockSync((m) => this.send(m));
  sync = new DriftController();
  netsim = parseNetsim(location.search);
  sig = null;
  peer = null;
  ctrl = null;
  fileCh = null;
  iceServers = null;

  anchor = { trackId: null, playing: false, position: 0, at: 0 };
  loadedId = null; // 本地可播放的曲目（已解码 / 流式已就绪）
  loadToken = 0; // 切歌时递增，丢弃过期的异步解码结果
  sendGen = 0; // 切歌时递增，中断旧的文件传输
  peerRtt = 0; // Host：Guest 上报的 RTT
  autoplay = null; // Host：{ id, timer } 等待 Guest 缓冲后自动播放
  incoming = null; // Guest：正在接收的文件 { id, size, head, headBytes, decided, stream }
  localFiles = new Map(); // Host：拖入的本地文件 playlistId → File
  guestCache = new Map(); // Guest：trackId → Blob（LRU）
  libraryReady = false;
  ctrlQueueAt = 0; // netsim：保证模拟延迟后消息仍按序到达
  driftHistory = []; // 调试面板：最近 60 次漂移测量（ms）
  lastSync = null;

  constructor() {
    this.graph.setVolume(get().volume);
    this.graph.onStateChange = (state) => this.onAudioState(state);
    this.bufferPlayer.onEnded = () => this.onEnded();
    this.receiver = this.createReceiver();
    setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    setInterval(() => this.publishStats(), 500);
    // Signaling starts only after the account gate admits the user (src/main.jsx).
    // 曲库变化（下载完成）→ 合并进 Host 播放列表
    useMusic.subscribe((s, prev) => {
      if (s.library !== prev.library && get().role === 'host') this.syncLibrary(s.library);
    });
    // 自动播放被拦截后，页面上的任意一次点击/按键都顺手解锁
    for (const ev of ['pointerdown', 'keydown']) {
      document.addEventListener(ev, () => get().audioBlocked && this.unlockAudio(), { capture: true });
    }
    // 标签页切回前台：移动端可能挂起了 AudioContext，后台定时器也被节流过，重新对齐
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.onVisible();
    });
    if (this.netsim) console.info('[netsim] 已启用', this.netsim);
  }

  // ═══════════════════════════════════════════════════════ 大厅
  createRoom() {
    this.graph.unlock(); // 用户手势内解锁音频（自动播放策略）
    set({ role: 'host', lobbyError: null });
    this.sig.send({ type: 'create' });
  }

  joinRoom(code) {
    this.graph.unlock();
    set({ role: 'guest', lobbyError: null });
    this.sig.send({ type: 'join', code: String(code).trim() });
  }

  leaveRoom() {
    location.href = location.pathname; // 最干净的重置方式
  }

  setProfile(profile) {
    saveProfile(profile);
    this.send({ type: 'hello', ...profile });
  }

  // ═══════════════════════════════════════════════════════ 自动播放策略
  /** 必须由用户手势调用（横幅按钮、或页面上任意点击） */
  unlockAudio() {
    // 流式播放用的 <audio>：在手势的同步调用栈里 play()，iOS 才放行
    if (this.out === this.stream && this.stream?.playing) this.stream.audio.play().catch(() => {});
    this.graph.unlock().then((running) => {
      set({ audioBlocked: !running, audioState: this.graph.state });
      if (running && this.anchor.playing) this.resync();
    });
  }

  onAudioState(state) {
    set({ audioState: state });
    if (state === 'running') set({ audioBlocked: false });
    else if (this.anchor.playing && get().screen === 'room') set({ audioBlocked: true });
  }

  /** 应该在发声时检查 AudioContext；被策略挂起就尝试恢复，失败则提示用户点击 */
  ensureAudible() {
    if (this.graph.running) return;
    this.graph.tryResume().then((ok) => {
      if (!ok && this.anchor.playing) set({ audioBlocked: true, audioState: this.graph.state });
    });
  }

  async onVisible() {
    if (get().screen !== 'room') return;
    await this.graph.tryResume();
    set({ audioState: this.graph.state });
    if (this.anchor.playing) this.resync();
  }

  /** 丢弃旧的漂移测量，按锚点硬对齐一次 */
  resync() {
    this.sync.reset();
    this.applyAnchor(this.anchor);
  }

  // ═══════════════════════════════════════════════════════ 信令
  connectSignaling() {
    // 部署到静态托管时信令在后端服务上（app-config.js 的 signalUrl），本地开发走同源 /ws
    const url = new URL(window.HH_CONFIG?.signalUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    if (accessToken()) url.searchParams.set('token', accessToken());
    this.sig = new Signaling(url.href);
    this.sig.onopen = () => set({ signaling: 'open' });
    this.sig.onclose = () => set({ signaling: 'closed' });
    this.sig.onmessage = (m) => this.onSignal(m);
  }

  async onSignal(m) {
    switch (m.type) {
      case 'created':
        this.iceServers = m.iceServers;
        set({ screen: 'room', roomCode: m.code });
        useMusic.getState().init();
        break;
      case 'joined':
        this.iceServers = m.iceServers;
        set({ screen: 'room', roomCode: m.code });
        this.setupPeer(); // 等待 Host 的 offer
        break;
      case 'peer-joined':
        this.setupPeer();
        await this.peer.start();
        break;
      case 'signal':
        await this.peer?.handleSignal(m.data).catch((e) => console.warn('signal', e));
        break;
      case 'peer-left':
        this.notify(m.reason === 'host-left' ? '房主已离开，房间解散' : `${get().peer?.name || '对方'} 离开了房间`);
        this.teardownPeer();
        if (m.reason === 'host-left') this.out.stopAt(now(), this.out.currentPosition());
        break;
      case 'error':
        set({ role: null, lobbyError: m.message });
        break;
    }
  }

  // ═══════════════════════════════════════════════════════ P2P
  setupPeer() {
    this.teardownPeer();
    set({ peerState: 'connecting', ice: null });
    this.peer = createPeer({
      isHost: get().role === 'host',
      iceServers: this.iceServers,
      forceRelay: new URLSearchParams(location.search).has('relay'),
      sendSignal: (data) => this.sig.send({ type: 'signal', data }),
      onChannel: (ch) => (ch.label === 'ctrl' ? this.bindCtrl(ch) : this.bindFile(ch)),
      onState: (s) => {
        set({ peerState: s });
        if (s === 'connected') clearTimeout(this.slowTimer);
      },
      onIce: (ice) => set({ ice: { ...get().ice, ...ice } }),
    });
    clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => {
      if (get().peerState !== 'connected') {
        const g = this.peer?.gathered || {};
        const hasTurn = (this.iceServers || []).some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
        this.notify(
          g.relay ? 'P2P 连接较慢，正在通过 TURN 中继连接…'
            : hasTurn ? 'TURN 中继也连不上：检查防火墙是否放行 Node.js（UDP 3478）'
            : 'P2P 连不上：请用 npm run dev:all 启动（会自带本地 TURN 中继），见 TESTING.md',
        );
      }
    }, SLOW_CONNECT_MS);
  }

  teardownPeer() {
    clearTimeout(this.slowTimer);
    this.clock.stop();
    this.sendGen++;
    this.clearAutoplay();
    this.peer?.close();
    this.peer = this.ctrl = this.fileCh = null;
    set({ peerState: 'waiting', channelOpen: false, peer: null, peerReady: false, rtt: null, offset: null, drift: null, transfer: null });
  }

  bindCtrl(ch) {
    this.ctrl = ch;
    ch.onopen = () => {
      set({ channelOpen: true });
      this.send({ type: 'hello', ...get().me });
      if (get().role === 'guest') this.clock.start();
      if (get().role === 'host') {
        this.sendPlaylist();
        const { track } = get();
        if (track) {
          this.send({ type: 'track', ...track, by: 'host', quiet: true });
          this.send({ type: 'state', ...this.anchor });
        }
      }
    };
    ch.onclose = () => set({ channelOpen: false });
    ch.onmessage = (e) => this.onCtrl(JSON.parse(e.data));
  }

  bindFile(ch) {
    this.fileCh = ch;
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => this.receiver.handle(e.data);
  }

  send(msg) {
    if (this.ctrl?.readyState !== 'open') return;
    const data = JSON.stringify(msg);
    if (!this.netsim?.delay && !this.netsim?.jitter) return this.ctrl.send(data);
    // 模拟网络延迟/抖动：仍保证按序（可靠有序通道不会乱序）
    const at = Math.max(this.ctrlQueueAt, now() + this.netsim.delay + Math.random() * this.netsim.jitter);
    this.ctrlQueueAt = at;
    setTimeout(() => this.ctrl?.readyState === 'open' && this.ctrl.send(data), at - now());
  }

  onCtrl(m) {
    const isHost = get().role === 'host';
    switch (m.type) {
      case 'hello':
        set({ peer: { name: String(m.name).slice(0, 20), color: m.color } });
        break;
      case 'sync_ping':
        this.peerRtt = m.rtt || this.peerRtt;
        this.clock.reply(m);
        break;
      case 'sync_pong':
        this.clock.handlePong(m);
        break;
      case 'playlist':
        if (!isHost) set({ playlist: m.items, currentId: m.currentId });
        break;
      case 'track':
        if (!isHost) this.guestLoadTrack(m);
        break;
      case 'need_file':
        if (isHost && m.id === this.anchor.trackId) this.pushFile(m.id);
        break;
      case 'track_ready':
        if (isHost && m.id === this.anchor.trackId) {
          set({ peerReady: true, peerStreaming: !!m.streaming, ...(m.streaming ? {} : { transfer: null }) });
          if (this.autoplay?.id === m.id) this.startAutoplay();
        }
        break;
      case 'play':
      case 'pause':
      case 'seek':
        if (isHost) break;
        this.sync.reset();
        this.applyAnchor(m);
        if (m.by === 'host' && !m.quiet) this.notifyAction(m.type, m.position);
        break;
      case 'state':
        if (!isHost) this.onHeartbeat(m);
        break;
      case 'request':
        if (isHost) this.act(m.action, { position: m.position, itemId: m.itemId, by: 'guest' });
        break;
    }
  }

  // ═══════════════════════════════════════════════════════ 播放控制（UI 入口）
  /**
   * @param {'play'|'pause'|'toggle'|'seek'|'next'|'prev'|'select'} action
   * Guest 调用时只发请求，由 Host 执行后广播；Host 收到请求时 opts.by = 'guest'
   */
  act(action, opts = {}) {
    if (action === 'toggle') action = this.anchor.playing ? 'pause' : 'play';
    if (get().role === 'guest' && !opts.by) {
      this.send({ type: 'request', action, position: opts.position, itemId: opts.itemId });
      return;
    }
    const by = opts.by || 'host';
    switch (action) {
      case 'select':
        return this.loadItem(opts.itemId, { autoplay: true, by });
      case 'next':
        return this.skip(1, by);
      case 'prev':
        // 播放超过 3 秒时"上一曲"先回到开头（主流播放器的习惯）
        if (this.position() > 3) return this.transport('seek', 0, by);
        return this.skip(-1, by);
      default:
        return this.transport(action, opts.position, by);
    }
  }

  skip(dir, by, quiet = false) {
    const { playlist, currentId, playMode } = get();
    const i = playlist.findIndex((x) => x.id === currentId);
    const candidates = playlist.filter((x) => x.id !== currentId);
    const next = playMode === 'shuffle'
      ? candidates[Math.floor(Math.random() * candidates.length)] || playlist[0]
      : playlist[i + dir] ?? (i < 0 ? playlist[0] : null);
    if (next) this.loadItem(next.id, { autoplay: true, by, quiet });
    return !!next;
  }

  /** Host：play / pause / seek，生成锚点并广播 */
  transport(action, position, by, quiet = false) {
    if (!this.loadedId) return;
    const lead = this.leadMs();
    const at = now() + lead;
    const p = this.bufferPlayer;
    let { playing } = this.anchor;
    let pos;
    if (action === 'play') {
      if (playing) return;
      playing = true;
      pos = p.pausedAt >= p.duration - 0.05 ? 0 : p.pausedAt;
    } else if (action === 'pause') {
      if (!playing) return;
      playing = false;
      pos = p.currentPosition() + lead / 1000; // `at` 时刻的位置
    } else if (action === 'seek') {
      pos = Math.min(Math.max(0, Number(position) || 0), p.duration);
    } else return;

    const anchor = { trackId: this.loadedId, playing, position: pos, at };
    this.applyAnchor(anchor);
    this.send({ type: action, ...anchor, by, quiet });
    if (by === 'guest' && !quiet) this.notifyAction(action, pos);
  }

  /** 指令提前量：保证 Guest 收到时 `at` 还没到（netsim 的模拟延迟也算进去） */
  leadMs() {
    if (!get().channelOpen) return 50;
    const sim = this.netsim ? this.netsim.delay + this.netsim.jitter : 0;
    return Math.min(1500, Math.max(120, this.peerRtt * 1.5 + 60 + sim));
  }

  applyAnchor(s) {
    this.anchor = { trackId: s.trackId, playing: s.playing, position: s.position, at: s.at };
    set({ playing: s.playing });
    if (s.trackId !== this.loadedId) {
      if (this.out.playing) this.out.stopAt(now(), 0);
      return;
    }
    const localAt = get().role === 'host' ? s.at : this.clock.toLocal(s.at);
    if (s.playing) {
      this.out.playAt(localAt, s.position);
      this.ensureAudible();
    } else this.out.stopAt(localAt, s.position);
  }

  /** Guest：心跳到达，计算漂移并交给 DriftController */
  onHeartbeat(s) {
    const consistent = s.trackId === this.loadedId && s.playing && this.out.playing;
    if (!consistent) {
      // 状态不一致（错过指令、刚就绪等）——直接按锚点对齐
      if (s.trackId !== this.anchor.trackId || s.playing !== this.out.playing) {
        this.sync.reset();
        this.applyAnchor(s);
      } else this.anchor = { trackId: s.trackId, playing: s.playing, position: s.position, at: s.at };
      return;
    }
    this.anchor = { trackId: s.trackId, playing: s.playing, position: s.position, at: s.at };
    if (!this.clock.ready) return;
    // 流式播放卡住等数据时不校正，恢复后再说（届时漂移若很大会直接 seek）
    if (this.out.kind === 'stream' && this.out.stalled) return;
    if (!this.graph.running) return; // 被自动播放策略挂起时音频时钟不走，测量没有意义

    const expected = s.position + (this.clock.toHost(now()) - s.at) / 1000;
    const drift = this.out.currentPosition() - expected;
    const r = this.sync.update(drift, now(), RATE_LIMITS[this.out.kind]);
    this.lastSync = r;
    this.driftHistory.push(Math.round(drift * 10000) / 10);
    if (this.driftHistory.length > 60) this.driftHistory.shift();
    if (r.action === 'seek') {
      console.info(`[sync] 漂移 ${(r.drift * 1000).toFixed(0)}ms ≥ 阈值，硬跳转`);
      this.applyAnchor(s);
    } else this.out.setRate(r.rate);
    set({ drift: r.drift * 1000, rate: r.rate, syncZone: r.zone });
  }

  /** Host：每秒广播实际音频位置 */
  heartbeat() {
    if (get().role !== 'host' || !this.loadedId || now() < this.anchor.at) return;
    const p = this.bufferPlayer;
    const s = p.playing
      ? { trackId: this.loadedId, playing: true, position: p.currentPosition(), at: now() }
      : { trackId: this.loadedId, playing: false, position: p.pausedAt, at: now() };
    this.send({ type: 'state', ...s });
  }

  onEnded() {
    if (get().role !== 'host') return;
    if (get().playMode === 'repeat') {
      this.transport('seek', 0, 'host', true);
      return;
    }
    if (this.skip(1, 'host', true)) return; // 自动下一首
    const anchor = { trackId: this.loadedId, playing: false, position: 0, at: now() };
    this.bufferPlayer.pausedAt = 0;
    this.applyAnchor(anchor);
    this.send({ type: 'pause', ...anchor, by: 'host', quiet: true });
  }

  /** 当前播放位置（秒）。未就绪时按锚点推算，Guest 缓冲期间进度条也会走 */
  position() {
    const { duration } = get();
    let p;
    if (this.loadedId && this.loadedId === this.anchor.trackId) p = this.out.currentPosition();
    else if (this.anchor.playing) {
      const hostNow = get().role === 'host' ? now() : this.clock.toHost(now());
      p = this.anchor.position + (hostNow - this.anchor.at) / 1000;
    } else p = this.anchor.position;
    return Math.min(Math.max(0, p), duration || Infinity);
  }

  setVolume(v) {
    this.graph.setVolume(v);
    set({ volume: v });
    saveVolume(v);
  }

  // ═══════════════════════════════════════════════════════ 曲目加载（Host）
  async loadItem(itemId, { autoplay = false, by = 'host', quiet = false } = {}) {
    const item = get().playlist.find((x) => x.id === itemId);
    if (!item) return;
    const token = ++this.loadToken;
    this.sendGen++;
    this.clearAutoplay();
    this.loadedId = null;
    this.out.stopAt(now(), 0);
    this.anchor = { trackId: item.id, playing: false, position: 0, at: now() };
    set({ currentId: item.id, track: meta(item), loaded: false, playing: false, peerReady: false, peerStreaming: false, duration: item.duration || 0, transfer: { dir: 'decode' } });
    this.send({ type: 'track', ...meta(item), by, quiet });
    this.sendPlaylist();
    if (by === 'guest') this.notify(`${this.peerName()} 切换到《${item.title}》`, true);

    try {
      const file = await this.fileFor(item);
      await this.bufferPlayer.load(await file.arrayBuffer());
    } catch (e) {
      if (token === this.loadToken) {
        set({ transfer: null });
        this.notify(`无法播放《${item.title}》：${e.message}`);
      }
      return;
    }
    if (token !== this.loadToken) return;
    this.loadedId = item.id;
    const duration = this.bufferPlayer.duration;
    set({ loaded: true, duration, transfer: get().transfer?.dir === 'decode' ? null : get().transfer });
    if (!item.duration || Math.abs(item.duration - duration) > 1) {
      this.patchItem(item.id, { duration });
      // 精确时长告诉 Guest：流式播放需要它设置 MediaSource.duration
      this.send({ type: 'track', ...meta({ ...item, duration }), by, quiet: true, update: true });
    }
    if (autoplay) this.autoplayWhenReady(item.id);
  }

  async fileFor(item) {
    if (item.origin === 'local') return this.localFiles.get(item.id);
    const res = await fetch(musicApi.fileUrl(item.fileName));
    if (!res.ok) throw new Error(`曲库文件读取失败 (HTTP ${res.status})`);
    return new File([await res.blob()], item.fileName);
  }

  /** 等 Guest 就绪（解码完成或流式缓冲足够）再一起开始；没有 Guest 或超时则直接播放 */
  autoplayWhenReady(id) {
    if (!get().channelOpen || get().peerReady) return this.transport('play', undefined, 'host', true);
    set({ waitingPeer: true });
    this.autoplay = { id, timer: setTimeout(() => this.startAutoplay(), PEER_WAIT_MS) };
  }

  startAutoplay() {
    const id = this.autoplay?.id;
    this.clearAutoplay();
    if (id && id === this.loadedId) this.transport('play', undefined, 'host', true);
  }

  clearAutoplay() {
    clearTimeout(this.autoplay?.timer);
    this.autoplay = null;
    if (get().waitingPeer) set({ waitingPeer: false });
  }

  /** Host → Guest：传输当前曲目的音频文件 */
  async pushFile(id) {
    const item = get().playlist.find((x) => x.id === id);
    if (!item || this.fileCh?.readyState !== 'open') return;
    const gen = ++this.sendGen;
    try {
      const file = await this.fileFor(item);
      if (gen !== this.sendGen) return;
      set({ transfer: { dir: 'send', done: 0, total: file.size } });
      const done = await sendFile(this.fileCh, file, id, {
        chunkSize: this.peer.chunkSize,
        rateLimit: this.netsim?.rate,
        isCancelled: () => gen !== this.sendGen,
        onProgress: (d, t) => set({ transfer: { dir: 'send', done: d, total: t } }),
      });
      if (done) set({ transfer: get().peerReady ? null : { dir: 'send', done: file.size, total: file.size, phase: 'decode' } });
    } catch (e) {
      console.warn('pushFile', e);
      set({ transfer: null });
    }
  }

  // ═══════════════════════════════════════════════════════ 曲目加载（Guest）
  /** Host 切歌（或补发精确时长 update） */
  guestLoadTrack(m) {
    if (m.update && m.id === get().currentId) {
      set({ track: meta(m), duration: m.duration || get().duration });
      if (this.stream && m.duration) this.stream.durationHint = m.duration;
      return;
    }
    const token = ++this.loadToken;
    this.loadedId = null;
    this.dropStream();
    this.out.stopAt(now(), 0);
    this.out = this.bufferPlayer;
    this.incoming = null;
    this.sync.reset();
    this.anchor = { trackId: m.id, playing: false, position: 0, at: 0 };
    set({ currentId: m.id, track: meta(m), loaded: false, playing: false, duration: m.duration || 0, transfer: null, streaming: false, buffering: false, format: null });
    if (m.by === 'host' && !m.quiet) this.notify(`${this.peerName()} 切换到《${m.title}》`, true);
    const cached = this.guestCache.get(m.id);
    if (cached) this.guestDecode(m.id, cached, token);
    else this.send({ type: 'need_file', id: m.id });
  }

  async guestDecode(id, blob, token) {
    set({ transfer: { dir: 'recv', phase: 'decode' } });
    try {
      await this.bufferPlayer.load(await blob.arrayBuffer());
    } catch (e) {
      if (token === this.loadToken) set({ transfer: null });
      this.notify(`解码失败：${e.message}`);
      return;
    }
    if (token !== this.loadToken) return;
    this.out = this.bufferPlayer;
    this.loadedId = id;
    set({ loaded: true, duration: this.bufferPlayer.duration, transfer: null, streaming: false });
    this.send({ type: 'track_ready', id });
    if (this.anchor.trackId === id) this.resync(); // 中途就绪：直接追到当前位置
  }

  /** 收到文件头后决定：边收边播（MSE）还是收完再解码 */
  decideStreaming(inc) {
    inc.decided = true;
    const head = concat(inc.head, inc.headBytes);
    const info = sniffAudio(head, (mime) => !!MSE?.isTypeSupported?.(mime));
    set({ format: info });
    const disabled = new URLSearchParams(location.search).get('stream') === '0';
    if (!info.streamable || disabled || inc.id !== get().currentId) {
      console.info(`[stream] ${info.container}：${disabled ? '已通过 ?stream=0 关闭' : info.reason || ''}，收完再解码`);
      return;
    }
    const stream = new StreamPlayer(this.graph, { mime: info.mime, duration: get().duration });
    stream.onStall = (stalled) => set({ buffering: stalled });
    stream.onBlocked = () => set({ audioBlocked: true });
    stream.onError = (e) => console.warn('[stream]', e);
    for (const c of inc.head) stream.append(c);
    inc.stream = stream;
    this.stream = stream;
    console.info(`[stream] ${info.mime}：边收边播`);

    // 缓冲到"应在位置 + 3 秒"就开始，不等整个文件
    const token = this.loadToken;
    const check = () => {
      if (token !== this.loadToken || this.stream !== stream) return;
      if (!stream.canPlayFrom(this.position(), STREAM_START_AHEAD)) return void (this.streamTimer = setTimeout(check, 200));
      this.out = stream;
      this.loadedId = inc.id;
      set({ loaded: true, streaming: true });
      this.send({ type: 'track_ready', id: inc.id, streaming: true });
      if (this.anchor.trackId === inc.id) this.resync();
    };
    stream.ready.then(check, () => this.dropStream());
  }

  dropStream() {
    clearTimeout(this.streamTimer);
    if (!this.stream) return;
    if (this.out === this.stream) this.out = this.bufferPlayer;
    this.stream.destroy();
    this.stream = null;
  }

  createReceiver() {
    let lastUpdate = 0;
    return new FileReceiver({
      onMeta: (m) => {
        this.incoming = m.id === get().currentId ? { id: m.id, size: m.size, head: [], headBytes: 0, decided: false, stream: null } : null;
        set({ transfer: { dir: 'recv', done: 0, total: m.size } });
      },
      onChunk: (m, chunk) => {
        const inc = this.incoming;
        if (!inc || inc.id !== m.id) return;
        if (inc.decided) return inc.stream?.append(chunk);
        inc.head.push(chunk);
        inc.headBytes += chunk.byteLength;
        if (inc.headBytes >= Math.min(SNIFF_BYTES, m.size)) this.decideStreaming(inc);
      },
      onProgress: (done, total) => {
        if (performance.now() - lastUpdate < 100 && done < total) return; // 节流 store 更新
        lastUpdate = performance.now();
        set({ transfer: { dir: 'recv', done, total } });
      },
      onComplete: (m, blob) => {
        this.guestCache.delete(m.id);
        this.guestCache.set(m.id, blob);
        if (this.guestCache.size > GUEST_CACHE_SIZE) this.guestCache.delete(this.guestCache.keys().next().value);
        const inc = this.incoming;
        this.incoming = null;
        if (m.id !== get().currentId) return;
        if (inc?.stream) {
          inc.stream.finish(); // 流式播放继续用到这首结束；下次播放命中缓存走 BufferPlayer
          set({ transfer: null });
        } else this.guestDecode(m.id, blob, this.loadToken);
      },
    });
  }

  // ═══════════════════════════════════════════════════════ 播放列表（Host）
  /** 曲库（downloads/）→ 播放列表；首次加载之后新增的标记为"新下载" */
  syncLibrary(lib) {
    const { playlist } = get();
    const existing = new Set(playlist.map((x) => x.id));
    const libIds = new Set(lib.map((e) => `lib:${e.file}`));
    const added = [...lib]
      .reverse() // library.json 新的在前；播放列表按加入顺序
      .filter((e) => !existing.has(`lib:${e.file}`))
      .map((e) => ({
        id: `lib:${e.file}`,
        title: e.title,
        artist: e.artist || e.uploader || '',
        cover: e.cover,
        duration: e.duration,
        origin: 'library',
        fileName: e.file,
        sourceName: e.sourceName,
        fresh: this.libraryReady,
      }));
    const kept = playlist.filter((x) => x.origin !== 'library' || libIds.has(x.id));
    this.libraryReady = true;
    if (!added.length && kept.length === playlist.length) return;
    set({ playlist: [...kept, ...added] });
    this.sendPlaylist();
  }

  /** 拖入 / 选择的本地音频文件 */
  addLocalFiles(files) {
    const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|flac|m4a|aac|wav|ogg|opus|webm)$/i.test(f.name));
    if (!audio.length) return 0;
    const items = audio.map((f) => {
      const id = `local:${Math.random().toString(36).slice(2, 10)}`;
      this.localFiles.set(id, f);
      return { id, ...parseFileName(f.name), cover: null, duration: null, origin: 'local', fresh: true };
    });
    const wasEmpty = !get().playlist.length;
    set({ playlist: [...get().playlist, ...items] });
    this.sendPlaylist();
    if (wasEmpty || !get().currentId) this.loadItem(items[0].id);
    toast(`已添加 ${items.length} 首到播放列表`, { icon: 'plus', key: 'playlist' });
    return items.length;
  }

  removeItem(id) {
    if (id === get().currentId) return;
    this.localFiles.delete(id);
    set({ playlist: get().playlist.filter((x) => x.id !== id) });
    this.sendPlaylist();
  }

  patchItem(id, patch) {
    set({ playlist: get().playlist.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
    this.sendPlaylist();
  }

  sendPlaylist() {
    const { playlist, currentId } = get();
    this.send({
      type: 'playlist',
      currentId,
      items: playlist.map(({ id, title, artist, cover, duration, origin }) => ({ id, title, artist, cover, duration, origin })),
    });
  }

  // ═══════════════════════════════════════════════════════ 提示 & 统计 & 调试
  peerName() {
    return get().peer?.name || '对方';
  }

  notifyAction(action, pos) {
    const who = this.peerName();
    const text = { play: `${who} 开始了播放`, pause: `${who} 暂停了播放`, seek: `${who} 把进度拖到了 ${fmtTime(pos)}` }[action];
    if (text) this.notify(text, true);
  }

  notify(text, peer = false) {
    if (!peer) return toast(text);
    const id = Math.random().toString(36).slice(2);
    set({ notices: [{ id, text }] });
    setTimeout(() => set({ notices: get().notices.filter((n) => n.id !== id) }), NOTICE_MS);
  }

  publishStats() {
    const s = get();
    if (s.role === 'guest' && this.clock.ready) {
      const rtt = Math.round(this.clock.rtt * 10) / 10;
      const offset = Math.round(this.clock.offset * 10) / 10;
      if (rtt !== s.rtt || offset !== s.offset) set({ rtt, offset });
    } else if (s.role === 'host' && s.channelOpen && this.peerRtt) {
      const rtt = Math.round(this.peerRtt * 10) / 10;
      if (rtt !== s.rtt) set({ rtt });
    }
    if (this.stream && this.out === this.stream) {
      const ahead = Math.max(0, this.stream.bufferedEnd() - this.stream.audio.currentTime);
      set({ bufferedAhead: Math.round(ahead * 10) / 10, buffering: this.stream.stalled });
    } else if (s.bufferedAhead != null) set({ bufferedAhead: null });
  }

  /** 调试面板读取的完整诊断信息（不放进 store，避免频繁重渲染） */
  debugInfo() {
    const s = get();
    return {
      role: s.role,
      peerState: s.peerState,
      ice: s.ice,
      iceServers: this.iceServers,
      clock: { ready: this.clock.ready, rtt: this.clock.rtt, offset: this.clock.offset, samples: this.clock.samples?.length ?? 0 },
      audio: { state: this.graph.state, outputLatency: this.graph.outputLatency, sampleRate: this.graph.ctx?.sampleRate },
      player: {
        kind: this.out.kind,
        playing: this.out.playing,
        rate: this.out.rate,
        position: this.position(),
        bufferedAhead: s.bufferedAhead,
        stalled: this.out.kind === 'stream' ? this.out.stalled : false,
        received: this.stream?.received,
        complete: this.stream?.complete,
      },
      format: s.format,
      sync: this.lastSync,
      driftHistory: [...this.driftHistory],
      netsim: this.netsim,
      leadMs: this.leadMs(),
    };
  }

  /** 调试：人为制造漂移，观察 DriftController 如何收敛（只影响本地） */
  injectDrift(seconds) {
    if (!this.out.playing) return;
    this.out.playAt(now(), this.out.currentPosition() + seconds);
    this.notify(`已注入 ${seconds > 0 ? '+' : ''}${Math.round(seconds * 1000)}ms 漂移`);
  }

  /** 调试：Host 手动触发 ICE restart */
  async restartIce() {
    if (!this.peer || get().role !== 'host') return;
    this.peer.pc.restartIce();
    await this.peer.pc.setLocalDescription();
    this.sig.send({ type: 'signal', data: { sdp: this.peer.pc.localDescription } });
    this.notify('已发起 ICE restart');
  }
}

export const engine = new SessionEngine();
