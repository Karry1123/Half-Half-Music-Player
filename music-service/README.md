# Half&Half music-service

**English** | [简体中文](README.zh-CN.md)

Aggregated search + download service. Core goal: **give you the original artist's version only**. It runs on the Host machine, stores downloaded audio in `downloads/`, and the player reads it through `/api/library` + `/files/*`.

> For personal study and for listening to publicly available content only. Before downloading, make sure it complies with each platform's terms of service and the copyright law where you live. This service does not bypass any paywall or membership restriction.

## Run

```bash
cd music-service
npm install
npm run setup:ytdlp     # installs yt-dlp into .venv (picks the newest Python on the machine)
npm start               # http://127.0.0.1:8090  (comes with a debug page)
```

Optional: install [ffmpeg](https://ffmpeg.org/) and add it to PATH (or set `FFMPEG_PATH`) to transcode to mp3 and embed covers / tags. Without ffmpeg the raw audio stream (m4a) is saved, which browsers and the sync player can play directly.

### Environment variables

Put them in `music-service/.env` (copy [`.env.example`](.env.example); every entry is explained there). System environment variables take precedence; relative paths are resolved against the music-service directory.

| Variable | Default | Description |
|---|---|---|
| `PROXY_URL` | inherits `HTTPS_PROXY` | **YouTube proxy**, required when deployed in mainland China. `http://127.0.0.1:7890` / `socks5h://127.0.0.1:7890`. yt-dlp and YouTube Music search use it; Bilibili does not |
| `COOKIE_PATH` | empty | **Bilibili cookie file** (Netscape cookies.txt / JSON exported by an extension / one line `SESSDATA=…; bili_jct=…`). A premium (大会员) account can resolve Hi-Res lossless. The file is reloaded automatically when it changes |
| `BILIBILI_COOKIE` | empty | Same, as a cookie string (use either this or the file) |
| `YT_COOKIE_PATH` | empty | Optional. YouTube cookies.txt, for "Sign in to confirm you're not a bot" |
| `BILIBILI_PROXY` | empty | Only needed for overseas deployments; Bilibili is reached directly by default |
| `BILI_MIN_INTERVAL` | `300` | Minimum interval between Bilibili API requests (ms); raise it if risk control triggers often |
| `BILI_TRUSTED_UPS` | `音乐私藏馆,JLRS-LeoFM` | Comma-separated uploaders who specialize in re-uploading originals: they get a "trusted uploader" tag and sort first |
| `PORT` / `HOST` | `8090` / `127.0.0.1` | Local access only by default (the service writes to disk) |
| `DOWNLOAD_DIR` | `./downloads` | |
| `MAX_DOWNLOADS` | `2` | Concurrent downloads |
| `RESOLVE_TIMEOUT` / `STALL_TIMEOUT` | `30000` / `20000` | YouTube link resolve timeout / how long without data counts as a stalled download |
| `YTDLP_PATH` / `FFMPEG_PATH` | auto-detected | |
| `API_TOKEN`, `CORS_ORIGINS`, `RATE_LIMIT`, `ENABLE_SIGNALING`, `CACHE_DIR`, `YTDLP_JS_RUNTIMES`, `YTDLP_AUTO_UPDATE` | | Public deployment (Render / Docker). See [`.env.example`](.env.example) and [DEPLOY.md](../DEPLOY.md). Do not set them for local use |

`.env` and `cookies/` are in `.gitignore`. A cookie is as sensitive as a password: use only your own account and resolve only content you are entitled to listen to.

## Sources

| Source | Content | Search method | Speed |
|---|---|---|---|
| **YouTube Music** | Official tracks released by labels (Art Tracks), the most reliable source of originals | Web innertube API; one call returns artist / album / duration / view count | ~0.5s |
| **Bilibili** | MVs / lossless audio re-uploaded by uploaders (音乐私藏馆, JLRS-LeoFM, ...) | Native search API (wbi signature + device cookies), with uploader, view count, category | ~0.5s |
| **YouTube** | Official MVs, lyric videos | `yt-dlp ytsearch --flat-playlist` | ~2s |

Every result carries a `pageUrl`; on the debug page the title and "open original page ↗" jump there so you can check the version. Bilibili downloads go straight to the CDN (falling back to yt-dlp on failure); YouTube downloads go through yt-dlp.

**Removed: NetEase Cloud Music, QQ Music (Meting), SoundCloud.** Nearly all SoundCloud results are covers or re-uploads. In a test of 8 popular songs (告白气球, 晴天, 后来, 光年之外, 起风了, 稻香, Yellow, 海阔天空), the number of downloadable originals in NetEase's free catalog was 0; everything downloadable was a cover, DJ edit or speed-changed version, and the public Meting instances returned 404 for every QQ / Kugou direct link. NetEase is kept only as a clue for "original artist detection" (its `originCoverType` field explicitly marks original / cover).

## Original-version detection

### 1. Detecting the original artist (`canonical.js`)

- **YouTube Music official catalog**: among songs with the same title, the original is the one with the most plays (告白氣球 · 周杰倫 360M vs. covers with 2). It must have at least 50,000 plays and at least 5% of the top entry.
- **NetEase `originCoverType`**: `1` = original, accepted directly; `2` = cover, excluded directly (e.g. 起风了 · 周深).
- If the keyword contains an artist (`晴天 周杰伦`), only that artist counts. Different songs with the same title (起风了: 买辣椒也用券 / 吴青峰) are listed together.

### 2. Classifying each result's version (`lib/rank.js` `classify`)

| Version | Rule |
|---|---|
| `original` | Title contains the song name + the performer is the original artist + not a variant + duration at least 70% of the original |
| `variant` (other versions by the original artist) | Re-recordings / revisions by the original artist: "重生版 / 热爱版 / 新版 / acoustic / remaster" etc. in brackets |
| `live` | live / concert / gala, or uploaded by a TV station / variety channel |
| `unknown` (artist not stated) | The title matches but who sings it cannot be told |
| `cover` | Bilibili "cover" category; title contains 翻唱 / cover / 原唱：XX / 伴奏 / 变速 / 钢琴 / 鼓谱 / 街头…; or in "A - B" the performer side is not the original artist |
| `other` | Title does not match, or clearly a clip |

Text is normalized from Traditional to Simplified Chinese (`opencc-js`), so "後來" = "后来" and "鄧紫棋" = "邓紫棋".

Original results carry `song: { title, artist }` (canonical title + original artist), used as the file name and library title after download. For example the Bilibili video `在百万豪装录音棚大声听邓紫棋《光年之外》【Hi-res】` becomes `G.E.M. 鄧紫棋 - 光年之外.m4a` (the original video title, uploader and link are kept in the library).

### 3. Ranking

First by version (original → other versions → live → …); within a version: `keyword coverage 40 + log10(plays)×4 + official source 15 / official channel 8 + trusted uploader 10 + platform's native rank 0~5`

## API

### `GET /api/search?q=keyword[&versions=original|all][&sources=ytmusic,bilibili][&limit=10]`

`versions` defaults to `original`: only originals are returned; if the original artist cannot be identified, it falls back to all results with "artist not stated". `all` returns everything sorted by version.

```jsonc
{
  "query": "告白气球", "tookMs": 2000, "cached": false, "versions": "original",
  "originals": [{ "artist": "周杰倫", "plays": 360000000, "duration": 216, "evidence": ["YouTube Music 360000000 plays"] }],
  "counts": { "original": 12, "variant": 0, "live": 2, "unknown": 18, "cover": 22, "other": 18 },
  "total": 12, "hidden": 60,
  "sources": [
    { "source": "bilibili", "label": "哔哩哔哩", "ok": true, "count": 16, "originals": 7, "ms": 540 },
    { "source": "youtube", "ok": false, "code": "TIMEOUT", "error": "timed out (15000ms)" }
  ],
  "results": [{
    "id": "bilibili:BV1mL411E7Fb",            // pass this to /api/download
    "source": "bilibili", "sourceName": "哔哩哔哩",
    "title": "【4K60FPS】周杰伦《告白气球》超甜神曲！祝大家七夕快乐！",
    "artists": [], "uploader": "音乐私藏馆", "trusted": true, "category": "MV",
    "pageUrl": "https://www.bilibili.com/video/BV1mL411E7Fb",
    "duration": 211, "plays": 6459889, "cover": "https://i0.hdslb.com/...",
    "version": "original", "versionLabel": "original",
    "song": { "title": "告白氣球", "artist": "周杰倫" },
    "score": 81.7
  }]
}
```

Error codes: `TIMEOUT` timed out · `BLOCKED` risk control / rate limited · `UPSTREAM` platform error · `PARSE` API structure changed · `NOT_INSTALLED` yt-dlp missing · `PROXY` cannot reach the proxy · `BAD_INPUT` link not recognized · `UNAVAILABLE` video missing / no permission · `AUTH` cookie expired

### `GET /api/resolve?url=…`

Resolves a pasted link and returns the track info with the **audio quality tiers that really exist**. Supported: Bilibili BV id / av id / `bilibili.com/video/…?p=2` (multi-part) / `b23.tv` short links / app share text (`【title】 https://b23.tv/xxx`); YouTube `watch?v=` / `youtu.be` / `shorts` / `music.youtube.com`.

```jsonc
{
  "platform": "bilibili", "ms": 640,
  "track": { "id": "bilibili:BV1HP4y1X7ye", "title": "…《后来》【Hi-res】", "uploader": "JLRS-LeoFM", "duration": 340, "cover": "…", "pageUrl": "…" },
  "qualities": [   // best first; Bilibili ids are audio-track tiers, YouTube uses format_id
    { "id": 30251, "label": "Hi-Res lossless", "codec": "flac", "lossless": true, "vip": true, "bitrate": 1650, "size": 70123456 },
    { "id": 30280, "label": "192K", "codec": "aac", "bitrate": 246, "size": 10449645 }
  ],
  "best": 30251,
  "account": { "login": true, "name": "…", "vip": true, "vipLabel": "annual premium" },  // null for YouTube
  "hint": null,   // e.g. "not logged in, 192K at most; configure COOKIE_PATH (premium account) to resolve Hi-Res lossless"
  "pages": [{ "page": 1, "part": "…", "duration": 340 }]   // multi-part videos only
}
```

Bilibili audio tracks: `30251` Hi-Res lossless (FLAC, premium) · `30250` Dolby Atmos (E-AC-3, premium; Chrome / Firefox cannot play it, so it is never picked automatically) · `30280` 192K · `30232` 132K · `30216` 64K.

### `GET /api/stream?id=…[&quality=…]`

The server pulls the audio stream and forwards it (Bilibili needs a Referer and YouTube needs a proxy, which browsers cannot do). Supports `Range`, so it can be used directly as `<audio src>`. The upstream address is cached for 50 minutes and re-resolved automatically when it expires (403).

### `POST /api/download`

```jsonc
{ "id": "bilibili:BV1HP4y1X7ye", "format": "flac", "quality": 30251 }
{ "url": "https://b23.tv/xxxx", "format": "m4a" }        // a link can be given directly
```

| `format` | Bilibili | YouTube |
|---|---|---|
| `m4a` | AAC as is; lossless tracks are stored as m4a (FLAC-encoded, playable in browsers) | m4a track |
| `flac` | Lossless track remuxed to `.flac` (needs ffmpeg); lossy tracks are not converted | No lossless source; the original track is saved |
| `mp3` | Transcoded V0 (needs ffmpeg) | Transcoded (needs ffmpeg) |
| `best` / `original` | No conversion | No conversion |

When `quality` is omitted the highest tier is used (Dolby excluded). Without ffmpeg the original track is always saved and the job's `note` says so. Returns `202` new job / `200` already downloading / `200 {status:"exists"}` already in the library / `400` invalid parameters.

### Progress and library

- `GET /api/events`: SSE. Pushes `snapshot` on connect, then `job` on every change (`queued → downloading → processing → done | error`, with `progress`, `file`, `url`)
- `GET /api/downloads`, `GET /api/downloads/:id`: polling
- `GET /api/library`: downloaded tracks (with `sourceTitle`, `uploader`, `pageUrl`, `version`); `GET /files/<file name>`: audio (supports Range)

## Risk control, timeouts and fallbacks

**Bilibili**
- On first use it requests device cookies (buvid3 / buvid4) and visits the home page once to "warm up"; the wbi signing key refreshes every 6 hours; video-info and audio-track endpoints are wbi-signed.
- All Bilibili API requests are serialized and rate limited (default 300 ms interval + random jitter) so concurrent requests do not trigger risk control.
- Explicit risk control (412 / -352 / -509): switch to a fresh set of device cookies (a login cookie is kept) + exponential backoff, 2 retries. Silent risk control (success but empty results) is retried with new cookies as well. If it still fails the source is marked `BLOCKED` and the other sources return as usual.
- Cookie check on startup: an expired `SESSDATA` is reported in the log so you can re-export it.

**Download (direct CDN)**
- Connect timeout 10 s; once a response arrives, 20 s without data counts as a stall, so it aborts and **resumes** (`Range: bytes=received-`).
- Drop / timeout: resume on the same address up to 4 times. 403 / 404 / host unreachable: switch to a backup address at once. PCDN nodes (mcdn / szbdyd / bare IPs) are ordered after official CDNs.
- All addresses dead: re-resolve the audio-track address once and retry; if it still fails, fall back to yt-dlp (with the same cookie).
- Written to `downloads/.partial/` first and renamed when complete, so a failure leaves no half file behind.

**YouTube**
- yt-dlp always runs with `--socket-timeout 15 --retries 3 --extractor-retries 2`; link resolving has an overall 30 s timeout.
- The proxy port is probed first (2 s); if the proxy is down it returns a `PROXY` error immediately instead of waiting through yt-dlp's retries for ten-odd seconds.
- "Sign in to confirm you're not a bot": change the proxy node first, then consider `YT_COOKIE_PATH`.

`npm test` verifies resume / stall / address switching / servers without Range support, using a local server that fails on purpose.

## Known limitations

- Original-artist detection relies on YouTube Music play counts: extremely famous covers (e.g. 海阔天空 by 信樂團) also have high play counts and are treated as one of the originals
- For obscure songs without enough YouTube Music plays the original cannot be identified; all results with "artist not stated" are shown and the user must check by following the link
- Video-platform titles vary endlessly, so rule-based classification can never be 100% accurate; the "all versions" view shows the filtered-out entries with their labels
- Download jobs are kept in memory and lost on restart (the library file `library.json` is kept)
