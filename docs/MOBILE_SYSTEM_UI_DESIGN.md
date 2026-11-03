# Android 系统界面接入设计：安全区、媒体通知、桌面小组件

日期：2026-11-03 · 状态：三阶段已实现（同日），真机验收见 `ANDROID_DEVICE_QA.md` · 适用：Capacitor 8 Android 壳（`android/`）加 `public/dashboard.html` 单文件前端

## 0. 现状盘点

读代码得到的事实，三部分设计都建立在这上面：

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 安全区 CSS 变量 | 已有。`--safe-top/right/bottom/left` 兼容 Capacitor 注入值与浏览器 `env()`，body、sticky 头、播放条、弹窗均已应用；`body::before` 把状态栏那条画成毛玻璃 | `public/mobile.css`、`public/design-tokens.css:190` |
| 状态栏/导航栏 | `capacitor.config.json` 里 `SystemBars.insetsHandling: css`、`style: DARK`，写死，不随主题变 | `capacitor.config.json` |
| 主题 | 启动时按 `prefers-color-scheme` 写 `html[data-theme]`，没有运行时切换入口 | `public/dashboard.html:12` |
| 前台服务通知 | capawesome 前台服务插件，普通通知样式，三个文字按钮（上一首/暂停/下一首），无封面、无进度条、暂停按钮不会变成“播放” | `public/dashboard.html` 约 2150 行起 |
| MediaSession | 自研 `PlaybackSessionPlugin`，只给系统媒体键与锁屏送标题、歌手、时长、进度，没有送封面（无 `METADATA_KEY_ART`） | `android/.../PlaybackSessionPlugin.java` |
| 封面 | 曲目上有 `cover` 字段，网络 URL 或本地库路径，`coverUrl.js` 负责候选与回退 | `public/coverUrl.js` |
| 原生代码 | 只有三个 Java 文件：`MainActivity`、`PlaybackSessionPlugin`、`AudioGuardPlugin`；minSdk 24，target 36 | `android/app/src/main/java/...` |

结论：第一部分是收尾，第二部分是把两套各自为政的东西合成一个，第三部分是新建原生模块。三部分共用一条“JS 把播放状态推到原生、原生把按钮事件推回 JS”的通道，建议按 1 → 2 → 3 顺序做，因为第 3 部分直接复用第 2 部分的状态仓库。

---

## 1. 刘海屏与状态栏安全区

### 1.1 目标

- 内容延伸到状态栏和手势条底下（沉浸式），但任何可点击、可阅读的东西都不被遮挡。
- 状态栏图标颜色随应用主题：浅色主题用深色图标，深色主题用浅色图标。
- 横屏时打孔/刘海那一侧自动留白，另一侧不留。
- 键盘弹起时底部播放条不被顶飞，也不盖住输入框。
- 普通浏览器里零影响（所有变量落回 0px）。

### 1.2 方案

**A. 原生层：真正的 edge-to-edge**

- `MainActivity.onCreate` 里调用 `EnableEdgeToEdge.enable(this)`（androidx.activity 1.8+），状态栏与导航栏背景透明。Capacitor 8 在 target 35+ 已默认 edge-to-edge，但显式调用可以消掉三键导航模式下系统强制加的半透明底色。
- `styles.xml` 给 `AppTheme.NoActionBar` 加 `android:windowLayoutInDisplayCutoutMode = shortEdges`（API 28+ 用单独的 `values-v28`），刘海区域允许绘制内容，否则横屏时系统会在刘海侧塞一条黑边。
- 加 `@capacitor/system-bars` 依赖，暴露 `SystemBars.setStyle({ style })`，供 JS 在主题变化时调用。现有 `capacitor.config.json` 的静态 `style: DARK` 保留作首帧默认值。

**B. JS 层：主题与状态栏联动**

- 在 `dashboard.html` 设置 `dataset.theme` 的地方包一层 `applyTheme(theme)`，同时调用 `SystemBars.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' })`，并监听 `matchMedia('(prefers-color-scheme: dark)')` 的 `change` 事件，让系统切深色模式时状态栏图标同步翻转。
- 把 `<meta name="theme-color">` 也跟着改，PWA 与浏览器地址栏同样受益。

**C. CSS 层：补齐三个缺口**

1. 横屏侧边：目前 `body` 已经 padding 了 `--safe-left/right`，但 `.mini-player`、`.hh-navigation`（底部 tab 栏）和 `.fullscreen-player` 是 `position: fixed`，不吃 body 的 padding。给它们各加 `padding-inline: max(16px, var(--safe-left)) max(16px, var(--safe-right))`。
2. 键盘：viewport 已经写了 `interactive-widget=resizes-content`，Manifest 是 `adjustResize`，所以键盘弹出时 `100dvh` 会缩小。把 `.mini-player` 与底部 tab 栏在 `body:has(input:focus-visible, textarea:focus-visible)` 时 `transform: translateY(100%)` 隐藏，避免被挤到键盘上方占掉半屏。
3. 状态栏条：`body::before` 已画出毛玻璃条。补一条规则，全屏播放页（`.fullscreen-player`）打开时把这条条的背景改成透明，只保留 blur，让封面色能透上去。

### 1.3 改动清单

| 文件 | 改动 |
| --- | --- |
| `android/app/src/main/java/.../MainActivity.java` | `EnableEdgeToEdge.enable(this)` |
| `android/app/src/main/res/values-v28/styles.xml` | 新增，`windowLayoutInDisplayCutoutMode=shortEdges` |
| `package.json` / `capacitor.config.json` | 加 `@capacitor/system-bars` |
| `public/dashboard.html` | `applyTheme()` 加状态栏样式与 `theme-color` 联动 |
| `public/mobile.css` | fixed 元素横屏 padding、键盘时隐藏底栏、全屏播放页状态栏条透明 |

### 1.4 验收

- 真机：带刘海的竖屏、横屏左/右各一次、手势与三键导航各一次、系统深浅色切换一次。
- 浏览器：Chrome 桌面与安卓 Chrome 各开一次，确认 `--safe-*` 为 0 时布局与现在一致。
- 对照 `ANDROID_DEVICE_QA.md` 的真机清单追加“状态栏图标颜色”“横屏打孔侧留白”“键盘弹出底栏”三项。

工作量：1 天内，含真机。

---

## 2. 通知栏与锁屏媒体控制

### 2.1 目标

- 通知栏显示封面大图、歌名、歌手、可拖动的进度条，按钮是上一首 / 播放或暂停（随状态切换图标） / 下一首。
- 锁屏显示同样的封面与控制。
- 通知与 MediaSession 是同一个东西，按钮事件只有一条路径回到 JS。
- 保留现有行为：暂停即停前台服务并释放唤醒锁，Guest 按键变成发给房主的请求。

### 2.2 为什么要换掉现有前台服务插件

capawesome 的前台服务插件只能发普通样式通知，没有 `MediaStyle`、没有大图、没有进度条，按钮也只能是文字。要封面和进度条就必须自己起通知，而通知又必须和 MediaSession 绑定，所以把“前台服务 + 通知 + MediaSession”合成一个自研的 `PlaybackService`，移除 capawesome 插件。这也顺手去掉了 `PlaybackSessionPlugin` 和前台服务两条独立的 JS 订阅。

### 2.3 原生结构

```
PlaybackSessionPlugin (Capacitor 插件，JS 入口)
  ├─ update(state)         JS 每次状态变化推一次：title/artist/cover/duration/position/playing/canNext/role
  ├─ setArtwork(id, bytes) 封面字节，按曲目 id 缓存到 cacheDir/artwork/<id>.jpg
  └─ 事件 action           play/pause/next/prev/seek(position) → JS 里的 session.act()

PlaybackService (前台服务，type = mediaPlayback)
  ├─ MediaSession（从插件迁过来，同一实例）
  ├─ NotificationCompat.MediaStyle 通知，setMediaSession(token)，showActionsInCompactView(0,1,2)
  ├─ 持有 PARTIAL_WAKE_LOCK（原插件在做的事）
  └─ PlaybackStateStore：把最近一次 state 写进 SharedPreferences，供小组件读（第 3 部分用）
```

- 插件负责把 JS 状态转成 `MediaMetadata`（含 `METADATA_KEY_ALBUM_ART` 位图）和 `PlaybackState`，再 `startForegroundService` 或 `updateNotification`。
- `playing=false` 持续超过 2 秒，`stopForeground(STOP_FOREGROUND_DETACH)` 并保留通知，可以从通知继续播放；`active=false`（没有曲目）则 `stopSelf` 并删通知。这比现在“一暂停就撤通知”更符合用户预期，也保留了释放锁的效果。
- Android 13+ 通知权限：首次开播时请求一次 `POST_NOTIFICATIONS`，拒绝了也不影响前台服务与锁屏控制，只是不显示通知，和现在一致。
- Android 14+ 的 `foregroundServiceType="mediaPlayback"` 与 `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限在 Manifest 里已经有，迁移到自研 service 时照抄。

### 2.4 JS 侧

- `dashboard.html` 里现有两段（`nativeMedia.update` 和 `NativeFG` 那段）合成一个 `nativePlayback` 订阅：订阅 store，按 `[currentId, playing, duration, canNext, role, peerName]` 去重后调用 `update`。
- 封面：切歌时通过 `coverCandidates(item)` 拿 URL，`fetchCover` 取字节（本地库走 Filesystem，网络走 fetch），缩到 512 像素后 `setArtwork`。失败用 `fallbackArtwork(title)` 生成的占位图。只在 `currentId` 变化时做，不要每次进度更新都做。
- 浏览器端 `navigator.mediaSession` 那段原样保留，`isAndroid` 时跳过，避免原生与 WebView 两份 MediaSession 打架（现在就是两份并存，锁屏偶尔显示 WebView 那份的标题）。

### 2.5 通知文案

通知副标题利用现有 `role` 信息：房主显示“和 xx 同步收听”，Guest 显示“正在听 xx 的歌”，单人显示歌手。和 WebView MediaSession 里 `album` 字段现有文案保持一致。

### 2.6 改动清单

| 文件 | 改动 |
| --- | --- |
| `android/.../PlaybackService.java` | 新增，前台服务 + MediaStyle 通知 + 唤醒锁 + 状态仓库 |
| `android/.../PlaybackSessionPlugin.java` | 改为把状态转给 service，增加 `setArtwork` |
| `android/app/src/main/AndroidManifest.xml` | 注册 `PlaybackService`，删 capawesome 的 receiver/service |
| `android/app/src/main/res/drawable/` | `ic_play`、`ic_pause`、`ic_skip_next`、`ic_skip_previous` 矢量图 |
| `package.json` | 移除 `@capawesome-team/capacitor-android-foreground-service` |
| `public/dashboard.html` | 合并两段原生订阅，新增封面推送 |
| `MOBILE_ANDROID.md` | “JS 前台服务核心配置”一节改写 |

### 2.7 验收

- 通知出现封面、进度条可拖、暂停后图标变播放。
- 锁屏显示封面与三个按钮，耳机线控与蓝牙按键仍可用。
- 暂停 2 秒后通知仍在、前台服务已停（`adb shell dumpsys activity services`）；清掉曲目后通知消失。
- 播放中锁屏 10 分钟不断音（沿用 `ANDROID_DEVICE_QA.md` 既有项）。
- Guest 端按通知按钮，房主端同步切歌。
- 通知权限拒绝时播放不受影响。

工作量：1.5 到 2 天，含真机。

---

## 3. 桌面小组件

### 3.1 目标与边界

- 一个 4×2 的小组件：封面、歌名、歌手、同步状态一行小字、上一首 / 播放暂停 / 下一首，点封面打开 App。
- 可选再出一个 2×2 的小号：只有封面叠播放按钮。
- 边界：小组件是静态快照，不能跑网页，没有歌词、没有实时进度条。App 进程被杀后，小组件显示最后一次状态并把按钮改成“打开 App 继续”。只做 Android，项目当前没有 iOS 打包。

### 3.2 数据流

```
JS store ──update──▶ PlaybackSessionPlugin ──▶ PlaybackService
                                                   │  写 SharedPreferences("playback_state")
                                                   │  写 cacheDir/artwork/<id>.jpg
                                                   ▼
                                       sendBroadcast(ACTION_STATE_CHANGED)
                                                   ▼
                                       PlayerWidgetProvider.onUpdate / onReceive
                                                   │  读 prefs + 封面 → RemoteViews
                                                   ▼
                                            AppWidgetManager.updateAppWidget

小组件按钮 ──PendingIntent──▶ PlaybackService(ACTION_PLAY/PAUSE/NEXT/PREV)
                                   │ service 活着：MediaSession.Callback → 插件 notifyListeners → JS session.act()
                                   │ service 不在：启动 MainActivity 并带上 extra "pendingAction"，
                                   │   JS 启动后由 @capacitor/app 的 appUrlOpen/launch 读到并执行
```

这就是为什么第 3 部分要排在第 2 部分之后：状态仓库和封面缓存都由 `PlaybackService` 维护，小组件只读不写。

### 3.3 原生实现要点

- `PlayerWidgetProvider extends AppWidgetProvider`，布局 `widget_player.xml` 用 `RemoteViews` 允许的控件：`ImageView`、`TextView`、`ImageButton`、`LinearLayout`。
- 封面用 `setImageViewBitmap`，位图先缩到 256 像素，RemoteViews 有约 1MB 的 IPC 上限。
- Android 12+ 支持圆角与动态取色：`widget_player.xml` 背景用 `?android:attr/colorBackground` 加 `system_accent1` 系列颜色，提供 `values-v31` 一套；低版本用固定深色。
- `res/xml/widget_player_info.xml`：`minWidth 250dp / minHeight 110dp`，`updatePeriodMillis = 0`（完全靠广播刷新，不要轮询），`widgetCategory = home_screen`，`previewLayout` 给选择器看。
- `targetCellWidth/Height = 4/2`，并加 `resizeMode = horizontal|vertical`，2×2 小号单独一个 provider。
- 进度：不做进度条。只在“正在播放”时显示 `▶ 02:14 / 04:30` 文本，由 service 每 30 秒刷一次，暂停即停刷。再高频会被系统限制并耗电。

### 3.4 JS 侧

- 第 2 部分已经把状态推给原生，小组件不需要新的 JS 调用。
- 唯一新增：App 冷启动时读 `pendingAction`。放在 `dashboard.html` 的启动流程里，等 store 恢复、`session` 就绪后执行一次 `session.act(action)`，然后清掉。

### 3.5 改动清单

| 文件 | 改动 |
| --- | --- |
| `android/.../PlayerWidgetProvider.java` | 新增 |
| `android/.../PlaybackService.java` | 状态变化时发广播；处理小组件 PendingIntent；30 秒进度刷新 |
| `android/app/src/main/res/layout/widget_player.xml`、`widget_player_small.xml` | 新增 |
| `android/app/src/main/res/xml/widget_player_info.xml` | 新增 |
| `android/app/src/main/res/values-v31/` | 动态取色与圆角 |
| `android/app/src/main/AndroidManifest.xml` | 注册 provider 与 `APPWIDGET_UPDATE` intent-filter |
| `public/dashboard.html` | 冷启动读取 `pendingAction` |

### 3.6 验收

- 添加小组件后立刻显示当前曲目；切歌、暂停、恢复各刷新一次。
- 从小组件按下一首，App 在前台、后台、被杀三种状态下都生效（被杀时先拉起 App）。
- Guest 端按键同样变成房主请求。
- 系统深浅色、动态取色切换后小组件配色跟随（Android 12+）。
- 关掉 App 一夜，小组件不消失、不卡在旧封面。
- 加入 `ANDROID_DEVICE_QA.md` 真机清单。

工作量：2 到 3 天，含真机。

---

## 4. 总排期与依赖

| 阶段 | 内容 | 依赖 | 估时 |
| --- | --- | --- | --- |
| 1 | 安全区收尾、状态栏主题联动 | 无 | 1 天 |
| 2 | 自研 `PlaybackService`，MediaStyle 通知，封面与进度 | 无（可与 1 并行） | 1.5 到 2 天 |
| 3 | 桌面小组件 | 阶段 2 的状态仓库与封面缓存 | 2 到 3 天 |

风险点：

- 阶段 2 去掉第三方前台服务插件后，后台保活要重新按 `ANDROID_DEVICE_QA.md` 的锁屏 10 分钟、微信切换、来电三项跑一遍。
- 国产 ROM（MIUI、HarmonyOS、ColorOS）对小组件广播刷新有额外限制，可能需要用户手动给“自启动”权限。小组件上放一行“点击打开 App”做兜底。
- 封面来自第三方音乐源时可能有防盗链，`fetchCover` 失败就用占位图，不阻塞通知。
