import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCookies } from '../src/config.js';

const line = ['.youtube.com', 'TRUE', '/', 'TRUE', '1900000000', 'SID', 'abc'];

test('adds the Netscape header and drops leading blank lines and BOM', () => {
  const r = normalizeCookies(`\uFEFF\n\n${line.join('\t')}\r\n`);
  assert.equal(r.text, `# Netscape HTTP Cookie File\n${line.join('\t')}\n`);
  assert.equal(r.entries, 1);
});

test('turns space-separated fields back into tabs and keeps HttpOnly lines', () => {
  const r = normalizeCookies(`# Netscape HTTP Cookie File\n# comment\n#HttpOnly_${line.join('   ')}\nbroken line\n`);
  assert.equal(r.text.split('\n')[1], `#HttpOnly_${line.join('\t')}`);
  assert.deepEqual([r.entries, r.skipped], [1, 1]);
});

test('converts a browser-extension JSON export', () => {
  const r = normalizeCookies(JSON.stringify([{ domain: 'youtube.com', hostOnly: false, path: '/', secure: true, httpOnly: true, expirationDate: 1900000000.5, name: 'SID', value: 'abc' }]));
  assert.equal(r.text.split('\n')[1], `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tabc`);
});

test('converts a request-header cookie string', () => {
  const r = normalizeCookies('SID=abc; HSID=def');
  assert.equal(r.entries, 2);
  assert.match(r.text.split('\n')[1], /^\.youtube\.com\tTRUE\t\/\tTRUE\t\d+\tSID\tabc$/);
});

test('reports the shape of unrecognised lines without their content', () => {
  const r = normalizeCookies('a\tb\tc\nsecret-value');
  assert.equal(r.entries, 0);
  assert.equal(r.shapes, '3tab/3ws×1, 1tab/1ws×1');
});
