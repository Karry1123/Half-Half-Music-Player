# Half&Half Music Player

**English** | [简体中文](README.zh-CN.md)

Two people, two devices, listening to the Host's music in sync. The Host's audio file is sent to the Guest over a WebRTC DataChannel; play / pause / seek stay in sync to within milliseconds. The Host can also search for and download the original artist's version from inside the page (see [music-service](music-service/README.md)).

**Try it online:** https://karry1123.github.io/Half-Half-Music-Player/dashboard.html (GitHub Pages; Android APK on the [Releases](https://github.com/Karry1123/Half-Half-Music-Player/releases) page)

Stack: React 18 + Vite 6 + Zustand 5 · native RTCPeerConnection · Web Audio API · Node.js WebSocket signaling

For production deployment (GitHub Pages / Vercel + Render + UptimeRobot keep-alive) see [DEPLOY.md](DEPLOY.md) (Chinese). For the Android APK see [Android app](#android-app) below.

## Run

```bash
npm install
npm run dev:all        # one command: page + signaling + music-service, prints test links and a phone QR code
npm run dev            # page + signaling only
npm test               # unit tests
npm run nat-check      # STUN / NAT self-check
```

For step-by-step testing, the debug panel (`?debug=1`), weak-network simulation (`?netsim=`) and the stability design, see **[TESTING.md](TESTING.md)** (Chinese).

### Single-file dashboard (`public/dashboard.html`)

An all-in-one page that needs no build step (React 18 + Tailwind + Lucide + PeerJS, all loaded from CDNs). Four modules share one screen: connection status bar / aggregated search and download / local library and queue / a persistent sync player at the bottom.

It opens on the **lobby** with three entries:

- **A. Solo listening**: no room; go straight to your personal library and search. Local import lives here too.
- **B. Create a duo room**: room code / QR code / copy link / waiting animation.
- **C. Join a friend's room**: 6-character segmented input, paste an invite link to auto-detect it, quick reconnect.

Below the entries:

- **My library** shelf: songs you downloaded before load automatically, with a "cached" badge.
- Global search and direct-link extraction: paste a Bilibili link / BV id / b23 short link / YouTube link and it is recognized immediately. An extraction card shows the cover, author, duration, view count, and the bitrate and size of every quality tier, and you can pick one to download.

You can browse songs while waiting for your partner; once they join, both of you switch to the player automatically.

- **Connection management**:
  - TURN relays are served by the backend's `/ice.json`. Metered, Cloudflare and self-hosted coturn (with short-lived credentials) are supported. You can also enter TURN settings in the page's "Connection settings" and test whether they work.
  - Two-way heartbeat; 3 seconds of silence triggers a seamless automatic reconnect, and the music keeps playing.
  - The top bar and player bar show the actual path (LAN / direct P2P / TURN relay), round-trip latency and sync drift.
  - For cross-border setups see [TESTING.md](TESTING.md), section "D. Cross-network / cross-border connections".

- After `npm run dev:all`, open `http://localhost:8080/dashboard.html`: it connects to music-service automatically.
- Double-click the file or use any static server: demo mode (mock search; "download" synthesizes a playable demo clip).
- Duo pairing uses the public PeerJS signaling server (`?room=ROOMCODE` joins as Guest automatically). Use `?peerHost=&peerPort=` to point at your own PeerServer.
- Phones and other non-Host devices cannot reach music-service (it only listens for the Host computer itself), so they enter "search via Host" mode: after joining a room, search / download requests go over P2P to the Host computer, the downloaded songs land in the Host's library and are synced to both sides.
- **On-device offline library** ([`public/libraryStorage.js`](public/libraryStorage.js), IndexedDB, dependency-free, importable from any framework):
  - Downloaded songs (audio + cover + metadata) are stored in the browser and the playlist is restored when the page opens. Audio is loaded lazily, never all into memory at once.
  - Local files you drop in or pick are saved too when "also cache to the local library when importing" is ticked (on by default).
  - Content-fingerprint dedupe (file size + head / middle / tail samples, pure JS, works on a phone over plain-http LAN addresses): a renamed file is still recognized. If a Guest already has the song, the Host switches to it and the Guest uses its local copy instead of a P2P transfer.
  - On a phone (Guest) every row has "save to this device"; when you tap download on the phone, the Host downloads the song and then sends a copy to the phone.
  - A "Local library" panel: sort by date added / size / title, delete single songs, export to files (desktop Chrome / Edge can pick a save location or a whole folder, other browsers use a normal download), storage usage and "request persistent storage".
  - iOS Safari clears site data after 7 days without a visit; the panel suggests "Add to Home Screen".
- **Playlists** (logic in [`public/playlists.js`](public/playlists.js), covered by `tests/playlists.test.mjs`):
  - Stored next to the tracks: IndexedDB store `playlists` on the web (database v2), `playlists-v1.json` on Android. A playlist only references `tracks.id`, so deleting a playlist never deletes audio, and deleting a song removes it from every playlist.
  - Built-in: "全部已下载 / 已导入" (virtual, always the whole library) and "默认曲库" (the "sort later" inbox; cannot be renamed or deleted). On first launch after upgrading, every existing song is moved into 默认曲库, so nothing is lost.
  - Downloading a search result, extracting a link, or importing / dropping files first asks which playlists to put the song in (you can create one right there, or tick "don't ask again"). Each song's "⋯" menu offers "add to playlist", "remove from this playlist" and "delete from device".
  - Solo: "播放全部" (or double-clicking a song inside a playlist) replaces the play queue with that playlist; next / previous / shuffle / repeat stay inside it.
  - Room: the Host's "在房间中播放" broadcasts `set_playlist`; both sides show "正在与对方一起收听歌单：【name】" and the Guest's list matches the Host's queue. While a song plays, the Guest prefetches the next song in the playlist, so a track change needs no transfer wait.
- **Play modes and solo / duo** (queue algorithm in [`public/playQueue.js`](public/playQueue.js), pure logic, covered by `tests/playQueue.test.mjs`):
  - Sequential / loop all / loop one / shuffle. Shuffle does not reorder the playlist; it keeps its own shuffled order: each song plays once per round, and a new round never starts with the song that just finished. "Previous" goes back to what you actually heard, then "next" retraces the same path. Songs added mid-round are heard in the current round.
  - Solo mode: the "Solo listening" entry creates no room and makes no WebRTC connection; it plays your on-device library directly.
  - Duo mode: only the Host can change the play mode; it is broadcast with the playlist. The Guest sees the Host's mode and a "next up" preview. Track switches still go through the data channel and make the Guest buffer and switch.
  - System media controls (MediaSession): lock screen / notification shade / headset buttons / keyboard media keys, with cover, artist and a seekable progress bar. A Guest's key presses become requests to the Host.
  - Returning from the background: the Guest first fires a burst of pings to re-measure the clock, then asks the Host for the state and hard-aligns to it. If the connection dropped in the background it reconnects with the room code. A Host / solo player interrupted by a phone call resumes from where it stopped.
- Difference from the main app: it uses HTML5 Audio + PeerJS, which suits quick demos and sharing. The main (Vite) app has sample-accurate scheduling, play-while-receiving, self-hosted signaling and a debug panel.

The search / download feature needs another terminal (on the Host computer only):

```bash
cd music-service
npm install
npm run setup:ytdlp
npm start              # http://127.0.0.1:8090
```

Production: `npm run build && npm start` (`server/index.js` serves `dist/` + signaling + the `/music-api` proxy). Public use needs HTTPS; behind a symmetric NAT you need to configure TURN in `src/lib/rtc.js`.

> The project path contains `&`. On Windows npm's `.cmd` wrappers treat `&` as a command separator, so the scripts call `node node_modules/vite/bin/vite.js` directly.

## Android app

[Capacitor](https://capacitorjs.com) wraps the single-file dashboard (`public/dashboard.html`) into a native APK. The app opens straight into the dashboard, and the backend address is baked in at build time (`MUSIC_API_URL`).

| Part | Where |
|---|---|
| Capacitor config | [`capacitor.config.json`](capacitor.config.json) (package `com.halfhalf.musicplayer`, `webDir: dist`) |
| Android project | [`android/`](android/) (committed; no need to run `cap add`) |
| Permissions and service declarations | [`android/app/src/main/AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) |
| Background playback (foreground service) | `NativeFG` in `public/dashboard.html`, plugin `@capawesome-team/capacitor-android-foreground-service` |
| Cloud build | [`.github/workflows/build-apk.yml`](.github/workflows/build-apk.yml) |

### Permissions

| Permission | Purpose |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | Reach the backend, WebRTC, network state |
| `WAKE_LOCK` | Keep the CPU awake while playing |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | Foreground service for background playback (type `mediaPlayback`; Android 14+ requires a declared type) |
| `POST_NOTIFICATIONS` | Playback notification (Android 13+ asks on the first play; if denied the service still runs, you just don't see the notification) |
| `READ_EXTERNAL_STORAGE` (up to Android 12), `WRITE_EXTERNAL_STORAGE` (up to Android 9) | Saving / exporting songs on old systems. Android 10+ uses the system file picker and needs no permission, which is why `READ_MEDIA_AUDIO` is not requested |

Cleartext traffic: release builds allow HTTPS only, with exceptions for `localhost`, `127.0.0.1` and `10.0.2.2` (the host machine as seen from the emulator). Debug builds allow all HTTP through `src/debug/AndroidManifest.xml`, handy for a backend on your LAN such as `http://192.168.1.10:8090`. The WebView page itself is `https://localhost`, so calling an http backend also triggers mixed-content blocking: change `server.androidScheme` in `capacitor.config.json` to `http` before building the debug app.

### Build locally

You need Node 22+, JDK 21 (Capacitor 8's Android library is compiled for Java 21; JDK 17 will not work) and the Android SDK (`ANDROID_HOME`, or `sdk.dir=…` in `android/local.properties`).

```bash
# MUSIC_API_URL is the public backend address (public address only, never the token)
MUSIC_API_URL=https://your-backend.example.com npm run cap:sync   # build the web app and sync it into android/
node scripts/gradle.mjs assembleDebug                             # -> android/app/build/outputs/apk/debug/app-debug.apk
node scripts/gradle.mjs assembleRelease                           # -> .../release/app-release.apk (debug-signed unless a key is configured)
```

The project path contains `&` (Windows), so use `scripts/gradle.mjs` instead of running `gradlew` directly. To use Android Studio, run `npm run cap:sync` and open the `android/` folder.

### Cloud build (GitHub Actions)

| Trigger | Result |
|---|---|
| Push a tag such as `v1.2.3` | `assembleRelease`; the APK and its SHA-256 are attached to that tag's GitHub Release (version name `1.2.3`, versionCode `10203`) |
| Push to `main` | `assembleDebug`, kept as a workflow artifact for 14 days (docs-only changes do not trigger it) |
| Manual run | choose debug or release |

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Repository settings (Settings → Secrets and variables → Actions):

| Name | Kind | Description |
|---|---|---|
| `MUSIC_API_URL` | Variable | Public backend address, baked into the app. Shared with the web deployment |
| `SIGNAL_URL`, `ICE_URL` | Variable | Optional; derived from `MUSIC_API_URL` by default |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Secret | Optional. If set, the APK is signed with your release key; otherwise the debug key is used (installable for testing, but not for app stores, and a later build signed with a real key cannot update it) |

Create a release key:

```bash
keytool -genkeypair -v -keystore release.jks -alias halfhalf -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.jks     # put the output into ANDROID_KEYSTORE_BASE64; *.jks is in .gitignore, never commit it
```

### Let the backend accept the app

The page origin inside the app is `https://localhost`, so add it to the backend's `CORS_ORIGINS`:

```
CORS_ORIGINS=https://your-site.vercel.app,https://localhost
```

The access token `API_TOKEN` is **not** built into the APK (an APK is a public file). On first launch enter it under "Connection settings → Music service"; it is stored only on the phone.

### Forced update on launch (GitHub Releases)

On every launch the app requests `https://api.github.com/repos/<owner>/<repo>/releases/latest` and compares the latest release's `tag_name` (e.g. `v1.2.0`) with the installed version using semantic versioning. If the remote version is newer, a **non-dismissible** "New version available" dialog appears. It shows the current and latest version and the release notes, has no close button, ignores backdrop taps, Esc and the back key, and offers only **Update now**.

| Part | Where |
|---|---|
| Version compare, release parsing, 5 s timeout (pure functions, unit-tested) | [`public/appUpdate.js`](public/appUpdate.js), [`tests/appUpdate.test.mjs`](tests/appUpdate.test.mjs) |
| Native download / verify / install | [`public/appUpdateNative.js`](public/appUpdateNative.js) |
| The dialog and the `useAppUpdate` hook | `UpdateGate` in `public/dashboard.html` |

- **Local version** is read from the installed APK's `versionName` (CI writes it from the tag: `v1.2.0` → `1.2.0`); nothing is hard-coded.
- **Update now**: downloads the release's `.apk` inside the app (with a progress bar), verifies it against the SHA-256 GitHub provides, then opens Android's package installer. The first time, you must allow this app to "install unknown apps" in system settings. On failure an "open in browser instead" link opens the APK URL in the system browser.
- **Slow GitHub downloads (e.g. mainland China)**: set the repository variable `UPDATE_MIRRORS` at build time (comma-separated, e.g. `https://ghfast.top/`). GitHub is tried first, then each mirror. A mirror is a third party, so it is **only used when a SHA-256 is known**, and a file that fails the check is discarded.
- **Fault tolerance**: offline, GitHub rate limit, no response within 5 s, no release yet, or no APK in the release all skip silently and never block startup. CI test builds (`0.0.0-dev.*`) and plain browsers do not check for updates.
- **Published releases only**: `latest` excludes drafts and pre-releases. To ship: `git tag v1.2.0 && git push origin v1.2.0`; the workflow publishes `app-release.apk`, and older installs then get the update on their next launch.

> **Sign with a fixed release key, or updates will not install.** Android only lets a package replace an installed one if both are signed with the same key. Without the `ANDROID_KEYSTORE_*` secrets every build uses a freshly generated debug key, so the new version fails with a "conflicts with an existing package" error. Create the release key as described above and store it in the repository secrets before shipping the first public version, and keep a separate backup of the key file: if you lose it you can no longer update installed copies.

### Known limitations

- The dashboard loads React, Tailwind etc. from CDNs, so the first launch needs internet access.
- Background playback relies on the foreground service. Some Chinese ROMs (MIUI, ColorOS, ...) also need "autostart / unrestricted battery" enabled for the app in system settings.
- "Export to file" may not work inside the Android WebView (limited `a[download]` support for blobs).
- There is no in-app auto-update; download new versions from GitHub Releases.
- The workflow and the Android project have not been fully built on the author's machine (no Android SDK installed); check the Actions log the first time you push a tag.

## Architecture

```
Browser (Host / Guest run the same code)
┌──────────────────────────────────────────────────────────────┐
│ React components (read the store, call engine methods)         │
│   ↑ useSession / useMusic (Zustand)                            │
│ engine/session.js  ── sync protocol, playlist, notices         │
│   ├ lib/signaling.js   WebSocket signaling                     │
│   ├ lib/rtc.js         RTCPeerConnection (ctrl + file channels)│
│   ├ lib/clock.js       NTP-style clock sync                    │
│   ├ lib/transfer.js    chunked file transfer (backpressure)    │
│   └ lib/player.js      Web Audio scheduled playback + volume   │
│                        + spectrum                              │
│ engine/musicApi.js ── /music-api (Host machine only)           │
└──────────────────────────────────────────────────────────────┘
        │ /ws                              │ /music-api (loopback only)
   server/signaling.js               server/musicProxy.js → music-service :8090
   (mounted on Vite in dev, on server/index.js in production)
```

### Components

| Component | Responsibility |
|---|---|
| `App` | Lobby / room switching; Host full-window drag-and-drop; space bar toggles play/pause |
| `Lobby` | Nickname + avatar color; create a room / join with a room code (`?room=` invite links pre-fill it) |
| `ConnectionBar` | Room code (copy invite link), role, connection light (waiting / connecting / same channel / lost), ping bars (hover for clock offset and playback drift), search entry |
| `NowPlaying` | Spinning vinyl cover `CoverDisc`, live spectrum `Visualizer` (AnalyserNode), duo avatars `DuoAvatars` (a line flows between them while playing in sync), transfer / buffering status `TransferLine` |
| `PlayerControls` | Previous / play / next, seek bar `SeekBar` (dragging only previews; the seek is broadcast on release), local volume `VolumeControl` |
| `Playlist` | Host library (downloaded) + local files; equalizer animation on the current track; a Guest's click = ask the Host to switch |
| `SearchDrawer` | Search, source filter, original-only / all, format; results carry version labels and quality labels (FLAC / 320k / M4A ≈128k) and the original page link; per-item download progress + download queue (SSE) |
| `Toasts` | Sync notices: "Evening Wind dragged the progress to 01:30" |

### State management

Two Zustand stores, each with a **single writer**:

- `useSession`: written only by `engine/session.js`. Connection (role, peerState, rtt, offset, drift, peer profile), current track, playback state, playlist, transfer progress, notices.
- `useMusic`: search parameters and results, download tasks (pushed over SSE), the library. When the library changes the engine subscribes, merges it into the playlist, and syncs it to the Guest.

Components only read through selectors; every action goes through `engine.act(...)` and friends. The Host executes directly, and a Guest's call is turned into a `request` sent to the Host. **The high-frequency playback position is not in the store**: `usePlaybackPosition()` reads `engine.position()` per frame in the few small components that need it, avoiding re-renders of the whole tree.

### Sync protocol (ctrl DataChannel)

The Host is the only authority. Playback state = an anchor `{ trackId, playing, position, at }` (at Host time `at`, the position was `position`).

| Message | Direction | Description |
|---|---|---|
| `hello` | both | Nickname, avatar color |
| `playlist` | H→G | Playlist metadata |
| `track` | H→G | Track switch (`by` = initiator, `quiet` = automatic action, no notice) |
| `need_file` / `track_ready` | G→H | Guest has no cache and asks for a transfer / has decoded and can play |
| `play` `pause` `seek` | H→G | Anchor; `at` is placed in the future by `clamp(1.5·RTT+60, 120, 1000)` ms |
| `state` | H→G | Heartbeat anchor every second; the Guest re-aligns when drift exceeds 30 ms |
| `request` | G→H | Guest's play / pause / seek / next / prev / select |
| `sync_ping` / `sync_pong` | G↔H | NTP-style clock sync |

Track switch flow: the Host sends `track` → the Guest decodes straight away on a cache hit (last 6 songs), otherwise sends `need_file` → the Host sends chunks → the Guest decodes and sends `track_ready` → the Host starts playback (waiting at most 15 seconds).

## Verified

Two tabs on one machine (Host + Guest):
- Create / join a room, P2P connection, nickname exchange, playlist sync
- Guest picks a song → Host loads the library file → 3.3 MB transferred → Guest decodes → both start together
- Host seeks to 01:30: the two playback positions differ by 0.8 ms at the same instant (engine-measured drift 0.04 ms)
- Guest drags the seek bar → the Host shows a notice "Evening Wind dragged the progress to 01:30"
- Drawer search "后来 刘若英" → download the JLRS-LeoFM original from Bilibili → added to the playlist as "劉若英 - 後來.m4a" and synced to the Guest
- `vite build` passes; no horizontal overflow at 375 px width

## Known limitations

- A Guest cannot search or download directly (music-service is open only to the Host machine); they can only pick from the Host's playlist
- Dropped-in local files do not have their ID3 tags read; the title comes from the file name (the "artist - title" form is split automatically)
- Refreshing the page leaves the room (P2P drops trigger an automatic ICE restart, but a lost signaling connection is not re-established)
- FLAC / non-fragmented MP4 cannot be played while still downloading; they play after being fully received
