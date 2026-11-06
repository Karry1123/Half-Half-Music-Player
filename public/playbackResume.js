// Remembers which track (and queue context) was last playing so a cold start can show it again.
// Only the track is kept: after the process died the song starts over, so no position is recorded.
// Pausing without a restart still resumes in place, because that state lives in memory.
export const LAST_PLAYBACK_KEY = 'hh.lastPlayback';

export function readLastPlayback(state, playlists, storage = globalThis.localStorage) {
  if (state.role === 'guest') return null;
  try {
    const saved = JSON.parse(storage.getItem(LAST_PLAYBACK_KEY));
    if (saved?.version !== 2) return null;
    const item = state.library.find(x => x.id === saved.trackId);
    if (!item) return null;
    const duration = Number.isFinite(item.duration) ? item.duration : 0;
    const playlist = saved.activePlaylistId && playlists.get(saved.activePlaylistId);
    const activePlaylistId = playlist && playlist.trackIds?.includes(item.localId || item.id) ? playlist.id : null;
    const scopeKey = activePlaylistId || 'all';
    const viewOrder = (!saved.activePlaylistId || activePlaylistId) && saved.viewOrder?.playlistId === scopeKey && Array.isArray(saved.viewOrder.ids)
      ? { playlistId: scopeKey, ids: [...new Set(saved.viewOrder.ids.filter(id => state.library.some(x => x.id === id)))] } : null;
    return { trackId: item.id, duration, position: 0, activePlaylistId, viewOrder,
      playMode: ['order', 'loopAll', 'loopOne', 'shuffle'].includes(saved.playMode) ? saved.playMode : 'order' };
  } catch { return null; }
}

/** Writes only when the track or its queue context changes; progress is never stored. */
export function createPlaybackWriter({ storage = globalThis.localStorage } = {}) {
  let lastContext = '';
  return (state, session) => {
    if (state.role === 'guest') return false;
    const item = state.library.find(x => x.id === state.currentId);
    if (!item || session.anchor.trackId !== item.id) return false;
    const saved = { version: 2, trackId: item.id, activePlaylistId: state.activePlaylistId || null, viewOrder: session.viewOrder || null, playMode: state.playMode };
    const context = JSON.stringify(saved);
    if (context === lastContext) return false;
    try { storage.setItem(LAST_PLAYBACK_KEY, context); lastContext = context; return true; } catch { return false; }
  };
}

export function installPlaybackPersistence({ store, get, session }) {
  const write = createPlaybackWriter();
  session.persistPlayback = () => write(get(), session);
  store.subscribe(() => session.persistPlayback());
}
