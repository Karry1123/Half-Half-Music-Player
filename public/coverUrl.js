// Restricted hosts must go through the authenticated backend in mainland China.
export const PROXIED_COVER = /^https:\/\/([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|googleusercontent\.com|billboard\.com)\//i;
let proxy = null;
export function setCoverProxy(fn) { proxy = typeof fn === 'function' ? fn : null; }
export function coverSrc(url) {
  if (typeof url !== 'string' || !url) return url;
  const normalized = url.replace(/^http:\/\/([^/]+\.(?:ytimg\.com|hdslb\.com))\//i, 'https://$1/');
  return proxy && PROXIED_COVER.test(normalized) ? proxy(normalized) : normalized;
}
export const COVER_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#282b35"/><path d="M43 69V31l32-7v38M43 39l32-7" fill="none" stroke="#aab0bf" stroke-width="6" stroke-linejoin="round"/><ellipse cx="33" cy="70" rx="13" ry="9" fill="#aab0bf"/><ellipse cx="65" cy="63" rx="13" ry="9" fill="#aab0bf"/></svg>');

// Keep blocked hosts proxied at every step, including alternate YouTube sizes.
export function coverCandidates(item) {
  const track = typeof item === 'string' ? { cover: item } : item || {};
  const urls = [track.cover, track.coverUrl, track.thumbnail].filter(x => typeof x === 'string' && x);
  const source = String(track.sourceId || track.id || '');
  const id = /^(?:youtube|ytmusic):([^:]+)$/.exec(source)?.[1]
    || /[?&]v=([^&#]+)/.exec(track.pageUrl || '')?.[1]
    || /youtu\.be\/([^/?#]+)/.exec(track.pageUrl || '')?.[1]
    || /ytimg\.com\/vi(?:_webp)?\/([^/]+)/.exec(urls.join(' '))?.[1];
  if (id) for (const size of ['hqdefault', 'mqdefault', 'default']) urls.push(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/${size}.jpg`);
  return [...new Set(urls.map(coverSrc))];
}
export function coverError(event, item) {
  const img = event.currentTarget;
  const candidates = [...coverCandidates(item), COVER_PLACEHOLDER];
  const current = img.getAttribute('src');
  if (current === COVER_PLACEHOLDER) { img.style.visibility = 'hidden'; return; }
  const index = candidates.indexOf(current);
  img.src = candidates[index + 1] || COVER_PLACEHOLDER;
}
export async function fetchCover(cover) {
  if (cover instanceof Blob) return valid(cover) ? cover : null;
  for (const url of coverCandidates(cover)) {
    if (!/^(https?:|data:|blob:|\/)/.test(url)) continue;
    try {
      const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000) });
      if (r.ok) { const blob = await r.blob(); if (valid(blob)) return blob; }
    } catch {}
  }
  return null;
}
function valid(blob) { return blob?.size > 0 && blob.type.startsWith('image/') && blob.size <= 5 * 1024 * 1024; }
