/**
 * 像素级证据：开了「透出桌面」之后，页面是真的把底色交出去了吗？
 *
 * 思路：
 *   让 CDP 用「透明底」导出 PNG（Emulation.setDefaultBackgroundColorOverride a=0），
 *   再从渲染器抓帧（fromSurface:false —— 开着系统材质时抓表面会一直等不到帧）。
 *   页面哪里没画东西，那里导出的像素 alpha 就是 0。
 *
 *   于是只要比较「不开」和「开」两种状态下同一块区域（比如左侧栏中部）的 alpha：
 *     不开 → 页面自己铺了不透明底色，alpha = 255
 *     开   → 页面放掉了底色，留出给系统材质，alpha 明显小于 255
 *
 *   这个差值就是"桌面有没有地方透上来"的直接证据 ——
 *   比肉眼看截图可靠得多，也不依赖 DWM 到底怎么合成。
 *
 * 用法：应用需带 --remote-debugging-port=9700 启动
 *   node tools/verify-see-through-pixels.js 9700
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

/** 极简 PNG 解码：只要能拿到 RGBA 像素就够（只处理 CDP 输出的 8bit RGBA） */
function decodePng(buf) {
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`不支持的 PNG 格式 bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: cur[i] = (cur[i] + a) & 255; break;
        case 2: cur[i] = (cur[i] + b) & 255; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: throw new Error('未知 filter ' + filter);
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, channels, data: out };
}

/** 取一块矩形区域的 alpha 平均值（0-255） */
function avgAlpha(img, x0, y0, x1, y1) {
  const { w, h, channels, data } = img;
  if (channels === 3) return 255;   // 没有 alpha 通道就是全不透明
  let sum = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      sum += data[(y * w + x) * channels + 3];
      n++;
    }
  }
  return n ? Math.round(sum / n) : -1;
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  fs.mkdirSync(OUTDIR, { recursive: true });

  // 透明底导出 —— 页面没画的地方才会露出 alpha=0
  await send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 }
  });

  /** 抓一帧并算侧栏 / 内容区中部的 alpha */
  async function sample(tag) {
    await new Promise((r) => setTimeout(r, 900));
    const s = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('截图超时')), 15000))
    ]);
    const buf = Buffer.from(s.data, 'base64');
    fs.writeFileSync(path.join(OUTDIR, `px-${tag}.png`), buf);
    const img = decodePng(buf);
    // 左侧栏大约占左边 260px；取中部一块，避开标题栏和状态栏
    const sb = avgAlpha(img, 20, Math.round(img.h * 0.45), 200, Math.round(img.h * 0.6));
    const ct = avgAlpha(img, Math.round(img.w * 0.55), Math.round(img.h * 0.45), Math.round(img.w * 0.75), Math.round(img.h * 0.6));
    return { w: img.w, h: img.h, sb, ct };
  }

  const rows = [];

  /* 基线：不透 */
  await ev(`
    await API.setDesktopMaterial('off');
    window.Bg.applySlot('sidebar', { type: 'material', material: 'liquid' });
    window.Bg.applySlot('content', { type: 'material', material: 'liquid' });
    return 1;
  `);
  const base = await sample('off');
  rows.push(['不透（基线）', `侧栏 alpha=${base.sb}  内容区 alpha=${base.ct}`]);

  /* 开：透出桌面 */
  await ev(`
    await API.setDesktopMaterial('acrylic');
    window.Bg.applySlot('sidebar', { type: 'material', material: 'liquid' });
    window.Bg.applySlot('content', { type: 'material', material: 'liquid' });
    return 1;
  `);
  const see = await sample('see');
  rows.push(['透出桌面', `侧栏 alpha=${see.sb}  内容区 alpha=${see.ct}`]);

  const okSb = see.sb < base.sb - 20;
  const okCt = see.ct < base.ct - 20;
  const verdict = (okSb && okCt)
    ? '通过 ✓ 放透后页面确实把底色交出去了（alpha 明显下降），桌面有地方透上来'
    : `未通过 ✗ 侧栏 ${okSb ? 'ok' : 'alpha 没降'} / 内容区 ${okCt ? 'ok' : 'alpha 没降'}`;

  await ev(`
    await API.setDesktopMaterial('auto');
    window.Bg.applySlot('sidebar', { type: 'default' });
    window.Bg.applySlot('content', { type: 'default' });
    return 1;
  `);

  const lines = [
    '========= 像素级证据：页面有没有把底色交出去 =========',
    `画面尺寸 ${base.w}×${base.h}`,
    ...rows.map(([k, v]) => `${String(k).padEnd(14, ' ')} | ${v}`),
    '------------------------------------------------------',
    verdict,
    `截图: ${path.join(OUTDIR, 'px-off.png')} / ${path.join(OUTDIR, 'px-see.png')}`,
    '======================================================'
  ];
  const text = lines.join('\n');
  fs.writeFileSync(path.join(OUTDIR, 'pixels.txt'), text);
  console.log(text);
  process.exitCode = (okSb && okCt) ? 0 : 1;
  ws.close();
})().catch((e) => {
  const msg = `验证失败: ${e.message}`;
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(path.join(OUTDIR, 'pixels.txt'), `${msg}\n`);
  } catch (_) { /* 忽略 */ }
  console.error(msg);
  process.exitCode = 1;
});
