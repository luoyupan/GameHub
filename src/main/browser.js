/**
 * ============================================================
 *  GameHub - 内置浏览器服务  (src/main/browser.js)
 * ------------------------------------------------------------
 *  在软件内部开一个浏览器窗口，用它在 N 网（Nexus Mods）之类的站点上
 *  浏览、登录、下载 MOD —— 下载会被 GameHub 接管，
 *  按 MOD 目录规则直接落到对应游戏的 MOD 文件夹里。
 *
 *  ── 为什么要内置，而不是丢给系统浏览器 ──────────────────────
 *    系统浏览器下载下来的文件落在「下载」目录，用户还得自己找、
 *    自己解压、自己判断该放哪个游戏的哪个子目录 —— 
 *    而 MOD 放错目录**不会报错，只会静默失效**，这是最折腾人的地方。
 *    内置浏览器能接管下载，一步到位。
 *
 *    顺带还有个好处：Electron 就是 Chromium，N 网给免费用户的
 *    「断点续传」特性在 Chromium 内核下支持最好。
 *
 *  ── 为什么要抽象成「服务」而不是直接 new 一个窗口 ────────────
 *    这个模块刻意把「开窗口」和「用浏览器」分开：
 *      上层只调 open() / 订阅事件，不关心底层是一个独立窗口、
 *      一个内嵌视图（WebContentsView）还是一组标签页。
 *    目的就是**给后续改造留口子**：
 *      · 想做成主界面里的内嵌标签页 → 换掉 createView 就行
 *      · 想加「在新标签打开」→ open() 返回 handle，自己管
 *      · 想加拦截 / 脚本注入 / 站点适配 → 改 installHooks
 *    上层代码一行都不用动。
 *
 *  ⚠ 安全边界：页面一律 nodeIntegration:false + contextIsolation:true，
 *    并且用**独立的 preload**（preload-browser.js），
 *    不给网页任何主进程能力，只能走我们定义的那几个通道。
 * ============================================================
 */
'use strict';

const path = require('path');
const { BrowserWindow, session, shell, app } = require('electron');

/** 浏览器窗口用的独立 session，和主界面分开，免得污染主界面的登录态 / 缓存 */
const SESSION_PARTITION = 'persist:gamehub-browser';

class BrowserService {
  /**
   * @param {object} opts
   * @param {object} [opts.parent]      父窗口（用于居中与模态感）
   * @param {Function} [opts.onLog]
   * @param {Function} [opts.onEvent]   统一事件出口，便于上层转发给渲染层
   * @param {Function} [opts.onDownload] 下载回调，返回保存目录（或 'cancel'）
   */
  constructor(opts = {}) {
    this.parent = opts.parent || null;
    this.log = opts.onLog || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onDownload = opts.onDownload || null;
    /**
     * 窗口页面就绪回调 —— 预留口子。
     * 想在主进程侧往浏览器界面推初始化信息（下载目标、工具栏状态、
     * 站点适配脚本等），都在这个时机推，早于此时的消息会丢失。
     * @type {(id:string, rec:object)=>void}
     */
    this.onReady = opts.onReady || (() => {});

    /** 已打开的窗口：id → { win, url, title, createdAt } */
    this.windows = new Map();
    /** <webview> 的 guest webContents → 窗口 id（下载要按它找回归属窗口） */
    this._guests = new WeakMap();
    this._seq = 0;

    /** 下载记录：id → { filename, url, savePath, state, received, total } */
    this.downloads = new Map();

    this.session = session.fromPartition(SESSION_PARTITION);
    this._installDownloadHooks();
  }

  /* ================================================================
   *  一、对外主接口（后续扩展都从这里长出来）
   * ================================================================ */

  /**
   * 打开一个浏览器窗口。
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {string} [opts.title]     窗口标题（默认取网页标题）
   * @param {object} [opts.context]   附加上下文（比如 { gameId }），回调时会原样带回
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @returns {{ok:boolean, id?:string, error?:string}}
   */
  open(url, opts = {}) {
    const target = String(url || '').trim();
    if (!target) return { ok: false, error: '没有地址' };
    // 只放行 http/https —— 别让人拿它去开 file:// 或者乱七八糟的协议
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: `不支持的地址：${target}` };

    const id = 'bw' + (++this._seq);
    try {
      const win = this._createWindow(id, target, opts);
      this.windows.set(id, {
        win,
        url: target,
        title: opts.title || '',
        context: opts.context || null,
        createdAt: Date.now()
      });
      this._attachWindowEvents(id, win);
      this.onEvent({ type: 'opened', id, url: target });
      return { ok: true, id };
    } catch (e) {
      this.log('内置浏览器开窗口失败：' + (e.message || e));
      return { ok: false, error: e.message || String(e) };
    }
  }

  /** 关闭一个窗口（不传 id 就关全部） */
  close(id) {
    if (!id) {
      for (const k of [...this.windows.keys()]) this.close(k);
      return { ok: true, closed: 'all' };
    }
    const rec = this.windows.get(id);
    if (!rec) return { ok: false, error: '窗口不存在' };
    try { if (!rec.win.isDestroyed()) rec.win.close(); } catch { /* 已关就算了 */ }
    return { ok: true, id };
  }

  /**
   * 往某个浏览器窗口的界面层推一条消息。
   *
   * ── 预留接口 ──────────────────────────────────────────────
   *  这是主进程主动影响浏览器界面的**唯一通道**。
   *  以后要加东西（换下载目标、注入脚本、推通知、改工具栏状态），
   *  都走这里，浏览器那边在 preload 上多注册一个监听即可，
   *  不用再开新的 IPC 通道，也不用动窗口创建逻辑。
   *
   * @param {string} id
   * @param {string} channel  'browser:download-target' 之类
   * @param {*}      payload
   */
  sendTo(id, channel, payload) {
    const rec = this.windows.get(id);
    if (!rec || !rec.win || rec.win.isDestroyed()) return { ok: false, error: '窗口不存在' };
    try {
      rec.win.webContents.send(channel, payload);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  /** 让某个窗口跳转 */
  navigate(id, url) {
    const rec = this.windows.get(id);
    if (!rec || rec.win.isDestroyed()) return { ok: false, error: '窗口不存在' };
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '不支持的地址' };
    rec.win.webContents.loadURL(url).catch((e) => this.log('跳转失败：' + e.message));
    return { ok: true };
  }

  /** 列出当前打开的窗口（给界面做"已打开的页面"列表用） */
  list() {
    return [...this.windows.entries()].map(([id, r]) => ({
      id,
      url: r.url,
      title: r.title || (r.win && !r.win.isDestroyed() ? r.win.getTitle() : ''),
      context: r.context
    }));
  }

  /** 当前下载任务快照 */
  downloadList() {
    return [...this.downloads.values()];
  }

  /** 把某个下载任务取消 */
  cancelDownload(downloadId) {
    const d = this.downloads.get(downloadId);
    if (!d || !d.item) return { ok: false, error: '没有这个下载' };
    try { d.item.cancel(); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true };
  }

  /** 关掉服务（退出时调用） */
  destroy() {
    this.close();
    this.windows.clear();
    this.downloads.clear();
  }

  /* ================================================================
   *  二、窗口内部实现
   *  ⚠ 想换成「内嵌到主界面」的标签页形态，主要就是改这里：
   *    把 BrowserWindow 换成 WebContentsView，再挂到主窗口上即可，
   *    上面那套 open/close/navigate 接口不用动。
   * ================================================================ */

  _createWindow(id, url, opts = {}) {
    const parent = this.parent && !this.parent.isDestroyed() ? this.parent : null;

    const win = new BrowserWindow({
      width: opts.width || 1180,
      height: opts.height || 780,
      minWidth: 720,
      minHeight: 480,
      parent: parent || undefined,
      // 不用系统标题栏：GameHub 主界面是自绘的，这里保持一致，
      // 顺便在顶部留出放地址栏和"下载到 xxx"提示的位置
      frame: false,
      backgroundColor: '#0e1420',
      title: opts.title || 'GameHub 浏览器',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
      show: false,
      webPreferences: {
        // ⚠ 安全：独立 preload，网页拿不到任何主进程能力
        preload: path.join(__dirname, '..', '..', 'preload-browser.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        session: this.session,
        // 壳页面里要用 <webview> 承载真实网页，不开这个标签就用不了
        webviewTag: true,
        spellcheck: false
      }
    });

    win.loadFile(path.join(__dirname, '..', 'renderer', 'browser.html'));

    // 页面就绪后再真正跳转 —— 这样地址栏能先显示出来，不会出现"白屏等一会儿"
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('browser:init', { url, title: opts.title || '', context: opts.context || null, id });
      // 页面已经能收消息了，这时才通知上层 —— 上层可以在这里补推初始化数据
      try { this.onReady(id, this.windows.get(id) || { context: opts.context || null }); } catch (e) {
        this.log('onReady 回调出错：' + (e.message || e));
      }
      win.show();
      if (parent) {
        try {
          const [px, py] = parent.getPosition();
          const [pw, ph] = parent.getSize();
          const [ww, wh] = win.getSize();
          win.setPosition(
            Math.max(0, px + Math.round((pw - ww) / 2)),
            Math.max(0, py + Math.round((ph - wh) / 2))
          );
        } catch { /* 定位失败无所谓 */ }
      }
    });

    return win;
  }

  _attachWindowEvents(id, win) {
    const wc = win.webContents;

    // 网页里的标题变了 → 同步到窗口标题，并通知上层
    wc.on('page-title-updated', (_e, title) => {
      const rec = this.windows.get(id);
      if (rec) rec.title = title;
      this.onEvent({ type: 'title', id, title });
    });

    wc.on('did-navigate', (_e, url) => {
      const rec = this.windows.get(id);
      if (rec) rec.url = url;
      this.onEvent({ type: 'navigated', id, url });
    });

    // 网页想在新窗口打开链接 → 在同窗口里跳，别真弹一堆窗口出来
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        this.navigate(id, url);
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });

    // 不是 http/https 的跳转（比如 nxm:// 这种 MOD 管理器的协议）
    // 交给系统处理，别在浏览器里卡住
    wc.on('will-navigate', (e, url) => {
      if (!/^https?:\/\//i.test(url)) {
        e.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });

    // <webview> 挂上来时登记它的 guest webContents ——
    // 下载是从 guest 里发起的，不登记就找不到这条下载属于哪个窗口
    wc.on('did-attach-webview', (_e, guest) => {
      if (guest) this._guests.set(guest, id);
      this.onEvent({ type: 'webview-attached', id });
    });

    win.on('closed', () => {
      this.windows.delete(id);
      this.onEvent({ type: 'closed', id });
    });
  }

  /* ================================================================
   *  三、下载接管 —— 这个功能的价值所在
   * ================================================================ */

  _installDownloadHooks() {
    this.session.on('will-download', (_e, item, wc) => {
      const downloadId = 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const filename = item.getFilename() || 'download';
      const url = item.getURL();

      // 这个下载是从哪个浏览器窗口发起的 —— 决定了进度要推回给谁
      // （session 是共享的，不带上窗口 id 就没法知道该更新哪个进度条）
      const winId = wc ? this._idOf(wc) : null;

      const rec = {
        id: downloadId,
        filename,
        url,
        savePath: '',
        state: 'pending',
        received: 0,
        total: item.getTotalBytes() || 0,
        mime: item.getMimeType() || '',
        windowId: winId,
        item,
        startedAt: Date.now()
      };
      this.downloads.set(downloadId, rec);

      // 问上层"这个文件该存哪" —— 由上层按 MOD 目录规则决定
      // 返回 { dir } 或 { cancel:true }
      let decided = null;
      if (this.onDownload) {
        try {
          decided = this.onDownload({
            filename,
            url,
            mime: rec.mime,
            totalBytes: rec.total,
            windowId: winId,
            // 从哪个浏览器窗口触发的，带上它的上下文（里面有 gameId）
            context: wc ? this._contextOf(wc) : null
          });
        } catch (e) {
          this.log('决定下载位置时出错：' + (e.message || e));
        }
      }

      // Promise 形态也支持，方便上层弹个"存到哪"的对话框
      const apply = (d) => {
        // ⚠ 只有**明确**返回 cancel 才取消。
        //   上层压根没配回调（d 为 null）时不能顺手取消 ——
        //   那样会让下载无声无息消失，比存错地方还难排查。
        if (d && d.cancel) {
          try { item.cancel(); } catch { /* 忽略 */ }
          rec.state = 'cancelled';
          this._fire('download', rec);
          return;
        }
        const dir = d ? String(d.dir || '').trim() : '';
        if (dir) {
          // setSavePath 必须给完整文件路径，不能只给目录
          item.setSavePath(require('path').join(dir, filename));
          rec.savePath = require('path').join(dir, filename);
        } else {
          // 上层没给目录 → 走默认「每次询问」
          item.setSavePath(item.getFilename());
        }
      };

      if (decided && typeof decided.then === 'function') {
        decided.then(apply).catch(() => apply(null));
      } else {
        apply(decided);
      }

      item.on('updated', (_s, state) => {
        rec.received = item.getReceivedBytes();
        rec.total = item.getTotalBytes() || rec.total;
        rec.state = state === 'progressing' ? 'progressing' : state === 'interrupted' ? 'interrupted' : state;
        this._fire('download', rec);
      });

      item.once('done', (_s, state) => {
        rec.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';
        rec.savePath = item.getSavePath() || rec.savePath;
        rec.received = item.getReceivedBytes();
        rec.item = null;
        this._fire('download-done', rec);
        this.log(`下载${rec.state === 'completed' ? '完成' : '结束（' + rec.state + '）'}：${filename}`);
      });
    });
  }

  /**
   * 分发下载事件：一路推回发起它的那个浏览器窗口（画进度条），
   * 一路统一上报给上层（以后做下载中心 / 落库用）。
   */
  _fire(type, rec) {
    const payload = this._publicDownload(rec);
    if (rec.windowId) this.sendTo(rec.windowId, 'browser:download', payload);
    this.onEvent({ type, id: rec.windowId, download: payload });
  }

  /** 去掉不能跨进程传的字段 */
  _publicDownload(rec) {
    return {
      id: rec.id,
      filename: rec.filename,
      url: rec.url,
      savePath: rec.savePath,
      state: rec.state,
      received: rec.received,
      total: rec.total,
      mime: rec.mime,
      windowId: rec.windowId || null,
      startedAt: rec.startedAt
    };
  }

  /** 根据 webContents 反查是哪个窗口（为了拿到 context 里的 gameId） */
  _contextOf(wc) {
    for (const r of this.windows.values()) {
      if (r.win && !r.win.isDestroyed() && r.win.webContents === wc) return r.context;
    }
    return null;
  }

  /**
   * 根据 webContents 反查窗口 id。
   *
   * ⚠ 这里的坑：下载是从 <webview> 里发起的，传进来的 wc 是
   *   **guest webContents**，不等于宿主窗口的 webContents，
   *   直接比 === 会全部失配，进度条就永远不动。
   *   所以 guest 要在 attach 时就登记，这里再兜三层。
   */
  _idOf(wc) {
    if (!wc) return null;

    // ① 就是某个窗口自己的 webContents（不用 webview 的情形）
    for (const [id, r] of this.windows.entries()) {
      if (r.win && !r.win.isDestroyed() && r.win.webContents === wc) return id;
    }

    // ② <webview> 的 guest：attach 时登记过就直接命中
    const mapped = this._guests && this._guests.get(wc);
    if (mapped && this.windows.has(mapped)) return mapped;

    // ③ 顺着归属窗口找
    try {
      const owner = typeof wc.getOwnerBrowserWindow === 'function' ? wc.getOwnerBrowserWindow() : null;
      if (owner) {
        for (const [id, r] of this.windows.entries()) {
          if (r.win === owner) return id;
        }
      }
    } catch { /* 某些版本会抛，忽略 */ }

    // ④ 只有一个窗口时不用猜也知道是它
    if (this.windows.size === 1) return [...this.windows.keys()][0];
    return null;
  }
}

/**
 * 建一个浏览器服务。
 * 之所以导出工厂函数而不是直接 new：以后要是想换成「内嵌标签页」实现，
 * 只要在这里换个类，调用方（main.js）完全不用改。
 */
function createBrowserService(opts = {}) {
  return new BrowserService(opts);
}

module.exports = {
  createBrowserService,
  BrowserService,
  SESSION_PARTITION
};
