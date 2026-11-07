# Half&Half brand source

"Wave capsule": a warm amber `#F2A65A` → rose `#EC7A96` diagonal field (the two
listeners), one dark capsule `#1A1512`, and one cream `#FFF7EE` sound wave running
through it (the song they share). No lettering or fine detail is needed at 64px.

- `half-half.svg` / `half-half.png`: square source artwork (1024 canvas).
- `half-half.preview.svg` and `preview-*.png`: rounded web and review artwork.
- `spec.json`: brief, semantic layers, palette, capsule/wave geometry and safe zone.
- `generate.py`: deterministic source and platform asset regeneration with Pillow.
  Geometry constants (`CAPSULE`, `WAVE`, `WAVE_WIDTH`, `ICON_RADIUS`) live at the top.

From the repository root, run `python public/brand/generate.py`. This updates web
icons, Android launcher/adaptive foregrounds and gradient background, the
notification silhouette (the wave alone, white) and all existing splash sizes.
Adaptive foregrounds draw the mark at 0.78 scale on the 108dp canvas so it stays
inside the centered 66dp safe circle.

The [app-icon-gen](https://github.com/xzhih/app-icon-skill) skill was run on the same
geometry at 1024px: `app-icon-gen/spec.json` is its spec, `app-icon-gen/half-half*.svg|png`
and `app-icon-gen/layers/` are its generated package, and `app-icon-gen/reports/` holds
the `verify` output (warnings and failures empty, route `generic_assets_ready`).
Regenerate with `npm --prefix scripts run author-icon -- --spec <delivery>/tmp/work/spec.json --out <delivery>`
followed by `npm --prefix scripts run verify -- --out <delivery>` inside the skill checkout.
