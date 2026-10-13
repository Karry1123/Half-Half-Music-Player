# Half&Half 本地联调与稳定性测试指南

## 0. 一键启动

```bash
npm install                 # 首次
npm run dev:all             # 页面 + 信令 + music-service，打印测试链接与手机二维码
```

| 参数 | 作用 |
|---|---|
| `npm run dev:all -- --kill-stale` | 8080 / 8090 被上次没关掉的进程占用时自动结束它们 |
| `npm run dev:all -- --no-music` | 只测同步播放，不启动 music-service |
| `npm run dev:all -- --no-turn` | 不启动本地 TURN 中继（默认会启动） |
| `npm run dev:all -- --netsim=delay:80,jitter:60,rate:200k` | 打印的测试链接自带网络模拟参数 |

启动脚本会依次检查：Node ≥ 20 → 依赖（缺失自动安装）→ yt-dlp → 端口占用（能识别只监听 127.0.0.1 的旧进程）→ 同时拉起两个服务（`[web]` / `[music]` 前缀日志，Ctrl+C 一起退出）。

其他命令：`npm test`（同步算法与格式探测的单元测试）、`npm run nat-check`（STUN 可达性与 NAT 类型自检）。

### URL 参数（测试专用）

| 参数 | 示例 | 作用 |
|---|---|---|
| `name` | `?name=Host` | 临时昵称。同一浏览器两个标签页共享 localStorage，不加的话两边昵称一样 |
| `debug` | `?debug=1` | 左下角调试面板：ICE 候选与选中路径、时钟 RTT/偏移、播放器类型、速率、漂移曲线、缓冲；Guest 可注入漂移，Host 可手动 ICE restart |
| `netsim` | `?netsim=delay:60,jitter:80,rate:150k` | 模拟弱网：控制消息额外延迟 + 随机抖动；文件传输限速（Host 端生效）。**DevTools 的网络限速对 WebRTC 无效**，所以内置了这个 |
| `stream` | `?stream=0` | 关闭边收边播，强制"收完再解码"，用于对比 |

---

## 1. 本地多端联调

### A. 同一台电脑，两个窗口

1. `npm run dev:all`
2. **Host**：Chrome 打开 `http://localhost:8080/?name=Host&debug=1` → 创建房间
3. **Guest**：用**另一个浏览器**（Edge / Firefox）或 **无痕窗口** 打开 `http://localhost:8080/?name=Guest&debug=1&room=房间码` → 加入
4. 两个窗口**并排显示**，不要叠在一起

> 为什么不用同一窗口的两个标签页：后台标签页的 `requestAnimationFrame` 会暂停、定时器被节流到 1 秒一次，进度条不动、心跳变慢，会让你误以为同步出了问题。音频本身不受影响，但观察起来很困惑。

### B. 电脑 + 手机（同一 Wi-Fi）

1. `npm run dev:all`，用手机扫终端里的二维码（`http://192.168.x.x:8080/?name=Phone&debug=1`）
2. Windows 首次运行 Node 时防火墙会弹窗：勾选**专用网络**并允许。错过了的话：设置 → Windows 安全中心 → 防火墙 → 允许应用通过防火墙 → Node.js
3. 电脑当 Host 创建房间，手机输入房间码加入
4. 调试面板"选中路径"应显示 **局域网直连**（host 候选）

> 局域网 HTTP 即可，不需要 HTTPS：`RTCPeerConnection`、`AudioContext`、`MediaSource` 在非安全上下文都可用（只有剪贴板会退化为弹窗复制）。

### 手机热点 / 设备隔离：P2P 连不上

**现象**：手机能打开页面、能加入房间，但一直"正在建立 P2P…"，或提示需要 TURN。

**原因**：电脑连手机热点时，手机浏览器的 WebRTC 往往只看得到 4G 网卡，拿不到热点那张网卡的局域网地址；Chrome 又用 mDNS 隐藏了电脑的 IP。双方只能互相"打洞"，而打洞要经过运营商 NAT 的回环，几乎都会失败。校园网 / 公司 Wi-Fi 的设备隔离同理。

**解决**：`npm run dev:all` 默认会在电脑上启动一个**本地 TURN 中继**（UDP 3478，每次启动随机密码，随信令下发）。手机能打开 `http://电脑IP:8080`，就一定能连上电脑上的中继，P2P 改走"手机 → 电脑中继 → 电脑浏览器"，局域网内延迟仍是个位数毫秒。状态栏 Ping 旁会出现"中继"标记。

| 排查 | 做法 |
|---|---|
| 确认中继本身可用 | 两端链接都加 `&relay=1`（强制只走 TURN）。能连上 → 中继正常；连不上 → 多半是防火墙 |
| 防火墙 | Windows 防火墙要允许 Node.js（含 UDP）。网络被识别为"公用"时规则可能不生效：设置 → 网络和 Internet → 当前连接 → 网络配置文件类型改为"专用" |
| 换个拓扑更省事 | 用**电脑开热点**（Windows：设置 → 移动热点），手机连电脑。手机拿到的是普通局域网地址，通常能直接 P2P，不需要中继 |
| Dashboard 单文件版 | 同样从 `/ice.json` 读取这份 TURN 配置，也支持 `&relay=1` |

实测（本机，两端 `relay=1`）：主应用与 Dashboard 均经本地 TURN 连通，选中路径 relay ⇄ relay，RTT 2ms；主应用边收边播，双方位置差约 2ms。

### C. 跨网络（手机 4G ↔ 家里电脑）

先跑 `npm run nat-check`。本机实测结果：

```
② NAT 映射行为（同一本地端口 → 两台服务器）
  stun.l.google.com:19302      → 128.195.97.25:33692
  stun.cloudflare.com:3478     → 128.195.97.25:31626
  ⚠ 对称 NAT：跨网 P2P 很可能失败，需要 TURN 中继
```

**对称 NAT（校园网、公司网、多数 4G）下 STUN 打洞基本不会成功，必须配 TURN。** 配置方法见下一节。

### D. 跨网络 / 跨境连接（配置公共 TURN）

**为什么需要 TURN：** STUN 只能帮两端"打洞"直连。只要有一端在对称 NAT 后面（4G、公司网、校园网很常见），或者两端隔着国境，跨境线路丢包又高，直连基本打不通。这时音频必须经过一台**双方都连得上**的 TURN 服务器中转。TURN 只转发加密后的 WebRTC 数据，看不到音频内容，但会消耗它的流量：一首 5MB 的歌，中继就走 5MB。

> **没有可靠的"免老板费"公共 TURN。** 以前常用的 Metered Open Relay（`openrelay.metered.ca`）2026-10 实测域名已无法解析，所以项目里没有内置任何写死的免费 TURN，以免看起来有兜底，实际全部失败。下面三种方案任选其一，都可以写在项目根目录的 `.env` 里（模板见 [`.env.example`](.env.example)）。

| 方案 | 费用 | 适合 | 配置 |
|---|---|---|---|
| **Metered** | 有免费额度（以官网为准） | 最快上手 | 注册 → 建 App → 拿到 `xxx.metered.live` 和 API Key：`METERED_DOMAIN` + `METERED_API_KEY` |
| **Cloudflare TURN** | 有免费额度（以官网为准） | 全球节点多，跨境稳 | Cloudflare 控制台 → Realtime → TURN → 建 Key：`CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` |
| **自建 coturn** | 一台云服务器 | 完全可控；中国 ↔ 海外选香港 / 新加坡 / 东京机房 | `TURN_URL` + `TURN_SECRET`（推荐，临时凭证）或 `TURN_USER` / `TURN_PASS` |

Metered / Cloudflare 的 Key 只在服务端使用：服务器用它换取**短期凭证**，经 `/ice.json` 下发给浏览器，并缓存、到期前自动刷新。coturn 用 `TURN_SECRET` 时，服务端按 TURN REST API 规范签发 24 小时有效的用户名和密码，即使泄露也会自动过期。

**自建 coturn 最小配置**（`/etc/turnserver.conf`）：

```ini
listening-port=3478
tls-listening-port=5349            # 可选，配证书后启用 turns:（能穿过只放行 443 的网络）
fingerprint
use-auth-secret
static-auth-secret=换成一串随机字符   # 与 .env 里的 TURN_SECRET 相同
realm=halfhalf
total-quota=100
no-multicast-peers
min-port=49160
max-port=49400                     # 安全组放行 UDP 3478 + 49160-49400（和 TCP 3478 / 5349）
```

```bash
# 项目根目录 .env
TURN_URL=turn:你的服务器IP:3478,turn:你的服务器IP:3478?transport=tcp
TURN_SECRET=上面那串随机字符
```

**部署方式：** 双方必须拿到同一份 TURN 配置。最简单的做法是把项目部署到一台公网服务器上：运行 `npm run build && npm start`，套上 HTTPS，在 `.env` 里配好 TURN。双方打开同一个网址，`/ice.json` 会自动把 TURN 下发给两边。

如果 dashboard 放在没有 `/ice.json` 的静态托管上，就让**两边**都在页面右上角「连接设置」里填同一台 TURN（只保存在本机浏览器）。面板里的「测试 TURN」可以检查凭证和连通性：凭证错误会显示 `401 Unauthorized`，能拿到中继候选才算可用。

**验证：** 两边都连上后，顶栏和播放条会显示实际走的路径。
- 局域网直连 / P2P 直连：没有经过任何服务器。
- TURN 中继：经过了中转。

想确认中继本身是否可用，可以在「连接设置」里勾选"强制只走 TURN 中继"再连一次（`?relay=1` 效果相同）。确认完记得取消，因为直连更快。

**断线重连：** 双方每秒互发一次心跳，3 秒收不到对方任何消息（心跳、状态、文件分片都算）就判定连接静默中断。
- Guest 会立刻在后台用同一房间码自动重拨，间隔按 0.3s → 1s → 2s → 4s → 8s 递增，最多持续 90 秒。重连期间音乐按最后的同步点继续播放，连上后先重新测量时钟，再硬对齐进度。Host 通过设备 id 认出是同一个人，直接替换旧连接。
- 主动离开会先发 `bye`，所以对方能区分"离开了"和"掉线了"。
- 切到后台的一方会先告诉对方，对方把超时放宽到 60 秒，避免把后台节流误判为掉线。

本机实测（局域网）：
- 关闭底层 `RTCPeerConnection` 模拟断网：675ms 后自动重连，期间音乐不中断，校准后偏差 -11ms。
- Host 静默 4.5 秒：Guest 判定超时并重连成功。

### 测试清单

| # | 操作 | 期望 |
|---|---|---|
| 1 | Guest 加入 | 状态栏"和 Host 在同一频道"，Ping 有数值；调试面板选中路径为局域网直连 |
| 2 | Host 点一首歌 | Guest 1~3 秒内开始播放（不必等整首传完）；双方头像连线流动"正在一起听" |
| 3 | Guest 拖进度条 | Host 弹出"Guest 把进度拖到了 xx:xx"，双方同时跳转 |
| 4 | 调试面板"注入 +150ms" | 漂移曲线在 ~8 秒内平滑回到 0，速率短暂变为 0.96x，**不跳** |
| 5 | "注入 +900ms" | 下一次心跳直接 seek，漂移回到 ±10ms |
| 6 | Guest 带 `netsim=delay:60,jitter:80` | 速率保持 1.000，漂移在 ±15ms 内波动 |
| 7 | 手机锁屏 10 秒再解锁 | 出现"点击开启声音"或自动恢复，进度追上 Host |
| 8 | 关闭 Wi-Fi 3 秒再打开 | 状态灯短暂"连接中断"，随后 ICE restart 恢复 |

---

## 2. 关键问题与方案

### 2.1 ICE 收集 / NAT 打洞（`server/ice.js`、`src/lib/rtc.js`）

| 问题 | 处理 |
|---|---|
| Google STUN 在国内可能不可达 | 默认 4 个 STUN：Google、Cloudflare、小米 `stun.miwifi.com`、B 站 `stun.chat.bilibili.com`（2026-10 实测均可达）。浏览器建议不超过 4 个，过多会拖慢收集 |
| 换 STUN / 加 TURN 要重新构建前端 | ICE 配置由服务端随 `created` / `joined` 信令下发，改环境变量即可 |
| Wi-Fi 抖动导致连接断开 | `disconnected` 持续 3 秒或 `failed` → Host 自动 `restartIce()` 重新协商（最多 3 次），DataChannel 不重建 |
| 连不上却不知道为什么 | 12 秒未连通弹出提示；调试面板显示各类候选数量（host / srflx / relay / mDNS）与最终选中的路径 |
| 局域网连不上（mDNS） | Chrome 默认用 `xxx.local` 隐藏本机 IP，部分路由器/安卓不解析 mDNS。临时关闭：`chrome://flags/#enable-webrtc-hide-local-ips-with-mdns` → Disabled。详细排查用 `chrome://webrtc-internals` |

### 2.2 边缓冲边播放（`src/lib/sniff.js`、`src/lib/streamPlayer.js`）

**做法：Guest 收到前 64KB 时探测格式，能流式就交给 MediaSource Extensions，当前位置之后缓冲满 3 秒就开始播放；不能流式的格式回退到收完再解码。**

| 格式 | 流式 | 说明 |
|---|---|---|
| MP3 | ✓ | `audio/mpeg`，`sequence` 模式拼接 |
| 分片 MP4（fMP4） | ✓ | B 站 / YouTube 的 DASH 音轨就是这种，读 esds 得到 `mp4a.40.2`/`40.5` |
| WebM / Opus | ✓ | |
| 普通 MP4、FLAC、WAV、OGG | ✗ | 回退到 BufferPlayer |

两种播放器接口一致（`playAt / stopAt / currentPosition / setRate`），引擎不关心当前是哪一种：

- **BufferPlayer**：整首解码，Web Audio 采样级调度。Host 永远用它；Guest 缓存命中时用它
- **StreamPlayer**：共享一个 `<audio>` 元素（iOS 每个元素都要单独解锁，复用可避免切歌被拦），接入同一个音频图，音量与频谱照常工作；数据不够时 `waiting` → 暂停漂移校正、界面显示"缓冲中"

实测（Host 限速 150KB/s，3.3MB 的 m4a 需要 22 秒传完）：**点歌后 1.0 秒开始同步播放，此时只收到 0.13MB**；之后边收边播，漂移始终在 ±4ms，无卡顿。

iPhone Safari 没有 `MediaSource`，只有 `ManagedMediaSource`（iOS 17.1+），已做兼容（未在真机验证）；更老的 iOS 回退为收完再播。

### 2.3 漂移校正（`src/lib/syncController.js`）

```
|漂移| ≤ 15ms           1.0x（死区：人耳分辨不出两台设备的先后）
15ms < |漂移| < 0.3s    比例微调 rate = 1 − 漂移/4s（约 4 秒内追平）
0.3s ≤ |漂移| < 0.5s    以最大速率追赶
|漂移| ≥ 0.5s           直接 seek（需连续两次测量都超阈值，3 秒冷却）
```

| 细节 | 原因 |
|---|---|
| 测量值取最近 3 次的中位数 | 时钟同步的单次误差、心跳被抖动延迟都不会直接触发动作 |
| 迟滞：修正中回到 7.5ms 以内才恢复 1.0x | 避免在 15ms 边界来回切换 |
| 速率上限分播放器：Buffer ±1%、Stream ±5% | `AudioBufferSourceNode` 变速会变调（1% ≈ 17 音分，几乎听不出）；`<audio>` 有 `preservesPitch` 时间伸缩 |
| BufferPlayer 变速时在当前位置重新打锚点 | 变速后位置不再是 `pos + elapsed`，而是分段线性 |
| 流式卡顿、AudioContext 被挂起时不测量 | 此时音频时钟不走，测量没有意义 |
| 心跳携带发送时刻 `at` | 网络延迟本身不影响漂移计算，只有时钟偏移的误差会；偏移估计取最低 RTT 的 1/4 样本 |

实测：注入 +150ms → 速率 0.965 → 8 秒回到 6ms（无跳转）；注入 +900ms → 一次 seek → 4ms；双向 60ms+80ms 抖动（RTT ≈ 200ms）下时钟偏移估计 −0.3ms，速率始终 1.000。

单元测试覆盖阈值、迟滞、冷却、离群值，以及 4 个闭环仿真（`npm test`）。

### 2.4 自动播放策略（`src/lib/audioGraph.js`）

| 场景 | 处理 |
|---|---|
| AudioContext 需要用户手势 | 创建/加入房间的点击里调用 `unlock()`：`resume()` + 播放 1 个采样的静音 buffer（Safari 需要真的播点什么） |
| iOS 的 `<audio>` 需要手势里 play() 过 | 同一次点击里用 46 字节静音 WAV 播放一次，之后程序化 `play()` 不再被拦 |
| iOS 静音拨片导致 Web Audio 没声音 | `navigator.audioSession.type = 'playback'`（Safari 16.4+） |
| 锁屏 / 来电 / 切后台后 AudioContext 被挂起 | `statechange` 监听；应在播放却不是 `running` → 底部横幅"点击开启声音"。**同步时间轴不停**，点击后直接跳到当前应在位置 |
| 用户不点横幅而是点了别处 | 页面上任意 pointerdown / keydown 都会顺手解锁 |
| 标签页切回前台 | `visibilitychange` → 尝试 `resume()` 并硬对齐一次（后台期间定时器被节流过） |
| `<audio>.play()` 被拒（NotAllowedError） | 同样进入"需要点击"状态 |

---

## 3. 常见问题速查

| 现象 | 排查 |
|---|---|
| `npm run dev:all` 报端口被占用 | 加 `-- --kill-stale` |
| 手机打不开页面 | 同一 Wi-Fi？防火墙放行 Node？试终端打印的其他 IP（169.254.x.x 是虚拟网卡，已过滤） |
| 一直"正在建立 P2P…" | 调试面板看候选：只有 mDNS 的 host 候选 → 关 mDNS 隐藏；跨网且没有 relay → 配 TURN |
| 选中路径是"TURN 中继" | 正常可用，但延迟更高、占服务器带宽 |
| Guest 不边收边播 | 调试面板"播放器"一栏和格式；FLAC / 非分片 MP4 只能收完再播 |
| 声音忽快忽慢 | 调试面板看漂移曲线是否在 ±15ms 外反复跨越；正常情况下速率应长时间保持 1.000 |
| 进度条不动但有声音 | 页面在后台标签页（rAF 暂停），切到前台即恢复 |
