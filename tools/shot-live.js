/**
 * 对着正在跑的窗口截图（开发期用）。
 *
 * 和项目自带的 --shot 模式的区别：那个会重启一个独立实例、
 * 用固定的数据与状态跑一遍；这个直接截当前窗口，
 * 适合「改完样式马上看效果」。
 *
 * 用法：
 *   ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9600
 *   node tools/shot-live.js 9600 preview/out.png [要应用的JS]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9600);
const OUT = process.argv[3] || path.join('preview', 'live.png');
const SETUP_JS = process.argv[4] || '';

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

  // SHOT_RELOAD=1：先刷新一次页面再截。
  // 改完 CSS / 渲染层 JS 想看效果时用，省得重启整个应用等 20 多秒。
  if (process.env.SHOT_RELOAD === '1') {
    await send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 3500));
  }

  if (SETUP_JS) {
    const r = await send('Runtime.evaluate', {
      expression: SETUP_JS, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      console.error('设置脚本出错:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    } else if (r.result && r.result.value !== undefined) {
      // 顺手把返回值打出来 —— 这样它也能当"在活着的窗口里跑一段脚本"的工具用
      console.log('脚本返回:', typeof r.result.value === 'string'
        ? r.result.value
        : JSON.stringify(r.result.value));
    }
    await new Promise((r2) => setTimeout(r2, 1400));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', OUT);
  process.exit(0);
})().catch((e) => {
  console.error('截图失败:', e.message);
  process.exit(1);
});
