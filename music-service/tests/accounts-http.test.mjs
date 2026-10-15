import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Accounts, mountAccounts } from '../src/accounts.js';

test('HTTP activation gate, token revocation and account library separation', async () => {
  const db = await Accounts.memory(), app = express(); app.use(express.json());
  const guard = mountAccounts(app, db, (_req, _res, next) => next());
  app.get('/api/search', guard, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, token, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, ...(body && { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await request('/api/search')).status, 401);
    const a = (await request('/auth/register', null, { username: 'account-a', password: 'local-test-password-a' })).body;
    assert.equal((await request('/api/search', a.token)).status, 403);
    assert.equal((await request('/account/library', a.token)).status, 403);
    await request('/auth/activate', a.token, { code: await db.invite() });
    assert.equal((await request('/api/search', a.token)).status, 200);
    const b = (await request('/auth/register', null, { username: 'account-b', password: 'local-test-password-b' })).body;
    await request('/auth/activate', b.token, { code: await db.invite() });
    await request('/account/library', a.token, { revision: 0, playlists: [{ id: 'p', name: '私有歌单', tracks: [] }] }, 'PUT');
    assert.deepEqual((await request('/account/library', b.token)).body.playlists, []);
    assert.equal((await request('/account/library', a.token, { revision: 0, playlists: [] }, 'PUT')).status, 409);
    await request('/auth/logout', a.token, {});
    assert.equal((await request('/api/search', a.token)).status, 401);
  } finally { await new Promise(r => server.close(r)); await db.close(); }
});
