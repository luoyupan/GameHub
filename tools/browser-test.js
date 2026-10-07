/**
 * 内置浏览器服务测试  (tools/browser-test.js)
 *
 * src/main/browser.js 依赖 electron，纯 node 跑不起来。
 * 这里把 electron 换成一个假的（拦截 Module._load），
 * 测的是**服务的对外契约**而不是窗口渲染：
 *   · open 的协议白名单
 *   · 下载回调怎么变成 setSavePath
 *   · 取消下载
 *   · 事件怎么分发（窗口一路、上层一路）
 *   · _idOf 在 <webview> guest 场景下的归属判定
 *
 * 之所以要测这些：下载接管是这个功能的命脉，
 * 一旦 setSavePath 用错（给了目录而不是完整文件路径）或者事件路由错了，
 * 表现是"下载了但找不到文件"，很难从界面上定位。
 *
 * 用法： node tools/browser-test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

/* ================================================================
 *  伪造 electron
 * ================================================================ */

/** 一次下载任务的假 item */
class FakeItem {
  constructor(filename, url) {
    this._filename = filename;
    this._url = url;
    this._savePath = '';
    this._cancelled = false;
    this._handlers = { updated: [], done: [] };
  }
  getFilename() { return this._filename; }
  getURL() { return this._url; }
  getMimeType() { return 'application/zip'; }
  getTotalBytes() { return 1024; }
  getReceivedBytes() { return 1024; }
  getSavePath() { return this._savePath; }
  setSavePath(p) { this._savePath = p; }
  cancel() { this._cancelled = true; }
  on(ev, cb) { (this._handlers[ev] || (this._handlers[ev] = [])).push(cb); return this; }
  once(ev, cb) { return this.on(ev, cb); }
  emit(ev, a, b) { (this._handlers[ev] || []).forEach((cb) => cb(a, b)); }
}

/** 假 webContents */
class FakeWC {
  constructor(win) {
    this.win = win;
    this.sent = [];
    this.handlers = {};
    this.url = '';
  }
  send(ch, payload) { this.sent.push({ ch, payload }); }
  on(ev, cb) { (this.handlers[ev] || (this.handlers[ev] = [])).push(cb); return this; }
  once(ev, cb) { return this.on(ev, cb); }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  /** 网页想开新窗口时的处理器（真实实现里用它把新窗口收敛成同窗口跳转） */
  setWindowOpenHandler(h) { this.windowOpenHandler = h; }
  fire(ev, ...args) { (this.handlers[ev] || []).forEach((cb) => cb({}, ...args)); }
  getOwnerBrowserWindow() { return this.win; }
}

/** 假 BrowserWindow —— 同时登记到 created 列表里方便断言 */
const created = [];
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts || {};
    this.webContents = new FakeWC(this);
    this.destroyed = false;
    this.shown = false;
    this.handlers = {};
    created.push(this);
  }
  on(ev, cb) { (this.handlers[ev] || (this.handlers[ev] = [])).push(cb); return this; }
  once(ev, cb) { return this.on(ev, cb); }
  fire(ev, ...args) { (this.handlers[ev] || []).forEach((cb) => cb(...args)); }
  isDestroyed() { return this.destroyed; }
  /** 注意：loadFile 是**窗口**的方法，不是 webContents 的 */
  loadFile(f) { this.loadedFile = f; return Promise.resolve(); }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  show() { this.shown = true; }
  /** 真实 Electron 里 closed 是异步触发的；这里同步触发，省得测试里等 */
  close() { this.destroyed = true; this.fire('closed'); }
  getTitle() { return this.opts.title || ''; }
  getPosition() { return [0, 0]; }
  getSize() { return [100, 100]; }
  setPosition() { }
}

/** 假 session：记住 will-download 回调，测试里手动触发 */
class FakeSession {
  constructor() { this.handlers = {}; }
  on(ev, cb) { (this.handlers[ev] || (this.handlers[ev] = [])).push(cb); return this; }
  fire(ev, ...args) { (this.handlers[ev] || []).forEach((cb) => cb({}, ...args)); }
}
const fakeElectron = {
  BrowserWindow: FakeBrowserWindow,
  // ⚠ 每个服务拿一个**新的** session：真实环境里不同 partition 本来就是隔开的，
  //   共用一个会让前一个服务注册的 will-download 钩子也被触发，用例之间互相污染
  session: { fromPartition: () => new FakeSession() },
  shell: { openExternal: async () => { } },
  app: { getPath: () => 'C:\\fake' }
};

// 必须在 require('../src/main/browser') 之前拦截
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

const { createBrowserService, SESSION_PARTITION } = require('../src/main/browser');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n      ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n      ${e.message}`); }
}

async function main() {
console.log('\n=========== 内置浏览器服务测试 ===========\n');

/* ---------------- 1. 打开：协议白名单 ---------------- */
console.log('-- 打开窗口 --');

t('拒绝 file:// 协议', () => {
  const svc = createBrowserService({});
  const r = svc.open('file:///C:/Windows/notepad.exe');
  assert.strictEqual(r.ok, false);
  assert.ok(/不支持的地址/.test(r.error), '应提示不支持的地址');
  assert.strictEqual(svc.list().length, 0, '不该真的开窗口');
});

t('拒绝 nxm:// 之类自定义协议', () => {
  const svc = createBrowserService({});
  assert.strictEqual(svc.open('nxm://skyrimse/mods/1/files/2').ok, false);
});

t('拒绝空地址', () => {
  const svc = createBrowserService({});
  assert.strictEqual(svc.open('').ok, false);
});

t('正常 https 能开，并记下 context', () => {
  const svc = createBrowserService({});
  const r = svc.open('https://www.nexusmods.com/', {
    title: '给「上古卷轴5」找 MOD',
    context: { gameId: 'g1', gameName: '上古卷轴5' }
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id, '应返回窗口 id');
  const list = svc.list();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].context, { gameId: 'g1', gameName: '上古卷轴5' });
});

t('开窗口用独立 session 分区', () => {
  const svc = createBrowserService({});
  svc.open('https://example.com/');
  const win = created[created.length - 1];
  assert.strictEqual(win.opts.webPreferences.session, svc.session, '窗口必须挂在浏览器自己的 session 上');
  assert.strictEqual(SESSION_PARTITION, 'persist:gamehub-browser');
  assert.ok(svc.session.handlers['will-download'], 'session 上应已挂好下载钩子');
});

t('webviewTag 必须打开（否则壳里的 <webview> 不生效）', () => {
  const svc = createBrowserService({});
  svc.open('https://example.com/');
  const win = created[created.length - 1];
  assert.strictEqual(win.opts.webPreferences.webviewTag, true);
});

t('网页侧不给 node 能力，且用独立 preload', () => {
  const svc = createBrowserService({});
  svc.open('https://example.com/');
  const wp = created[created.length - 1].opts.webPreferences;
  assert.strictEqual(wp.nodeIntegration, false);
  assert.strictEqual(wp.contextIsolation, true);
  assert.strictEqual(path.basename(wp.preload), 'preload-browser.js',
    '必须用浏览器专用 preload，不能复用主界面那个');
});

/* ---------------- 2. sendTo：预留的推消息口子 ---------------- */
console.log('-- sendTo（预留接口）--');

t('sendTo 能推到指定窗口', () => {
  const svc = createBrowserService({});
  const r = svc.open('https://example.com/');
  const res = svc.sendTo(r.id, 'browser:download-target', { dir: 'D:\\Mods' });
  assert.strictEqual(res.ok, true);
  const win = created[created.length - 1];
  const last = win.webContents.sent[win.webContents.sent.length - 1];
  assert.strictEqual(last.ch, 'browser:download-target');
  assert.strictEqual(last.payload.dir, 'D:\\Mods');
});

t('sendTo 到不存在的窗口要报错而不是抛异常', () => {
  const svc = createBrowserService({});
  const res = svc.sendTo('nope', 'browser:x', {});
  assert.strictEqual(res.ok, false);
});

t('onReady 只在页面就绪后触发（早于此推消息会丢）', () => {
  let readyId = null;
  const svc = createBrowserService({
    onReady: (id) => { readyId = id; }
  });
  const r = svc.open('https://example.com/');
  assert.strictEqual(readyId, null, '刚 open 完还不该触发');
  // 模拟壳页面加载完成
  created[created.length - 1].webContents.fire('did-finish-load');
  assert.strictEqual(readyId, r.id, 'did-finish-load 之后应触发');
  assert.strictEqual(created[created.length - 1].shown, true, '同时把窗口显示出来');
});

/* ---------------- 3. 下载接管 ---------------- */
console.log('-- 下载接管（这个功能的核心）--');

async function triggerDownload(svc, item, wc) {
  svc.session.fire('will-download', item, wc);
  // 让 Promise 形态的回调有机会 resolve
  await new Promise((r) => setImmediate(r));
}

await ta('上层给了目录 → setSavePath 收到**完整文件路径**', async () => {
  const svc = createBrowserService({
    onDownload: () => ({ dir: 'D:\\Games\\Skyrim Special Edition\\Data' })
  });
  const r = svc.open('https://www.nexusmods.com/', { context: { gameId: 'g1' } });
  const wc = created[created.length - 1].webContents;
  const item = new FakeItem('SkyUI.7z', 'https://nexusmods.com/x');
  await triggerDownload(svc, item, wc);
  assert.strictEqual(
    item.getSavePath(),
    path.join('D:\\Games\\Skyrim Special Edition\\Data', 'SkyUI.7z'),
    '必须是 目录+文件名，只给目录 Electron 会静默走默认下载路径'
  );
  assert.ok(r.id);
});

await ta('回调能拿到 gameId 上下文（否则不知道该给哪个游戏）', async () => {
  let got = null;
  const svc = createBrowserService({
    onDownload: (info) => { got = info; return { dir: 'D:\\Mods' }; }
  });
  svc.open('https://www.nexusmods.com/', { context: { gameId: 'g1', gameName: '上古卷轴5' } });
  const wc = created[created.length - 1].webContents;
  await triggerDownload(svc, new FakeItem('a.zip', 'https://x/a'), wc);
  assert.deepStrictEqual(got.context, { gameId: 'g1', gameName: '上古卷轴5' });
  assert.strictEqual(got.filename, 'a.zip');
});

await ta('异步（Promise）回调也支持 —— 「每次问我」要弹对话框', async () => {
  const svc = createBrowserService({
    onDownload: async () => ({ dir: 'D:\\Picked\\By\\User' })
  });
  svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  const item = new FakeItem('mod.zip', 'https://x/m');
  await triggerDownload(svc, item, wc);
  assert.strictEqual(item.getSavePath(), path.join('D:\\Picked\\By\\User', 'mod.zip'));
});

await ta('上层返回 cancel → 真的取消，不落文件', async () => {
  const svc = createBrowserService({ onDownload: () => ({ cancel: true }) });
  svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  const item = new FakeItem('mod.zip', 'https://x/m');
  await triggerDownload(svc, item, wc);
  assert.strictEqual(item._cancelled, true);
  assert.strictEqual(item.getSavePath(), '', '取消了就不该设保存路径');
});

await ta('上层没配任何回调 → 不崩，走 Electron 默认行为', async () => {
  const svc = createBrowserService({});
  svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  const item = new FakeItem('mod.zip', 'https://x/m');
  await triggerDownload(svc, item, wc);
  // 没给目录时不强行指定，交给默认「每次询问」
  assert.strictEqual(item.getSavePath(), 'mod.zip');
});

await ta('上层回调抛异常 → 吞掉不崩，不至于让整个浏览器挂掉', async () => {
  const svc = createBrowserService({
    onDownload: () => { throw new Error('boom'); },
    onLog: () => { }
  });
  svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  const item = new FakeItem('mod.zip', 'https://x/m');
  await triggerDownload(svc, item, wc);
  assert.ok(true);
});

/* ---------------- 4. 下载事件分发 ---------------- */
console.log('-- 下载事件分发 --');

await ta('进度事件同时推给窗口和上层', async () => {
  const upper = [];
  const svc = createBrowserService({ onEvent: (e) => upper.push(e) });
  svc.open('https://example.com/');
  const win = created[created.length - 1];
  const wc = win.webContents;
  const item = new FakeItem('mod.zip', 'https://x/m');
  await triggerDownload(svc, item, wc);

  upper.length = 0;
  win.webContents.sent.length = 0;
  item.emit('updated', {}, 'progressing');

  assert.strictEqual(upper.length, 1, '上层应收到一条');
  assert.strictEqual(upper[0].type, 'download');
  assert.strictEqual(upper[0].download.state, 'progressing');
  const pushed = win.webContents.sent.filter((s) => s.ch === 'browser:download');
  assert.strictEqual(pushed.length, 1, '窗口自己也该收到进度（画进度条）');
});

await ta('完成事件带 completed 状态，且从 downloadList 里查得到', async () => {
  const upper = [];
  const svc = createBrowserService({ onEvent: (e) => upper.push(e) });
  svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  const item = new FakeItem('mod.zip', 'https://x/m');
  await triggerDownload(svc, item, wc);

  upper.length = 0;
  item.setSavePath('D:\\Mods\\mod.zip');
  item.emit('done', {}, 'completed');

  const done = upper.find((e) => e.type === 'download-done');
  assert.ok(done, '应有一条 download-done');
  assert.strictEqual(done.download.state, 'completed');
  assert.strictEqual(done.download.savePath, 'D:\\Mods\\mod.zip');
  assert.strictEqual(svc.downloadList().length, 1);
});

/* ---------------- 5. _idOf：<webview> guest 归属 ---------------- */
console.log('-- 窗口归属判定（webview guest 的坑）--');

t('guest webContents 通过 did-attach-webview 登记后可反查', () => {
  const svc = createBrowserService({});
  const r = svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  const guest = new FakeWC(null);
  wc.fire('did-attach-webview', guest);
  assert.strictEqual(svc._idOf(guest), r.id);
});

t('宿主 webContents 能直接反查', () => {
  const svc = createBrowserService({});
  const r = svc.open('https://example.com/');
  const wc = created[created.length - 1].webContents;
  assert.strictEqual(svc._idOf(wc), r.id);
});

t('只有一个窗口时，陌生 guest 也能兜底归属', () => {
  const svc = createBrowserService({});
  const r = svc.open('https://example.com/');
  const stranger = new FakeWC(null);
  assert.strictEqual(svc._idOf(stranger), r.id);
});

t('多个窗口且 guest 未登记 → 返回 null（不瞎猜，丢给上层）', () => {
  const svc = createBrowserService({});
  svc.open('https://a.example.com/');
  svc.open('https://b.example.com/');
  const stranger = new FakeWC(null);
  assert.strictEqual(svc._idOf(stranger), null);
});

t('传 null 不抛异常', () => {
  const svc = createBrowserService({});
  svc.open('https://example.com/');
  assert.strictEqual(svc._idOf(null), null);
});

/* ---------------- 6. 生命周期 ---------------- */
console.log('-- 生命周期 --');

t('navigate 仍受协议白名单约束', () => {
  const svc = createBrowserService({});
  const r = svc.open('https://example.com/');
  assert.strictEqual(svc.navigate(r.id, 'file:///x').ok, false);
  assert.strictEqual(svc.navigate(r.id, 'https://other.example.com/').ok, true);
});

t('close(id) 关掉指定窗口', () => {
  const svc = createBrowserService({});
  const a = svc.open('https://a.example.com/');
  const b = svc.open('https://b.example.com/');
  const winA = svc.windows.get(a.id).win;
  assert.strictEqual(svc.close(a.id).ok, true);
  assert.strictEqual(winA.isDestroyed(), true);
  assert.strictEqual(svc.list().length, 1);
  assert.strictEqual(svc.list()[0].id, b.id);
});

t('close() 不传 id 就全关', () => {
  const svc = createBrowserService({});
  svc.open('https://a.example.com/');
  svc.open('https://b.example.com/');
  svc.close();
  assert.strictEqual(svc.list().length, 0);
});

t('destroy 清空所有状态', () => {
  const svc = createBrowserService({});
  svc.open('https://a.example.com/');
  svc.destroy();
  assert.strictEqual(svc.list().length, 0);
  assert.strictEqual(svc.downloadList().length, 0);
});

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(50));
console.log(`结果：通过 ${pass}，失败 ${fail}`);
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
console.log('='.repeat(50) + '\n');
process.exitCode = fail ? 1 : 0;
}

main();
