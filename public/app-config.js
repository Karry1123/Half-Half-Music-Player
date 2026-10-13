// 运行时配置（页面加载时最先执行）。
//
// 本地开发保持为空：音乐服务走 Vite 代理 /music-api，信令走同源 /ws，ICE 读同源 /ice.json。
// 部署到 GitHub Pages / Vercel 时，构建脚本 scripts/write-app-config.mjs 会按环境变量重写 dist/app-config.js：
//   window.HH_CONFIG = {
//     apiBase:   'https://halfhalf-music.onrender.com',      // music-service 地址
//     signalUrl: 'wss://halfhalf-music.onrender.com/ws',     // Vite 主应用的信令
//     iceUrl:    'https://halfhalf-music.onrender.com/ice.json',
//   };
// 访问令牌（API_TOKEN）不能写在这里——这个文件是公开的。用户在页面「连接设置」里自己填，只存在本机浏览器。
window.HH_CONFIG = window.HH_CONFIG || {};
