#!/usr/bin/env node
/**
 * 把 npm 上的第三方前端库拷到 src/renderer/vendor/，
 * 供 index.html 以普通 <script> 标签加载。
 *
 * 用法：npm run vendor   （npm install 之后会自动执行 prepare 钩子）
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const vendor = join(appRoot, 'src', 'renderer', 'vendor');

const FILES = [
  ['marked/marked.min.js', 'marked.js'],
  ['dompurify/dist/purify.min.js', 'purify.js'],
  ['@highlightjs/cdn-assets/highlight.min.js', 'highlight.js'],
  ['@highlightjs/cdn-assets/styles/github.min.css', 'hljs-light.css'],
  ['@highlightjs/cdn-assets/styles/github-dark.min.css', 'hljs-dark.css'],
];

mkdirSync(vendor, { recursive: true });

let copied = 0;
for (const [from, to] of FILES) {
  const src = join(appRoot, 'node_modules', from);
  if (!existsSync(src)) {
    console.warn(`[vendor] 缺少 ${from}，请先 npm install`);
    continue;
  }
  copyFileSync(src, join(vendor, to));
  copied += 1;
}

console.log(`[vendor] 已就绪 ${copied}/${FILES.length} → src/renderer/vendor/`);
