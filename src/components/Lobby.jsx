import { useState } from 'react';
import { engine } from '../engine/session.js';
import { PALETTE, useSession } from '../store/useSession.js';
import { Avatar } from './Avatar.jsx';

export function Lobby() {
  const me = useSession((s) => s.me);
  const signaling = useSession((s) => s.signaling);
  const lobbyError = useSession((s) => s.lobbyError);
  const role = useSession((s) => s.role);
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('room') || '');
  const invited = /^\d{6}$/.test(code);

  const setName = (name) => engine.setProfile({ ...me, name: name.slice(0, 20) });
  const offline = signaling !== 'open';

  return (
    <div className="lobby">
      <div className="lobby-inner">
        <div className="brand">
          <span className="brand-mark" />
          Half&amp;Half Music Player
        </div>
        <div>
          <h1>
            两个人，<span className="amp">一首歌</span>，同一拍。
          </h1>
          <p className="lobby-sub">音乐从一台设备直接传到另一台，播放、暂停、拖动进度都实时同步。</p>
        </div>

        <div className="card profile-row">
          <Avatar profile={me} size={44} />
          <label className="sr-only" htmlFor="nickname">
            昵称
          </label>
          <input id="nickname" className="input" value={me.name} onChange={(e) => setName(e.target.value)} placeholder="你的昵称" style={{ flex: '1 1 160px' }} />
          <div className="swatches" role="group" aria-label="头像颜色">
            {PALETTE.map((c) => (
              <button key={c} className="swatch" style={{ background: c }} aria-pressed={me.color === c} aria-label={`颜色 ${c}`} onClick={() => engine.setProfile({ ...me, color: c })} />
            ))}
          </div>
        </div>

        <div className="lobby-actions">
          <div className="card lobby-card" style={invited ? { order: 2 } : undefined}>
            <span className="tag host" style={{ justifySelf: 'start' }}>
              Host
            </span>
            <h2>创建房间，我来放歌</h2>
            <p>音乐在你的电脑上：搜索下载、拖入本地文件，对方无需下载即可同步收听。</p>
            <button className="btn host" disabled={offline || !!role} onClick={() => engine.createRoom()}>
              创建房间
            </button>
          </div>

          <form
            className="card lobby-card"
            onSubmit={(e) => {
              e.preventDefault();
              engine.joinRoom(code);
            }}
          >
            <span className="tag guest" style={{ justifySelf: 'start' }}>
              Guest
            </span>
            <h2>{invited ? '你收到了一个邀请' : '加入朋友的房间'}</h2>
            <p>输入对方给你的 6 位房间码。</p>
            <input
              className="input code-input"
              inputMode="numeric"
              maxLength={6}
              pattern="\d{6}"
              required
              placeholder="······"
              aria-label="房间码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn guest" disabled={offline || !!role || code.length !== 6}>
              加入房间
            </button>
          </form>
        </div>

        {lobbyError && <div className="lobby-error">{lobbyError}</div>}
        {signaling === 'connecting' && <div className="muted">正在连接信令服务器…</div>}
        {signaling === 'closed' && <div className="lobby-error">信令服务器连接失败，请确认服务已启动后刷新页面。</div>}
      </div>
    </div>
  );
}
