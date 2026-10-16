// 封面地址：国内打不开的图床（YouTube / Google / Billboard）改走后端 /api/cover 代理，其余直连。
// dashboard.html 启动时用 setCoverProxy() 注入带令牌的代理地址生成函数。
export const PROXIED_COVER = /^https:\/\/([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|googleusercontent\.com|billboard\.com)\//i;

let proxy = null;
export function setCoverProxy(fn) { proxy = typeof fn === 'function' ? fn : null; }
export function coverSrc(url) {
  if (typeof url !== 'string' || !url) return url;
  return proxy && PROXIED_COVER.test(url) ? proxy(url) : url;
}
