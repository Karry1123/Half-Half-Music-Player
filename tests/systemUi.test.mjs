import test from 'node:test';
import assert from 'node:assert/strict';
import { installThemeSync, resolveTheme, THEME_COLORS } from '../public/systemUi.js';

function fakeDoc() {
  const meta = { name: 'theme-color', content: '' };
  const classes = new Set();
  return {
    meta,
    documentElement: { dataset: {}, classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c), has: c => classes.has(c) } },
    querySelector: sel => sel.includes('theme-color') ? meta : null,
    head: { appendChild() {} },
    createElement: () => ({}),
  };
}

test('stored preference wins over the OS, otherwise the OS decides', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('junk', false), 'light');
});

test('theme drives html flags, theme-color and the Capacitor system bars', () => {
  const doc = fakeDoc();
  const styles = [];
  let change;
  const query = { matches: true, addEventListener: (_, fn) => { change = fn; }, removeEventListener() {} };
  const storage = { value: null, getItem() { return this.value; } };
  installThemeSync({ doc, storage, media: () => query, systemBars: { setStyle: s => { styles.push(s.style); return Promise.resolve(); } } });
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(doc.documentElement.classList.has('dark'), true);
  assert.equal(doc.meta.content, THEME_COLORS.dark);
  assert.deepEqual(styles, ['DARK']);
  // OS flips to light while nothing is pinned: follow it.
  query.matches = false;
  change();
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(doc.documentElement.classList.has('dark'), false);
  assert.equal(doc.meta.content, THEME_COLORS.light);
  assert.equal(styles.at(-1), 'LIGHT');
  // A pinned theme ignores the OS.
  storage.value = 'dark';
  query.matches = false;
  change();
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(styles.at(-1), 'DARK');
});

test('works without matchMedia or a plugin (plain browser, old WebView)', () => {
  const doc = fakeDoc();
  const sync = installThemeSync({ doc, storage: null, media: undefined, systemBars: null });
  assert.equal(doc.documentElement.dataset.theme, 'light');
  sync.dispose();
});
