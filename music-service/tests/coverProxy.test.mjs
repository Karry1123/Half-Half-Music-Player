import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { allowedCoverUrl, mountCoverProxy } from '../src/lib/coverProxy.js';

test('only https covers from blocked image hosts are proxied', () => {
  assert.ok(allowedCoverUrl('https://i.ytimg.com/vi/abc/hqdefault.jpg'));
  assert.ok(allowedCoverUrl('https://yt3.ggpht.com/a.jpg'));
  assert.ok(allowedCoverUrl('https://lh3.googleusercontent.com/x'));
  assert.equal(allowedCoverUrl('http://i.ytimg.com/vi/abc/hqdefault.jpg'), null);
  assert.equal(allowedCoverUrl('https://evil.com/i.ytimg.com.jpg'), null);
  assert.equal(allowedCoverUrl('https://i.ytimg.com.evil.com/a.jpg'), null);
  assert.equal(allowedCoverUrl('https://user:pw@i.ytimg.com/a.jpg'), null);
  assert.equal(allowedCoverUrl('https://i.ytimg.com:8443/a.jpg'), null);
  assert.equal(allowedCoverUrl('not a url'), null);
});

async function serve(fetcher) {
  const app = express();
  mountCoverProxy(app, { fetcher });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('proxy relays images and rejects non-images or disallowed hosts', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const { server, base } = await serve(async url => String(url).includes('bad')
    ? new Response('<html>', { headers: { 'content-type': 'text/html' } })
    : new Response(png, { headers: { 'content-type': 'image/png' } }));
  try {
    const ok = await fetch(`${base}/api/cover?url=${encodeURIComponent('https://i.ytimg.com/vi/a/hq.jpg')}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/api/cover?url=${encodeURIComponent('https://i.ytimg.com/bad.jpg')}`)).status, 502);
    assert.equal((await fetch(`${base}/api/cover?url=${encodeURIComponent('https://example.com/a.jpg')}`)).status, 400);
  } finally { server.close(); }
});
