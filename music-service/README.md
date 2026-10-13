# Half&Half music-service

聚合搜索 + 下载服务。核心目标：**只给你歌手原版**。运行在 Host 本机，下载的音频存入 `downloads/`，播放器可通过 `/api/library` + `/files/*` 读取。

> 仅用于个人学习与收听公开可得的内容。下载前请确认符合各平台服务条款及所在地版权法规；本服务不绕过任何付费/会员限制。

## 运行

```bash
cd music-service
npm install
npm run setup:ytdlp     # 在 .venv 中安装 yt-dlp（自动选用本机最新的 Python）
npm start               # http://127.0.0.1:8090  （自带调试页面）
```

可选：安装 [ffmpeg](https://ffmpeg.org/) 并加入 PATH（或设 `FFMPEG_PATH`），才能转码为 mp3 并嵌入封面/标签。没有 ffmpeg 时保存原始音频流（m4a），浏览器与同步播放器都能直接播放。

### 环境变量

可以写在 `music-service/.env` 里（复制 [`.env.example`](.env.example)，里面每一项都有说明）。系统环境变量优先；相对路径按 music-service 目录解析。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_URL` | 继承 `HTTPS_PROXY` | **YouTube 代理**，国内部署必填。`http://127.0.0.1:7890` / `socks5h://127.0.0.1:7890`。yt-dlp 与 YouTube Music 搜索都走它，B 站不走 |
| `COOKIE_PATH` | 空 | **B 站 Cookie 文件**（Netscape cookies.txt / 扩展导出的 JSON / 一行 `SESSDATA=…; bili_jct=…`）。大会员账号可解析 Hi-Res 无损。文件修改后自动重新加载 |
| `BILIBILI_COOKIE` | 空 | 同上，直接写 Cookie 字符串（与文件二选一） |
| `YT_COOKIE_PATH` | 空 | 可选。YouTube cookies.txt，遇到 "Sign in to confirm you're not a bot" 时用 |
| `BILIBILI_PROXY` | 空 | 仅海外部署需要，B 站默认直连 |
| `BILI_MIN_INTERVAL` | `300` | B 站 API 请求最小间隔（毫秒），被风控频繁时调大 |
| `BILI_TRUSTED_UPS` | `音乐私藏馆,JLRS-LeoFM` | 逗号分隔，专门搬运原版的 UP 主：打"收藏UP"标记并优先排序 |
| `PORT` / `HOST` | `8090` / `127.0.0.1` | 默认仅本机可访问（服务会写磁盘） |
| `DOWNLOAD_DIR` | `./downloads` | |
| `MAX_DOWNLOADS` | `2` | 同时下载数 |
| `RESOLVE_TIMEOUT` / `STALL_TIMEOUT` | `30000` / `20000` | YouTube 链接解析超时 / 下载时多久收不到数据算卡死 |
| `YTDLP_PATH` / `FFMPEG_PATH` | 自动探测 | |

`.env` 和 `cookies/` 已加入 `.gitignore`。Cookie 等同于账号密码，只用你自己的账号、只解析你有权收听的内容。

## 音源

| 音源 | 内容 | 搜索方式 | 速度 |
|---|---|---|---|
| **YouTube Music** | 唱片公司上架的官方音轨（Art Track），原版最可靠的来源 | 网页端 innertube 接口，一次拿到歌手/专辑/时长/播放量 | ~0.5s |
| **哔哩哔哩** | UP 主搬运的 MV / 无损音源（音乐私藏馆、JLRS-LeoFM 等） | 原生搜索接口（wbi 签名 + 设备 Cookie），带 UP 主、播放量、分区 | ~0.5s |
| **YouTube** | 官方 MV、歌词视频 | `yt-dlp ytsearch --flat-playlist` | ~2s |

所有结果都带 `pageUrl`，调试页面里标题和"打开原页面 ↗"可直接跳转核对版本。B 站下载直连 CDN（失败降级 yt-dlp），YouTube 下载走 yt-dlp。

**已移除：网易云、QQ 音乐（Meting）、SoundCloud。** SoundCloud 结果几乎都是翻唱/搬运。 实测 8 首热门歌（告白气球、晴天、后来、光年之外、起风了、稻香、Yellow、海阔天空）在网易云免费曲库中可下载的原唱为 0，能下载的全是翻唱/DJ/变速版；公共 Meting 实例解析 QQ/酷狗直链全部 404。网易云仅保留为"原唱识别"的线索（其 `originCoverType` 字段明确标注原唱/翻唱）。

## 原版识别

### 1. 识别原唱（`canonical.js`）

- **YouTube Music 官方曲库**：同名歌曲按播放量取原唱（告白氣球·周杰倫 3.6 亿 vs 翻唱 2 次）。播放量 ≥ 5 万且 ≥ 头部的 5% 才算
- **网易云 `originCoverType`**：`1` 原唱直接认定；`2` 翻唱直接排除（如 起风了·周深）
- 关键词带歌手（`晴天 周杰伦`）时只认该歌手；同名不同歌（起风了：买辣椒也用券 / 吴青峰）会同时列出

### 2. 给每条结果判定版本（`lib/rank.js` `classify`）

| 版本 | 判定 |
|---|---|
| `original` 原版 | 标题含歌名 + 演唱者是原唱 + 非变体 + 时长不短于原版 70% |
| `variant` 原唱其他版本 | 原唱的重录/改版：括号里的"重生版 / 热爱版 / 新版 / acoustic / remaster"等 |
| `live` 现场 | live / 演唱会 / 晚会，或电视台/综艺频道上传 |
| `unknown` 未标明原唱 | 歌名对上但看不出谁唱的 |
| `cover` 翻唱/改编 | B 站"翻唱"分区；标题含 翻唱 / cover / 原唱：XX / 伴奏 / 变速 / 钢琴 / 鼓谱 / 街头…；或"A - B"中演唱者一侧不是原唱 |
| `other` 无关 | 歌名对不上，或明显是片段 |

文本统一做繁→简转换（`opencc-js`），"後來"="后来"、"鄧紫棋"="邓紫棋"。

原版结果会附带 `song: { title, artist }`（规范歌名 + 原唱），下载后用作文件名和曲库标题：
B 站 `在百万豪装录音棚大声听邓紫棋《光年之外》【Hi-res】` → `G.E.M. 鄧紫棋 - 光年之外.m4a`（原视频标题、UP 主、链接保存在曲库里）。

### 3. 排序

先按版本（原版 → 其他版本 → 现场 → …），同版本内：`关键词覆盖 40 + log10(播放量)×4 + 官方音源 15 / 官方频道 8 + 收藏UP 10 + 平台原始排序 0~5`

## 接口

### `GET /api/search?q=关键词[&versions=original|all][&sources=ytmusic,bilibili][&limit=10]`

`versions` 默认 `original`：只返回原版；未能识别原唱时退化为全部"未标明原唱"的结果。`all` 返回全部并按版本排序。

```jsonc
{
  "query": "告白气球", "tookMs": 2000, "cached": false, "versions": "original",
  "originals": [{ "artist": "周杰倫", "plays": 360000000, "duration": 216, "evidence": ["YouTube Music 360000000 次播放"] }],
  "counts": { "original": 12, "variant": 0, "live": 2, "unknown": 18, "cover": 22, "other": 18 },
  "total": 12, "hidden": 60,
  "sources": [
    { "source": "bilibili", "label": "哔哩哔哩", "ok": true, "count": 16, "originals": 7, "ms": 540 },
    { "source": "youtube", "ok": false, "code": "TIMEOUT", "error": "超时（15000ms）" }
  ],
  "results": [{
    "id": "bilibili:BV1mL411E7Fb",            // 传给 /api/download
    "source": "bilibili", "sourceName": "哔哩哔哩",
    "title": "【4K60FPS】周杰伦《告白气球》超甜神曲！祝大家七夕快乐！",
    "artists": [], "uploader": "音乐私藏馆", "trusted": true, "category": "MV",
    "pageUrl": "https://www.bilibili.com/video/BV1mL411E7Fb",
    "duration": 211, "plays": 6459889, "cover": "https://i0.hdslb.com/...",
    "version": "original", "versionLabel": "原版",
    "song": { "title": "告白氣球", "artist": "周杰倫" },
    "score": 81.7
  }]
}
```

错误码：`TIMEOUT` 超时 · `BLOCKED` 风控/限流 · `UPSTREAM` 平台异常 · `PARSE` 接口结构变化 · `NOT_INSTALLED` 缺少 yt-dlp · `PROXY` 代理连不上 · `BAD_INPUT` 链接无法识别 · `UNAVAILABLE` 视频不存在/无权限 · `AUTH` Cookie 失效

### `GET /api/resolve?url=…`

解析粘贴的链接，返回曲目信息与**真实可用的音质档位**。支持：B 站 BV 号 / av 号 / `bilibili.com/video/…?p=2`（多 P）/ `b23.tv` 短链 / App 分享文案（`【标题】 https://b23.tv/xxx`）；YouTube `watch?v=` / `youtu.be` / `shorts` / `music.youtube.com`。

```jsonc
{
  "platform": "bilibili", "ms": 640,
  "track": { "id": "bilibili:BV1HP4y1X7ye", "title": "…《后来》【Hi-res】", "uploader": "JLRS-LeoFM", "duration": 340, "cover": "…", "pageUrl": "…" },
  "qualities": [   // 从高到低；B 站 id 为音轨档位，YouTube 为 format_id
    { "id": 30251, "label": "Hi-Res 无损", "codec": "flac", "lossless": true, "vip": true, "bitrate": 1650, "size": 70123456 },
    { "id": 30280, "label": "192K", "codec": "aac", "bitrate": 246, "size": 10449645 }
  ],
  "best": 30251,
  "account": { "login": true, "name": "…", "vip": true, "vipLabel": "年度大会员" },  // YouTube 为 null
  "hint": null,   // 例如 "未登录，最高 192K；配置 COOKIE_PATH（大会员账号）可解析 Hi-Res 无损"
  "pages": [{ "page": 1, "part": "…", "duration": 340 }]   // 仅多 P 视频
}
```

B 站音轨：`30251` Hi-Res 无损（FLAC，大会员）· `30250` 杜比全景声（E-AC-3，大会员；Chrome/Firefox 不能播放，不会被自动选中）· `30280` 192K · `30232` 132K · `30216` 64K。

### `GET /api/stream?id=…[&quality=…]`

服务端代拉音频流并转发（B 站要 Referer、YouTube 要代理，浏览器做不到），支持 `Range`，可以直接作为 `<audio src>`。地址缓存 50 分钟，过期（403）自动重新解析。

### `POST /api/download`

```jsonc
{ "id": "bilibili:BV1HP4y1X7ye", "format": "flac", "quality": 30251 }
{ "url": "https://b23.tv/xxxx", "format": "m4a" }        // 也可以直接给链接
```

| `format` | B 站 | YouTube |
|---|---|---|
| `m4a` | AAC 原样；无损音轨存为 m4a（FLAC 编码，浏览器可播） | m4a 音轨 |
| `flac` | 无损音轨转封装为 `.flac`（需 ffmpeg）；有损音轨不转 | 无无损源，保存原始音轨 |
| `mp3` | 转码 V0（需 ffmpeg） | 转码（需 ffmpeg） |
| `best` / `original` | 不做转换 | 不做转换 |

`quality` 省略时取最高档（不含杜比）。缺少 ffmpeg 时一律保存原始音轨，并在任务的 `note` 里说明。返回 `202` 新任务 / `200` 已在下载中 / `200 {status:"exists"}` 曲库已有 / `400` 参数非法。

### 进度与曲库

- `GET /api/events`：SSE。连接时推 `snapshot`，之后每次变化推 `job`（`queued → downloading → processing → done | error`，带 `progress`、`file`、`url`）
- `GET /api/downloads`、`GET /api/downloads/:id`：轮询方式
- `GET /api/library`：已下载曲目（含 `sourceTitle`、`uploader`、`pageUrl`、`version`）；`GET /files/<文件名>`：音频（支持 Range）

## 风控、超时与降级

**B 站**
- 首次使用时申请设备 Cookie（buvid3/buvid4）并访问一次首页"预热"，wbi 签名密钥 6 小时刷新；视频信息、音轨接口都带 wbi 签名
- 所有 B 站 API 请求串行限速（默认间隔 300ms + 随机抖动），避免并发请求触发风控
- 显式风控（412 / -352 / -509）：换一套设备 Cookie（登录 Cookie 保留）+ 指数退避重试 2 次；静默风控（成功但结果为空）同样换 Cookie 重试；仍失败则该音源标记为 `BLOCKED`，其他音源照常返回
- 启动时检查 Cookie：`SESSDATA` 已失效会在日志里提示重新导出

**下载（直连 CDN）**
- 连接超时 10s；收到响应后连续 20s 没有数据视为假死，中止并**断点续传**（`Range: bytes=已收-`）
- 断流 / 超时：同一地址续传最多 4 次；403 / 404 / 主机连不上：立即换备用地址；PCDN 节点（mcdn / szbdyd / IP 直连）排在官方 CDN 之后
- 全部地址失效：重新解析一次音轨地址再试；仍失败降级到 yt-dlp（带同一份 Cookie）
- 先写入 `downloads/.partial/`，完成后再改名，失败不会留下半截文件

**YouTube**
- yt-dlp 统一带 `--socket-timeout 15 --retries 3 --extractor-retries 2`；链接解析整体 30s 超时
- 调用前先探测代理端口（2s），代理没开时立即返回 `PROXY` 错误，而不是等 yt-dlp 重试十几秒
- "Sign in to confirm you're not a bot"：先换代理节点，再考虑 `YT_COOKIE_PATH`

`npm test` 用一个故意出错的本地服务验证续传 / 假死 / 换地址 / 不支持 Range 等情况。

## 已知限制

- 原唱识别依赖 YouTube Music 播放量：极其著名的翻唱（如 海阔天空·信樂團）播放量也很高，会被当作原唱之一
- 冷门歌曲在 YouTube Music 上没有足够播放量时识别不出原唱，此时显示全部"未标明原唱"的结果，需要用户点链接核对
- 视频平台标题千变万化，规则判定不可能 100% 准确；"全部版本"里可以看到被过滤的条目及其标签
- 下载任务记录在内存中，重启服务后丢失（曲库 `library.json` 会保留）
