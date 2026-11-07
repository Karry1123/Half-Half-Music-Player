"""Regenerate Half&Half source, web and Android artwork: python public/brand/generate.py.

Requires Pillow. Geometry and palette live here; spec.json preserves the icon brief.

Mark ("wave capsule"): a warm amber-to-rose diagonal gradient field, one dark
rounded capsule, and a single cream sound wave running through it. The two
colours of the field are the two listeners; the one wave is the song they share.
The same geometry feeds the app-icon-gen package under public/brand/app-icon-gen.
"""
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / 'public/brand'
RES = ROOT / 'android/app/src/main/res'
AMBER, ROSE, INK, CREAM = '#F2A65A', '#EC7A96', '#1A1512', '#FFF7EE'
ADAPTIVE_BG = '#EF9078'  # midpoint of the gradient, used where a flat colour is required

# Master geometry on a 1024 canvas, centred at (512, 512).
CAPSULE = (232, 392, 792, 632)          # x0, y0, x1, y1; corner radius = half height
WAVE = [(330, 512), (370, 512), (410, 440), (450, 584), (490, 460), (530, 564), (570, 480), (610, 544), (650, 500), (694, 512)]
WAVE_WIDTH = 40
ICON_RADIUS = 224                       # rounded-square corner on the 1024 canvas


def gradient_stops():
    return [(0.0, AMBER), (1.0, ROSE)]


def wave_path(scale=1.0, cx=512, cy=512, precision=1):
    pts = [((x - 512) * scale + cx, (y - 512) * scale + cy) for x, y in WAVE]
    return 'M' + 'L'.join(f'{x:.{precision}f},{y:.{precision}f}' for x, y in pts)


def capsule_rect(scale=1.0, cx=512, cy=512):
    x0, y0, x1, y1 = CAPSULE
    return ((x0 - 512) * scale + cx, (y0 - 512) * scale + cy, (x1 - 512) * scale + cx, (y1 - 512) * scale + cy)


def svg(rounded=True):
    x0, y0, x1, y1 = CAPSULE
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Half&amp;Half · two listeners, one wave">'
            '<defs><linearGradient id="field" x1="0" y1="0" x2="1" y2="1">'
            f'<stop stop-color="{AMBER}"/><stop offset="1" stop-color="{ROSE}"/></linearGradient></defs>'
            f'<rect width="1024" height="1024" rx="{ICON_RADIUS if rounded else 0}" fill="url(#field)"/>'
            f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{(y1 - y0) / 2:.0f}" fill="{INK}"/>'
            f'<path d="{wave_path()}" fill="none" stroke="{CREAM}" stroke-width="{WAVE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>'
            '</svg>\n')


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gradient_field(n):
    """Diagonal amber→rose gradient, top-left to bottom-right."""
    ramp = Image.linear_gradient('L').resize((n, n))          # vertical 0→255
    diag = Image.new('L', (n, n))
    # Project onto the (1,1) diagonal: t = (x + y) / (2n)
    px = diag.load()
    row = [0] * n
    for y in range(n):
        for x in range(n):
            px[x, y] = (x + y) * 255 // (2 * n - 2)
    a = Image.new('RGB', (n, n), hex_rgb(AMBER))
    r = Image.new('RGB', (n, n), hex_rgb(ROSE))
    return Image.composite(r, a, diag).convert('RGBA')


_FIELD_CACHE = {}


def field(n):
    if n not in _FIELD_CACHE:
        _FIELD_CACHE[n] = gradient_field(n)
    return _FIELD_CACHE[n]


def draw_mark(draw, n, scale):
    k = n / 1024
    x0, y0, x1, y1 = capsule_rect(scale)
    draw.rounded_rectangle((x0 * k, y0 * k, x1 * k, y1 * k), radius=(y1 - y0) / 2 * k, fill=INK)
    pts = [(((x - 512) * scale + 512) * k, ((y - 512) * scale + 512) * k) for x, y in WAVE]
    w = WAVE_WIDTH * scale * k
    draw.line(pts, fill=CREAM, width=round(w), joint='curve')
    for x, y in (pts[0], pts[-1]):
        draw.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=CREAM)


def render(size, mode='rounded', adaptive=False):
    # Supersample so small launchers keep clean capsule and wave edges.
    ss = 4 if size <= 256 else 2
    n = size * ss
    if mode == 'foreground':
        out = Image.new('RGBA', (n, n))
    else:
        out = field(n).copy()
    draw = ImageDraw.Draw(out)
    draw_mark(draw, n, 0.78 if adaptive else 1.0)   # adaptive foregrounds stay inside the 66dp safe circle
    if mode in ('rounded', 'round'):
        mask = Image.new('L', (n, n)); d = ImageDraw.Draw(mask)
        if mode == 'round': d.ellipse((0, 0, n - 1, n - 1), fill=255)
        else: d.rounded_rectangle((0, 0, n - 1, n - 1), radius=n * ICON_RADIUS / 1024, fill=255)
        out.putalpha(mask)
    return out.resize((size, size), Image.Resampling.LANCZOS)


def vector():
    # 108dp adaptive canvas; mark scaled to 0.78 so every point lies within radius 33 of (54,54).
    k = 108 / 1024
    s = 0.78
    x0, y0, x1, y1 = capsule_rect(s)
    x0, y0, x1, y1 = (v * k for v in (x0, y0, x1, y1))
    r = (y1 - y0) / 2
    capsule = (f'M{x0 + r:.2f},{y0:.2f}H{x1 - r:.2f}A{r:.2f},{r:.2f} 0 0 1 {x1 - r:.2f},{y1:.2f}'
               f'H{x0 + r:.2f}A{r:.2f},{r:.2f} 0 0 1 {x0 + r:.2f},{y0:.2f}Z')
    pts = [(((x - 512) * s + 512) * k, ((y - 512) * s + 512) * k) for x, y in WAVE]
    wave = 'M' + 'L'.join(f'{x:.2f},{y:.2f}' for x, y in pts)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n'
            f'    <path android:fillColor="{INK}" android:pathData="{capsule}"/>\n'
            f'    <path android:strokeColor="{CREAM}" android:strokeWidth="{WAVE_WIDTH * s * k:.2f}" android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="{wave}"/>\n'
            '</vector>\n')


def background_vector():
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n'
            '    <path android:pathData="M0,0H108V108H0Z"><aapt:attr name="android:fillColor">'
            '<gradient android:type="linear" android:startX="0" android:startY="0" android:endX="108" android:endY="108">'
            f'<item android:offset="0" android:color="{AMBER}"/><item android:offset="1" android:color="{ROSE}"/>'
            '</gradient></aapt:attr></path>\n</vector>\n')


def status_icon():
    # Monochrome 24dp silhouette: the wave alone, white, for the notification bar.
    k = 24 / 1024
    s = 1.3
    pts = [(((x - 512) * s + 512) * k, ((y - 512) * s + 512) * k) for x, y in WAVE]
    wave = 'M' + 'L'.join(f'{x:.2f},{y:.2f}' for x, y in pts)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">\n'
            f'    <path android:strokeColor="#FFFFFFFF" android:strokeWidth="{WAVE_WIDTH * s * k:.2f}" android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="{wave}"/>\n'
            '</vector>\n')


def app_icon_gen_spec():
    """Spec for the app-icon-gen skill (1024px canvas, same geometry)."""
    x0, y0, x1, y1 = CAPSULE
    return {
        'name': 'HalfHalf', 'target_platforms': ['Web', 'Android'],
        'source_reference': 'Original direct semantic design for Half&Half (public/brand/generate.py)',
        'brief': 'Two people listening in P2P sync: an amber-to-rose field for the two listeners, one dark capsule, one cream sound wave they share. Flat, rounded, legible at 64px.',
        'semantic_review': {'status': 'exact-enough', 'identity_risk': 'low',
                            'basis': 'original in-task design with no external brand identity; geometry is authored primitives',
                            'route': 'semantic-svg', 'notes': 'Gradient background, one filled capsule and one stroked polyline; no material effects.'},
        'fill': 'automatic',
        'layers': [
            {'name': 'background', 'svg': f'<defs><linearGradient id="field" x1="0" y1="0" x2="1" y2="1"><stop stop-color="{AMBER}"/><stop offset="1" stop-color="{ROSE}"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#field)"/>', 'composer': {'include': False}},
            {'name': 'capsule', 'svg': f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{(y1 - y0) / 2:.0f}" fill="{INK}"/>'},
            {'name': 'wave', 'svg': f'<path d="{wave_path()}" fill="none" stroke="{CREAM}" stroke-width="{WAVE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>'},
        ],
    }


def main():
    BRAND.mkdir(exist_ok=True)
    (BRAND / 'half-half.svg').write_text(svg(False), encoding='utf-8')
    (BRAND / 'half-half.preview.svg').write_text(svg(), encoding='utf-8')
    (ROOT / 'public/icon.svg').write_text(svg(), encoding='utf-8')
    render(512, 'square').save(BRAND / 'half-half.png')
    for size in (64, 192, 512):
        render(size).save(BRAND / f'preview-{size}.png')
    for size in (192, 512): render(size).save(ROOT / f'public/icon-{size}.png')
    for density, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        directory = RES / f'mipmap-{density}'
        render(size).save(directory / 'ic_launcher.png')
        render(size, 'round').save(directory / 'ic_launcher_round.png')
        render(round(size * 108 / 48), 'foreground', True).save(directory / 'ic_launcher_foreground.png')
    (RES / 'drawable/ic_launcher_foreground.xml').write_text(vector(), encoding='utf-8')
    (RES / 'drawable/ic_launcher_background.xml').write_text(background_vector(), encoding='utf-8')
    (RES / 'values/ic_launcher_background.xml').write_text(f'<?xml version="1.0" encoding="utf-8"?><resources><color name="ic_launcher_background">{ADAPTIVE_BG}</color></resources>\n', encoding='utf-8')
    (RES / 'drawable/ic_stat_music.xml').write_text(status_icon(), encoding='utf-8')
    for path in RES.glob('drawable*/splash.png'):
        with Image.open(path) as original: w, h = original.size
        splash = Image.new('RGB', (w, h), INK)
        size = round(min(w, h) * 0.32)
        icon = render(size)
        splash.paste(icon, ((w - size) // 2, (h - size) // 2), icon)
        splash.save(path)
    spec = {
        'name': 'HalfHalf', 'target_platforms': ['Web', 'Android'],
        'source_reference': 'Original direct semantic design for Half&Half',
        'brief': 'Two people listening in P2P sync: an amber-to-rose diagonal field (the two listeners), one dark capsule, one cream sound wave they share. Flat, rounded, legible at 64px.',
        'canvas': {'size': 1024, 'icon_radius': ICON_RADIUS, 'adaptive_safe_circle_108dp': {'cx': 54, 'cy': 54, 'radius': 33}, 'adaptive_mark_scale': 0.78},
        'palette': {'host': AMBER, 'guest': ROSE, 'ink': INK, 'wave': CREAM, 'adaptive_background': ADAPTIVE_BG},
        'geometry': {'capsule': CAPSULE, 'wave': WAVE, 'wave_width': WAVE_WIDTH},
        'style': {'direction': 'gradient-field-capsule-mark', 'svg_convertibility': 'high'},
        'layers': app_icon_gen_spec()['layers'],
    }
    (BRAND / 'spec.json').write_text(json.dumps(spec, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    gen = BRAND / 'app-icon-gen'; gen.mkdir(exist_ok=True)
    (gen / 'spec.json').write_text(json.dumps(app_icon_gen_spec(), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Generated SVG sources, previews, web icons, Android icons and splash variants.')


if __name__ == '__main__': main()
