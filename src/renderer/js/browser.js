/**
 * ============================================================
 *  GameHub - 内置浏览器窗口的前端逻辑  (js/browser.js)
 * ------------------------------------------------------------
 *  负责工具条交互与状态显示，**不做任何业务判断**：
 *  该存到哪个目录是主进程按 MOD 规则算好推过来的，这里只负责显示。
 *
 *  ⚠ 这个页面跑在隔离环境里，只能通过 preload-browser.js 暴露的
 *    window.GHBrowser 那几个方法跟主进程说话，拿不到 Node 能力。
 * ============================================================
 */
(function () {
  'use strict';

  const B = window.GHBrowser;
  const $ = (id) => document.getElementById(id);

  const view = $('br-view');
  const addr = $('br-addr');
  const titleEl = $('br-title');

  let initUrl = '';

  /* ---------------- 主进程推来的初始信息 ---------------- */
  if (B && B.onInit) {
    B.onInit((info) => {
      initUrl = info.url || '';
      if (info.title) titleEl.textContent = info.title;
      addr.value = initUrl;
      // 下载落点由主进程算好推过来
      if (info.downloadTarget) setTarget(info.downloadTarget);
      if (initUrl) view.src = initUrl;
    });
  }

  /* ---------------- 下载落点显示 ---------------- */
  function setTarget(t) {
    if (!t) return;
    const pathEl = $('br-target-path');
    const srcEl = $('br-target-src');

    if (t.dir) {
      pathEl.textContent = t.dir;
      pathEl.classList.remove('dim');
    } else {
      // 「每次问我」模式没有固定目录，也要说清楚，别显示成"（未指定）"让人不安
      pathEl.textContent = '每次下载时让我选';
      pathEl.classList.add('dim');
    }

    const bits = [];
    if (t.gameName) bits.push(t.gameName);
    if (t.label) bits.push(t.label);
    srcEl.textContent = bits.length ? '（' + bits.join(' · ') + '）' : '';
  }
  if (B && B.onDownloadTarget) B.onDownloadTarget(setTarget);

  /* ---------------- 导航按钮 ---------------- */
  $('btn-back').onclick = () => { try { view.goBack(); } catch (_) { /* 忽略 */ } };
  $('btn-fwd').onclick = () => { try { view.goForward(); } catch (_) { /* 忽略 */ } };
  $('btn-reload').onclick = () => { try { view.reload(); } catch (_) { /* 忽略 */ } };
  $('btn-ext').onclick = () => { if (B) B.openExternal(addr.value || initUrl); };

  addr.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    let u = addr.value.trim();
    if (!u) return;
    // 没写协议就按 https 处理，省得用户输一大串
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    view.src = u;
  });

  /* ---------------- 窗口按钮 ---------------- */
  $('btn-min').onclick = () => B && B.minimize();
  $('btn-max').onclick = () => B && B.maximize();
  $('btn-close').onclick = () => B && B.close();

  /* ---------------- webview 状态同步 ---------------- */
  view.addEventListener('did-navigate', (e) => { addr.value = e.url; });
  view.addEventListener('did-navigate-in-page', (e) => { addr.value = e.url; });
  view.addEventListener('page-title-updated', (e) => {
    // 标题栏显示"页面标题 - GameHub 浏览器"
    titleEl.textContent = (e.title || '') + ' - GameHub 浏览器';
  });

  const syncNav = () => {
    $('btn-back').disabled = !view.canGoBack();
    $('btn-fwd').disabled = !view.canGoForward();
  };
  view.addEventListener('did-navigate', syncNav);
  view.addEventListener('did-finish-load', syncNav);

  /* ---------------- 下载进度 ---------------- */
  function fmt(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
  }

  if (B && B.onDownload) {
    B.onDownload((d) => {
      const box = $('br-dl');
      box.hidden = false;
      $('br-dl-name').textContent = d.filename;

      if (d.state === 'progressing') {
        const pct = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
        $('br-dl-stat').textContent = `${fmt(d.received)} / ${fmt(d.total)}　${pct}%`;
        $('br-dl-fill').style.width = pct + '%';
        $('br-dl-fill').classList.remove('done');
      } else if (d.state === 'completed') {
        $('br-dl-stat').textContent = '完成　' + fmt(d.total || d.received);
        $('br-dl-fill').style.width = '100%';
        $('br-dl-fill').classList.add('done');
        // 3 秒后收起进度条，别一直占着地方
        setTimeout(() => { box.hidden = true; }, 3000);
      } else if (d.state === 'cancelled') {
        $('br-dl-stat').textContent = '已取消';
        setTimeout(() => { box.hidden = true; }, 2000);
      } else {
        $('br-dl-stat').textContent = '中断 / 失败';
      }
    });
  }
})();
