// GET /api/cover?url=… 代取封面图：YouTube / Google / Billboard 的图床在国内打不开，由服务端转发。
// 只允许白名单域名的 https 图片，限制大小与超时，避免被当成通用代理。
export const COVER_HOSTS = /^([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|googleusercontent\.com|billboard\.com)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

export function allowedCoverUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && COVER_HOSTS.test(url.hostname) ? url : null;
  } catch { return null; }
}

export function mountCoverProxy(app, { fetcher = globalThis.fetch } = {}) {
  app.get('/api/cover', async (req, res) => {
    const url = allowedCoverUrl(req.query.url);
    if (!url) return res.status(400).json({ error: '不支持的封面地址', code: 'BAD_INPUT' });
    try {
      const upstream = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'image/*' } });
      const type = upstream.headers.get('content-type') || '';
      const length = Number(upstream.headers.get('content-length') || 0);
      if (!upstream.ok || !type.startsWith('image/') || length > MAX_BYTES) return res.status(502).json({ error: '封面获取失败', code: 'UPSTREAM' });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > MAX_BYTES) return res.status(502).json({ error: '封面过大', code: 'UPSTREAM' });
      res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).send(body);
    } catch {
      if (!res.headersSent) res.status(502).json({ error: '封面获取失败', code: 'UPSTREAM' });
    }
  });
}
