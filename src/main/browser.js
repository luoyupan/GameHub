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

const { session, shell } = require('electron');

/** 独立 session 分区：跟主界面分开，免得污染主界面的登录态 / 缓存。
 *  ⚠ 渲染层 webview 的 partition 属性必须写同一个值，两边对不上下载钩子就收不到。 */
const SESSION_PARTITION = 'persist:gamehub-browser';

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
  SESSION_PARTITION
};
