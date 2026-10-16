import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { config } from './config.js';
import { DownloadManager } from './downloads.js';
import { cors, rateLimit, requireToken } from './lib/guard.js';
import { redact, toSourceError } from './lib/http.js';
import { detectFfmpeg, detectYtdlp } from './lib/tools.js';
import { pipeRemote } from './lib/transfer.js';
import { accountInfo } from './providers/bilibili.js';
import { resolveLink, streamSource } from './resolve.js';
import { listLibrary, loadLibrary, cleanTemporaryDownloads } from './library.js';
import { parseTrackId, providers, timeoutFor } from './providers/index.js';
import { makeTrack } from './providers/track.js';
import { aggregateSearch, trackCache } from './search.js';
import { Accounts, mountAccounts } from './accounts.js';
import { ChartsCache, mountCharts } from './lib/charts.js';
import { mountCoverProxy } from './lib/coverProxy.js';
import { createAuthenticatedPeerWebSocket } from '../../server/peerAuth.js';
import { TurnQuotaGuard, databaseQuotaStore, fileQuotaStore, setTurnQuotaGuard } from '../../server/turnQuota.js';

const FORMATS = ['mp3', 'm4a', 'flac', 'best', 'original'];
const QUALITY_RE = /^[\w-]{1,20}$/; // B 站音轨 id（30280）或 YouTube format_id（251 / 140-drc）
const ERROR_STATUS = { BAD_INPUT: 400, AUTH: 401, UNAVAILABLE: 404, TIMEOUT: 504, BLOCKED: 503, PROXY: 502, NOT_INSTALLED: 501 };

await loadLibrary();
const downloads = new DownloadManager();
await downloads.init();

const app = express();
const server = createServer(app);
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render / Vercel 等前面有一层反向代理：限流按真实客户端 IP
app.use(express.json({ limit: '2mb' }));
app.use(cors);
// 账号库：设置了 DATABASE_URL 就用 PostgreSQL（如 Northflank 免费数据库），否则用本地 SQLite 文件（ACCOUNT_DB）
const accounts = process.env.AUTH_MODE === 'legacy' ? null : await Accounts.open({ root: config.root });
if (accounts) console.log(`账号数据库: ${accounts.db.dialect === 'postgres' ? 'PostgreSQL（DATABASE_URL）' : 'SQLite'}`);
const accountGuard = accounts ? mountAccounts(app, accounts, rateLimit({ perMinute: 15, name: 'account' })) : null;
const charts = new ChartsCache({ dataDir: config.dataDir });
// Disk loading and remote refresh run in the background; requests always have a fallback.
void charts.init().catch(e => console.error('[discover]', e.message));
mountCharts(app, accountGuard || ((_req, res) => res.status(401).json({ error: '请先登录账号' })), charts);
server.once('close', () => charts.stop());
let quotaGuard;
let mailer;
try {
  if (process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.ALERT_EMAIL_TO) {
    const { default: nodemailer } = await import('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 10000, socketTimeout: 15000 });
    // 启动时验证一次邮箱登录（不发信），方便在日志里确认告警邮件可用
    mailer.verify().then(() => console.log('[turn-quota] 告警邮箱: SMTP 登录成功')).catch(e => console.error('[turn-quota] 告警邮箱: SMTP 登录失败:', e.message));
  }
} catch (e) { console.error('[turn-quota] SMTP unavailable; alerts will be logged:', e.message); }
try {
  const store = accounts ? await databaseQuotaStore(accounts.db) : fileQuotaStore(process.env.TURN_QUOTA_STATE_FILE || path.join(config.root, 'data', 'turn-quota.json'));
  quotaGuard = await new TurnQuotaGuard({ store, mailer }).init();
  setTurnQuotaGuard(quotaGuard);
  quotaGuard.start();
  server.once('close', () => quotaGuard.stop());
} catch (e) {
  console.error('[turn-quota] Initialization failed; Cloudflare credentials paused:', e.message);
  setTurnQuotaGuard({ enabled: () => false });
}
if (config.signaling) {
  const { ExpressPeerServer } = await import('peer');
  const peerServer = ExpressPeerServer(server, { path: '/', proxied: true, allow_discovery: false,
    createWebSocketServer: options => createAuthenticatedPeerWebSocket(options, { accounts }) });
  peerServer.on('error', e => console.error('[peerjs]', e.message));
  app.use('/peerjs', peerServer);
}
if (accounts) setInterval(() => cleanTemporaryDownloads().catch(e => console.error('Temporary cache cleanup:', e.message)), 60000).unref();
if (!accounts) app.get('/auth/config', (_req, res) => res.json({ required: false }));

// ---------------------------------------------------------------- 保活 / 健康检查（不需要令牌，UptimeRobot 用）
// 刻意保持极轻：不探测 yt-dlp、不读磁盘，几毫秒返回，也不会唤醒任何下载
const startedAt = Date.now();
app.get('/ping', (_req, res) => res.set('Cache-Control', 'no-store').type('text/plain').send('pong'));
app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), ts: Date.now() }));
app.head(['/ping', '/health'], (_req, res) => res.sendStatus(200)); // UptimeRobot 的 HEAD 请求

// ---------------------------------------------------------------- ICE 配置（公网部署且启用信令时）
// 不需要令牌：好友那一端没有令牌，也要拿到 TURN 才能跨境连上。凭证本身是短期的，并且有限流
if (config.signaling) {
  const { iceConfigAsync, describeTurn } = await import('../../server/ice.js');
  // 启动时报告 TURN 状态（不打印凭证）：配置了就先取一次，确认密钥可用
  const turn = describeTurn();
  console.log(`TURN 中继: ${turn.length ? turn.join('、') : '未配置（仅 STUN，跨网络可能连不上）'}`);
  if (turn.length) iceConfigAsync().then(servers => console.log(`TURN 凭证: ${servers.some(s => s.credential) ? '获取成功' : '获取失败，请检查密钥'}`)).catch(e => console.error('TURN 凭证获取失败:', e.message));
  app.get('/ice.json', accountGuard || ((_req, _res, next) => next()), rateLimit({ perMinute: 30, name: 'ice' }), async (_req, res) => res.set('Cache-Control', 'no-store').json(await iceConfigAsync()));
}

// 以下全部需要访问令牌（配置了 API_TOKEN 时）
app.use(['/api', '/files'], accountGuard || requireToken);
app.use(['/api/search', '/api/resolve', '/api/download'], rateLimit());
mountCoverProxy(app);

// ---------------------------------------------------------------- 状态
app.get('/api/health', async (_req, res) => {
  const [ytdlp, ffmpeg] = await Promise.all([detectYtdlp(), detectFfmpeg()]);
  res.json({
    ok: true,
    ytdlp: ytdlp?.version ?? null,
    ffmpeg: !!ffmpeg,
    downloadDir: config.downloadDir,
    proxy: { youtube: config.youtube.proxy ? redact(config.youtube.proxy) : null, bilibili: config.bilibili.proxy ? redact(config.bilibili.proxy) : null },
    bilibiliAccount: await accountInfo(),
    formats: FORMATS,
    providers: await Promise.all(
      providers.map(async (p) => {
        const a = await p.available();
        return { name: p.name, label: p.label, kind: p.kind, timeoutMs: timeoutFor(p), available: a === true, reason: a === true ? null : a };
      }),
    ),
  });
});

// ---------------------------------------------------------------- 搜索
// GET /api/search?q=关键词&versions=original|all&sources=ytmusic,bilibili&limit=10
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: '缺少参数 q' });
  if (q.length > 100) return res.status(400).json({ error: '关键词过长（≤100 字符）' });
  const limit = Math.min(Math.max(Number(req.query.limit) || config.search.perSourceLimit, 1), 20);
  const sources = req.query.sources ? String(req.query.sources) : undefined;
  const versions = req.query.versions === 'all' ? 'all' : 'original';
  res.json(await aggregateSearch(q, { sources, limit, versions }));
});

// ---------------------------------------------------------------- 链接解析
// GET /api/resolve?url=<B 站 / YouTube 链接、BV 号、b23.tv 短链、分享文案>
//   → { platform, track, qualities: [{id, label, codec, bitrate, size, lossless, vip?}], best, account, hint, pages? }
app.get('/api/resolve', async (req, res) => {
  const url = String(req.query.url ?? '').trim();
  if (!url) return res.status(400).json({ error: '缺少参数 url', code: 'BAD_INPUT' });
  try {
    res.json(await resolveLink(url));
  } catch (e) {
    const err = toSourceError(e);
    console.warn(`[resolve] ${url.slice(0, 80)} 失败: ${err.code} ${err.message}`);
    res.status(ERROR_STATUS[err.code] || 502).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------- 在线播放
// GET /api/stream?id=bilibili:BV…&quality=30280  → 音频流（支持 Range，可直接作为 <audio src>）
// 服务端代为请求 CDN（B 站需要 Referer、YouTube 需要代理），浏览器无需任何特殊配置
app.get('/api/stream', async (req, res) => {
  const id = String(req.query.id ?? '');
  const quality = req.query.quality ? String(req.query.quality) : null;
  if (quality && !QUALITY_RE.test(quality)) return res.status(400).json({ error: '无效的 quality', code: 'BAD_INPUT' });
  try {
    try {
      await pipeRemote(req, res, await streamSource(id, quality));
    } catch (e) {
      // 缓存的地址过期（403）：重新解析一次
      if (res.headersSent || toSourceError(e).code !== 'BLOCKED') throw e;
      await pipeRemote(req, res, await streamSource(id, quality, { fresh: true }));
    }
  } catch (e) {
    const err = toSourceError(e);
    if (res.headersSent) return res.destroy();
    res.status(ERROR_STATUS[err.code] || 502).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------- 下载
// POST /api/download
//   { id: "bilibili:BV1HP4y1X7ye" | url: "https://b23.tv/…",
//     format?: "m4a"|"flac"|"mp3"|"best"|"original", quality?: 30251 | "251", meta?: {title, artist} }
app.post('/api/download', async (req, res) => {
  const { url, format = 'mp3', meta } = req.body ?? {};
  let { id } = req.body ?? {};
  const quality = req.body?.quality != null ? String(req.body.quality) : null;
  if (!FORMATS.includes(format)) return res.status(400).json({ error: `format 只支持 ${FORMATS.join(' / ')}` });
  if (quality && !QUALITY_RE.test(quality)) return res.status(400).json({ error: '无效的 quality' });

  // 直接给链接：先解析（同时把元数据写入缓存）
  if (!id && url) {
    try {
      id = (await resolveLink(url)).track.id;
    } catch (e) {
      const err = toSourceError(e);
      return res.status(ERROR_STATUS[err.code] || 502).json({ error: err.message, code: err.code });
    }
  }
  const parsed = parseTrackId(id);
  if (!parsed) return res.status(400).json({ error: '无效的曲目 id，格式为 source:sourceId（或改传 url）' });

  // 优先使用搜索 / 解析时缓存的完整元数据；服务重启后缓存丢失，则退化为调用方提供的 meta
  const track =
    trackCache.get(id) ||
    makeTrack(parsed.provider, {
      sourceId: parsed.sourceId,
      title: String(meta?.title || parsed.sourceId).slice(0, 200),
      artists: meta?.artist ? [String(meta.artist).slice(0, 100)] : [],
    });

  const r = downloads.enqueue(track, { format, quality, cacheTtlMs: accounts ? 3600000 : 0 });
  if (accounts) await accounts.grant(req.account.id, track.id);
  if (r.library) return res.status(200).json({ status: 'exists', file: r.library.file, url: `/files/${encodeURIComponent(r.library.file)}`, entry: r.library });
  res.status(r.existing ? 200 : 202).json({ status: r.job.status, job: r.job, events: '/api/events' });
});

// 账号模式下每个账号只能看到自己发起过的下载
const ownedBy = async (req) => (accounts ? accounts.ownedTracks(req.account.id) : null);
const visible = (owned, trackId) => !owned || owned.has(trackId);
app.get('/api/downloads', async (req, res) => {
  const owned = await ownedBy(req);
  res.json(downloads.list().filter((j) => visible(owned, j.trackId)));
});
app.get('/api/downloads/:id', async (req, res) => {
  const job = downloads.get(req.params.id);
  job && (!accounts || (await accounts.owns(req.account.id, job.trackId))) ? res.json(job) : res.status(404).json({ error: '任务不存在' });
});

// Server-Sent Events：下载进度 / 完成 / 失败实时推送
app.get('/api/events', async (req, res) => {
  let owned = await ownedBy(req);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', downloads.list().filter((j) => visible(owned, j.trackId)));
  const onJob = async (job) => {
    // 新发起的下载在授权之后才会出现：缓存里没有就重新读一次
    if (owned && !owned.has(job.trackId)) owned = await ownedBy(req).catch(() => owned);
    if (visible(owned, job.trackId)) send('job', job);
  };
  downloads.on('job', onJob);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    downloads.off('job', onJob);
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------- 本地曲库
app.get('/api/library', async (req, res) => {
  const owned = await ownedBy(req);
  res.json(listLibrary().filter((t) => visible(owned, t.trackId)));
});
app.use(
  '/files',
  async (req, res, next) => {
    if (!accounts) return next();
    let filename; try { filename = decodeURIComponent(req.path.slice(1)); } catch { return res.sendStatus(400); }
    const entry = listLibrary().find(t => t.file === filename);
    if (!entry || !(await accounts.owns(req.account.id, entry.trackId))) return res.sendStatus(404);
    next();
  },
  express.static(config.downloadDir, { dotfiles: 'deny', index: false, fallthrough: false, acceptRanges: true }),
);

// 调试页面
app.use(express.static(path.join(config.root, 'public')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : '服务器内部错误' });
});

if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.apiToken) {
  console.warn('⚠ 正在监听公网 / 局域网地址但没有设置 API_TOKEN：任何人都能让这台机器替他下载文件。请设置 API_TOKEN');
}

server.listen(config.port, config.host, async () => {
  const [ytdlp, ffmpeg] = await Promise.all([detectYtdlp(), detectFfmpeg()]);
  console.log(`Half&Half music-service: http://${config.host}:${config.port}`);
  if (config.corsOrigins.length) console.log(`  CORS:     ${config.corsOrigins.join(', ')}`);
  if (config.apiToken) console.log('  令牌:     已启用（/api、/files 需要 API_TOKEN）');
  if (config.signaling) console.log('  信令:     /ws + /ice.json');
  console.log(`  下载目录: ${config.downloadDir}`);
  console.log(`  yt-dlp:   ${ytdlp ? `${ytdlp.version} (${ytdlp.cmd})` : '未安装 → YouTube Music / YouTube / B站下载不可用'}`);
  console.log(`  ffmpeg:   ${ffmpeg ? '可用' : '未安装 → yt-dlp 源只保存原始音频流，不转码'}`);
  console.log(`  音源:     ${providers.map((p) => p.name).join(', ')}`);
  console.log(`  YouTube:  ${config.youtube.proxy ? `代理 ${redact(config.youtube.proxy)}` : '直连（国内网络请设置 PROXY_URL）'}`);
  console.log(`  YT Cookie: ${config.youtube.cookieFile && existsSync(config.youtube.cookieFile) ? '已加载' : '未配置（频繁下载可能被要求验证）'}`);
  console.log(`  B 站:     ${config.bilibili.cookieFile || config.bilibili.cookie ? `Cookie ${config.bilibili.cookieFile || 'BILIBILI_COOKIE'}` : '未配置 Cookie（最高 192K）'}`);
  accountInfo(); // 预热 B 站会话，并打印登录 / 大会员状态
});

// Vite 主应用的 WebRTC 信令（/ws）：静态托管没有后端，信令跟音乐服务部署在一起
if (config.signaling) {
  const { attachSignaling } = await import('../../server/signaling.js');
  attachSignaling(server, '/ws', accounts ? (token) => accounts.user(token, true) : null, accounts);
}
