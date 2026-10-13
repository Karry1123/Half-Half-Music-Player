import { useState } from 'react';
import { engine, fmtTime } from '../engine/session.js';
import { usePlaybackPosition } from '../hooks/usePlayback.js';
import { useSession } from '../store/useSession.js';
import { Icon } from './Icon.jsx';

/** 进度条：拖动时只预览，松手才发送 seek（避免拖动过程中对端频繁跳转） */
function SeekBar({ disabled }) {
  const duration = useSession((s) => s.duration);
  const pos = usePlaybackPosition();
  const [drag, setDrag] = useState(null);
  const value = drag ?? pos;
  const fill = duration ? (value / duration) * 100 : 0;

  const commit = () => {
    if (drag == null) return;
    engine.act('seek', { position: drag });
    setDrag(null);
  };

  return (
    <div className="seek-row tabular">
      <span>{fmtTime(value)}</span>
      <input
        type="range"
        className="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={value}
        disabled={disabled || !duration}
        style={{ '--fill': `${fill}%` }}
        aria-label="播放进度"
        aria-valuetext={`${fmtTime(value)} / ${fmtTime(duration)}`}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span>{fmtTime(duration)}</span>
    </div>
  );
}

/** 音量只影响本地，不同步给对方 */
function VolumeControl() {
  const volume = useSession((s) => s.volume);
  const [lastVolume, setLastVolume] = useState(0.8);
  const muted = volume === 0;
  return (
    <div className="volume">
      <button
        className="icon-btn"
        aria-label={muted ? '取消静音' : '静音'}
        title="音量只影响你自己"
        onClick={() => {
          if (muted) engine.setVolume(lastVolume || 0.8);
          else {
            setLastVolume(volume);
            engine.setVolume(0);
          }
        }}
      >
        <Icon name={muted ? 'mute' : 'volume'} />
      </button>
      <input
        type="range"
        className="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        style={{ '--fill': `${volume * 100}%` }}
        aria-label="音量"
        onChange={(e) => engine.setVolume(Number(e.target.value))}
      />
    </div>
  );
}

export function PlayerControls() {
  const role = useSession((s) => s.role);
  const playing = useSession((s) => s.playing);
  const loaded = useSession((s) => s.loaded);
  const channelOpen = useSession((s) => s.channelOpen);
  const playlist = useSession((s) => s.playlist);
  const currentId = useSession((s) => s.currentId);
  const waitingPeer = useSession((s) => s.waitingPeer);
  const peer = useSession((s) => s.peer);

  // Guest 必须连上 Host 才能操作；Host 需要已解码当前曲目
  const canControl = role === 'host' ? loaded : channelOpen && loaded;
  const index = playlist.findIndex((x) => x.id === currentId);
  const canSkip = role === 'host' || channelOpen;

  return (
    <div className="controls">
      <SeekBar disabled={!canControl} />
      <div className="transport">
        <button className="icon-btn" aria-label="上一曲" title="上一曲（播放超过 3 秒时回到开头）" disabled={!canSkip || index < 0} onClick={() => engine.act('prev')}>
          <Icon name="prev" size={22} />
        </button>
        <button className="play-btn" aria-label={playing ? '暂停' : '播放'} disabled={!canControl} onClick={() => engine.act('toggle')}>
          <Icon name={playing ? 'pause' : 'play'} size={26} />
        </button>
        <button className="icon-btn" aria-label="下一曲" disabled={!canSkip || index >= playlist.length - 1} onClick={() => engine.act('next')}>
          <Icon name="next" size={22} />
        </button>
        <VolumeControl />
      </div>
      <div className="waiting-hint" aria-live="polite">
        {waitingPeer ? `等 ${peer?.name || '对方'} 缓冲完就一起开始…` : role === 'guest' && !channelOpen ? '正在连接房主…' : ''}
      </div>
    </div>
  );
}
