// Persist actual listening time separately from the playback position: seeking is not listening.
const DATABASE = 'half-half-listening-stats';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const emptyStats = () => ({ completedPlayCount: {}, coListeningTime: {}, trackMetadata: {} });

export function createListeningStatsPersistence(indexedDB) {
  let database;
  const open = () => database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const records = db.createObjectStore('play_records', { keyPath: 'id' });
      records.createIndex('userId', 'userId');
      db.createObjectStore('listening_stats', { keyPath: 'userId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    async load(userId) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['play_records', 'listening_stats'], 'readonly');
        const records = tx.objectStore('play_records').index('userId').getAll(userId);
        const stats = tx.objectStore('listening_stats').get(userId);
        tx.oncomplete = () => resolve({ records: records.result, stats: stats.result || emptyStats() });
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
    async save({ userId, records, stats }) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['play_records', 'listening_stats'], 'readwrite');
        for (const record of records) tx.objectStore('play_records').put(record);
        tx.objectStore('listening_stats').put({ ...stats, userId });
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
  };
}

export class ListeningStats {
  constructor({ userId, indexedDB = globalThis.indexedDB, persistence } = {}) {
    this.userId = String(userId || '');
    this.persistence = persistence || (indexedDB && this.userId ? createListeningStatsPersistence(indexedDB) : null);
    this.records = [];
    this.stats = emptyStats();
    this.listeners = new Set();
    this.completionListeners = new Set();
    this.dirty = new Set();
    this.pendingSamples = [];
    this.write = Promise.resolve();
    this.loaded = false;
    this.loading = this.hydrate();
  }

  async hydrate() {
    try {
      const saved = await this.persistence?.load(this.userId);
      this.records = (saved?.records || []).filter(record => record.userId === this.userId);
      this.stats = { ...emptyStats(), ...saved?.stats };
    } catch (error) {
      // Private browsing/storage failures must not stop playback or lose this session's accounting.
      this.storageError = error;
    }
    if (!this.stats.deviceId) {
      this.stats.deviceId = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.changed = true;
    }
    this.loaded = true;
    this.scheduleSave();
    for (const sample of this.pendingSamples.splice(0)) this.sample(sample);
    this.notify();
    return this;
  }

  ready() { return this.loading; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeCompleted(listener) { this.completionListeners.add(listener); return () => this.completionListeners.delete(listener); }
  notify() { for (const listener of this.listeners) listener(this); }

  start(sample) {
    this.session = {
      trackId: sample.trackId, played: 0, completed: false,
      skipped: sample.currentTime > 1, ended: false, record: null,
    };
  }

  sample(input = {}) {
    const sample = {
      ...input, now: finite(input.now, Date.now()), currentTime: Math.max(0, finite(input.currentTime)),
      duration: Math.max(0, finite(input.duration)), playbackRate: Math.max(0.01, finite(input.playbackRate, 1)),
    };
    if (!this.loaded) { this.pendingSamples.push(sample); return; }
    if (!this.userId) return;
    this.rememberTrack(sample);
    const previous = this.previous;
    if (!sample.trackId) { this.previous = null; this.session = null; return; }
    const sameTrack = previous?.trackId === sample.trackId;
    const replay = sameTrack && this.session?.ended && sample.playing && !sample.ended;
    const loop = sameTrack && !sample.seeking && !previous.seeking && previous.playing && sample.playing
      && previous.duration > 0 && previous.currentTime >= previous.duration - 1
      && sample.currentTime < previous.currentTime && sample.currentTime <= 1;
    if (!sameTrack || replay || loop || !this.session) this.start(sample);
    const session = this.session;
    let gained = 0;
    if (sameTrack && !replay && !loop && !session.ended) {
      const wall = Math.max(0, (sample.now - previous.now) / 1000);
      const delta = sample.currentTime - previous.currentTime;
      const jumped = delta > wall * previous.playbackRate + 0.75 || delta < -0.1;
      if (sample.seeking || previous.seeking || jumped) {
        if (delta > 0.1 || jumped) session.skipped = true;
      } else if (previous.playing && wall > 0 && delta > 0) {
        gained = Math.min(wall, delta / previous.playbackRate);
      }
      if (gained > 0) {
        session.played += gained;
        // Split intervals crossing local midnight so calendar summaries retain the correct day.
        let cursor = sample.now - gained * 1000;
        while (cursor < sample.now) {
          const date = new Date(cursor);
          const day = date.toDateString();
          const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
          const end = Math.min(sample.now, midnight);
          if (!session.record || session.record.day !== day) {
            session.record = {
              id: globalThis.crypto?.randomUUID?.() || `${this.userId}-${cursor}-${Math.random()}`,
              userId: this.userId, trackId: sample.trackId, durationPlayed: 0,
              timestamp: cursor, day,
            };
            this.records.push(session.record);
          }
          session.record.durationPlayed += (end - cursor) / 1000;
          this.dirty.add(session.record.id);
          cursor = end;
        }
        if (previous.connected && previous.friendId) {
          const friendId = String(previous.friendId);
          this.stats.coListeningTime[friendId] = (this.stats.coListeningTime[friendId] || 0) + gained;
        }
      }
    }
    const reachedThreshold = sample.duration > 0 && session.played >= sample.duration * 0.95;
    const naturalEnd = sample.ended && !session.skipped && session.played > 0;
    if (!session.completed && (reachedThreshold || naturalEnd)) {
      this.stats.completedPlayCount[sample.trackId] = this.completedCount(sample.trackId) + 1;
      session.completed = true;
      this.changed = true;
      for (const listener of this.completionListeners) listener(this);
    }
    if (sample.ended) session.ended = true;
    this.previous = sample;
    if (gained || this.changed) {
      this.changed = true;
      this.scheduleSave();
      this.notify();
    }
  }

  scheduleSave() {
    if (!this.persistence || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, 1000);
    this.timer.unref?.();
  }

  async flush() {
    await this.ready();
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.persistence || !this.changed) return this.write;
    const ids = new Set(this.dirty);
    const snapshot = {
      userId: this.userId,
      records: this.records.filter(record => ids.has(record.id)).map(record => ({ ...record })),
      stats: { deviceId: this.stats.deviceId, trackMetadata: { ...this.stats.trackMetadata }, completedPlayCount: { ...this.stats.completedPlayCount }, coListeningTime: { ...this.stats.coListeningTime } },
    };
    this.dirty.clear();
    this.changed = false;
    this.write = this.write.catch(() => {}).then(() => this.persistence.save(snapshot)).catch(error => {
      this.storageError = error;
      ids.forEach(id => this.dirty.add(id));
      this.changed = true;
      throw error;
    });
    return this.write;
  }

  rememberTrack({ trackId, title, artist = '', cover = '' }) {
    if (!trackId || !title) return;
    const old = this.stats.trackMetadata[trackId];
    const meta = { title, artist, cover: /^https:\/\//i.test(cover) ? cover : old?.cover || '' };
    if (JSON.stringify(old) !== JSON.stringify(meta)) {
      this.stats.trackMetadata[trackId] = meta;
      this.changed = true;
    }
  }

  completedUploads() {
    const songs = new Map();
    for (const [id, completed] of Object.entries(this.stats.completedPlayCount)) {
      const saved = this.stats.trackMetadata[id];
      const meta = saved && { ...saved, artist: saved.artist || '' };
      if (!meta?.title || !completed || meta.title.length > 200 || meta.artist.length > 200) continue;
      const key = [meta.title, meta.artist].map(x => x.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')).join('\n');
      const item = songs.get(key) || { ...meta, cover: /^https:\/\//i.test(meta.cover || '') && meta.cover.length <= 2000 ? meta.cover : '', completed: 0 };
      item.completed += completed;
      songs.set(key, item);
    }
    return [...songs.values()];
  }

  completedCount(trackId) { return this.stats.completedPlayCount[trackId] || 0; }
  coListeningSeconds(friendId) { return this.stats.coListeningTime[friendId] || 0; }
  summary(period = 'week', now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    else if (period === 'month') start.setDate(1);
    else if (period === 'year') start.setMonth(0, 1);
    else throw new RangeError('Unknown listening statistics period');
    return this.records.reduce((total, record) => total +
      (record.timestamp >= start.getTime() && record.timestamp <= now ? record.durationPlayed : 0), 0);
  }
}

// Upload absolute device totals: retrying/backfilling cannot double count on the server.
// A completion during an in-flight request queues another snapshot instead of being lost.
export function createCompletedPlayUploader({ stats, client, listTracks, onUploaded = () => {} }) {
  let running, queued = false;
  return function upload() {
    if (!client.user?.isActivated) return Promise.resolve();
    queued = true;
    if (running) return running;
    running = (async () => {
      try {
        while (queued) {
          queued = false;
          await stats.ready();
          for (const t of await listTracks().catch(() => [])) {
            stats.rememberTrack({ trackId: t.id, title: t.title, artist: t.artist, cover: t.coverUrl || t.cover });
          }
          await stats.flush();
          const plays = stats.completedUploads();
          for (let i = 0; i < plays.length; i += 100) {
            await client.request('/account/plays', { deviceId: stats.stats.deviceId, plays: plays.slice(i, i + 100) });
          }
          if (plays.length) onUploaded();
        }
      } finally { running = null; }
    })();
    return running;
  };
}
