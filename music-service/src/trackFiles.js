// 账号云端音频：本机导入的歌（没有平台音源 ID）上传到账号数据库，其他设备按指纹 hash 直接下载。
//   - 文件按 1 MiB 分块存进 track_file_chunks（PostgreSQL BYTEA / SQLite BLOB），上传、下载都逐块进行，
//     256 MB 的小容器也不会把整首歌读进内存。
//   - 每个账号有配额（ACCOUNT_FILE_QUOTA_MB，默认 1024）和单文件上限（ACCOUNT_FILE_MAX_MB，默认 60）。
//   - 歌单保存后，不再被任何歌单引用且上传超过一天的文件会被清掉（prune），避免删掉的歌一直占空间。
// 不在顶层 import express：根目录的 CI 只装前端依赖，而 tests/accountSignaling.test.mjs 会经 accounts.js 加载本文件
import { once } from 'node:events';

export const CHUNK_SIZE = 1024 * 1024;
const HASH = /^[0-9a-z]{1,16}-[0-9a-f]{16}$/; // libraryStorageWeb.fingerprint 的格式：<size base36>-<64 位十六进制>
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

export const FILE_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS track_files(user_id TEXT NOT NULL REFERENCES users(id), hash TEXT NOT NULL, size BIGINT NOT NULL, mime TEXT NOT NULL, file_name TEXT NOT NULL, chunks INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, PRIMARY KEY(user_id, hash))',
  'CREATE TABLE IF NOT EXISTS track_file_chunks(user_id TEXT NOT NULL, hash TEXT NOT NULL, seq INTEGER NOT NULL, data BYTEA NOT NULL, PRIMARY KEY(user_id, hash, seq))',
];

export class TrackFiles {
  /** @param {import('./accounts.js').Driver} db */
  constructor(db, { quotaBytes = mb(process.env.ACCOUNT_FILE_QUOTA_MB, 1024), maxFileBytes = mb(process.env.ACCOUNT_FILE_MAX_MB, 60) } = {}) {
    this.db = db;
    this.quotaBytes = quotaBytes;
    this.maxFileBytes = maxFileBytes;
  }

  get limits() { return { quota: this.quotaBytes, maxFile: this.maxFileBytes, chunkSize: CHUNK_SIZE }; }

  async used(userId) {
    const [row] = await this.db.all('SELECT COALESCE(SUM(size),0) AS used FROM track_files WHERE user_id=$1 AND complete=1', [userId]);
    return Number(row?.used || 0);
  }

  /** 这些指纹里哪些已经有完整的云端文件 */
  async check(userId, hashes) {
    if (!Array.isArray(hashes) || hashes.length > 500) fail(400, 'INPUT', '一次最多查询 500 个指纹');
    const wanted = new Set(hashes.filter(h => typeof h === 'string' && HASH.test(h)));
    const rows = await this.db.all('SELECT hash FROM track_files WHERE user_id=$1 AND complete=1', [userId]);
    return { present: rows.map(r => r.hash).filter(h => wanted.has(h)), used: await this.used(userId), ...this.limits };
  }

  /** 开始上传：登记文件、清掉上次没传完的分块。已有完整文件时直接返回 complete */
  async begin(userId, hash, { size, mime, fileName }) {
    if (!HASH.test(String(hash))) fail(400, 'INPUT', '无效的文件指纹');
    if (!Number.isSafeInteger(size) || size <= 0) fail(400, 'INPUT', '无效的文件大小');
    if (size > this.maxFileBytes) fail(413, 'TOO_LARGE', `单个文件不能超过 ${Math.round(this.maxFileBytes / 1048576)} MB`);
    const type = /^(audio|video)\/[\w.+-]{1,60}$/i.test(String(mime)) ? String(mime).toLowerCase() : 'audio/mp4';
    const name = String(fileName || '').replace(/[\r\n"\\/]/g, ' ').trim().slice(0, 200) || `${hash}.m4a`;
    return this.db.tx(async db => {
      const [existing] = await db.all('SELECT complete, size FROM track_files WHERE user_id=$1 AND hash=$2', [userId, hash]);
      if (existing && Number(existing.complete) === 1) return { complete: true, chunkSize: CHUNK_SIZE };
      const [row] = await db.all('SELECT COALESCE(SUM(size),0) AS used FROM track_files WHERE user_id=$1 AND complete=1', [userId]);
      if (Number(row?.used || 0) + size > this.quotaBytes) fail(413, 'QUOTA', `云端空间不足（上限 ${Math.round(this.quotaBytes / 1048576)} MB），请先删除一些歌`);
      const chunks = Math.ceil(size / CHUNK_SIZE);
      await db.run('DELETE FROM track_file_chunks WHERE user_id=$1 AND hash=$2', [userId, hash]);
      await db.run('DELETE FROM track_files WHERE user_id=$1 AND hash=$2', [userId, hash]);
      await db.run('INSERT INTO track_files(user_id,hash,size,mime,file_name,chunks,complete,created_at) VALUES($1,$2,$3,$4,$5,$6,0,$7)', [userId, hash, size, type, name, chunks, Date.now()]);
      return { complete: false, chunkSize: CHUNK_SIZE, chunks };
    });
  }

  async putChunk(userId, hash, seq, data) {
    const file = await this.#pending(userId, hash);
    if (!Number.isInteger(seq) || seq < 0 || seq >= file.chunks) fail(400, 'INPUT', '分块序号超出范围');
    if (!Buffer.isBuffer(data) || !data.length || data.length > CHUNK_SIZE) fail(400, 'INPUT', '分块内容无效');
    const expected = seq === file.chunks - 1 ? Number(file.size) - seq * CHUNK_SIZE : CHUNK_SIZE;
    if (data.length !== expected) fail(400, 'INPUT', `第 ${seq} 块大小应为 ${expected} 字节`);
    await this.db.run('INSERT INTO track_file_chunks(user_id,hash,seq,data) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,hash,seq) DO UPDATE SET data=excluded.data', [userId, hash, seq, data]);
    return { ok: true };
  }

  async complete(userId, hash) {
    const file = await this.#pending(userId, hash);
    const [row] = await this.db.all('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS bytes FROM track_file_chunks WHERE user_id=$1 AND hash=$2', [userId, hash]);
    if (Number(row.n) !== file.chunks || Number(row.bytes) !== Number(file.size)) fail(400, 'INCOMPLETE', `还有分块没有上传（${row.n}/${file.chunks}）`);
    await this.db.run('UPDATE track_files SET complete=1 WHERE user_id=$1 AND hash=$2', [userId, hash]);
    return { ok: true, size: Number(file.size) };
  }

  async #pending(userId, hash) {
    if (!HASH.test(String(hash))) fail(400, 'INPUT', '无效的文件指纹');
    const [file] = await this.db.all('SELECT size, chunks, complete FROM track_files WHERE user_id=$1 AND hash=$2', [userId, hash]);
    if (!file) fail(404, 'NOT_FOUND', '请先开始上传');
    if (Number(file.complete) === 1) fail(409, 'EXISTS', '这个文件已经上传完成');
    return file;
  }

  async info(userId, hash) {
    if (!HASH.test(String(hash))) fail(400, 'INPUT', '无效的文件指纹');
    const [file] = await this.db.all('SELECT size, mime, file_name AS "fileName", chunks FROM track_files WHERE user_id=$1 AND hash=$2 AND complete=1', [userId, hash]);
    if (!file) fail(404, 'NOT_FOUND', '云端没有这首歌的文件，请在原设备重新导入');
    return { ...file, size: Number(file.size) };
  }

  /** 逐块写到响应流 */
  async stream(userId, hash, res) {
    const file = await this.info(userId, hash);
    res.set({ 'Content-Type': file.mime, 'Content-Length': String(file.size), 'Cache-Control': 'private, max-age=0', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}` });
    for (let seq = 0; seq < file.chunks; seq++) {
      const [row] = await this.db.all('SELECT data FROM track_file_chunks WHERE user_id=$1 AND hash=$2 AND seq=$3', [userId, hash, seq]);
      if (!row) { res.destroy(new Error(`分块 ${seq} 丢失`)); return; }
      if (res.destroyed) return;
      if (!res.write(Buffer.from(row.data))) await once(res, 'drain');
    }
    res.end();
  }

  async remove(userId, hash) {
    if (!HASH.test(String(hash))) fail(400, 'INPUT', '无效的文件指纹');
    await this.db.tx(async db => {
      await db.run('DELETE FROM track_file_chunks WHERE user_id=$1 AND hash=$2', [userId, hash]);
      await db.run('DELETE FROM track_files WHERE user_id=$1 AND hash=$2', [userId, hash]);
    });
    return { ok: true };
  }

  /** 歌单保存后：删掉不再被任何歌单引用、且上传超过 graceMs 的文件（刚导入还没同步进歌单的先留着） */
  async prune(userId, playlists, { graceMs = 86400000, now = Date.now() } = {}) {
    const referenced = new Set();
    for (const p of playlists || []) if (!p.deleted) for (const t of p.tracks || []) if (t.hash) referenced.add(t.hash);
    const rows = await this.db.all('SELECT hash FROM track_files WHERE user_id=$1 AND created_at<$2', [userId, now - graceMs]);
    const stale = rows.map(r => r.hash).filter(h => !referenced.has(h));
    for (const hash of stale) await this.remove(userId, hash);
    return stale.length;
  }
}

function mb(value, fallback) {
  const n = Number(value);
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallback) * 1048576);
}

/**
 * 路由都挂在账号守卫后面（req.account 已是激活用户）。express 模块由调用方传入（见文件头的说明）。
 * 分块上传走自己的限流：一首歌十几个请求，账号接口每分钟 15 次的限额不够用。
 */
export function mountTrackFiles(app, guard, files, { express, limiter = (_req, _res, next) => next() }) {
  if (!express?.raw) throw new Error('mountTrackFiles 需要传入 express 模块（分块上传用 express.raw）');
  const route = fn => async (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)); }
    catch (e) {
      if (!e.status) console.error('Track file error:', e.message);
      res.status(e.status || 500).json({ error: e.status ? e.message : '云端文件服务错误', code: e.code || 'INTERNAL' });
    }
  };
  const uid = req => req.account.id;
  app.post('/account/files/check', guard, limiter, route(req => files.check(uid(req), req.body?.hashes)));
  app.post('/account/files/:hash', guard, limiter, route(req => files.begin(uid(req), req.params.hash, { size: Number(req.body?.size), mime: req.body?.mime, fileName: req.body?.fileName })));
  app.put('/account/files/:hash/:seq', guard, limiter, express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 }), route(req => files.putChunk(uid(req), req.params.hash, Number(req.params.seq), req.body)));
  app.post('/account/files/:hash/complete', guard, limiter, route(req => files.complete(uid(req), req.params.hash)));
  app.get('/account/files/:hash', guard, limiter, async (req, res) => {
    try { await files.stream(uid(req), req.params.hash, res); }
    catch (e) {
      if (res.headersSent) return res.destroy(e);
      if (!e.status) console.error('Track file error:', e.message);
      res.status(e.status || 500).json({ error: e.status ? e.message : '云端文件服务错误', code: e.code || 'INTERNAL' });
    }
  });
  app.delete('/account/files/:hash', guard, limiter, route(req => files.remove(uid(req), req.params.hash)));
}
