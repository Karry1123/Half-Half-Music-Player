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

一个无需构建的 All-in-One 页面（React 18 + Tailwind + Lucide + PeerJS，全部走 CDN），四个模块同屏：连接状态条 / 聚合搜索与下载 / 本地曲库与队列 / 底部常驻同步播放器。

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
- 双人配对用 PeerJS 公共信令（`?room=房间码` 自动以 Guest 加入）；可用 `?peerHost=&peerPort=` 指向自建 PeerServer
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

## 已知限制

- Guest 无法搜索下载（音乐服务只对 Host 本机开放），只能在 Host 的播放列表里点歌
- 拖入的本地文件不读取 ID3 标签，标题来自文件名（"歌手 - 歌名"格式可自动拆分）
- 刷新页面会离开房间（P2P 断线会自动 ICE restart，但信令断开不重连）
- FLAC / 非分片 MP4 无法边收边播，需完整接收后播放
