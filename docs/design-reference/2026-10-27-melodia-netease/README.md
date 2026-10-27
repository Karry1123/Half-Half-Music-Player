# Half&Half — Melodia / NetEase reference studies

## English

Design reference only, dated 2026-10-27. Open [index.html](index.html) directly in a browser. No build, server, network, application code or runtime integration is required. All four studies include desktop (≥1100px) and mobile (≤430px) layouts; suggested review sizes: 1440×1000 and 390×844. All covers are CSS gradients. Names, track metadata, counts and original lyric lines are fictional. Disabled buttons illustrate placement; links navigate the studies, and native disclosure elements show state copy. Layouts depict frozen states, not working playback, resizing, drag sorting, search or timed lyrics.

### Pattern comparison

| Pattern | Melodia | netease-gpui | Half&Half today | Proposed change |
| --- | --- | --- | --- | --- |
| Navigation | Narrow icon rail; My Library consolidates five tabs | Labeled sidebar, search and avatar in top header | React lobby → room; ConnectionBar above two cards. Dashboard independently has discovery/library/friends/settings navigation | Room-first labeled sidebar on desktop, wrapping top navigation on mobile; keep room return and two-person presence explicit |
| Library / list density | Sortable, toggleable and resizable columns; virtualized cover grids | 56px virtual table rows, draggable column dividers; 64px queue rows | React Playlist uses ≥64px rows with cover, title, origin, artist and duration; Dashboard has library/songlist views | Keep readable two-line rows, 44px action targets and current-track highlight; add columns only where width allows; virtualization only after measuring large lists |
| Detail in place | LibraryTabBand grows into selected entity banner; tabs and back remain available | Cover-led playlist hero and songs/comments/collectors tabs | Dashboard has playlist chips/banner and separate library sections; React room has no library tab band | Dashboard tab band plus inline selected-playlist banner; restore list position on return; mobile banner stacks |
| Search | Best-match card beside songs, then album/artist/genre sections and recent searches | Category tabs; songs and playlists wired, other categories may be placeholders | SearchDrawer filters providers; flat song results expose version, source, quality and download action | Best song match plus grouped songs and local playlists; external albums are a future data capability, explicitly illustrated rather than promised |
| Expanded now playing | Cover/metadata and Up Next or timed lyric column | Expandable spinning disc, line lyrics, translations and comments | React has disc, local spectrum, duo avatars, transfer line and controls; Dashboard already has fullscreen disc player; no lyric surface in inspected UI | Cover and lyric split with current line and translations; keep both listeners and collapse control; retain queue as alternate view |
| Mini player | Window shrinks continuously into strip, card, then column with queue/lyrics | Bottom bar remains as page content changes | React controls live inside NowPlaying; Dashboard already has mini/bottom-player variants | Reuse a compact mobile strip with pause/next/queue; do not collapse entire WebView into a native mini window |
| Bottom bar | Artwork/title expands full view; seek, mode, queue, volume and overflow | 86px bar, play-mode cycle, volume bubble, heart/comment counts | React seek commits on release; volume is local; host alone changes mode. Dashboard already has fixed player | One persistent control surface per entry point; preserve existing permission and seek behavior; reserve content space and bottom safe area |
| Play queue panel | Resizable dock; overlays content when insufficient room; drag reorder | Global side panel with virtualized session queue, distinct from a saved playlist; README says sorting/removal unsupported | React Playlist is shared room list; DownloadQueue is a separate job drawer. Dashboard queue sheet chooses playlists | Dock an Up Next projection of the same room list on wide screens; compact screens show it below content in this static study. Future sheet must keep single source of truth; downloads remain separate |
| Badges / feedback | Format chips; optional exclusive-output signal-path quality verdict | Hi-Res/SQ badges, playing indicator; actual playback can downgrade with rights | Existing version/source/quality/trusted-uploader tags and transfer/download progress | Preserve provenance and real status first; distinguish available/source quality from actual playback; sample FLAC chip is illustrative metadata |
| Empty / loading / error | First-run import guidance; lyrics distinguishes not looked up from no sheet | Resource model separates initial loading/failure/empty/data; retains same-key snapshot during refresh | Lobby connection errors, role-specific empty queue, service retry, download progress/retry, toasts | Separate loading, empty and source failure copy; keep same-query results while refreshing; never reuse another query's data; keep audible playback visible |
| Theming | Six theme families, light/dark, optional artwork-derived accents; bounded aurora washes | Shared theme tokens; cover-derived dark gradients on immersive views | Existing warm two-tone semantic system already covers light/dark and reduced motion | Keep warm paper/white, amber host and rose guest; use low-intensity warm wash only on hero regions; do not let covers redefine role or status colors |
| Social emphasis | Personal local-library organization | Account/VIP, discovery feeds, heart/comment counts and public comments | Two listeners, invitation, presence, co-listening stats, friend activity | Promote shared presence, invitation and joint listening time; avoid public engagement counters and account gates dominating a room |

### Prioritized recommendations — future scope, not changes made

- **P0 — Stable room context and a single player bar.** `src/App.jsx`, `src/components/ConnectionBar.jsx`, `NowPlaying.jsx`, `PlayerControls.jsx`, `src/styles.css`; separately `public/dashboard.html` player functions and `public/mobile.css`. Preserve local-only volume, seek commit on release, guest selection as a host request, and host-only mode changes. Keep invite/reconnect/buffering copy visible, with ≥44px targets, keyboard focus and safe-area spacing. Dashboard already has a bar; refine that existing surface rather than add a second one.
- **P0 — Clarify shared queue versus downloads.** `src/components/Playlist.jsx`, `DownloadQueue.jsx`, `ConnectionBar.jsx`, `src/App.jsx`, `src/styles.css`; Dashboard queue sheet in `public/dashboard.html`. Up Next must derive from the existing shared playlist and current position. Do not copy NetEase's separate personal playback queue into a shared room. No speculative guest drag controls or second writable queue. At narrow widths use a dedicated sheet in a future implementation; the static proposal deliberately shows the panel stacked so reviewers can inspect all content.
- **P1 — Search hierarchy and honest states.** `src/components/SearchDrawer.jsx`, `DownloadQueue.jsx`, `Toasts.jsx`, `src/styles.css`; Dashboard SearchDrawer/SearchDiscovery in `public/dashboard.html`, `public/discoveryUI.js`, `public/mobile.css`. Highlight one best song match; group existing results without hiding provider/version/download status. Label download-to-library and append-to-room separately. Do not offer album/artist filters until data exists. Distinguish first load, refresh, empty, per-source failure and retry.
- **P1 — Dashboard library band and contextual cards.** LibraryPanel/PlaylistChips/RoomPlaylistBanner in `public/dashboard.html`, `public/friendsUI.js`, `statsUI.js`, `discoveryUI.js`, `accountUI.js`, `public/mobile.css`. Preserve active playlist and scroll position when returning from inline detail. Show append versus replace explicitly; friend invitation and stats retain their existing meaning. Album and recently-played tabs are proposed views, not claims of current complete entity support.
- **P2 — Expanded lyrics.** `src/components/NowPlaying.jsx`, `PlayerControls.jsx`, `src/App.jsx`, `src/styles.css`; Dashboard FullscreenPlayer in `public/dashboard.html`, `public/mobile.css`. Requires separately scoped lyric data and synchronized-seek work; UI-only changes cannot deliver it. Keep original/translation pairing, manual-scroll return control, loading/no-lyrics states, both listeners and existing seek permissions. Support reduced motion; spinning artwork is optional.
- **P2 — Density and atmosphere refinements.** `src/components/Playlist.jsx`, `SearchDrawer.jsx`, `src/styles.css`, Dashboard library/search presentation and `public/mobile.css`. Test long titles and large queues before considering virtualization or resize handles. Consume `public/design-tokens.css` without changing role/status semantics; desktop columns should disappear or wrap on mobile. No extra theme-family selector is needed.

### Three patterns rejected for this product

1. **Personal playback queue copied/replaced on every library play.** It would obscure the two-person shared playlist and surprise the other listener. Prefer explicit append and host-mediated selection.
2. **Public-content portal: VIP prominence, comment/heart counts and full comment column.** These compete with intimate presence and shared listening; retain personal favorites only where useful, without importing engagement metrics.
3. **Desktop-native complexity: automatic whole-window mini mode, OS theme families and extensive library column/tag-management UI on mobile.** A WebView room needs stable navigation and touch targets. Borrow the compact strip and restrained ambient wash, not the window lifecycle or full desktop library toolset.

### Token and responsive contract

The HTML copies needed values inline from `public/design-tokens.css`; it does not load that file or any font/image/CDN. Canvas `#f7f0e8`, surface `#ffffff`, subtle `#f4eee7`, text `#221d19`, secondary `#6b594a`, border `#dccdbe`; brand amber `#f2a65a` and rose `#ec7a96`; readable host foreground `#8a460c` on `#fff1df`, guest `#a32f55` on `#fdebf1`, success `#146c43` on `#e8f5ed`. Decorative gradients use this same palette. Light theme is the chosen reference state; existing dark-theme mappings remain the source for any future dark implementation. No new product palette is proposed.

At ≥1100px the sidebar and bottom bar frame the content; player queue is docked. At ≤430px navigation wraps above content, hero and lyrics stack, dashboard cards become one column, search takes the whole content width and player controls simplify. Text can wrap, content reserves space for the fixed bar, and safe-area bottom padding is included. The mockups contain no animated artwork, so reduced-motion users receive the same static state. Interactive tabs and drag/resize are intentionally not simulated.

### Evidence and limitations

These observations refer to the supplied local snapshots, not current upstream projects. Reference root: `C:/Users/KARRYX~1/AppData/Local/Temp/claude/F--Half-Half-Music-Player/5dff3268-45a5-4f57-9f5c-3dbb449912d3/scratchpad/refs/`.

- **Melodia:** `README.md` library/playback/lyrics/themes sections; `docs/adr/0026-aurora-bounded-washes-over-the-theme-base.md` and `0038-lyrics-display-reads-the-file.md`; under `crates/melodia-ui/ui/`, `views/my-library-view.slint`, `components/hero/library-tab-band.slint`, `layout/now-playing-bar.slint`, `views/mini-player.slint`, `views/search/top-result-card.slint`, `views/queue-panel/queue-panel.slint`, `components/now-playing/lyrics-panel.slint`.
- **Screenshots actually viewed:** Melodia `assets/screenshots/songs.png`, `playlist-detail.png`, `search.png`, `nowplaying-lyrics.png`, `miniplayer-onestrip-aurora.png`; NetEase `docs/images/screenshot.png`. The NetEase image shows a playlist page; recommendation and expanded-lyrics patterns are corroborated by README/source, not inferred from that one screenshot.
- **NetEase:** `README.md`, `docs/architecture.md`; `src/ui/sidebar.rs`, `theme.rs`, `pages/search.rs`, `pages/recommend.rs`, `components/player_bar.rs`, `play_queue.rs`, `virtual_table.rs`, `now_playing/page/lyrics.rs`. Its search source explicitly marks some categories unsupported; its README marks queue sorting/removal unsupported. The studies do not treat these as delivered features.
- **Half&Half:** `src/App.jsx`, named UI components, `src/styles.css`, `public/design-tokens.css`, `public/mobile.css`, `public/dashboard.html`, `public/friendsUI.js`, `statsUI.js`, `discoveryUI.js`, `accountUI.js`, `docs/design-system-proposal.md`, existing design-reference inventory. `public/dashboard.css` is absent in this checkout; `dist/dashboard.css` is the existing generated stylesheet inspected read-only. A future change should edit the owning source, not the generated file.

### Validation performed

Static UTF-8, local-link/fragment, no-script and inline-CSS checks passed. Headless Chrome loaded all five HTML pages directly from disk at widths 390, 430, 1100 and 1440px: 20 viewport checks passed with no horizontal overflow. Desktop and mobile screenshots were inspected; temporary browser profiles/screenshots were removed. No app build or dev server was run.

## 简体中文

本目录是 2026-10-27 的设计参考，所有建议均未实施到应用。直接打开 [index.html](index.html) 即可，无需构建、服务器或联网。四个页面均含桌面（≥1100px）与移动（≤430px）布局，推荐查看尺寸为 1440×1000、390×844。封面为 CSS 渐变，人名、数据、曲目和原创歌词都是占位样例。按钮禁用表示静态位置；链接可跳转参考页，原生展开项展示状态文案。拖动排序、列宽调整、播放与歌词同步均未实现。

### 逐项模式比较

| 模式 | Melodia | netease-gpui | Half&Half 现状 | 建议调整 |
| --- | --- | --- | --- | --- |
| 导航 | 图标侧栏，曲库集中为五个分类 | 文字侧栏，顶部搜索、头像与登录 | React 大厅进入双卡房间；Dashboard 独立的发现／曲库／好友／设置导航 | 桌面房间优先侧栏，手机顶部导航换行，返回房间与双人状态常驻 |
| 列表密度 | 可排序、显示隐藏及调整宽度的列，虚拟封面网格 | 56px 虚拟表格、可拖列分隔；队列行 64px | React 至少 64px 曲目行，封面、来源、歌手、时长；Dashboard 有歌单管理 | 保持两行清晰信息和 44px 操作区，当前曲目高亮；宽屏才加列，测量性能后再虚拟化 |
| 原位详情 | 分类带展开成详情横幅，分类和返回键保留 | 封面主导的歌单头图，歌曲／评论／收藏者分类 | Dashboard 已有歌单 chips、房间歌单 banner；React 无曲库分类带 | Dashboard 在同一空间展开歌单详情，返回恢复列表位置，手机上下堆叠 |
| 搜索 | 最佳匹配卡片、歌曲、专辑、歌手、流派与历史 | 分类搜索，已接歌曲和歌单，部分分类占位 | SearchDrawer 按来源筛选，平铺歌曲，已有版本／来源／音质／下载状态 | 置顶最佳歌曲，分组歌曲及本地歌单；远端专辑等分组是待补数据的提案 |
| 展开播放／歌词 | 封面与接下来／歌词两列切换 | 黑胶、逐行歌词、译文和评论 | React 有黑胶、频谱、双头像、传输提示及控制；Dashboard 有全屏黑胶，无已接歌词界面 | 封面与歌词分栏，当前行和逐行译文，保留双人状态和收起入口，接下来作为替代视图 |
| 迷你播放器 | 随窗口宽高连续变为条／卡／列 | 页面切换时底部播放条仍在 | React 控制在 NowPlaying 卡里；Dashboard 已有 mini／bottom 变体 | 手机采用紧凑条保留暂停／下一首／队列，不移植原生窗口生命周期 |
| 底部播放条 | 点击封面展开，进度、模式、队列、音量、更多 | 86px 播放条、模式按钮、音量气泡、红心及评论数 | React 进度松手提交，音量仅本机，模式仅房主；Dashboard 已有固定条 | 每个入口保留唯一播放控制表面，沿用权限与 seek 规则，正文及安全区留位 |
| 播放队列面板 | 宽屏可调整停靠，窄屏覆盖，支持拖动 | 全局侧面板及虚拟队列，区别于收藏歌单；README 明确暂不支持排序删除 | React Playlist 为共享房间列表；DownloadQueue 是任务抽屉，Dashboard 队列 sheet 用于切歌单 | 接下来仅投影同一共享列表；桌面停靠，示意图手机放正文下方便于审阅，未来可做独立 sheet；下载队列继续独立 |
| 徽章与反馈 | 格式 chips、独占输出时的信号链质量 | Hi-Res／SQ、播放指示，实际质量可能降级 | 已有版本、来源、音质、信任 UP 标签及传输／下载进度 | 优先真实来源、状态和权限；可用资源音质不等于实际播放质量，FLAC 样例仅是占位元数据 |
| 空白／加载／错误 | 首次导入引导，歌词区分未查找和无歌词 | Resource 分离初载／失败／空数据／已有数据，同 key 刷新保留快照 | 大厅错误、角色相关空列表、服务重试、下载重试、Toast | 区分首次加载、刷新、空结果和来源故障；同查询刷新保留内容，换查询清旧结果，不遮挡当前播放 |
| 主题 | 六种主题家族、明暗、可选封面取色和有界极光底色 | 共享主题 token，沉浸页有封面衍生暗色渐变 | 已有暖光同频语义令牌、明暗和减少动效 | 沿用暖纸／白表面、琥珀房主、玫瑰房客，仅头图轻染暖色，不由封面改角色色和状态色 |
| 社交重心 | 个人本地音乐管理 | 账号／VIP、推荐、公开红心评论数量 | 两个人的邀请、在线、共同收听统计、好友动态 | 优先彼此在线、邀请和共同时间，不让公众互动指标或登录门槛主导房间 |

### 优先级与未来涉及文件

- **P0：稳定房间上下文与唯一播放条。** React：`src/App.jsx`、`src/components/ConnectionBar.jsx`、`NowPlaying.jsx`、`PlayerControls.jsx`、`src/styles.css`。Dashboard：`public/dashboard.html` 播放器函数、`public/mobile.css`。保留本机音量、松手 seek、房客请求切歌及房主改模式；邀请／重连／缓冲明确可见，触控区至少 44px，有键盘焦点和安全区。Dashboard 优化既有播放条，不另加一套。
- **P0：共享队列和下载任务分开。** `src/components/Playlist.jsx`、`DownloadQueue.jsx`、`ConnectionBar.jsx`、`src/App.jsx`、`src/styles.css`，以及 `public/dashboard.html` 队列 sheet。接下来由当前共享列表与播放位置计算，不引入第二份可写播放队列，也不预设房客可拖动管理。未来窄屏用独立 sheet；当前静态图上下排列便于审阅。
- **P1：搜索层级与真实状态。** `src/components/SearchDrawer.jsx`、`DownloadQueue.jsx`、`Toasts.jsx`、`src/styles.css`；Dashboard 的 SearchDrawer／SearchDiscovery、`public/discoveryUI.js`、`public/mobile.css`。突出最佳歌曲，保留版本、来源和下载反馈，分清下载入库与追加房间；未具备数据时不提供专辑／歌手筛选。区分初载、刷新、无结果及单来源失败。
- **P1：曲库分类带与上下文卡片。** `public/dashboard.html` 的 LibraryPanel／PlaylistChips／RoomPlaylistBanner，以及 `public/friendsUI.js`、`statsUI.js`、`discoveryUI.js`、`accountUI.js`、`public/mobile.css`。原位详情返回时保持选中歌单和滚动位置，明确追加／替换，沿用好友邀请与统计语义。专辑和最近收听分类是建议视图，不表示完整数据实体已支持。
- **P2：展开歌词。** `src/components/NowPlaying.jsx`、`PlayerControls.jsx`、`src/App.jsx`、`src/styles.css`，Dashboard FullscreenPlayer 与 `public/mobile.css`。歌词来源和共享 seek 需单独设计，改 UI 无法直接交付。保留原文／译文配对、恢复跟随、加载／无歌词、双人状态和既有权限。黑胶动效可选，并支持减少动效。
- **P2：密度与氛围细化。** `src/components/Playlist.jsx`、`SearchDrawer.jsx`、`src/styles.css`、Dashboard 列表／搜索呈现与 `public/mobile.css`。先验证长标题、大队列，再决定虚拟化与调列宽。消费 `public/design-tokens.css`，不改变角色／状态语义，不增加多主题家族选择器。

### 不适合双人一起听的三个模式

1. 每次从曲库播放就复制或替换个人播放队列：会破坏两人对共享列表的预期，改为明确追加及房主协调切换。
2. VIP、公开红心数、评论数和完整评论栏构成的内容门户：会挤占彼此的在线感和共同收听，可保留个人收藏，不引入公众互动指标。
3. 整窗自动迷你模式、操作系统主题家族、手机上完整桌面列管理和标签编辑：WebView 需要稳定导航和触控空间，只借紧凑播放条及克制氛围，不复制原生窗口和重型曲库工具。

### 令牌、响应式与取证边界

每页直接内联现有浅色令牌值，不依赖外部样式、字体、图片或 CDN。暖纸 `#f7f0e8`、白表面 `#ffffff`、浅底 `#f4eee7`、正文 `#221d19`、次级文字 `#6b594a`、边线 `#dccdbe`；品牌琥珀 `#f2a65a` 与玫瑰 `#ec7a96`。房主前景 `#8a460c`／底 `#fff1df`，房客前景 `#a32f55`／底 `#fdebf1`，成功前景 `#146c43`／底 `#e8f5ed`。浅色是本次示意状态，未来暗色继续使用现有暗色映射，不提议新配色体系。

桌面保留侧栏、固定播放条及停靠队列；手机导航换行，封面／歌词上下布局，Dashboard 卡片单列，搜索占满内容宽度，播放条精简。正文为固定条留足空间，底部使用安全区。文字可换行，示意图没有动画。分类切换、拖拽、列宽和歌词时间均没有模拟实现。

英文 Evidence 部分列出实际读取的本地源文件及截图；路径均对应用户提供的快照，不代表上游最新版本。已实际查看 Melodia 的 songs、playlist-detail、search、nowplaying-lyrics、miniplayer-onestrip-aurora 五张 PNG，以及 NetEase 的 docs/images/screenshot.png。后者展示歌单页，其推荐和歌词模式由 README／源码验证。Melodia ADR 26／38 支持氛围与歌词状态判断；NetEase architecture 支持加载状态分析，其搜索源码标有未接入分类，README 标有队列排序／删除限制。

当前项目的 `public/dashboard.css` 不存在，现有 `dist/dashboard.css` 仅只读检查；未来改动应追溯其源文件，不能把生成 CSS 当作本次修改目标。现有 React、Dashboard、设计说明及 token／mobile 样式均作为依据。所有建议涉及文件仅描述后续可能范围，本次只新增本目录六个文件，不修改应用、已有文档或配置，不提交、不启动开发服务器、不构建。

验证：UTF-8、本地链接及锚点、无脚本与内联 CSS 检查通过；Chrome 直接打开五页，在 390／430／1100／1440px 共 20 个视口检查通过，无横向溢出，并已目视检查桌面和手机截图。临时截图与浏览器 profile 已清理，没有运行构建或开发服务器。


### Implemented 2026-10-27

P0–P2 shipped using existing track/playlist/provider models: one player surface per entry point, persistent room presence, read-only Up Next projection, separate download drawer, best song match/provider groups with keyed refresh/error states, explicit library-download versus queue-append and playlist-replace actions, in-place playlist header with scroll restoration, token-based responsive density. Expanded playback uses cover, both listeners and Up Next; lyrics, album/artist entities and engagement counters were omitted; the existing mock search and synthesized-audio demo fallback remain available. An all-library playback scope already includes every library track; appending there is an explicit no-op. Guest queue management stays host-controlled. Dashboard remains a no-build development page using its original Tailwind CDN, esm.sh import map and inline module; production/Android retain the original local bundling pipeline.

已按现有模型实现 P0–P2：唯一播放器、房间在线状态、只读“接下来”投影、独立下载抽屉、最佳歌曲与来源分组、按查询键保留刷新结果、区分下载入库／追加／替换、歌单原位横幅与滚动恢复，以及令牌化响应式布局。展开页只有封面、双人状态与接下来；未实现歌词、专辑／歌手实体或公众指标；保留原有 mock 搜索与合成音频演示回退。播放范围为整个曲库时，曲库歌曲已在队列，追加操作不会另建队列；房客的队列管理仍由房主负责。开发 Dashboard 恢复原有无需构建的 Tailwind CDN、esm.sh importmap 与内联 module，Android／生产沿用原打包流程。
