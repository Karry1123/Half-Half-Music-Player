# Half&Half Music Player

[English](README.md) | **简体中文**

两个人、两台设备，同步收听 Host 本机的音乐。Host 的音频文件经 WebRTC DataChannel 直传给 Guest，播放/暂停/拖动毫秒级同步；Host 可在页面里搜索下载歌手原版（见 [music-service](music-service/README.zh-CN.md)）。

**在线使用：** https://karry1123.github.io/Half-Half-Music-Player/dashboard.html （GitHub Pages；Android 安装包见 [Releases](https://github.com/Karry1123/Half-Half-Music-Player/releases)）

技术栈：React 18 + Vite 6 + Zustand 5 · 原生 RTCPeerConnection · Web Audio API · Node.js WebSocket 信令

上线部署（GitHub Pages / Vercel + Render + UptimeRobot 保活）见 [DEPLOY.md](DEPLOY.md)。Android 安装包见下文「[Android App](#android-app)」。

## 运行

```bash
npm install
npm run dev:all        # 一键启动：页面 + 信令 + music-service，打印测试链接和手机二维码
npm run dev            # 只启动页面 + 信令
npm test               # 单元测试
npm run nat-check      # STUN / NAT 自检
```

联调步骤、调试面板（`?debug=1`）、弱网模拟（`?netsim=`）与稳定性设计见 **[TESTING.md](TESTING.md)**。

### 单文件版 Dashboard（`public/dashboard.html`）

React 18 + Tailwind + Lucide + PeerJS Dashboard，提供四个底部标签与常驻迷你播放器。生产构建将依赖打包到本地；直接打开源码页面仍使用开发用 CDN 导入。

打开后先进入**主界面（Lobby）**，有三大入口：

- **A 单人沉浸听歌**：不建房间，直接进入个人曲库与搜索；本地导入也在这里。
- **B 创建双人房间**：房间码 / 二维码 / 复制链接 / 等待动效。
- **C 加入好友房间**：6 位分段输入、粘贴邀请链接自动识别、快速重新连接。

入口下方依次是：

- **我的曲库**展示栏：自动加载之前下载过的歌，带"已缓存"徽章。
- 全网检索与直链解析：粘贴 B站链接 / BV 号 / b23 短链 / YouTube 链接后立即识别，展示提取卡片（封面、作者、时长、播放量、每档音质的码率与大小，可选音质下载）。

等待伙伴期间就能先挑歌，伙伴加入后双方自动进入播放台。

- **连接管理**：
  - TURN 中继由服务端 `/ice.json` 下发，支持 Metered、Cloudflare、自建 coturn（含临时凭证）；也可以在页面「连接设置」里填写，并测试 TURN 是否可用。
  - 双向心跳，3 秒静默即自动无感重连，期间音乐不中断。
  - 顶栏和播放条显示实际路径（局域网 / P2P 直连 / TURN 中继）、往返延迟和同步偏差。
  - 跨境配置见 [TESTING.md](TESTING.md)「D. 跨网络 / 跨境连接」。

- `npm run dev:all` 后访问 `http://localhost:8080/dashboard.html`：自动对接 music-service
- 直接双击打开或任意静态服务器：演示模式（mock 搜索，"下载"会合成一段可播放的演示音频）
- 双人配对使用后端自建、带认证的 PeerJS 信令（`?room=房间码` 自动以 Guest 加入）；可用 `?peerHost=&peerPort=&peerPath=` 指向其他自建 PeerServer
- 手机等非房主设备访问不到 music-service（只对房主电脑本机开放），会进入"经房主搜索"模式：加入房间后，搜索 / 下载请求经 P2P 交给房主电脑执行，下载的歌进入房主曲库并同步给双方
- **本机离线曲库**（[`public/libraryStorage.js`](public/libraryStorage.js)，IndexedDB，无依赖，任何框架可直接 import）：
  - 下载的歌（音频 + 封面 + 元数据）自动存进浏览器，打开页面自动恢复歌单；音频懒加载，不会一次读进内存
  - 拖入 / 选择的本地文件：勾选"导入时同时缓存至浏览器本地库"后也会保存（默认开启）
  - 按内容指纹去重（文件大小 + 头 / 中 / 尾采样，纯 JS，手机走 http 局域网地址也能用）：改了文件名也认得出；Guest 本机已有的歌，房主切到它时直接用本机副本，不再经 P2P 传输
  - 手机（Guest）：歌单每行有"保存到本机"；在手机上点下载，房主下载完后会自动传一份存到手机
  - 「本机曲库」面板：按添加时间 / 大小 / 歌名排序、单曲删除、导出为文件（桌面 Chrome / Edge 可选保存位置或整个文件夹，其他浏览器用普通下载）、存储用量与"申请持久保存"
  - iOS Safari 会清理 7 天未访问网站的数据，面板里会提示"添加到主屏幕"
- **自定义歌单**（逻辑在 [`public/playlists.js`](public/playlists.js)，`tests/playlists.test.mjs` 覆盖）：
  - 和曲目存在一起：网页用 IndexedDB 的 `playlists` 表（数据库升级到 v2），Android 用 `playlists-v1.json`。歌单只引用 `tracks.id`：删除歌单不会删音频；从本机删歌会自动从所有歌单里移除
  - 内置「全部已下载 / 已导入」（虚拟歌单，永远等于整个曲库）和「默认曲库」（"稍后整理"，不能改名或删除）。升级后第一次打开，已有的歌全部并入默认曲库，不会丢
  - 下载搜索结果、提取链接、选择 / 拖入本地文件时，先问放进哪个歌单（可以当场新建，也可以勾选"以后不再询问"）。每首歌的「⋯」里有"添加到歌单""从当前歌单移除""从本机删除"
  - 单人：歌单头部的「播放全部」或双击歌单里任一首，播放队列立即换成这个歌单；上一首 / 下一首 / 随机 / 循环都只在歌单内
  - 房间：房主点「在房间中播放」会广播 `set_playlist`，双方顶部显示"正在与对方一起收听歌单：【歌单名】"，Guest 的列表与房主队列一致；播放当前这首时 Guest 会预先缓存歌单里的下一首，切歌不用等传输
- **播放模式与单人 / 双人**（队列算法在 [`public/playQueue.js`](public/playQueue.js)，纯逻辑，`tests/playQueue.test.mjs` 覆盖）：
  - 顺序 / 列表循环 / 单曲循环 / 随机。随机不打乱歌单，单独维护洗牌顺序：一轮内每首只播一次，新一轮第一首不会是刚播完的那首；"上一首"回到真正听过的歌，再"下一首"原路返回；中途加的歌本轮就能听到
  - 单人模式：主界面"单人听歌"，不建房间、不连 WebRTC，直接播本机曲库
  - 双人模式：播放模式只有房主能改，随歌单广播；Guest 显示房主的模式和"下一首"预告；切歌照旧经数据通道触发 Guest 缓冲 + 换曲
  - 系统媒体控件（MediaSession）：锁屏 / 通知栏 / 耳机线控 / 键盘媒体键，封面、歌手、进度条拖动；Guest 按键会变成发给房主的请求
  - 切后台回来：Guest 先连发 ping 重新测时钟，再向房主要一次状态并直接硬对齐；连接在后台断了会用房间码自动重连。Host / 单人被来电等打断时从原位置继续
- 与主应用的区别：用 HTML5 Audio + PeerJS，适合快速演示和分享；主应用（Vite 版）有采样级调度、边收边播、自建信令和调试面板

搜索下载功能需要另开一个终端（只在 Host 电脑上）：

```bash
cd music-service
npm install
npm run setup:ytdlp
npm start              # http://127.0.0.1:8090
```

生产部署：`npm run build && npm start`（`server/index.js` 托管 `dist/` + 信令 + `/music-api` 代理）。公网使用需 HTTPS，对称 NAT 需在 `src/lib/rtc.js` 配置 TURN。

> 项目路径含 `&`，Windows 下 npm 的 `.cmd` 包装会把 `&` 当作命令分隔符，所以脚本里直接调用 `node node_modules/vite/bin/vite.js`。

## 账号、云端歌单与 ZIP 导出

音乐服务默认为**账号模式**：注册后需用一次性**邀请码**激活一次，激活前搜索、链接解析、下载、云端歌单和双人同步都会被服务端拒绝。激活状态保存在服务端，之后在任何设备（网页或 Android）登录都无需再填邀请码。登录凭据是 30 天有效的随机令牌（服务端只存 SHA-256），网页存在 localStorage，Android 存在 Capacitor Preferences。

- **歌单自动同步**：歌单（含默认曲库）和昵称在登录同一账号的所有设备间自动同步：打开时、修改后 2 秒、回到前台时、以及每分钟一次。只同步歌曲信息，其他设备加入的歌显示为「未下载」并可一键下载。按每台设备上次同步的状态做三方合并，两台设备各自加歌、删歌都会保留；在某台设备删除文件只是腾出空间，不会把歌从歌单里删掉。音源失效会明确提示并可「替换音源」。
- **ZIP 导出**：歌单或整个本机曲库可打包为一个 ZIP，文件名为 `歌手 - 歌名.扩展名`，附带 `metadata.json`；Android 上交给系统分享面板。
- **数据库**：生产环境设置 `DATABASE_URL` 为 PostgreSQL 连接串（如 Northflank 免费 PostgreSQL）；不设置时用本地 SQLite 文件（`ACCOUNT_DB`，需要 Node >= 22.13），仅供开发。
- **邀请码**：在服务所在环境运行 `node music-service/scripts/invite.mjs 7`（7 天有效、单次使用）。
- `AUTH_MODE=legacy` 关闭账号系统，保留旧的共享 `API_TOKEN` 方式。

详细说明、表结构和验收步骤见 [ACCOUNT_SYNC_EXPORT.md](ACCOUNT_SYNC_EXPORT.md)。

## Android App

用 [Capacitor](https://capacitorjs.com) 把单文件 Dashboard（`public/dashboard.html`）封装成原生 APK。App 打开后直接进入 Dashboard，后端地址在构建时写进去（`MUSIC_API_URL`）。

| 部分 | 位置 |
|---|---|
| Capacitor 配置 | [`capacitor.config.json`](capacitor.config.json)（包名 `com.halfhalf.musicplayer`，`webDir: dist`） |
| Android 工程 | [`android/`](android/)（已提交，不用再 `cap add`） |
| 权限与服务声明 | [`android/app/src/main/AndroidManifest.xml`](android/app/src/main/AndroidManifest.xml) |
| 后台播放（前台服务） | `public/dashboard.html` 里的 `NativeFG`，插件 `@capawesome-team/capacitor-android-foreground-service` |
| 云端构建 | [`.github/workflows/build-apk.yml`](.github/workflows/build-apk.yml) |

### 权限清单

| 权限 | 作用 |
|---|---|
| `INTERNET`、`ACCESS_NETWORK_STATE` | 连后端、WebRTC、网络状态 |
| `WAKE_LOCK` | 播放时防止 CPU 休眠 |
| `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK` | 后台播放用的前台服务（类型 `mediaPlayback`，Android 14+ 必须声明类型） |
| `POST_NOTIFICATIONS` | 播放通知（Android 13+ 首次播放时弹窗询问；拒绝后服务照常运行，只是看不到通知） |
| `READ_EXTERNAL_STORAGE`（≤ Android 12）、`WRITE_EXTERNAL_STORAGE`（≤ Android 9） | 旧系统保存 / 导出歌曲。Android 10+ 走系统文件选择器，不需要权限，所以没有申请 `READ_MEDIA_AUDIO` |

明文流量：正式版（release）只允许 HTTPS，仅 `localhost`、`127.0.0.1`、`10.0.2.2`（模拟器访问宿主机）例外；测试版（debug）通过 `src/debug/AndroidManifest.xml` 放开所有 HTTP，方便连局域网里的后端（例如 `http://192.168.1.10:8090`）。WebView 页面本身是 `https://localhost`，访问 http 后端还会触发"混合内容"拦截：需要把 `capacitor.config.json` 里的 `server.androidScheme` 改成 `http` 后再构建测试版。

### 本地构建

需要 Node 22+、JDK 21（Capacitor 8 的 Android 库按 Java 21 编译，JDK 17 不行）、Android SDK（`ANDROID_HOME`，或在 `android/local.properties` 写 `sdk.dir=…`）。

```bash
# MUSIC_API_URL 是后端公网地址（只放公开地址，不要放令牌）
MUSIC_API_URL=https://你的后端.example.com npm run cap:sync     # 构建网页并同步到 android/
node scripts/gradle.mjs assembleDebug                           # → android/app/build/outputs/apk/debug/app-debug.apk
node scripts/gradle.mjs assembleRelease                         # → .../release/app-release.apk（没配密钥时用 debug 密钥签名）
```

项目路径里有 `&`（Windows），所以用 `scripts/gradle.mjs` 代替直接运行 `gradlew`。想用 Android Studio 的话，`npm run cap:sync` 之后打开 `android/` 目录即可。

### 云端自动构建（GitHub Actions）

| 触发 | 产物 |
|---|---|
| 推送标签 `v1.2.3` | `assembleRelease`，APK 和 SHA-256 作为附件发布到该标签的 GitHub Release（版本名 `1.2.3`，versionCode `10203`） |
| 推送到 `main` | `assembleDebug`，作为工作流产物保留 14 天（只改文档不触发） |
| 手动运行 | 可选 debug / release |

```bash
git tag v0.1.0 && git push origin v0.1.0
```

仓库设置（Settings → Secrets and variables → Actions）：

| 名称 | 类型 | 说明 |
|---|---|---|
| `MUSIC_API_URL` | Variable | 后端公网地址，构建时写进 App。和网页部署共用同一个变量 |
| `SIGNAL_URL`、`ICE_URL` | Variable | 可选，默认由 `MUSIC_API_URL` 推出 |
| `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` | Secret | 可选。配了就用你的发布密钥签名；没配就用 debug 密钥（能安装测试，但不能上架应用商店，以后换正式密钥签名的包也无法覆盖安装） |

生成发布密钥：

```bash
keytool -genkeypair -v -keystore release.jks -alias halfhalf -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.jks     # 把输出填进 ANDROID_KEYSTORE_BASE64；*.jks 已在 .gitignore 里，不要提交
```

### 让后端接受 App

App 里的页面来源是 `https://localhost`，后端的 `CORS_ORIGINS` 要加上它：

```
CORS_ORIGINS=https://你的网页.vercel.app,https://localhost
```

访问令牌 `API_TOKEN` **不打进 APK**（APK 是公开文件）。首次打开 App，在「连接设置 → 音乐服务」里填写，只保存在手机本地。

### 启动强制更新（GitHub Releases）

每次打开 App 都会请求 `https://api.github.com/repos/<owner>/<repo>/releases/latest`，把最新 Release 的 `tag_name`（如 `v1.2.0`）和 App 已安装的版本号按语义化版本（semver）比对。远端更新就弹出**不可关闭**的"发现新版本"对话框：显示当前 / 最新版本和 Release 正文（更新日志），没有关闭按钮，点遮罩、Esc、返回键都无效，只有【立即更新】。

| 部分 | 位置 |
|---|---|
| 版本比对、Release 解析、5 秒超时（纯函数，有单元测试） | [`public/appUpdate.js`](public/appUpdate.js)、[`tests/appUpdate.test.mjs`](tests/appUpdate.test.mjs) |
| 原生下载 / 校验 / 安装 | [`public/appUpdateNative.js`](public/appUpdateNative.js) |
| 对话框与 `useAppUpdate` | `public/dashboard.html` 里的 `UpdateGate` |

- **本地版本**读自已安装 APK 的 `versionName`（CI 按标签写入，`v1.2.0` → `1.2.0`），不用在代码里手写。
- **点【立即更新】**：在 App 里下载 Release 里的 `.apk`（有进度条），用 GitHub 给的 SHA-256 校验，通过后打开 Android 系统安装界面。首次需要在系统设置里允许本 App"安装未知应用"。失败时出现【改用浏览器下载】，用系统浏览器打开 APK 直链。
- **国内下载慢**：构建时设置仓库变量 `UPDATE_MIRRORS`（逗号分隔，如 `https://ghfast.top/`）。先试 GitHub，失败再依次试镜像。镜像是第三方，所以**只有拿到 SHA-256 才会使用**，校验不过的文件直接丢弃。
- **容错**：离线、GitHub 限流、5 秒没响应、没有 Release、Release 里没有 APK，一律静默跳过，不会卡住启动。`0.0.0-dev.*` 的 CI 测试构建和普通浏览器不检查更新。
- **只认正式 Release**：`latest` 不含草稿和预发布。发布流程：`git tag v1.2.0 && git push origin v1.2.0`，工作流会把 `app-release.apk` 发布出来，之后旧版本启动就会收到更新。

> **必须用固定的发布密钥签名，否则更新装不上。** Android 只允许同一把密钥签名的包覆盖安装。没配 `ANDROID_KEYSTORE_*` 时，每次构建用的 debug 密钥都是临时生成的，新版本会提示"与已安装的应用冲突"。请先按上文生成发布密钥并写进仓库 Secrets，再发第一个对外版本；密钥文件务必另外备份，丢了就没法给已安装的用户推更新。

### 已知限制

- 依赖 `public/dashboard.html` 里的 CDN 脚本（React、Tailwind 等），首次打开必须联网。
- 后台播放靠前台服务保活。部分国产系统（MIUI、ColorOS 等）还需要在系统设置里给 App 开"自启动 / 无限制电池"。
- "导出到文件"在 Android WebView 里不一定可用（`a[download]` 对 blob 的支持有限）。
- 没有应用内自动更新，新版本从 GitHub Releases 下载安装。
- 工作流和 Android 工程在本机没有完整构建过（本机没装 Android SDK），首次推送标签时请留意 Actions 日志。

## 架构

```
浏览器（Host / Guest 同一套代码）
┌──────────────────────────────────────────────────────────────┐
│ React 组件（只读 store，调用 engine 方法）                       │
│   ↑ useSession / useMusic（Zustand）                           │
│ engine/session.js  ── 同步协议、播放列表、提示                    │
│   ├ lib/signaling.js   WebSocket 信令                          │
│   ├ lib/rtc.js         RTCPeerConnection（ctrl + file 通道）     │
│   ├ lib/clock.js       NTP 式时钟同步                            │
│   ├ lib/transfer.js    文件分片传输（背压）                       │
│   └ lib/player.js      Web Audio 定时播放 + 音量 + 频谱           │
│ engine/musicApi.js ── /music-api（仅 Host 本机）                  │
└──────────────────────────────────────────────────────────────┘
        │ /ws                              │ /music-api（loopback only）
   server/signaling.js               server/musicProxy.js → music-service :8090
   （开发时挂在 Vite 上，生产时挂在 server/index.js 上）
```

### 组件拆分

| 组件 | 职责 |
|---|---|
| `App` | 大厅 / 房间切换；Host 全窗口拖放添加文件；空格键播放/暂停 |
| `Lobby` | 昵称 + 头像色；创建房间 / 输入房间码加入（`?room=` 邀请链接自动填充） |
| `ConnectionBar` | 房间号（复制邀请链接）、角色、连接指示灯（等待 / 连接中 / 同一频道 / 中断）、Ping 信号格（悬停显示时钟偏移与播放漂移）、搜索入口 |
| `NowPlaying` | 旋转黑胶封面 `CoverDisc`、实时频谱 `Visualizer`（AnalyserNode）、双人头像 `DuoAvatars`（同步播放时连线流动）、传输/缓冲状态 `TransferLine` |
| `PlayerControls` | 上一曲/播放/下一曲、进度条 `SeekBar`（拖动只预览，松手才广播）、本地音量 `VolumeControl` |
| `Playlist` | Host 曲库（已下载）+ 本地文件；当前曲目均衡器动画；Guest 点击 = 请求房主切歌 |
| `SearchDrawer` | 搜索、音源筛选、只看原版/全部、格式；结果含版本标签与音质标签（FLAC / 320k / M4A ≈128k）、原页面链接；逐条下载进度 + 下载队列（SSE） |
| `Toasts` | 同步提示："晚风 把进度拖到了 01:30" |

### 状态管理

两个 Zustand store，**写入方单一**：

- `useSession`：只由 `engine/session.js` 写入。连接（role、peerState、rtt、offset、drift、peer 资料）、当前曲目、播放状态、播放列表、传输进度、提示。
- `useMusic`：搜索参数与结果、下载任务（SSE 推送）、曲库。曲库变化时 engine 订阅并合并进播放列表，再同步给 Guest。

组件只用 selector 读取，操作一律调用 `engine.act(...)` 等方法——Host 直接执行，Guest 自动转成 `request` 发给 Host 裁决。**高频的播放位置不进 store**：`usePlaybackPosition()` 在需要的小组件里按帧读取 `engine.position()`，避免全树重渲染。

### 同步协议（ctrl DataChannel）

Host 是唯一权威，播放状态 = 锚点 `{ trackId, playing, position, at }`（Host 时钟 `at` 时位置为 `position`）。

| 消息 | 方向 | 说明 |
|---|---|---|
| `hello` | 双向 | 昵称、头像色 |
| `playlist` | H→G | 播放列表元数据 |
| `track` | H→G | 切歌（`by` 发起者、`quiet` 自动行为不提示） |
| `need_file` / `track_ready` | G→H | Guest 无缓存请求传输 / 已解码可播放 |
| `play` `pause` `seek` | H→G | 锚点，`at` 设在未来 `clamp(1.5·RTT+60, 120, 1000)` ms |
| `state` | H→G | 每秒心跳锚点，Guest 漂移 > 30ms 重新对齐 |
| `request` | G→H | Guest 的 play/pause/seek/next/prev/select |
| `sync_ping` / `sync_pong` | G↔H | NTP 式时钟同步 |

切歌流程：Host 发 `track` → Guest 命中缓存（最近 6 首）直接解码，否则 `need_file` → Host 分片传输 → Guest 解码后 `track_ready` → Host 开始播放（最多等 15 秒）。

## 已验证

本机两个标签页（Host + Guest）：
- 创建/加入房间，P2P 建连，昵称交换，播放列表同步
- Guest 点歌 → Host 加载曲库文件 → 传输 3.3 MB → Guest 解码 → 双方同时开始
- Host 拖动到 01:30：同一时刻双方播放位置相差 0.8 ms（引擎测得漂移 0.04 ms）
- Guest 拖动进度条 → Host 弹出"晚风 把进度拖到了 01:30"
- 抽屉搜索"后来 刘若英" → 下载 B 站 JLRS-LeoFM 原版 → 自动以"劉若英 - 後來.m4a"加入播放列表并同步给 Guest
- `vite build` 通过；375px 宽度无横向溢出

## Dashboard 好友与新增环境变量

Dashboard 底部提供「发现/检索、曲库/歌单、好友/动态、设置/账号」四个入口，迷你播放器可展开全屏并下滑收起。按昵称或用户 ID 查找好友，接受请求后可查看在线状态、发送一起听邀请；接受邀请自动连接，房间码仍可备用。最近一起听记录保存在本机。切歌、重播和回到前台时从音频元素读取进度与播放状态。

构建前端设置 `MUSIC_API_URL`；后端设置 `ENABLE_SIGNALING=1` 同时启用自建 PeerJS `/peerjs` 与好友信令 `/ws`。反向代理需转发两条路径的 WebSocket upgrade。账号模式要求已激活的有效会话，`AUTH_MODE=legacy` 保留 `API_TOKEN` 规则，不再默认依赖公共 PeerJS 云服务。

运行时可用 `HH_CONFIG.peerUrl` 覆盖 PeerJS 后端基础地址（默认使用 `HH_CONFIG.apiBase` 对应的实际 API 地址）；`HH_CONFIG.peerPath` 覆盖路径，默认是基础地址路径加 `/peerjs`。`HH_CONFIG.signalUrl` 可指定好友 WebSocket 地址，默认使用 API 地址加 `/ws`，并按后端协议转换为 `ws:` / `wss:`。

| 环境变量 | 含义 / 默认值 |
|---|---|
| `CLOUDFLARE_TURN_KEY_ID`、`CLOUDFLARE_TURN_API_TOKEN` | 仅后端保存，用于签发短期 TURN 凭据 |
| `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_ANALYTICS_TOKEN` | 启用每小时本月 TURN 出站流量查询；未配置时配额监控平稳停用 |
| `TURN_QUOTA_GB` | 每月十进制 GB 配额，默认 `1000` |
| `TURN_QUOTA_WARN_PERCENT`、`TURN_QUOTA_KILL_PERCENT` | 警告 / 停发凭据百分比，默认 `50` / `90` |
| `IS_TURN_ENABLED` | 设 `false` 手动停止 Cloudflare 凭据签发 |
| `TURN_QUOTA_STATE_FILE` | 旧模式状态文件，默认 `music-service/data/turn-quota.json`；账号模式用 `turn_quota_state` 数据表 |
| `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`、`ALERT_EMAIL_TO` | Nodemailer 告警需配置主机、发件人与收件人；用户名/密码为可选认证。端口默认 `587`（`465` 启用 TLS）；未配投递信息仅记录日志 |
| `YTDLP_PATH`、`YTDLP_JS_RUNTIMES`、`YTDLP_SEARCH_TIMEOUT` | 可选 yt-dlp 可执行文件路径、逗号分隔的 JS 运行时（如 `node`）及搜索超时（默认 `15000` 毫秒） |
| `PROXY_URL`、`YT_PROXY`、`YTDLP_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY` | YouTube 代理地址，按列出顺序取首个已配置值 |
| `YTDLP_COOKIES` | Netscape Cookie 文件路径，优先于 `YT_COOKIE_PATH`，再尝试 `music-service/cookies/youtube.txt` |
| `YTDLP_MIN_INTERVAL_MS`、`YTDLP_BACKOFF_MS` | YouTube 串行任务间隔 / 首次重试退避，默认 `1500` / `4000` 毫秒，附随机延迟 |
| `YTDLP_PLAYER_CLIENTS` | 分号分隔的重试策略，最多三组，默认 `default;web_safari,mweb` |
| `YTDLP_PO_TOKEN` | 可选 `CLIENT.CONTEXT+TOKEN` 格式 PO Token |
| `YTDLP_PO_TOKEN_PROVIDER_URL` | 可选 bgutil HTTP provider 地址，需另装兼容的 yt-dlp 插件 |

告警与自动停发状态按 UTC 月持久化，服务重启后仍生效，每月各阈值告警一次。自动停发次月重置；手动设置的 `IS_TURN_ENABLED=false` 需自行更改后才恢复。监控器将状态写入数据库/文件，不改写环境变量或 `.env`。停发不会撤销已发出的凭据。YouTube 解析和下载共用串行队列，成功解析缓存 5 分钟，已下载音频复用曲库。身份验证错误会换客户端重试，再尝试搜索结果里匹配的 B 站录音；没有可用替代时返回 `YOUTUBE_BOT_CHECK` 中文提示。Cookie 不得提交。参考 [yt-dlp PO Token 指南](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)及 [bgutil 插件配置](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)。

## 已知限制

- Guest 无法搜索下载（音乐服务只对 Host 本机开放），只能在 Host 的播放列表里点歌
- 拖入的本地文件不读取 ID3 标签，标题来自文件名（"歌手 - 歌名"格式可自动拆分）
- 刷新页面会离开房间（P2P 断线会自动 ICE restart，但信令断开不重连）
- FLAC / 非分片 MP4 无法边收边播，需完整接收后播放
