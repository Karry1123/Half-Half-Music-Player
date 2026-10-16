"""Regenerate the legacy launcher PNGs (Android < 8) from the same geometry as public/icon.svg.

Uses the locally available Pillow; no extra install needed:  python scripts/generate-launcher-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / 'android/app/src/main/res'
SCALE = 8
ART = 1.265  # artwork size relative to the 108-unit grid, scaled around the centre
TOP, BOTTOM = (0xF6, 0xB4, 0x6A), (0xE8, 0x70, 0x8F)
WHITE, GRILLE = '#ffffff', '#efb3c1'


def gradient(size):
    """Diagonal orange-to-pink gradient, matching the vector background."""
    small = Image.new('RGB', (108, 108))
    for y in range(108):
        for x in range(108):
            t = (x + y) / 214
            small.putpixel((x, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return small.resize((size, size), Image.Resampling.BICUBIC)


def bezier(start, control1, control2, end, steps=24):
    return [tuple((1-t)**3*a + 3*(1-t)**2*t*b + 3*(1-t)*t*t*c + t**3*d
                  for a, b, c, d in zip(start, control1, control2, end))
            for t in (i / steps for i in range(1, steps + 1))]


def render(kind):
    size = 108 * SCALE
    image = Image.new('RGBA', (size, size))
    if kind != 'foreground':
        mask = Image.new('L', (size, size))
        shape = ImageDraw.Draw(mask)
        if kind == 'round':
            shape.ellipse((0, 0, size - 1, size - 1), fill=255)
        else:
            shape.rounded_rectangle((0, 0, size - 1, size - 1), radius=24 * SCALE, fill=255)
        image.paste(gradient(size), (0, 0), mask)
    s = lambda *coords: tuple(round(((c - 54) * ART + 54) * SCALE) for c in coords)
    if kind != 'foreground':
        # Soft shadow under the white shapes for a little depth.
        from PIL import ImageFilter
        shadow = Image.new('RGBA', (size, size))
        sd = ImageDraw.Draw(shadow)
        for (x1, y1), (x2, y2) in (((43, 52.5), (37, 72.5)), ((65, 52.5), (71, 72.5))):
            sd.line(s(x1, y1, x2, y2), fill=(120, 40, 60, 70), width=round(7 * ART * SCALE))
        for cx in (40, 68):
            sd.ellipse(s(cx - 10, 36.5, cx + 10, 56.5), fill=(120, 40, 60, 70))
        image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(2 * ART * SCALE)))
    draw = ImageDraw.Draw(image)
    s = lambda *coords: tuple(round(((c - 54) * ART + 54) * SCALE) for c in coords)

    # Stems: 7-unit capsules leaning outward.
    for (x1, y1), (x2, y2) in (((43, 51), (37, 71)), ((65, 51), (71, 71))):
        draw.line(s(x1, y1, x2, y2), fill=WHITE, width=round(7 * ART * SCALE))
        for x, y in ((x1, y1), (x2, y2)):
            draw.ellipse(s(x - 3.5, y - 3.5, x + 3.5, y + 3.5), fill=WHITE)  # s() scales the cap radius too
    # Heads.
    for cx in (40, 68):
        draw.ellipse(s(cx - 10, 35, cx + 10, 55), fill=WHITE)
    # Small heart between them.
    heart = [(54, 66)]
    heart += bezier(heart[-1], (46, 60), (47, 54), (51, 54.5))
    heart += bezier(heart[-1], (52.8, 54.7), (54, 56), (54, 57))
    heart += bezier(heart[-1], (54, 56), (55.2, 54.7), (57, 54.5))
    heart += bezier(heart[-1], (61, 54), (62, 60), (54, 66))
    draw.polygon([s(x, y) for x, y in heart], fill=WHITE)
    # Speaker grilles facing each other.
    for cx in (46.5, 61.5):
        draw.ellipse(s(cx - 2, 43, cx + 2, 49), fill=GRILLE)
    return image


if __name__ == '__main__':
    renders = {kind: render(kind) for kind in ('square', 'round', 'foreground')}
    for density, size in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        folder = RES / f'mipmap-{density}'
        for filename, kind, output_size in [('ic_launcher.png', 'square', size),
                                            ('ic_launcher_round.png', 'round', size),
                                            ('ic_launcher_foreground.png', 'foreground', round(size*108/48))]:
            renders[kind].resize((output_size, output_size), Image.Resampling.LANCZOS).save(folder / filename)
    print('Generated all 15 legacy launcher PNGs.')
