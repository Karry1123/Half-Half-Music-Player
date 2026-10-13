import { useState } from 'react';
import { engine } from '../engine/session.js';
import { useMusic } from '../store/useMusic.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';

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
  return (
    <span className="stat" title={detail || 'P2P 往返延迟'}>
      <span className="ping-bars" data-level={level}>
        <i />
        <i />
        <i />
      </span>
      Ping <b>{rtt == null ? '–' : `${Math.round(rtt)} ms`}</b>
      {pairType === 'relay' && <span className="tag warn">中继</span>}
    </span>
  );
}

function RoomCode() {
  const code = useSession((s) => s.roomCode);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const link = `${location.origin}${location.pathname}?room=${code}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      prompt('复制邀请链接：', link); // 非 HTTPS 的局域网地址没有剪贴板权限
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="room-code">
      <span className="muted" style={{ fontSize: 12 }}>
        房间
      </span>
      <b>{code}</b>
      <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={copy} title="复制邀请链接" aria-label="复制邀请链接">
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
    </span>
  );
}

export function ConnectionBar() {
  const role = useSession((s) => s.role);
  const link = useLinkState();
  const openDrawer = useMusic((s) => s.setDrawer);

  return (
    <header className="topbar">
      <span className="brand">
        <span className="brand-mark" />
        Half&amp;Half
      </span>
      <RoomCode />
      <span className={`tag ${role}`}>{role === 'host' ? 'Host · 音源' : 'Guest'}</span>
      <span className="light" data-state={link.state} role="status">
        <span className="dot" />
        {link.label}
      </span>
      <PingMeter />
      <span className="spacer" />
      {role === 'host' && (
        <button className="btn" onClick={() => openDrawer(true)}>
          <Icon name="search" size={16} />
          搜索音乐
        </button>
      )}
      <button className="icon-btn" title="离开房间" aria-label="离开房间" onClick={() => confirm('确定离开房间？') && engine.leaveRoom()}>
        <Icon name="leave" />
      </button>
    </header>
  );
}
