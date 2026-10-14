# Android 真机验收记录 · 2026-10-13

后续布局优化：已安装 versionCode 5（`0.0.0-dev.5-layout`）。播放控制改为对称五列，播放键真机中心 x=180px，与 360px 屏幕中心一致；页头压缩至 141px，设置移至右上；增加播放器曲库入口并验证打开；缩小搜索空态间距。浏览器 320/360/390/768/1280px 无横向溢出，控制区中心偏差小于 0.01px。原有曲库保留。

设备：Samsung SM-S931U，Android 17，物理分辨率 1080×2340。

安装包：`android/app/build/outputs/apk/debug/app-debug.apk`，包名 `com.halfhalf.musicplayer.qa`，名称「Half&Half 验收版」，versionCode 4。

手机原有应用签名与本机调试签名不同，不能覆盖。此次使用独立包名安装；没有卸载、清除或迁移原应用的数据。验收版保留一首自生成的 12 分钟 WAV 测试音频（23,040,044 字节），当前已暂停。没有推送 GitHub。

## 真机发现并修复

1. **原生插件桥未接通**：原先直接调用 `window.Capacitor.registerPlugin()`，但 Android 注入桥并不提供这个 SDK 方法。因此旧模拟测试虽然通过，真实返回事件、Filesystem 和前台服务都没有接通。新增 `public/nativeBridge.js`，从 `@capacitor/core` 注册并缓存插件代理；存储测试模拟真实 `PluginHeaders/nativePromise` 桥，而非虚构 registerPlugin。
2. **键盘遮挡搜索框**：移动端多行 sticky 头部遮挡输入框。改为手机 relative、桌面 sticky。真机键盘出现后视口从 780px 缩至 438px，播放器隐藏，输入框位于 y=198～240px，可见。
3. **深色界面状态栏对比度**：SystemBars 配置 `style: DARK`，与深色页面匹配。
4. **WebView 缺少 HTML MediaSession**：该真机 `navigator.mediaSession` 不可用。新增原生 `PlaybackSessionPlugin`，提供标题、歌手、时长、位置、播放状态、系统播放/暂停/前后曲和 seek 回调。保留现有 mediaPlayback 前台服务和通知按钮。该插件仍控制 WebView 音频，不是 Media3 原生播放器。

## 已通过

| 项目 | 证据 |
|---|---|
| 首屏、竖屏安全区 | CSS 宽 360px，scrollWidth=360；顶部安全区 34px |
| 播放器内容预留 | 底栏 175px，内容底部预留 206px，包含安全区 |
| 软键盘 | 780→438px；底栏隐藏；输入框不再被头部挡住 |
| 原生返回键 | 设置关闭、播放台回大厅、搜索结果清空、取消房间等待 |
| 边缘返回手势 | 解锁后从设置面板左边缘侧滑，面板关闭 |
| 根视图防误退出 | 第一次出现“再按一次退出应用”；连续返回才退出到桌面 |
| 横屏 | 780×360，scrollWidth=780；左侧摄像头安全区 34px；底栏 106px |
| 原生文件保存 | 私有 `files/library-v1/` 出现完整 23,040,044 字节 .audio、JSON 和迁移标记 |
| 重启与覆盖安装恢复 | 独立验收版覆盖安装及重新启动后，同一首音频自动恢复 |
| 前台服务 | dumpsys 显示 isForeground=true，类型 0x2（mediaPlayback），3 个通知动作 |
| 唤醒锁 | 播放期间 PARTIAL_WAKE_LOCK `CapacitorAndroidForegroundService::Wakelock` |
| 后台/锁屏声音 | 用户明确反馈“声音持续正常” |
| 无 WebView 调试连接锁屏 | 移除 ADB DevTools 转发；熄屏约一分钟后仍为 Dozing，AudioPlaybackConfiguration 为 started、mutedState:none |
| 原生媒体会话 | dumpsys media_session 显示 HalfHalfPlayback 为媒体按键接收会话、active=true、PLAYING |
| 系统媒体暂停/恢复 | KEYCODE_MEDIA_PAUSE 实际暂停；前台服务及唤醒锁消失；KEYCODE_MEDIA_PLAY 恢复 |
| 构建与回归 | Android assembleDebug 成功；44 项 Node 测试通过 |

横屏测试后已恢复原始竖屏设置（accelerometer_rotation=0，user_rotation=0）。

## 未覆盖与边界

- 没有针对微信逐一测试聊天、短视频、语音通话抢占音频焦点。其他应用正常抢占音频焦点时暂停不必然是 bug。
- 本次锁屏持续性只验证短时约一分钟及用户听感，不等同于 10 分钟以上、Doze 深度休眠、拔掉 USB、低电量、厂商极限省电或进程被杀测试。
- 只有一台设备，未验收双机后台 WebRTC 同步和来电恢复。
- 原应用签名不同，旧正式包 IndexedDB 原地迁移没有真机覆盖。本次仅确认验收包新保存和覆盖安装恢复。
- 原生 MediaSession 的封面与厂商锁屏卡片完整视觉、通知各按钮触摸、蓝牙实体耳机按键尚未逐项验收；系统媒体键回调已通过。
- 当前构建未填入 Render URL，搜索为演示数据，不作为真实音乐后端联网验收。
- FGS/唤醒锁不能保证 WebView 永不终止；需要脱离 WebView 的长期后台播放时仍应迁移到 Media3 + MediaSessionService。

## 重建独立验收包

```powershell
npm run cap:sync
node scripts/gradle.mjs assembleDebug -PqaBuild -PappVersionCode=4 -PappVersionName=0.0.0-dev.4-mobile
```

不传 `-PqaBuild` 时保持原生产包名。发布前仍需使用与原应用相同的正式签名。
