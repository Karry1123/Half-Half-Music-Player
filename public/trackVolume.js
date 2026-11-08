// Per-track output settings stay on this device, including for guests.
const key = 'hh.trackVolume';
const listeners = new Set();
let fallback = [];
const clamp = db => Number.isFinite(Number(db)) ? Math.max(-12, Math.min(12, Math.round(Number(db)))) : 0;
function read() {
  try {
    if (!globalThis.localStorage) return fallback;
    const entries = JSON.parse(globalThis.localStorage?.getItem(key) || '[]');
    return Array.isArray(entries) ? entries.filter(entry => typeof entry?.id === 'string') : [];
  } catch { return fallback; }
}
export const trackVolumeStore = {
  getTrim(id) { return id ? clamp(read().find(entry => entry.id === id)?.db) : 0; },
  setTrim(id, db) {
    const value = clamp(db);
    if (typeof id !== 'string' || !id) return value;
    fallback = [...read().filter(entry => entry.id !== id), { id, db: value }];
    try { globalThis.localStorage?.setItem(key, JSON.stringify(fallback)); } catch {}
    listeners.forEach(fn => fn(id));
    return value;
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
