#!/usr/bin/env node
/**
 * upload-asset.js —— 给已存在的 Release 传附件（走 uploads.github.com）。
 *
 * 只在 node 里做 HTTP，不 spawn 任何子进程（本机沙箱会挡 spawnSync）。
 *
 * 用法：
 *   GH_TOKEN=xxx node tools/upload-asset.js <releaseId> <文件路径> [附件名] [显示名]
 * 例：
 *   GH_TOKEN=xxx node tools/upload-asset.js 406307832 "dist/GameHub-1.3.2-便携版.exe" \
 *     GameHub-1.3.2-Portable.exe "GameHub v1.3.2 便携版 · 单文件免安装"
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = 'luoyupan/GameHub';
const TOKEN = process.env.GH_TOKEN || '';
const id = process.argv[2];
const file = process.argv[3];
const name = process.argv[4] || path.basename(file);
const label = process.argv[5] || '';
if (!TOKEN || !id || !file) { console.error('用法: node upload-asset.js <releaseId> <file> [name] [label]'); process.exit(1); }

(async () => {
  const buf = fs.readFileSync(file);
  console.log(`上传 ${name}（${(buf.length / 1e6).toFixed(1)} MB）…`);
  const url = `https://uploads.github.com/repos/${REPO}/releases/${id}/assets`
    + `?name=${encodeURIComponent(name)}`
    + (label ? `&label=${encodeURIComponent(label)}` : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'GameHub-upload-asset',
    },
    body: buf,
  });
  const txt = await res.text();
  if (res.status >= 300) { console.error(`✗ HTTP ${res.status}\n${txt.slice(0, 800)}`); process.exit(1); }
  const j = JSON.parse(txt);
  console.log(`✓ 已上传：${j.name} / ${j.label || '(无标签)'} / ${(j.size / 1e6).toFixed(1)} MB / 下载数 ${j.download_count}`);
  console.log(`  ${j.browser_download_url}`);
})();
