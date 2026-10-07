/**
 * ============================================================
 *  GameHub - 内置浏览器·导航栏标签页  (js/browserview.js)
 * ------------------------------------------------------------
 *  【为什么从独立弹窗改成标签页】
 *    v1 弹一个独立 BrowserWindow，实际用下来反馈很直接：
 *    不要额外弹窗，要集合到主界面顶部导航栏里。所以：
 *
 *      · 顶部导航栏动态插入浏览器标签（🌐 标题 ✕）
 *      · 内容区盖一层 #browserHost，里面每个标签一个 <webview>
 *      · 下载落点 / 解压仍是主进程的事（见 src/main/browser.js）
 *
 *  【职责边界】
 *    这个文件只管「标签和显示」：开 / 关 / 激活 / 工具条 / 进度条。
 *    该存到哪、怎么解压是主进程按 MOD 规则算的，这里不掺和。
 *
 *  ⚠ webview 的 partition 必须写 persist:gamehub-browser，
 *    与主进程 SESSION_PARTITION 一致，否则下载钩子收不到。
 * ============================================================
 */
(function () {
  'use strict';

  const PARTITION = 'persist:gamehub-browser';

  const $ = (id) => document.getElementById(id);
  const host = $('browserHost');
  const viewsBox = $('bhViews');
  const navBar = document.querySelector('.titlebar-nav');
  const contentEl = $('content');

  /** tabId → { id, title, url, context, target, webview, btn } */
  const tabs = new Map();
  let activeId = null;
  let seq = 0;

  /* ================================================================
   *  显示 / 隐藏
   * ================================================================ */

  function showHost() {
    host.hidden = false;
    // 盖住内容区头部和游戏墙 —— 不靠 z-index 硬压，直接把底下两层收起来，
    // 免得和「更多选项」那套层叠上下文打架（那坑踩过一次了）
    contentEl.classList.add('browser-active');
    syncNavButtons();
  }

  /** 回到游戏库视图（点侧栏 / 顶部「游戏库」时调用） */
  function hideAll() {
    host.hidden = true;
    contentEl.classList.remove('browser-active');
    for (const t of tabs.values()) t.btn.classList.remove('active');
  }

  /* ================================================================
   *  标签条（插在顶部导航栏里）
   * ================================================================ */

  function buildTabButton(t) {
    const btn = document.createElement('button');
    btn.className = 'bh-tab';
    btn.type = 'button';
    btn.title = t.title || t.url;
    btn.innerHTML =
      '<span class="bh-tab-icon">🌐</span>' +
      '<span class="bh-tab-title"></span>' +
      '<span class="bh-tab-close" title="关闭标签">✕</span>';
    btn.querySelector('.bh-tab-title').textContent = t.title || '新建标签';

    btn.onclick = () => activate(t.id);
    // ✕ 是关闭，别把点击事件冒泡成"激活标签"
    btn.querySelector('.bh-tab-close').onclick = (e) => {
      e.stopPropagation();
      close(t.id);
    };
    return btn;
  }

  function setTabTitle(t, title) {
    t.title = title || t.title;
    const el = t.btn.querySelector('.bh-tab-title');
    if (el) el.textContent = t.title || '正在加载…';
    t.btn.title = t.title || t.url;
  }

  /* ================================================================
   *  开 / 关 / 激活
   * ================================================================ */

  /**
   * 开一个浏览器标签。
   * @param {{url:string, title?:string, context?:object, target?:object}} opts
   *  target 是主进程算好的下载落点预览（mod:browse 返回的），只管显示。
   */
  function open(opts = {}) {
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '不支持的地址' };

    const id = 'bt' + (++seq);
    const t = {
      id,
      url,
      title: opts.title || '',
      context: opts.context || null,
      target: opts.target || null,
      webview: null,
      btn: null
    };

    // 标签按钮插到导航栏（游戏平台按钮后面）
    t.btn = buildTabButton(t);
    navBar.appendChild(t.btn);

    // webview：一个标签一个，切走时隐藏不销毁，回来状态还在
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('allowpopups', 'false');
    wv.setAttribute('nodeintegration', 'false');
    wv.setAttribute('webpreferences', 'contextIsolation=true,spellcheck=false');
    wv.classList.add('bh-view');
    wv.hidden = true;
    wv.src = url;
    viewsBox.appendChild(wv);
    t.webview = wv;

    // webview 挂上后立刻向主进程登记 guest id ——
    // 下载钩子按它反查这条下载属于哪个标签（不带 gameId 就不知道该给谁）
    wv.addEventListener('did-attach', () => {
      try {
        window.API.browserAttach({ tabId: id, wcId: wv.getWebContentsId() });
      } catch (_) { /* 老版本没有这个 API 就算了，落点会退化成询问 */ }
    });

    tabs.set(id, t);
    activate(id);
    return { ok: true, id };
  }

  function activate(id) {
    const t = tabs.get(id);
    if (!t) return;
    activeId = id;

    for (const [tid, rec] of tabs) {
      rec.webview.hidden = tid !== id;
      rec.btn.classList.toggle('active', tid === id);
    }
    t.webview.hidden = false;
    showHost();

    // 工具条跟着切
    $('bhAddr').value = t.webview.getAttribute('src') === 'about:blank' ? '' : (t.url || '');
    paintTarget(t);
  }

  function close(id) {
    const t = tabs.get(id);
    if (!t) return;
    try { if (t.webview) t.webview.remove(); } catch { /* 已销毁就算了 */ }
    t.btn.remove();
    tabs.delete(id);

    if (activeId === id) {
      activeId = null;
      // 关的是当前标签 → 剩下还有标签就切过去，没有就回游戏库
      const next = tabs.keys().next();
      if (!next.done) activate(next.value);
      else hideAll();
    }
  }

  /* ================================================================
   *  工具条
   * ================================================================ */

  function activeTab() { return tabs.get(activeId) || null; }

  function bindToolbar() {
    $('bhBack').onclick = () => { const t = activeTab(); if (t) { try { t.webview.goBack(); } catch (_) { } } };
    $('bhFwd').onclick = () => { const t = activeTab(); if (t) { try { t.webview.goForward(); } catch (_) { } } };
    $('bhReload').onclick = () => { const t = activeTab(); if (t) { try { t.webview.reload(); } catch (_) { } } };

    $('bhExt').onclick = () => {
      const t = activeTab();
      const u = t ? t.url : '';
      if (u) window.API.browserOpenExternal(u);
    };

    // 没写协议就按 https 处理，省得用户输一大串
    $('bhAddr').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = activeTab();
      if (!t) return;
      let u = $('bhAddr').value.trim();
      if (!u) return;
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      t.url = u;
      t.webview.src = u;
      t.webview.focus();
    });
  }

  /** 「MOD 将下载到」徽标 —— 主进程把目录算好带过来了，这里只管显示 */
  function paintTarget(t) {
    const pathEl = $('bhTargetPath');
    const box = $('bhTarget');
    const d = t && t.target;
    if (d && d.dir) {
      pathEl.textContent = d.dir;
      pathEl.classList.remove('dim');
      box.title = (d.label ? d.label + '\n' : '') + d.dir + (d.note ? '\n' + d.note : '');
    } else if (d) {
      // 「每次问我」模式没有固定目录，也说清楚，别显示成"（未指定）"让人不安
      pathEl.textContent = '每次下载时让我选';
      pathEl.classList.add('dim');
      box.title = d.label || '';
    } else {
      pathEl.textContent = '（未指定）';
      pathEl.classList.add('dim');
      box.title = '';
    }
  }

  /* ================================================================
   *  下载进度
   * ================================================================ */

  function fmt(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  }

  function bindDownloadEvents() {
    window.GameHub.on('browser:event', (ev) => {
      if (!ev || typeof ev.type !== 'string') return;

      if (ev.type === 'download') {
        const box = $('bhDl');
        box.hidden = false;
        $('bhDlName').textContent = ev.filename || '';

        if (ev.state === 'progressing') {
          const pct = ev.total ? Math.min(100, Math.round((ev.received / ev.total) * 100)) : 0;
          $('bhDlStat').textContent = `${fmt(ev.received)} / ${fmt(ev.total)}　${pct}%`;
          $('bhDlFill').style.width = pct + '%';
          $('bhDlFill').classList.remove('done');
        } else if (ev.state === 'completed') {
          $('bhDlStat').textContent = '完成　' + fmt(ev.total || ev.received);
          $('bhDlFill').style.width = '100%';
          $('bhDlFill').classList.add('done');
          // 落点和解压结果由主进程 toast，进度条 3 秒后收起
          setTimeout(() => { box.hidden = true; }, 3000);
        } else if (ev.state === 'cancelled') {
          $('bhDlStat').textContent = '已取消';
          setTimeout(() => { box.hidden = true; }, 2000);
        } else {
          $('bhDlStat').textContent = '中断 / 失败';
        }
        return;
      }

      if (ev.type === 'download-done') {
        // 主进程的 download-done 事件里带了终态，进度条交给上面的 'download'
        // 分支收尾就行，这里只兜一层（万一中间漏了一条 updated）
        if (ev.state !== 'completed' && ev.state !== 'cancelled') {
          $('bhDlStat').textContent = '中断 / 失败';
        }
      }
    });
  }

  /* ================================================================
   *  与游戏库视图互斥
   * ================================================================ */

  function syncNavButtons() {
    // 浏览器标签激活时，顶部「游戏库 / 游戏平台」两个按钮不亮
    if (activeId) {
      document.querySelectorAll('.titlebar-nav .tb-nav-btn').forEach((n) => {
        n.classList.remove('active');
      });
    }
  }

  /* ================================================================
   *  启动
   * ================================================================ */

  bindToolbar();
  bindDownloadEvents();

  /**
   * 暴露给外面（modview.js 点「N 网找找」时调）。
   * app.js 的 goto() 也会调 hideAll() —— 切回游戏库时收起浏览器。
   */
  window.BrowserTabs = {
    open,
    close,
    activate,
    hideAll,
    /** 当前是否开着标签 */
    get count() { return tabs.size; }
  };
})();
