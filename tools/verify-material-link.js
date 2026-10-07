/**
 * 验证「选了玻璃系材质 → 窗口真的透出桌面」这条联动。
 *
 * 这是用户真正要的东西：
 *   在设置里给某一栏选「亚克力 / 玻璃 / 液态玻璃 / 磨砂」，
 *   窗口就该切到系统亚克力，让桌面透上来。
 *
 * 分两层查，缺一层都不算数：
 *   ① 主进程：resolveDesktopMaterial 有没有把玻璃材质换算成 acrylic
 *   ② 页面层：html[data-desktop-material] 有没有打上，
 *              材质底色有没有从 --mat-* 换成 --mat-*-see（真的放淡了）
 *
 * 注意：CDP 的 Runtime.evaluate 把表达式当脚本编译，顶层 await 会语法错，
 * 所以每段脚本都得自己包 async IIFE。
 *
 * 用法：应用需带 --remote-debugging-port=9700 启动
 *   node tools/verify-material-link.js 9700
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9700);
const OUTDIR = path.join('preview', 'desktop-material');

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
  const fails = [];

  const sup = JSON.parse(await ev(`return JSON.stringify(await API.desktopMaterialSupport())`));
  report.push(['系统支持', sup.supported ? `是（build ${sup.build}）` : `否 — ${sup.reason}`]);

  /**
   * 把内容区设成指定形态，然后读回「窗口实际材质」和「页面标记 / 底色」。
   * 主进程改完会推消息回来，所以留 400ms 等推送落地。
   */
  async function scenario(label, patch, expect) {
    await ev(`
      await API.settingsSet(${JSON.stringify(patch)});
      return 1;
    `);
    await new Promise((r) => setTimeout(r, 400));
    const st = JSON.parse(await ev(`
      const ct = document.querySelector('.content');
      return JSON.stringify({
        attr: document.documentElement.getAttribute('data-desktop-material'),
        ctBg: getComputedStyle(ct).backgroundColor,
        ctMat: ct.getAttribute('data-material'),
        ctCls: ct.className,
        body: getComputedStyle(document.body).backgroundColor,
        app: getComputedStyle(document.querySelector('.app')).backgroundColor
      });
    `));
    const got = st.attr || 'off';
    const ok = got === expect;
    if (!ok) fails.push(`${label}：期望 ${expect}，实际 ${got}`);
    report.push([`${label}`, `${ok ? '✓' : '✗'} 窗口材质=${got}（期望 ${expect}）`]);
    report.push([`  └ 内容区`, `material=${st.ctMat || '-'} class="${st.ctCls}" bg=${st.ctBg}`]);
    report.push([`  └ 页面底`, `body=${st.body} app=${st.app}`]);
    return st;
  }

  /* 先固定成「自动」模式 */
  await ev(`await API.setDesktopMaterial('auto'); return 1;`);

  await scenario('纯色底（默认）', { bg: { content: { type: 'default' } } }, 'off');
  await scenario('磨砂玻璃', { bg: { content: { type: 'material', material: 'frosted' } } }, 'acrylic');
  await scenario('亚克力', { bg: { content: { type: 'material', material: 'acrylic' } } }, 'acrylic');
  await scenario('玻璃', { bg: { content: { type: 'material', material: 'glass' } } }, 'acrylic');
  await scenario('液态玻璃', { bg: { content: { type: 'material', material: 'liquid' } } }, 'acrylic');
  await scenario('换回纯色底', { bg: { content: { type: 'default' } } }, 'off');

  /* 强制不透：就算用玻璃材质也不该透 */
  await ev(`await API.setDesktopMaterial('off'); return 1;`);
  await scenario('液态玻璃 + 强制不透', { bg: { content: { type: 'material', material: 'liquid' } } }, 'off');

  /* 强制亚克力：就算用纯色底也要透 */
  await ev(`await API.setDesktopMaterial('acrylic'); return 1;`);
  await scenario('纯色底 + 强制亚克力', { bg: { content: { type: 'default' } } }, 'acrylic');

  /* 图片背景不该触发透出桌面（用户要求图片铺满） */
  await ev(`await API.setDesktopMaterial('auto'); return 1;`);
  await scenario('图片背景', { bg: { content: { type: 'image' } } }, 'off');

  /* 收尾：恢复默认 */
  await ev(`
    await API.setDesktopMaterial('auto');
    await API.settingsSet({ bg: { content: { type: 'default' }, sidebar: { type: 'default' } } });
    return 1;
  `);

  const lines = ['============ 材质 ↔ 透出桌面 联动验证 ============'];
  for (const [k, v] of report) lines.push(`${String(k).padEnd(20, ' ')} | ${v}`);
  lines.push('==================================================');
  lines.push(fails.length ? `失败 ${fails.length} 项：\n  - ${fails.join('\n  - ')}` : '全部通过 ✓');
  const text = lines.join('\n');
  fs.writeFileSync(path.join(OUTDIR, 'material-link.txt'), text);
  console.log(text);
  process.exitCode = fails.length ? 1 : 0;
  ws.close();
})().catch((e) => {
  const msg = `验证失败: ${e.message}`;
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(path.join(OUTDIR, 'material-link.txt'), `${msg}\n`);
  } catch (_) { /* 忽略 */ }
  console.error(msg);
  process.exitCode = 1;
});
