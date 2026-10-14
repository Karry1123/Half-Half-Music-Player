# Android 专项优化与部署清理

当前 Android 入口是 `public/dashboard.html`，`src/App.jsx` 是另一套 React/WebRTC 页面。Android 构建会把前者作为启动页面；不能只修改后者。本次修改全部在本地，没有推送、发布或创建 Release。

## 已落地

- viewport 使用 `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`，保留缩放能力。
- Tailwind 保持手机单列、桌面多列；触屏按钮至少 44px 高，表单字体至少 16px。
- `public/mobile.css` 同时支持 Capacitor 8 注入的 `--safe-area-inset-*` 和浏览器 `env(safe-area-inset-*)`。顶部、横屏两侧和底部均留出安全区。
- `ResizeObserver` 测量播放器实际高度，为内容预留滚动空间。键盘检测兼容窗口和 visualViewport 一起缩小的情况，输入时隐藏底栏；Android Activity 使用 `adjustResize`。
- `public/mobileRuntime.js` 是唯一 Android 返回事件入口。弹层按打开顺序后进先出；随后关闭试听、搜索结果，播放台回大厅，房间等待/连接状态退出房间；根视图两秒内再按一次才退出。退出某一层会清除上次退出计时。返回搜索时使未完成请求失效，防止结果重新弹回。
- 更新提示也可返回关闭；已开始的 APK 下载不会因关闭提示而中止。
- Android 音频直接使用 HTMLAudioElement，避免分析器所在 AudioContext 挂起造成静音。浏览器仍保留频谱分析。Android 因此不显示真实音频频谱。
- 复用已安装的前台服务插件，它的 Android 实现已持有 PARTIAL_WAKE_LOCK。服务启动/更新/停止按顺序串行处理，避免快速切歌产生竞态；暂停即停止服务并释放锁。通知包含上一首、暂停、下一首。HTML MediaSession 保留标题、歌手、专辑、封面、进度和播放/暂停/跳转事件。
- `scripts/bundle-dashboard.mjs` 在构建时打包 React、htm、PeerJS 等依赖并编译 Tailwind；APK 不再依赖 CDN 才能显示页面。音乐搜索、房间连接仍需要网络。

## 后台播放的边界

Manifest 原先已包含 `WAKE_LOCK`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK`、`POST_NOTIFICATIONS` 和 `foregroundServiceType="mediaPlayback"`，所以“再加一遍权限”不是修复。

MediaSession 用于系统媒体交互，前台服务用于提高运行优先级；二者都不是 JavaScript 或 AudioContext 永不挂起的保证。没有添加静音循环或无意义心跳。别的应用真正抢占音频焦点时，暂停可能是正确行为。强行停止应用、厂商省电限制、WebView 渲染进程被终止，仍能中断播放。

如果产品要求脱离 Activity/WebView 生命周期持续播放，应继续迁移到 **Media3 ExoPlayer + MediaSessionService**：服务持有播放器、原生队列和音频焦点，JS 仅发送命令和订阅状态。本次仍保留现有 HTMLAudio/P2P 同步架构，不声称已经完成这项原生播放器迁移。后台 WebRTC 心跳/精确同步也不能仅靠 FGS 保证。

参考：[Android 后台播放](https://developer.android.com/media/platform/mediaplayer/background)、[Capacitor App 返回键](https://capacitorjs.com/docs/apis/app)、[System Bars 安全区域](https://capacitorjs.com/docs/apis/system-bars)。

## 本地曲库到底存在哪里

| 环境 | 音频、封面与元数据 | 特点 |
|---|---|---|
| 网页 | IndexedDB：Blob 与元数据分表 | 不要求任意文件系统访问；按网站 origin 隔离；可能受到浏览器配额/清理策略影响 |
| Android | Capacitor Filesystem `Directory.Data/library-v1/` | App 私有目录；无需公共存储权限；重启/覆盖安装保留，清除应用数据或卸载删除 |

Android WebView 能使用 IndexedDB，但无需把它作为新曲库的主存储。本次原生适配器将音频、封面和每首曲目的 JSON 全部放入私有目录，不进行双份新缓存。写入时分块传输 base64，音频写完再提交元数据；读取音频使用 `convertFileSrc()`，避免一次性通过桥返回巨大 base64 字符串。当前播放器/P2P API 最终仍需要 Blob；超大文件完全流式播放需要下一阶段更改播放器和传输协议。

统一入口：`public/libraryStorage.js`。调用方继续使用：

```js
import * as Library from './libraryStorage.js';
await Library.saveTrack(file, { title: file.name, fileName: file.name });
const tracks = await Library.listTracks({ sort: 'addedAt', order: 'desc' });
const audioBlob = await Library.getBlob(tracks[0].id);
await Library.deleteTrack(tracks[0].id);
```

完整接口还有 `getTrack/findByHash/findBySource/updateTrack/markPlayed/coverUrl/usage/requestPersist/subscribe/exportTrack/exportAll/clearAll`。

首次新版 Android 启动会把旧 IndexedDB 曲库迁移到私有目录，按指纹去重，可在失败后重试。迁移标记仅在全部成功后写入；旧 IndexedDB 保留作为备份，不自动删除，因此迁移期间需要额外空间。迁移后的新保存/删除仅影响原生曲库。旧数据备份不代表两个库持续同步。当前采样指纹是去重标识，不是安全校验哈希。

“导出”与“离线保存”是两件事：Android 离线保存不等于系统 Downloads 文件夹。当前单曲导出复制到缓存后交给系统应用打开/分享，不宣称已经永久保存到 Downloads；批量浏览器下载在 Android 禁用。需要批量保存到用户指定公共目录时应单独实现 SAF 文件夹授权。

## 清理清单

| 文件/目录 | 处理 | 原因 |
|---|---|---|
| `vercel.json`、`vite.config.js`、`index.html`、`package*.json` | 保留 | 前端构建与 Vercel 路由/缓存 |
| `render.yaml`、`Dockerfile`、`.dockerignore`、`deploy/docker-entrypoint.sh` | **必须保留** | Render 配置为 Docker runtime，Docker 是当前后端部署依赖 |
| `server/`、`music-service/` 及其锁文件 | 保留 | 信令、ICE、搜索/解析/下载后端 |
| `capacitor.config.json`、`android/` 原生源码、Gradle wrapper | 保留 | Android 可复现构建；不要删除 wrapper JAR |
| `scripts/write-app-config.mjs`、`bundle-dashboard.mjs`、`prepare-android-web.mjs`、`gradle.mjs` | 保留 | 三种目标的实际构建链路 |
| `.github/workflows/build-apk.yml` | 保留 | 可选 APK CI/版本更新来源，本次没有触发发布 |
| `.github/workflows/deploy-pages.yml` | 保留 | GitHub Pages（karry1123.github.io/Half-Half-Music-Player/dashboard.html）作为国内访问的主入口；Vercel 继续保留 |
| `dist/`、`android/**/build/`、`node_modules/`、Gradle 缓存 | 可重新生成，忽略 | 不属于源码；本次保留构建结果便于验收 |
| `.env*`、签名密钥、本机 SDK 路径、IDE 文件 | 忽略 | 环境与凭据不得进入版本库；保留 `.env.example` |
| `src/` | 暂不删除 | Vercel 根入口仍依赖这一套页面；合并两套 UI 后才能退役 |

`.dockerignore` 已排除 Android 工程、APK、签名文件、构建缓存，减少 Render 上传的构建上下文。`.gitignore` 已补充构建缓存、IDE、APK/AAB 和本地环境文件。旧 DEPLOY/README 中的 Pages 指南仅供历史参考，以本清单为准。

建议结构（无需为了整洁而立即搬动所有路径）：

```text
android/             原生工程
src/                 React 原入口
public/              Dashboard 与共享存储/移动端模块
server/              信令与 ICE
music-service/       音乐后端
scripts/             构建与开发脚本
deploy/              Render 容器入口
tests/               回归测试
.github/workflows/   APK 构建
docs/                后续可集中 README 之外的专题文档
package.json / package-lock.json
vite.config.js / vercel.json / render.yaml
capacitor.config.json / Dockerfile / .dockerignore / .gitignore
```

## 验收

运行 `npm test`、`npm run cap:sync`、`npm run android:debug`。构建时设置公开的 `MUSIC_API_URL` / `SIGNAL_URL` 等配置；未设置音乐服务地址的 APK 会使用演示搜索，不会自动连接你的 Render 实例。不要把 API_TOKEN 写进前端构建产物。

真机清单：320/360/390px 竖屏、横屏、手势/三键导航；设置/本机曲库/二维码/试听/搜索/房间等待逐层返回；根视图双击退出；搜索键盘开关；导入大文件、重启后离线播放、旧库迁移后检查数量；播放时锁屏 10 分钟、微信切换、耳机媒体键、通知权限拒绝、来电音频焦点、暂停后检查前台服务停止。

以下附录直接摘录本次实现，完整集成见 `public/dashboard.html`。

## 统一 Android 返回键实现

```js
import { nativePlugin } from './nativeBridge.js';
// One owner for Android back events. Layers are ordered by opening time.
const layers = [];
export function pushBackLayer(close) {
  const layer = { close };
  layers.push(layer);
  return () => { const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1); };
}

export function createBackHandler({ keyboard, navigate, notify, exit, now = Date.now }) {
  let lastPress = null;
  return () => {
    if (layers.length) { lastPress = null; layers.at(-1).close(); return; }
    if (keyboard() || navigate()) { lastPress = null; return; }
    const time = now();
    if (lastPress !== null && time - lastPress < 2000) { lastPress = null; exit(); }
    else { lastPress = time; notify('再按一次退出应用'); }
  };
}

export async function installAndroidBack(options) {
  const cap = window.Capacitor;
  if (cap?.getPlatform?.() !== 'android') return () => {};
  const app = nativePlugin('App');
  const handle = await app.addListener('backButton', createBackHandler({
    ...options, exit: () => app.exitApp(),
    keyboard: () => {
      const el = document.activeElement;
      if (el?.matches('input, textarea, [contenteditable="true"]')) { el.blur(); return true; }
      return false;
    },
  }));
  return () => handle.remove();
}

```

## 安全区域与触屏 CSS

```css
:root {
  --safe-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
  --safe-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
  --safe-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
  --safe-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
  --player-height: 0px;
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; min-width: 0; overflow-x: clip; }
body { padding: var(--safe-top) var(--safe-right) 0 var(--safe-left); }
#root { min-width: 0; padding-bottom: calc(var(--player-height) + var(--safe-bottom) + 16px); }
.sticky.top-0 { top: var(--safe-top); }
.player-bar { padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left); }
[role="dialog"], [role="alertdialog"] {
  padding-top: max(16px, var(--safe-top));
  padding-bottom: max(16px, var(--safe-bottom));
  overflow-y: auto;
  overscroll-behavior: contain;
}
@media (max-width: 767px) {
  input, select, textarea { font-size: 16px !important; }
  button { min-height: 44px; }
  button[aria-label] { min-width: 44px; }
  input[type="range"].hh { height: 32px; }
  input[type="range"].hh::-webkit-slider-thumb { opacity: 1; width: 18px; height: 18px; margin-top: -7px; }
  .player-bar > div { padding: 8px 12px; gap: 4px; }
  .player-bar .gap-5 { gap: 12px; }
  main, section, header, .grid > *, .flex > * { min-width: 0; }
}

```

## AndroidManifest（实际完整配置）

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="false"
        android:networkSecurityConfig="@xml/network_security_config">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:windowSoftInputMode="adjustResize"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>

        <!-- Foreground service from @capawesome-team/capacitor-android-foreground-service.
             Keeps playback alive when the app is in the background (type: media playback). -->
        <receiver
            android:name="io.capawesome.capacitorjs.plugins.foregroundservice.NotificationActionBroadcastReceiver"
            android:exported="false" />
        <service
            android:name="io.capawesome.capacitorjs.plugins.foregroundservice.AndroidForegroundService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />
    </application>

    <!-- Network -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

    <!-- Background audio playback -->
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

    <!-- Install the downloaded update APK through the system package installer (the user still has to confirm). -->
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

    <!-- Notifications (playback notification, Android 13+ asks at runtime) -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <!-- Legacy storage access for saving / exporting songs on old Android versions.
         Android 10+ uses scoped storage and the system file picker, which need no permission. -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
</manifest>

```

## JS 前台服务核心配置

```js
const NativeFG = (() => {
  const C = window.Capacitor;
  if (!C?.isNativePlatform?.() || C.getPlatform?.() !== 'android') return null;
  try {
    return nativePlugin('ForegroundService');
  } catch {
    return null;
  }
})();

if (NativeFG) {
  let running = false, lastKey = '', asked = false;
  let work = Promise.resolve();
  const sync = async () => {
    const s = get();
    const item = s.library.find(x => x.id === s.currentId);
    // Read current state inside the serialized job, never a stale subscription snapshot.
    if (!item || !s.playing) {
      if (running) await NativeFG.stopForegroundService();
      running = false; lastKey = ''; return;
    }
    const key = item.id + '|' + item.title + '|' + item.artist;
    if (running && key === lastKey) return;
    const opts = {
      id: 4101, title: item.title || 'Half&Half', body: item.artist || '正在播放',
      smallIcon: 'ic_stat_music', serviceType: 2, silent: true, notificationChannelId: 'playback',
      buttons: [{ id: 1, title: '上一首' }, { id: 2, title: '暂停' }, { id: 3, title: '下一首' }],
    };
    if (!running) {
      await NativeFG.createNotificationChannel({ id: 'playback', name: '音乐播放', importance: 2 });
      // Start promptly while visible. Notification permission is not a prerequisite for an FGS.
      await NativeFG.startForegroundService(opts);
      running = true;
      if (!asked && !document.hidden) {
        asked = true;
        NativeFG.requestPermissions().catch(console.warn);
      }
    } else await NativeFG.updateForegroundService(opts);
    lastKey = key;
  };
  const enqueue = () => { work = work.then(sync).catch(e => {
    console.warn('后台播放服务失败', e);
    toast('后台播放服务启动失败，请返回前台重试', 'warn');
  }); };
  let desiredKey;
  store.subscribe(() => {
    const s = get(), item = s.library.find(x => x.id === s.currentId);
    const key = JSON.stringify([s.playing, item?.id, item?.title, item?.artist]);
    // A toast or progress update must not cause an endless failed-service retry loop.
    if (key === desiredKey) return;
    desiredKey = key;
    enqueue();
  });
  NativeFG.addListener('buttonClicked', ({ buttonId }) => session.act(({ 1: 'prev', 2: 'pause', 3: 'next' })[buttonId])).catch(console.warn);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) enqueue(); });
}


```

## 本次验证记录

- 44 项 Node 测试通过，包括返回栈和原生存储模拟桥测试。
- Edge 无头浏览器：320/360/390/768/1280px 无横向溢出；屏蔽外部网络仍可加载。
- Android 桥模拟：设置 → 播放台 → 大厅 → 退出提示 → 第二次退出通过。
- 360px 播放器高 160px，内容底部预留 176px。
- Capacitor sync 与 Android assembleDebug 成功。
- 后续已在 Samsung SM-S931U / Android 17 上完成部分真机验收，并发现修复插件桥、键盘遮挡和原生媒体会话问题；以 [ANDROID_DEVICE_QA.md](./ANDROID_DEVICE_QA.md) 的实测结果与待测范围为准。
