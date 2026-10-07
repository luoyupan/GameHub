/**
 * ============================================================
 *  GameHub - 内置浏览器服务·内嵌标签页形态  (src/main/browser.js)
 * ------------------------------------------------------------
 *  【本文件的历史】
 *    v1 是「独立弹窗」形态：点「N 网找找」弹一个带自绘工具条的
 *    BrowserWindow。实际用下来主人的反馈很直接 —— 不要额外弹窗，
 *    要集合到主界面顶部导航栏里。所以重构成 v2：
 *
 *    · 窗口没了，webview 由**渲染层**（browserview.js）创建和管理
 *    · 这里只保留三件渲染层做不了的事：
 *        1) 独立 session 分区（登录态 / 缓存隔离）
 *        2) will-download 下载接管（决定每个文件落到哪个 MOD 目录）
 *        3) 标签注册表（哪个 webview 属于哪个标签、带着什么上下文）
 *
 *  【为什么下载必须留在主进程】
 *    will-download 只有 session 能挂；而"存到哪"要查设置、查
 *    MOD 目录规则、必要时弹系统对话框 —— 这些全是主进程能力。
 *
 *  【归属映射的坑】
 *    下载是从 <webview> 的 guest webContents 发起的，跟主窗口的
 *    webContents 不是同一个对象。渲染层在 webview 挂上后会调
 *    attach(tabId, wcId) 把「guest 的 webContents id → 标签」登记进来，
 *    下载发生时按 wc.getId() 反查 —— 不登记就找不到这条下载该给谁。
 * ============================================================
 */
'use strict';

const { session, shell, app } = require('electron');

/** 独立 session 分区：跟主界面分开，免得污染主界面的登录态 / 缓存。
 *  ⚠ 渲染层 webview 的 partition 属性必须写同一个值，两边对不上下载钩子就收不到。 */
const SESSION_PARTITION = 'persist:gamehub-browser';

/* ================================================================
 *  Cloudflare 人机验证「过不去」的问题
 * ------------------------------------------------------------
 *  现象：N 网点开就卡在 "Just a moment..." / Turnstile 转圈，永远不放行。
 *
 *  根因（用 tools/dev/cf-probe.js 实测出来的，不是猜的）：
 *    我们把 UA 清洗成了普通 Chrome（去掉 Electron 尾巴，躲 Cloudflare 对
 *    Electron UA 的发难），但 Electron 发出的 Client Hints 还是自己的：
 *
 *      navigator.userAgentData.brands =
 *        [ {Not?A_Brand,99}, {Chromium,130} ]        ← 没有 Google Chrome
 *      sec-ch-ua: "Not?A_Brand";v="99", "Chromium";v="130"
 *      User-Agent: ... Chrome/130.0.6723.191 ...     ← 却自称 Chrome
 *
 *    "自称 Chrome 但 brands 里没有 Google Chrome" —— 这个不自洽正是
 *    Cloudflare 判定「伪装浏览器 / 自动化」的强特征，于是 challenge 不给过。
 *
 *  修法：两头都补成自洽的 Chrome，版本号统一取自 process.versions.chrome，
 *    免得 UA 与 Client Hints 各说各话：
 *    ① HTTP 请求头：webRequest.onBeforeSendHeaders 补 sec-ch-ua 系列
 *    ② 页面 JS：走 CDP 在**主世界**、页面任何脚本之前覆盖 userAgentData
 *       （preload 是隔离世界，改不到页面的 navigator，必须用 CDP）
 * ================================================================ */

/** Chromium 版本：UA / Client Hints 全用它，保证一致 */
const CHROME_FULL = (process.versions && process.versions.chrome) || '130.0.0.0';
const CHROME_MAJOR = String(CHROME_FULL).split('.')[0];

/** 请求头：大小写不敏感地覆盖（HTTP/2 下头名全小写，直接赋值会重复） */
function setHeader(h, name, value) {
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name.toLowerCase() && k !== name) delete h[k];
  }
  h[name] = value;
}

/**
 * 主世界注入脚本：让页面 JS 读到的 userAgentData / languages 与 UA 自洽。
 * 只在 guest（webview）里跑，不动主界面。
 */
function stealthScript() {
  return `(function () {
  var full = '${CHROME_FULL}';
  var major = '${CHROME_MAJOR}';
  var brands = [
    { brand: 'Not?A_Brand', version: '99' },
    { brand: 'Google Chrome', version: major },
    { brand: 'Chromium', version: major }
  ];
  var fullList = [
    { brand: 'Not?A_Brand', version: '99.0.0.0' },
    { brand: 'Google Chrome', version: full },
    { brand: 'Chromium', version: full }
  ];
  var uaData = {
    brands: brands,
    mobile: false,
    platform: 'Windows',
    architecture: 'x86',
    bitness: '64',
    getHighEntropyValues: function (hints) {
      var pool = {
        brands: fullList, mobile: false, platform: 'Windows',
        architecture: 'x86', bitness: '64', uaFullVersion: full,
        fullVersionList: fullList, model: '', platformVersion: '15.0.0', wow64: false
      };
      var out = {};
      for (var i = 0; i < (hints || []).length; i++) {
        var k = hints[i];
        if (Object.prototype.hasOwnProperty.call(pool, k)) out[k] = pool[k];
      }
      return Promise.resolve(out);
    },
    toJSON: function () {
      return { brands: brands, mobile: false, platform: 'Windows' };
    }
  };
  try {
    Object.defineProperty(navigator, 'userAgentData', {
      get: function () { return uaData; }, configurable: true
    });
  } catch (e) { }
  // Electron 默认只有 zh-CN,zh-Hans-CN，真实 Chrome 的列表更长
  try {
    Object.defineProperty(navigator, 'languages', {
      get: function () { return ['zh-CN', 'zh', 'en-US', 'en']; }, configurable: true
    });
  } catch (e) { }
})();`;
}

class BrowserTabsService {
  /**
   * @param {object} opts
   * @param {Function} [opts.onLog]
   * @param {Function} [opts.onEvent]   统一事件出口，主进程转发给渲染层
   * @param {Function} [opts.onDownload] 下载回调，返回 {dir} 或 {cancel:true}
   */
  constructor(opts = {}) {
    this.log = opts.onLog || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onDownload = opts.onDownload || null;

    /** 标签注册表：tabId → { id, url, title, context, createdAt } */
    this.tabs = new Map();
    /** guest webContents id → tabId（下载归属反查用） */
    this._wcMap = new Map();
    this._seq = 0;

    this.session = session.fromPartition(SESSION_PARTITION);
    this._installDownloadHooks();
    this._installStealthHeaders();
    this._installStealthScript();
  }

  /**
   * ① 请求头层：把 Client Hints 补成与 UA 自洽的 Chrome。
   * Electron 自己发的 sec-ch-ua 缺 "Google Chrome" 品牌 —— 而 UA 又自称
   * Chrome，两者打架，Cloudflare 一眼识破。这里统一按 process.versions.chrome 补。
   */
  _installStealthHeaders() {
    const brands = `"Not?A_Brand";v="99", "Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}"`;
    const fullList = `"Not?A_Brand";v="99.0.0.0", "Google Chrome";v="${CHROME_FULL}", "Chromium";v="${CHROME_FULL}"`;
    try {
      this.session.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = Object.assign({}, details.requestHeaders || {});
        setHeader(h, 'sec-ch-ua', brands);
        setHeader(h, 'sec-ch-ua-mobile', '?0');
        setHeader(h, 'sec-ch-ua-platform', '"Windows"');
        setHeader(h, 'sec-ch-ua-arch', '"x86"');
        setHeader(h, 'sec-ch-ua-bitness', '"64"');
        setHeader(h, 'sec-ch-ua-full-version', `"${CHROME_FULL}"`);
        setHeader(h, 'sec-ch-ua-full-version-list', fullList);
        // Electron 的 Accept-Language 只有 zh-CN,zh-Hans-CN，补成常见浏览器的样子
        if (!h['accept-language'] && !h['Accept-Language']) {
          setHeader(h, 'accept-language', 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
        }
        cb({ requestHeaders: h });
      });
    } catch (e) {
      this.log(`[browser] Client Hints 头注入失败：${e && e.message}`);
    }
  }

  /**
   * ② 页面 JS 层：在主世界覆盖 navigator.userAgentData。
   * ⚠ 必须用 CDP 的 addScriptToEvaluateOnNewDocument —— preload 跑在
   *   隔离世界，改不到页面自己的 navigator；而这段必须在页面任何脚本
   *   （Cloudflare 的 challenge 脚本就是其中之一）之前生效。
   */
  _installStealthScript() {
    const src = stealthScript();
    const inject = (wc) => {
      try {
        if (wc.isDestroyed()) return;
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        wc.debugger.sendCommand('Page.enable')
          .then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: src }))
          .catch(() => { /* 失败就退化成只改了头，不影响浏览 */ });
      } catch { /* 同上，静默降级 */ }
    };

    try {
      app.on('web-contents-created', (_e, wc) => {
        // guest 是异步挂上来的，晚一点才能拿到 type
        setTimeout(() => {
          if (wc.isDestroyed()) return;
          let t = '';
          try { t = wc.getType(); } catch { return; }
          if (t !== 'webview') return;   // 只处理内嵌浏览器的 guest，不动主界面
          inject(wc);
        }, 80);
      });
    } catch (e) {
      this.log(`[browser] userAgentData 注入失败：${e && e.message}`);
    }
  }

  /* ================================================================
   *  一、对外接口
   * ================================================================ */

  /**
   * 登记一个新标签。
   * ⚠ 只建记录、不建窗口 —— webview 是渲染层建的。
   * @param {string} url
   * @param {{title?:string, context?:object}} [opts]
   * @returns {{ok:boolean, id?:string, url?:string, error?:string}}
   */
  open(url, opts = {}) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: `不支持的地址：${target}` };

    const id = 'bt' + (++this._seq);
    this.tabs.set(id, {
      id,
      url: target,
      title: opts.title || '',
      context: opts.context || null,
      createdAt: Date.now()
    });
    this.onEvent({ type: 'tab-opened', id, url: target });
    return { ok: true, id, url: target };
  }

  /**
   * 渲染层报告：这个标签的 webview 已经挂上来了。
   * 把 guest webContents 的 id 登记进来，下载时才知道该给哪个标签。
   */
  attach(tabId, wcId) {
    const rec = this.tabs.get(tabId);
    const n = Number(wcId);
    if (!rec || !Number.isFinite(n)) return { ok: false, error: '参数不对' };
    this._wcMap.set(n, tabId);
    return { ok: true };
  }

  /** 让某个标签跳转（协议白名单照旧，file:// 之类一律不放行） */
  navigate(tabId, url) {
    const rec = this.tabs.get(tabId);
    if (!rec) return { ok: false, error: '标签不存在' };
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '不支持的地址' };
    rec.url = url;
    this.onEvent({ type: 'navigated', id: tabId, url });
    return { ok: true };
  }

  /**
   * 把用户在系统浏览器里拿到的验证 Cookie（主要是 Cloudflare 的 cf_clearance）
   * 写进内嵌浏览器的 session。
   *
   * 为什么要有这条路：Cloudflare 的人机验证在内嵌浏览器里就是过不去
   * （Electron 的自动化特征它认得 —— 见上面 Client Hints 那段实测），
   * 但用户自己的 Chrome / Edge 一定能过。过完把那张通行证搬过来，
   * 内嵌浏览器就能直接进站，下载接管 / MOD 自动落位也就还能用上。
   *
   * @param {string} url 当前页面地址（用它推 domain）
   * @param {string} raw 粘贴内容：单条 cf_clearance=xxx、整串 Cookie 头都行
   */
  async setCookie(url, raw) {
    let u = null;
    try { u = /^https?:\/\//i.test(String(url || '')) ? new URL(String(url)) : null; } catch { u = null; }
    if (!u) return { ok: false, error: '先打开站点再贴 Cookie' };

    const text = String(raw || '').trim();
    if (!text) return { ok: false, error: 'Cookie 是空的' };

    /* 用户常把整串 Cookie 头连控制属性一起复制进来，这些不是 cookie 本体 */
    const SKIP = /^(path|domain|expires|max-age|secure|httponly|samesite|priority|partitioned)$/i;
    const names = [];
    for (const seg of text.split(/[;\n]/)) {
      const i = seg.indexOf('=');
      if (i < 0) continue;
      const name = seg.slice(0, i).trim();
      const value = seg.slice(i + 1).trim();
      if (!name || SKIP.test(name)) continue;
      try {
        await this.session.cookies.set({
          url: u.origin,
          name,
          value,
          sameSite: 'no_restriction'
        });
        names.push(name);
      } catch { /* 单条失败不影响其它条 */ }
    }
    if (!names.length) return { ok: false, error: '没解析出可用的 Cookie' };
    this.log(`[browser] 写入验证 Cookie：${names.join(', ')}`);
    return { ok: true, names };
  }

  /** 渲染层上报地址 / 标题变化（webview 的导航事件渲染层自己收得到，这里只是记账） */
  update(tabId, patch = {}) {
    const rec = this.tabs.get(tabId);
    if (!rec) return { ok: false };
    if (typeof patch.url === 'string' && patch.url) rec.url = patch.url;
    if (typeof patch.title === 'string') rec.title = patch.title;
    return { ok: true };
  }

  /** 关一个标签（不传 id 关全部） */
  close(tabId) {
    if (!tabId) {
      for (const id of [...this.tabs.keys()]) this.close(id);
      return { ok: true, closed: 'all' };
    }
    const rec = this.tabs.get(tabId);
    if (!rec) return { ok: false, error: '标签不存在' };
    // 顺手清掉它的 webContents 映射，别留悬空引用
    for (const [wcId, tid] of [...this._wcMap.entries()]) {
      if (tid === tabId) this._wcMap.delete(wcId);
    }
    this.tabs.delete(tabId);
    this.onEvent({ type: 'tab-closed', id: tabId });
    return { ok: true };
  }

  /** 当前标签快照 */
  list() {
    return [...this.tabs.values()].map((r) => ({
      id: r.id, url: r.url, title: r.title, context: r.context
    }));
  }

  /** 关掉服务（退出时调用） */
  destroy() {
    this.close();
    this._wcMap.clear();
  }

  /* ================================================================
   *  二、下载接管 —— 这个功能的价值所在
   * ================================================================ */

  _installDownloadHooks() {
    this.session.on('will-download', (_e, item, wc) => {
      const filename = item.getFilename() || 'download';
      const url = item.getURL();

      // 反查这条下载来自哪个标签（拿 context 里的 gameId 决定落点）。
      // ⚠ 踩坑：WebContents 的 id 是**属性 wc.id**，没有 getId() 方法 ——
      //   调 getId() 会抛 TypeError，被 try 吞掉后归属永远查不到，
      //   表现就是「下载被莫名其妙取消 / 落错地方」。三层防御：
      //   wc.id → item.getWebContents().id → null。
      //   拿不到归属时 onDownload 收到 tabId=null，上层退化成询问，绝不硬猜。
      let wcId = null;
      try { wcId = wc && typeof wc.id === 'number' ? wc.id : null; } catch { }
      if (wcId == null && item && typeof item.getWebContents === 'function') {
        try { const g = item.getWebContents(); wcId = g && typeof g.id === 'number' ? g.id : null; }
        catch { /* 忽略 */ }
      }
      let tabId = wcId != null ? (this._wcMap.get(wcId) || null) : null;
      const rec = tabId ? this.tabs.get(tabId) : null;

      const dlId = 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const pub = {
        id: dlId,
        tabId,
        filename,
        url,
        savePath: '',
        state: 'pending',
        received: 0,
        total: item.getTotalBytes() || 0,
        mime: item.getMimeType() || '',
        startedAt: Date.now()
      };

      let decided = null;
      if (this.onDownload) {
        try {
          decided = this.onDownload({
            filename, url, mime: pub.mime, totalBytes: pub.total,
            tabId,
            context: rec ? rec.context : null
          });
        } catch (e) {
          this.log('决定下载位置时出错：' + (e.message || e));
        }
      }

      const apply = (d) => {
        // ⚠ 只有**明确**返回 cancel 才取消。
        //   上层压根没配回调时不能顺手取消 —— 下载无声消失比存错地方更难查。
        if (d && d.cancel) {
          try { item.cancel(); } catch { /* 忽略 */ }
          pub.state = 'cancelled';
          this._fire('download', pub);
          return;
        }
        const dir = d ? String(d.dir || '').trim() : '';
        if (dir) {
          // setSavePath 必须给完整文件路径，只给目录会静默走默认下载路径
          const full = require('path').join(dir, filename);
          item.setSavePath(full);
          pub.savePath = full;
        }
      };

      if (decided && typeof decided.then === 'function') {
        decided.then(apply).catch(() => { /* 回调挂了就走默认，别取消 */ });
      } else {
        apply(decided);
      }

      item.on('updated', (_s, state) => {
        pub.received = item.getReceivedBytes();
        pub.total = item.getTotalBytes() || pub.total;
        pub.state = state === 'progressing' ? 'progressing'
          : state === 'interrupted' ? 'interrupted' : state;
        this._fire('download', pub);
      });

      item.once('done', (_s, state) => {
        pub.state = state === 'completed' ? 'completed'
          : state === 'cancelled' ? 'cancelled' : 'failed';
        pub.savePath = item.getSavePath() || pub.savePath;
        pub.received = item.getReceivedBytes();
        this._fire('download-done', pub);
        this.log(`下载${pub.state === 'completed' ? '完成' : '结束（' + pub.state + '）'}：${filename}`);
      });
    });
  }

  /** 统一事件出口 */
  _fire(type, payload) {
    this.onEvent(Object.assign({ type }, payload));
  }
}

/**
 * 建一个浏览器标签服务。
 * 想换实现（比如以后真要弹独立窗口），换掉这个工厂里的类即可，调用方不用动。
 */
function createBrowserTabs(opts = {}) {
  return new BrowserTabsService(opts);
}

module.exports = {
  createBrowserTabs,
  BrowserTabsService,
  SESSION_PARTITION,
  /* 导出版本号：测试要拿它比对 sec-ch-ua 是否和 UA 自洽
     （纯 Node 下 process.versions.chrome 不存在，不能直接引用） */
  CHROME_FULL,
  CHROME_MAJOR
};
