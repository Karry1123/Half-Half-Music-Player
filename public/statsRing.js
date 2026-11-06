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
export function formatCentre(kind, value) {
  value = safeValue(value);
  if (!value) return '0';
  if (kind !== 'duration') return `${Math.floor(value).toLocaleString('zh-CN')} 次`;
  const minutes = Math.floor(value / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes}分`;
}
export function centreFontSize(label) {
  // CJK glyphs consume a full em; digits/punctuation use a conservative .65 em.
  const width = [...label].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.65), 0);
  return Math.min(23, 96 / Math.max(1, width));
}
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
