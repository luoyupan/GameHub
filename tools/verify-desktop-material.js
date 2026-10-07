/**
 * 验证「透出桌面（窗口材质）」这条路是否真的通了。
 *
 * 要验证的东西有三层，缺任何一层都白搭：
 *   1) 主进程：win.setBackgroundMaterial() 有没有真的调用成功（build 够不够）
 *   2) 页面层：html[data-desktop-material] 标记有没有打上
 *   3) 样式层：body / .app / .sidebar / .content 的底色有没有放掉
 *              —— 页面只要还留一层不透明底色，系统材质就被盖死，等于没开
 *
 * 关于截图：
 *   开了系统材质之后窗口由 DWM 合成，CDP 默认的 fromSurface 抓表面会一直等不到帧，
 *   会卡死。所以截图改成可选（SHOT=1 才截），并且用 fromSurface:false 走渲染器，
 *   这样至少能看出"页面是不是真的把底色放掉了"。
 *
 * 注意：CDP 的 Runtime.evaluate 是把表达式当「脚本」编译的，
 * 顶层 await 会直接语法错，所以每段脚本都得自己包一层 async IIFE。
 *
 * 用法：
 *   应用需带 --remote-debugging-port=9700 启动
 *   node tools/verify-desktop-material.js 9700
 *   SHOT=1 node tools/verify-desktop-material.js 9700    # 顺带截图
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9700);
const OUTDIR = path.join('preview', 'desktop-material');
const WANT_SHOT = process.env.SHOT === '1';

function list() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  const page = (await list()).find((t) => t.type === 'page');
  if (!page) throw new Error('没找到页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    waiters.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id);
      waiters.delete(m.id);
      m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  fs.mkdirSync(OUTDIR, { recursive: true });
  const report = [];

  /* ---------- 0. 系统层面支不支持 ---------- */
  const sup = JSON.parse(await ev(`return JSON.stringify(await API.desktopMaterialSupport())`));
  report.push(['系统支持', sup.supported ? `是（build ${sup.build}）` : `否 — ${sup.reason}`]);

  /* 各状态下取一次快照：html 标记 + 关键元素的实际底色 */
  const snap = `return JSON.stringify({
    attr: document.documentElement.getAttribute('data-desktop-material'),
    body: getComputedStyle(document.body).backgroundColor,
    app: getComputedStyle(document.querySelector('.app')).backgroundColor,
    sb: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
    ct: getComputedStyle(document.querySelector('.content')).backgroundColor,
    tb: getComputedStyle(document.querySelector('.titlebar')).backgroundColor
  })`;

  for (const mode of ['none', 'acrylic', 'mica']) {
    const res = await ev(`return JSON.stringify(await API.setDesktopMaterial(${JSON.stringify(mode)}))`);
    await ev(`
      const s = await API.settingsGet();
      s.desktopMaterial = ${JSON.stringify(mode)};
      window.Bg.applyDesktop(s);
      return 1;
    `);
    const st = JSON.parse(await ev(snap));
    const label = { none: '关闭', acrylic: '亚克力', mica: '云母' }[mode];
    report.push([`${label}：主进程返回`, res]);
    report.push([`${label}：html 标记`, String(st.attr)]);
    report.push([`${label}：body 底色`, st.body]);
    report.push([`${label}：.app 底色`, st.app]);
    report.push([`${label}：侧栏底色`, st.sb]);
    report.push([`${label}：内容区底色`, st.ct]);
    report.push([`${label}：标题栏底色`, st.tb]);
  }

  /* ---------- 开着材质时，图片背景仍应铺满（上一轮修的东西别被带坏） ---------- */
  const fill = JSON.parse(await ev(`
    const ct = document.querySelector('.content');
    const cs = getComputedStyle(ct, '::before');
    const sb = document.querySelector('.sidebar');
    const ss = getComputedStyle(sb, '::before');
    return JSON.stringify({
      ctH: cs.height, ctW: cs.width,
      sbH: ss.height, sbW: ss.width,
      ctBoxH: getComputedStyle(ct).height
    });
  `));
  report.push(['内容区 ::before 尺寸', `${fill.ctW} × ${fill.ctH}`]);
  report.push(['内容区实际高度', fill.ctBoxH]);
  report.push(['侧栏 ::before 尺寸', `${fill.sbW} × ${fill.sbH}`]);

  /* ---------- 截图（可选） ---------- */
  const shots = [];
  if (WANT_SHOT) {
    for (const mode of ['none', 'acrylic']) {
      await ev(`await API.setDesktopMaterial(${JSON.stringify(mode)}); return 1;`);
      await new Promise((r) => setTimeout(r, 1500));
      try {
        // fromSurface:false —— 从渲染器抓，绕开 DWM 合成面的等待
        const s = await Promise.race([
          send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 12000))
        ]);
        const p = path.join(OUTDIR, `${mode}.png`);
        fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
        shots.push(p);
      } catch (e) {
        shots.push(`${mode}.png（失败：${e.message}）`);
      }
    }
  }

  /* ---------- 收尾：恢复关闭状态 ---------- */
  await ev(`return await API.setDesktopMaterial('none')`);

  const lines = ['================ 透出桌面 验证结果 ================'];
  for (const [k, v] of report) lines.push(`${String(k).padEnd(22, ' ')} | ${v}`);
  lines.push('==================================================');
  if (shots.length) lines.push(`截图: ${shots.join(', ')}`);
  const text = lines.join('\n');
  fs.writeFileSync(path.join(OUTDIR, 'report.txt'), text);
  console.log(text);
  process.exitCode = 0;
  ws.close();
})().catch((e) => {
  const msg = `验证失败: ${e.message}`;
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.appendFileSync(path.join(OUTDIR, 'report.txt'), `${msg}\n`);
  } catch (_) { /* 忽略 */ }
  console.error(msg);
  process.exitCode = 1;
});
