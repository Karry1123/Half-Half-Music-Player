import React, { useEffect, useState } from 'react';
import htm from 'htm';
import { Music2, Flame, X } from 'lucide-react';
const html = htm.bind(React.createElement);
export function DiscoverSections({ client, fallback = [], onPick }) {
  const [tracks, setTracks] = useState(fallback), [charts, setCharts] = useState([]), [chart, setChart] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    client.request('/discover/trending').then(data => { if (alive && data.tracks?.length) setTracks(data.tracks); }).catch(() => {});
    client.request('/discover/charts').then(data => { if (alive) setCharts(data.charts || []); }).catch(() => {});
    return () => { alive = false; };
  }, [client]);
  const open = async id => { try { setError(''); setChart(await client.request(`/discover/charts/${encodeURIComponent(id)}`)); } catch { setError('榜单暂时无法打开，请稍后重试'); } };
  const cover = (t, i) => html`<div class="relative grid aspect-square place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-host/30 to-guest/20">${t.cover ? html`<img src=${t.cover} alt="" loading="lazy" class="absolute inset-0 h-full w-full object-cover" />` : html`<${Music2} size=${30} />`}${i !== undefined && html`<span class="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-1 text-xs text-host">热度 ${t.completed || '推荐'}</span>`}</div>`;
  return html`<div class="space-y-8">
    <section aria-label="大家都在听"><h3 class="mb-3 flex items-center gap-2 text-sm text-sand-400"><${Flame} size=${16} />大家都在听</h3><div class="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3 touch-pan-x">${tracks.slice(0, 10).map((t, i) => html`<button key=${t.key || t.title} class="glass w-40 shrink-0 snap-start rounded-2xl p-3 text-left" onClick=${() => onPick(`${t.title} ${t.artist}`)}>${cover(t, i)}<p class="mt-2 truncate text-sm">${t.title}</p><p class="truncate text-xs text-sand-400">${t.artist}</p></button>`)}</div></section>
    <section aria-label="全球权威榜单"><h3 class="mb-3 font-semibold">全球权威榜单</h3><div class="grid grid-cols-1 gap-3 sm:grid-cols-3">${charts.map(c => html`<button key=${c.id} class="glass rounded-2xl p-4 text-left" onClick=${() => open(c.id)}>${cover(c)}<p class="mt-2 text-sm">${c.title}</p><p class="text-xs text-sand-400">${c.stale ? '离线精选 · 等待更新' : '每日更新'}</p></button>`)}</div>${error && html`<p role="alert">${error}</p>`}</section>
    ${chart && html`<div class="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur" onClick=${e => e.target === e.currentTarget && setChart(null)}><section role="dialog" aria-modal="true" aria-label=${chart.title} class="max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-ink-900 p-5"><header class="mb-4 flex justify-between"><h2>${chart.title}${chart.stale ? ' · 离线精选' : ''}</h2><button aria-label="关闭" onClick=${() => setChart(null)}><${X} size=${20} /></button></header>${chart.tracks.map((t, i) => html`<button key=${i} class="flex w-full items-center gap-3 border-b border-white/5 py-3 text-left" onClick=${() => { setChart(null); onPick(`${t.title} ${t.artist}`); }}><span class="text-host">${i + 1}</span>${t.cover && html`<img src=${t.cover} alt="" class="h-10 w-10 rounded-lg" />`}<span><span class="block">${t.title}</span><span class="text-xs text-sand-400">${t.artist}</span></span></button>`)}</section></div>`}
  </div>`;
}
export function sortPlaylistTracks(items, sort = 'default', count = () => 0) {
  const result = [...items];
  if (sort === 'count') result.sort((a, b) => count(b) - count(a));
  if (sort === 'name') result.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
  if (sort === 'duration') result.sort((a, b) => (a.duration || 0) - (b.duration || 0));
  return result;
}
