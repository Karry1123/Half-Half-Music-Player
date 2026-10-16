import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSrc, setCoverProxy } from '../public/coverUrl.js';

test('covers from hosts blocked in mainland China go through the backend proxy', () => {
  setCoverProxy(null);
  assert.equal(coverSrc('https://i.ytimg.com/vi/a/hq.jpg'), 'https://i.ytimg.com/vi/a/hq.jpg');
  setCoverProxy(url => `/api/cover?url=${encodeURIComponent(url)}`);
  assert.equal(coverSrc('https://i.ytimg.com/vi/a/hq.jpg'), '/api/cover?url=https%3A%2F%2Fi.ytimg.com%2Fvi%2Fa%2Fhq.jpg');
  assert.equal(coverSrc('https://i0.hdslb.com/bfs/a.jpg'), 'https://i0.hdslb.com/bfs/a.jpg');
  assert.equal(coverSrc('https://is1-ssl.mzstatic.com/a.jpg'), 'https://is1-ssl.mzstatic.com/a.jpg');
  assert.equal(coverSrc(''), '');
  assert.equal(coverSrc(undefined), undefined);
  setCoverProxy(null);
});
