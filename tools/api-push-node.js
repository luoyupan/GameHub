#!/usr/bin/env node
/**
 * api-push-node.js —— 只读 .tmp-push/ 目录 + 发 GitHub API，全程不 spawn 任何子进程。
 *
 * 由 tools/api-push.sh 负责收集 git 数据（node 里 spawnSync('git') 会被沙箱挡成 EBUSY）。
 *
 * 核心技巧：tree / parent / author / committer / message 全部与本地提交逐字节一致
 *           ⇒ 远端生成的 commit SHA == 本地 SHA ⇒ 推完本地 refs 无需重置。
 *
 * 可选（环境变量 / 目录文件）：
 *   .tmp-push/tag.txt     要打的标签名，如 v1.3.2
 *   .tmp-push/notes.md    Release 说明正文
 *   ASSET_PATH            要上传的附件路径，如 dist/GameHub-1.3.2-便携版.exe
 *   ASSET_NAME            附件在 GitHub 上的文件名（建议纯 ASCII）
 *   ASSET_LABEL           附件显示名（可以写中文）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = 'luoyupan/GameHub';
const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) { console.error('缺 GH_TOKEN'); process.exit(1); }
const DIR = '.tmp-push';
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(DIR, p));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GameHub-api-push',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    },
    body: body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8'),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 204 无 body */ }
  return { code: res.status, text, json };
}
async function ok(label, r) {
  if (r.code >= 300) { console.error(`✗ ${label} HTTP ${r.code}\n${r.text.slice(0, 1000)}`); process.exit(1); }
  return r.json;
}

/** 读一个提交的收集结果 */
function readCommit(i) {
  const d = `c${i}`;
  const h = read(`${d}/head.txt`).trimEnd().split('\t');
  const meta = { full: h[0], tree: h[1], AN: h[2], AE: h[3], AD: h[4], CN: h[5], CE: h[6], CD: h[7] };
  meta.message = read(`${d}/msg.txt`);
  const entries = [];
  for (const line of read(`${d}/files.txt`).split('\n')) {
    if (!line.trim()) continue;
    const [st, mode, p, blobIdx] = line.split('\t');
    if (st === 'D') { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
    entries.push({
      path: p, mode, type: 'blob',
      content: fs.readFileSync(path.join(DIR, d, 'blobs', blobIdx), 'utf8'),
    });
  }
  return { meta, entries };
}

(async () => {
  let parent = read('base.txt').trim();
  let parentTree = '';
  const r0 = await ok('读远端 main', await api('GET', `https://api.github.com/repos/${REPO}/git/commits/${parent}`));
  parentTree = r0.tree.sha;
  console.log(`起点 base=${parent.slice(0, 7)} tree=${parentTree.slice(0, 7)}`);

  let i = 1;
  let finalSha = parent;
  while (fs.existsSync(path.join(DIR, `c${i}`))) {
    const { meta, entries } = readCommit(i);
    console.log(`\n== 提交 ${meta.full.slice(0, 7)}：${entries.length} 个文件 ==`);
    for (const e of entries) console.log(`   ${e.sha === null ? 'D' : 'M'}  ${e.path}`);

    const t = await ok('建树', await api('POST', `https://api.github.com/repos/${REPO}/git/trees`,
      { base_tree: parentTree, tree: entries }));
    console.log(`   远端树 ${t.sha.slice(0, 7)} / 本地树 ${meta.tree.slice(0, 7)}`);
    if (t.sha !== meta.tree) {
      console.error('✗ 树 SHA 对不上：远端基线与本地假设不一致，停下来等你确认');
      process.exit(1);
    }

    const cm = await ok('建提交', await api('POST', `https://api.github.com/repos/${REPO}/git/commits`, {
      message: meta.message,
      tree: t.sha,
      parents: [parent],
      author: { name: meta.AN, email: meta.AE, date: meta.AD },
      committer: { name: meta.CN, email: meta.CE, date: meta.CD },
    }));
    console.log(`   远端提交 ${cm.sha} / 本地提交 ${meta.full}`);
    if (cm.sha !== meta.full) {
      // 打印远端实际存下来的字段，方便判断到底差在哪（多半是日期被规范化成 UTC）
      console.error('✗ 提交 SHA 对不上，远端实际字段：');
      console.error('   author   :', JSON.stringify(cm.author));
      console.error('   committer:', JSON.stringify(cm.committer));
      console.error('   msgLen   :', cm.message.length, '（本地', Buffer.byteLength(meta.message), '）');
      console.error('   msgTail  :', JSON.stringify(cm.message.slice(-30)), '（本地', JSON.stringify(meta.message.slice(-30)), '）');
      process.exit(1);
    }
    parent = cm.sha;
    parentTree = t.sha;
    finalSha = cm.sha;
    i++;
  }

  await ok('更新 main', await api('PATCH', `https://api.github.com/repos/${REPO}/git/refs/heads/main`,
    { sha: finalSha, force: false }));
  console.log(`\n✓ main -> ${finalSha.slice(0, 7)}`);

  const tag = exists('tag.txt') ? read('tag.txt').trim() : '';
  if (tag) {
    await ok(`打标签 ${tag}`, await api('POST', `https://api.github.com/repos/${REPO}/git/refs`,
      { ref: `refs/tags/${tag}`, sha: finalSha }));
    console.log(`✓ tag ${tag} -> ${finalSha.slice(0, 7)}`);
  }

  // ---------- Release ----------
  if (exists('notes.md')) {
    const body = read('notes.md');
    const rel = await ok('建 Release', await api('POST', `https://api.github.com/repos/${REPO}/releases`, {
      tag_name: tag || `v${Date.now()}`,
      name: tag ? `GameHub ${tag} · 便携版（单文件免安装）` : 'GameHub 便携版',
      body,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    }));
    console.log(`✓ Release ${rel.tag_name}（id=${rel.id}）`);

    const assetPath = process.env.ASSET_PATH || '';
    if (assetPath) {
      const abs = path.resolve(assetPath);
      const name = process.env.ASSET_NAME || path.basename(abs);
      const label = process.env.ASSET_LABEL || '';
      const buf = fs.readFileSync(abs);
      console.log(`上传附件 ${name}（${(buf.length / 1048576).toFixed(1)} MB）…`);
      const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}${label ? '&label=' + encodeURIComponent(label) : ''}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'GameHub-api-push',
        },
        body: buf,
      });
      const txt = await up.text();
      if (up.status >= 300) { console.error(`✗ 传附件 HTTP ${up.status}\n${txt.slice(0, 600)}`); process.exit(1); }
      console.log(`✓ 附件已上传：${JSON.parse(txt).name}（${(JSON.parse(txt).size / 1048576).toFixed(1)} MB）`);
    }
  }

  console.log('FINAL=' + finalSha);
})();
