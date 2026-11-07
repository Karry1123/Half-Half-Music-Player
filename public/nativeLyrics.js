import { currentLineIndex, lyricsQuery, parseLrc } from './lyrics.js';

// Load independently of the lyrics sheet; a closed player still exports lyrics.
export function installNativeLyrics({ plugin, store, get, session, cache, fetchLyrics,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout, warn = console.warn }) {
  let key = '', trackId = '', cacheId = '', lines = [], plain = '', offset = 0, enabled = true;
  let token = 0, lastIndex = null, lastSent = -Infinity, timer = null, disposed = false;
  let pending = Promise.resolve();
  const send = payload => {
    pending = pending.then(() => disposed ? undefined : plugin.updateLyrics(payload)).catch(warn);
  };
  const tick = () => {
    if (disposed || !enabled || !trackId) return;
    const index = currentLineIndex(lines, (session.position?.() || 0) + offset);
    if (index === lastIndex) return;
    const delay = 1000 - (now() - lastSent);
    if (delay > 0) {
      if (timer === null) timer = schedule(() => { timer = null; tick(); }, delay);
      return;
    }
    lastIndex = index; lastSent = now();
    send({ trackId, currentLine: lines[index]?.text || '', lineIndex: index });
  };
  const publish = data => {
    lines = parseLrc(data?.synced);
    plain = data?.plain || lines.map(line => line.text).join('\n');
    offset = cache.getOffset(cacheId);
    const index = currentLineIndex(lines, (session.position?.() || 0) + offset);
    lastIndex = index; lastSent = now();
    send({ trackId, enabled, lyrics: plain.slice(0, 60000), lines: lines.slice(0, 3000), offset,
      currentLine: enabled ? lines[index]?.text || '' : '', lineIndex: index });
  };
  const refresh = () => {
    const state = get(), item = state.library.find(item => item.id === state.currentId);
    const query = item && lyricsQuery(item, item.duration || state.duration);
    const nextKey = JSON.stringify([item?.id, item?.localId, query, state.externalLyricsEnabled !== false]);
    if (nextKey === key) { tick(); return; }
    key = nextKey; const request = ++token;
    if (timer !== null) cancel(timer); timer = null;
    trackId = item ? String(item.id) : ''; cacheId = item?.localId || item?.id;
    enabled = state.externalLyricsEnabled !== false;
    const cached = enabled && cache.get(cacheId);
    publish(cached || null); // Clears the old track immediately, including when disabled.
    if (!enabled || !item || !query || cached) return;
    Promise.resolve().then(() => fetchLyrics(query)).then(data => {
      if (disposed || request !== token) return;
      cache.set(cacheId, data); // The cache subscription publishes fetched and manually refreshed lyrics.
    }).catch(error => warn('[native lyrics] unavailable', error));
  };
  const unsubscribe = store.subscribe(refresh);
  const uncache = cache.subscribe(id => {
    if (id === cacheId && enabled) publish(cache.get(cacheId));
  });
  const audio = session.out?.audio;
  audio?.addEventListener?.('timeupdate', tick);
  audio?.addEventListener?.('seeked', tick);
  refresh();
  return () => {
    disposed = true; ++token;
    if (timer !== null) cancel(timer);
    unsubscribe?.(); uncache?.();
    audio?.removeEventListener?.('timeupdate', tick);
    audio?.removeEventListener?.('seeked', tick);
  };
}
