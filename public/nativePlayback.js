import { PLAY_MODES } from './playQueue.js';

// Android (Capacitor): one bridge between the player state and the system playback UI.
// The native PlaybackService owns the MediaSession, the MediaStyle notification (artwork, seek bar,
// prev / play-pause / next), the wake lock and the home-screen widgets. This module pushes state and
// artwork to it and performs the "action" events it sends back (notification, lock screen, media keys,
// widgets, and the launch action of a widget tap that had to open the app first).

const HOLD_KEYS = ['playing', 'playbackPending', 'audioFocusTransient'];

export function subtitleFor(state) {
  if (state.role === 'host') return '和伙伴同步收听';
  if (state.role === 'guest') return `正在听 ${state.peer?.name || '房主'} 的歌`;
  return '';
}

export function snapshot(state, session, item, seedColor = state.seedColor || '') {
  const hold = !!(state.playing || state.playbackPending || session.out?.intent || state.audioFocusTransient);
  return {
    active: !!item,
    playing: !!state.playing,
    hold: !!item && hold,
    trackId: item ? String(item.id) : '',
    title: item?.title || '',
    artist: item?.artist || item?.sourceLabel || '',
    subtitle: item ? (!state.loaded && !hold && state.role !== 'guest' ? '点按打开 App 继续' : subtitleFor(state)) : '',
    duration: Number.isFinite(state.duration) ? Math.max(0, state.duration) : 0,
    position: Math.max(0, session.position?.() || 0),
    canNext: !!item && !!state.canNext,
    canPrev: !!item,
    favorite: !!item && !!state.playlists?.some(p => p.id === 'favorites' && p.trackIds?.includes(item.localId || item.id)),
    playMode: PLAY_MODES.includes(state.playMode) ? state.playMode : 'order',
    canChangeMode: state.role !== 'guest',
    seedColor: item && /^#[0-9a-f]{6}$/i.test(seedColor) ? seedColor.toLowerCase() : '',
  };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(blob);
  });
}

/**
 * @param {object} deps
 * @param {{ update: Function, setArtwork: Function, requestNotifications: Function, addListener: Function }} deps.plugin
 * @param {{ subscribe: Function }} deps.store  get(): current state
 * @param {object} deps.session  act(action, opts), position(), out.audio, out.intent
 * @param {(item: object) => Promise<Blob|null>} deps.fetchCover
 * @param {(title: string) => string} deps.fallbackArtwork  data: URL
 */
export function installNativePlayback({ plugin, store, get, session, fetchCover, fallbackArtwork, toast = () => {}, onAction = () => false, getSeedColor = async () => '', getCoverKey = item => item?.cover || '', doc = globalThis.document, warn = console.warn }) {
  let ready = false;
  const queued = [];
  const lastAction = new Map(), inFlight = new Set();
  const perform = ({ action, position }) => {
    if (!action) return;
    if (!ready) { queued.push({ action, position }); return; }
    const custom = action === 'favorite' || action === 'mode';
    const now = Date.now();
    if (custom && (inFlight.has(action) || now - (lastAction.get(action) ?? -Infinity) < 400)) return;
    if (custom) { lastAction.set(action, now); inFlight.add(action); }
    try {
      const result = custom ? onAction(action) : session.act(action, action === 'seek' ? { position } : {});
      Promise.resolve(result).catch(e => warn('[native playback] action failed', e))
        .finally(() => inFlight.delete(action));
    } catch (e) { inFlight.delete(action); warn('[native playback] action failed', e); }
  };
  plugin.addListener('action', perform).catch?.(warn);

  let previousKey = '';
  let pending = Promise.resolve();
  let askedNotifications = false;
  let startFailed = false;
  let seedFor = null, seedColor = '', disposed = false;
  const coverKey = item => item ? JSON.stringify([String(item.id), getCoverKey(item)]) : '';
  const updateSeed = item => {
    const key = coverKey(item);
    if (key === seedFor) return;
    seedFor = key; seedColor = '';
    if (!item) return;
    Promise.resolve().then(() => getSeedColor(item)).then(color => {
      const current = get().library.find(x => x.id === get().currentId);
      if (disposed || seedFor !== key || coverKey(current) !== key) return;
      seedColor = /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '';
      push();
    }).catch(e => warn('[native playback] palette failed', e));
  };
  const push = () => {
    const s = get();
    const item = s.library.find(x => x.id === s.currentId) || null;
    updateSeed(item);
    const state = snapshot(s, session, item, seedColor);
    pending = pending
      .then(() => plugin.update(state))
      .then(() => {
        startFailed = false;
        if (state.hold && !askedNotifications && !doc?.hidden) {
          askedNotifications = true;
          plugin.requestNotifications().catch(() => {});
        }
      })
      .catch(e => {
        warn('[native playback] update failed', e);
        if (state.hold && !startFailed) { startFailed = true; toast('后台播放服务启动失败，请返回前台重试', 'warn'); }
      });
  };

  let artworkToken = 0;
  let artworkFor = '';
  const pushArtwork = async (item) => {
    const token = ++artworkToken;
    let blob = null;
    try { blob = await fetchCover(item); } catch {}
    if (token !== artworkToken) return;
    let data;
    try {
      data = blob ? await blobToBase64(blob) : fallbackArtwork(item.title || '♪').replace(/^data:[^,]*,/, '');
    } catch (e) { warn('[native playback] artwork encode failed', e); return; }
    if (token !== artworkToken) return;
    pending = pending.then(() => plugin.setArtwork({ trackId: String(item.id), data })).catch(e => warn('[native playback] artwork failed', e));
  };

  const unsubscribe = store.subscribe(() => {
    const s = get();
    const item = s.library.find(x => x.id === s.currentId) || null;
    const hold = HOLD_KEYS.some(k => s[k]) || !!session.out?.intent;
    const key = JSON.stringify([item?.id ?? null, item?.title, item?.artist, item?.cover, s.playing, hold, s.duration, s.canNext, s.role, s.peer?.name, snapshot(s, session, item).favorite, s.playMode, item?.localId, getCoverKey(item)]);
    if (key === previousKey) return; // progress ticks and toasts must not re-trigger a failed start
    previousKey = key;
    push();
    const coverKey = item ? `${item.id}|${item.cover || ''}` : '';
    if (coverKey !== artworkFor) {
      artworkFor = coverKey;
      if (item) pushArtwork(item);
    }
  });
  session.out?.audio?.addEventListener?.('seeked', push);
  session.out?.audio?.addEventListener?.('ratechange', push);
  const onVisible = () => { if (!doc?.hidden) { startFailed = false; push(); } };
  doc?.addEventListener?.('visibilitychange', onVisible);

  return {
    /** Call once the library is restored: queued actions (widget launch, early media keys) run now. */
    markReady() {
      ready = true;
      push();
      for (const a of queued.splice(0)) perform(a);
    },
    push,
    dispose() {
      disposed = true; ++artworkToken;
      unsubscribe?.();
      session.out?.audio?.removeEventListener?.('seeked', push);
      session.out?.audio?.removeEventListener?.('ratechange', push);
      doc?.removeEventListener?.('visibilitychange', onVisible);
    },
  };
}
