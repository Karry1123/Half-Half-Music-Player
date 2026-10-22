import test from 'node:test';
import assert from 'node:assert/strict';
import { coverCandidates, coverError, COVER_PLACEHOLDER, setCoverProxy, fetchCover } from '../public/coverUrl.js';
import { createCoverBackfill } from '../public/libraryCoverBackfill.js';

test('cover errors progress through proxied alternate sizes to a music placeholder', () => {
  setCoverProxy(url => '/api/cover?url=' + encodeURIComponent(url));
  const item = { cover: 'blob:expired', coverUrl: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg' };
  const urls = coverCandidates(item);
  assert.equal(urls.length, 5);
  assert.ok(urls.slice(1).every(u => u.startsWith('/api/cover?url=')));
  const img = { src: urls[0], getAttribute() { return this.src; }, style: {} };
  for (const expected of [...urls.slice(1), COVER_PLACEHOLDER]) {
    coverError({ currentTarget: img }, item);
    assert.equal(img.src, expected);
  }
  coverError({ currentTarget: img }, item);
  assert.equal(img.style.visibility, 'hidden');
  setCoverProxy(null);
});

test('durable cover fetch tries alternate sizes with no referrer and rejects HTML', async () => {
  const original = globalThis.fetch, calls = [];
  setCoverProxy(url => '/api/cover?url=' + encodeURIComponent(url));
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(calls.length < 2 ? 'error page' : 'image bytes', { headers: { 'Content-Type': calls.length < 2 ? 'text/html' : 'image/jpeg' } });
  };
  try {
    const blob = await fetchCover('https://i.ytimg.com/vi/abc/maxresdefault.jpg');
    assert.equal(blob.type, 'image/jpeg');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.url.startsWith('/api/cover?') && c.options.referrerPolicy === 'no-referrer'));
  } finally { globalThis.fetch = original; setCoverProxy(null); }
});

test('failed backfill automatically recovers after backoff and persists only actual cover success', async () => {
  let time = 0, callback, wait, offline = true, saved = 0, refreshed = 0;
  const repair = createCoverBackfill({ available: () => true, now: () => time, retryBaseMs: 100,
    schedule: (fn, ms) => { callback = fn; wait = ms; return 1; }, cancel: () => {},
    resolve: async () => { if (offline) throw Error('network'); return { cover: 'https://example.com/fresh.jpg' }; },
    save: async (id, url) => { saved++; return { id, hasCover: url.includes('fresh'), coverUrl: url }; },
    onCover: () => { refreshed++; },
  });
  const tracks = [{ id: '1', sourceId: 'bilibili:BV123', coverUrl: 'https://example.com/stale.jpg' }];
  await repair(tracks);
  assert.equal(refreshed, 0); assert.equal(saved, 1); assert.equal(wait, 100);
  await repair(tracks); assert.equal(saved, 1);
  offline = false; time += wait; callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, 3); assert.equal(refreshed, 1);
  await repair(tracks); assert.equal(saved, 3);
  repair.dispose();
});

test('cloud metadata can repair an imported local track with no original URL', async () => {
  let url;
  const repair = createCoverBackfill({ available: () => true, metadata: () => ['https://example.com/cloud.jpg'],
    resolve: () => assert.fail(), save: async (id, coverUrl) => { url = coverUrl; return { id, hasCover: true }; }, onCover: () => {},
  });
  await repair([{ id: 'local', hash: 'same-audio' }]);
  assert.equal(url, 'https://example.com/cloud.jpg');
  repair.dispose();
});
