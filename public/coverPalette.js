// Cover palette math is DOM-free; sampling is only performed on cover changes.
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
}
export function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
export function contrast(a, b) {
  const lum = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function dominantHue(pixels) {
  const buckets = Array.from({ length: 24 }, () => ({ weight: 0, rgb: [0, 0, 0] }));
  let eligible = 0, colorful = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const rgb = Array.from(pixels.slice(i, i + 3));
    if (pixels[i + 3] < 192 || Math.max(...rgb) < 31) continue;
    eligible++;
    const [h, s] = rgbToHsl(...rgb);
    if (s < .18) continue;
    colorful++;
    const bucket = buckets[Math.min(23, Math.floor(h / 15))], weight = .25 + s * .75;
    bucket.weight += weight;
    rgb.forEach((v, n) => bucket.rgb[n] += v * weight);
  }
  if (!eligible || colorful / eligible < .1) return null;
  const best = buckets.reduce((a, b) => a.weight >= b.weight ? a : b);
  return rgbToHsl(...best.rgb.map(v => v / best.weight))[0];
}
export function paletteFromPixels(pixels, theme = 'dark') {
  const hue = dominantHue(pixels);
  return hue == null ? null : paletteFromHue(hue, theme);
}
export function paletteFromHue(hue, theme = 'dark') {
  const light = theme === 'light';
  const bg = hslToRgb(hue, .28, light ? .94 : .12);
  const deep = hslToRgb(hue, .26, light ? .88 : .07);
  const fit = (s, initial, backgrounds, ratio) => {
    let l = initial, rgb = hslToRgb(hue, s, l);
    for (let n = 0; n < 100 && backgrounds.some(b => contrast(rgb, b) < ratio); n++) {
      l = Math.max(0, Math.min(1, l + (light ? -.01 : .01)));
      rgb = hslToRgb(hue, s, l);
    }
    return rgb;
  };
  const accent = fit(.66, light ? .34 : .72, [bg, deep], 3);
  const onAccent = contrast([0, 0, 0], accent) >= contrast([255, 255, 255], accent) ? [0, 0, 0] : [255, 255, 255];
  const roles = { bg, 'bg-deep': deep, 'on-bg': fit(.12, light ? .12 : .96, [bg, deep], 4.5),
    'on-bg-muted': fit(.16, light ? .34 : .72, [bg, deep], 4.5), accent, 'on-accent': onAccent,
    surface: hslToRgb(hue, .24, light ? .84 : .23), track: hslToRgb(hue, .2, light ? .65 : .4) };
  return Object.fromEntries(Object.entries(roles).map(([key, rgb]) => [`--fsp-${key}`, `rgb(${rgb.join(', ')})`]));
}
const cache = new Map();
/** Cross-origin failures (including a tainted canvas) deliberately resolve to token fallback. */
export function loadCoverPalette(itemId, coverUrl) {
  if (!coverUrl) return Promise.resolve(null);
  const key = `${itemId}|${coverUrl}`;
  if (cache.has(key)) return cache.get(key);
  const task = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
    const timer = setTimeout(() => finish(null), 10000);
    const finish = value => { clearTimeout(timer); img.onload = img.onerror = null; resolve(value); };
    img.onerror = () => finish(null);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 64 / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const hue = dominantHue(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        finish(hue == null ? null : { dark: paletteFromHue(hue), light: paletteFromHue(hue, 'light') });
      } catch { finish(null); }
    };
    img.src = coverUrl;
  });
  cache.set(key, task);
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return task;
}
