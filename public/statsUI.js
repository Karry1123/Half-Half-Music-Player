import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
const html = htm.bind(React.createElement);
function CountUp({ value }) {
  const [number, setNumber] = useState(value);
  useEffect(() => {
    if (globalThis.document?.hidden || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setNumber(value); return; }
    let frame, start;
    const step = time => { start ??= time; const progress = Math.min(1, (time - start) / 650); setNumber(Math.round(value * (1 - (1 - progress) ** 3))); if (progress < 1) frame = requestAnimationFrame(step); };
    const visibility = () => { if (document.hidden) { cancelAnimationFrame(frame); setNumber(value); } };
    document.addEventListener('visibilitychange', visibility);
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); };
  }, [value]);
  return html`<span>${number}</span>`;
}

const card = 'min-w-0 space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4';
const note = 'min-w-0 break-words text-xs text-sand-400';
const periods = [['week', '本周'], ['month', '本月'], ['year', '本年'], ['all', '全部']];
const minutes = seconds => Math.floor(seconds / 60).toLocaleString();
const durationLabel = (seconds, compact = false) => {
  const total = Math.floor(seconds / 60);
  if (compact) return total >= 60 ? `${Math.round(total / 60)}小时` : `${total}分`;
  return total >= 60 ? `${Math.floor(total / 60)}小时${total % 60}分` : `${total}分`;
};
const chartTitles = { week: '每日收听', month: '每周收听', year: '每月收听', all: '每年收听' };
// Goals: week/month/year = 7/30/365 hours and 50/200/2000 completions; all is full.
const goals = { week: [7 * 3600, 50], month: [30 * 3600, 200], year: [365 * 3600, 2000] };
// Completed plays are a lifetime total, so the ring fills toward the next milestone instead of a period goal.
const completionMilestone = count => [10, 50, 100, 200, 500, 1000, 2000, 5000].find(n => count < n) || Math.ceil((count + 1) / 5000) * 5000;
function StatRing({ progress, children, label, colour = 'text-host' }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setDrawn(true); return; }
    let second;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setDrawn(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, []);
  return html`<div className=${`relative mx-auto w-full max-w-40 ${colour}`}>
    <svg viewBox="0 0 160 160" className="block w-full" role="img" aria-label=${label}>
      <circle cx="80" cy="80" r="67" fill="none" stroke="currentColor" strokeWidth="8" opacity="0.12" />
      <circle className="stats-ring" cx="80" cy="80" r="67" pathLength="100" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeDasharray="100" transform="rotate(-90 80 80)" style=${{ strokeDashoffset: drawn ? 100 - Math.min(1, Math.max(0, progress)) * 100 : 100, transition: 'stroke-dashoffset 800ms ease-out' }} />
    </svg><div className="absolute inset-0 flex items-center justify-center px-3 text-center text-sm font-bold tabular-nums sm:text-base">${children}</div>
  </div>`;
}

function ListeningChart({ series, period }) {
  const [hover, setHover] = useState(null);
  // The viewBox follows the container's CSS width so labels keep their pixel size on wide screens.
  const [width, setWidth] = useState(340);
  const box = useRef(null);
  useEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setHover(null), [period]);
  // The plot always fits the card; when neighbouring labels would collide they alternate above/below.
  const plotWidth = width;
  const widthOf = compact => Math.max(30, ...series.map(row => durationLabel(row.seconds, compact).length * 9));
  const slot = (plotWidth - 80) / Math.max(1, series.length - 1);
  // Full labels when they fit; otherwise alternate rows, and fall back to whole hours when even that collides.
  const crowded = series.length > 1 && slot < widthOf(false) + 6;
  const compact = crowded && slot * 2 < widthOf(false) + 6;
  const labelWidth = widthOf(compact);
  const max = Math.max(1, ...series.map(row => row.seconds / 60));
  const left = Math.min(labelWidth / 2 + 8, 40), right = plotWidth - left, span = right - left;
  const x = i => left + i * span / Math.max(1, series.length - 1);
  const y = seconds => 112 - seconds / 60 / max * 76;
  const labelBelow = i => {
    if (crowded) return i % 2 === 1;
    const row = series[i];
    return i > 0 && i < series.length - 1 && row.seconds < series[i - 1].seconds && row.seconds < series[i + 1].seconds;
  };
  const selected = hover !== null && series[hover] ? hover : null;
  const select = event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width * plotWidth;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round((position - left) / span * (series.length - 1)))));
  };
  return html`<div ref=${box} className="relative min-w-0"><div className="overflow-hidden">
    <svg viewBox=${`0 0 ${plotWidth} 160`} preserveAspectRatio="xMidYMid meet" className="block w-full text-host" role="img" aria-label=${`${chartTitles[period]}折线图；触摸或悬停查看详情`} onPointerMove=${select} onPointerDown=${select} onPointerLeave=${() => setHover(null)}>
      ${[0, 0.5, 1].map(level => html`<line key=${level} x1=${left} x2=${right} y1=${112 - level * 76} y2=${112 - level * 76} stroke="currentColor" opacity="0.12" />`)}
      <path d=${series.map((row, i) => `${i ? 'L' : 'M'}${x(i)} ${y(row.seconds)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      ${series.map((row, i) => html`<g key=${row.startDay}><circle cx=${x(i)} cy=${y(row.seconds)} r="3" fill="currentColor" /><text x=${x(i)} y=${y(row.seconds) + (labelBelow(i) ? 16 : -10)} textAnchor="middle" fill="currentColor" fontSize="10" className="tabular-nums">${durationLabel(row.seconds, compact)}</text></g>`)}
      ${selected !== null && html`<line key="crosshair-x" x1=${x(selected)} x2=${x(selected)} y1="30" y2="112" stroke="currentColor" opacity="0.5" strokeDasharray="3 3" /><line key="crosshair-y" x1=${left} x2=${right} y1=${y(series[selected].seconds)} y2=${y(series[selected].seconds)} stroke="currentColor" opacity="0.3" strokeDasharray="3 3" /><circle key="selected" cx=${x(selected)} cy=${y(series[selected].seconds)} r="4" fill="currentColor" />`}
      ${series.map((row, i) => html`<text key=${row.startDay} x=${x(i)} y="153" textAnchor="middle" fill="currentColor" opacity="0.65" fontSize="10">${row.label}</text>`)}
    </svg></div>
    ${selected !== null && html`<div role="status" className="pointer-events-none absolute inset-x-0 top-0 mx-auto min-w-0 max-w-full rounded-lg border border-white/10 px-2 py-1 text-center text-xs tabular-nums" style=${{ background: 'var(--color-bg-subtle)', width: 'max-content' }}><p className="min-w-0 break-words">${series[selected].startDay}${series[selected].endDay !== series[selected].startDay ? ` — ${series[selected].endDay}` : ''}</p><p className="min-w-0 break-all text-host">${durationLabel(series[selected].seconds)}</p></div>`}
  </div>`;
}

export function ListeningStatsCards({ stats, tracks = [], me = {}, friends = [], count }) {
  const [period, setPeriod] = useState('week');
  const now = Date.now();
  const seconds = stats?.summary(period, now) || 0;
  const previous = stats?.previousSummary(period, now);
  const series = stats?.periodSeries(period, now, { since: me.createdAt }) || [];
  const matrix = stats?.hourWeekdayMatrix(period, now) || Array.from({ length: 7 }, () => Array(24).fill(0));
  const artists = (stats?.artistTotals(period, now) || []).slice(0, 5);
  const heatMax = Math.max(0, ...matrix.flat());
  const peak = matrix.flat().indexOf(heatMax);
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const coTotals = stats?.coListeningTotals() || {};
  const localCompleted = Object.values(stats?.stats?.completedPlayCount || {}).reduce((sum, value) => sum + value, 0);
  const remoteCompleted = [...new Map((stats?.cloud?.completed || []).map(row => [row.key, row])).values()].reduce((sum, row) => sum + Number(row.completed || 0), 0);
  const completed = localCompleted + remoteCompleted;
  // Tracks no longer in the library still count: fall back to the metadata the stats remembered.
  const known = new Set(tracks.flatMap(track => [track.id, track.localId]));
  const remembered = Object.entries(stats?.stats?.trackMetadata || {}).filter(([id, meta]) => meta?.title && !known.has(id)).map(([id, meta]) => ({ id, title: meta.title, artist: meta.artist, remembered: true }));
  const top = [...tracks.map(track => ({ track, plays: count?.(track) ?? 0 })), ...remembered.map(track => ({ track, plays: stats?.completedCount(track.id) || 0 }))]
    .filter(row => row.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 5);
  const delta = previous == null ? null : Math.floor(seconds / 60) - Math.floor(previous / 60);
  const comparison = delta === null ? (period === 'year' ? '今年至今' : '全部记录') : delta === 0 ? `与${period === 'week' ? '上周' : '上月'}持平` : `较${period === 'week' ? '上周' : '上月'}${delta > 0 ? '增加' : '减少'} ${Math.abs(delta).toLocaleString()} 分钟`;
  // Each play session that produced listening time leaves one record; the ratio is lifetime and local only.
  const started = Math.max(stats?.records?.length || 0, localCompleted);
  const rate = started ? Math.round(localCompleted / started * 100) : 0;
  const avatar = name => html`<span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-host/20 text-xs">${String(name || '听').slice(0, 1)}</span>`;
  return html`<section className="mb-4 min-w-0 space-y-4 rounded-3xl border border-white/10 bg-gradient-to-br from-host/10 via-white/5 to-guest/10 p-3 sm:p-5">
    <style>@media (prefers-reduced-motion: reduce) { .stats-ring { transition: none !important; } }</style>
    <h2 className="min-w-0 truncate font-semibold">收听统计</h2>
    <div className="grid min-w-0 grid-cols-4 gap-1 rounded-full border border-white/10 bg-white/5 p-1" role="group" aria-label="统计周期">${periods.map(([value, label]) => html`<button key=${value} type="button" aria-pressed=${period === value} onClick=${() => setPeriod(value)} className=${`min-w-0 truncate rounded-full px-1 py-2 text-xs ${period === value ? 'bg-host/20 font-semibold text-host' : 'text-sand-400'}`}>${label}</button>`)}</div>
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <article className=${card}><h3 className=${`${note} text-center`}>收听时长</h3><${StatRing} key=${`duration-${period}`} progress=${period === 'all' ? 1 : seconds / goals[period][0]} label="收听时长目标进度">${durationLabel(seconds)}<//><p className="min-w-0 break-words text-center text-xs text-sand-400 tabular-nums">${comparison}</p></article>
      <article className=${card}><h3 className=${`${note} text-center`}>听完的歌</h3><${StatRing} key=${`completed-${period}`} progress=${completed / completionMilestone(completed)} label="听完歌曲里程碑进度" colour="text-guest"><span><${CountUp} value=${completed} /> 次</span><//></article>
    </div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">一起听的里程碑</h3>
      ${Object.entries(coTotals).map(([id, time]) => {
        const friend = friends.find(f => String(f.id || f.userId) === id), name = friend?.nickname || friend?.username || '好友';
        const hours = time / 3600, target = [1, 10, 50, 100, 500].find(n => hours < n) || (Math.floor(hours / 500) + 1) * 500;
        const progress = Math.min(100, hours / target * 100);
        return html`<article key=${id} className="min-w-0 rounded-2xl border border-white/10 p-3"><div className="flex min-w-0 items-center gap-2"><div className="flex shrink-0 -space-x-2">${avatar(me.name || me.username)}${avatar(name)}</div><div className="min-w-0 flex-1"><p className="min-w-0 truncate text-sm">与 ${name} 的音乐旅程</p><p className=${note}>已同行 ${minutes(time)} 分钟 · 下一站 ${target} 小时</p></div></div><div role="progressbar" aria-label=${`与 ${name} 的同听进度`} aria-valuenow=${Math.round(progress)} aria-valuemin="0" aria-valuemax="100" className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-host to-guest" style=${{ width: `${progress}%` }} /></div></article>`;
      })}
      ${!Object.keys(coTotals).length && html`<p className=${note}>邀请好友一起听，让共同的旋律慢慢累积。</p>`}
    </div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">${chartTitles[period]}</h3><${ListeningChart} series=${series} period=${period} />${!seconds && html`<p className=${note}>让喜欢的旋律，点亮今天的曲线。</p>`}</div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">收听热力</h3>
      <div className="grid min-w-0 gap-px" style=${{ gridTemplateColumns: 'minmax(0, 1.5fr) repeat(24, minmax(0, 1fr))' }}>
        ${matrix.map((row, day) => html`<${React.Fragment} key=${day}><span className="min-w-0 truncate text-xs text-sand-400">${weekdays[day]}</span>${row.map((value, hour) => html`<span key=${hour} className="min-w-0 self-center rounded-sm" style=${{ aspectRatio: '1', background: `rgb(var(--color-brand-host-rgb) / ${[0.12, 0.45, 0.65, 0.85, 1][value >= 3600 ? 4 : value >= 1800 ? 3 : value >= 600 ? 2 : value >= 60 ? 1 : 0]})` }} title=${`周${weekdays[day]} ${hour} 时 · ${minutes(value)} 分钟`} />`)}<//>`)}
        <span /><div className="flex min-w-0 justify-between text-xs text-sand-400" style=${{ gridColumn: '2 / -1' }}>${[0, 6, 12, 18, 23].map(hour => html`<span key=${hour} className="min-w-0 truncate">${hour}时</span>`)}</div>
      </div><p className=${note}>${heatMax ? `高峰在 周${weekdays[Math.floor(peak / 24)]} ${peak % 24} 点。` : '还没有收听足迹，下一首就从此刻开始。'}</p>
    </div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">最常听的歌手</h3>${artists.map((row, i) => html`<div key=${row.artist} className="grid min-w-0 items-center gap-2" style=${{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, .65fr)' }}><span className="min-w-0 truncate text-xs" title=${row.artist}>${i + 1}. ${row.artist}</span><span className="h-2 min-w-0 overflow-hidden rounded-full bg-host/10"><span className="block h-full rounded-full bg-host" style=${{ width: `${row.seconds / artists[0].seconds * 100}%`, opacity: 1 - i * 0.13 }} /></span><span className="min-w-0 break-all text-right text-xs tabular-nums">${minutes(row.seconds)}</span></div>`)}${!artists.length && html`<p className=${note}>听一首喜欢的歌，让熟悉的声音留下足迹。</p>`}</div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">最常听的 5 首</h3>${top.map(({ track, plays }, i) => html`<div key=${track.id} className="flex min-w-0 items-center gap-3"><span className="min-w-0 shrink-0 text-sm tabular-nums text-host">${i + 1}</span><div className="min-w-0 flex-1"><p className="min-w-0 truncate text-sm" title=${track.title}>${track.title}</p><p className="min-w-0 truncate text-xs text-sand-400" title=${track.artist}>${track.artist || '未知歌手'} · 已听 ${plays.toLocaleString()} 次</p></div></div>`)}${!top.length && html`<p className=${note}>完整听完一首，留下旋律的足迹。</p>`}</div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">听完率</h3>
      ${started > 0 ? html`<div className="flex min-w-0 items-center gap-3"><div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-host/10" role="meter" aria-label="听完率" aria-valuenow=${rate} aria-valuemin="0" aria-valuemax="100"><div className="h-full rounded-full bg-host" style=${{ width: `${rate}%` }} /></div><span className="shrink-0 text-lg font-bold tabular-nums text-host">${rate}%</span></div><p className=${note}>${localCompleted.toLocaleString()} 次听完 · ${started.toLocaleString()} 次开始播放</p>` : html`<p className=${note}>播放几首歌后，这里会显示完整听完的比例。</p>`}
    </div>
  </section>`;
}
