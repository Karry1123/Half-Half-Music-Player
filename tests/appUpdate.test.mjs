import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  checkForUpdate,
  compareSemver,
  downloadCandidates,
  fetchLatestRelease,
  isDevVersion,
  isNewer,
  parseSemver,
  pickApkAsset,
  plainChangelog,
  releaseToUpdate,
  sha256Hex,
} from '../public/appUpdate.js';

const HEX = 'a'.repeat(64);
const release = (over = {}) => ({
  tag_name: 'v1.2.0',
  name: 'v1.2.0',
  body: '## What\'s Changed\n* **Fix** shuffle bug\n* See [docs](https://example.com)\n\n\n\nDone',
  html_url: 'https://github.com/o/r/releases/tag/v1.2.0',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'app-release.apk.sha256', state: 'uploaded', browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/app-release.apk.sha256' },
    { name: 'app-release.apk', state: 'uploaded', size: 6000000, digest: `sha256:${HEX}`, browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/app-release.apk' },
  ],
  ...over,
});
const okFetch = (body, init = {}) => async () => ({ ok: true, status: 200, json: async () => body, ...init });

test('semver: parsing', () => {
  assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseSemver('1.2.3-beta.1+build5'), { major: 1, minor: 2, patch: 3, pre: ['beta', 1] });
  assert.deepEqual(parseSemver('V2'), { major: 2, minor: 0, patch: 0, pre: [] });
  assert.deepEqual(parseSemver(' 1.4 '), { major: 1, minor: 4, patch: 0, pre: [] });
  for (const bad of ['', 'abc', '1.2.3.4', 'v', null, undefined, '1.2.x']) assert.equal(parseSemver(bad), null, String(bad));
});

test('semver: ordering follows semver.org precedence, not string order', () => {
  const ascending = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 0; i < ascending.length - 1; i++) {
    assert.equal(compareSemver(ascending[i], ascending[i + 1]), -1, `${ascending[i]} < ${ascending[i + 1]}`);
    assert.equal(compareSemver(ascending[i + 1], ascending[i]), 1);
  }
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0, 'build metadata is ignored');
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
  assert.throws(() => compareSemver('nope', '1.0.0'), TypeError);
});

test('isNewer: only a strictly higher valid version counts', () => {
  assert.equal(isNewer('v1.10.0', '1.9.0'), true);
  assert.equal(isNewer('v1.2.0', '1.2.0'), false);
  assert.equal(isNewer('v1.1.9', '1.2.0'), false);
  assert.equal(isNewer('v1.2.0', '1.2.0-rc.1'), true);
  assert.equal(isNewer('garbage', '1.0.0'), false);
  assert.equal(isNewer('v2.0.0', 'garbage'), false);
});

test('isDevVersion: CI dev builds and unknown versions are never forced to update', () => {
  assert.equal(isDevVersion('0.0.0-dev.42+abc1234'), true);
  assert.equal(isDevVersion(undefined), true);
  assert.equal(isDevVersion(''), true);
  assert.equal(isDevVersion('0.1.0'), false);
  assert.equal(isDevVersion('0.0.1'), false);
});

test('pickApkAsset: prefers app-release.apk and reads the SHA-256 from digest', () => {
  const apk = pickApkAsset(release().assets);
  assert.equal(apk.name, 'app-release.apk');
  assert.equal(apk.sha256, HEX);
  assert.equal(apk.size, 6000000);
  assert.match(apk.sha256Url, /app-release\.apk\.sha256$/);
  assert.equal(pickApkAsset([{ name: 'notes.txt', state: 'uploaded', browser_download_url: 'x' }]), null);
  assert.equal(pickApkAsset(undefined), null);
  const other = pickApkAsset([{ name: 'Half-Half.APK', state: 'uploaded', browser_download_url: 'https://x/y.apk' }]);
  assert.equal(other.name, 'Half-Half.APK');
  assert.equal(other.sha256, null);
  assert.equal(pickApkAsset([{ name: 'app-release.apk', state: 'open', browser_download_url: 'x' }]), null, 'half-uploaded assets are ignored');
});

test('plainChangelog: strips markdown, keeps text, truncates', () => {
  assert.equal(plainChangelog(release().body), "What's Changed\n• Fix shuffle bug\n• See docs\n\nDone");
  assert.equal(plainChangelog(null), '');
  const long = plainChangelog('x'.repeat(5000), 100);
  assert.equal(long.length, 101);
  assert.ok(long.endsWith('…'));
});

test('releaseToUpdate: drafts, pre-releases and releases without an APK are not installable', () => {
  const u = releaseToUpdate(release());
  assert.equal(u.version, '1.2.0');
  assert.equal(u.tag, 'v1.2.0');
  assert.equal(u.apk.url.endsWith('app-release.apk'), true);
  assert.equal(releaseToUpdate(release({ draft: true })), null);
  assert.equal(releaseToUpdate(release({ prerelease: true })), null);
  assert.equal(releaseToUpdate(release({ assets: [] })), null);
  assert.equal(releaseToUpdate(null), null);
});

test('checkForUpdate: newer / same / older', async () => {
  const f = okFetch(release());
  const newer = await checkForUpdate({ repo: 'o/r', localVersion: '1.1.9', fetchImpl: f });
  assert.equal(newer.status, 'update');
  assert.equal(newer.update.version, '1.2.0');
  assert.equal((await checkForUpdate({ repo: 'o/r', localVersion: '1.2.0', fetchImpl: f })).status, 'current');
  assert.equal((await checkForUpdate({ repo: 'o/r', localVersion: '1.3.0', fetchImpl: f })).status, 'current');
});

test('checkForUpdate: asks the right URL and never hits the network for dev builds', async () => {
  let url;
  await checkForUpdate({ repo: 'me/app', localVersion: '1.0.0', fetchImpl: async (u) => ((url = u), { ok: false }) });
  assert.equal(url, 'https://api.github.com/repos/me/app/releases/latest');
  let called = false;
  const r = await checkForUpdate({ repo: 'o/r', localVersion: '0.0.0-dev.3+abc', fetchImpl: async () => ((called = true), { ok: true, json: async () => release() }) });
  assert.deepEqual(r, { status: 'skipped', reason: 'dev-build' });
  assert.equal(called, false);
});

test('checkForUpdate: every failure mode silently skips', async () => {
  const skipped = (r, reason) => assert.deepEqual(r, { status: 'skipped', reason });
  skipped(await checkForUpdate({ localVersion: '1.0.0', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), 'unreachable');
  skipped(await checkForUpdate({ localVersion: '1.0.0', fetchImpl: async () => ({ ok: false, status: 403 }) }), 'unreachable'); // rate limit
  skipped(await checkForUpdate({ localVersion: '1.0.0', fetchImpl: async () => ({ ok: false, status: 404 }) }), 'unreachable'); // no release yet
  skipped(await checkForUpdate({ localVersion: '1.0.0', fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }) }), 'unreachable');
  skipped(await checkForUpdate({ localVersion: '1.0.0', fetchImpl: okFetch(release({ tag_name: 'nightly' })) }), 'bad-version');
  skipped(await checkForUpdate({ localVersion: '1.0.0', fetchImpl: okFetch(release({ assets: [] })) }), 'no-apk');
});

test('fetchLatestRelease: gives up after the timeout (5 s in the app) instead of hanging', async () => {
  const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const t0 = Date.now();
  assert.equal(await fetchLatestRelease({ repo: 'o/r', fetchImpl: hang, timeoutMs: 60 }), null);
  assert.ok(Date.now() - t0 < 1000);
  // a body that stalls after the headers arrived is cut off as well
  const stalledBody = async (_url, { signal }) => ({ ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.equal(await fetchLatestRelease({ repo: 'o/r', fetchImpl: stalledBody, timeoutMs: 60 }), null);
});

test('downloadCandidates: GitHub first; mirrors only with a known SHA-256 and only over https', () => {
  const url = 'https://github.com/o/r/releases/download/v1/app-release.apk';
  assert.deepEqual(downloadCandidates(url), [url]);
  assert.deepEqual(downloadCandidates(url, { mirrors: ['https://m.example/'], haveSha256: false }), [url]);
  assert.deepEqual(downloadCandidates(url, { mirrors: ['https://m.example/', 'https://n.example', 'http://insecure.example/', '', null], haveSha256: true }), [
    url,
    `https://m.example/${url}`,
    `https://n.example/${url}`,
  ]);
});

test('sha256Hex / base64ToBytes round trip', async () => {
  const bytes = base64ToBytes(Buffer.from('abc').toString('base64'));
  assert.equal(await sha256Hex(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
