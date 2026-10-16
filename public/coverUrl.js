// 封面地址：国内打不开的图床（YouTube / Google / Billboard）改走后端 /api/cover 代理，其余直连。
// dashboard.html 启动时用 setCoverProxy() 注入带令牌的代理地址生成函数。
export const PROXIED_COVER = /^https:\/\/([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|googleusercontent\.com|billboard\.com)\//i;

let proxy = null;
export function setCoverProxy(fn) { proxy = typeof fn === 'function' ? fn : null; }
export function coverSrc(url) {
  if (typeof url !== 'string' || !url) return url;
  return proxy && PROXIED_COVER.test(url) ? proxy(url) : url;
}

// Use the same proxy for durable downloads as for displayed artwork.
export async function fetchCover(cover) {
  let blob = cover instanceof Blob ? cover : null;
  if (!blob && typeof cover === 'string' && /^(https?:|data:|blob:|\/)/.test(cover)) {
    try {
      const r = await fetch(coverSrc(cover), { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000) });
      if (r.ok) blob = await r.blob();
    } catch {}
  }
  return blob?.size > 0 && blob.type.startsWith('image/') && blob.size <= 5 * 1024 * 1024 ? blob : null;
}
