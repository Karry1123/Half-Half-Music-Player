# PixelPlayer × Half&Half：播放器与桌面小组件设计比较及改进提案

日期：2026-11-05。性质：源码审阅与设计建议；本次不修改 UI 或原生实现。
结论：优先借鉴 PixelPlayer 的封面取色、三键主控制层级和圆角形状节奏，同时保留 Half&Half 的双人身份与同步反馈。
所有建议以 Capacitor 内的 React/htm + Tailwind 单文件页面、Java RemoteViews 小组件为实施边界。

## 阅读范围与引用约定

- 无前缀的路径均相对 `F:/Half&Half_Music_Player`，`:数字` 表示审阅时的源码行号。
- `P/` 指向只读 PixelPlayer 克隆根目录，完整路径为：
  `C:/Users/KARRYX~1/AppData/Local/Temp/claude/cc359ed2892165b4/0582c6b0-1a7e-498c-925e-caf1b420e895/scratchpad/pixelplayer/repo`。
- `K/` 是 `P/app/src/main/java/com/theveloper/pixelplay/` 的缩写，以下 Kotlin 引用均按此展开。
- 阅读了 `P/README.md`、`P/docs/performance-report.md`；功能宣传与性能观察不能代替组件调用证据。
- 我方依据 `public/dashboard.html`、`public/mobile.css`、`public/design-tokens.css` 和 Android 实现。
- 已核对 `docs/MOBILE_SYSTEM_UI_DESIGN.md`、`docs/design-system-proposal.md`、`docs/widget-style-options.html`。
- 前两份设计文档包含历史盘点或待实施描述；是否已经实现，以当前源码为准。
- 当前不存在额外的 design-system CSS 文件；本提案使用已存在的 token 文件与页面样式。
- 同时查看现有 `docs/design-reference/pixelplayer-compare/pp-now-playing.jpg`、`docs/design-reference/pixelplayer-compare/hh-now-playing.jpg`、`docs/design-reference/pixelplayer-compare/hh-widget-mockup.jpg`。
- 图片证明视觉参考，无法证明其构建版本；小组件 mockup 不能当作真实 Launcher 截图。
- 未启动两款 App、未构建 APK；以下运行表现与风险均明确作为推断或待验收项。

## 1 PixelPlayer 设计语言总结

### 1.1 整体语言：Material 3 的色彩角色与有表现力的控件

PixelPlayer 使用 Compose + Material 3，以大面积色面、圆角封面、胶囊组和圆润字体建立整体感。
颜色不是简单的“背景 + 一个强调色”：容器、容器文字、按钮、按钮文字分别采用配对色彩角色。
`K/ui/theme/Theme.kt:116` 区分系统动态色、显式色板覆盖与固定回退色板。
Android 12+ 且没有覆盖色板时走系统 dynamic light/dark scheme；指定封面色板时采用其明暗配对。
因此“壁纸动态色”与“封面动态色”是两条来源，不应在我方方案里混成同一功能。

| 维度 | 可核查的定义或实际调用 | 设计意义 |
|---|---|---|
| 固定深色回退 | `K/ui/theme/Color.kt:5` 起：深紫 `#1E1234`、主紫 `#AB47BC`、粉 `#F06292`、橙 `#FF8A65` | 无可用动态色时仍有完整品牌底色 |
| 固定浅色回退 | `K/ui/theme/Color.kt:15` 起：背景 `#F7F2FF`、surface `#FBF8FF`、primary `#6C4FF5`、primaryContainer `#E3DBFF` | 明暗模式不是简单反相 |
| 基础形状 | `K/ui/theme/Shape.kt`：small 8dp、medium 16dp、large 24dp | 基础形状有层级，特殊播放器形状另行定义 |
| 常规字体 | `K/ui/theme/Type.kt:68` 起：本地 Google Sans Flex 可变字体，ROND 轴 100，封装为 GoogleSansRounded | 圆润字形与控件形状呼应 |
| 字体刻度 | 同文件：headlineSmall 24sp/32sp、titleLarge 22sp/28sp、bodyLarge 16sp/24sp、bodySmall 12sp/16sp | 字号和行高成对定义 |
| 特殊标题 | 同文件另有 Montserrat 与 ExpTitleTypography，例如 displayLarge 60sp | 不能把所有页面字体都概括成 Montserrat |
| 组件间距 | `K/presentation/components/player/FullPlayerContent.kt:1158` 起：主按钮横向 12dp、纵向 8dp，主辅控件之间 14dp | 连续控制组用紧间距，组间用留白 |

### 1.2 从封面生成 seed 与明暗色板的真实链路

入口是 `K/presentation/viewmodel/ColorSchemeProcessor.kt`，并非在每次进度变化时取色。
先查内存与数据库缓存，缓存键包含封面 URI、palette style、accuracy；内存 LRU 为 20 项。
图片由 Coil 在 IO 调度器加载，请求 128×128、ARGB_8888、禁用硬件位图，允许后续像素读取。
CPU 取色在 Default 调度器执行，提取后回收位图，结果写回缓存和数据库。
后台请求 channel 容量 32，满时丢弃最旧请求，避免快速切歌积压。

`K/ui/theme/ColorRoles.kt:39` 定义最大采样边长 128、量化最大颜色数 128。
`K/ui/theme/ColorRoles.kt:104` 的 extractSeedColor 读取像素，再调用 selectSeedColorArgbFromPixels。
`K/ui/theme/ColorRoles.kt:178` 起的核心步骤如下：

1. 计算平均色作为候选缺失时的回退。
2. 用 QuantizerCelebi 将像素量化成颜色与人口占比。
3. 判断是否以中性色为主，避免灰阶封面被强行染成鲜艳颜色。
4. 转入 HCT，按色相邻域占比、chroma 和代表色保真度评分，并随 accuracy 调整。
5. 对排名第一的 seed 做局部精炼；不是简单挑最高饱和度，也不是直接调用标准 Score.score。
6. 用 seed HCT 生成 light/dark scheme，再映射为 Compose ColorScheme；异常回退固定色板。

评分初始参数可在 `K/ui/theme/ColorRoles.kt:27` 核对：targetChroma 48、占比权重 0.7、chroma 截止 5、最低邻域占比 0.01。
`K/ui/theme/ColorRoles.kt:532` 按样式选择 SchemeTonalSpot、SchemeVibrant、SchemeExpressive 或 SchemeFruitSalad。
默认 TONAL_SPOT 见 `K/data/preferences/AlbumArtPaletteStyle.kt`；中性封面还会得到灰阶色板。
对我方的启发是“一个 seed → 一组受控的颜色角色”，不能只把采样 RGB 直接塞给背景与按钮。

### 1.3 Now Playing：封面、波浪与两级控制组

实际主体为 `K/presentation/components/player/FullPlayerContent.kt`，由 UnifiedPlayerSheet 系列容器承载。
`K/presentation/components/scoped/SheetThemeState.kt:152` 将播放器区域背景设为 miniPlayerScheme.primaryContainer。
`K/presentation/components/UnifiedPlayerSheetV2.kt:697` 将这一颜色用于播放器区域背景。
FullPlayerContent 通过 LocalMaterialTheme 获得封面色板，前景采用 onPrimaryContainer，强调色采用 primary/onPrimary。
这种设计把封面与页面连成整体，正文仍依赖配对前景色保证清晰。

- 封面：`K/presentation/components/AlbumCarouselSelection.kt:185` 实际传入 18dp 圆角。
- 封面尺寸：`K/presentation/components/player/FullPlayerContent.kt:1040` 附近按 carousel style 取可用宽度的 1、0.8 或 0.6，具有露出相邻封面的模式。
- 暂停反馈：同文件约 1024 行将封面缩为 0.95，使用 260ms FastOutSlowIn tween，播放恢复为 1。
- 歌名：同文件 `:2152` 使用 headlineSmall、Bold、GoogleSansRounded；艺人采用 titleMedium（18sp/24sp），具有更弱层级。
- 进度：同文件 `:1880` 确实调用 WavySliderExpressive，而不是仅存在未使用组件。
- 波浪参数：`K/presentation/components/WavySliderExpressive.kt:73` 起，stroke 5dp、thumb radius 8dp、播放振幅 4dp、交互竖线高 24dp。
- 动态条件：同文件 `:126` 仅 enabled、playing 且未交互时保留波浪振幅；拖动与暂停收敛为更稳定的轨道。
- 时间：FullPlayerContent 的时间行在轨道下方两端，12sp SemiBold，给轨道更完整的横向空间。
- 主控制：FullPlayerContent `:1158` 调用 AnimatedPlaybackControls，并覆盖高度为 80dp；组件默认值 90dp 不是此处实际高度。
- 三键：前一首、播放/暂停、后一首各有大块填色区域，间隔 6dp；中央按钮播放/暂停圆角目标为 60dp/26dp。
- 按压：`K/presentation/components/player/AnimatedPlaybackControls.kt:60` 起，权重基准 1、被按键 1.1、其余 0.65，并有触感反馈。
- 底部：FullPlayerContent `:2545` 的私有 BottomToggleRow 才是当前主体调用；不要误读同名独立文件的默认值。
- 底部实际外壳：60dp 平滑圆角、surfaceContainerLowest 70% 透明度、内边距与按钮间距各 6dp。
- 底部状态：shuffle/repeat/favorite 分别使用 primaryFixed/secondaryFixed/tertiaryFixed；未激活背景为 onSurface 7%。

### 1.4 顶栏、手势与动效：参考截图与当前源码的区别

参考截图里，“Now Playing”左右分布收起、歌词与队列按钮，整体是明确的页面顶栏。
当前克隆的 `K/presentation/components/player/FullPlayerContent.kt:696` 起仍有 Now Playing 标题与 42dp 收起按钮。
但竖屏歌词入口实际位于歌曲信息旁的 48dp 按钮；队列入口在顶栏，见同文件 `:1593` 的注释与分支。
横屏则把歌词、队列放在歌曲信息区域的一组 42×50dp 按钮中；顶栏还包含 Cast 等条件内容。
因此产品目标可采用截图的双按钮顶栏，但不应宣称当前源码所有方向都完全如此。

封面轮播选择、上滑队列、下拉折叠由播放器容器协作；FullPlayerContent `:617` 起处理向上队列拖动。
我方应先借鉴明确入口与手势排除区，再评估增加轮播，避免误触同步切歌。
`K/presentation/components/scoped/SheetThemeState.kt:175` 起使用一个动画进度统一插值色板。
换色使用 medium-low stiffness spring；小播放器出现另用 260ms tween，不是全局所有动画共享一个时长。
FullPlayerContent 顶栏可见性还使用 350ms 进入、220ms 退出；部分控件有 Material expressive motion。
`P/docs/performance-report.md` 将 artwork、widgets、MediaSession、UI work 分开测量，提示持续动画必须关注性能。

### 1.5 Glance 小组件：三种专用版式与已存在的波浪绘制能力

| 样式 | 源码及几何参数 | 实际信息结构 |
|---|---|---|
| 4×1 bar | `K/ui/glancewidget/BarWidget4x1.kt:63` 起；容器 28dp、padding 16dp、封面 44dp/圆角 16dp | 歌名 14sp、歌手 12sp、三键 40dp；播放角半径播放时 16dp、暂停时 20dp |
| 4×2 control | `K/ui/glancewidget/ControlWidget4x2.kt:67` 起；容器 28dp、padding 16dp、封面 80dp | 歌名 16sp、歌手 14sp；底行 shuffle/prev/play/next/repeat 五个等权 48dp 高控件 |
| 2×2 grid | `K/ui/glancewidget/GridWidget2x2.kt:59` 起；容器 28dp、内部格子 16dp、格间 6dp | 上排封面与播放、下排前后曲；不显示歌名/歌手，优先扩大触控面积 |

三种专用小组件均为 SizeMode.Exact；目标格数是 Launcher 建议，不等于固定物理像素。
配置分别见 `P/app/src/main/res/xml/bar_widget_4x1_info.xml`、`P/app/src/main/res/xml/control_widget_4x2_info.xml`、`P/app/src/main/res/xml/grid_widget_2x2_info.xml`。
bar 最小 245×56dp、control 245×110dp、grid 110×110dp，updatePeriodMillis 均设为 0。

取色由播放服务输出：`K/data/service/MusicService.kt:2039` 起将明暗色板角色转成 WidgetThemeColors。
`K/ui/glancewidget/WidgetUtils.kt:43` 的 getWidgetColors 将 surface、title、artist、两类按钮前背景映射成日夜 ColorProvider。
无主题颜色时回退 GlanceTheme；所以不只是“封面当背景”，而是正文、控件都融入相同色板。
`K/ui/glancewidget/WidgetComponents.kt` 负责封面降采样、圆角和共享按钮；位图缓存按 4MiB 控制。

**波浪进度的准确结论：存在可借鉴代码，但当前三种专用小组件未调用它。**
`K/ui/glancewidget/subcomponents/WavyLinearProgressIndicator.kt:50` 把 Android Canvas 绘制的 Bitmap 放进 Image。
其默认高度 24dp、轨道 6dp、thumb radius 8dp、振幅 3dp，暂停时振幅归零。
组件注释明确：相位动画需要外部更新机制；Glance 本身不会让这张位图持续动起来。
对整个 glancewidget 目录检索该函数名，仅找到定义，没有调用点。
较大的 `K/ui/glancewidget/PixelPlayGlanceWidget.kt:858` 还保留“Progress bar commented out”的注释。
因此我方可以实现静态波浪快照，但不能把它写成 PixelPlayer 三种专用版式已经运行的实时动画。

## 2 两个 app 的共同点

1. 都以方形专辑封面、歌名、艺人、进度、前后曲与播放暂停构成主要播放体验。
2. 都有全屏播放器与较紧凑的播放入口；我方 mini player 见 `public/dashboard.html:5008`。
3. 都支持深浅主题、圆角容器和图标控制，我方已有语义 token、44px 触控下限与 reduced-motion 处理。
4. 都有播放模式与队列相关能力；我方以四态模式切换、接下来列表和替换歌单实现，交互语义并不相同。
5. 两者小组件均可展示封面并控制前后曲与播放；都通过原生状态快照更新，不应把 Web 页面塞进桌面小组件。
6. **我方小组件已经封面取色**：`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java:129` 起按 24×24 采样、24 个色相桶加权求主色。
7. 我方同文件 `:156` 起已用主色生成深色渐变，并按尺寸缓存背景；建议是扩展角色配色，不是从零重做。
8. 都通过 Android 媒体会话服务对接通知；我方已有封面、进度元数据与三项 MediaStyle 控制。

## 3 差异对比表

以下“已有”均指当前代码，截图目标作为设计参考单独说明。

| 元素 | Half&Half 现状 | PixelPlayer 现状 / 参考 | 改进方向 |
|---|---|---|---|
| 整体语言 | 暖黑、奶油字、琥珀房主/玫瑰房客、同步绿；语义 token 已落地 | Material 3 明暗角色、圆润字形、填色大控件 | 保留关系语义，播放器局部采用封面色板 |
| 全屏背景 | `public/mobile.css:55` 使用全局 canvas，曲目变化不改色 | primaryContainer 随封面 scheme 变化 | 生成播放器局部 background/on-background |
| 封面 | `public/dashboard.html:5022`：340px 上限、rounded-2xl；窄屏 CSS 收至 280px | 18dp 圆角轮播，尺寸随 carousel style 变化 | 让封面占可用宽度，圆角增强，短屏适配 |
| 标题/艺人 | `public/dashboard.html:5023`：text-xl bold、普通艺人、另有聆听次数 | headlineSmall bold + titleMedium，圆润字体、时间独立 | 建立更鲜明字号差，统计信息移入详情 |
| 进度轨道 | `public/dashboard.html:3512`：时间与直线同一行 | WavySliderExpressive，时间在轨道下方 | 完整宽轨道与 SVG 波浪视觉层 |
| 主控制 | 五项一排，72px 主圆钮、44px 辅助按钮 | 80dp 高三块主控制，按压形变 | 三大胶囊与辅助操作分层 |
| 次操作 | 四态模式循环按钮，无当前歌曲 favorite UI | 底部 shuffle/repeat/favorite 三段胶囊 | 先拆出已有模式，收藏另建真实状态 |
| 顶栏 | 只有居中收起箭头；dialog 有语义名称但无可见标题 | Now Playing 顶栏；入口位置随方向/版本变化 | 可见标题、收起、队列，歌词分期接入 |
| 手势 | 下拉超过 100px 收起，滚动顶部启用；无封面横滑 | 轮播选歌、上滑队列、容器折叠 | 保留关闭手势，先明确队列按钮 |
| 歌词入口 | 当前 dashboard 未见歌词视图或歌词数据通路 | 歌词弹层、获取与导入流程 | 属于功能项目，不能只新增图标 |
| 队列入口 | `public/dashboard.html:5025` 的“切换歌单”禁用 guest；下方另有 UpNextPanel | 当前播放队列及手势入口 | 分清查看队列与替换歌单，允许 guest 查看 |
| 双人状态 | SyncStatus、CoListenPill、两人状态、接下来列表 | 本地/远程播放上下文，没有我方房主房客模型 | 单一紧凑状态区，完整详情按需展开 |
| 动效 | token 120/180/240ms；下拉关闭另有固定 220ms | 色板统一插值、封面暂停缩放、控制组弹性反馈 | 采用少量 transform/opacity，尊重减少动态 |
| 小组件尺寸 | 4×2、2×2；可双向缩放；没有独立 4×1 provider | 4×1 bar、4×2 control、2×2 grid，另有综合组件 | 新增紧凑规格放 P1，先改现有两种 |
| 小组件背景 | 封面主色深渐变；文字/主按钮仍固定资源色 | 明暗 ColorProvider 覆盖容器、文字与按钮 | 扩成完整配对色板与主题回退 |
| 小组件布局 | 大版封面+文字+三键；小版 44dp 封面+文字+底部三键 | grid 舍弃文字换四格大触控，control 多模式控制 | 小版优先可按性，保留产品所需的最少信息 |
| 小组件进度 | 大版已有 3dp 直线 ProgressBar，小版无进度 | 波浪 Bitmap 函数存在但未在三专用版式调用 | P1 静态波浪，沿用低频状态刷新 |
| 通知 | 原生 Notification.MediaStyle + MediaSession、封面与三动作 | Media3 DefaultMediaNotificationProvider 包装为 local-only | 保留系统媒体样式，不承诺复制播放器布局 |

通知证据：`android/app/src/main/java/com/halfhalf/musicplayer/PlaybackService.java:226` 起构建 MediaStyle，`:147` 起写入封面/时长元数据。
PixelPlayer 见 `K/data/service/LocalOnlyMediaNotificationProvider.kt:18` 及 `K/data/service/MusicService.kt:897` 的安装调用。
具体通知背景、圆角与系统进度表现受 Android/SystemUI/厂商实现影响，不能用播放器 CSS 或 Glance 直接控制。

## 4 现有实现的具体问题

### 4.1 全屏播放器

- **视觉割裂**：`public/mobile.css:55` 与 `public/dashboard.html:5016` 都指向固定 canvas 色；原生 widget 却已有封面色背景，跨入口缺少同曲一致性。
- **主辅操作挤在一层**：`public/dashboard.html:5025` 把模式、前曲、播放、后曲、切换歌单排成一行。
  `public/mobile.css:193` 固定五列，前三个传输动作只有中央按钮填色，左右跳曲的视觉权重弱。
- **封面尺寸受固定上限限制**：`public/mobile.css:308` 上限 340px、`:338` 窄屏 280px，`public/dashboard.html:5022` 圆角为 16px。
  不等于发生溢出；问题是大屏手机仍较保守、圆角和主按钮形状缺少统一节奏。
- **首屏信息密度偏高**：`public/dashboard.html:5023` 将完成次数直接放在标题组，`:5026` 常驻音量，`:5027` 后又进入双人状态区。
  `public/mobile.css:307`、`:337` 的组间距加重纵向占用；短屏可能需要滚动才能看完核心控制，需真机验证。
- **可见顶栏欠完整**：`public/dashboard.html:5020` 只有收起按钮；“正在播放”仅为 ARIA 名称，缺少可见位置提示与内容工具入口。
- **进度缺少独立视觉空间**：`public/dashboard.html:3525` 起时间各占 w-10，另有 gap，压缩轨道宽度。
  `public/dashboard.html:104` 至 `:108` 为普通直线样式；并非缺少拖动能力，现有 pointer/key/blur 提交应复用。
- **队列语义不清晰**：`public/dashboard.html:5025` 的 ListMusic 打开替换歌单弹层；`:5031` 又提供 UpNextPanel。
  直接将前者改名“队列”会误导；应单独查看接下来列表，再保留仅房主可用的替换动作。
- **不能直接复制 shuffle/repeat 两个独立开关**：`public/dashboard.html:3592` 使用 order/loopAll/loopOne/shuffle 单一枚举。
  若伪装成可同时开启的两个状态，将与现有队列逻辑冲突，guest 权限也必须遵循 session 方法。
- **尚无歌词和单曲收藏基础**：当前全屏仅包含封面、元数据、播放、音量和同步区；好友页面“收藏到我的歌单”不是当前歌曲 favorite。
- **关闭动效与 token 有偏差**：`public/dashboard.html:5019` 超阈值后固定等 220ms，但 `:5016` 用 normal token，现值 180ms。
  应统一收尾事件与时长，避免今后调整 token 时留下不匹配；现有 reduced-motion 分支应保留。

### 4.2 Android RemoteViews 小组件

- **已有取色仅作用于背景**：`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java:165` 起限制 HSV 亮度并绘制渐变。
  `android/app/src/main/res/values/colors.xml:4` 起的文字 `#F7F0E8`、主按钮 `#D7852F` 仍固定；封面冷色时琥珀按钮可能显得分离。
- **只提供深色视觉**：同一 provider 的背景算法固定压暗，资源只有 Android 12+ 圆角覆盖，尚未形成与系统日夜配对的文字/按钮色板。
- **小版宽度预算冲突**：`android/app/src/main/res/layout/widget_player_small.xml:62` 起三键各 40dp、中央左右各 2dp，共 124dp。
  加左右 10dp padding 后需至少 144dp；但 `android/app/src/main/res/xml/widget_player_small_info.xml:7` 允许最小宽 110dp。
  在 Launcher 实际可用宽度偏小时存在裁切/挤压风险；这是可计算风险，不声称已经真机复现。
- **触控目标不一致**：大版 `android/app/src/main/res/layout/widget_player.xml:89` 起前后曲 40dp、播放 48dp；小版三键均 40dp。
  对拇指控制可优先做到 48dp 目标，必要时压缩信息，而不是继续缩小图标区域。
- **小版封面与空白分配弱**：`android/app/src/main/res/layout/widget_player_small.xml:24` 固定 44dp 封面，中间弹性空白、底部三键。
  作为 2×2 可探索四格布局，封面和控制共享更大的格子；但 PixelPlayer grid 不展示歌名，需要产品权衡。
- **进度实现可扩展但非实时**：`android/app/src/main/res/layout/widget_player.xml:66` 起是 3dp ProgressBar。
  `android/app/src/main/res/drawable/widget_progress.xml` 固定直线配色；`android/app/src/main/java/com/halfhalf/musicplayer/PlaybackService.java:44` 为 30 秒节拍。
  波浪若改为位图也只能表达某次刷新快照，不能以后台高频刷新模拟网页动画。
- **恢复状态信息在小版不足**：`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java:89` 的状态文本只写入大版。
  小版在服务不活跃时换成播放图标并跳转恢复，但没有相同的“打开继续”提示，需提供最少可见反馈。
- **圆角并非缺失**：`android/app/src/main/res/drawable/widget_bg.xml`、`android/app/src/main/res/values/dimens.xml:3` 已有 20dp。
  `android/app/src/main/res/values-v31/dimens.xml:3` 使用系统 widget 背景半径，应顺应宿主而非强制一律 28dp。

## 5 建议修改清单

估时为熟悉现有工程的单人开发人日，包含针对性验证；是粗估，不是交付承诺。
P0 先建立可见层级与可用性；P1 补波浪及多规格；P2 才扩大功能与原生状态协议。
本节列出的均是后续建议，本次只新增报告。

### P0：首轮必须做的五项

**P0-1｜播放器局部封面色板。**
改什么：新增 background/on-background、surface、accent/on-accent、track 等局部 CSS 变量，作用域限制为 fullscreen-player。
如何做：封面成功加载后用离屏 canvas 缩至 32×32 或 64×64，过滤透明和极暗像素，采用色相桶/代表色策略生成 seed。
参考我方原生已有 24×24 逻辑保持风格接近；首轮不宣称与 PixelPlayer 的 HCT 结果完全一致。
用受控明度/饱和度生成明暗配对，测正文至少 4.5:1、控件关键边界至少 3:1；无封面/灰阶/CORS 失败回退现有 token。
缓存键使用稳定曲目 ID + 封面版本；异步结束核对当前封面，避免快速切歌套用旧色；切歌取一次，不跟随进度重算。
跨域图片需服务允许 CORS 或使用已有可读封面字节/本地来源；referrerPolicy 本身不解决 canvas 污染。
文件：`public/dashboard.html`、`public/mobile.css`、`public/design-tokens.css`、`public/coverUrl.js`。
工作量：2–3 日；风险：跨域、晚到封面、对比度、快速切歌；原生代码：否，采用 Web 回退可先交付。

**P0-2｜三大主控制 + 大圆角封面 + 短屏布局。**
改什么：主行只保留 prev/play-pause/next，使用三列弹性胶囊，中央略强，统一约 64–80px 高；封面圆角建议 24–32px。
封面宽度采用 clamp/min 与容器适配，短屏按可用高度缩减；320px 宽仍保证每个主键至少 48px 触控。
时间挪至进度下方，音量与次数进入详情；双人状态保留一条紧凑提示，接下来列表下置，核心控制优先出现在首屏。
按钮继续调用 session.act，不改变 guest 请求路由、canNext、加载态禁用条件。
文件：`public/dashboard.html`、`public/mobile.css`、`public/design-tokens.css`。
工作量：1.5–2.5 日；风险：短屏/横屏、长标题、触控与滚动冲突；原生代码：否。

**P0-3｜补全可见顶栏，澄清队列与辅助操作。**
改什么：顶栏“正在播放”+收起+查看队列；查看使用已有 UpNextPanel，替换歌单作为队列内的房主动作。
guest 可查看并通过既有 session.act 请求播放，不能因旧“切换歌单”权限而封锁整个队列入口。
辅助胶囊先承载已有模式状态与可用动作；若视觉上拆 shuffle/repeat，必须体现当前单一枚举的互斥映射，不创建虚假独立状态。
歌词、favorite 在 P2 的真实数据能力完成后再加入；不要用不可用的装饰按钮占据常用入口。
文件：`public/dashboard.html`、`public/mobile.css`；复用现有返回层与 dialog 处理。
工作量：1.5–2 日；风险：队列与歌单语义、焦点返回、房客权限；原生代码：否。

**P0-4｜修复两种 widget 的最小尺寸与触控预算。**
改什么：大版保留封面/歌名/歌手/状态，主键 48dp；小版用两行或四格控制，保证最小宽度下不出现 124dp 控制行挤进 90dp 内容宽。
通过 onAppWidgetOptionsChanged 读取尺寸选择紧凑/常规 RemoteViews 版式，或同步提高最小宽度；保留两人收听与恢复提示。
验证 2×2 实际尺寸再确定是否保留歌手；四格方案至少在内容描述或紧凑文本里给出当前歌曲上下文。
文件：`android/app/src/main/res/layout/widget_player.xml`、`android/app/src/main/res/layout/widget_player_small.xml`、`android/app/src/main/res/xml/widget_player_info.xml`、`android/app/src/main/res/xml/widget_player_small_info.xml`。
原生入口：`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java`、`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetSmallProvider.java`。
工作量：2–3 日；风险：Launcher 网格差异、字体放大、冷启动动作；原生代码：是，Java/XML RemoteViews。

**P0-5｜把 widget 已有主色扩展为可读的整套颜色。**
改什么：复用 dominantColour，生成背景、标题、次文字、三键容器与图标配对；浅色模式提供浅色 tint，深色模式保留压暗版本。
使用 setTextColor、ImageView tint 或缓存着色位图与 RemoteViews 可调用 setter；圆角胶囊可用预绘制小背景 Bitmap，避免自定义 View。
缺图保留资源回退；缓存包含封面版本、主题、尺寸；主题切换或封面晚到时正确失效，并控制位图总大小。
文件：`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java`、`android/app/src/main/res/values/colors.xml`、`android/app/src/main/res/drawable/widget_button_bg.xml`、`android/app/src/main/res/drawable/widget_play_bg.xml`。
工作量：1.5–2.5 日；风险：日夜切换、极亮/极暗封面、Binder 位图成本；原生代码：是，不需要迁移 Glance。

### P1：完成标志性视觉与规格

**P1-1｜Web 波浪进度，保留原生 range 交互。**
改什么：SVG path 显示已播波浪与未播直线，时间移至下方；透明 input[type=range] 作为可访问交互层。
装饰 SVG 设 pointer-events:none 与 aria-hidden；保留当前 onInput 预览、pointer/key/blur 提交与 canSeek 权限。
播放且可见时才用 requestAnimationFrame 推动相位；暂停/拖动/后台/减少动态时停止，拖动时轨道趋平。
控制 SVG 在进度端点剪裁，短曲、0 时长与结束位置均不越界；首轮建议 4–5px 轨道、2–4px 振幅而非照搬 dp。
文件：`public/dashboard.html`、`public/mobile.css`、`public/design-tokens.css`。
工作量：2–3 日；风险：触屏拖动、键盘、WebView 性能、动画与实际进度漂移；原生代码：否。

**P1-2｜RemoteViews 静态波浪进度快照。**
改什么：大版进度区换为 ImageView，由 Java Canvas/Path 画波浪、余轨与端点；播放时固定相位，暂停振幅归零。
继续在状态变化和既有 30 秒节拍刷新，不增加常驻动画或 1 秒 worker；它是进度指示器，不承诺任意位置拖动 seek。
小版只有空间足够才显示；生成尺寸受实际 option 和像素上限约束，文字进度写进 contentDescription。
文件：`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java`、`android/app/src/main/java/com/halfhalf/musicplayer/PlaybackService.java`、`android/app/src/main/res/layout/widget_player.xml`、`android/app/src/main/res/drawable/widget_progress.xml`。
工作量：1.5–2 日；风险：位图传输、缩放锯齿、旧状态快照；原生代码：是，Android Canvas + RemoteViews。

**P1-3｜新增 4×1 bar，统一小组件系列。**
改什么：封面+两行文本+三控制，参考 PixelPlayer 的紧凑条形；不足宽度时优先保留播放/下一首，给出明确规格。
通过新的 Java provider、布局与 widget-info 资源注册为独立选择；这些是待新增文件，本报告不伪造现存路径。
现有接入文件：`android/app/src/main/AndroidManifest.xml`、`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java`、`android/app/src/main/res/values/strings.xml`。
工作量：2–3 日；风险：Launcher 预览、实际可用高度、receiver 注册、最小触控预算；原生代码：是。

**P1-4｜统一播放器动效与返回体验。**
改什么：换色约 180–260ms，轻微按压缩放，封面播放状态变化最多缩至 0.97；以 CSS transform/opacity 为主。
关闭流程用 transitionend 并设超时兜底，使等待与 token 一致；减少动态时立即收尾，不添加持续封面旋转。
补充弹层初始焦点、焦点约束与关闭后的焦点返回，保留既有 Android back/Escape/下拉。
文件：`public/dashboard.html`、`public/mobile.css`、`public/design-tokens.css`。
工作量：1–2 日；风险：触摸取消、快速开关、动态偏好变更；原生代码：否。

### P2：需要真实业务能力支撑的扩展

**P2-1｜歌词与 favorite，完成目标顶栏/底部胶囊。**
改什么：歌词需要来源、缓存、无结果态、逐行时间与当前曲目切换；收藏需要稳定曲目 ID、持久化与列表反馈。
布局可采用参考截图顶栏歌词/队列并列、底部 shuffle/repeat/favorite；先决定是否把播放模式改成独立 shuffle 与 repeat 状态。
文件入口：`public/dashboard.html`、`public/mobile.css`；如扩展模式，需要审查现有 `public/playQueue.js` 的状态契约。
工作量：歌词 4–7 日、收藏 2–3 日；独立模式组合另估；风险：数据来源、旧状态迁移、房客同步语义。
原生代码：仅 Web 功能不需要；若要在 widget 增加收藏/模式按钮则需要继续扩展原生协议。

**P2-2｜原生 widget 增加模式/收藏控制及跨端色板一致性。**
改什么：在 4×2 空间足够时增加模式，新增字段必须从 JS store 经 Capacitor 传到原生，并在动作回传时保持房主/房客规则。
色板可增加 seed 与 schema version 的持久化，以减少 Web/Java 各自算法造成的同曲色偏；不必传整张封面反复取色。
文件：`public/nativePlayback.js`、`android/app/src/main/java/com/halfhalf/musicplayer/PlaybackSessionPlugin.java`、`android/app/src/main/java/com/halfhalf/musicplayer/PlaybackStateStore.java`、`android/app/src/main/java/com/halfhalf/musicplayer/PlaybackService.java`、`android/app/src/main/java/com/halfhalf/musicplayer/PlayerWidgetProvider.java`。
工作量：3–5 日，依赖 Web 状态契约稳定；风险：服务重建、旧 prefs 默认值、重复动作、guest 请求；原生代码：是。

### 分期验收与边界

- P0：320/360/412px 手机宽度、短屏横屏、长中英歌名、缺图/灰图/纯白图、快速连续切歌均可操作。
- P0：本机、房主、房客、接收中、重连中保持明确状态；颜色变化不能重定义身份色、告警色与同步成功色。
- P0：真实 Launcher 验证两种小组件最小/最大尺寸、系统字体放大、日夜切换、封面晚到与服务不活跃后的恢复提示。
- P1：TalkBack/键盘仍可操控 range；减少动态、页面隐藏和暂停不持续绘制波浪；widget 保持低频快照。
- P2：模式组合/收藏持久化/歌词切歌正确，再开放相应图标；不要预先把不存在的功能包装成可用入口。
- 通知保持系统 MediaStyle，优先验证标题、艺人、封面、进度、前后曲和暂停恢复；不做定制通知皮肤。
- 我方不用 Compose/Glance 重建界面；Web 视觉落在 CSS/JS/SVG，桌面视觉落在 RemoteViews/XML/Canvas 位图。

本次文档检查范围：引用路径存在性、行号范围、200–500 行要求，以及仅新增指定报告；未将设计建议表述为已实施或真机验收。
