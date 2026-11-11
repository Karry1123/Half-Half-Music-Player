// Values are seconds for duration and song counts for completed.
export const lapUnits = {
  week: { duration: 7 * 3600, completed: 50 },
  month: { duration: 30 * 3600, completed: 200 },
  year: { duration: 365 * 3600, completed: 2000 },
  all: { duration: 1000 * 3600, completed: 5000 },
};
export const ringRadius = 66; // 20-wide stroke plus room for the soft tip shadow.
export const ringStyles = `
.stats-ring-box{position:relative;width:100%;max-width:160px;margin:auto;color:var(--color-text-primary)}
.stats-ring{display:block;width:100%;overflow:visible}
.stats-ring-number{font-weight:750;font-variant-numeric:tabular-nums;fill:currentColor}
.stats-ring-caption{fill:var(--color-text-secondary)}
.stats-ring-badge{position:absolute;right:0;top:0;border-radius:20px;padding:1px 6px;font-size:10px;font-weight:700;background:var(--color-text-primary);color:var(--color-bg-surface);border:2px solid var(--color-bg-surface)}
@media(prefers-reduced-motion:reduce){.stats-ring{animation:none}}
`;
const safeValue = value => Number.isFinite(value) ? Math.max(0, value) : 0;
export function ringModel(value, perLap) {
  const progress = perLap > 0 && Number.isFinite(perLap) ? safeValue(value) / perLap : 0;
  // Correct floating point noise at exact lap boundaries without swallowing tiny values.
  const nearest = Math.round(progress);
  const normalized = nearest > 0 && Math.abs(progress - nearest) < 1e-10 ? nearest : progress;
  const laps = Math.floor(normalized), fraction = normalized - laps;
  const arcs = [];
  const arc = (lapIndex, fraction) => ({ lapIndex, fraction, tint: Math.min(lapIndex, 2) * 18 });
  for (let i = Math.max(0, laps - 2); i < laps; i++) arcs.push(arc(i, 1));
  if (fraction > 0) arcs.push(arc(laps, Math.max(0.02, fraction)));
  return { laps, fraction, badge: laps ? `×${laps}` : '', arcs };
}
export function lapColour(kind, tint = 0) {
  const base = `var(--color-brand-${kind === 'duration' ? 'host' : 'guest'})`;
  return tint ? `color-mix(in srgb, ${base}, rgb(var(--p-white-rgb)) ${tint}%)` : base;
}
export function ringHue(kind, alpha) {
  return `rgb(var(--color-brand-${kind === 'duration' ? 'host' : 'guest'}-rgb) / ${alpha})`;
}
export function ringTip(arc) {
  const angle = arc.fraction * Math.PI * 2 - Math.PI / 2;
  return { x: 80 + Math.cos(angle) * ringRadius, y: 80 + Math.sin(angle) * ringRadius };
}
// One font size for every label. The label is shortened as the number grows instead, so the
// centre never changes size while a sweep counts or a period switch changes the magnitude.
// Widest label is 4.95 em by the estimate below; the ring is 112 wide inside the stroke.
export const centreFontSize = 18;
export const centreMaxWidth = 90;
// 1.2万 / 12万 / 999万 / 0.9亿 / 12亿: one decimal below ten, whole units above.
const short = n => n < 10 ? String(Math.floor(n * 10) / 10) : String(Math.floor(n));
const compact = n => n >= 1e7 ? `${short(n / 1e8)}亿` : `${short(n / 1e4)}万`;
export function formatCentre(kind, value) {
  value = safeValue(value);
  if (!value) return '0';
  if (kind !== 'duration') {
    const count = Math.floor(value);
    return `${count >= 1e4 ? compact(count) : count} 次`;
  }
  const minutes = Math.floor(value / 60), hours = Math.floor(minutes / 60);
  if (hours >= 1e4) return `${compact(hours)}小时`;
  if (hours >= 100) return `${hours}小时`;
  if (hours >= 10) return `${Math.floor(minutes / 6) / 10}小时`;
  if (hours) return `${hours}小时${minutes % 60}分`;
  return `${minutes}分`;
}
// CJK glyphs consume a full em; digits/punctuation use a conservative .65 em.
export const labelWidth = (label, size = centreFontSize) => [...label].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : 0.65), 0) * size;
export function lapCaption(kind, perLap) {
  return `一圈 = ${(kind === 'duration' ? perLap / 3600 : perLap).toLocaleString('zh-CN')} ${kind === 'duration' ? '小时' : '次'}`;
}
export function sweep(from, to, duration, onFrame) {
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || globalThis.document?.hidden || duration <= 0) {
    onFrame(to);
    return () => {};
  }
  let frame, start, cancelled = false;
  const step = time => {
    if (cancelled) return;
    start ??= time;
    const t = Math.min(1, Math.max(0, (time - start) / duration));
    onFrame(t === 1 ? to : from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) frame = globalThis.requestAnimationFrame(step);
  };
  onFrame(from);
  frame = globalThis.requestAnimationFrame(step);
  return () => { cancelled = true; globalThis.cancelAnimationFrame(frame); };
}
