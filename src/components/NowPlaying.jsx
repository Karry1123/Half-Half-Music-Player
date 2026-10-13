import { useEffect, useRef } from 'react';
import { engine } from '../engine/session.js';
import { useAnimationFrame } from '../hooks/usePlayback.js';
import { useSession } from '../store/useSession.js';
import { Avatar } from './Avatar.jsx';
import { Icon } from './Icon.jsx';
import { PlayerControls } from './PlayerControls.jsx';

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

/** 黑胶唱片：播放时旋转 */
function CoverDisc({ cover, spinning }) {
  return (
    <div className={`disc${spinning ? ' spinning' : ''}`}>
      <div className="disc-art">{cover ? <img src={cover} alt="" referrerPolicy="no-referrer" /> : <Icon name="music" size={36} />}</div>
      <div className="disc-hole" />
    </div>
  );
}

/** 实时频谱（AnalyserNode），Host/Guest 看到的都是各自本地正在发声的音频 */
function Visualizer({ active }) {
  const canvas = useRef(null);
  const data = useRef(null);
  useAnimationFrame(() => {
    const c = canvas.current;
    const analyser = engine.graph.analyser;
    if (!c || !analyser) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    data.current ??= new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data.current);

    const styles = getComputedStyle(c);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, styles.getPropertyValue('--host').trim());
    grad.addColorStop(1, styles.getPropertyValue('--guest').trim());
    ctx.fillStyle = grad;

    const bars = Math.min(64, Math.floor(w / 7));
    const gap = 3;
    const bw = (w - gap * (bars - 1)) / bars;
    const usable = Math.floor(data.current.length * 0.75); // 最高频段几乎没有能量，略去
    for (let i = 0; i < bars; i++) {
      const v = data.current[Math.floor((i / bars) * usable)] / 255;
      const bh = Math.max(2, v * v * h);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(i * (bw + gap), (h - bh) / 2, bw, bh, 2); // 上下对称的波形
      else ctx.rect(i * (bw + gap), (h - bh) / 2, bw, bh);
      ctx.fill();
    }
  }, active);

  // 暂停时收成一条细线
  useEffect(() => {
    const c = canvas.current;
    if (active || !c) return;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = getComputedStyle(c).getPropertyValue('--line').trim();
    ctx.fillRect(0, c.height / 2 - 1, c.width, 2);
  }, [active]);

  return <canvas ref={canvas} className="visualizer" aria-hidden="true" />;
}

/** 双人头像：两个人都在且已缓冲同一首时，中间的连线流动 */
function DuoAvatars() {
  const me = useSession((s) => s.me);
  const peer = useSession((s) => s.peer);
  const role = useSession((s) => s.role);
  const playing = useSession((s) => s.playing);
  const loaded = useSession((s) => s.loaded);
  const hasTrack = useSession((s) => !!s.track);
  const peerReady = useSession((s) => s.peerReady);
  // Host 要等 Guest 也缓冲好才算"在一起"；Guest 这边 Host 一定已就绪
  const together = !!peer && loaded && (role === 'guest' || peerReady);
  const [left, right] = role === 'host' ? [me, peer] : [peer, me];
  const caption = !peer ? '等待对方加入' : !hasTrack ? '已连接，等待选歌' : together && playing ? '正在一起听' : together ? '已同步，随时开始' : '缓冲中…';
  return (
    <div>
      <div className="duo">
        <Avatar profile={left} size={40} title={left ? `${left.name}（Host）` : '等待 Host'} />
        <span className={`duo-link${together && playing ? ' on' : ''}`} />
        <Avatar profile={right} size={40} title={right ? `${right.name}（Guest）` : '等待对方加入'} />
      </div>
      <div className="duo-caption">{caption}</div>
    </div>
  );
}

/** 传输 / 缓冲状态 */
function TransferLine() {
  const role = useSession((s) => s.role);
  const transfer = useSession((s) => s.transfer);
  const peerReady = useSession((s) => s.peerReady);
  const channelOpen = useSession((s) => s.channelOpen);
  const loaded = useSession((s) => s.loaded);
  const track = useSession((s) => s.track);
  const streaming = useSession((s) => s.streaming);
  const peerStreaming = useSession((s) => s.peerStreaming);
  const buffering = useSession((s) => s.buffering);
  const bufferedAhead = useSession((s) => s.bufferedAhead);
  if (!track) return <div className="transfer-line" />;

  let text = '';
  let progress = null;
  const pct = transfer?.total ? transfer.done / transfer.total : 0;
  if (transfer?.dir === 'decode') text = '解码中…';
  else if (transfer?.dir === 'send' && transfer.phase === 'decode') text = '已发送，对方解码中…';
  else if (transfer?.dir === 'send') {
    text = `${peerStreaming ? '对方边收边播 · ' : '发送给对方 '}${mb(transfer.done)} / ${mb(transfer.total)}`;
    progress = pct;
  } else if (transfer?.dir === 'recv' && transfer.phase === 'decode') text = '接收完成，解码中…';
  else if (transfer?.dir === 'recv') {
    // 流式播放时显示"已缓冲多少秒"，比字节数更直观
    text = streaming
      ? `${buffering ? '缓冲中…' : '边收边播'} · 领先 ${bufferedAhead ?? 0}s · ${Math.round(pct * 100)}%`
      : `接收中 ${mb(transfer.done || 0)} / ${mb(transfer.total || 0)}${loaded ? '' : '，即将开始'}`;
    progress = pct;
  } else if (role === 'host') text = !channelOpen ? '仅本机播放' : peerReady ? '对方已缓冲 ✓' : loaded ? '等待对方缓冲…' : '';
  else text = buffering ? '缓冲中…' : loaded ? '已缓冲 ✓' : '等待音频…';

  return (
    <div className="transfer-line">
      {progress != null && (
        <span className="mini-progress">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      {text}
    </div>
  );
}

export function NowPlaying() {
  const track = useSession((s) => s.track);
  const playing = useSession((s) => s.playing);
  const loaded = useSession((s) => s.loaded);

  return (
    <section className="card now" aria-label="正在播放">
      <div className="stage">
        <CoverDisc cover={track?.cover} spinning={playing && loaded} />
        <div className="track-meta">
          <span className="muted" style={{ fontSize: 12, letterSpacing: '0.08em' }}>
            {playing ? 'NOW PLAYING' : track ? 'PAUSED' : 'READY'}
          </span>
          <h1 className="track-title">{track?.title || '还没有选择歌曲'}</h1>
          <div className="track-artist">{track ? track.artist || '未知歌手' : '从右侧播放列表选一首，或拖入本地音频文件'}</div>
          <TransferLine />
          <DuoAvatars />
        </div>
      </div>
      <Visualizer active={playing && loaded} />
      <PlayerControls />
    </section>
  );
}
