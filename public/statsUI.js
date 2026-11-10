import React, { useEffect, useRef, useState } from 'react';
import htm from 'htm';
import { lapUnits, ringModel, ringRadius, ringStyles, lapColour, ringHue, ringTip, formatCentre, centreFontSize, lapCaption, sweep } from './statsRing.js';
const html = htm.bind(React.createElement);
const card = 'min-w-0 space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4';
const note = 'min-w-0 break-words text-xs text-sand-400';
const periods = [['week', '本周'], ['month', '本月'], ['year', '本年'], ['all', '全部']];
const minutes = seconds => Math.floor(seconds / 60).toLocaleString();
const durationLabel = seconds => {
  const total = Math.floor(seconds / 60);
  return total >= 60 ? `${Math.floor(total / 60)}小时${total % 60}分` : `${total}分`;
};
const heatColours = ['rgb(var(--color-brand-host-rgb) / 0.08)', '#F2C9A0', '#E39A5B', '#C96E2A', '#8A4512'];
const chartTitles = { week: '每日收听', month: '每周收听', year: '每月收听', all: '每年收听' };
const minArc = 0.02;
function StatRing({ value, kind, period, label }) {
  const perLap = lapUnits[period][kind];
  // Interpolate normalized geometry separately: period changes also change the lap scale.
  const target = { value, progress: value / perLap };
  const [rendered, setRendered] = useState(target);
  const previous = useRef(target);
  useEffect(() => {
    const from = previous.current;
    if (from.value === value && from.progress === target.progress) return;
    // The arc is never drawn shorter than 2% of a lap. Below that length it fades instead,
    // so a sweep to or from zero ends smoothly rather than popping at the last frame.
    const floor = Math.min(minArc, Math.max(from.progress, target.progress)) || minArc;
    return sweep(0, 1, 600, fraction => {
      const next = { value: from.value + (value - from.value) * fraction,
        progress: from.progress + (target.progress - from.progress) * fraction, floor };
      previous.current = next;
      setRendered(next);
    });
  }, [value, perLap]);
  const model = ringModel(rendered.progress, 1);
  const leading = model.arcs.at(-1);
  const tip = leading && ringTip(leading);
  // First lap: arc and tip fade together. Later laps: only the new partial arc fades in over the full ring.
  const fade = !model.fraction ? 1 : Math.min(1, model.laps ? model.fraction / minArc : rendered.progress / (rendered.floor || minArc));
  const number = formatCentre(kind, rendered.value);
  const shadowId = `stats-ring-shadow-${kind}`;
  return html`<div className="stats-ring-box">
    <svg viewBox="0 0 160 160" className="stats-ring" role="img" aria-label=${`${label}：${number}，${model.laps} 圈已完成`}>
      <defs><filter id=${shadowId} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB"><feDropShadow dx="0" dy="2" stdDeviation="2" floodColor=${ringHue(kind, 0.35)} /></filter></defs>
      <circle cx="80" cy="80" r=${ringRadius} fill="none" stroke=${ringHue(kind, 0.12)} strokeWidth="20" />
      ${[0, 1, 2].map(slot => { const arc = model.arcs[slot] || { fraction: 0, tint: 0 }; return html`<circle key=${slot} opacity=${!model.arcs[slot] ? 0 : arc === leading ? fade : 1} cx="80" cy="80" r=${ringRadius} pathLength="100" fill="none" stroke=${lapColour(kind, arc.tint)} strokeWidth="20" strokeLinecap=${arc.fraction === 1 ? 'butt' : 'round'} strokeDasharray=${`${arc.fraction * 100} 100`} transform="rotate(-90 80 80)" />`; })}
      <circle className="stats-ring-tip" opacity=${!leading ? 0 : model.laps ? 1 : fade} cx=${tip?.x ?? 80} cy=${tip?.y ?? 14} r="10" fill=${lapColour(kind, leading?.tint)} filter=${`url(#${shadowId})`} />
      <text className="stats-ring-number" x="80" y="79" textAnchor="middle" dominantBaseline="middle" fontSize=${centreFontSize(number)}>${number}</text>
      <text className="stats-ring-caption" x="80" y="99" textAnchor="middle" fontSize="8">${lapCaption(kind, perLap)}</text>
    </svg><span className="stats-ring-badge" hidden=${!model.badge}>${model.badge}</span>
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
  const plotWidth = width;
  const max = Math.max(1, ...series.map(row => row.seconds / 60));
  const left = 24, right = plotWidth - 24, span = right - left;
  const x = i => left + i * span / Math.max(1, series.length - 1);
  const y = seconds => 112 - seconds / 60 / max * 76;
  const peak = series.reduce((best, row, i) => best === null || row.seconds > series[best].seconds ? i : best, null);
  const peakLabel = peak === null ? '' : durationLabel(series[peak].seconds);
  const peakWidth = peakLabel.length * 10;
  const peakAnchor = peak !== null && x(peak) - peakWidth / 2 < 8 ? 'start'
    : peak !== null && x(peak) + peakWidth / 2 > plotWidth - 8 ? 'end' : 'middle';
  const peakX = peak === null ? 0 : Math.max(8, Math.min(plotWidth - 8, x(peak)));
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
      ${series.map((row, i) => html`<circle key=${row.startDay} className="stats-chart-point" cx=${x(i)} cy=${y(row.seconds)} r="3" fill="currentColor" />`)}
      ${peak !== null && html`<text className="stats-chart-peak tabular-nums" x=${peakX} y=${y(series[peak].seconds) - 10} textAnchor=${peakAnchor} fill="currentColor" fontSize="10">${peakLabel}</text>`}
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
  const completed = stats?.completedInPeriod(period, now) || 0;
  // Tracks no longer in the library still count: fall back to the metadata the stats remembered.
  const known = new Set(tracks.flatMap(track => [track.id, track.localId]));
  const remembered = Object.entries(stats?.stats?.trackMetadata || {}).filter(([id, meta]) => meta?.title && !known.has(id)).map(([id, meta]) => ({ id, title: meta.title, artist: meta.artist, remembered: true }));
  const top = [...tracks.map(track => ({ track, plays: count?.(track) ?? 0 })), ...remembered.map(track => ({ track, plays: stats?.completedCount(track.id) || 0 }))]
    .filter(row => row.plays > 0).sort((a, b) => b.plays - a.plays).slice(0, 5);
  const delta = previous == null ? null : Math.floor(seconds / 60) - Math.floor(previous / 60);
  const compare = (delta, unit) => delta === null ? (period === 'year' ? '今年至今' : '全部记录') : delta === 0 ? `与${period === 'week' ? '上周' : '上月'}持平` : `较${period === 'week' ? '上周' : '上月'}${delta > 0 ? '增加' : '减少'} ${Math.abs(delta).toLocaleString()} ${unit}`;
  const comparison = compare(delta, '分钟');
  const previousCompleted = stats?.previousCompleted(period, now);
  const completedComparison = compare(previousCompleted == null ? null : completed - previousCompleted, '次');
  // Each play session that produced listening time leaves one record; the ratio is lifetime and local only.
  const started = Math.max(stats?.records?.length || 0, localCompleted);
  const rate = started ? Math.round(localCompleted / started * 100) : 0;
  const avatar = name => html`<span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-host/20 text-xs">${String(name || '听').slice(0, 1)}</span>`;
  return html`<section className="mb-4 min-w-0 space-y-4 rounded-3xl border border-white/10 bg-gradient-to-br from-host/10 via-white/5 to-guest/10 p-3 sm:p-5">
    <style>${ringStyles}</style>
    <h2 className="min-w-0 truncate font-semibold">收听统计</h2>
    <div className="grid min-w-0 grid-cols-4 gap-1 rounded-full border border-white/10 bg-white/5 p-1" role="group" aria-label="统计周期">${periods.map(([value, label]) => html`<button key=${value} type="button" aria-pressed=${period === value} onClick=${() => setPeriod(value)} className=${`min-w-0 truncate rounded-full px-1 py-2 text-xs ${period === value ? 'bg-host/20 font-semibold text-host' : 'text-sand-400'}`}>${label}</button>`)}</div>
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <article className=${card}><h3 className=${`${note} text-center`}>收听时长</h3><${StatRing} value=${seconds} kind="duration" period=${period} label="收听时长" /><p className="min-w-0 break-words text-center text-xs text-sand-400 tabular-nums">${comparison}</p></article>
      <article className=${card}><h3 className=${`${note} text-center`}>听完的歌</h3><${StatRing} value=${completed} kind="completed" period=${period} label="听完的歌" /><p className="min-w-0 break-words text-center text-xs text-sand-400 tabular-nums">${completedComparison}</p></article>
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
        ${matrix.map((row, day) => html`<${React.Fragment} key=${day}><span className="min-w-0 truncate text-xs text-sand-400">${weekdays[day]}</span>${row.map((value, hour) => html`<span key=${hour} className="min-w-0 self-center rounded-sm" style=${{ aspectRatio: '1', background: heatColours[value >= 1800 ? 4 : value >= 900 ? 3 : value >= 300 ? 2 : value >= 60 ? 1 : 0] }} title=${`周${weekdays[day]} ${hour} 时 · ${minutes(value)} 分钟`} />`)}<//>`)}
        <span /><div className="flex min-w-0 justify-between text-xs text-sand-400" style=${{ gridColumn: '2 / -1' }}>${[0, 6, 12, 18, 23].map(hour => html`<span key=${hour} className="min-w-0 truncate">${hour}时</span>`)}</div>
      </div><div className="flex items-center justify-end gap-1 text-xs text-sand-400" aria-label="收听热力图例"><span>少</span>${heatColours.map(fill => html`<span key=${fill} className="h-3 w-3 rounded-sm" style=${{ background: fill }} />`)}<span>多</span></div><p className=${note}>${heatMax ? `高峰在 周${weekdays[Math.floor(peak / 24)]} ${peak % 24} 点。` : '还没有收听足迹，下一首就从此刻开始。'}</p>
    </div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">最常听的歌手</h3>${artists.map((row, i) => html`<div key=${row.artist} className="grid min-w-0 items-center gap-2" style=${{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, .65fr)' }}><span className="min-w-0 truncate text-xs" title=${row.artist}>${i + 1}. ${row.artist}</span><span className="h-2 min-w-0 overflow-hidden rounded-full bg-host/10"><span className="block h-full rounded-full bg-host" style=${{ width: `${row.seconds / artists[0].seconds * 100}%`, opacity: 1 - i * 0.13 }} /></span><span className="min-w-0 break-all text-right text-xs tabular-nums">${minutes(row.seconds)}</span></div>`)}${!artists.length && html`<p className=${note}>听一首喜欢的歌，让熟悉的声音留下足迹。</p>`}</div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">最常听的 5 首</h3>${top.map(({ track, plays }, i) => html`<div key=${track.id} className="flex min-w-0 items-center gap-3"><span className="min-w-0 shrink-0 text-sm tabular-nums text-host">${i + 1}</span><div className="min-w-0 flex-1"><p className="min-w-0 truncate text-sm" title=${track.title}>${track.title}</p><p className="min-w-0 truncate text-xs text-sand-400" title=${track.artist}>${track.artist || '未知歌手'} · 已听 ${plays.toLocaleString()} 次</p></div></div>`)}${!top.length && html`<p className=${note}>完整听完一首，留下旋律的足迹。</p>`}</div>
    <div className=${card}><h3 className="min-w-0 break-words text-sm font-semibold">听完率</h3>
      ${started > 0 ? html`<div className="flex min-w-0 items-center gap-3"><div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-host/10" role="meter" aria-label="听完率" aria-valuenow=${rate} aria-valuemin="0" aria-valuemax="100"><div className="h-full rounded-full bg-host" style=${{ width: `${rate}%` }} /></div><span className="shrink-0 text-lg font-bold tabular-nums text-host">${rate}%</span></div><p className=${note}>${localCompleted.toLocaleString()} 次听完 · ${started.toLocaleString()} 次开始播放</p>` : html`<p className=${note}>播放几首歌后，这里会显示完整听完的比例。</p>`}
    </div>
  </section>`;
}
