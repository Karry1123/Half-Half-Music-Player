// music-service 客户端。
// 本地：经由 /music-api 代理（仅 Host 本机可用）；部署后：app-config.js 里的 apiBase（如 Render 上的服务）
const stored = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const BASE = (stored('hh.api') || window.HH_CONFIG?.apiBase || '/music-api').replace(/\/+$/, '');
import { accessToken } from '../account.js';

/** <audio> / EventSource 不能带请求头，令牌放在查询参数里 */
const withToken = (url) => (accessToken() ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(accessToken())}` : url);

async function request(path, init = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { ...init.headers, ...(accessToken() && { Authorization: `Bearer ${accessToken()}` }) } });
  } catch {
    throw new Error('无法连接音乐服务');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export const musicApi = {
  health: () => request('/api/health'),

  search: ({ q, sources, versions }) => {
    const params = new URLSearchParams({ q, versions });
    if (sources?.length) params.set('sources', sources.join(','));
    return request(`/api/search?${params}`);
  },

  download: (id, format, meta) =>
    request('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, format, meta }),
    }),

  library: () => request('/api/library'),

  fileUrl: (fileName) => withToken(`${BASE}/files/${encodeURIComponent(fileName)}`),

  /** 下载进度 SSE；返回关闭函数 */
  subscribe({ onSnapshot, onJob, onError }) {
    const es = new EventSource(withToken(`${BASE}/api/events`));
    es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
    es.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
    es.onerror = () => onError?.();
    return () => es.close();
  },
};
