// 会话状态（Zustand）：连接 / 播放 / 播放列表 / 同步提示。
//
// 只有 engine/session.js 会写入这个 store；组件只读，并通过 engine 的方法发起操作。
// 高频变化的"当前播放位置"不放进 store（避免每帧触发全局重渲染），由 hooks/usePlayback 按帧读取。
import { create } from 'zustand';

const PROFILE_KEY = 'hh.profile';
const VOLUME_KEY = 'hh.volume';
const PALETTE = ['#ff7a59', '#5b6cff', '#16a37f', '#e0559b', '#e0a43a', '#2f9bd6', '#8a5cf6'];

function loadProfile() {
  // 测试用：?name=小明 临时指定昵称（同一浏览器两个标签页共享 localStorage，否则昵称相同）
  const urlName = new URLSearchParams(location.search).get('name');
  if (urlName) {
    const hash = [...urlName].reduce((h, c) => h + c.codePointAt(0), 0);
    return { name: urlName.slice(0, 20), color: PALETTE[hash % PALETTE.length] };
  }
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (p?.name) return p;
  } catch {}
  const names = ['小鲸鱼', '晚风', '橘子汽水', '星期天', '月亮邮差', '海盐', '云朵'];
  const name = names[Math.floor(Math.random() * names.length)];
  return { name, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
}

function loadVolume() {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) !== null ? v : 0.8;
  } catch {
    return 0.8;
  }
}

export const useSession = create(() => ({
  // ---- 房间与连接
  screen: 'lobby', // 'lobby' | 'room'
  lobbyError: null,
  role: null, // 'host' | 'guest'
  roomCode: null,
  signaling: 'connecting', // 'connecting' | 'open' | 'closed'
  peerState: 'waiting', // 'waiting' | RTCPeerConnectionState
  channelOpen: false,
  rtt: null, // ms
  offset: null, // ms，Guest 本地时钟与 Host 的差
  drift: null, // ms，Guest 实际播放位置与 Host 的偏差
  me: loadProfile(),
  peer: null, // { name, color }

  // ---- 播放列表（Host 维护，同步给 Guest 只读展示）
  playlist: [], // [{ id, title, artist, cover, duration, origin: 'library'|'local', fileName? }]
  currentId: null,

  // ---- 当前曲目
  track: null, // { id, title, artist, cover, duration }
  loaded: false, // 本地已解码，可以播放
  playing: false,
  duration: 0,
  volume: loadVolume(),
  transfer: null, // { dir: 'send'|'recv', done, total, phase: 'transfer'|'decode' }
  peerReady: false, // Host：Guest 已缓冲当前曲目
  waitingPeer: false, // Host：自动播放前等待 Guest 缓冲
  peerStreaming: false, // Host：Guest 正在边收边播

  // ---- 音频输出 / 流式播放 / 同步质量
  audioState: 'none', // AudioContext.state
  audioBlocked: false, // 被浏览器自动播放策略拦截，需要用户点击
  streaming: false, // Guest：当前曲目边收边播
  buffering: false, // 流式播放卡住等数据
  bufferedAhead: null, // 流式：当前位置之后已缓冲的秒数
  format: null, // 文件格式探测结果 { container, mime, streamable, reason }
  rate: 1, // 软同步当前的 playbackRate
  syncZone: null, // 'ok' | 'soft' | 'strong' | 'seek'
  ice: null, // { gathering, gathered: {host, srflx, relay, mdns}, pair }

  // ---- 同步提示（"对方拖动了进度条到 02:15"）
  notices: [],
}));

export function saveProfile(profile) {
  useSession.setState({ me: profile });
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {}
}

export function saveVolume(v) {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {}
}

export { PALETTE };
