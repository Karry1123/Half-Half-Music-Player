# 本地账号、云端歌单、ZIP 与域名适配

本次仅修改和测试本地代码，未执行 commit、push、部署或修改线上数据库。主功能入口为 `dashboard.html`（Android 同样使用它）。

## 使用方式

账号数据库有两种：**生产用 PostgreSQL**（设置 `DATABASE_URL`，例如 Northflank 免费数据库），**本地开发用 SQLite**（不设 `DATABASE_URL` 时自动使用 `ACCOUNT_DB` 或 `music-service/data/accounts.sqlite`，需要 Node >=22.13）。两者表结构和 SQL 相同，测试在 SQLite、PGlite 和真实 `pg` 驱动三种引擎上跑同一组用例。

```powershell
# 项目根目录；后端默认为账号模式
$env:AUTH_MODE='account'
$env:ACCOUNT_DB='F:\Half&Half_Music_Player\.build-tmp\accounts-local.sqlite'
npm run music

# 另一个终端使用相同 ACCOUNT_DB 生成一个 7 天有效、只能核销一次的邀请码
$env:ACCOUNT_DB='F:\Half&Half_Music_Player\.build-tmp\accounts-local.sqlite'
node music-service/scripts/invite.mjs 7
```

前端构建时设置 `MUSIC_API_URL` 为你的后端地址。浏览器打开 `dashboard.html`，注册、激活；随后新设备登录同一账号，无需再次激活。未激活状态只有账号界面，搜索、解析、下载、云端歌单与自建信令被后端拒绝。HTTP 接口每次从数据库检查账号状态，不信任前端的 `isActivated`。

账号模式不接受共享 API_TOKEN 作为旁路；旧服务兼容需明确设置 `AUTH_MODE=legacy`，此模式关闭账号模块、保留原 API_TOKEN 规则。新前端连接没有 `/auth/config` 的旧服务时会停在连接错误界面，需要前后端一起升级，不会静默降级绕过激活。

Web token 存 localStorage，Android 存 Capacitor Preferences，按后端地址分区。Preferences 不是加密保险箱；本实现按需求持久化，生产更高安全需求可以替换为 Android Keystore 适配器。token 为 256 位随机不透明 Bearer Token（不是 JWT），服务器只保存 SHA-256；30 天有效，退出即时撤销。密码使用独立随机 salt + scrypt；注册/登录/激活有 IP 限流。没有密码找回、邮箱验证或管理后台。

## 数据表

| 表 | 核心列 | 用途 |
|---|---|---|
| users | id PK、username UNIQUE、password、salt、activated、created_at | 密码散列和永久激活状态 |
| sessions | token_hash PK、user_id FK、expires_at | 多设备独立会话、注销 |
| invites | code_hash PK、expires_at、used_by FK、used_at | 事务内单次核销 |
| libraries | user_id PK/FK、revision、metadata、updated_at | 每账号歌单元数据 JSON 和乐观并发版本 |
| peer_tickets | token_hash PK、user_id FK、room、expires_at | 绑定房间的两分钟 P2P 准入凭据，不向对端暴露账号 token |
| download_grants | (user_id, track_id) PK | 下载任务、文件、事件列表的账号隔离 |

`libraries.metadata` 格式：`[{id,name,tracks:[{id,title,artist,sourceId,pageUrl,hash,duration}]}]`。平台源 ID 和原始页面地址用于重新解析 CDN 地址；不保存二进制、账号凭据或过期签名下载 URL。每账号最多 200 个歌单、10000 曲目，HTTP body 上限 2 MB。写入必须携带上次拉取的 revision，过期返回 409，不覆盖其他设备的改动。

入口：主界面右上角云朵按钮打开「云端歌单」面板；账号信息与退出在「设置 → 账号」。打开面板即自动拉取、可见时每分钟刷新；本机歌单通过面板顶部“上传”明确发布/更新，避免把已有的整台设备曲库自动上传。云端列表独立于本地曲库，未缓存的歌曲不会被本地缺失引用清理。点击“下载至本地/缓存全部”按 sourceId/hash 去重、下载缺失文件、写入 Web IndexedDB 或 Android 沙盒，并建立本机歌单。单首失败继续下一首，失败原因标注在对应歌曲下方；音源失效时显示“原音源已失效，无法下载，建议重新搜索源替换”，并自动展开“替换音源”。云端歌单可“从云端移除”（不影响各设备已缓存的歌曲）。云端音源可输入新页面链接“验证并替换”。本地导入曲目只有元数据可同步，另一台设备缺少原文件时明确提示重新导入。

云数据库仅保存元数据。现有下载服务为解决平台 Referer/CORS 仍需代理传输音频，因此并非零服务器带宽；账号模式新产生的下载文件保留一小时供客户端读取，每分钟清理过期文件。不触碰既有无 expiresAt 的历史本机文件。生产应对下载临时目录加磁盘/网络配额；此版没有对用户计费。

P2P 时间校准、音频分片和漂移算法不变。Dashboard 的 PeerJS 连接双方通过后端校验房间票据，自建 `/ws` 在 upgrade 和消息处理时检查账号。仍需可达的 PeerJS 信令与 STUN/TURN；授权不能代替网络连通性。旧 `src/` Vite 播放器同样增加登录/激活门禁与动态授权信令，新增云端歌单/ZIP 的完整入口是 `dashboard.html`。

## 歌单自动同步（v0.2.2 起）

- 同步对象：本机全部歌单（含「默认曲库」）和账号昵称（新表 `profiles`）。触发：打开应用、本机歌单变化后 2 秒、回到前台、每分钟。
- 跨设备识别同一首歌：`sourceId`（同一个 B 站 / YouTube 音源），没有时用音频指纹 `hash:<sha>`。
- 本机歌单新增 `pending` 字段：歌单里有、但这台设备还没下载的歌，界面显示「未下载」，可单首 / 全部下载、移除、音源失效时替换。
- 三方合并（`public/cloudSync.js`）：每台设备在 localStorage `hh.sync.<用户 id>` 记住上次同步结果；和它比较得出本机的增删，再与云端的增删合并，第一次同步取并集。删除歌单写入删除标记 `{ id, deleted: true, updatedAt }`（保留 180 天），其他设备若没改过该歌单就跟着删除，改过则保留。两台设备各自新建的同名歌单在第一次同步时合并为一个；旧版「缓存到本机」生成的 `cloud-<用户>-<id>` 副本自动并回原歌单。
- 在某台设备删除音频文件只会把歌转为「未下载」，不影响歌单和其他设备。
- 写入使用版本号乐观并发，另一台设备刚写过时自动重新拉取合并（最多重试 3 次）。

## ZIP 导出

歌单详情及本机曲库新增“打包导出歌单”。选择歌曲 → 3 路并发读取本地 Blob → 保留真实扩展名 → ZIP 单文件下载。包含 `metadata.json`（schemaVersion、歌单名、顺序、文件名、标题/歌手、来源、hash）。同名文件自动加序号；缺失 Blob 报错，不能生成假成功归档。音频已压缩，ZIP 使用 STORE，避免无意义压缩。当前为浏览器内存打包，单批最大 512 MB，请按设备内存分批；Android 上 ZIP 写入应用缓存目录后交给系统“打开方式 / 分享”面板，由用户选择保存位置或分享。metadata 为后续反向导入准备，本次未实现 ZIP 反向导入。

浏览器仍可能要求确认一次 ZIP 保存位置，但不再每首弹窗。普通单首/目录导出入口保留兼容。

## 路径和国内网络

`vite.config.js` 默认 `base: './'`，也可使用 `VITE_BASE=/` 或 `/Half-Half-Music-Player/`。Dashboard 的 CSS/JS/运行时配置都是相对引用；生产构建将 React、JSZip、图标和 Tailwind 打入本地资源，不依赖 esm.sh 或 Tailwind CDN。源码直接打开的开发页面仍有 CDN importmap，应以构建产物验收国内网络。

```powershell
# GitHub Pages 子目录构建（仅本地生成，未上传）
$env:VITE_BASE='/Half-Half-Music-Player/'
$env:MUSIC_API_URL='https://你的后端域名'
npm run build:deploy
# Vercel 根目录
$env:VITE_BASE='/'
npm run build:deploy
# Android 必须使用相对路径，并设置设备可达的 HTTPS 后端
$env:VITE_BASE='./'
npm run cap:sync
```

404 页面按 VITE_BASE 回到规范的 dashboard 入口，保留 query/hash。静态站点必须设置 MUSIC_API_URL；子路径不是 API 服务地址。CORS_ORIGINS 填 origin，不带路径：`https://karry1123.github.io,https://half-half-music-player.vercel.app,https://你的域名,https://localhost`（最后一个按实际 Capacitor origin 配置）。生产请收紧列表。

仅凭当前测试不能断言 vercel.app 无法访问一定是 DNS 污染：需要在受影响的国内网络依次核对 DNS、TLS、HTML、静态 JS、API CORS 与信令。自定义域名能减少对共享域名的依赖，但 Cloudflare 免费全球 CDN 不能保证中国大陆访问速度或可达性。

可执行的配置方案：

1. 注册自己控制的域名，把 DNS 托管到 Cloudflare；在 Vercel 项目中添加该域名。
2. 按 Vercel 控制台当前给出的 A/CNAME/TXT 值配置 DNS，先用 DNS only 完成域名验证和证书签发，不硬编码网上旧 IP。
3. 若实测确有必要启用 Cloudflare 橙云代理，TLS 设 Full (strict)，避免 Flexible 引起 HTTPS 重定向循环。Vercel 支持 Cloudflare Verified Proxy Lite，但官方仍不推荐一般情况下叠加反代；不能把它当成必然改善连通性的方案。
4. 不缓存账号、授权和音乐 API；`/.well-known/vercel/*` 禁止缓存，证书验证路径按 Vercel 要求放行。更新 app-config 的 apiBase/iceUrl/signalUrl 和后端 CORS。
5. 在移动/联通/电信网络分别检查页面、登录、搜索和 WebRTC；仍不稳定时，将同一份静态 dist 部署到可达区域/国内合规静态托管，后端另设可达域名。音源供应商的地区限制和 TURN 连通性需要独立处理。

参考：[Vercel 反向代理与 Cloudflare 配置](https://vercel.com/docs/security/reverse-proxy)、[Node SQLite 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。

### 生产部署：Northflank 免费 PostgreSQL

Northflank 免费沙盒包含 1 个免费数据库（addon）。不要给服务挂收费的持久卷，改用数据库：

> 已完成（2026-10-14）：addon `halfhalf-db`（PostgreSQL 17，免费档 0.2 vCPU / 512 MB / 6 GB，TLS，仅内网）已运行；密钥组 `halfhalf-database` 把它的 `POSTGRES_URI` 以别名 `DATABASE_URL` 注入，仅限 `halfhalf-music` 服务。账单显示 $0.00。剩下第 4、5 步在推送代码后进行。连接串里的 `sslmode=require` 由代码按 libpq 语义处理（加密、不校验内网 CA），无需手动改。

1. 项目里 **Create new → Addon → PostgreSQL**，选免费套餐（创建前确认页面显示的价格为 0）。
2. 创建完成后打开 addon 的 **Connection details**，复制项目内网连接串（`POSTGRES_URI`，形如 `postgresql://用户:密码@主机:5432/库名`）。
3. 到 `halfhalf-music` 服务的 **Environment** 新增 `DATABASE_URL` = 上面的连接串（推荐用 addon 的 “Link to service / secret group” 自动注入，避免手抄密码）。
4. 确认没有 `AUTH_MODE=legacy`，重新部署。日志出现 `账号数据库: PostgreSQL（DATABASE_URL）` 即成功；数据库刚启动时服务会每 5 秒重试，最多约 1 分钟。
5. 生成邀请码：在服务的 **Shell** 里执行 `node music-service/scripts/invite.mjs 7`（自动使用同一个 `DATABASE_URL`）。

如果 addon 开启了 TLS 且报 `self-signed certificate`，在连接串末尾加 `?sslmode=no-verify`（仅限项目内网连接）。表在启动时自动创建（`CREATE TABLE IF NOT EXISTS`），无需手动建表；重新部署、重启不会丢账号、邀请码和云端歌单。

`render.yaml` 保持免费套餐并设 `AUTH_MODE=legacy`，避免蓝图同步时意外升级为付费实例；要在 Render 上用账号模式，同样设置 `DATABASE_URL` 指向任意 PostgreSQL 并去掉 legacy。

## 文件清单

新增：

- `music-service/src/accounts.js`：表结构、PostgreSQL / SQLite 双引擎（`DATABASE_URL` 优先）、账号、会话、邀请码、元数据同步、房间票据、下载授权和 HTTP routes。
- `music-service/tests/accounts-engines.test.mjs`：同一组账号用例在 SQLite、PGlite、真实 `pg` 驱动（经 TCP 连接串）上运行，含同一邀请码并发激活只有一个成功。
- `music-service/scripts/invite.mjs`：本地管理员邀请码 CLI。
- `server/accountAccess.js`：开发/自托管信令的统一账号校验。
- `public/accountClient.js`：跨端 token、云端 API、本地缓存复用、限时下载轮询和失效源提示。
- `public/accountUI.js`：登录/激活、云端列表、缓存/替换音源、ZIP 选择进度 UI。
- `public/playlistZip.js`：ZIP 与 metadata。
- `tests/cloudCache.test.mjs`、`tests/playlistZip.test.mjs`、`music-service/tests/accounts-http.test.mjs`：新增回归测试。
- 本文档。

改造：`public/dashboard.html`、`public/libraryStorageWeb.js`、`music-service/src/server.js`、`music-service/src/lib/guard.js`、`music-service/src/downloads.js`、`music-service/src/library.js`、`server/signaling.js`、`server/index.js`、`src/account.js`、`src/main.jsx`、`src/engine/session.js`、`src/engine/musicApi.js`、`vite.config.js`、`scripts/write-app-config.mjs`、根及 music-service 的 package/lock、`.gitignore`、`render.yaml`（改为 legacy 模式）、`Dockerfile`（账号数据库目录）、`public/libraryStorageNative.js` / `public/libraryStorage.js`（Android 导出任意文件）、`scripts/bundle-dashboard.mjs`（Tailwind 同时扫描 public/*.js，否则生产包缺少账号界面的样式）、Capacitor 自动生成的 Preferences 插件登记。

## 测试与验收

```powershell
npm test
npm --prefix music-service test
npm run build:deploy
npm run cap:sync
```

复查轮修复：云端缓存把 `saveTrack` 的 `{track, existed}` 当成曲目对象（导致缓存的歌加不进本机歌单）；沿用其他设备的文件指纹；任何 HTTP 404 都被误判为音源失效；Docker 非 root 用户无法创建数据库目录；生产 CSS 缺少账号界面样式。界面改为与应用一致的登录/激活卡片、云端歌单底部面板、ZIP 选择面板（带进度条）。复查后根目录 64 项、音乐服务 9 项测试通过；浏览器实测：注册→未激活时搜索/云端/ICE 均 403→CLI 邀请码激活→上传歌单→清空本机模拟新设备→缓存全部（真实 B 站下载成功、本地导入曲目提示重新导入、失效 YouTube 源显示失效提示）→ZIP 打包校验文件名与 metadata→另一会话登录无需邀请码、退出后 token 失效。GitHub Pages 子路径与 Vercel 根路径构建产物均无 CDN 依赖，404 回退正确。Android QA 包可编译（含 Preferences 插件），真机验收待手机重新连接。

首轮记录：根目录 62 项测试、音乐服务 9 项测试全部通过；本地浏览器完成注册→未激活界面→CLI 邀请码激活→刷新保留登录→发布云端空歌单→设置自动授权。导入 1 秒本地测试 WAV，勾选打包并实际下载 ZIP，检查音频条目、metadata.json 和 ZIP CRC 均成功。

还需上线前环境验收：两台真机的账号模式 P2P/断线重连、Android Preferences 重装/升级场景、国内不同运营商、真实平台音源失效和批量大文件内存。现有播放队列、同步漂移、原生存储、返回键单元回归通过，不等于上述实机/公网验收已完成。
