import test from 'node:test';
import assert from 'node:assert/strict';
import { contrast, dominantHue, paletteFromPixels, paletteFromHue } from '../public/coverPalette.js';
const pixels = (...colors) => new Uint8ClampedArray(colors.flat());
const rgb = value => value.match(/[\d.]+/g).map(Number);
test('transparent, dark, grayscale and predominantly neutral covers use fallback', () => {
 for (const p of [[], [255,0,0,0], [8,0,0,255], [180,180,180,255], [...Array(20).fill([180,180,180,255]).flat(), 255,0,0,255]])
   assert.equal(paletteFromPixels(p), null);
});
test('saturation-weighted buckets select the dominant colorful family', () => {
 const p = pixels([255,0,0,255], [240,20,10,255], [0,0,255,255], [100,100,100,255]);
 assert.ok(dominantHue(p) < 15);
 assert.ok(paletteFromPixels(p));
 assert.ok(Math.abs(dominantHue(pixels([0,255,0,255])) - 120) < .01);
});
test('all hues meet text, muted text, accent and button text contrast in both themes', () => {
 for (const theme of ['dark','light']) for (let hue=0; hue<360; hue+=3) {
   const p = paletteFromHue(hue, theme), get = role => rgb(p[`--fsp-${role}`]);
   for (const bg of ['bg','bg-deep']) {
     assert.ok(contrast(get('on-bg'),get(bg)) >= 4.5, `${theme}/${hue}/text`);
     assert.ok(contrast(get('on-bg-muted'),get(bg)) >= 4.5, `${theme}/${hue}/muted`);
     assert.ok(contrast(get('accent'),get(bg)) >= 3, `${theme}/${hue}/accent`);
   }
   assert.ok(contrast(get('on-accent'),get('accent')) >= 4.5);
   assert.equal(Object.keys(p).length, 8);
 }
});
