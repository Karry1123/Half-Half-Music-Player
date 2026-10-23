# Half&Half Music Player 设计系统提案

> 状态：设计提案，未实施。
> 文档语言：简体中文；token 与 CSS 变量名使用英文。
> 目标文件：`docs/design-system-proposal.md`。
> 分析依据：当前工作区源码与项目文档；未使用历史记忆。
> 验证范围：静态源码审计及关键颜色对比度计算；未启动应用、运行测试或构建 APK。

## 1. 产品边界与设计目标

Half&Half 的核心体验是“两个人、一首歌、同一拍”。

用户需要知道：对方是否在、是否听到同一首歌、当前操作会影响谁，以及等待是否正在取得进展。

设计应围绕陪伴、同步与可信反馈展开；单人收听也应保持完整，不把双人关系限定为情侣场景。

### 1.1 两套实际入口

| 入口 | 实现与样式 | 设计系统影响 |
|---|---|---|
| 根页面 | `index.html` → `src/main.jsx` → `src/App.jsx` | React、Zustand、原生 WebRTC；使用 `src/styles.css` |
| Dashboard | `public/dashboard.html` | React/htm、PeerJS、Tailwind、页面内 CSS、独立状态管理 |
| Android | Capacitor → 构建后的 Dashboard | 使用 Dashboard 与 `public/mobile.css`；不是直接启动 `src/App.jsx` |
| Android 构建准备 | `scripts/prepare-android-web.mjs` | 把构建后的根入口转为 Dashboard 跳转 |
| Dashboard 构建 | `scripts/bundle-dashboard.mjs` | 编译 Tailwind 并打包依赖；新增 token 必须进入构建产物 |

不能以“修改 `src/styles.css`”作为 Android 已完成设计迁移的判断依据。

README 部分历史限制与 `MOBILE_ANDROID.md`、现有构建脚本不一致；本提案以当前代码为主要依据。

### 1.2 本次覆盖范围

| 范围 | 覆盖深度 |
|---|---|
| `src/styles.css`、`public/mobile.css` | 全量显式样式值审计 |
| `src/components/*.jsx` | 全量组件、内联样式与可见状态审计 |
| `src/App.jsx`、`index.html` | 布局、入口、全局交互 |
| `src/store/*`、播放 hook | 状态来源与控制权限 |
| Dashboard | 入口、品牌、主题、移动布局、构建及主要状态核对 |
| 账号、好友、发现、统计等 public 模块 | 列入后续统一范围；未声称完成这些模块的全量样式审计 |

## 2. 当前 UI 审计

### 2.1 颜色：React 页面

现有样式已经具有初步主题变量；缺少的是正式分层、统一命名和组件契约。

| 当前变量 | 浅色 | 深色 |
|---|---|---|
| `--bg` | `#f4f1ec` | `#121116` |
| `--surface` | `#ffffff` | `#1c1b22` |
| `--surface-2` | `#faf8f5` | `#232129` |
| `--text` | `#1b1a1f` | `#f1eff4` |
| `--muted` | `#75707a` | `#9a95a3` |
| `--line` | `#e7e2db` | `#2e2c35` |
| `--host` | `#ff6b4a` | `#ff7d5e` |
| `--guest` | `#5865f2` | `#7480ff` |
| `--ok` | `#1fa971` | 沿用浅色 |
| `--warn` | `#e2a03f` | 沿用浅色 |
| `--err` | `#e5484d` | 沿用浅色 |
| `--together` | Host → Guest 的 90deg 渐变 | 同结构，颜色随主题改变 |

| 其余显式颜色 | 用途 |
|---|---|
| `#fff`、`#ffffff` | 按钮、头像、图标前景；两者重复 |
| `#222`、`#111`、`#1a1a1a` | 唱片径向渐变、内环 |
| `#e8e6ec`、`#9a95a3`、`#7480ff` | DebugPanel 文字、次要文字、曲线 |
| `transparent`、`currentColor`、`inherit` | 透明层、SVG 和继承前景 |

| 带透明度的颜色 | 当前全部取值 |
|---|---|
| 黑色 | `rgb(0 0 0 / 15% / 20% / 22% / 25% / 30%)`，分别为独立声明 |
| 白色 | `rgb(255 255 255 / 4% / 10% / 18% / 25% / 70% / 80%)` |
| 暖黑 | `rgb(27 26 31 / 4%)`、`rgb(27 26 31 / 6%)` |
| 调试背景 | `rgb(20 19 24 / 85%)`、`rgb(20 19 24 / 92%)` |
| 调试阈值线 | `rgb(229 72 77 / 50%)` |

| `color-mix()` 配方 | 当前用途 |
|---|---|
| text 25% + line | 按钮悬停边框 |
| ok 12%、warn 14%、err 12% + transparent | 状态标签背景 |
| host 12%、guest 12% + transparent | 身份标签背景 |
| guest 10% + transparent | 当前歌曲背景 |
| guest 35% + transparent | 播放按钮阴影 |
| err 65% + line | 下载错误边框 |
| bg 85%、bg 70% + transparent | 顶栏、拖入遮罩 |

### 2.2 颜色：移动样式与品牌分歧

| `public/mobile.css` 显式值 | 用途 |
|---|---|
| `#0e0c0b` | 全屏播放器背景 |
| `rgba(14,12,11,0.94)` | 系统状态栏下方安全区背景 |
| `#f2a65a`、`#ec7a96` | 热门徽章、开关、焦点 |
| `#86745f`、`#2e2721` | 开关边框、关闭背景 |
| `#dccdbe`、`#151210` | 开关滑块 |
| `rgb(0 0 0 / 75%)` | 热门徽章背景 |

Dashboard 的品牌为 `host #f2a65a`、`guest #ec7a96`、`sync #71d6a4`。

Dashboard 暖黑阶为 `#0e0c0b / #151210 / #1b1714 / #221d19 / #2e2721 / #3e352d`。

Dashboard 沙色阶为 `#f7f0e8 / #dccdbe / #ab9886 / #86745f`。

React 的橙蓝品牌与 Android 的琥珀玫瑰品牌明显分裂。

头像另有七色数据调色板：`#ff7a59 / #5b6cff / #16a37f / #e0559b / #e0a43a / #2f9bd6 / #8a5cf6`。

头像色是已保存的用户数据，不能通过替换主题变量强制改写。

### 2.3 字体与排版值

| 类别 | 当前全部显式值 |
|---|---|
| 正文字体 | `system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif` |
| 等宽字体 | `ui-monospace, Consolas, monospace` |
| 基础 shorthand | `14px/1.5`；调试 `12px/1.5` |
| 固定字号 | CSS：`10,11,12,13,14,15,16,17,18,22px`；SVG 内文字另有 `9` |
| 流动字号 | `clamp(20px,3vw,28px)`；`clamp(32px,6vw,52px)` |
| 显式字重 | `500,600,700,800`；其余继承或使用浏览器默认 |
| 行高 | `1,1.05,1.2,1.4,1.5,1.6` |
| 字距 | `-0.03,-0.02,0,0.02,0.06,0.08,0.12,0.4em` |
| 数字 | 多处使用 `tabular-nums` |
| 动态头像字号 | 实体头像 `size×0.42`；空头像 `size×0.4` |

中文标题沿用 `1.05` 行高，换行时偏紧；11px 标签和 10px 热门徽章也偏小。

### 2.4 间距值

以下为显式声明值；组合顺序均为 CSS 原始顺序，单位默认 px。

| 属性 | 当前值集合 |
|---|---|
| React `gap` | `0,2,4,5,6,8,10,12,16,20,24` |
| Mobile `gap` | `6,8,10,12`；组合 `4 8`、`6 10` |
| React `padding` 单值 | `0,2,6,8,12,16,18,20,24` |
| React `padding` 组合 | `0 10`、`0 12`、`0 14`、`0 5`、`0 6 0 10`、`0 7`、`10 10 10 16`、`10 12`、`10 16`、`14 16` |
| React `padding` 组合续 | `24 8`、`28 40`、`2 6`、`32 16`、`3 8`、`6 0`、`6 10`、`6 8`、`8 14 8 8` |
| React 单轴 padding | top `8,14`；inline `8,10`；另有 safe-area 表达式 |
| React `margin` | `0`、`0 -2`、`0 0 4`、`0 auto`、`10`、`8 0 0` |
| React 单轴 margin | top `-5,2,4,6`；bottom `6`；组件内 top 另有 `8,12` |
| Mobile `padding` | `0`、`8`、`10 16 4`、`2 5`、`3 8`、`8 10`、`8 16` |
| Mobile 单轴 padding | top `0,4,12`；bottom `12`；另有安全区组合 |
| Mobile margin | `0`；left `0`；thumb top `-7` |
| JSX 补充 padding | Playlist Guest 提示 `8px 16px 12px` |

`6/8/10/12/14/16px` 同时承担相近密度，没有正式规则。

负间距 `-2px`、滑块负 margin 属于几何对齐，迁移时应单独保留。

### 2.5 尺寸、布局、圆角与边框

| 类别 | 当前显式尺寸 |
|---|---|
| React 固定 width | `1,3,8,12,16,22,28,36,40,44,52,56,60,76,120,130,200px` |
| React 固定 height | `1,2,3,4,5,6,8,12,16,20,22,26,28,32,36,40,44,48,52,60,64,200px` |
| JSX 补充尺寸 | 删除按钮 `28×28`；格式 select 高 `30`；头像 `24/40/44` |
| 图标尺寸 | 默认 `20`；调用值 `12,14,15,16,18,20,22,26,28,36` |
| React 最小尺寸 | width `0,20,76`；height `18px,100%` |
| React 容器 | Lobby `min(760px,100%)`；房间 max `1280px`；抽屉 `min(560px,100vw)` |
| React 高度限制 | Playlist `calc(100vh - 100px)`；Debug `70vh` |
| React Debug 宽度 | `min(320px,calc(100vw - 32px))` |
| React 网格 | `1fr 1fr`；`minmax(0,1.35fr) minmax(300px,1fr)`；`auto 1fr` |
| React 网格续 | `48px 1fr 48px`；`28px 40px minmax(0,1fr) auto`；`52px minmax(0,1fr) auto`；`40px minmax(0,1fr) 32px` |
| React 比例尺寸 | `100%`、`30%`；唱片内区 inset `22%/47%`；连线起点 `-30%` |
| Mobile 固定尺寸 | `16,18,22,32,36,44,52px`；min-width 另有 `80px` |
| Mobile 视口尺寸 | `100vh/100dvh`；`85vh/85dvh`；唱片 `min(256px,65vw)` |
| Mobile 网格 | `44 44 52 44 44px`；`44px minmax(0,1fr) 44px`；`56px minmax(0,1fr)` |
| Mobile 推荐卡 | `clamp(100px,calc((100% - 18px)/2.5),160px)` |
| Mobile flex 几何 | `calc(100% - 112px)`、`110px` 基准、`36px` 开关基准 |
| 定位常数 | `0,2,4,16,24px`、`50%`；toast top `64px + safe-top` |
| React 圆角 | `1,2,3,6,8,10,12,14,16,20,99px`、`50%` |
| Mobile 圆角 | `999px`、`50%`；Dashboard 另有 Tailwind 圆角体系 |
| 边框/轮廓 | border `1px/2px`，solid/dashed；outline `2px`；offset `2px/3px` |

`99px` 与 `999px` 都在表示胶囊；`50%` 表示圆形，建议保留语义区别。

### 2.6 阴影、透明度与模糊

| 用途 | 当前完整值 |
|---|---|
| 浅色卡片 | `0 1px 2px rgb(27 26 31 / 4%), 0 8px 24px rgb(27 26 31 / 6%)` |
| 深色卡片 | `0 1px 2px rgb(0 0 0 / 30%), 0 8px 24px rgb(0 0 0 / 25%)` |
| 唱片 | `0 10px 30px rgb(0 0 0 / 25%), inset 0 0 0 6px #1a1a1a` |
| 唱片孔 | `inset 0 0 0 2px rgb(0 0 0 / 30%)` |
| 播放键 | `0 6px 18px color-mix(in srgb,var(--guest) 35%,transparent)` |
| 抽屉 | `-12px 0 40px rgb(0 0 0 / 15%)` |
| Toast | `0 8px 24px rgb(0 0 0 / 20%)` |
| 错误 Toast | 上项叠加 `0 0 0 1px var(--err)` |
| AudioUnlock | `0 12px 32px rgb(0 0 0 / 22%)` |
| DebugPanel | `0 12px 32px rgb(0 0 0 / 30%)` |
| backdrop blur | React `4/8/12px`；Mobile `12px` |
| opacity | React `0/0.3/0.4/0.5/1`；JSX `0.6`；Mobile 动画 `0.4/1` |

### 2.7 动效与层级

| 类别 | 当前值 |
|---|---|
| transition | border/background `150ms`；transform `100ms`；进度 width `200/250ms` |
| Mobile transition | background/transform `150ms` |
| 常规动画 | fade `200ms`；drawer `250ms cubic-bezier(0.2,0.8,0.2,1)` |
| Toast | 入场 `180ms ease-out`；退场 `180ms ease-in`，延迟 `2020ms` |
| AudioUnlock | `250ms` 入场 |
| 循环动画 | blink `1/2s`；ping `1.6s`；flow `1.4s linear`；spin `18s linear`；eq `0.9s ease-in-out` |
| eq 相位 | `-0.3s/-0.6s` |
| Mobile 队列翻页 | `220ms ease-out` |
| transform | 按压 `0.97/0.94`；thumb hover `1.15`；ping `0.6→1.6`；旋转 `360deg` |
| 位移动画 | drawer `translateX(100%)`；toast Y `-8/-6px`、scale `0.96`；队列 X `100%/-25%→0` |
| React z-index | `20,40,50,54,55,60,70,75,80` |
| Mobile z-index | 安全区 `55`；全屏播放 `65` |
| 当前断点 | React max `380/560/640/900px`；Mobile max `767px` |

减少动态效果规则关闭了唱片、连线、eq、toast、队列翻页，但没有完整关闭 blink、ping、drawer、fade、unlock 与 Canvas 频谱更新。

### 2.8 内联样式与绘图值清单

| 文件 | 全部内联样式类型及特殊绘图值 |
|---|---|
| Lobby | 昵称 `flex:1 1 160px`；色块 `background:c` |
| Avatar | `width/height:size`；字号 `size×0.4/0.42`；`background:profile.color` |
| NowPlaying | 传输条 `width:round(progress×100)%`；状态字 `12px`、字距 `0.08em` |
| NowPlaying Canvas | 渐变读取 `--host/--guest`；暂停线读取 `--line`；最多64柱、按宽度/7确定数量、gap3、最小高2、圆角2；暂停线高2 |
| PlayerControls | 播放与音量 `--fill:百分比` |
| Playlist | `minWidth:0`、`textAlign:left`；歌手 `overflow:hidden/textOverflow:ellipsis`；删除 `28×28`；空态 margin-top8/12；Guest 提示12px与`8 16 12px` |
| SearchDrawer | 进度 width%；`minWidth:0`；外链图标 `verticalAlign:-1px/opacity:0.6`；重试 `justifySelf:start`；spacer `flex:1` |
| SearchDrawer 续 | select `height:30/fontSize:12`；错误标签 `height:auto/padding:6 10px`；结果容器 `display:grid/gap:2` |
| DownloadQueue | 进度 `width:百分比`，已限制0–100 |
| DebugPanel | spacer `flex:1`；SVG `240×56`；漂移范围±60ms、阈值±15ms |
| Icon | viewBox `0 0 24 24`；描边`1.8/2/2.2`；部分填充图形；内部文字字号9 |
| Toasts / AudioUnlock / ConnectionBar | 无直接 `style` 声明；尺寸来自 Avatar/Icon 参数与 CSS |

动态百分比、用户头像颜色、Canvas 几何值可继续使用运行时数据，不应把每个运行时数值变为全局 token。

### 2.9 主要问题与重复

| 优先级 | 问题 | 影响与建议 |
|---|---|---|
| P0 | 两套品牌、主题和层级体系 | 建立共享 token；分别迁移两个入口 |
| P0 | 白字配 `#ff6b4a` 对比约2.82:1 | 普通按钮文字不足；操作色与装饰色分离 |
| P0 | `#e2a03f` 配白底约2.25:1；`#1fa971`约3.01:1 | 11px状态文字不足；定义专用状态前景 |
| P0 | 22px色块、28px删除、26/28px筛选、36px按钮 | 移动端操作目标统一≥44×44px |
| P0 | SearchDrawer 缺少完整模态焦点管理 | 增加焦点约束、恢复与背景隔离 |
| P1 | `.input:focus`移除outline，只改变细边框 | 保留明确focus-visible轮廓 |
| P1 | `.transport`重复声明gap16后被gap10覆盖 | 合并规则，移除无效声明 |
| P1 | `#fff/#ffffff`、99/999圆角、6/8/10/12间距重复 | 收敛为有明确用途的尺度 |
| P1 | 当前歌曲、身份、链接、focus共用Guest色 | 分离 selected、focus、role语义 |
| P1 | `mobile.css`中`.hh-chip`最低36px、range高32px | 通用44px规则仍有例外，需逐项修正 |
| P1 | 双人caption未完整考虑断连、buffering、audioBlocked | 防止显示“一起听”但本机没有声音 |
| P1 | DownloadQueue初始焦点可能命中disabled按钮 | 优先标题或关闭按钮 |
| P1 | Toast CSS时长与JS 2200ms生命周期耦合 | 明确展示时长由逻辑管理，CSS仅负责过渡 |
| P1 | safe-area有CSS变量与直接env两条路径 | 统一入口，避免Android注入值被忽略 |
| P2 | React使用自定义SVG Icon，Dashboard使用Lucide | 先统一尺寸与线宽，后评估替换，避免混入迁移 |
| P2 | DebugPanel固定深色与独立颜色 | 可保持深色诊断面，但纳入语义与层级 |
| P2 | 连接指标、同步质量、下载进度容易混成同一种状态 | 三条独立反馈通道 |

## 3. 产品性格与方向选择

### 3.1 设计原则

- 陪伴可感知：头像、名字和轻量连线比持续闪烁更有意义。
- 同步可解释：区分“已连接”“正在对齐”“正在一起听”“本机声音受阻”。
- 等待有进展：传输显示可用进度；解码等未知时长任务显示阶段。
- 操作有归属：明确共享播放操作、本机音量、Host专属操作。
- 氛围安静：动效服务状态反馈，长时间听歌时减少持续视觉刺激。

### 3.2 候选方向

| 方向 | 概念与视觉 | 优点 | 代价 |
|---|---|---|---|
| A 暖光同频，推荐 | 暖黑/暖纸、琥珀Host、玫瑰Guest、双半圆与细连线 | 延续Dashboard与Android；亲近、耐看，适合长时间收听 | React需调整橙蓝品牌；浅色需新增深色品牌前景 |
| B 双声道 | 延续React珊瑚橙与靛蓝，强调左右声道与同步刻度 | 双角色辨识强，技术感清楚 | Android改动较大；高饱和色需要更严格控制 |
| C 黑胶书房 | 中性色、封面主导，品牌双色只用于细节 | 内容突出、最安静 | 双人产品特征较弱；需要靠布局和文案补足 |

推荐A：现有移动产品已经形成暖色基调，统一到它能降低Android迁移成本。

品牌标记保留“两半构成一个整体”；双色不表示性别，也不强制绑定用户头像颜色。

渐变只用于品牌、关系连线、非关键装饰；主要按钮使用经过对比验证的实色。

## 4. 三层 Token 架构

### 4.1 命名与依赖

| 层 | 示例 | 规则 |
|---|---|---|
| Primitive | `--p-amber-300`、`--p-space-4` | 原始值，无组件含义 |
| Semantic | `--color-action-primary-bg`、`--space-section` | 表达用途，负责主题切换 |
| Component | `--player-play-size`、`--drawer-width` | 组件契约，引用语义或primitive |

依赖方向为 component → semantic → primitive。

组件颜色不得直接引用HEX；允许动态头像数据和Canvas读取已解析的语义颜色。

几何与尺度型组件token可直接引用primitive，避免无意义中间层。

### 4.2 Primitive：颜色

下列每个色阶均对应完整变量名，例如 neutral-50 即 `--p-neutral-50`。

| 色族 | 完整色阶定义 |
|---|---|
| neutral | `0:#ffffff; 50:#f7f0e8; 100:#f4eee7; 200:#dccdbe; 300:#c4b3a3; 400:#ab9886; 500:#86745f` |
| neutral续 | `600:#6b594a; 700:#3e352d; 750:#2e2721; 800:#221d19; 850:#1b1714; 900:#151210; 950:#0e0c0b` |
| amber | `50:#fff1df; 300:#f2a65a; 400:#e99544; 500:#d7852f; 800:#8a460c; 900:#713805; 950:#342417` |
| rose | `50:#fdebf1; 300:#ec7a96; 400:#dc6684; 700:#a32f55; 800:#872342; 950:#351d27` |
| green | `50:#e8f5ed; 300:#71d6a4; 800:#146c43; 950:#123326` |
| yellow | `50:#fff3d6; 300:#f4c46a; 800:#855000; 950:#382b13` |
| red | `50:#fdecef; 300:#ff99a4; 800:#b42332; 950:#3b1e25` |
| alpha | `--p-black-rgb:0 0 0; --p-white-rgb:255 255 255` |

### 4.3 Semantic：主题颜色

表中右侧变量名均引用上一节primitive。

| Semantic token | Light引用 | Dark引用 |
|---|---|---|
| `--color-bg-canvas` | neutral-50 | neutral-950 |
| `--color-bg-surface` | neutral-0 | neutral-900 |
| `--color-bg-subtle` | neutral-100 | neutral-850 |
| `--color-bg-raised` | neutral-0 | neutral-800 |
| `--color-text-primary` | neutral-800 | neutral-50 |
| `--color-text-secondary` | neutral-600 | neutral-400 |
| `--color-text-disabled` | neutral-500 | neutral-500 |
| `--color-border-subtle` | neutral-200 | neutral-750 |
| `--color-border-control` | neutral-500 | neutral-500 |
| `--color-focus` | rose-700 | rose-300 |
| `--color-role-host` | amber-800 | amber-300 |
| `--color-role-host-bg` | amber-50 | amber-950 |
| `--color-role-guest` | rose-700 | rose-300 |
| `--color-role-guest-bg` | rose-50 | rose-950 |
| `--color-brand-host` | amber-300 | amber-300 |
| `--color-brand-guest` | rose-300 | rose-300 |
| `--color-action-primary-bg` | amber-800 | amber-300 |
| `--color-action-primary-hover` | amber-900 | amber-400 |
| `--color-action-primary-active` | amber-900 | amber-500 |
| `--color-action-primary-fg` | neutral-0 | neutral-900 |
| `--color-action-secondary-bg` | neutral-100 | neutral-800 |
| `--color-action-secondary-fg` | neutral-800 | neutral-50 |
| `--color-action-guest-bg` | rose-700 | rose-300 |
| `--color-action-guest-fg` | neutral-0 | neutral-900 |
| `--color-selected-bg` | rose-50 | rose-950 |
| `--color-selected-indicator` | rose-700 | rose-300 |
| `--color-status-success-fg/bg` | green-800 / green-50 | green-300 / green-950 |
| `--color-status-warning-fg/bg` | yellow-800 / yellow-50 | yellow-300 / yellow-950 |
| `--color-status-error-fg/bg` | red-800 / red-50 | red-300 / red-950 |
| `--color-status-info-fg/bg` | rose-700 / rose-50 | rose-300 / rose-950 |
| `--color-status-neutral-fg/bg` | neutral-600 / neutral-100 | neutral-400 / neutral-800 |
| `--color-player-track` | neutral-500 | neutral-500 |
| `--color-player-fill` | amber-800 | amber-300 |
| `--color-player-thumb` | neutral-0 | neutral-50 |
| `--color-scrim` | black / 40% | black / 64% |
| `--color-safe-area` | neutral-50 | neutral-950 |
| `--color-toast-bg/fg` | neutral-800 / neutral-0 | neutral-50 / neutral-900 |
| `--color-disc-bg/ring` | neutral-950 / neutral-800 | neutral-950 / neutral-800 |
| `--color-debug-bg/fg/muted` | neutral-950 / neutral-50 / neutral-400 | 同左 |

`--gradient-together:linear-gradient(90deg,var(--color-brand-host),var(--color-brand-guest))`。

`fg/bg`、`bg/fg/muted`为表格简写，实施时分别声明独立token。

### 4.4 状态语义

| 状态 | 颜色语义 | 文案与图形 |
|---|---|---|
| waiting / alone | neutral | 空心人物或圆点，“等待对方加入” |
| connecting / reconnecting | warning | 连接图标，“正在连接 / 重连中” |
| connected | success | 实心点或勾，“已连接” |
| syncing | info | 对齐图标，“正在对齐播放” |
| synced | success | 勾，“已同步” |
| disconnected / failed | error | 断连图标，“连接中断”与恢复入口 |
| offline | neutral | 断网图标，“离线，可播放本机歌曲” |
| buffering / decoding | info | 阶段文字，不伪造百分比 |
| downloading | info | 已知进度条；未知时长显示阶段 |
| download error | error | 原因、重试；保留到用户处理 |
| audioBlocked | warning | “声音尚未开启”；明确按钮 |
| relay | neutral | “中继”；本身不代表故障 |

RTT继续按现有 `<60 / <150 / ≥150ms`显示网络等级，但不能据此宣称同步良好。

同步质量使用引擎实际状态；不在CSS或组件中另建漂移阈值算法。

已连接、轨道已缓冲、播放已对齐、本机已发声必须分开表达。

### 4.5 已计算的关键对比度

| 前景 / 背景 | 约对比度 |
|---|---:|
| Light正文 `#221d19 / #ffffff` | 16.70:1 |
| Light次要文字 `#6b594a / #f7f0e8` | 5.89:1 |
| Dark次要文字 `#ab9886 / #151210` | 6.72:1 |
| Light主按钮 `#ffffff / #8a460c` | 7.09:1 |
| Dark主按钮 `#151210 / #f2a65a` | 9.22:1 |
| Light角色Guest `#a32f55 / #ffffff` | 6.78:1 |
| Light成功 / 警告 / 错误配套色 | 5.75 / 6.06 / 5.71:1 |
| Light / Dark焦点与对应背景 | 6.00 / 6.19:1 |
| 控件边框与白色 / 暖黑表面 | 4.49 / 3.72:1 |

以上使用sRGB相对亮度计算；最终仍需检查hover、active、透明叠层与实际邻接色。

普通文本目标≥4.5:1；大文本≥3:1；必要的非文字控件线索≥3:1。[文字对比度](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)、[非文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。

### 4.6 字体与排版

| Token | 值 |
|---|---|
| `--font-sans` | `system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif` |
| `--font-mono` | `ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace` |
| `--font-weight-regular/medium/semibold/bold` | `400/500/600/700` |
| `--text-caption-size/line` | `0.75rem / 1.5`，12px/18px |
| `--text-small-size/line` | `0.875rem / 1.5`，14px/21px |
| `--text-body-size/line` | `1rem / 1.5`，16px/24px |
| `--text-title-sm-size/line` | `1.25rem / 1.4`，20px/28px |
| `--text-title-size/line` | `1.5rem / 1.3334`，24px/约32px |
| `--text-display-size/line` | `2rem / 1.25`，32px/40px |
| `--text-hero-size/line` | `clamp(2rem,5vw,3rem) / 1.25` |
| `--tracking-default/latin-label/code` | `0 / 0.06em / 0.12em` |

默认根字号保持100%；rem按浏览器默认16px换算，支持用户字体设置。

桌面密集列表可用small；移动端主要正文和所有输入框使用body。

中文不加负字距；仅英文小标签使用latin-label字距。

歌词、长歌名和错误说明可换行；时间、进度和房间码使用等宽数字。

不新增远程字体依赖，保持离线启动与Android首屏稳定。

### 4.7 间距、形状与尺寸

| Primitive token | 值 |
|---|---|
| `--p-space-0/1/2/3/4/5/6/8/10/12/16` | `0/4/8/12/16/20/24/32/40/48/64px` |
| `--p-space-half` | `2px`，仅光学对齐和紧密装饰 |
| `--p-radius-xs/sm/md/lg/xl/pill/circle` | `4/8/12/16/24/999px/50%` |
| `--p-border-thin/strong` | `1/2px` |
| `--p-size-control-compact/default/large` | `36/44/48px` |
| `--p-size-icon-sm/md/lg` | `16/20/24px` |
| `--p-size-avatar-sm/md/lg` | `24/40/48px` |

| Semantic token | 引用 / 值 |
|---|---|
| `--space-inline-xs/sm/md` | space-1/2/3，即4/8/12px |
| `--space-stack-sm/md/lg` | space-2/4/6，即8/16/24px |
| `--space-section` | space-8，即32px |
| `--space-page` | phone16px；768px起24px |
| `--radius-control/card/sheet` | radius-md/lg/xl |
| `--size-touch-target` | control-default，即44px |
| `--size-input` | control-large，即48px |
| `--size-control` | 默认44px；精确指针桌面可选36px密集变体 |

所有移动端独立按钮、链接卡片、色块选择器、开关及滑块目标≥44×44 CSS px。

色块和开关的视觉本体可以更小，但实际点击区域必须明确且不重叠。

44px是本产品约束；WCAG的44px增强目标属于AAA，不能误写成AA最低要求。[目标尺寸说明](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)。

### 4.8 阴影与层级

| Token | Light | Dark |
|---|---|---|
| `--shadow-0` | `none` | `none` |
| `--shadow-1` | `0 1px 2px rgb(0 0 0 / 6%)` | `0 1px 3px rgb(0 0 0 / 28%)` |
| `--shadow-2` | `0 8px 24px rgb(0 0 0 / 10%)` | `0 8px 24px rgb(0 0 0 / 36%)` |
| `--shadow-3` | `0 16px 48px rgb(0 0 0 / 18%)` | `0 16px 48px rgb(0 0 0 / 48%)` |
| `--shadow-focus` | `0 0 0 2px var(--color-bg-surface),0 0 0 4px var(--color-focus)` | 同配方 |
| `--blur-header` | `12px` | `12px` |

| z-index token | 值与用途 |
|---|---|
| `--z-base/sticky/safe-area/player/full-player` | `0/20/25/30/35` |
| `--z-scrim/drawer` | `40/41` |
| `--z-nested-scrim/nested-dialog` | `50/51`，搜索之上的下载队列 |
| `--z-drag/toast/debug/unlock` | `60/70/75/80` |
| `--z-invitation/update` | `90/200` |

安全区背景只绘制系统栏区域，不能覆盖弹层内容；关闭pointer-events。

AudioUnlock在模态打开时应归入当前模态内的提示区域，避免可见但无法获取焦点。

DebugPanel只在调试模式出现；模态打开时不得突破焦点约束。

### 4.9 动效

| Token | 值与用途 |
|---|---|
| `--motion-duration-instant/fast/normal/slow` | `0/120/180/240ms` |
| `--motion-ease-standard` | `cubic-bezier(0.2,0,0,1)` |
| `--motion-ease-enter` | `cubic-bezier(0.2,0.8,0.2,1)` |
| `--motion-ease-exit` | `cubic-bezier(0.4,0,1,1)` |
| `--motion-press-scale` | `0.98` |
| `--motion-disc-period` | `18s linear` |
| `--motion-status-period` | `1600ms`，仅短时连接反馈 |
| `--toast-duration` | 建议信息/成功4000ms；错误保留在对应面板 |

hover改变背景或边框；press可轻微缩放；布局尺寸不随交互改变。

稳定连接不持续ping；可用静态双色连线与文字表示“一起”。

`prefers-reduced-motion:reduce`时停止旋转、闪烁、连线流动、eq、滑入、缩放和队列平移。

减少动态模式中，Canvas改为静态线或低频状态图；不能只关闭CSS动画。

JS计时负责消息展示生命周期，不依赖animationend完成清理。[减少动态效果](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion)。

### 4.10 断点、安全区与键盘

| 断点 | 建议布局 |
|---|---|
| `<480px` | 紧凑手机；单列、全宽抽屉、标题可换行 |
| `480–767px` | 宽手机；单列为主，不强制桌面控制密度 |
| `768–1023px` | 平板；按内容宽度决定单列/双列 |
| `≥1024px` | 播放区+列表双列；保留约1.35:1比例 |
| `≥1280px` | 主内容max-width1280px，居中 |

`--breakpoint-sm/md/lg/xl`可作为文档token记录480/768/1024/1280px；普通CSS media query使用对应字面量，不能直接使用`var()`作为断点。

保留现有安全区适配顺序：`var(--safe-area-inset-top,env(safe-area-inset-top,0px))`，四边同理。

`--safe-top/right/bottom/left`作为运行环境变量，不随主题变化。

底部预留继续基于实测`--player-height`；明确测量值是否已经包含safe-bottom，保证只计算一次。

固定弹层使用100dvh并保留100vh回退；横屏同时处理左右安全区。

保留现有键盘检测、ResizeObserver和Android返回栈；避免增加第二套返回事件入口。

安全区用于保护内容免受系统界面遮挡。[CSS环境变量](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env)。

## 5. 组件规格

### 5.1 共用交互契约

| 状态 | 统一表现 |
|---|---|
| default | 使用组件基底与边框 |
| hover | 仅在hover能力设备启用，背景或边框变化 |
| active | 按钮轻缩放；列表保留稳定尺寸 |
| focus-visible | 2px清晰轮廓，offset2px；不被overflow裁切 |
| disabled | 原生disabled；使用专门前景/背景，附可理解的禁用原因 |
| loading | 保留按钮标签和尺寸；必要时aria-busy；避免重复提交 |
| error | 图标、文字与颜色共同表达；保留恢复动作 |
| selected/current | aria-pressed或aria-current与可见标识匹配 |
| offline | 明确受影响功能；本机可用内容仍可操作 |

无实际交互的徽章、装饰头像和进度图形无需强制44px；独立操作入口必须满足。

### 5.2 ConnectionBar

| 项目 | 规格 |
|---|---|
| Anatomy | 品牌、角色、连接状态、网络详情、搜索/队列、离开 |
| 当前状态 | alone、connecting、together、broken；RTT未知/三级；relay；Host/Guest |
| 变体 | desktop完整；phone两行；详情折叠 |
| 推荐新增表达 | reconnecting、offline、syncing；必须由真实状态驱动 |
| Component tokens | `--connection-gap:12px`；`--connection-padding:12px 16px`；`--connection-dot-size:8px` |
| 颜色 | role、status；品牌渐变仅用于关系装饰 |
| 可访问性 | 保留role=status；变化节流；离开/详情按钮44px；诊断不能只放title |

### 5.3 Lobby

| 项目 | 规格 |
|---|---|
| Anatomy | 品牌、产品标题、说明、昵称、头像色、进入/邀请入口、连接错误 |
| 当前状态 | profile editing、色块selected、signaling connecting/open/closed、lobbyError |
| 当前入口事实 | React Lobby目前仅展示前往好友/动态入口；未渲染房间创建/加入表单 |
| Dashboard边界 | 单人、邀请/房间等入口按实际产品保留，不能照旧README凭空恢复 |
| Component tokens | `--lobby-max-width:760px`；`--lobby-gap:24px`；`--lobby-card-padding:24px` |
| 变体 | 单列phone；桌面根据实际入口数量排布，避免仅一张卡仍占半宽 |
| 可访问性 | 昵称可见标签；错误关联输入；色块44px目标、内部22px圆；颜色名使用可读名称 |

### 5.4 NowPlaying

| 项目 | 规格 |
|---|---|
| Anatomy | 唱片/封面、播放标签、歌名/歌手、传输信息、双人头像、频谱、控制区 |
| 当前状态 | no-track、paused、playing、send、recv、decode、streaming、buffering、peer-ready/waiting |
| 变体 | desktop横向封面；phone纵向；Dashboard另有mini/fullscreen |
| Component tokens | `--now-padding:24px`；`--now-gap:24px`；`--now-disc-size:200px`；`--now-visualizer-height:64px` |
| Phone | 唱片`min(256px,65vw)`；外边距16px；长歌名自然换行 |
| 状态优先级 | 音频受阻/卡顿 → 连接异常 → 对齐/传输 → 播放/暂停 |
| 可访问性 | 封面重复信息可alt空；频谱装饰隐藏；传输进度有文本，已知量可使用progressbar |
| Android | 保留无真实频谱的现状；不为视觉统一伪造“实时频谱” |

### 5.5 PlayerControls

| 项目 | 规格 |
|---|---|
| Anatomy | 时间/seek、模式、上一首、播放暂停、下一首、本机音量、等待说明 |
| 当前状态 | playing/paused、not-loaded、duration未知、seek dragging、muted、waitingPeer、Guest断连、首尾曲 |
| 权限 | Host控制模式；Guest播放/seek需要channelOpen且loaded；音量始终只作用本机 |
| 模式差异 | React为order/repeat/shuffle；Dashboard模式更丰富；设计迁移不改播放算法 |
| Component tokens | `--player-play-size:60px`；`--player-control-size:44px`；`--player-control-gap:8px` |
| 滑块tokens | `--player-range-hit-height:44px`；`--player-track-height:4px`；`--player-thumb-size:20px` |
| 布局 | 保留五列对称；音量独立行，避免播放键被挤偏 |
| 可访问性 | 保留range键盘与时间aria-valuetext；thumb始终可见；共享/本机作用域用文字说明 |
| 实施边界 | 保留拖动预览、松手提交seek；本提案不修改引擎控制权限 |

### 5.6 Playlist

| 项目 | 规格 |
|---|---|
| Anatomy | 标题/数量、导入入口、列表、当前曲标识、来源/新标签、时长、移除、空态 |
| 当前状态 | empty Host/Guest、disconnected Guest、current playing/paused、local/library、fresh、hover |
| 当前操作 | Guest点击是请求Host切歌；移除仅Host本地非当前曲显示 |
| Component tokens | `--playlist-row-min-height:64px`；`--playlist-thumb-size:40px`；`--playlist-row-gap:12px` |
| 选中表现 | selected-bg、2px指示条、当前曲文字/图形；不能仅靠背景色 |
| 可访问性 | 切歌和删除为并列按钮，避免嵌套；删除目标44px；当前曲aria-current |
| Offline | 区分“本机可播”“未下载”；来自Dashboard真实曲库状态，不能由origin推断 |

### 5.7 SearchDrawer

| 项目 | 规格 |
|---|---|
| Anatomy | 标题/关闭/队列、搜索、音源筛选、版本/格式、状态、结果、下载动作 |
| 当前状态 | closed/open、Host-only、服务检测/不可用、idle/searching/error、empty/results、音源部分失败 |
| 下载状态 | 下载、queued/downloading/processing、done/已在库可播放、error可重试 |
| 其他状态 | 筛选selected；MP3缺ffmpeg disabled；封面缺失；原唱识别成功/失败 |
| Component tokens | `--drawer-width:560px`；`--drawer-padding:16px`；`--search-thumb-size:52px`；`--search-action-min-width:88px` |
| Phone | 全宽；筛选44px目标；必要时动作下移，保留歌曲信息宽度 |
| 可访问性 | 搜索可见标签；aria-modal；初始焦点、trap、恢复；Esc仅关闭顶层 |
| 反馈 | 搜索过程aria-busy；结果数量一次性播报；错误正文不放在固定高度tag内 |
| 内容语义 | 翻唱/现场是版本属性，建议中性标签，避免默认用error表达音乐类型 |

### 5.8 DownloadQueue

| 项目 | 规格 |
|---|---|
| Anatomy | 标题/数量、清除完成、关闭、任务封面、名称、格式、阶段、进度、错误、重试、移除 |
| 当前状态 | closed/open、Host-only、empty、queued/downloading/processing/done/error |
| 恢复状态 | 中断的持久化任务恢复为error；失败在前、活动次之、完成最后 |
| Component tokens | `--download-card-padding:16px`；`--download-card-gap:12px`；`--download-thumb-size:40px` |
| 布局 | `40px minmax(0,1fr) 44px`，替换原32px动作列 |
| 可访问性 | 已有progressbar语义保留；初始焦点到标题/关闭；仅顶层可交互 |
| 文案 | 明确“移除记录”不会取消下载；不能只藏在title |
| 进度 | queued/processing若无可靠百分比，显示阶段，避免0%看似停滞 |

### 5.9 Toasts

| 项目 | 规格 |
|---|---|
| Anatomy | 类型图标/伙伴头像、消息；需要动作的错误留在对应面板 |
| 当前状态 | app info/success/error；peer notice；应用消息替换并重置2200ms生命周期 |
| 当前容量 | 1条app + 最新1条peer notice |
| Component tokens | `--toast-max-width:480px`；`--toast-gap:8px`；`--toast-padding:12px 16px`；`--toast-radius:12px` |
| 变体 | app中性/成功/错误；peer表面色并带名字 |
| 可访问性 | polite播报；合并重复消息；不让进度更新不断打断朗读 |
| 推荐行为 | 信息建议4000ms；重要错误可追溯；本阶段如改时长，同步调整JS与CSS |

### 5.10 Avatar

| 项目 | 规格 |
|---|---|
| Anatomy | 首字符/占位、用户色、可选角色标记、双人连线 |
| 当前状态 | profile/empty；24/40/44px；色块selected由Lobby管理 |
| Component tokens | `--avatar-size-sm:24px`；`--avatar-size-md:40px`；`--avatar-size-lg:48px` |
| 文字 | 建议small12px、medium16px、large20px，替换任意比例字号 |
| 颜色 | 保留用户已存颜色；按背景亮度选择高对比深/浅字，逐色校验 |
| 可访问性 | title不足以承载唯一名字；无相邻姓名时提供可访问名称 |
| 交互 | 纯展示头像无需44px；可点击头像外层目标44px；不靠颜色区分两人 |

### 5.11 AudioUnlock

| 项目 | 规格 |
|---|---|
| Anatomy | 声音受阻图标、原因说明、开启声音按钮 |
| 当前状态 | hidden、blocked、interrupted；无独立pending/error视觉 |
| Component tokens | `--unlock-padding:16px`；`--unlock-gap:12px`；`--unlock-max-width:560px` |
| 颜色 | warning表面/前景；操作使用guest-action或primary-action |
| 定位 | 在播放器上方，计入底栏实测高度与safe-bottom |
| 可访问性 | 首次出现alert；按钮44px；持续可见至恢复，不能自动消失 |
| 推荐新增 | 解锁中aria-busy；失败说明和重试；只在真实Promise状态可获得时增加 |

### 5.12 DebugPanel

| 项目 | 规格 |
|---|---|
| Anatomy | 标题/复制/收起、连接、时钟、播放、漂移曲线、网络模拟、诊断动作 |
| 当前状态 | debug参数开启、expanded/collapsed、Host/Guest、Buffer/Stream、netsim可选、数据未知 |
| Component tokens | `--debug-width:320px`；`--debug-max-height:70dvh`；`--debug-padding:12px`；`--debug-font-size:12px` |
| 曲线 | 保留240×56、±60ms视窗与±15ms参考；使用文本补充当前漂移 |
| 可访问性 | SVG提供可读说明；不把500ms刷新放进live-region；复制成功/失败有反馈 |
| Phone | 控件44px；位置避开播放器、安全区和unlock；保留面板滚动 |

### 5.13 Icon与App级拖入层

Icon保留24×24网格；后续统一到16/20/24px显示与2px描边，播放等填充图标可例外。

不要在token迁移中同时替换整套图标，避免引入视觉差异与依赖风险。

拖入层继续仅对Host文件操作启用；使用`--z-drag`、raised surface、focus色虚线与明确“松手添加”文字。

拖入层不能成为手机导入的唯一入口；保留文件选择按钮。

### 5.14 Dashboard附加表面

| 表面 | 应复用的契约 |
|---|---|
| Mini / Fullscreen Player | PlayerControls、NowPlaying、safe-area、实测播放器高度 |
| 好友/一起听邀请 | Avatar、role、dialog、invitation层；接受/拒绝均有明确标签 |
| 发现/热门 | surface、卡片圆角、caption≥12px；封面优先 |
| 听歌统计 | text、tabular数字、surface；图表含文字摘要 |
| 云端歌单/本机库 | download/status；区分元数据存在与音频已下载 |
| 账号/更新提示 | dialog、输入、错误；保留当前业务流程与返回键行为 |

## 6. 实施方案：四阶段、最小改动

### 6.1 样式组织建议

建议新增`public/design-tokens.css`作为两个入口的共同token来源。

该文件声明primitive、`:root`默认语义、`[data-theme="light"]`和`[data-theme="dark"]`覆盖。

`src/styles.css`加载共享token，并在`:root`保留旧变量兼容别名，逐个迁移现有selector。

Dashboard通过相对路径link加载同一文件；其Tailwind颜色配置逐步引用CSS变量。

示意如下，仅用于说明未来实施方式：

```css
/* public/design-tokens.css */
:root {
  --p-amber-300: #f2a65a;
  --p-amber-800: #8a460c;
  --p-neutral-0: #fff;
  --p-neutral-900: #151210;
  --color-action-primary-bg: var(--p-amber-800);
  --color-action-primary-fg: var(--p-neutral-0);
}
:root[data-theme="dark"] {
  --color-action-primary-bg: var(--p-amber-300);
  --color-action-primary-fg: var(--p-neutral-900);
}
/* src/styles.css：过渡别名，完整映射按token表展开 */
:root {
  --bg: var(--color-bg-canvas);
  --surface: var(--color-bg-surface);
  --surface-2: var(--color-bg-subtle);
  --text: var(--color-text-primary);
  --muted: var(--color-text-secondary);
  --line: var(--color-border-subtle);
  --host: var(--color-brand-host);
  --guest: var(--color-brand-guest);
  --together: var(--gradient-together);
  --ok: var(--color-status-success-fg);
  --warn: var(--color-status-warning-fg);
  --err: var(--color-status-error-fg);
  --radius: var(--radius-card);
  --shadow: var(--shadow-1);
}
```

旧Host按钮不能继续通过`--host`承担操作背景；需显式切到action token。

Canvas暂时可通过兼容别名读取颜色；后续改为读取`--color-brand-host/guest`。

CSS变量解析为实际颜色后再交给Canvas，避免把`var(...)`字符串直接传给绘图API。

主题优先级：用户显式选择 → 系统偏好 → 浅色回退；Dashboard迁移初期可保留深色默认。

显式`data-theme`必须覆盖系统dark媒体规则；系统规则只匹配未设置`data-theme`的根节点。

主题应用应在首屏绘制前完成；存储不可用时回退系统偏好，不阻塞启动。

### 6.2 阶段一：建立基础与基线

| 步骤 | 工作 | 完成标准 |
|---|---|---|
| 1 | 为两个入口记录当前关键页面与状态截图 | 区分当前行为与拟议修改 |
| 2 | 新增共享token文件、主题选择器、旧变量别名 | 两入口都能解析token，无未定义变量 |
| 3 | 先调整body/card/button/input/tag/focus | 布局大体保持；关键对比改善 |
| 4 | 保留现有类名、DOM、状态管理 | 不改引擎、store结构或同步协议 |

预估1–2人日；需要能启动双入口并准备双机连接场景。

### 6.3 阶段二：迁移React核心组件

| 顺序 | 组件 | 重点 |
|---|---|---|
| 1 | Avatar、Icon、基础按钮/输入/标签 | 字号、线宽、focus、44px目标 |
| 2 | ConnectionBar、Lobby | 状态颜色、入口事实、手机折行 |
| 3 | PlayerControls、NowPlaying | 播放键对称、滑块目标、发声与连接区分 |
| 4 | Playlist | 行高、删除目标、当前曲语义 |
| 5 | SearchDrawer、DownloadQueue | 表单、模态、进度、错误与嵌套焦点 |
| 6 | Toasts、AudioUnlock、DebugPanel | 生命周期、底部避让、reduced-motion |

每次只替换一个组件的视觉契约；静态内联样式移到组件类，动态进度保留。

与状态判定相关的变化单独评审，避免以“改样式”掩盖行为修改。

预估2–4人日。

### 6.4 阶段三：Dashboard与Android对齐

| 步骤 | 工作 | 完成标准 |
|---|---|---|
| 1 | Dashboard Tailwind颜色指向共享语义变量 | 不再存在另一套独立品牌定义 |
| 2 | 迁移页面内关键CSS与mobile.css硬编码颜色 | 全屏播放器、开关、安全区主题一致 |
| 3 | 优先对齐连接栏、播放器、列表、搜索、队列、提示 | Android核心流程达到同一组件契约 |
| 4 | 对齐好友、发现、统计、账号与云端表面 | 不遗漏应用真实主入口 |
| 5 | 验证Tailwind透明度修饰符与构建路径 | `/15`等透明度在打包后仍正确 |

Tailwind需要透明度能力的颜色应使用兼容`<alpha-value>`的RGB通道表示，或专门的透明语义token。

不要仅把所有HEX机械替换为`var(--color)`，否则`bg-host/15`等现有类可能失效。

保留`mobileRuntime.js`的返回栈、键盘处理及播放器实测逻辑。

浅色Android还需核对SystemBars、原生窗口/启动背景；CSS主题切换不能自动证明系统栏适配正确。

预估3–5人日；双入口与Dashboard内联代码使这一阶段工作量高于纯CSS替换。

### 6.5 阶段四：验收与收口

| 步骤 | 工作 | 完成标准 |
|---|---|---|
| 1 | 执行视觉、键盘、读屏与移动触控检查 | 核心状态矩阵全部记录 |
| 2 | 执行现有自动测试与两种构建 | 测试和构建通过，有实际日志 |
| 3 | Android真机覆盖系统栏、键盘、返回、前后台 | 不退化既有真机已验证行为 |
| 4 | 删除已无引用的旧规则与别名 | 无遗留硬编码主色，无重复transport规则 |
| 5 | 补充组件状态样张与token维护说明 | 新组件可直接依照规范实现 |

预估1–2人日；整体约7–13人日，取决于Dashboard全量表面与双机真机资源。

该估算包含视觉迁移和必要交互修复，不包含播放引擎重构。

### 6.6 未来预计文件清单

| 文件 | 预计变化 |
|---|---|
| `public/design-tokens.css`，新增 | 共享三层token、主题定义 |
| `src/styles.css` | 旧别名、组件样式迁移、清除重复值 |
| `src/components/*.jsx` | 静态内联样式归类、可访问性与状态标签 |
| `src/App.jsx` | 必要的布局/弹层组织；不改播放行为 |
| `src/main.jsx`或独立小型主题模块 | 主题初始化，按最终组织选择一处 |
| `index.html` | 主题首屏、共享资源与颜色声明核对 |
| `public/dashboard.html` | token引用、Tailwind映射、主要组件样式 |
| `public/mobile.css` | 安全区、触控尺寸、移动端硬编码迁移 |
| `public/accountUI.js/friendsUI.js/discoveryUI.js/statsUI.js` | 后续对应表面颜色和尺寸映射 |
| `scripts/bundle-dashboard.mjs` | 原则上保持；仅在共享CSS构建验证失败时调整 |
| `capacitor.config.json`及原生主题资源 | 浅色系统栏/启动背景确需适配时单独处理 |
| `docs/design-system-proposal.md` | 记录采纳决策与实施结果 |

以上均是未来实施清单；本次没有修改这些文件。

### 6.7 风险与取舍

| 风险 | 应对 |
|---|---|
| 两套UI长期漂移 | 共用token，保留各自组件实现；用同一状态验收矩阵 |
| 全量换品牌影响熟悉度 | 延续Dashboard品牌；先基础层，再核心操作 |
| 旧别名语义不够准确 | 设过渡期；按钮、focus、selected优先迁出 |
| 共享mobile.css污染根页面 | 不把Dashboard专属全局规则直接引入React入口 |
| CSS层叠与Tailwind优先级 | 固定加载顺序；减少新增!important；逐组件检查computed style |
| safe-area重复计入 | 定义测量边界，纵横屏实测，而非按固定播放器高度猜测 |
| 新层级破坏返回/焦点顺序 | 视觉层级与现有LIFO弹层栈逐一映射 |
| 主题导致头像不可读 | 保留头像数据，计算前景并测试全部七色 |
| 错把“connected”当作“可听见” | 状态文案绑定真实数据；承认无法从本机证明对方扬声器发声 |
| 动效降级只改CSS | 同步处理Canvas与JS驱动动画 |
| 文档替代了真实验证 | 保留待测项；不得把源码审查写成真机通过 |

## 7. 验收矩阵

### 7.1 视觉与交互

| 维度 | 检查项目 |
|---|---|
| 入口 | React根页面、Dashboard、Android启动页 |
| 尺寸 | 320/360/390/480/768/1024/1280px；手机横屏 |
| 主题 | 浅色、深色、系统跟随、手动覆盖、重启恢复 |
| 内容 | 超长中文/Latin歌名、空歌手、无封面、长错误、数量为0和大数量 |
| 布局 | 无横向溢出；播放键居中；最后一行内容不被播放器挡住 |
| 可访问性 | 键盘全流程、focus可见、缩放200%、文字不裁切、44px操作目标 |
| 弹层 | 搜索→下载队列→返回；焦点在顶层，关闭后回到触发点 |
| 动效 | reduced-motion下所有装饰循环停止，Canvas同步降级 |
| 状态 | hover/active/disabled/loading/error/selected均有一致表现 |

模态需要把焦点放入弹层、约束Tab循环、支持Escape，并在关闭后恢复到合理位置。[WAI-ARIA模态对话框模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)。

### 7.2 产品状态

| 场景 | 应验证结果 |
|---|---|
| Host独处、Guest未加入 | 等待文案；本机功能保持可用 |
| 建立连接、重连、失败 | 明确阶段与恢复入口；不混淆离线 |
| 已连接未选曲 | “已连接，等待选歌” |
| 传输、解码、边收边播、卡顿 | 显示正确阶段，不伪造进度 |
| 双方已缓冲、播放、暂停 | 状态文字与实际控制权限一致 |
| 本机audioBlocked | 显示开启声音提示，不只展示“一起听” |
| Guest断连 | 共享控制明确不可用；本机音量仍可用 |
| 搜索服务不可用/部分音源失败 | 局部错误保留，不清空其他有效内容 |
| 下载排队/处理/成功/失败/恢复中断 | 队列、重试与持久化记录一致 |
| 网络离线且本机有歌曲 | 可发现可播放内容；未下载歌曲有明确状态 |

### 7.3 构建与Android

未来实施完成后运行`npm test`与`npm run build`，分别检查根页面和`dashboard.html`产物。

Android使用现有`npm run cap:sync`和`node scripts/gradle.mjs assembleDebug`流程；构建只发生在实施阶段。

真机检查手势/三键导航、纵横屏安全区、键盘开关、弹层返回和播放器高度预留。

检查主题切换后的状态栏图标与背景、全屏播放器、通知媒体信息和锁屏卡片。

双机覆盖Host/Guest连接、重连、缓冲与前后台恢复，避免只验收单机外观。

沿用`ANDROID_DEVICE_QA.md`记录实际设备、已通过内容和未覆盖边界，不把历史测试当成本次验收。

## 8. 采纳建议

采纳“暖光同频”、三层token、两入口共享基础与四阶段迁移。

首批优先解决颜色对比、44px触控目标、模态焦点及状态真实性。

保留现有组件和播放架构，通过兼容别名逐步迁移；待视觉与状态契约稳定后，再考虑合并两套UI。
[job 1022-155900-0d96 done session=01a165d6-ea08-7d40-8e8a-c405d60267ca]

未能创建 `F:/Half&Half_Music_Player/docs/design-system-proposal.md`：当前沙箱仅允许读取，且禁止权限升级。未修改任何文件。以下提供可直接保存的完整 Markdown 提案。

推荐摘要（10 行）：

1. 推荐“暖光同频”：温暖、安静、有陪伴感。
2. 延续 Dashboard 的琥珀与玫瑰双色，统一 Web 与 Android 品牌。
3. 渐变表达两人关系，绿色表达连接或同步状态。
4. 使用 primitive → semantic → component 三层 token。
5. 浅色采用暖纸底色，深色采用暖黑底色。
6. 品牌装饰色与按钮、文字所需的高对比颜色分开。
7. 使用中英系统字体栈，正文 14–16px，移动端输入框 16px。
8. 间距以 4px 为主；所有移动端独立操作目标至少 44×44px。
9. 两套入口共用 token，保留现有播放与连接逻辑。
10. 用四阶段完成基础层、核心组件、Dashboard/Android、验收与收口。

拟定阶段：① 建立 token 与兼容别名；② 迁移 React 核心组件；③ 对齐 Dashboard 和 Android；④ 完成视觉与可访问性验收。

子代理：`component_audit`，`gpt-6-astra`，medium；负责独立组件与状态审计，主代理已复读相关组件核对。

---
