import { engine } from '../engine/session.js';
import { PALETTE, useSession } from '../store/useSession.js';
import { Avatar } from './Avatar.jsx';

export function Lobby() {
  const me = useSession((s) => s.me);
  const signaling = useSession((s) => s.signaling);
  const lobbyError = useSession((s) => s.lobbyError);

  const setName = (name) => engine.setProfile({ ...me, name: name.slice(0, 20) });

  return (
    <div className="lobby">
      <span className="lobby-pattern" aria-hidden="true" />
      <div className="lobby-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
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
          <label className="nickname-field" htmlFor="nickname">
            昵称
            <input id="nickname" className="input" value={me.name} onChange={(e) => setName(e.target.value)} placeholder="你的昵称" />
          </label>
          <div className="swatches" role="group" aria-label="头像颜色">
            {PALETTE.map((c, i) => (
              <button key={c} className="swatch" aria-pressed={me.color === c} aria-label={['珊瑚', '靛蓝', '翠绿', '玫红', '金黄', '天蓝', '紫罗兰'][i]} onClick={() => engine.setProfile({ ...me, color: c })}><span className="swatch-dot" style={{ '--swatch-color': c }} aria-hidden="true" /></button>
            ))}
          </div>
        </div>

        <div className="lobby-actions">
          <div className="card lobby-card">
            <h2>从好友列表邀请一起听</h2>
            <p>打开好友 / 动态，选择好友并邀请；对方接受后即可同步收听。</p>
            <a className="btn host" href="./dashboard.html">前往好友 / 动态</a>
          </div>
        </div>

        {lobbyError && <div className="lobby-error">{lobbyError}</div>}
        {signaling === 'connecting' && <div className="muted">正在连接信令服务器…</div>}
        {signaling === 'closed' && <div className="lobby-error">信令服务器连接失败，请确认服务已启动后刷新页面。</div>}
      </div>
    </div>
  );
}
