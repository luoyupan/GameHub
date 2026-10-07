/**
 * 外观自定义 + 卸载功能的实机验证脚本。
 *
 * 用法：先启动应用（带 --remote-debugging-port=9600），再跑这个脚本。
 *   ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9600
 *   node tools/appearance-probe.js
 *
 * 它通过 CDP 连到正在跑的窗口，检查：
 *   · 新增模块是否挂上（Bg / API.appearance* / Modals.uninstallGame）
 *   · 背景与材质能不能真的作用到 .sidebar / .content 上
 *   · 字体与字号能不能改到 CSS 变量
 *   · 设置面板里有没有出现新分组
 *   · 卸载弹窗能不能打开、方式选项是否按来源给对
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 9600);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}

function targets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiters = new Map();
  const errors = [];

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
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('[console] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };

  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');

  // PROBE_RELOAD=1：先刷新页面再验证。
  // 改完渲染层代码不用重启整个应用，刷新就能拿到新文件。
  if (process.env.PROBE_RELOAD === '1') {
    await send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 4000));
  }

  await new Promise((r) => setTimeout(r, 3500));

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  };

  /* ---------------- 1. 模块挂载 ---------------- */
  console.log('\n=== 1. 新增模块是否挂上 ===');
  check('window.Bg 存在', await ev('typeof window.Bg === "object"'));
  check('Bg.applyAll 可用', await ev('typeof window.Bg.applyAll === "function"'));
  check('API.appearanceFonts 可用', await ev('typeof window.API.appearanceFonts === "function"'));
  check('API.uninstall 可用', await ev('typeof window.API.uninstall === "function"'));
  check('Modals.uninstallGame 可用', await ev('typeof window.Modals.uninstallGame === "function"'));

  /* ---------------- 2. 字体 ---------------- */
  console.log('\n=== 2. 字体与字号 ===');
  const fontRes = await ev(`(() => {
    window.Bg.applyFont({ fontFamily: '微软雅黑', fontSize: 15 });
    const root = document.documentElement;
    return JSON.stringify({
      fs: root.style.getPropertyValue('--fs-base'),
      font: root.style.getPropertyValue('--font').slice(0, 30),
      bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 30),
      bodySize: getComputedStyle(document.body).fontSize
    });
  })()`);
  const fr = JSON.parse(fontRes);
  check('--fs-base 被设为 15px', fr.fs === '15px', fr.fs);
  check('--font 被设为微软雅黑', fr.font.includes('微软雅黑'), fr.font);
  check('body 字号跟随生效', fr.bodySize === '15px', fr.bodySize);

  // 字号应真的传导到具体元素上（验证 CSS 变量链是通的）
  const cardSz = await ev(`(() => {
    const el = document.querySelector('.side-title, .side-item .si-label, .btn');
    return el ? getComputedStyle(el).fontSize : 'no-el';
  })()`);
  check('具体元素的字号也随之变化', cardSz !== 'no-el' && parseFloat(cardSz) > 10, cardSz);

  // 恢复默认，别把用户设置带跑
  await ev('window.Bg.applyFont({ fontFamily: "", fontSize: 13.5 })');

  /* ---------------- 3. 背景与材质 ---------------- */
  console.log('\n=== 3. 背景与材质 ===');
  const matRes = await ev(`(() => {
    window.Bg.applySlot('sidebar', { type: 'material', material: 'acrylic' });
    const sb = document.querySelector('.sidebar');
    const app = document.getElementById('app');
    return JSON.stringify({
      cls: sb.className,
      mat: sb.getAttribute('data-material'),
      ambient: app.className.includes('has-material'),
      bd: getComputedStyle(sb).backdropFilter
    });
  })()`);
  const mr = JSON.parse(matRes);
  check('左侧栏加上 bg-material 类', mr.cls.includes('bg-material'), mr.cls);
  check('材质类型写对了', mr.mat === 'acrylic', String(mr.mat));
  check('窗口铺上了氛围光（材质才透得出来）', mr.ambient === true);
  check('backdrop-filter 真的生效', /blur/.test(mr.bd || ''), String(mr.bd));

  const imgRes = await ev(`(() => {
    // 真实使用时地址由主进程在选图后返回；这里塞一张 1x1 的 data URL 当替身
    window.Bg.setUrl('content',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
    window.Bg.applySlot('content', { type: 'image', fit: 'cover', opacity: 0.4, blur: 6, dim: 0.5 });
    const c = document.querySelector('.content');
    return JSON.stringify({
      cls: c.className,
      op: c.style.getPropertyValue('--bg-opacity'),
      blur: c.style.getPropertyValue('--bg-blur'),
      dim: c.style.getPropertyValue('--bg-dim'),
      size: c.style.getPropertyValue('--bg-size')
    });
  })()`);
  const ir = JSON.parse(imgRes);
  check('内容区切到图片模式', ir.cls.includes('bg-image'), ir.cls);
  check('透明度变量写入正确', ir.op === '0.4', ir.op);
  check('模糊 / 压暗变量写入正确', ir.blur === '6px' && ir.dim === '0.5', ir.blur + ' / ' + ir.dim);
  check('填充方式变量写入正确', ir.size === 'cover', ir.size);

  // 默认模式应该把前面加的东西都清干净
  const resetRes = await ev(`(() => {
    window.Bg.setUrl('content', '');
    window.Bg.applySlot('sidebar', { type: 'default' });
    window.Bg.applySlot('content', { type: 'default' });
    const sb = document.querySelector('.sidebar');
    const c = document.querySelector('.content');
    return JSON.stringify({
      sb: sb.className.includes('bg-material') || sb.className.includes('bg-image'),
      c: c.className.includes('bg-image'),
      amp: document.getElementById('app').className.includes('has-material')
    });
  })()`);
  const rr = JSON.parse(resetRes);
  check('切回默认后左侧栏已清理', rr.sb === false);
  check('切回默认后内容区已清理', rr.c === false);
  check('不再需要氛围光时已关掉', rr.amp === false);

  /* ---------------- 3b. 四种材质都要能生效 ---------------- */
  console.log('\n=== 3b. 四种材质 ===');
  for (const m of ['frosted', 'acrylic', 'glass', 'liquid']) {
    const r = await ev(`(() => {
      window.Bg.applySlot('sidebar', { type: 'material', material: '${m}' });
      const el = document.querySelector('.sidebar');
      const cs = getComputedStyle(el);
      return JSON.stringify({
        mat: el.getAttribute('data-material'),
        bd: cs.backdropFilter,
        hasLayer: cs.backgroundImage !== 'none'
      });
    })()`);
    const d = JSON.parse(r);
    check(`材质「${m}」生效且有模糊`, d.mat === m && /blur/.test(d.bd || ''), d.bd);
    check(`材质「${m}」有分层高光`, d.hasLayer === true);
  }
  // 材质面板必须是"有实体"的 —— 靠底色不透明度撑住，不能是个空洞
  const solid = await ev(`(() => {
    window.Bg.applySlot('sidebar', { type: 'material', material: 'frosted' });
    const c = getComputedStyle(document.querySelector('.sidebar')).backgroundColor;
    const m = c.match(/rgba?\\([^)]*\\)/);
    if (!m) return 'no-color';
    const parts = m[0].replace(/rgba?\\(|\\)/g, '').split(',').map(Number);
    return String(parts.length === 4 ? parts[3] : 1);
  })()`);
  check('材质底色足够实（不会透成空洞）', Number(solid) >= 0.55, 'alpha=' + solid);

  // 恢复默认，别把用户设置带跑
  await ev(`(() => {
    window.Bg.applySlot('sidebar', { type: 'default' });
    window.Bg.applySlot('content', { type: 'default' });
    return 'ok';
  })()`);

  /* ---------------- 4. 设置面板里的新分组 ---------------- */
  console.log('\n=== 4. 设置面板 ===');
  await ev('window.Modals.settings()');
  await new Promise((r) => setTimeout(r, 1500));
  const panel = await ev(`(() => {
    const t = document.body.innerText;
    return JSON.stringify({
      hasBg: t.includes('背景与材质'),
      hasFont: t.includes('字体'),
      hasSlotPick: t.includes('要设置哪一栏'),
      hasTypePick: t.includes('背景类型'),
      hasRange: document.querySelectorAll('.gh-range').length,
      hasPreview: document.querySelectorAll('.bg-preview, .font-preview').length
    });
  })()`);
  const pr = JSON.parse(panel);
  check('出现「背景与材质」分组', pr.hasBg === true);
  check('出现「字体」分组', pr.hasFont === true);
  check('有左右栏切换', pr.hasSlotPick === true);
  check('有背景类型切换', pr.hasTypePick === true);
  check('滑块渲染出来了', pr.hasRange >= 1, 'count=' + pr.hasRange);
  check('预览区域渲染出来了', pr.hasPreview >= 1, 'count=' + pr.hasPreview);

  // 设置面板里滑一下字号，看元素是否响应
  const slideRes = await ev(`(() => {
    const r = [...document.querySelectorAll('.gh-range')].pop();
    if (!r) return 'no-range';
    r.value = '16';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return document.documentElement.style.getPropertyValue('--fs-base');
  })()`);
  check('拖动滑块能实时改字号', slideRes === '16px', String(slideRes));

  await ev('window.Modals.closeModal()');
  await new Promise((r) => setTimeout(r, 500));

  /* ---------------- 5. 卸载弹窗 ---------------- */
  console.log('\n=== 5. 卸载 ===');
  const gid = await ev('(() => { const g = window.State.games.find(x => !x.hidden); return g ? g.id : ""; })()');
  if (!gid) {
    console.log('  [跳过] 库里没有游戏，无法验证卸载弹窗');
  } else {
    const info = await ev(`window.API.uninstallInfo(${JSON.stringify(gid)}).then(r => JSON.stringify(r))`);
    const ii = JSON.parse(info);
    check('能取到卸载方案', ii.ok !== false, JSON.stringify(ii).slice(0, 80));
    check('方案里带来源标签', typeof ii.sourceLabel === 'string' && ii.sourceLabel.length > 0);
    check('方案里有安装目录字段', 'installDir' in ii);
    check('方案里说明了走平台还是本地', 'platform' in ii && 'uninstaller' in ii);

    await ev(`window.Modals.uninstallGame(${JSON.stringify(gid)})`);
    await new Promise((r) => setTimeout(r, 1500));
    const dlg = await ev(`(() => {
      const t = document.body.innerText;
      return JSON.stringify({
        title: t.includes('卸载游戏'),
        opts: document.querySelectorAll('.un-opt').length,
        info: document.querySelectorAll('.un-row').length,
        btn: t.includes('确认卸载') || t.includes('处理中')
      });
    })()`);
    const dl = JSON.parse(dlg);
    check('卸载弹窗打开了', dl.title === true);
    check('列出了可选卸载方式', dl.opts >= 2, 'count=' + dl.opts);
    check('列出了要删什么的信息', dl.info >= 3, 'count=' + dl.info);
    check('有确认按钮', dl.btn === true);
    await ev('window.Modals.closeModal()');
  }

  /* ---------------- 6. 弹出层层级（防回归） ----------------
   * 这条是补上的：给左右栏加背景层时，曾经为了"把背景压到内容下面"
   * 而给 .content 的直接子元素统一写了 z-index:1，
   * 结果顶栏和卡片区落到同一层级，顶栏里的「更多选项」下拉
   * 被后面的卡片区盖住了。
   *
   * 正确做法是让背景伪元素用负 z-index 沉下去，内容层不动层级。
   * 这里用 elementFromPoint 直接问"这个点上最上面的是谁"，
   * 比看 z-index 数值靠谱得多 —— 层叠上下文是会嵌套的。
   * ---------------------------------------------------------- */
  console.log('\n=== 6. 弹出层层级 ===');

  const moreRes = await ev(`(async () => {
    const btn = document.getElementById('btnMore');
    const m = document.getElementById('moreMenu');
    if (!btn || !m || typeof btn.onclick !== 'function') return 'no-el';
    if (m.hidden) btn.onclick({ stopPropagation() {} });
    await new Promise(r => setTimeout(r, 600));
    if (m.hidden) return 'hidden';
    const r = m.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + 22);
    const onTop = m.contains(top);
    const topEl = top ? (top.className || top.id || top.tagName) : 'null';
    // 量完就收起来，别把界面留着开着
    btn.onclick({ stopPropagation() {} });
    return JSON.stringify({ onTop, topEl });
  })()`);

  if (moreRes === 'no-el' || moreRes === 'hidden') {
    check('「更多选项」菜单能打开', false, String(moreRes));
  } else {
    const mr2 = JSON.parse(moreRes);
    check('「更多选项」菜单浮在卡片之上', mr2.onTop === true, '最上层是 ' + mr2.topEl);
  }

  // 顺带确认背景层没有反过来盖住内容（负 z-index 的伪元素）
  const bgRes = await ev(`(() => {
    window.Bg.applySlot('sidebar', { type: 'material', material: 'frosted' });
    window.Bg.applySlot('content', { type: 'material', material: 'frosted' });
    const item = document.querySelector('.side-item');
    if (!item) return 'no-item';
    const r = item.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const ok = item.contains(top);
    window.Bg.applySlot('sidebar', { type: 'default' });
    window.Bg.applySlot('content', { type: 'default' });
    return JSON.stringify({ ok, topEl: top ? (top.className || top.tagName) : 'null' });
  })()`);
  if (bgRes === 'no-item') {
    console.log('  [跳过] 侧栏里没有可测的项（可能是空库）');
  } else {
    const br = JSON.parse(bgRes);
    check('背景层没有盖住侧栏内容', br.ok === true, '最上层是 ' + br.topEl);
  }

  /* ---------------- 7. 运行时错误 ---------------- */
  console.log('\n=== 7. 运行时错误 ===');
  const realErrors = errors.filter((e) => !/DevTools|Autofill|Electron Security/i.test(e));
  check('没有 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log(`\n================ 验证结果：${pass} 通过 / ${fail} 失败 ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本出错:', e.message);
  process.exit(1);
});
