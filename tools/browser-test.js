/**
 * 内置浏览器服务测试  (tools/browser-test.js)
 *
 * v2 起浏览器改成「主界面导航栏标签页」形态：webview 在渲染层，
 * 主进程这个服务只管 标签注册表 + session 下载钩子。
 * 这里用假 electron（拦截 Module._load）测服务的对外契约：
 *   · open 的协议白名单
 *   · attach 登记的 guest id 怎么用于下载归属反查
 *   · 下载回调怎么变成 setSavePath
 *   · 取消 / 未配置回调的行为
 *   · 事件分发（扁平结构，带 tabId）
 *
 * 之所以测这些：下载接管是这个功能的命脉，setSavePath 用错或归属查错，
 * 表现是"下载了但找不到文件/落错游戏"，界面上很难定位。
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

/** 假 webContents：⚠ Electron 里 WebContents 的 id 是**属性 wc.id**，没有 getId() */
function fakeWC(id) { return { id }; }

class FakeSession {
  constructor() { this.handlers = {}; }
  on(ev, cb) { (this.handlers[ev] || (this.handlers[ev] = [])).push(cb); return this; }
  fire(ev, ...args) { (this.handlers[ev] || []).forEach((cb) => cb({}, ...args)); }
}

const fakeElectron = {
  session: { fromPartition: () => new FakeSession() },
  shell: { openExternal: async () => { } }
};

// 必须在 require('../src/main/browser') 之前拦截
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

const { createBrowserTabs, SESSION_PARTITION } = require('../src/main/browser');

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

async function triggerDownload(svc, item, wc) {
  svc.session.fire('will-download', item, wc);
  await new Promise((r) => setImmediate(r));
}

async function main() {
  console.log('\n=========== 内置浏览器服务测试（标签页形态） ===========\n');

  /* ---------------- 1. 标签生命周期 ---------------- */
  console.log('-- 标签生命周期 --');

  t('open 拒绝 file:// 与自定义协议', () => {
    const svc = createBrowserTabs({});
    assert.strictEqual(svc.open('file:///C:/Windows/notepad.exe').ok, false);
    assert.strictEqual(svc.open('nxm://skyrimse/mods/1').ok, false);
    assert.strictEqual(svc.open('').ok, false);
    assert.strictEqual(svc.list().length, 0, '不该真的建标签');
  });

  t('open 接受 https 并记下 context', () => {
    const svc = createBrowserTabs({});
    const r = svc.open('https://www.nexusmods.com/', {
      title: '给「上古卷轴5」找 MOD',
      context: { gameId: 'g1', gameName: '上古卷轴5' }
    });
    assert.strictEqual(r.ok, true);
    const list = svc.list();
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0].context, { gameId: 'g1', gameName: '上古卷轴5' });
  });

  t('session 用独立分区，且钩子已挂好', () => {
    const svc = createBrowserTabs({});
    assert.strictEqual(SESSION_PARTITION, 'persist:gamehub-browser');
    assert.ok(svc.session.handlers['will-download'], 'will-download 钩子必须初始化时就挂上');
  });

  t('attach 登记 guest id → list/title/update 记账', () => {
    const svc = createBrowserTabs({});
    const r = svc.open('https://example.com/');
    assert.strictEqual(svc.attach(r.id, 777).ok, true);
    assert.strictEqual(svc.attach('nope', 1).ok, false, '不存在的标签要拒绝');
    assert.strictEqual(svc.attach(r.id, NaN).ok, false, '非法 wcId 要拒绝');
    assert.strictEqual(svc.update(r.id, { title: 'Nexus Mods' }).ok, true);
    assert.strictEqual(svc.list()[0].title, 'Nexus Mods');
  });

  t('close(id) 删标签并清掉 guest 映射', () => {
    const svc = createBrowserTabs({});
    const a = svc.open('https://a.example.com/');
    svc.attach(a.id, 42);
    svc.close(a.id);
    assert.strictEqual(svc.list().length, 0);
  });

  t('close() 不传 id 全关', () => {
    const svc = createBrowserTabs({});
    svc.open('https://a.example.com/');
    svc.open('https://b.example.com/');
    svc.close();
    assert.strictEqual(svc.list().length, 0);
  });

  t('navigate 仍受协议白名单约束', () => {
    const svc = createBrowserTabs({});
    const r = svc.open('https://example.com/');
    assert.strictEqual(svc.navigate(r.id, 'file:///x').ok, false);
    assert.strictEqual(svc.navigate(r.id, 'https://other.example.com/').ok, true);
  });

  t('tab-opened / tab-closed 事件上报', () => {
    const evs = [];
    const svc = createBrowserTabs({ onEvent: (e) => evs.push(e) });
    const r = svc.open('https://example.com/');
    svc.close(r.id);
    assert.ok(evs.some((e) => e.type === 'tab-opened' && e.id === r.id));
    assert.ok(evs.some((e) => e.type === 'tab-closed' && e.id === r.id));
  });

  /* ---------------- 2. 下载归属：guest id 反查 ---------------- */
  console.log('-- 下载归属（guest webContents 反查）--');

  await ta('attach 过的 guest → 下载回调拿到正确 context', async () => {
    let got = null;
    const svc = createBrowserTabs({
      onDownload: (info) => { got = info; return { dir: 'D:\\Mods' }; }
    });
    const r = svc.open('https://www.nexusmods.com/', {
      context: { gameId: 'g1', gameName: '上古卷轴5' }
    });
    svc.attach(r.id, 1001);
    await triggerDownload(svc, new FakeItem('a.zip', 'https://x/a'), fakeWC(1001));
    assert.deepStrictEqual(got.context, { gameId: 'g1', gameName: '上古卷轴5' });
    assert.strictEqual(got.tabId, r.id);
    assert.strictEqual(got.filename, 'a.zip');
  });

  await ta('没 attach 过的 guest → context 为 null 但不崩', async () => {
    let got = null;
    const svc = createBrowserTabs({
      onDownload: (info) => { got = info; return { dir: 'D:\\Mods' }; }
    });
    svc.open('https://example.com/');
    await triggerDownload(svc, new FakeItem('a.zip', 'https://x/a'), fakeWC(9999));
    assert.strictEqual(got.context, null);
    assert.strictEqual(got.tabId, null);
  });

  await ta('关掉标签后，同 guest 的下载拿不到 context（映射已清）', async () => {
    let got = null;
    const svc = createBrowserTabs({
      onDownload: (info) => { got = info; return { dir: 'D:\\Mods' }; }
    });
    const r = svc.open('https://example.com/', { context: { gameId: 'g1' } });
    svc.attach(r.id, 55);
    svc.close(r.id);
    await triggerDownload(svc, new FakeItem('a.zip', 'https://x/a'), fakeWC(55));
    assert.strictEqual(got.context, null);
  });

  /* ---------------- 3. 下载落点 ---------------- */
  console.log('-- 下载落点 --');

  await ta('上层给目录 → setSavePath 收到**完整文件路径**', async () => {
    const svc = createBrowserTabs({
      onDownload: () => ({ dir: 'D:\\Games\\Skyrim Special Edition\\Data' })
    });
    const item = new FakeItem('SkyUI.7z', 'https://nexusmods.com/x');
    await triggerDownload(svc, item, fakeWC(1));
    assert.strictEqual(
      item.getSavePath(),
      path.join('D:\\Games\\Skyrim Special Edition\\Data', 'SkyUI.7z'),
      '必须是 目录+文件名，只给目录 Electron 会静默走默认下载路径'
    );
  });

  await ta('异步（Promise）回调也支持', async () => {
    const svc = createBrowserTabs({ onDownload: async () => ({ dir: 'D:\\Picked' }) });
    const item = new FakeItem('mod.zip', 'https://x/m');
    await triggerDownload(svc, item, fakeWC(1));
    assert.strictEqual(item.getSavePath(), path.join('D:\\Picked', 'mod.zip'));
  });

  await ta('上层明确 cancel → 真的取消，不落文件', async () => {
    const svc = createBrowserTabs({ onDownload: () => ({ cancel: true }) });
    const item = new FakeItem('mod.zip', 'https://x/m');
    await triggerDownload(svc, item, fakeWC(1));
    assert.strictEqual(item._cancelled, true);
    assert.strictEqual(item.getSavePath(), '', '取消了就不该设保存路径');
  });

  await ta('上层没配回调 → 交给 Electron 默认流程，**不能顺手取消**', async () => {
    const svc = createBrowserTabs({});
    const item = new FakeItem('mod.zip', 'https://x/m');
    await triggerDownload(svc, item, fakeWC(1));
    assert.strictEqual(item._cancelled, false, '无声无息取消比存错地方更难查');
    assert.strictEqual(item.getSavePath(), '', '不设路径 = Electron 自己弹保存框');
  });

  await ta('上层回调抛异常 → 吞掉不崩', async () => {
    const svc = createBrowserTabs({
      onDownload: () => { throw new Error('boom'); },
      onLog: () => { }
    });
    const item = new FakeItem('mod.zip', 'https://x/m');
    await triggerDownload(svc, item, fakeWC(1));
    assert.ok(true);
  });

  /* ---------------- 4. 下载事件分发 ---------------- */
  console.log('-- 下载事件分发 --');

  await ta('进度 / 完成事件扁平上报，带 tabId', async () => {
    const evs = [];
    const svc = createBrowserTabs({ onEvent: (e) => evs.push(e) });
    const r = svc.open('https://example.com/', { context: { gameId: 'g1' } });
    svc.attach(r.id, 71);
    const item = new FakeItem('mod.zip', 'https://x/m');
    await triggerDownload(svc, item, fakeWC(71));

    evs.length = 0;
    item.emit('updated', {}, 'progressing');
    item.setSavePath('D:\\Mods\\mod.zip');
    item.emit('done', {}, 'completed');

    const prog = evs.find((e) => e.type === 'download');
    assert.ok(prog, '应有 download 进度事件');
    assert.strictEqual(prog.state, 'progressing');
    assert.strictEqual(prog.tabId, r.id, '事件必须带 tabId，渲染层才知道亮哪个标签');
    assert.strictEqual(prog.filename, 'mod.zip');

    const done = evs.find((e) => e.type === 'download-done');
    assert.ok(done, '应有 download-done');
    assert.strictEqual(done.state, 'completed');
    assert.strictEqual(done.savePath, 'D:\\Mods\\mod.zip');
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
