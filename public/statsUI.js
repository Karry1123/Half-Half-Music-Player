import React, { useEffect, useState } from 'react';
import htm from 'htm';
const html = htm.bind(React.createElement);
function CountUp({ value }) {
  const [number, setNumber] = useState(value);
  useEffect(() => {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setNumber(value); return; }
    let frame, start;
    const step = time => { start ??= time; const progress = Math.min(1, (time - start) / 650); setNumber(Math.round(value * (1 - (1 - progress) ** 3))); if (progress < 1) frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return html`<span>${number}</span>`;
}
export function ListeningStatsCards({ stats, tracks = [], me = {}, friends = [], count }) {
  const [names, setNames] = useState(friends);
  useEffect(() => { setNames(friends); }, [friends]);
  const top = [...tracks].filter(t => count(t) > 0).sort((a, b) => count(b) - count(a)).slice(0, 5);
  const max = top.length ? count(top[0]) : 1;
  const avatar = name => html`<span class="grid h-10 w-10 place-items-center rounded-full border-2 border-ink-900 bg-gradient-to-br from-host/60 to-guest/60 text-sm">${String(name || '听').slice(0, 1)}</span>`;
  return html`<section class="mb-4 space-y-5 rounded-3xl border border-white/10 bg-gradient-to-br from-host/10 via-white/5 to-guest/10 p-5 backdrop-blur-xl"><h2 class="font-semibold">收听统计</h2>
    <div class="grid grid-cols-3 gap-2">${[['week', '本周'], ['month', '本月'], ['year', '本年']].map(([period, label]) => html`<div key=${period} class="rounded-2xl border border-white/10 bg-white/5 p-3"><p class="text-xs text-sand-400">${label}</p><p class="mt-2 text-3xl font-bold tabular-nums text-host"><${CountUp} value=${Math.floor((stats?.summary(period) || 0) / 60)} /></p><p class="text-xs text-sand-400">分钟</p></div>`)}</div>
    <h3 class="text-sm">一起听的里程碑</h3>
    ${Object.entries(stats?.coListeningTotals() || {}).map(([id, seconds]) => {
      const friend = names.find(f => (f.id || f.userId) === id), name = friend?.nickname || friend?.username || '好友';
      const hours = seconds / 3600, target = [1, 10, 50, 100, 500].find(n => hours < n) || Math.ceil(hours / 500) * 500 + 500;
      return html`<article key=${id} class="rounded-2xl border border-white/10 bg-white/5 p-4"><div class="flex items-center gap-3"><div class="flex -space-x-3">${avatar(me.name || me.username)}${avatar(name)}</div><div class="min-w-0"><p class="truncate text-sm">与 ${name} 的音乐旅程</p><p class="text-xs text-sand-400">已同行 ${Math.floor(seconds / 60)} 分钟 · 下一站 ${target} 小时</p></div></div><div role="progressbar" aria-label=${`与 ${name} 的同听进度`} aria-valuenow=${Math.min(100, Math.round(hours / target * 100))} aria-valuemin="0" aria-valuemax="100" class="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full bg-gradient-to-r from-host to-guest" style=${{ width: `${Math.min(100, hours / target * 100)}%` }} /></div></article>`;
    })}
    ${!Object.keys(stats?.coListeningTotals() || {}).length && html`<p class="text-xs text-sand-400">邀请好友一起听，让共同的旋律慢慢累积。</p>`}
    <h3 class="text-sm">最常听的 5 首</h3>${top.map((t, i) => html`<div key=${t.id} class="flex items-center gap-3"><span class="grid h-10 w-10 shrink-0 place-items-center rounded-full" style=${{ background: `conic-gradient(#f2a65a ${count(t) / max * 360}deg, #ffffff18 0)` }}><span class="grid h-8 w-8 place-items-center rounded-full bg-ink-900 text-xs">${count(t)}</span></span><div class="min-w-0"><p class="truncate text-sm">${i + 1}. ${t.title}</p><p class="text-xs text-sand-400">${t.artist} · 已听 ${count(t)} 次</p></div></div>`)}${!top.length && html`<p class="text-xs text-sand-400">完整听完一首，留下旋律的足迹。</p>`}
  </section>`;
}
