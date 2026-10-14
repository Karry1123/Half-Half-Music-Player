// Native half of the in-app updater (Android / Capacitor only). Talks to four plugins through Capacitor's
// registerPlugin(), so it works in the plain-HTML dashboard without a bundler:
//   App         @capacitor/app                      installed version, hardware back button
//   Filesystem  @capacitor/filesystem               download with progress, read for the SHA-256 check
//   FileOpener  @capacitor-community/file-opener    hands the APK to Android's package installer
//   Browser     @capacitor/browser                  fallback: download in the system browser
import { base64ToBytes, downloadCandidates, sha256Hex } from './appUpdate.js';

const APK_MIME = 'application/vnd.android.package-archive';
const DIR = 'CACHE';
const APK_PATH = 'update/app-release.apk';
const SHA_PATH = 'update/app-release.apk.sha256';

const cap = () => window.Capacitor;
export const isAndroidApp = () => !!(cap()?.isNativePlatform?.() && cap().getPlatform?.() === 'android');

let plugins;
const P = () =>
  (plugins ??= {
    App: cap().registerPlugin('App'),
    Filesystem: cap().registerPlugin('Filesystem'),
    FileOpener: cap().registerPlugin('FileOpener'),
    Browser: cap().registerPlugin('Browser'),
  });

/** versionName of the installed APK (the CI build sets it from the git tag), e.g. "1.2.0" */
export async function getInstalledVersion() {
  return (await P().App.getInfo()).version;
}

/** Swallow the hardware back button while the force-update dialog is up.  Returns a function that restores it. */
export async function blockBackButton() {
  const handle = await P().App.addListener('backButton', () => {});
  return () => handle.remove();
}

/** Plan A: let the system browser download the APK (the user then taps the finished download to install). */
export async function openInBrowser(url) {
  await P().Browser.open({ url });
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

async function removeCached(path) {
  try {
    await P().Filesystem.deleteFile({ path, directory: DIR });
  } catch {} // not there = fine
}

/** Delete a leftover APK from an earlier attempt (call on startup, whatever the update result was). */
export async function cleanStaleDownloads() {
  await removeCached(APK_PATH);
  await removeCached(SHA_PATH);
}

/** Companion "<apk>.sha256" asset ("<hex>  app-release.apk"), downloaded natively because the browser cannot fetch release assets (CORS). */
async function fetchCompanionSha(url) {
  const { Filesystem } = P();
  try {
    await Filesystem.downloadFile({ url, path: SHA_PATH, directory: DIR, recursive: true, connectTimeout: 10000, readTimeout: 10000 });
    const { data } = await Filesystem.readFile({ path: SHA_PATH, directory: DIR, encoding: 'utf8' });
    return /\b([0-9a-f]{64})\b/i.exec(String(data))?.[1].toLowerCase() || null;
  } catch {
    return null;
  } finally {
    await removeCached(SHA_PATH);
  }
}

/**
 * Plan B: download inside the app (with progress), verify the SHA-256, then open Android's package installer.
 * GitHub is tried first, then each mirror -- but only when a SHA-256 is known to check the file against.
 *
 * @param {object}   o
 * @param {object}   o.update       from appUpdate.releaseToUpdate()
 * @param {string[]} [o.mirrors]    optional https:// prefixes, e.g. "https://ghfast.top/"
 * @param {(phase:'downloading'|'verifying'|'installing', info?:object)=>void} [o.onPhase]
 * @param {(received:number, total:number)=>void} [o.onProgress]
 * @throws the last error when every address failed
 */
export async function downloadAndInstall({ update, mirrors = [], onPhase = () => {}, onProgress = () => {} }) {
  const { Filesystem, FileOpener } = P();
  const { apk } = update;
  const sha = apk.sha256 || (apk.sha256Url ? await fetchCompanionSha(apk.sha256Url) : null);
  const candidates = downloadCandidates(apk.url, { mirrors, haveSha256: !!sha });

  let lastError = new Error('no download address');
  for (const url of candidates) {
    await removeCached(APK_PATH);
    try {
      onPhase('downloading', { source: hostOf(url), mirrored: url !== apk.url });
      onProgress(0, apk.size);
      const listener = await Filesystem.addListener('progress', (e) => e.url === url && onProgress(e.bytes, e.contentLength || apk.size));
      try {
        await Filesystem.downloadFile({ url, path: APK_PATH, directory: DIR, recursive: true, progress: true, connectTimeout: 15000, readTimeout: 30000 });
      } finally {
        listener.remove();
      }

      if (sha) {
        onPhase('verifying');
        const { data } = await Filesystem.readFile({ path: APK_PATH, directory: DIR });
        const got = await sha256Hex(base64ToBytes(String(data)));
        if (got !== sha) throw new Error(`SHA-256 mismatch (${hostOf(url)})`);
      }

      onPhase('installing');
      const { uri } = await Filesystem.getUri({ path: APK_PATH, directory: DIR });
      await FileOpener.open({ filePath: uri, contentType: APK_MIME, openWithDefault: true });
      return { sha256Verified: !!sha };
    } catch (e) {
      lastError = e;
      await removeCached(APK_PATH); // never leave a half or tampered file behind
    }
  }
  throw lastError;
}
