// Local playback checkpoints never carry room/guest state or start audio at launch.
export const LAST_PLAYBACK_KEY = 'hh.lastPlayback';
export function resumePosition(position, duration) {
  const p = Number.isFinite(position) ? Math.max(0, position) : 0;
  return duration > 0 && p >= Math.max(0, duration - 3) ? 0 : p;
}

export function readLastPlayback(state, playlists, storage = globalThis.localStorage) {
  if (state.role === 'guest') return null;
  try {
    const saved = JSON.parse(storage.getItem(LAST_PLAYBACK_KEY));
    if (saved?.version !== 1) return null;
    const item = state.library.find(x => x.id === saved.trackId);
    if (!item) return null;
    const duration = Number.isFinite(item.duration) ? item.duration : 0;
    const playlist = saved.activePlaylistId && playlists.get(saved.activePlaylistId);
    const activePlaylistId = playlist && playlist.trackIds?.includes(item.localId || item.id) ? playlist.id : null;
    const scopeKey = activePlaylistId || 'all';
    const viewOrder = (!saved.activePlaylistId || activePlaylistId) && saved.viewOrder?.playlistId === scopeKey && Array.isArray(saved.viewOrder.ids)
      ? { playlistId: scopeKey, ids: [...new Set(saved.viewOrder.ids.filter(id => state.library.some(x => x.id === id)))] } : null;
    return { trackId: item.id, duration, position: resumePosition(saved.position, duration), activePlaylistId, viewOrder,
      playMode: ['order', 'loopAll', 'loopOne', 'shuffle'].includes(saved.playMode) ? saved.playMode : 'order' };
  } catch { return null; }
}

export function createPlaybackWriter({ storage = globalThis.localStorage, now = Date.now } = {}) {
  let lastAt = -Infinity, lastContext = '';
  return (state, session, force = false) => {
    if (state.role === 'guest') return false;
    const item = state.library.find(x => x.id === state.currentId);
    if (!item || session.anchor.trackId !== item.id) return false;
    const context = JSON.stringify([item.id, state.playing, state.activePlaylistId, state.playMode, session.viewOrder]);
    const at = now();
    if (!force && context === lastContext && at - lastAt < 5000) return false;
    const position = state.playing ? session.position() : session.anchor.position;
    const saved = { version: 1, trackId: item.id, position: Math.max(0, Number.isFinite(position) ? position : 0),
      activePlaylistId: state.activePlaylistId || null, viewOrder: session.viewOrder || null, playMode: state.playMode };
    try { storage.setItem(LAST_PLAYBACK_KEY, JSON.stringify(saved)); lastAt = at; lastContext = context; return true; } catch { return false; }
  };
}

export function installPlaybackPersistence({ store, get, session, doc = globalThis.document, win = globalThis.window }) {
  const write = createPlaybackWriter();
  session.persistPlayback = (force = false) => write(get(), session, force);
  store.subscribe(() => session.persistPlayback());
  setInterval(() => { if (get().playing) session.persistPlayback(); }, 5000);
  doc.addEventListener('visibilitychange', () => session.persistPlayback(true));
  win.addEventListener('pagehide', () => session.persistPlayback(true));
}
