// Run after `vite build` + `write-app-config.mjs`, before `cap sync android`.
//
// The Android app should open the full-featured single-file dashboard (public/dashboard.html), not the
// Vite demo UI. Capacitor always loads dist/index.html, so the original index.html is kept as app.html
// and index.html becomes a tiny redirect. Web deployments (Pages / Vercel) do not run this script.
import { copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
for (const f of ['index.html', 'dashboard.html', 'app-config.js']) {
  if (!existsSync(path.join(dist, f))) {
    console.error(`dist/${f} is missing: run "npm run build:android" instead of calling this script directly`);
    process.exit(1);
  }
}

await copyFile(path.join(dist, 'index.html'), path.join(dist, 'app.html'));
await writeFile(
  path.join(dist, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Half&Half</title>
<meta http-equiv="refresh" content="0; url=./dashboard.html" />
<script>location.replace('./dashboard.html' + location.search + location.hash);</script>
</head>
<body style="background:#0b0f1a"></body>
</html>
`,
);
console.log('Android web bundle: index.html -> dashboard.html (original kept as app.html)');
