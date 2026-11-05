import { toSimplified } from './zhVariants.js';

// Persist actual listening time separately from the playback position: seeking is not listening.
const DATABASE = 'half-half-listening-stats';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const emptyStats = () => ({ completedPlayCount: {}, coListeningTime: {}, trackMetadata: {} });
const normalizedName = value => toSimplified(String(value || '')).normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
const songKey = meta => JSON.stringify([meta?.title, meta?.artist].map(normalizedName));
const calendarDay = timestamp => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const recordDay = record => record.localDay || (record.day ? calendarDay(Date.parse(record.day)) : calendarDay(record.timestamp));

// Calendar operations stay in local time, including across daylight-saving changes.
const dayDate = day => new Date(`${day}T00:00:00`);
const dayNumber = day => {
  const date = dayDate(day);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
};
const periodBounds = (period, now) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  else if (period === 'month') start.setDate(1);
  else if (period === 'year') start.setMonth(0, 1);
  else if (period !== 'all') throw new RangeError('Unknown listening statistics period');
  return { startDay: period === 'all' ? '0000-01-01' : calendarDay(+start), endDay: calendarDay(now), start };
};
const inPeriod = (record, bounds, now) => recordDay(record) >= bounds.startDay
  && recordDay(record) <= bounds.endDay && record.timestamp <= now;

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
      this.cloud = this.stats.cloud;
    } catch (error) {
      // Private browsing/storage failures must not stop playback or lose this session's accounting.
      this.storageError = error;
    }
    if (!this.stats.deviceId) {
      this.stats.deviceId = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.changed = true;
    }
    this.loaded = true;
    this.completionIndex = null;
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
    const metadataChanged = this.rememberTrack(sample);
    const previous = this.previous;
    if (!sample.trackId) { this.previous = null; this.session = null; return; }
    const sameTrack = previous?.trackId === sample.trackId;
    const replay = sameTrack && this.session?.ended && sample.playing && !sample.ended;
    const loop = sameTrack && !sample.seeking && !previous.seeking && previous.playing && sample.playing
      && previous.duration > 0 && previous.currentTime >= previous.duration - 1
      && sample.currentTime < previous.currentTime && sample.currentTime <= 1;
    if (!sameTrack || replay || loop || !this.session) this.start(sample);
    const session = this.session;
    let gained = 0, completed = false;
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
              timestamp: cursor, day, localDay: calendarDay(cursor),
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
      this.stats.completedPlayCount[sample.trackId] = (this.stats.completedPlayCount[sample.trackId] || 0) + 1;
      session.record.completed = (session.record.completed || 0) + 1;
      this.dirty.add(session.record.id);
      this.completionIndex = null;
      session.completed = true;
      completed = true;
      this.changed = true;
      for (const listener of this.completionListeners) listener(this);
    }
    if (sample.ended) session.ended = true;
    this.previous = sample;
    if (gained || completed || metadataChanged) {
      this.changed = true;
      this.scheduleSave();
      this.notify();
    }
  }

  scheduleSave() {
    if (!this.persistence || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, 30000);
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
      stats: { deviceId: this.stats.deviceId, cloud: this.cloud, trackMetadata: { ...this.stats.trackMetadata }, completedPlayCount: { ...this.stats.completedPlayCount }, coListeningTime: { ...this.stats.coListeningTime } },
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

  rememberTrack({ trackId, title, artist = '', cover = '', sourceId, hash }) {
    if (!trackId || !title) return;
    const old = this.stats.trackMetadata[trackId];
    const meta = { title, artist, cover: /^https:\/\//i.test(cover) && cover.length <= 2000 ? cover : old?.cover || '',
      sourceId: sourceId || old?.sourceId || '', hash: hash || old?.hash || '' };
    if (JSON.stringify(old) !== JSON.stringify(meta)) {
      this.stats.trackMetadata[trackId] = meta;
      this.completionIndex = null;
      this.changed = true;
      return true;
    }
  }

  completedUploads() {
    const songs = new Map();
    for (const [id, completed] of Object.entries(this.stats.completedPlayCount)) {
      const saved = this.stats.trackMetadata[id];
      const meta = saved && { title: saved.title, artist: saved.artist || '', cover: saved.cover || '' };
      if (!meta?.title || !completed || meta.title.length > 200 || meta.artist.length > 200) continue;
      const key = [meta.title, meta.artist].map(x => x.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')).join('\n');
      const item = songs.get(key) || { ...meta, cover: /^https:\/\//i.test(meta.cover || '') && meta.cover.length <= 2000 ? meta.cover : '', completed: 0 };
      item.completed += completed;
      songs.set(key, item);
    }
    return [...songs.values()];
  }

  trackKey(trackId) {
    const meta = this.stats.trackMetadata[trackId];
    return meta && (meta.sourceId || (meta.hash && `hash:${meta.hash}`) || songKey(meta));
  }
  mergeCloud(data) { this.cloud = data; this.completionIndex = null; this.changed = true; this.scheduleSave(); this.notify(); }
  indexCompletions() {
    if (this.completionIndex) return this.completionIndex;
    const keys = new Map(), names = new Map(), pairs = new Map(), remoteKeys = new Map(), remoteNames = new Map();
    const add = (map, key, count) => map.set(key, (map.get(key) || 0) + count);
    for (const [id, count] of Object.entries(this.stats.completedPlayCount)) {
      const key = this.trackKey(id), name = songKey(this.stats.trackMetadata[id]);
      add(keys, key, count); add(names, name, count); add(pairs, JSON.stringify([key, name]), count);
    }
    for (const row of this.cloud?.completed || []) {
      if (!remoteKeys.has(row.key)) remoteKeys.set(row.key, row);
      const name = row.completionKey || row.key;
      if (!remoteNames.has(name)) remoteNames.set(name, row);
    }
    return this.completionIndex = { keys, names, pairs, remoteKeys, remoteNames };
  }
  completedCount(trackId) {
    const meta = this.stats.trackMetadata[trackId];
    if (!meta) return this.stats.completedPlayCount[trackId] || 0;
    const key = songKey(meta);
    const index = this.indexCompletions(), trackKey = this.trackKey(trackId);
    const local = (index.keys.get(trackKey) || 0) + (index.names.get(key) || 0) -
      (index.pairs.get(JSON.stringify([trackKey, key])) || 0);
    const remote = index.remoteKeys.get(trackKey) || index.remoteNames.get(key);
    return local + Number(remote?.completed || 0);
  }
  coListeningSeconds(friendId) {
    return (this.stats.coListeningTime[friendId] || 0) + Number(this.cloud?.coListening?.find(row => row.friendId === friendId)?.seconds || 0);
  }
  coListeningTotals() {
    const ids = new Set([...Object.keys(this.stats.coListeningTime), ...(this.cloud?.coListening || []).map(row => row.friendId)]);
    return Object.fromEntries([...ids].map(id => [id, this.coListeningSeconds(id)]));
  }
  dailyTotals(period = 'week', now = Date.now()) {
    const bounds = periodBounds(period, now), totals = new Map();
    const add = (day, seconds) => {
      if (day >= bounds.startDay && day <= bounds.endDay)
        totals.set(day, (totals.get(day) || 0) + Math.max(0, finite(seconds)));
    };
    for (const row of this.cloud?.daily || []) add(row.day, row.seconds);
    for (const record of this.records) if (inPeriod(record, bounds, now)) add(recordDay(record), record.durationPlayed);
    return [...totals].map(([day, seconds]) => ({ day, seconds })).sort((a, b) => a.day.localeCompare(b.day));
  }

  completedInPeriod(period = 'week', now = Date.now()) {
    if (period === 'all') {
      const local = Object.values(this.stats.completedPlayCount).reduce((sum, count) => sum + count, 0);
      const remote = [...new Map((this.cloud?.completed || []).map(row => [row.key, row])).values()];
      return local + remote.reduce((sum, row) => sum + Number(row.completed || 0), 0);
    }
    const bounds = periodBounds(period, now);
    const local = this.records.filter(record => inPeriod(record, bounds, now))
      .reduce((sum, record) => sum + (record.completed || 0), 0);
    return local + (this.cloud?.dailyCompleted || [])
      .filter(row => row.day >= bounds.startDay && row.day <= bounds.endDay)
      .reduce((sum, row) => sum + Number(row.completed || 0), 0);
  }

  summary(period = 'week', now = Date.now()) {
    return this.dailyTotals(period, now).reduce((sum, row) => sum + row.seconds, 0);
  }

  // Previous complete calendar week/month, compared with the current period to date.
  previousSummary(period = 'week', now = Date.now()) {
    if (!['week', 'month'].includes(period)) return null;
    const { start } = periodBounds(period, now);
    return this.summary(period, +start - 1);
  }

  // Complete local calendar buckets; unreached buckets remain visible with zero time.
  // Month weeks start on Monday and are clipped to the first/last day of the month.
  periodSeries(period = 'week', now = Date.now(), { since } = {}) {
    const totals = this.dailyTotals(period, now), { start, endDay: today } = periodBounds(period, now);
    const year = new Date(now).getFullYear(), series = [];
    const add = (label, first, next) => {
      const startDay = calendarDay(+first), endDay = calendarDay(+next - 1);
      const reached = startDay <= today;
      const seconds = reached ? totals.reduce((sum, row) => sum + (row.day >= startDay && row.day <= endDay ? row.seconds : 0), 0) : 0;
      series.push({ label, startDay, endDay, seconds, reached });
    };
    if (period === 'week') {
      for (let i = 0; i < 7; i++) {
        const first = new Date(start), next = new Date(start);
        first.setDate(start.getDate() + i); next.setDate(start.getDate() + i + 1);
        add(`周${['一', '二', '三', '四', '五', '六', '日'][i]}`, first, next);
      }
    } else if (period === 'month') {
      const end = new Date(year, start.getMonth() + 1, 1);
      let first = new Date(start);
      while (first < end) {
        const next = new Date(first);
        next.setDate(next.getDate() + 7 - (next.getDay() + 6) % 7);
        if (next > end) next.setTime(+end);
        add(`第${series.length + 1}周`, first, next);
        first = next;
      }
    } else if (period === 'year') {
      for (let month = 0; month < 12; month++) add(`${month + 1}月`, new Date(year, month, 1), new Date(year, month + 1, 1));
    } else {
      const registered = since == null ? NaN : new Date(since).getFullYear();
      const firstYear = Math.min(year, Number.isFinite(registered) ? registered : year, ...totals.map(row => Number(row.day.slice(0, 4))));
      for (let value = firstYear; value <= Math.max(year, firstYear + 1); value++) add(`${value}年`, new Date(value, 0, 1), new Date(value + 1, 0, 1));
    }
    return series;
  }

  dailySeries(period = 'week', now = Date.now()) {
    const totals = this.dailyTotals(period, now), bounds = periodBounds(period, now);
    let cursor = period === 'all' ? dayDate(totals[0]?.day || bounds.endDay) : bounds.start;
    const end = dayDate(bounds.endDay), series = [];
    const monthly = period === 'year' || period === 'all';
    const months = (end.getFullYear() - cursor.getFullYear()) * 12 + end.getMonth() - cursor.getMonth() + 1;
    const stride = Math.max(1, Math.ceil(months / 31));
    if (monthly) cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const values = new Map(totals.map(row => [row.day, row.seconds]));
    while (cursor <= end) {
      const day = calendarDay(+cursor), next = new Date(cursor);
      if (monthly) next.setMonth(next.getMonth() + stride);
      else next.setDate(next.getDate() + 1);
      const nextDay = calendarDay(+next);
      const seconds = monthly ? totals.reduce((sum, row) => sum + (row.day >= day && row.day < nextDay ? row.seconds : 0), 0) : values.get(day) || 0;
      const last = new Date(Math.min(+end, +next - 1));
      series.push({ day, endDay: calendarDay(+last), seconds });
      cursor = next;
    }
    return series;
  }

  activeDays(period = 'week', now = Date.now()) {
    const days = this.dailyTotals(period, now).filter(row => row.seconds > 0);
    let longestStreak = 0, streak = 0, previous;
    for (const row of days) {
      const day = dayNumber(row.day);
      streak = day === previous + 1 ? streak + 1 : 1;
      longestStreak = Math.max(longestStreak, streak);
      previous = day;
    }
    return { days: days.length, longestStreak };
  }

  artistTotals(period = 'week', now = Date.now()) {
    const bounds = periodBounds(period, now), totals = new Map();
    for (const record of this.records) {
      if (!inPeriod(record, bounds, now)) continue;
      const artist = this.stats.trackMetadata[record.trackId]?.artist?.trim() || '未知歌手';
      const key = normalizedName(artist), seconds = Math.max(0, finite(record.durationPlayed));
      const group = totals.get(key) || { seconds: 0, variants: new Map() };
      group.seconds += seconds;
      group.variants.set(artist, (group.variants.get(artist) || 0) + seconds);
      totals.set(key, group);
    }
    return [...totals.values()].filter(group => group.seconds > 0).map(({ seconds, variants }) => ({
      artist: [...variants].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], seconds,
    }))
      .sort((a, b) => b.seconds - a.seconds || a.artist.localeCompare(b.artist));
  }

  // Daily cloud totals have no hour/artist detail and cannot populate these views.
  hourWeekdayMatrix(period = 'week', now = Date.now()) {
    const bounds = periodBounds(period, now), matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const record of this.records) {
      if (!inPeriod(record, bounds, now)) continue;
      let cursor = record.timestamp, remaining = Math.max(0, finite(record.durationPlayed));
      const firstDay = dayNumber(calendarDay(cursor));
      const weekday = (dayDate(recordDay(record)).getDay() + 6) % 7;
      while (remaining > 0) {
        const date = new Date(cursor), next = new Date(cursor);
        next.setHours(next.getHours() + 1, 0, 0, 0);
        const seconds = Math.min(remaining, (+next - cursor) / 1000);
        const row = (weekday + dayNumber(calendarDay(cursor)) - firstDay) % 7;
        matrix[row][date.getHours()] += seconds;
        remaining -= seconds;
        cursor += seconds * 1000;
      }
    }
    return matrix;
  }

}

// Upload absolute device totals: retrying/backfilling cannot double count on the server.
// A completion during an in-flight request queues another snapshot instead of being lost.
// Both uploaders share a conservative rolling budget, leaving room for other account
// routes. A rejected batch stays pending until a later dashboard/event timer retries.
const budgets = new WeakMap();
function statsRequest(client, now, ...args) {
  let budget = budgets.get(client);
  if (!budget) budgets.set(client, budget = { times: [], until: 0 });
  const time = now();
  budget.times = budget.times.filter(t => time - t <= 60000);
  if (time < budget.until || budget.times.length >= 8) return Promise.reject(Object.assign(new Error('Listening sync request budget; retry later'), { status: 429 }));
  if (globalThis.navigator?.onLine === false) return Promise.reject(new Error('Offline'));
  budget.times.push(time);
  return client.request(...args).catch(error => {
    if (error.status === 429) budget.until = now() + Math.max(60000, error.retryAfter || 0);
    throw error;
  });
}

export function createCompletedPlayUploader({ stats, client, listTracks, onUploaded = () => {}, now = Date.now }) {
  let running, queued = false;
  const sent = new Map();
  const active = () => client.user?.isActivated && (!client.user.id || client.user.id === stats.userId);
  return function upload() {
    if (!active()) return Promise.resolve();
    queued = true;
    if (running) return running;
    running = (async () => {
      try {
        while (queued) {
          queued = false;
          await stats.ready();
          for (const t of await listTracks().catch(() => [])) {
            stats.rememberTrack({ trackId: t.id, title: t.title, artist: t.artist, cover: t.coverUrl || t.cover, sourceId: t.sourceId, hash: t.hash });
          }
          await stats.flush();
          const plays = stats.completedUploads().filter(row => sent.get(songKey(row)) !== JSON.stringify(row));
          for (let i = 0; i < plays.length; i += 100) {
            if (!active()) return;
            const batch = plays.slice(i, i + 100);
            await statsRequest(client, now, '/account/plays', { deviceId: stats.stats.deviceId, plays: batch });
            batch.forEach(row => sent.set(songKey(row), JSON.stringify(row)));
          }
          if (plays.length) onUploaded();
        }
      } finally { running = null; }
    })();
    return running;
  };
}

// Cloud responses exclude this device for time AND completions. Local counters remain
// authoritative and are never replaced by cloud totals (including during playback).
// Signatures only acknowledge successful snapshots; restarting safely backfills all records.
export function createListeningSync({ stats, client, listTracks, uploadPlays = async () => {}, now = Date.now,
  shouldSync = () => !globalThis.document?.hidden }) {
  let running, timer, stopped = false, queued = false;
  const sent = new Map();
  const active = () => !stopped && client.user?.isActivated && client.user.id === stats.userId;
  const sync = ({ changed = false } = {}) => {
    if (!active()) return Promise.resolve();
    clearTimeout(timer);
    timer = null;
    if (running) { queued ||= changed; return running; }
    queued = true;
    running = (async () => {
      try {
        while (queued && active()) {
          queued = false;
          await stats.ready();
          for (const t of await listTracks().catch(() => [])) stats.rememberTrack({ ...t, trackId: t.id, cover: t.coverUrl || t.cover });
          await stats.flush();
          if (!active()) return;
          const records = stats.records.flatMap(record => {
            const meta = stats.stats.trackMetadata[record.trackId];
            if (!meta?.title || meta.title.length > 200 || (meta.artist || '').length > 200) return [];
            return [{ id: String(record.id), key: stats.trackKey(record.trackId), day: recordDay(record),
              seconds: record.durationPlayed, completed: record.completed || 0, title: meta.title, artist: meta.artist || '', cover: meta.cover || '' }];
          }).filter(row => sent.get(`r:${row.id}`) !== JSON.stringify(row));
          const co = Object.entries(stats.stats.coListeningTime).map(([friendId, seconds]) => ({ friendId, seconds }))
            .filter(row => sent.get(`f:${row.friendId}`) !== JSON.stringify(row));
          for (let i = 0; i < Math.max(records.length, co.length); i += 200) {
            if (!active()) return;
            const batch = records.slice(i, i + 200), friends = co.slice(i, i + 200);
            await statsRequest(client, now, '/account/listening', { deviceId: stats.stats.deviceId, records: batch, coListening: friends }, 'PUT');
            batch.forEach(row => sent.set(`r:${row.id}`, JSON.stringify(row)));
            friends.forEach(row => sent.set(`f:${row.friendId}`, JSON.stringify(row)));
          }
          if (!active()) return;
          await uploadPlays();
          if (!active()) return;
          const data = await statsRequest(client, now, `/account/listening?deviceId=${encodeURIComponent(stats.stats.deviceId)}`);
          if (active()) stats.mergeCloud(data);
        }
      } catch (error) {
        throw error;
      } finally { running = null; }
    })();
    return running;
  };
  // Bounded debounce also works during continuous playback. Failed snapshots retry
  // on the next change, online/foreground event or the dashboard's minute timer.
  const schedule = () => {
    if (!active() || !shouldSync() || timer || running) return;
    // Share the account service's 15 requests/minute budget with play uploads.
    timer = setTimeout(() => { timer = null; if (shouldSync()) sync().catch(() => {}); }, 60000);
    timer.unref?.();
  };
  const unsubscribe = stats.subscribe(schedule);
  return { sync, stop() { stopped = true; clearTimeout(timer); unsubscribe(); } };
}
