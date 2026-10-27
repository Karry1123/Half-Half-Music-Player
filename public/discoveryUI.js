import React, { useEffect, useState } from 'react';
import htm from 'htm';
import { Music2, Flame, X } from 'lucide-react';
import { coverSrc, coverError } from './coverUrl.js';
const html = htm.bind(React.createElement);
export function DiscoverSections({ client, fallback = [], onPick }) {
  const [tracks, setTracks] = useState(fallback), [charts, setCharts] = useState([]), [chart, setChart] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let request = 0;
    const refresh = () => {
      const id = ++request;
      client.request('/discover/trending').then(data => { if (alive && id === request && data.tracks?.length) setTracks(data.tracks); }).catch(() => {});
    };
    refresh();
    globalThis.addEventListener?.('hh:plays-synced', refresh);
    client.request('/discover/charts').then(data => { if (alive) setCharts(data.charts || []); }).catch(() => {});
    return () => { alive = false; globalThis.removeEventListener?.('hh:plays-synced', refresh); };
  }, [client]);
  const open = async id => { try { setError(''); setChart(await client.request(`/discover/charts/${encodeURIComponent(id)}`)); } catch { setError('榜单暂时无法打开，请稍后重试'); } };
  const cover = (t, i) => html`<div className="relative grid aspect-square place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-host/30 to-guest/20">${t.cover ? html`<img onError=${e => coverError(e, t)} referrerPolicy="no-referrer" src=${coverSrc(t.cover)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />` : html`<${Music2} size=${24} />`}${i !== undefined && html`<span className="trending-badge">${trendingBadge(t, i)}</span>`}</div>`;
  return html`<div className="space-y-8">
    <section aria-label="大家都在听"><h3 className="mb-3 flex items-center gap-2 text-sm text-sand-400"><${Flame} size=${16} />大家都在听</h3><div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3 touch-pan-x">${tracks.slice(0, 10).map((t, i) => html`<button key=${t.key || t.title} className="trending-card glass shrink-0 snap-start rounded-2xl p-2 text-left" onClick=${() => onPick(`${t.title} ${t.artist}`)}>${cover(t, i)}<p className="mt-2 truncate text-sm" title=${t.title}>${t.title}</p><p className="truncate text-xs text-sand-400" title=${t.artist}>${t.artist}</p></button>`)}</div></section>
    <section aria-label="全球权威榜单"><h3 className="mb-3 font-semibold">全球权威榜单</h3><div className="grid grid-cols-3 gap-2">${charts.map(c => html`<button key=${c.id} className="glass min-w-0 rounded-2xl p-2 text-left" onClick=${() => open(c.id)}>${cover(c)}<p className="mt-2 line-clamp-2 text-xs leading-snug">${c.title}</p><p className="truncate text-[10px] text-sand-400">${c.source ? c.source + ' · ' : ''}${c.stale ? '等待更新' : '每日更新'}</p></button>`)}</div>${error && html`<p role="alert">${error}</p>`}</section>
    ${chart && html`<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur" onClick=${e => e.target === e.currentTarget && setChart(null)}><section role="dialog" aria-modal="true" aria-label=${chart.title} className="max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-ink-900 p-5"><header className="mb-4 flex justify-between"><h2>${chart.title}${chart.stale ? ' · 离线精选' : ''}</h2><button aria-label="关闭" onClick=${() => setChart(null)}><${X} size=${20} /></button></header>${chart.tracks.map((t, i) => html`<button key=${i} className="flex w-full items-center gap-3 border-b border-white/5 py-3 text-left" onClick=${() => { setChart(null); onPick(`${t.title} ${t.artist}`); }}><span className="w-7 shrink-0 whitespace-nowrap text-right tabular-nums text-host">${i + 1}</span>${t.cover && html`<img onError=${e => coverError(e, t)} referrerPolicy="no-referrer" src=${coverSrc(t.cover)} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-lg object-cover" />`}<span className="min-w-0 flex-1"><span className="block truncate">${t.title}</span><span className="block truncate text-xs text-sand-400">${t.artist}</span></span></button>`)}</section></div>`}
  </div>`;
}
/** 热度标签只表达名次，不显示具体播放次数；没有真实播放数据时显示「推荐」 */
export function trendingBadge(track, rank = 0) {
  const count = Number(track.completed);
  if (!(Number.isFinite(count) && count > 0)) return '推荐';
  return rank === 0 ? '最热' : rank < 3 ? '热门' : '热听';
}
export function sortPlaylistTracks(items, sort = 'default', count = () => 0) {
  const result = [...items];
  if (sort === 'count') result.sort((a, b) => count(b) - count(a));
  if (sort === 'name') result.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
  if (sort === 'duration') result.sort((a, b) => (a.duration || 0) - (b.duration || 0));
  return result;
}
