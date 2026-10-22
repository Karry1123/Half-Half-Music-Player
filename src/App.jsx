import { useEffect, useState } from 'react';
import { AudioUnlock } from './components/AudioUnlock.jsx';
import { ConnectionBar } from './components/ConnectionBar.jsx';
import { DebugPanel } from './components/DebugPanel.jsx';
import { Lobby } from './components/Lobby.jsx';
import { NowPlaying } from './components/NowPlaying.jsx';
import { Playlist } from './components/Playlist.jsx';
import { SearchDrawer } from './components/SearchDrawer.jsx';
import { Toasts } from './components/Toasts.jsx';
import { DownloadQueue } from './components/DownloadQueue.jsx';
import { engine } from './engine/session.js';
import { useSession } from './store/useSession.js';

const DEBUG = new URLSearchParams(location.search).has('debug');

/** Host：把音频文件拖到窗口任意位置即可加入播放列表 */
function useFileDrop(enabled) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) setDragging(false);
    };
    const onOver = (e) => hasFiles(e) && e.preventDefault();
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const n = engine.addLocalFiles(e.dataTransfer.files);
      if (!n) engine.notify('没有可识别的音频文件');
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled]);
  return dragging;
}

/** 空格 = 播放/暂停（输入框内不拦截） */
function useSpaceToggle(enabled) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (e.target.closest('input, textarea, select, button, [contenteditable]')) return;
      e.preventDefault();
      engine.act('toggle');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export function App() {
  const screen = useSession((s) => s.screen);
  const role = useSession((s) => s.role);
  const inRoom = screen === 'room';
  const dragging = useFileDrop(inRoom && role === 'host');
  useSpaceToggle(inRoom);

  useEffect(() => {
    document.title = inRoom ? `Half&Half · ${useSession.getState().roomCode}` : 'Half&Half Music Player';
  }, [inRoom]);

  if (!inRoom) return <><Lobby /><Toasts /></>;
  return (
    <div className="room">
      <ConnectionBar />
      <main className="room-main">
        <NowPlaying />
        <Playlist />
      </main>
      <SearchDrawer />
      <DownloadQueue />
      <Toasts />
      <AudioUnlock />
      {DEBUG && <DebugPanel />}
      {dragging && (
        <div className="drag-overlay">
          <div>松手添加到播放列表</div>
        </div>
      )}
    </div>
  );
}
