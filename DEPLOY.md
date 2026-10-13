# 上线部署：GitHub Pages / Vercel + Render + UptimeRobot

```
 浏览器（任何地方）
   │  ① 打开页面                    ③ 双人 P2P 音频（WebRTC，直连或 TURN 中继）
   ▼                               ◄──────────────────────────────────────►
 GitHub Pages / Vercel                         好友的浏览器
 （静态前端：index.html 主应用 + dashboard.html 单文件版）
   │  ② 搜索 / 解析 / 下载（HTTPS + 访问令牌）、信令（WSS）、ICE 配置
   ▼
 Render（Docker 容器）：music-service + yt-dlp + ffmpeg + 信令 /ws + /ice.json
   ▲
   └── UptimeRobot 每 5 分钟 GET /ping，防止 15 分钟无流量后休眠
```

| 部分 | 放在哪 | 相关文件 |
|---|---|---|
| 前端（静态） | GitHub Pages **或** Vercel（二选一，也可以都上） | `.github/workflows/deploy-pages.yml`、`vercel.json`、`scripts/write-app-config.mjs`、`public/app-config.js` |
| 后端 | Render（Docker） | `Dockerfile`、`deploy/docker-entrypoint.sh`、`.dockerignore`、`render.yaml` |
| 保活 | UptimeRobot | 后端的 `GET /ping`、`GET /health` |

**部署顺序：Render → 前端 → 回到 Render 填 CORS 白名单 → UptimeRobot。** 前端构建时需要知道后端地址，后端又要知道前端地址才能放行跨域，所以要来回一次。

---

## 先读：四件需要知道的事

1. **后端必须加访问令牌。** 以前 music-service 只允许本机访问；部署到公网后，任何人都能让它替自己下载东西，占用你的流量和 Render 额度。CORS 白名单只能限制浏览器，`curl` 不受影响，所以 `/api/*`、`/files/*` 一律要求 `API_TOKEN`。令牌不写进前端代码（前端是公开的），而是由你在网页「连接设置」里填写，只保存在你自己的浏览器里。
   - 好友**不需要**令牌：好友加入你的房间后，搜索和下载会经 P2P 交给你（房主）的页面代办。
2. **Render 免费实例的限制**（2026-10 查阅 [官方文档](https://render.com/docs/free)，以官网为准）：
   - 15 分钟没有入站流量就休眠，再次访问要约 1 分钟冷启动。
   - 每个 workspace 每月 750 小时免费实例时长。一个服务 24 小时保活约 720~744 小时，**只够保活一个免费服务**；用完后当月所有免费服务都会被暂停。
   - 文件系统是临时的：重启、重新部署、休眠后，下载的文件和曲库记录都会丢失。这不影响使用，因为歌曲在下载时已经缓存进浏览器的 IndexedDB。
   - 出站流量计入免费额度。文档写明，**出站流量异常大的免费服务可能被暂停**，而下载音乐正是出站流量。自己和朋友偶尔用没问题，不要公开给很多人。
3. **YouTube 对机房 IP 很严格。** Render 的出口 IP 经常被 YouTube 要求"登录验证"（`Sign in to confirm you're not a bot`），这时 YouTube / YouTube Music 搜索和下载会失败，B 站不受影响。解决办法是上传 YouTube Cookie（见下文「可选：Cookie」），而且最好用小号。
4. **B 站在海外有部分视频受地区限制。** Render 选新加坡机房最稳；遇到"地区限制"的视频，换一个同名搬运即可。

---

## 第 0 步：把代码推到 GitHub

项目目前还不是 git 仓库。在 GitHub 上新建一个**私有**仓库（例如 `halfhalf`），然后执行：

```bash
git init -b main
git add .
git commit -m "Half&Half Music Player"
git remote add origin https://github.com/<你的用户名>/halfhalf.git
git push -u origin main
```

`.gitignore` 已经排除了 `.env`、`music-service/cookies/`、下载目录和 `node_modules`，Cookie 和令牌不会被提交。推送前可以先用 `git status` 确认一遍。

> 私有仓库用 GitHub Pages 需要付费计划。如果只想用免费的 Pages，仓库就得是公开的。仓库里不含任何密钥，公开也可以；如果不想公开，前端用 Vercel（免费支持私有仓库）。

---

## 第 1 步：部署后端到 Render

### 方式 A：Blueprint（推荐，一次建好）

1. 登录 [Render](https://dashboard.render.com) → **New → Blueprint** → 连接 GitHub，选中这个仓库。
2. Render 读取仓库根目录的 `render.yaml`，创建 `halfhalf-music` 服务（Docker、免费、新加坡、健康检查 `/health`）。
3. 按提示填写标记为 `sync: false` 的变量。现在至少要填 `CORS_ORIGINS`，可以先临时填 `https://example.com`，第 3 步再改成真实地址。
4. **Apply**。第一次构建大约 5~10 分钟，要安装 ffmpeg 和 yt-dlp。

### 方式 B：手动创建

**New → Web Service** → 选仓库，然后设置：

- **Runtime：** Docker
- **Dockerfile Path：** `./Dockerfile`
- **Instance Type：** Free
- **Region：** Singapore
- **Health Check Path：** `/health`

环境变量：

| 变量 | 值 | 说明 |
|---|---|---|
| `API_TOKEN` | 一串随机字符（可以在终端运行 `node -e "console.log(crypto.randomUUID())"` 生成） | **必填**。网页「连接设置」里填同一个值 |
| `CORS_ORIGINS` | `https://<用户名>.github.io,https://halfhalf-*.vercel.app` | 允许跨域的前端网址。**只写协议加域名，不带路径**；`*` 匹配一段子域名 |
| `RATE_LIMIT` | `60` | 每个 IP 每分钟可发起的搜索、解析、下载次数 |
| `MAX_DOWNLOADS` | `1` | 免费实例内存小，同时只下载一首更稳 |

镜像里已经设置好的变量（`HOST=0.0.0.0`、`PORT=10000`、`ENABLE_SIGNALING=1`、`YTDLP_JS_RUNTIMES=node` 等）不用填，见 `Dockerfile`。Render 会把 `PORT` 注入进来，服务按它监听。

### 镜像里有什么

- `node:22` + `python3` + `ffmpeg` + `tini`。yt-dlp 装在 `/opt/yt-dlp` 虚拟环境里（Debian 不允许往系统 Python 里 `pip install`）。
- 构建时安装**最新版** yt-dlp；容器每次启动还会在后台检查更新（最多 120 秒，不影响启动）。YouTube 和 B 站经常改接口，旧版 yt-dlp 很快就会失效。设置 `YTDLP_AUTO_UPDATE=0` 可以关闭自动更新。
- 新版 yt-dlp 解析 YouTube 需要 JS 运行时，默认只找 deno。镜像里已经有 Node，`YTDLP_JS_RUNTIMES=node` 让 yt-dlp 直接用它。
- 进程以非 root 用户 `node` 运行，只写 `/tmp/halfhalf`。

### 验证

部署完成后，Render 会给出地址，例如 `https://halfhalf-music.onrender.com`。

```bash
curl https://halfhalf-music.onrender.com/ping            # → pong
curl https://halfhalf-music.onrender.com/health          # → {"ok":true,"uptime":…}
curl https://halfhalf-music.onrender.com/api/health      # → 401（没带令牌，说明令牌生效了）
curl -H "Authorization: Bearer <你的 API_TOKEN>" https://halfhalf-music.onrender.com/api/health
```

最后一条返回 `ytdlp` 版本号、`"ffmpeg": true` 和音源列表，后端就绪。

### 可选：Cookie（Render 的 Secret Files）

Cookie 等同于账号密码，**不要**放进仓库或环境变量。用 Render 的 **Secret Files** 上传：

1. 服务页 → **Environment → Secret Files → Add Secret File**。
   - 文件名填 `bilibili.txt`，内容粘贴 B 站 Cookie。格式见 `music-service/.env.example`，大会员账号可以解析 Hi-Res 无损。
   - YouTube 同理，文件名填 `youtube.txt`（Netscape cookies.txt 格式）。
2. 添加环境变量：`COOKIE_PATH=/etc/secrets/bilibili.txt`、`YT_COOKIE_PATH=/etc/secrets/youtube.txt`。

### 可选：TURN（跨境 / 4G 连接）

在 Render 环境变量里填 `METERED_DOMAIN` + `METERED_API_KEY`，或者 `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`。后端的 `/ice.json` 会签发短期凭证给双方。原理和方案对比见 [TESTING.md「D. 跨网络 / 跨境连接」](TESTING.md)。

---

## 第 2 步（二选一）：前端部署到 GitHub Pages

1. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
2. 仓库 **Settings → Secrets and variables → Actions → Variables** 标签页 → **New repository variable**：

   | Name | Value |
   |---|---|
   | `MUSIC_API_URL` | `https://halfhalf-music.onrender.com`（第 1 步的地址，结尾不带 `/`） |
   | `PAGES_BASE` | 可选。绑定了自定义域名时填 `/` |

   这里只放公开地址，**不要**放 `API_TOKEN`：构建产物（`app-config.js`）是公开的。
3. 推送到 `main`（或在 **Actions → Deploy to GitHub Pages → Run workflow** 手动触发）。工作流会依次执行：
   - `npm ci`
   - `npm test`
   - 按仓库名计算部署路径（`/<仓库名>/`）
   - `npm run build:deploy`（Vite 构建，再用 `MUSIC_API_URL` 生成 `app-config.js` 和单页应用回退用的 `404.html`）
   - 发布
4. 完成后访问：
   - 主应用：`https://<用户名>.github.io/<仓库名>/`
   - 单文件版：`https://<用户名>.github.io/<仓库名>/dashboard.html`

## 第 2 步（二选一）：前端部署到 Vercel

1. [Vercel](https://vercel.com/new) → **Import Git Repository** → 选仓库。`vercel.json` 已经写好了构建配置：
   - `installCommand`：`npm ci`
   - `buildCommand`：`npm run build:deploy`
   - 输出目录：`dist`
   - 单页应用回退：没有扩展名的路径都回到 `index.html`
   - 缓存策略：`app-config.js` 不缓存，`assets/` 长缓存
2. **Environment Variables** 添加 `MUSIC_API_URL = https://halfhalf-music.onrender.com`。
3. **Deploy**。项目地址是 `https://<项目名>.vercel.app`；每个分支 / PR 还有预览地址 `https://<项目名>-<hash>-<团队>.vercel.app`。

> 修改 `MUSIC_API_URL` 后需要**重新部署**才会生效，因为它是在构建时写进 `app-config.js` 的。

---

## 第 3 步：回到 Render，放行前端域名

把 `CORS_ORIGINS` 改成真实的前端地址（**只写到域名，不带路径**），多个地址用逗号分隔，例如：

```
https://<用户名>.github.io,https://halfhalf.vercel.app,https://halfhalf-*.vercel.app
```

- GitHub Pages 项目页的网址是 `https://<用户名>.github.io/<仓库名>/`，但浏览器发出的 Origin 只有 `https://<用户名>.github.io`。
- `halfhalf-*.vercel.app` 用来放行 Vercel 的预览部署。不要写成 `https://*.vercel.app`，那样所有人的 Vercel 站点都能跨域调用（虽然没有令牌也用不了）。

保存后 Render 会自动重启服务。

## 第 4 步：在网页里填令牌

1. 打开前端页面（例如 `…/dashboard.html`）。右上角会显示 **「音乐服务需要令牌」**，点它。
2. 在「音乐服务」里填 `API_TOKEN` → **测试**。可能的结果：
   - `连接成功 · yt-dlp … · ffmpeg 可用`：一切正常。
   - `令牌不对（401）`：检查令牌。
   - `服务拒绝了这个网页的跨域请求`：第 3 步的 `CORS_ORIGINS` 没包含这个网址。
   - `连接超时`：Render 正在冷启动，等 1 分钟再试。
3. **保存并应用**，页面会刷新。之后搜索、链接解析、下载都直接走 Render。

令牌只保存在这台设备的浏览器里。手机也想直接用，就在手机上同样填一次；不填也行，加入房间后会经房主代办。

---

## 第 5 步：UptimeRobot 保活

Render 免费实例 15 分钟没有入站请求就会休眠，下次访问要等约 1 分钟。UptimeRobot 每 5 分钟访问一次 `/ping`，服务就一直醒着。

1. 注册 [UptimeRobot](https://uptimerobot.com)。免费版支持 5 分钟间隔，额度以官网为准。
2. **Dashboard → + New monitor**，设置：

   | 项 | 填写 |
   |---|---|
   | Monitor Type | **HTTP(s)** |
   | Friendly Name | `Half&Half 后端` |
   | URL (or IP) | `https://halfhalf-music.onrender.com/ping` |
   | Monitoring Interval | **5 minutes** |
   | Request Timeout | 30 秒或更长：冷启动时第一次请求比较慢 |
   | HTTP Method | `GET` 或 `HEAD`（两种后端都支持） |

   可选：把 Monitor Type 换成 **Keyword**，关键字填 `pong`、条件选 "exists"，这样连返回内容都会检查。
3. **Alert Contacts** 勾选你的邮箱。服务真的挂了（例如构建失败、额度用完被暂停）时会收到通知。
4. **Create Monitor**。几分钟后状态变为 **Up**。

**为什么用 `/ping`：** 它不需要令牌，不读磁盘，不调用 yt-dlp，几毫秒就返回，几乎不消耗资源。`/health` 会多返回运行时长，适合人工查看。**不要**拿 `/api/health` 做探针：它需要令牌，还会探测 yt-dlp / ffmpeg。

**要不要保活：**
- 保活一个服务大约用掉每月 750 小时额度里的 720~744 小时，第二个免费服务就不能再保活了。
- 如果能接受"第一次打开等 1 分钟"，可以不配 UptimeRobot：网页在冷启动期间会自动等待（最长 60 秒）。
- Render 文档里没有提到外部保活。是否符合它当前的服务条款，请自行确认。

---

## 本地预演（不需要任何账号）

模拟"前端在别的域名、后端开令牌"，提交前可以先在本机走一遍：

```bash
# 后端：云端模式（端口 8092）
cd music-service
HOST=0.0.0.0 PORT=8092 API_TOKEN=test-token CORS_ORIGINS=http://localhost:4173 ENABLE_SIGNALING=1 node src/server.js
```

```bash
# 前端：按 Pages 子路径构建并预览（另开一个终端，在项目根目录）
VITE_BASE=/halfhalf/ MUSIC_API_URL=http://127.0.0.1:8092 npm run build:deploy
node node_modules/vite/bin/vite.js preview --base /halfhalf/
```

浏览器打开 `http://localhost:4173/halfhalf/dashboard.html`，在「连接设置」里填 `test-token` 即可。

> 在 Windows 的 Git Bash 里，`VITE_BASE=/halfhalf/` 会被改写成 `C:/Program Files/Git/halfhalf/`。命令前加 `MSYS_NO_PATHCONV=1`，或者改用 PowerShell。

本机已实测：
- 子路径构建；
- 跨域加令牌的搜索、链接解析、下载、`/files` 取文件；
- 401 / 403 / 429；
- WebSocket 信令建房；
- 没有令牌的好友经房主代办搜索。

**Docker 镜像没有在本机构建过**，因为本机没装 Docker。第一次部署时请留意 Render 的构建日志。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 页面一直显示"音乐服务需要令牌" | 没在「连接设置」里填令牌，或者令牌和 Render 上的 `API_TOKEN` 不一致 |
| 测试时报"跨域请求被拒绝"或"连不上" | `CORS_ORIGINS` 没有包含当前网址（注意不带路径、不带结尾 `/`） |
| GitHub Pages 页面空白，控制台 404 `assets/…` | 部署路径不对：项目页需要 `/<仓库名>/`。工作流会自动计算；用了自定义域名时把变量 `PAGES_BASE` 设为 `/` |
| https 页面请求后端被拦截（Mixed Content） | `MUSIC_API_URL` 必须是 `https://`。Render 默认就是 https |
| YouTube 搜索失败："要求登录验证" | 机房 IP 被风控：上传 YouTube Cookie，或只用 B 站音源 |
| 下载完的歌过一阵就没了 | Render 免费实例的磁盘是临时的。浏览器里已经缓存的歌不受影响（「本机曲库」） |
| Render 显示服务被暂停 | 免费时长或出站流量用完了，下个月恢复；或者升级付费实例 |
| 好友手机连不上我 | 和部署无关，是网络打洞问题。配置 TURN，见 TESTING.md「D」 |
