import { useRef } from 'react';
import { engine, fmtTime } from '../engine/session.js';
import { useMusic } from '../store/useMusic.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';

const ORIGIN = { library: '已下载', local: '本地' };

function PlaylistItem({ item, index, current, playing, isHost }) {
  return (
    <div className={`item${current ? ' current' : ''}`}>
      <span className="item-index">
        {current ? (
          <span className={`eq${playing ? '' : ' paused'}`} aria-label={playing ? '正在播放' : '已暂停'}>
            <i />
            <i />
            <i />
          </span>
        ) : (
          index + 1
        )}
      </span>
      <span className="thumb">{item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="music" size={18} />}</span>
      <button style={{ minWidth: 0, textAlign: 'left' }} onClick={() => engine.act('select', { itemId: item.id })} title={isHost ? '播放' : '请房主播放这首'}>
        <div className="item-title">{item.title}</div>
        <div className="item-sub">
          {item.fresh && <span className="tag ok">新</span>}
          <span className="tag">{ORIGIN[item.origin] || item.origin}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.artist || '未知歌手'}</span>
        </div>
      </button>
      <span className="item-end tabular">
        {item.duration ? fmtTime(item.duration) : ''}
        {isHost && item.origin === 'local' && !current && (
          <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`移除 ${item.title}`} onClick={() => engine.removeItem(item.id)}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </span>
    </div>
  );
}

export function Playlist() {
  const playlist = useSession((s) => s.playlist);
  const currentId = useSession((s) => s.currentId);
  const playing = useSession((s) => s.playing);
  const role = useSession((s) => s.role);
  const channelOpen = useSession((s) => s.channelOpen);
  const musicAvailable = useMusic((s) => s.available);
  const openDrawer = useMusic((s) => s.setDrawer);
  const fileInput = useRef(null);
  const isHost = role === 'host';

  return (
    <section className="card playlist" aria-label="播放列表">
      <div className="panel-head">
        <h2>
          播放列表 <span className="muted tabular">{playlist.length}</span>
        </h2>
        {isHost && (
          <>
            <button className="btn ghost" onClick={() => fileInput.current.click()} title="也可以直接把音频文件拖进窗口">
              <Icon name="plus" size={16} />
              本地文件
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="audio/*,.mp3,.flac,.m4a,.wav,.ogg,.opus"
              multiple
              hidden
              onChange={(e) => {
                engine.addLocalFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      <div className="list">
        {playlist.map((item, i) => (
          <PlaylistItem key={item.id} item={item} index={i} current={item.id === currentId} playing={playing} isHost={isHost} />
        ))}
        {!playlist.length &&
          (isHost ? (
            <div className="drop-hint">
              <Icon name="music" size={28} />
              <div style={{ marginTop: 8 }}>把 mp3 / flac / m4a 拖到这里</div>
              {musicAvailable && (
                <button className="btn" style={{ marginTop: 12 }} onClick={() => openDrawer(true)}>
                  <Icon name="search" size={16} />
                  或者搜索下载
                </button>
              )}
            </div>
          ) : (
            <div className="empty">{channelOpen ? '房主还没有添加歌曲' : '连接房主后显示播放列表'}</div>
          ))}
      </div>
      {!isHost && playlist.length > 0 && <div className="muted" style={{ fontSize: 12, padding: '8px 16px 12px' }}>点击歌曲会请求房主切换播放</div>}
    </section>
  );
}
