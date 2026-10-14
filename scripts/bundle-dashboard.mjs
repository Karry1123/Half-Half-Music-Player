// Compile the existing dashboard for both Vercel and Capacitor; no runtime CDN.
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import path from 'node:path';
let html = await readFile('public/dashboard.html', 'utf8');
const config = html.match(/tailwind\.config = ([\s\S]*?);\s*<\/script>/)?.[1];
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
if (!config || !script) throw new Error('Dashboard build markers missing');
// Configuration is trusted repository source, not remote content.
const theme = Function(`return (${config})`)();
const css = await postcss([tailwind({ ...theme, content: [{ raw: html, extension: 'html' }] })])
  .process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined });
await writeFile('dist/dashboard.css', css.css);
await build({ stdin: { contents: script, resolveDir: path.resolve('public'), sourcefile: 'dashboard.js' },
  bundle: true, format: 'esm', target: 'es2022', minify: true, outfile: 'dist/dashboard.js' });
html = html.replace(/<script src="https:\/\/cdn\.tailwindcss.com[^>]*><\/script>\s*<script>[\s\S]*?<\/script>/,
  '<link rel="stylesheet" href="./dashboard.css" />');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '');
html = html.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="./dashboard.js"></script>');
await writeFile('dist/dashboard.html', html);
console.log('Dashboard: bundled JavaScript and Tailwind CSS locally');
