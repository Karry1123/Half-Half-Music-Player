# Half&Half Music Player

两个人、两台设备，同步收听 Host 本机的音乐。Host 的音频文件经 WebRTC DataChannel 直传给 Guest，播放/暂停/拖动毫秒级同步；Host 可在页面里搜索下载歌手原版（见 [music-service](music-service/README.md)）。

技术栈：React 18 + Vite 6 + Zustand 5 · 原生 RTCPeerConnection · Web Audio API · Node.js WebSocket 信令

上线部署（GitHub Pages / Vercel + Render + UptimeRobot 保活）见 [DEPLOY.md](DEPLOY.md)。

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
