// 公网部署时的三道门：CORS 白名单、访问令牌、限流。
//
// 本机运行（默认）：三者都不启用，和以前完全一样（只监听 127.0.0.1，CORS 为 *）。
// 部署到 Render 等公网环境时：
//   CORS_ORIGINS=https://you.github.io,https://halfhalf.vercel.app,https://*.vercel.app
//     → 只有这些站点的网页能跨域调用（不在名单里的浏览器请求直接 403）
//   API_TOKEN=一串随机字符
//     → /api/*、/files/* 必须带 Authorization: Bearer <token>（或 ?token=，供 <audio>/EventSource 使用）
//   CORS 只能约束浏览器，curl 之类的工具不受影响，所以公网部署一定要配 API_TOKEN：
//   这个服务会替调用者下载文件、占用带宽和磁盘。
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// ───────────────────────────── CORS

/** "https://*.vercel.app" 这类通配写法 → 正则 */
const originPatterns = config.corsOrigins.map((o) =>
  o === '*' ? /^.*$/ : new RegExp(`^${o.replace(/\/$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'),
);

export function originAllowed(origin) {
  if (!config.corsOrigins.length) return true;
  return originPatterns.some((re) => re.test(origin));
}

export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (!config.corsOrigins.length) res.set('Access-Control-Allow-Origin', '*');
  else if (origin) {
    res.vary('Origin');
    if (!originAllowed(origin)) {
      // 没有 Origin 的请求（UptimeRobot、curl、同源）不受影响；有 Origin 但不在白名单 → 拒绝
      return res.status(403).json({ error: `不允许来自 ${origin} 的跨域请求（CORS_ORIGINS）`, code: 'CORS' });
    }
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // 前端用 fetch 读音频分段 / 文件大小时需要这些响应头
  res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ───────────────────────────── 访问令牌

const expected = config.apiToken ? Buffer.from(config.apiToken) : null;

export function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return typeof req.query.token === 'string' ? req.query.token : '';
}

export function requireToken(req, res, next) {
  if (!expected) return next();
  const got = Buffer.from(tokenOf(req));
  // 长度不同直接拒绝；长度相同用常数时间比较，避免按响应时间逐位猜令牌
  if (got.length === expected.length && timingSafeEqual(got, expected)) return next();
  res.status(401).json({ error: '需要访问令牌：在页面「连接设置 → 音乐服务」里填写 API_TOKEN', code: 'AUTH' });
}

// ───────────────────────────── 限流（每个 IP 固定窗口计数，进程内存即可：单实例部署）

export function rateLimit({ perMinute = config.rateLimitPerMin, name = 'api' } = {}) {
  const hits = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, 60_000).unref();
  return (req, res, next) => {
    if (!perMinute) return next();
    const key = `${name}:${req.ip}`;
    const t = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < t) hits.set(key, (h = { count: 0, reset: t + 60_000 }));
    if (++h.count > perMinute) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ error: '请求太频繁，稍后再试', code: 'RATE_LIMIT' });
    }
    next();
  };
}
