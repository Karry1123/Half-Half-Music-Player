import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { isTrendingSong, validatePlays } from './lib/discover.js';
const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const publicUser = u => ({ id: u.id, username: u.username, shortId: u.short_id, isActivated: !!Number(u.activated) });
const normalizeNickname = name => name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const SHORT_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newShortId = () => [...randomBytes(7)].map(byte => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]).join('');
const uniqueViolation = e => e.code === '23505' || /UNIQUE/i.test(e.message);

// One schema for both engines. Millisecond timestamps need BIGINT on PostgreSQL.
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, salt TEXT NOT NULL, activated INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS play_counts(user_id TEXT NOT NULL REFERENCES users(id), song_key TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, cover TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL, PRIMARY KEY(user_id,song_key))',
  'CREATE TABLE IF NOT EXISTS play_devices(user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT NOT NULL, song_key TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,device_id,song_key))',
  'CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS invites(code_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL, used_by TEXT REFERENCES users(id), used_at BIGINT)',
  "CREATE TABLE IF NOT EXISTS libraries(user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '[]', updated_at BIGINT NOT NULL)",
  'CREATE TABLE IF NOT EXISTS peer_tickets(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), room TEXT NOT NULL, expires_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS download_grants(user_id TEXT NOT NULL REFERENCES users(id), track_id TEXT NOT NULL, PRIMARY KEY(user_id, track_id))',
  // Display name shared by every device signed in to the account.
  'CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id), nickname TEXT NOT NULL, updated_at BIGINT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS friendships(requester TEXT NOT NULL REFERENCES users(id), addressee TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('pending','accepted')), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, pair_key TEXT UNIQUE NOT NULL, PRIMARY KEY(requester,addressee), CHECK(requester<>addressee))",
];

/**
 * Database driver: SQL uses $1..$n placeholders (SQLite reads them as ?1..?n).
 * @typedef {{ dialect: string, exec(sql: string): Promise<void>, all(sql: string, params?: any[]): Promise<object[]>,
 *   run(sql: string, params?: any[]): Promise<number>, tx<T>(fn: (db: Driver) => Promise<T>): Promise<T>, close(): Promise<void> }} Driver
 */

/** Wraps a pg Pool / Client or a PGlite instance (anything with query(sql, params) → { rows }). */
export function wrapPostgres(q, tx, close) {
  const db = {
    dialect: 'postgres',
    exec: async sql => { await (q.exec ? q.exec(sql) : q.query(sql)); },
    all: async (sql, params = []) => (await q.query(sql, params)).rows,
    run: async (sql, params = []) => { const r = await q.query(sql, params); return r.rowCount ?? r.affectedRows ?? 0; },
    tx: tx || (fn => fn(db)),
    close: close || (async () => {}),
  };
  return db;
}

/**
 * node-postgres treats sslmode=require as verify-full, which rejects the private CA that managed
 * databases (e.g. Northflank add-ons) use on their internal network. Restore libpq semantics:
 * require / prefer = encrypted, certificate not verified. verify-ca / verify-full keep full checks.
 */
export function pgConnection(url) {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  if (mode !== 'require' && mode !== 'prefer' && mode !== 'no-verify') return { connectionString: url };
  u.searchParams.delete('sslmode');
  return { connectionString: u.href, ssl: { rejectUnauthorized: false } };
}

async function postgres(url) {
  const { default: pg } = await import('pg');
  // Never hand BIGINT columns back as strings.
  const types = { getTypeParser: (oid, format) => (oid === 20 ? Number : pg.types.getTypeParser(oid, format)) };
  const pool = new pg.Pool({ ...pgConnection(url), max: 5, types, connectionTimeoutMillis: 10000 });
  pool.on('error', e => console.error('PostgreSQL connection error:', e.message));
  return wrapPostgres(pool, async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrapPostgres(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }, () => pool.end());
}

async function sqlite(filename) {
  const { DatabaseSync } = await import('node:sqlite');
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const raw = new DatabaseSync(filename);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const prep = sql => raw.prepare(sql.replace(/\$(\d+)/g, '?$1'));
  let queue = Promise.resolve(); // one connection: transactions must not overlap
  const db = {
    dialect: 'sqlite',
    exec: async sql => { raw.exec(sql); },
    all: async (sql, params = []) => prep(sql).all(...params),
    run: async (sql, params = []) => Number(prep(sql).run(...params).changes),
    tx: fn => {
      const next = queue.then(async () => {
        raw.exec('BEGIN IMMEDIATE');
        try { const result = await fn(db); raw.exec('COMMIT'); return result; }
        catch (e) { raw.exec('ROLLBACK'); throw e; }
      });
      queue = next.catch(() => {});
      return next;
    },
    close: async () => raw.close(),
  };
  return db;
}

/** DATABASE_URL (postgres://…) wins; otherwise a SQLite file (ACCOUNT_DB) for local development. */
export async function openDatabase({ url = process.env.DATABASE_URL, file = process.env.ACCOUNT_DB, root = process.cwd() } = {}) {
  if (url) {
    if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL 必须是 postgres:// 或 postgresql:// 连接串');
    return postgres(url);
  }
  return sqlite(file || path.join(root, 'data/accounts.sqlite'));
}

export class Accounts {
  /** @param {Driver} db */
  constructor(db) { this.db = db; }
  static async open(options) {
    const accounts = new Accounts(await openDatabase(options));
    // A freshly started database add-on may not accept connections yet: retry for about a minute.
    for (let attempt = 1; ; attempt++) {
      try { await accounts.migrate(); return accounts; }
      catch (e) {
        if (accounts.db.dialect !== 'postgres' || attempt >= 12) { await accounts.close().catch(() => {}); throw e; }
        console.warn(`账号数据库暂不可用（${e.code || e.message}），5 秒后重试 ${attempt}/11`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  /** In-memory SQLite, for tests. */
  static memory() { return Accounts.open({ url: '', file: ':memory:' }); }
  async migrate() {
    await this.db.tx(async db => {
      for (const sql of SCHEMA) await db.exec(sql);
      // Serialize concurrent deploys before inspecting/altering existing production tables.
      if (db.dialect === 'postgres') await db.exec('LOCK TABLE users, profiles IN ACCESS EXCLUSIVE MODE');
      const columns = async table => db.dialect === 'postgres'
        ? (await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', [table])).map(row => row.name)
        : (await db.all(`PRAGMA table_info(${table})`)).map(row => row.name);
      if (!(await columns('users')).includes('short_id')) await db.exec('ALTER TABLE users ADD COLUMN short_id TEXT');
      if (!(await columns('profiles')).includes('nickname_normalized')) await db.exec('ALTER TABLE profiles ADD COLUMN nickname_normalized TEXT');
      const users = await db.all('SELECT id, short_id FROM users ORDER BY created_at, id');
      const shortIds = new Set(users.map(user => user.short_id).filter(Boolean));
      for (const user of users) if (!user.short_id) {
        let shortId; do { shortId = newShortId(); } while (shortIds.has(shortId));
        shortIds.add(shortId);
        await db.run('UPDATE users SET short_id=$1 WHERE id=$2', [shortId, user.id]);
      }
      const profiles = await db.all('SELECT user_id, nickname, nickname_normalized FROM profiles ORDER BY updated_at, user_id');
      const claimed = new Set(profiles.map(profile => profile.nickname_normalized).filter(Boolean));
      // Reserve legacy names before assigning suffixes so no unrelated name is displaced.
      const reserved = new Set(profiles.map(profile => normalizeNickname(profile.nickname)));
      for (const profile of profiles) if (!profile.nickname_normalized) {
        let nickname = profile.nickname, normalized = normalizeNickname(nickname), suffix = 2;
        if (claimed.has(normalized)) {
          do {
            const ending = ` (${suffix++})`;
            nickname = [...profile.nickname].slice(0, Math.max(1, 16 - ending.length)).join('') + ending;
            normalized = normalizeNickname(nickname);
          } while (claimed.has(normalized) || reserved.has(normalized));
        }
        claimed.add(normalized);
        await db.run('UPDATE profiles SET nickname=$1, nickname_normalized=$2 WHERE user_id=$3', [nickname, normalized, profile.user_id]);
      }
      await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_short_id_unique ON users(short_id)');
      await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS profiles_nickname_normalized_unique ON profiles(nickname_normalized)');
    });
  }
  close() { return this.db.close(); }
  async one(sql, params) { return (await this.db.all(sql, params))[0] || null; }
  async grant(userId, trackId) { await this.db.run('INSERT INTO download_grants VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, trackId]); }
  async owns(userId, trackId) { return !!(await this.one('SELECT 1 AS ok FROM download_grants WHERE user_id=$1 AND track_id=$2', [userId, trackId])); }
  async ownedTracks(userId) { return new Set((await this.db.all('SELECT track_id FROM download_grants WHERE user_id=$1', [userId])).map(r => r.track_id)); }
  async register(username, password) {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.@-]{3,80}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, 'INPUT', '账号需 3–80 位字母/数字；密码需 12–128 位');
    const salt = randomBytes(16).toString('hex');
    const digest = (await scrypt(password, salt, 64)).toString('hex');
    const id = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.run('INSERT INTO users(id,username,password,salt,activated,created_at,short_id) VALUES($1,$2,$3,$4,0,$5,$6)', [id, username, digest, salt, Date.now(), newShortId()]);
        break;
      } catch (e) {
        if (!uniqueViolation(e)) throw e;
        if (await this.one('SELECT id FROM users WHERE username=$1', [username])) fail(409, 'EXISTS', '该账号已注册');
        if (attempt >= 19) throw e;
      }
    }
    return this.issue(id);
  }
  async login(username, password) {
    if (typeof password !== 'string' || password.length > 128) fail(401, 'AUTH', '账号或密码不正确');
    const u = await this.one('SELECT * FROM users WHERE username=$1', [String(username || '').trim().toLowerCase()]);
    const digest = await scrypt(password, u?.salt || 'dummy-login-salt', 64);
    if (!u || !timingSafeEqual(digest, Buffer.from(u.password, 'hex'))) fail(401, 'AUTH', '账号或密码不正确');
    return this.issue(u.id);
  }
  async issue(id) {
    const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 30 * 86400000;
    await this.db.run('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
    await this.db.run('INSERT INTO sessions VALUES($1,$2,$3)', [hash(token), id, expiresAt]);
    return { token, expiresAt, user: publicUser(await this.one('SELECT * FROM users WHERE id=$1', [id])) };
  }
  async user(token, activated = false) {
    const u = await this.one('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2', [hash(String(token || '')), Date.now()]);
    if (!u) fail(401, 'AUTH', '请登录账号');
    if (activated && !Number(u.activated)) fail(403, 'NOT_ACTIVATED', '请先使用邀请码激活账号');
    return publicUser(u);
  }
  async logout(token) { await this.db.run('DELETE FROM sessions WHERE token_hash=$1', [hash(String(token || ''))]); }
  async invite(days = 7) {
    if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'INPUT', '有效期为 1–365 天');
    const code = randomBytes(18).toString('base64url');
    await this.db.run('INSERT INTO invites(code_hash, expires_at) VALUES($1,$2)', [hash(code), Date.now() + days * 86400000]);
    return code;
  }
  async activate(token, code) {
    const u = await this.user(token);
    if (!u.isActivated) {
      await this.db.tx(async db => {
        // Conditional update: two devices racing on one code cannot both win.
        const used = await db.run('UPDATE invites SET used_by=$1, used_at=$2 WHERE code_hash=$3 AND used_by IS NULL AND expires_at>$4', [u.id, Date.now(), hash(String(code || '').trim()), Date.now()]);
        if (!used) fail(400, 'INVITE_INVALID', '邀请码无效、已使用或已过期');
        await db.run('UPDATE users SET activated=1 WHERE id=$1', [u.id]);
      });
    }
    return this.user(token);
  }
  async library(userId) {
    const row = await this.one('SELECT revision, metadata FROM libraries WHERE user_id=$1', [userId]);
    return { revision: row ? Number(row.revision) : 0, playlists: row ? JSON.parse(row.metadata) : [] };
  }
  async recordPlays(userId, body) {
    const rows = validatePlays(body);
    await this.db.tx(async db => {
      for (const row of rows) {
        // Lock the device row before computing the delta, including concurrent PostgreSQL uploads.
        await db.run('INSERT INTO play_devices(user_id,device_id,song_key,completed) VALUES($1,$2,$3,0) ON CONFLICT(user_id,device_id,song_key) DO NOTHING', [userId, body.deviceId, row.key]);
        const [old] = await db.all('SELECT completed FROM play_devices WHERE user_id=$1 AND device_id=$2 AND song_key=$3' + (db.dialect === 'postgres' ? ' FOR UPDATE' : ''), [userId, body.deviceId, row.key]);
        const delta = Math.max(0, row.completed - Number(old.completed));
        if (!delta) continue;
        await db.run('UPDATE play_devices SET completed=$1 WHERE user_id=$2 AND device_id=$3 AND song_key=$4', [row.completed, userId, body.deviceId, row.key]);
        await db.run('INSERT INTO play_counts(user_id,song_key,title,artist,cover,completed,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,song_key) DO UPDATE SET completed=play_counts.completed+excluded.completed,title=excluded.title,artist=excluded.artist,cover=excluded.cover,updated_at=excluded.updated_at', [userId, row.key, row.title, row.artist, row.cover, delta, Date.now()]);
      }
    });
    return { ok: true };
  }
  async trending(now = Date.now()) {
    if (this.trendingCache && now - this.trendingCache.at < 600000) return this.trendingCache.value;
    const rows = await this.db.all('SELECT song_key, title, artist, cover, completed, updated_at FROM play_counts WHERE completed>0 ORDER BY updated_at DESC');
    const songs = new Map();
    for (const row of rows) {
      if (!isTrendingSong(row)) continue;
      const item = songs.get(row.song_key);
      const plays = Math.min(Number(row.completed), 50); // cap each listener so one account cannot dominate the chart
      if (item) item.completed += plays;
      else songs.set(row.song_key, { key: row.song_key, title: row.title, artist: row.artist, cover: row.cover, completed: plays });
    }
    const value = { tracks: [...songs.values()].sort((a, b) => b.completed - a.completed || a.key.localeCompare(b.key)).slice(0, 10), stale: false };
    this.trendingCache = { at: now, value };
    return value;
  }
  async publicPlaylists(userId, friendId) {
    if (!await this.areFriends(userId, friendId)) fail(403, 'NOT_FRIEND', '仅可查看已添加好友的公开歌单');
    const { playlists } = await this.library(friendId);
    return { playlists: playlists.filter(p => !p.deleted && p.isPublic === true).map(p => ({ id: p.id, name: p.name, coverUrl: p.coverUrl || null, tracks: p.tracks.map(t => ({ title: t.title, artist: t.artist, cover: t.cover || '', duration: t.duration, sourceId: t.sourceId })) })) };
  }
  async saveLibrary(userId, revision, playlists) {
    const clean = validatePlaylists(playlists);
    if (!Number.isSafeInteger(revision) || revision < 0) fail(400, 'INPUT', '无效版本号');
    const json = JSON.stringify(clean), now = Date.now();
    // Optimistic concurrency in a single statement: only the writer holding the latest revision succeeds.
    const changed = revision === 0
      ? await this.db.run('INSERT INTO libraries VALUES($1,1,$2,$3) ON CONFLICT(user_id) DO NOTHING', [userId, json, now])
      : await this.db.run('UPDATE libraries SET revision=revision+1, metadata=$1, updated_at=$2 WHERE user_id=$3 AND revision=$4', [json, now, userId, revision]);
    if (!changed) fail(409, 'CONFLICT', '其他设备已修改歌单，请刷新后重试');
    return { revision: revision + 1, playlists: clean };
  }
  async profile(userId) {
    const row = await this.one('SELECT nickname FROM profiles WHERE user_id=$1', [userId]);
    return { nickname: row?.nickname || '' };
  }
  async saveProfile(userId, nickname) {
    const name = typeof nickname === 'string' ? nickname.replace(/\s+/g, ' ').trim() : '';
    if (!name || [...name].length > 16) fail(400, 'INPUT', '昵称需 1–16 个字');
    try {
      await this.db.run('INSERT INTO profiles(user_id,nickname,updated_at,nickname_normalized) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname, updated_at=excluded.updated_at, nickname_normalized=excluded.nickname_normalized', [userId, name, Date.now(), normalizeNickname(name)]);
    } catch (e) {
      if (uniqueViolation(e)) fail(409, 'NICKNAME_TAKEN', '该昵称已被使用，请换一个昵称');
      throw e;
    }
    return { nickname: name };
  }
  async searchUsers(userId, query) {
    const q = String(query || '').trim().slice(0, 80);
    if (!q) return [];
    return this.db.all("SELECT u.id, u.username, u.short_id AS \"shortId\", COALESCE(p.nickname,u.username) AS nickname FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id<>$1 AND u.activated=1 AND (u.id=$2 OR u.short_id=$4 OR LOWER(u.username) LIKE $3 ESCAPE '!' OR p.nickname_normalized LIKE $3 ESCAPE '!') ORDER BY u.id LIMIT 25", [userId, q, '%' + normalizeNickname(q).replace(/[!%_]/g, c => '!' + c) + '%', q.toUpperCase()]);
  }
  async friends(userId) {
    return this.db.all('SELECT f.requester, f.addressee, f.status, f.created_at, f.updated_at, u.id, u.username, u.short_id AS "shortId", COALESCE(p.nickname,u.username) AS nickname FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester=$1 THEN f.addressee ELSE f.requester END LEFT JOIN profiles p ON p.user_id=u.id WHERE f.requester=$1 OR f.addressee=$1 ORDER BY f.updated_at DESC', [userId]);
  }
  async areFriends(a, b) {
    return !!await this.one("SELECT 1 AS ok FROM friendships WHERE pair_key=$1 AND status='accepted'", [[a, b].sort().join(':')]);
  }
  async requestFriend(userId, otherId) {
    if (typeof otherId !== 'string' || otherId === userId) fail(400, 'INPUT', '请选择其他用户');
    const other = await this.one('SELECT id FROM users WHERE id=$1 AND activated=1', [otherId]);
    if (!other) fail(404, 'NOT_FOUND', '用户不存在');
    const now = Date.now();
    const changed = await this.db.run("INSERT INTO friendships VALUES($1,$2,'pending',$3,$3,$4) ON CONFLICT(pair_key) DO NOTHING", [userId, otherId, now, [userId, otherId].sort().join(':')]);
    if (!changed) fail(409, 'FRIEND_EXISTS', '已是好友或已有待处理申请');
    return { ok: true };
  }
  async respondFriend(userId, requester, accept) {
    const changed = accept
      ? await this.db.run("UPDATE friendships SET status='accepted',updated_at=$1 WHERE requester=$2 AND addressee=$3 AND status='pending'", [Date.now(), requester, userId])
      : await this.db.run("DELETE FROM friendships WHERE requester=$1 AND addressee=$2 AND status='pending'", [requester, userId]);
    if (!changed) fail(404, 'NOT_FOUND', '好友申请不存在');
    return { ok: true };
  }
  async removeFriend(userId, otherId) {
    await this.db.run('DELETE FROM friendships WHERE pair_key=$1', [[userId, String(otherId)].sort().join(':')]);
    return { ok: true };
  }
  async ticket(userId, room) {
    if (!/^\d{6}$/.test(room)) fail(400, 'INPUT', '无效房间码');
    await this.db.run('DELETE FROM peer_tickets WHERE expires_at<$1', [Date.now()]);
    const ticket = randomBytes(32).toString('base64url');
    await this.db.run('INSERT INTO peer_tickets VALUES($1,$2,$3,$4)', [hash(ticket), userId, room, Date.now() + 120000]);
    return { ticket };
  }
  async verifyTicket(ticket, room) {
    const row = await this.one('SELECT t.user_id FROM peer_tickets t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.room=$2 AND t.expires_at>$3 AND u.activated=1', [hash(String(ticket || '')), room, Date.now()]);
    if (!row) fail(403, 'AUTH', '房间授权无效或已过期');
    return { ok: true };
  }
}

export function validatePlaylists(value) {
  if (!Array.isArray(value) || value.length > 2000) fail(400, 'INPUT', '歌单数据过多');
  const ids = new Set(); let total = 0;
  const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  if (value.filter((p) => !p?.deleted).length > 200) fail(400, 'INPUT', '最多同步 200 个歌单');
  return value.map(p => {
    if (!p || !p.id || ids.has(p.id) || typeof p.id !== 'string' || p.id.length > 100) fail(400, 'INPUT', '无效或重复歌单');
    ids.add(p.id);
    // Deletion marker: lets other devices remove the playlist instead of re-uploading it.
    if (p.deleted === true) return { id: p.id, deleted: true, updatedAt: time(p.updatedAt) };
    if (!Array.isArray(p.tracks)) fail(400, 'INPUT', '无效或重复歌单');
    total += p.tracks.length;
    if (total > 10000) fail(400, 'INPUT', '曲目总数不能超过 10000');
    return { id: p.id, name: text(p.name, 80) || '未命名歌单', createdAt: time(p.createdAt), updatedAt: time(p.updatedAt), isPublic: p.isPublic === true, coverUrl: /^https:\/\//i.test(text(p.coverUrl, 2000)) ? text(p.coverUrl, 2000) : null, tracks: p.tracks.map(t => {
      if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 200) fail(400, 'INPUT', '无效曲目');
      const pageUrl = text(t.pageUrl, 2000);
      if (pageUrl && !/^https:\/\//.test(pageUrl)) fail(400, 'INPUT', '音源页面必须使用 HTTPS');
      return { id: t.id, title: text(t.title, 200), artist: text(t.artist, 200), cover: /^https:\/\//i.test(text(t.cover, 2000)) ? text(t.cover, 2000) : '', sourceId: text(t.sourceId, 200), pageUrl, hash: text(t.hash, 100), duration: Number.isFinite(t.duration) ? Math.max(0, t.duration) : 0 };
    }) };
  });
}

export function mountAccounts(app, accounts, limiter) {
  const token = req => req.headers.authorization?.replace(/^Bearer /, '') || '';
  const route = fn => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)); }
    catch (e) {
      if (!e.status) console.error('Account service error:', e.message);
      res.status(e.status || 500).json({ error: e.status ? e.message : '账号服务错误', code: e.code || 'INTERNAL' });
    }
  };
  const active = async req => (await accounts.user(token(req), true)).id;
  app.get('/auth/config', (_req, res) => res.json({ required: true }));
  app.post('/auth/register', limiter, route(req => accounts.register(req.body?.username, req.body?.password)));
  app.post('/auth/login', limiter, route(req => accounts.login(req.body?.username, req.body?.password)));
  app.get('/auth/me', route(req => accounts.user(token(req))));
  app.post('/auth/activate', limiter, route(req => accounts.activate(token(req), req.body?.code)));
  app.post('/auth/logout', route(async req => { await accounts.logout(token(req)); return { ok: true }; }));
  app.get('/account/library', route(async req => accounts.library(await active(req))));
  app.post('/account/plays', limiter, route(async req => accounts.recordPlays(await active(req), req.body)));
  app.get('/discover/trending', route(async req => { await active(req); return accounts.trending(); }));
  app.put('/account/library', route(async req => accounts.saveLibrary(await active(req), req.body?.revision, req.body?.playlists)));
  app.get('/account/profile', route(async req => accounts.profile(await active(req))));
  app.put('/account/profile', route(async req => accounts.saveProfile(await active(req), req.body?.nickname)));
  app.get('/account/users', limiter, route(async req => accounts.searchUsers(await active(req), req.query.q)));
  app.get('/account/friends', route(async req => accounts.friends(await active(req))));
  app.get('/account/friends/:id/playlists', route(async req => accounts.publicPlaylists(await active(req), req.params.id)));
  app.post('/account/friends', limiter, route(async req => accounts.requestFriend(await active(req), req.body?.userId)));
  app.post('/account/friends/:id/accept', route(async req => accounts.respondFriend(await active(req), req.params.id, true)));
  app.post('/account/friends/:id/decline', route(async req => accounts.respondFriend(await active(req), req.params.id, false)));
  app.delete('/account/friends/:id', route(async req => accounts.removeFriend(await active(req), req.params.id)));
  app.post('/account/peer-ticket', limiter, route(async req => accounts.ticket(await active(req), String(req.body?.room))));
  app.post('/account/verify-peer', limiter, route(async req => { await active(req); return accounts.verifyTicket(req.body?.ticket, String(req.body?.room)); }));
  return async (req, res, next) => {
    try { req.account = await accounts.user(token(req) || req.query?.token, true); }
    catch (e) {
      if (!e.status) console.error('Account service error:', e.message);
      return res.status(e.status || 503).json({ error: e.status ? e.message : '账号服务暂不可用', code: e.code || 'INTERNAL' });
    }
    next();
  };
}
