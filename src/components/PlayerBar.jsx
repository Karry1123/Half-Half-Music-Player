import { useSession } from '../store/useSession.js';
import { useMusic } from '../store/useMusic.js';
import { PlayerControls } from './PlayerControls.jsx';
export function PlayerBar() {
  const track = useSession(s => s.track);
  const modalOpen = useMusic(s => s.drawerOpen || s.queueOpen);
  return <footer className="persistent-player" aria-label="播放控制" inert={modalOpen ? '' : undefined}>
    <div className="persistent-track"><strong>{track?.title || '从共享列表选择一首歌'}</strong><small>{track?.artist || 'Half&Half · 一起听'}</small></div>
    <PlayerControls />
  </footer>;
}
