// Force-update logic for the Android app, based on GitHub Releases. Pure functions + one network call, no DOM and
// no Capacitor, so everything here runs (and is tested) in Node. The native side lives in appUpdateNative.js.
//
// Flow: read the installed version -> GET /releases/latest (5 s budget, any failure = silently skip) ->
// semantic-version compare -> if newer, hand the release (version, changelog, APK link, SHA-256) to the UI.

export const DEFAULT_REPO = 'Karry1123/Half-Half-Music-Player';
export const CHECK_TIMEOUT_MS = 5000;

// ───────────────────────────────────────────────────────── semantic versioning (semver.org §11 precedence)

const SEMVER = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v1.2.3-beta.1+build5" -> { major, minor, patch, pre: ['beta', 1] }.  Missing minor / patch count as 0.  Invalid -> null. */
export function parseSemver(input) {
  const m = SEMVER.exec(String(input ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** -1 / 0 / 1.  Build metadata is ignored; a pre-release sorts below its release (1.0.0-rc.1 < 1.0.0).  Throws on invalid input. */
export function compareSemver(a, b) {
  const x = typeof a === 'object' && a ? a : parseSemver(a);
  const y = typeof b === 'object' && b ? b : parseSemver(b);
  if (!x || !y) throw new TypeError(`invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) {
    const c = cmp(x[k], y[k]);
    if (c) return c;
  }
  if (!x.pre.length || !y.pre.length) return cmp(y.pre.length, x.pre.length); // a release beats any pre-release
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1; // fewer identifiers = lower
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = typeof p === 'number';
    const qn = typeof q === 'number';
    if (pn && qn) return cmp(p, q);
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    return cmp(p, q);
  }
  return 0;
}

/** remote > local.  Unparseable versions never count as "newer" (so a weird tag cannot lock the app). */
export function isNewer(remote, local) {
  const r = parseSemver(remote);
  const l = parseSemver(local);
  return !!r && !!l && compareSemver(r, l) > 0;
}

/**
 * Builds from CI branches / manual runs are versioned 0.0.0-dev.N+sha, and a browser has no installed version at all.
 * Neither should ever be forced to update.
 */
export function isDevVersion(version) {
  const v = parseSemver(version);
  return !v || (v.major === 0 && v.minor === 0 && v.patch === 0 && v.pre[0] === 'dev');
}

// ───────────────────────────────────────────────────────── release -> update description

const sha256Of = (digest) => {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(digest ?? ''));
  return m ? m[1].toLowerCase() : null;
};

/** The APK to install: prefer app-release.apk, otherwise the first uploaded *.apk.  Returns null when there is none. */
export function pickApkAsset(assets) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && typeof a.name === 'string' && (a.state === undefined || a.state === 'uploaded') && a.browser_download_url);
  const apks = list.filter((a) => /\.apk$/i.test(a.name));
  if (!apks.length) return null;
  const asset = apks.find((a) => a.name === 'app-release.apk') || apks[0];
  const companion = list.find((a) => a.name === `${asset.name}.sha256`);
  return {
    name: asset.name,
    size: Number(asset.size) || 0,
    url: asset.browser_download_url,
    sha256: sha256Of(asset.digest), // GitHub computes this for every uploaded asset
    sha256Url: companion?.browser_download_url || null, // fallback when the API response lacks `digest`
  };
}

/** Release notes -> plain text for the dialog (the UI renders it as text, never as HTML). */
export function plainChangelog(body, max = 1200) {
  let t = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s*[*-]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) t = `${t.slice(0, max).trimEnd()}…`;
  return t;
}

/** GitHub release JSON -> what the UI needs, or null when it cannot be installed (draft, pre-release, no APK). */
export function releaseToUpdate(release) {
  if (!release || release.draft || release.prerelease || !release.tag_name) return null;
  const apk = pickApkAsset(release.assets);
  if (!apk) return null;
  return {
    tag: release.tag_name,
    version: String(release.tag_name).replace(/^v/i, ''),
    name: release.name || release.tag_name,
    notes: plainChangelog(release.body),
    pageUrl: release.html_url || null,
    publishedAt: release.published_at || null,
    apk,
  };
}

// ───────────────────────────────────────────────────────── network

/**
 * GET /repos/{repo}/releases/latest.  Never throws: offline, timeout, rate limit (403 / 429), 404 (no release yet),
 * bad JSON all resolve to null, so a weak network can never keep the user stuck on the splash screen.
 */
export async function fetchLatestRelease({ repo = DEFAULT_REPO, fetchImpl = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json(); // still covered by the abort timer: a stalled body is cut off too
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{status:'update', update:object} | {status:'current'} | {status:'skipped', reason:string}>}
 *   skipped reasons: 'dev-build' | 'unreachable' | 'no-apk' | 'bad-version'
 */
export async function checkForUpdate({ repo = DEFAULT_REPO, localVersion, fetchImpl, timeoutMs } = {}) {
  if (isDevVersion(localVersion)) return { status: 'skipped', reason: 'dev-build' };
  const release = await fetchLatestRelease({ repo, fetchImpl, timeoutMs });
  if (!release) return { status: 'skipped', reason: 'unreachable' };
  if (!parseSemver(release.tag_name)) return { status: 'skipped', reason: 'bad-version' };
  if (!isNewer(release.tag_name, localVersion)) return { status: 'current' };
  const update = releaseToUpdate(release);
  return update ? { status: 'update', update } : { status: 'skipped', reason: 'no-apk' };
}

// ───────────────────────────────────────────────────────── download addresses

/**
 * Where to download the APK from, in order: GitHub first, then optional mirrors ("https://mirror.example/" + original URL).
 * A mirror is a third party that could serve a tampered file, so mirrors are only offered when a SHA-256 is known
 * (the caller verifies it) -- and Android itself refuses to install an update that is not signed with the same key.
 */
export function downloadCandidates(url, { mirrors = [], haveSha256 = false } = {}) {
  const out = [url];
  if (!haveSha256) return out;
  for (const m of mirrors) {
    const prefix = String(m || '').trim();
    if (!/^https:\/\//i.test(prefix)) continue; // never downgrade to plain http
    out.push(prefix.endsWith('/') ? prefix + url : `${prefix}/${url}`);
  }
  return [...new Set(out)];
}

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('crypto.subtle is not available (needs a secure context)');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
