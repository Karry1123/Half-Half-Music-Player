import { engine } from '../engine/session.js';
import { useMusic } from '../store/useMusic.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';
import { DownloadQueueButton } from './DownloadQueue.jsx';

const PATH = { host: '局域网直连', srflx: 'STUN 打洞', prflx: 'STUN 打洞', relay: 'TURN 中继' };

/** 连接指示灯：等待对方 → 连接中 → 同一频道 / 连接断开 */
function useLinkState() {
  const peerState = useSession((s) => s.peerState);
  const channelOpen = useSession((s) => s.channelOpen);
  const peer = useSession((s) => s.peer);
  if (peerState === 'failed' || peerState === 'disconnected') return { state: 'broken', label: '连接中断' };
  if (channelOpen && peer) return { state: 'together', label: `和 ${peer.name} 在同一频道` };
  if (peerState === 'connecting' || peerState === 'new' || (peerState === 'connected' && !channelOpen)) return { state: 'connecting', label: '正在建立 P2P…' };
  return { state: 'alone', label: '等待对方加入' };
}

function PingMeter() {
  const rtt = useSession((s) => s.rtt);
  const offset = useSession((s) => s.offset);
  const drift = useSession((s) => s.drift);
  const pairType = useSession((s) => s.ice?.pair?.local?.type);
  const level = rtt == null ? 0 : rtt < 60 ? 3 : rtt < 150 ? 2 : 1;
  const detail = [PATH[pairType], offset != null && `时钟偏移 ${offset} ms`, drift != null && `播放漂移 ${drift.toFixed(1)} ms`].filter(Boolean).join(' · ');
  if (rtt == null) return null;
  return (
    <span className="stat" title={detail || 'P2P 往返延迟'} aria-label={`往返延迟 ${Math.round(rtt)} ms`}>
      <span aria-hidden="true">·</span>
      <span className="ping-bars" data-level={level} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <b>{`${Math.round(rtt)} ms`}</b>
    </span>
  );
}

export function ConnectionBar() {
  const role = useSession((s) => s.role);
  const link = useLinkState();
  const modalOpen = useMusic((s) => s.drawerOpen || s.queueOpen);
  const openDrawer = useMusic((s) => s.setDrawer);

  return (
    <header className="topbar" inert={modalOpen ? '' : undefined}>
      <div className="topbar-identity">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Half&amp;Half
        </span>
        <span className={`tag ${role}`}>{role === 'host' ? 'Host · 音源' : 'Guest'}</span>
      </div>
      <span className="light" data-state={link.state} role="status" title={link.label}>
        <span className="dot" aria-hidden="true" />
        <span className="light-label">{link.label}</span>
        <PingMeter />
      </span>
      <div className="topbar-actions" role="group" aria-label="房间操作">
        {role === 'host' && (
          <><DownloadQueueButton />
          <button className="btn" aria-label="搜索音乐" onClick={() => openDrawer(true)}>
            <Icon name="search" size={16} />
            <span>搜索<span className="connection-action-detail">音乐</span></span>
          </button>
          </>
        )}
        <button className="icon-btn" title="离开房间" aria-label="离开房间" onClick={() => confirm('确定离开房间？') && engine.leaveRoom()}>
          <Icon name="leave" />
        </button>
      </div>
    </header>
  );
}
