/**
 * ============================================================
 *  GameHub - 外观自定义  (js/background.js)
 * ------------------------------------------------------------
 *  把设置里的「背景」与「字体」落到界面上：
 *    · 左侧栏 / 右侧内容区 各自独立的背景（图片 或 材质）
 *    · 界面字体族与基础字号
 *
 *  背景不是直接改元素的 background，而是往元素上写 CSS 变量，
 *  由 css/appearance.css 里的 ::before / ::after 去画。
 *  这样内容层的层级、图标的点击区域完全不受影响，
 *  也不会出现"改个背景把按钮 hover 底色也带偏"的连锁问题。
 * ============================================================
 */
(function () {
  'use strict';

  const API = window.API;

  /** 栏位 → 元素选择器 */
  const SLOT_SEL = { sidebar: '.sidebar', content: '.content' };

  /** 填充方式 → background-size / background-repeat */
  const FIT = {
    cover: { size: 'cover', repeat: 'no-repeat' },
    contain: { size: 'contain', repeat: 'no-repeat' },
    tile: { size: 'auto', repeat: 'repeat' },
    center: { size: 'auto', repeat: 'no-repeat' }
  };

  /** 背景图地址缓存（避免每次都问主进程） */
  let urls = { sidebar: '', content: '' };

  /** 数字兜底：拿不到或越界就回默认值 */
  function num(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * 应用单个栏位的背景。
   * @param {'sidebar'|'content'} slot
   * @param {object} cfg 设置里的 settings.bg[slot]
   */
  function applySlot(slot, cfg) {
    const el = document.querySelector(SLOT_SEL[slot]);
    if (!el) return;

    const c = cfg || {};
    const type = c.type || 'default';

    // 先把上一次留下的形态清干净，避免换类型时叠加
    el.classList.remove('bg-image', 'bg-material');
    el.removeAttribute('data-material');
    for (const v of ['--bg-img', '--bg-size', '--bg-repeat',
      '--bg-opacity', '--bg-blur', '--bg-dim', '--bg-zoom']) {
      el.style.removeProperty(v);
    }

    if (type === 'image') {
      const url = urls[slot];
      // 图还没就绪就先保持默认外观，refreshUrls 回来后会自动重画
      if (!url) return;
      const fit = FIT[c.fit] || FIT.cover;
      const blur = num(c.blur, 0, 40, 0);
      el.classList.add('bg-image');
      el.style.setProperty('--bg-img', 'url("' + url + '")');
      el.style.setProperty('--bg-size', fit.size);
      el.style.setProperty('--bg-repeat', fit.repeat);
      el.style.setProperty('--bg-opacity', String(num(c.opacity, 0, 1, 0.55)));
      el.style.setProperty('--bg-dim', String(num(c.dim, 0, 1, 0.35)));
      el.style.setProperty('--bg-blur', blur + 'px');
      // 模糊会把图片边缘化开、露出栏位底色，稍微放大一点把边填满
      el.style.setProperty('--bg-zoom', blur > 0 ? '1.06' : '1');
    } else if (type === 'material') {
      el.classList.add('bg-material');
      el.setAttribute('data-material', c.material || 'frosted');
    }
    // default：什么都不加，沿用主题自带的底色

    // 氛围光跟着当前 DOM 现状走 —— 只调 applySlot 也不会漏掉
    syncAmbientFromDom();
  }

  /** 应用字体族与基础字号 */
  function applyFont(settings) {
    const s = settings || {};
    const root = document.documentElement;

    // 字体族：留空就回落到主题自带的字体栈
    const fam = String(s.fontFamily || '').trim();
    if (fam) {
      // 带空格或逗号的字体名必须加引号，否则 CSS 解析会在空格处断掉
      const clean = fam.replace(/["']/g, '');
      const quoted = /[,\s]/.test(clean) ? '"' + clean + '"' : clean;
      root.style.setProperty(
        '--font',
        quoted + ', "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif'
      );
    } else {
      root.style.removeProperty('--font');
    }

    // 基础字号（设置里的滑块范围是 11 ~ 16）
    root.style.setProperty('--fs-base', num(s.fontSize, 11, 16, 13.5) + 'px');
  }

  /**
   * 按 DOM 现状同步氛围光。
   *
   * 为什么不直接用设置判断：调 applySlot 的地方（比如设置面板里
   * 每改一个值就实时预览）手上不一定有完整的 settings，
   * 单独调 applySlot 也会漏掉氛围光的同步 —— 那样用户切到材质后，
   * 面板是半透明的却透不出任何东西，看着像坏了。
   * 直接看 DOM 上挂着哪个类最省事，也最不会漏。
   */
  function syncAmbientFromDom() {
    const any = !!document.querySelector('.sidebar.bg-material, .content.bg-material');
    const app = document.getElementById('app');
    if (app) app.classList.toggle('has-material', any);
  }

  /**
   * 应用「透出桌面」状态。
   *
   * 分工要分清：
   *   窗口那一层（到底能不能看到桌面）是主进程调 setBackgroundMaterial 决定的 ——
   *   页面里的 backdrop-filter 只能采样页面内已画出来的东西，看不到窗口外面。
   *   这里只负责"页面别挡着"：给 html 打个标记，
   *   剩下的交给 CSS 把 body 和 .app 的底色放掉。
   *
   * ⚠ 传进来的 mode 是「已经换算过的最终值」（off / acrylic / mica / tabbed），
   *   不是设置里那个 desktopMaterial 偏好（auto / off / acrylic …）。
   *   换算在主进程做（auto 要根据背景材质决定），主进程改完会推过来；
   *   这里只在启动时按同一套规则先算一次，好让首屏别闪一下。
   */
  function applyDesktop(mode) {
    const m = ['acrylic', 'mica', 'tabbed'].includes(mode) ? mode : null;
    const root = document.documentElement;
    if (m) root.setAttribute('data-desktop-material', m);
    else root.removeAttribute('data-desktop-material');
  }

  /** 和主进程 resolveDesktopMaterial 同一套规则（首屏用，之后以主进程推送为准） */
  function resolveDesktop(settings) {
    const pref = (settings && settings.desktopMaterial) || 'auto';
    if (pref !== 'auto' && pref !== 'none') return pref;
    const bg = (settings && settings.bg) || {};
    const glassy = ['sidebar', 'content'].some((k) => {
      const c = bg[k] || {};
      return c.type === 'material' && ['frosted', 'acrylic', 'glass', 'liquid'].includes(c.material);
    });
    return glassy ? 'acrylic' : 'off';
  }

  /**
   * 从主进程拉一次背景图地址。
   * 只有真的用到图片才拉，省一次 IPC 往返。
   */
  async function refreshUrls(settings) {
    const bg = (settings && settings.bg) || {};
    const needImg = ['sidebar', 'content'].some((k) => (bg[k] || {}).type === 'image');
    if (!needImg) {
      urls = { sidebar: '', content: '' };
      return;
    }
    const r = await API.appearanceUrls();
    if (r && r.ok !== false) {
      urls = { sidebar: r.sidebar || '', content: r.content || '' };
    }
  }

  /**
   * 总入口：把一整套设置应用到界面。
   * @param {object} settings
   * @param {{skipUrls?:boolean}} [opts] 图片刚换过、地址已在手上时可跳过拉取
   */
  async function applyAll(settings, opts) {
    const s = settings || {};
    applyFont(s);
    applyDesktop(resolveDesktop(s));
    if (!(opts && opts.skipUrls)) await refreshUrls(s);
    applySlot('sidebar', (s.bg || {}).sidebar);
    applySlot('content', (s.bg || {}).content);
    // applySlot 内部已经同步过氛围光，这里不用再算一遍
  }

  /**
   * 订阅主进程推来的窗口材质。
   *
   * 为什么要有这一条：auto 模式下「到底透不透」是主进程按背景材质算出来的，
   * 页面启动时那个首屏值只是临时猜的。用户在设置里把某一栏从「纯色」切到
   * 「亚克力」时，走的也是主进程那条链路 —— 没有这个推送，
   * 页面就还停在旧的（不透）样式上，用户会觉得"点了没反应"。
   */
  if (API && typeof API.onDesktopMaterial === 'function') {
    API.onDesktopMaterial((p) => {
      if (p && typeof p.mode !== 'undefined') applyDesktop(p.mode);
    });
  }

  window.Bg = {
    applyAll,
    applySlot,
    applyFont,
    applyDesktop,
    resolveDesktop,
    refreshUrls,
    /** 换图后直接把新地址喂进来，省一次往返 */
    setUrl(slot, url) {
      if (slot === 'sidebar' || slot === 'content') urls[slot] = url || '';
    },
    getUrls() { return { ...urls }; }
  };
})();
