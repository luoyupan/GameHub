/**
 * ============================================================
 *  GameHub - 内置浏览器  (js/browserview.js)
 * ------------------------------------------------------------
 *  两种形态，共用一套「面板」实现（createPane）：
 *
 *   ① MOD 管理面板内嵌（主人定的：不要跳出去，太突兀）
 *      点 MOD 管理里的「N 网」，浏览器直接嵌在区块里打开，
 *      工具条 + 页面都在详情弹窗内部。
 *
 *   ② 导航栏标签页
 *      在顶部导航栏插「🌐 标题 ✕」标签，页面盖在内容区上。
 *      供以后其他入口使用。
 *
 *  ── 白屏问题的三个源头（都修了）────────────────────────
 *    1. src 在 webview 挂进 DOM 之前设置 → 初始导航被丢弃，页面停在
 *       about:blank（白色）。必须先 appendChild 再设 src。
 *    2. `nodeintegration="false"` 这个属性**写了就等于 true**
 *       （布尔属性只看存在与否，不看值）—— 不但要删掉，还是个安全洞。
 *    3. Electron 的 UA 带 `Electron/x.y.z` 尾巴，N 网这类走 Cloudflare
 *       的站点可能据此发难 —— 清洗成普通 Chrome UA。
 *    另外加载失败 / 渲染进程崩溃时显示错误页 + 重试按钮，不再白屏。
 * ============================================================
 */
(function () {
  'use strict';

  const PARTITION = 'persist:gamehub-browser';

  const $ = (id) => document.getElementById(id);

  /** paneId → pane；下载进度事件按 tabId 路由到对应面板 */
  const panes = new Map();
  let seq = 0;

  /** 清洗 UA：去掉 Electron 尾巴，伪装成普通 Chrome（有些站点会针对 Electron UA 使绊子） */
  function cleanUA() {
    return (navigator.userAgent || '')
      .replace(/\sElectron\/\S+/, '')
      .replace(/\sGameHub\/\S+/, '');
  }

  /* ================================================================
   *  面板核心：工具条 + webview + 状态
   * ================================================================ */

  /**
   * 在 container 里建一个浏览器面板。
   * @param {HTMLElement} container 面板的挂载点
   * @param {{url:string, target?:object, context?:object, compact?:boolean, floatable?:boolean}} opts
   *   floatable（默认 true）：给面板加「浮出」能力 —— 右下角抓手拖一下就能
   *   脱离文档流变成浮层，自由缩放 / 移动，双击抓手铺满全窗。导航栏形态用不上。
   * @returns {{id:string, el:HTMLElement, webview:HTMLElement, destroy:Function, navigate:Function}}
   */
  function createPane(container, opts = {}) {
    const paneId = 'pane' + (++seq);

    const root = document.createElement('div');
    root.className = 'bh-pane' + (opts.compact ? ' bh-pane-compact' : '');
    root.innerHTML =
      '<div class="bh-toolbar">' +
      '  <button class="bh-btn" data-act="back" title="后退">‹</button>' +
      '  <button class="bh-btn" data-act="fwd" title="前进">›</button>' +
      '  <button class="bh-btn" data-act="reload" title="刷新">⟳</button>' +
      '  <input class="bh-addr" type="text" spellcheck="false" placeholder="输入网址后回车" />' +
      '  <button class="bh-btn" data-act="ext" title="用系统浏览器打开">↗</button>' +
      '  <div class="bh-target" title="按各游戏的 MOD 目录规则自动落位">' +
      '    <span class="bh-target-label">MOD 将下载到</span>' +
      '    <span class="bh-target-path">（未指定）</span>' +
      '  </div>' +
      '</div>' +
      '<div class="bh-dl" hidden>' +
      '  <span class="bh-dl-name"></span>' +
      '  <div class="bh-dl-track"><div class="bh-dl-fill"></div></div>' +
      '  <span class="bh-dl-stat"></span>' +
      '</div>' +
      '<div class="bh-stage">' +
      '  <div class="bh-error" hidden></div>' +
      '</div>';

    const stage = root.querySelector('.bh-stage');
    const errBox = root.querySelector('.bh-error');

    /**
     * ⚠ 白屏修复 ①：webview 必须先挂进 DOM、再设 src。
     *   反过来的话初始导航会被丢掉，guest 停在 about:blank —— 白屏。
     * ⚠ 白屏修复 ②：绝对不要写 nodeintegration="false" ——
     *   布尔属性只看在不在，写了这个属性 nodeIntegration 反而是开的。
     *   默认就是 false，什么都不写才对。
     */
    const wv = document.createElement('webview');
    wv.className = 'bh-view';
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('allowpopups', 'false');
    wv.setAttribute('webpreferences', 'contextIsolation=true,spellcheck=false');
    // ⚠ 白屏修复 ③：清洗 UA（N 网这类 Cloudflare 站点对 Electron UA 不友好）
    wv.setAttribute('useragent', cleanUA());
    stage.appendChild(wv);

    const pane = {
      id: paneId,
      el: root,
      webview: wv,
      url: opts.url || '',
      target: opts.target || null,
      tabId: null,          // 主进程登记后回填
      started: false,       // 是否已经导航过（重建后据此恢复上次地址）
      destroyed: false,
      navigate,
      setTarget,
      destroy
    };
    panes.set(paneId, pane);

    /** 浮层形态下原位置的占位条 —— destroy 时要一并清掉，声明提升到这层 */
    let fPlaceholder = null;

    /* ---- 工具条 ---- */
    root.querySelector('[data-act="back"]').onclick = () => { try { wv.goBack(); } catch (_) { } };
    root.querySelector('[data-act="fwd"]').onclick = () => { try { wv.goForward(); } catch (_) { } };
    root.querySelector('[data-act="reload"]').onclick = () => { try { wv.reload(); } catch (_) { } };
    root.querySelector('[data-act="ext"]').onclick = () => {
      if (pane.url) window.API.browserOpenExternal(pane.url);
    };

    const addr = root.querySelector('.bh-addr');
    addr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      let u = addr.value.trim();
      if (!u) return;
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      navigate(u);
      wv.focus();
    });

    if (opts.floatable !== false) {
    /* ================================================================
     *  浮层能力：从面板里拖出来自由缩放 / 移动
     * ------------------------------------------------------------
     *  主人需求：内嵌的网页窗口要能自由拖大，方便看更多信息。
     *  实现要点（两个坑都在这）：
     *  ① webview 一旦被移出 DOM 就销毁重载 —— 所以**绝不 reparent**，
     *     浮层化只是给同一个节点改 position:fixed + 内联几何。
     *     祖先链（.detail-layer → .detail-panel）没有 transform/filter，
     *     fixed 的包含块就是视口，可以放心铺满全窗。
     *  ② 拖拽时鼠标会划过 webview —— 它是独立进程，鼠标事件不冒泡，
     *     宿主收不到 pointermove 拖拽就断了。拖拽期间给 stage 盖一层
     *     透明罩（.bh-dragging ::after）把鼠标留在宿主文档里。
     * ================================================================ */
    let fMode = 'dock';        // dock=内嵌 | float=自由浮层 | max=铺满全窗

    const MIN_W = 420, MIN_H = 300, EDGE = 16;

    const fBtn = document.createElement('button');
    fBtn.className = 'bh-btn';
    fBtn.type = 'button';
    fBtn.title = '放大浏览';
    fBtn.textContent = '⤢';
    root.querySelector('[data-act="ext"]').parentNode.insertBefore(
      fBtn, root.querySelector('[data-act="ext"]')
    );

    const grip = document.createElement('div');
    grip.className = 'bh-grip';
    grip.title = '拖动调整大小 · 双击铺满全窗';
    grip.textContent = '◢';
    root.appendChild(grip);

    const fBar = root.querySelector('.bh-toolbar');

    function fApply(x, y, w, h) {
      root.style.left = Math.round(Math.max(-rootW() + 120, Math.min(x, innerWidth - 120))) + 'px';
      root.style.top = Math.round(Math.max(0, Math.min(y, innerHeight - 60))) + 'px';
      root.style.width = Math.max(MIN_W, Math.round(w)) + 'px';
      root.style.height = Math.max(MIN_H, Math.round(h)) + 'px';
    }
    function rootW() { return root.getBoundingClientRect().width || MIN_W; }

    function fSetMode(m) {
      fMode = m;
      root.classList.toggle('is-float', m !== 'dock');
      fBtn.textContent = m === 'dock' ? '⤢' : '⇲';
      fBtn.title = m === 'dock' ? '放大浏览' : '收回面板';
      if (m === 'dock') {
        ['left', 'top', 'width', 'height'].forEach((p) => root.style.removeProperty(p));
        if (fPlaceholder) { fPlaceholder.remove(); fPlaceholder = null; }
      } else {
        // 原位置留个占位，用户不会找不到"浏览器去哪了"
        if ((!fPlaceholder || !fPlaceholder.isConnected) && root.parentNode) {
          fPlaceholder = document.createElement('div');
          fPlaceholder.className = 'bh-float-ph';
          fPlaceholder.innerHTML = '<span>🌐 浏览器已浮出</span>';
          const back = document.createElement('button');
          back.type = 'button';
          back.textContent = '点此收回';
          back.onclick = () => fSetMode('dock');
          fPlaceholder.appendChild(back);
          root.parentNode.insertBefore(fPlaceholder, root);
        }
      }
    }

    function fMaximize() {
      fApply(EDGE, EDGE, innerWidth - EDGE * 2, innerHeight - EDGE * 2);
      fSetMode('max');
    }

    /** 通用拖拽：按下起点 + window 级 move/up（拖网页容器必须挂 window） */
    function fDrag(e, onMove) {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      root.classList.add('bh-dragging');
      document.body.style.userSelect = 'none';
      const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        root.classList.remove('bh-dragging');
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }

    // 抓手：按住拖 = 缩放（dock 态第一次拖就浮出来）；双击 = 铺满
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = root.getBoundingClientRect();
      const baseL = r.left, baseT = r.top, baseW = r.width, baseH = r.height;
      if (fMode === 'dock') fSetMode('float');
      fApply(baseL, baseT, baseW, baseH);
      fDrag(e, (dx, dy) => fApply(baseL, baseT, baseW + dx, baseH + dy));
    });
    grip.addEventListener('dblclick', (e) => { e.preventDefault(); fMaximize(); });

    // 工具条空白处：按住拖 = 移动浮层位置（dock 态拖一下也会浮出来）
    fBar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, .bh-target')) return;
      const r = root.getBoundingClientRect();
      const baseL = r.left, baseT = r.top;
      if (fMode === 'dock') {
        fApply(baseL, baseT, Math.max(r.width, 560), Math.max(r.height, 400));
        fSetMode('float');
      } else {
        fApply(baseL, baseT, r.width, r.height);
      }
      const bl = parseFloat(root.style.left), bt = parseFloat(root.style.top);
      fDrag(e, (dx, dy) => {
        root.style.left = Math.round(Math.max(-rootW() + 120, Math.min(bl + dx, innerWidth - 120))) + 'px';
        root.style.top = Math.round(Math.max(0, Math.min(bt + dy, innerHeight - 60))) + 'px';
      });
    });

    // ⤢ / ⇲：内嵌 ↔ 铺满一键切换
    fBtn.onclick = () => { if (fMode === 'dock') fMaximize(); else fSetMode('dock'); };
    } /* end floatable */

    /* ---- webview 事件 ---- */

    // 挂上后立刻登记 guest id —— 下载钩子按它反查这条下载属于谁
    wv.addEventListener('did-attach', () => {
      try {
        window.API.browserAttach({ tabId: pane.tabId, wcId: wv.getWebContentsId() });
      } catch (_) { /* 拿不到就退化成询问，不崩 */ }
    });

    wv.addEventListener('did-navigate', (e) => {
      if (e && e.url) { pane.url = e.url; addr.value = e.url; }
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      if (e && e.url) { pane.url = e.url; addr.value = e.url; }
    });

    // 加载失败要说话，不能白屏装死（404 之外的内嵌错误都在这）
    wv.addEventListener('did-fail-load', (e) => {
      // errorCode -3 (ERR_ABORTED) 多是正常跳转被打断，不用吓用户
      if (!e || e.errorCode === -3 || e.isMainFrame === false) return;
      showError(`页面加载失败（${e.errorDescription || e.errorCode}）`, e.errorCode);
    });
    wv.addEventListener('render-process-gone', (e) => {
      const reason = (e && e.detail && e.detail.reason) || 'unknown';
      showError('页面进程退出了（' + reason + '）', '');
    });

    function showError(msg, code) {
      errBox.hidden = false;
      errBox.innerHTML =
        '<div class="bh-error-t">😵 打不开这个页面</div>' +
        '<div class="bh-error-d"></div>' +
        '<button class="btn btn-ghost btn-sm bh-error-retry">↻ 重试</button>' +
        '<button class="btn btn-ghost btn-sm bh-error-ext">用系统浏览器打开</button>';
      errBox.querySelector('.bh-error-d').textContent =
        msg + (pane.url ? '　·　' + pane.url : '');
      errBox.querySelector('.bh-error-retry').onclick = () => {
        errBox.hidden = true;
        navigate(pane.url);
      };
      errBox.querySelector('.bh-error-ext').onclick = () => {
        if (pane.url) window.API.browserOpenExternal(pane.url);
      };
      void code;
    }

    function navigate(u) {
      if (!/^https?:\/\//i.test(String(u || ''))) return;
      pane.url = u;
      pane.started = true;
      errBox.hidden = true;
      addr.value = u;
      // src 赋值即导航（webview 已在 DOM 里，白屏源头已除）
      wv.src = u;
    }

    function setTarget(t) {
      pane.target = t || pane.target;
      const pathEl = root.querySelector('.bh-target-path');
      const box = root.querySelector('.bh-target');
      const d = pane.target;
      if (d && d.dir) {
        pathEl.textContent = d.dir;
        pathEl.classList.remove('dim');
        box.title = (d.label ? d.label + '\n' : '') + d.dir + (d.note ? '\n' + d.note : '');
      } else if (d) {
        pathEl.textContent = '每次下载时让我选';
        pathEl.classList.add('dim');
        box.title = d.label || '';
      } else {
        pathEl.textContent = '（未指定）';
        pathEl.classList.add('dim');
        box.title = '';
      }
    }

    function destroy() {
      if (pane.destroyed) return;
      pane.destroyed = true;
      if (fPlaceholder) fPlaceholder.remove();   // 浮出时原位置留的占位一并清掉
      try { wv.remove(); } catch { }
      root.remove();
      panes.delete(paneId);
    }

    /* ---- 先挂进容器（容器必须已在 DOM 里），最后才导航 ----
     * 顺序是白屏的关键：src 设在挂载前，初始导航会被丢弃。 */
    container.appendChild(root);
    setTarget(opts.target);
    if (opts.url) navigate(opts.url);

    return pane;
  }

  /* ================================================================
   *  下载进度：按 tabId 路由到对应面板
   * ================================================================ */

  function fmt(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  }

  window.GameHub.on('browser:event', (ev) => {
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type !== 'download' && ev.type !== 'download-done') return;

    // 找到这条下载对应的面板（tabId 是主进程按 guest id 反查出来的）
    const pane = [...panes.values()].find((p) => p.tabId && p.tabId === ev.tabId);
    if (!pane || pane.destroyed) return;
    const root = pane.el;
    const box = root.querySelector('.bh-dl');
    box.hidden = false;
    root.querySelector('.bh-dl-name').textContent = ev.filename || '';

    if (ev.state === 'progressing') {
      const pct = ev.total ? Math.min(100, Math.round((ev.received / ev.total) * 100)) : 0;
      root.querySelector('.bh-dl-stat').textContent = `${fmt(ev.received)} / ${fmt(ev.total)}　${pct}%`;
      root.querySelector('.bh-dl-fill').style.width = pct + '%';
      root.querySelector('.bh-dl-fill').classList.remove('done');
    } else if (ev.state === 'completed') {
      root.querySelector('.bh-dl-stat').textContent = '完成　' + fmt(ev.total || ev.received);
      root.querySelector('.bh-dl-fill').style.width = '100%';
      root.querySelector('.bh-dl-fill').classList.add('done');
      // 落点 / 解压结果由主进程 toast，进度条 3 秒后收起
      setTimeout(() => { box.hidden = true; }, 3000);
    } else if (ev.state === 'cancelled') {
      root.querySelector('.bh-dl-stat').textContent = '已取消';
      setTimeout(() => { box.hidden = true; }, 2000);
    } else {
      root.querySelector('.bh-dl-stat').textContent = '中断 / 失败';
    }
  });

  /* ================================================================
   *  形态一：MOD 管理面板内嵌（modview.js 用）
   * ================================================================ */

  let modPane = null;     // 当前内嵌面板
  let modGameId = null;   // 面板属于哪个游戏
  let modTabId = null;    // 服务里登记的标签 id（下载归属）
  let modLastUrl = '';    // 上次浏览的地址（面板被重挂/重建后恢复用）

  /**
   * 取（或建）MOD 管理里那个内嵌浏览器元素。
   *
   * ⚠ webview 被移出 DOM 就销毁 —— 而这里的老家（MOD 区块）在
   *   排序 / 刷新时会整体重画。所以面板是**模块级持久**的，
   *   断连（isConnected=false）时自动重建，恢复到上次地址；
   *   重挂后 modview 要调 modResume() 才会真正导航。
   *
   * @param {object} g 游戏（判断是不是同一款，换游戏就重开）
   * @returns {HTMLElement}
   */
  function modElement(g) {
    if (!modPane || modGameId !== g.id || modPane.destroyed || !modPane.el.isConnected) {
      if (modPane) modPane.destroy();
      // ⚠ 容器必须是「已经在 DOM 里」的元素 —— 但此刻它还没有，
      //   所以这里不能带 url，等 modview append 之后由 modResume 导航
      modPane = createPane(document.createElement('div'), { compact: true });
      modPane.el.classList.add('mv-bdock');
      modPane.tabId = modTabId;   // 复用服务里登记的标签，下载归属不断
      modGameId = g.id;
    }
    return modPane.el;
  }

  /**
   * 面板挂进 DOM 之后的恢复 / 首航。
   * modview 在 append 后调；首次打开走 modOpen，重挂走这里恢复上次地址。
   */
  function modResume() {
    if (modPane && !modPane.started && modLastUrl) modPane.navigate(modLastUrl);
  }

  /**
   * 在内嵌面板里打开一个地址。
   * @param {object} g 游戏
   * @param {{url:string, target?:object, tabId?:string}} opts tabId 来自 mod:browse
   */
  function modOpen(g, opts = {}) {
    modElement(g); // 确保面板存在
    if (!modPane) return;
    modTabId = opts.tabId || modTabId;
    modPane.tabId = modTabId;
    modLastUrl = opts.url || modLastUrl;
    if (opts.target) modLastTarget = opts.target;
    modPane.navigate(opts.url);
    modPane.setTarget(opts.target || modLastTarget);
  }

  let modLastTarget = null;

  /** 收起内嵌面板（同时关掉服务里的标签） */
  function modClose() {
    if (modPane) { modPane.destroy(); modPane = null; }
    modGameId = null;
    if (modTabId) {
      try { window.API.browserCloseTab(modTabId); } catch (_) { }
      modTabId = null;
    }
  }

  /* ================================================================
   *  形态二：导航栏标签页（保留给其他入口）
   * ================================================================ */

  const navTabs = new Map();   // tabId → { pane, btn }
  let navBar = null;
  let navActive = null;
  let contentEl = null;

  function ensureNavBar() {
    if (!navBar) navBar = document.querySelector('.titlebar-nav');
    if (!contentEl) contentEl = $('content');
    return navBar;
  }

  function showNavHost() {
    const host = $('browserHost');
    if (!host) return;
    host.hidden = false;
    // 不靠 z-index 硬压：把内容区头部和游戏墙收起来（弹出层层级的坑踩过）
    contentEl.classList.add('browser-active');
    document.querySelectorAll('.titlebar-nav .tb-nav-btn').forEach((n) => n.classList.remove('active'));
  }

  /** 切回游戏库视图时收起（app.js 的 goto 调） */
  function hideAll() {
    const host = $('browserHost');
    if (host) host.hidden = true;
    if (contentEl) contentEl.classList.remove('browser-active');
    for (const t of navTabs.values()) t.btn.classList.remove('active');
    navActive = null;
  }

  function openNav(opts = {}) {
    const url = String(opts.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '不支持的地址' };

    ensureNavBar();
    const host = $('browserHost');
    const viewsBox = $('bhViews');
    if (!host || !viewsBox) return { ok: false, error: '浏览器宿主不存在' };

    const btn = document.createElement('button');
    btn.className = 'bh-tab';
    btn.type = 'button';
    btn.innerHTML =
      '<span class="bh-tab-icon">🌐</span>' +
      '<span class="bh-tab-title"></span>' +
      '<span class="bh-tab-close" title="关闭标签">✕</span>';
    navBar.appendChild(btn);

    const holder = document.createElement('div');
    holder.className = 'bh-nav-holder';
    viewsBox.appendChild(holder);

    // 导航栏形态本身就占满内容区，浮层没意义，关掉
    const pane = createPane(holder, { url, target: opts.target, floatable: false });
    pane.tabId = opts.tabId || null;

    const rec = { pane, btn, holder };
    const paneId = pane.id;
    navTabs.set(paneId, rec);

    btn.querySelector('.bh-tab-title').textContent = opts.title || '正在加载…';
    btn.onclick = () => activateNav(paneId);
    btn.querySelector('.bh-tab-close').onclick = (e) => {
      e.stopPropagation();
      closeNav(paneId);
    };

    activateNav(paneId);
    return { ok: true, id: paneId };
  }

  function activateNav(paneId) {
    const rec = navTabs.get(paneId);
    if (!rec) return;
    navActive = paneId;
    for (const [id, r] of navTabs) {
      r.holder.hidden = id !== paneId;
      r.btn.classList.toggle('active', id === paneId);
    }
    showNavHost();
  }

  function closeNav(paneId) {
    const rec = navTabs.get(paneId);
    if (!rec) return;
    rec.pane.destroy();
    rec.btn.remove();
    rec.holder.remove();
    navTabs.delete(paneId);
    if (navActive === paneId) {
      navActive = null;
      const next = navTabs.keys().next();
      if (!next.done) activateNav(next.value);
      else hideAll();
    }
  }

  /* ================================================================
   *  启动
   * ================================================================ */

  window.BrowserTabs = {
    /** MOD 管理内嵌形态 */
    modElement,
    modResume,
    modOpen,
    modClose,
    /** 导航栏标签页形态 */
    open: openNav,
    hideAll
  };
})();
