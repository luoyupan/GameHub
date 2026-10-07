/**
 * ============================================================
 *  GameHub - 前端主控  (js/app.js)
 * ------------------------------------------------------------
 *  页面的大脑，负责：
 *   · 启动流程：读设置 → 应用主题 → 拉数据 → 首次渲染
 *   · 视图渲染：首页 / 全部游戏 / 分类 / 收藏 / 最近 / 隐藏空间
 *   · 交互绑定：搜索、排序、视图切换、卡片点击、右键菜单
 *   · 事件订阅：扫描进度、数据变更、体积回填、游戏启停、自动上锁
 *   · 键盘快捷键与窗口控制
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const API = window.API;
  const { $, $$, el, fmtBytes, fmtDate, fmtDuration, applyGradient, initialOf, sourceMeta } = U;

  let ctxGame = null;   // 右键菜单当前指向的游戏

  /* ================================================================
   *  一、启动
   * ================================================================ */
  async function init() {
    bindWindowControls();
    bindSidebar();
    bindToolbar();
    bindSearch();
    bindKeyboard();
    bindDragGlobals();
    subscribeMainEvents();

    // 先本地应用主题，避免打开瞬间闪一下白
    const s = await API.settingsGet();
    setTheme((s && s.theme) || 'dark');

    // 外观自定义（字体 + 左右栏背景）也在这里尽早应用，
    // 否则界面会先按默认样式画一遍、再肉眼可见地跳一下。
    // 不 await：applyFont 是同步生效的，背景图慢慢加载也不挡首屏。
    if (window.Bg) {
      window.Bg.applyAll(s && s.ok !== false ? s : {}).catch(() => {});
    }

    await loadSettingsToUI();
    await refresh();

    setStatus('就绪', 'ok');
    updateStatusBar();

    // 首屏画完之后，按设置决定要不要自动联网补缺失的封面（不阻塞界面）
    maybeAutoSearchCovers().catch(() => {});
  }

  /* ================================================================
   *  二、数据刷新与渲染
   * ================================================================ */

  /**
   * 把设置里的界面偏好读进来，并同步到顶部的各个控件。
   * 必须在第一次渲染之前执行，否则用户上次选的排序 / 卡片大小会"跳回去"。
   */
  async function loadSettingsToUI() {
    const s = await API.settingsGet();
    if (!s || s.ok === false) return;
    const S = window.State;

    if (s.viewMode === 'grid' || s.viewMode === 'list') S.viewMode = s.viewMode;
    if (s.cardSize) S.cardSize = s.cardSize;
    if (s.sortBy) S.sort = `${s.sortBy}:${s.sortAsc ? 'asc' : 'desc'}`;

    // 同步排序下拉
    const sel = $('#sortSelect');
    if (sel) sel.value = S.sort;

    // 同步网格 / 列表切换
    $$('#viewToggle .vt-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.viewMode));

    // 同步卡片尺寸
    $$('#sizeToggle .sz-btn').forEach((b) => b.classList.toggle('active', b.dataset.size === S.cardSize));
  }

  /** 重新拉取数据并整体重绘 */
  async function refresh() {
    const ok = await window.State.load();
    if (!ok) {
      setStatus('数据加载失败', 'err');
      return;
    }
    applyThemeFromState();
    renderSidebar();
    renderContent();
    updateStatusBar();
  }

  /** 只重画侧栏（设置改动后调用） */
  function refreshSidebar() {
    renderSidebar();
  }

  /** 只重画内容区 */
  function renderContent() {
    const S = window.State;
    const body = $('#contentBody');
    const head = $('#contentHead');
    const isHome = S.view === 'home';

    // 标题栏状态
    $('#viewTitle').textContent = S.viewTitle();
    $('#viewHint').textContent = S.viewHint();
    head.hidden = false;

    // 统计页和平台页都有自己的一整套控件，顶部那些"来源筛选/排序/视图"在这里没意义，收起来
    const toolbar = $('#contentHead .ch-right');
    if (toolbar) toolbar.hidden = S.view === 'stats' || S.view === 'platform';

    body.innerHTML = '';

    /* ---------- 游玩统计 ---------- */
    if (S.view === 'stats') {
      $('#viewCount').textContent = '';
      window.StatsView.render(body);
      return;
    }

    /* ---------- 游戏平台 ---------- */
    if (S.view === 'platform') {
      $('#viewCount').textContent = '';
      window.PlatformView.render(body);
      return;
    }

    /* ---------- 隐藏空间上锁 → 显示解锁界面，不渲染任何游戏 ---------- */
    if (S.view === 'hidden' && !S.hidden.unlocked) {
      $('#viewCount').textContent = '';
      body.appendChild(lockScreenView());
      return;
    }

    /* ---------- 首页 ---------- */
    if (isHome && S.games.length) {
      renderHome();
      return;
    }

    /* ---------- 空库 ---------- */
    if (!S.games.length) {
      $('#viewCount').textContent = '';
      body.appendChild(emptyLibraryView());
      return;
    }

    /* ---------- 常规列表 ---------- */
    const list = S.visible();
    $('#viewCount').textContent = list.length + ' 款';

    if (!list.length) {
      body.appendChild(emptyFilterView());
      return;
    }

    if (S.viewMode === 'grid') {
      const grid = el('div', { class: 'game-grid', dataset: { size: S.cardSize } });
      list.forEach((g, i) => grid.appendChild(window.Cards.buildCard(g, i)));
      body.appendChild(grid);
      // 卡片右下角的成就角标要等平台快照，异步补
      window.Cards.decorateAchievements(grid, list);
    } else {
      const wrap = el('div', { class: 'game-list' });
      list.forEach((g, i) => wrap.appendChild(window.Cards.buildRow(g, i)));
      body.appendChild(wrap);
      window.Cards.decorateAchievements(wrap, list);
    }
  }

  /* ---------------- 首页：继续游戏 + 最近入库 + 收藏 ---------------- */
  function renderHome() {
    const S = window.State;
    const body = $('#contentBody');
    const visibleGames = S.games.filter((g) => !g.hidden);

    $('#viewCount').textContent = visibleGames.length + ' 款游戏';

    // 边界情况：库里有游戏，但可见的一共有 0 款（全被藏起来了）
    if (!visibleGames.length) {
      body.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-art', text: '🔒' }),
        el('div', { class: 'empty-title', text: '所有游戏都在隐藏空间里' }),
        el('div', { class: 'empty-desc', text: '当前可见的游戏为 0 款。进入隐藏空间可以查看和管理被隐藏的游戏。' }),
        el('div', { class: 'empty-actions' }, [
          el('button', { class: 'btn btn-primary', text: '前往隐藏空间', onclick: () => goto('hidden') }),
          el('button', { class: 'btn btn-ghost', text: '扫描新游戏', onclick: () => runScan() })
        ])
      ]));
      return;
    }

    // 继续游戏：玩过的按时间倒序
    const recent = visibleGames.filter((g) => g.lastPlayedAt > 0)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 12);
    if (recent.length) {
      const rail = el('div', { class: 'rail-scroll' }, recent.map((g) => window.Cards.buildRailCard(g)));
      body.appendChild(el('div', { class: 'rail-section' }, [
        el('div', { class: 'rail-head' }, [
          el('div', { class: 'rail-title', text: '继续游戏' }),
          el('button', {
            class: 'rail-more', text: '查看全部 →',
            onclick: () => goto('recent')
          })
        ]),
        rail
      ]));
    }

    // 最近入库
    const recentAdded = [...visibleGames].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 12);
    if (recentAdded.length) {
      const grid = el('div', { class: 'game-grid', dataset: { size: S.cardSize } });
      recentAdded.forEach((g, i) => grid.appendChild(window.Cards.buildCard(g, i)));
      body.appendChild(el('div', { class: 'rail-section' }, [
        el('div', { class: 'rail-head' }, [
          el('div', { class: 'rail-title', text: '最近入库' }),
          el('button', { class: 'rail-more', text: '查看全部 →', onclick: () => goto('all') })
        ]),
        grid
      ]));
      window.Cards.decorateAchievements(grid, recentAdded);
    }

    // 收藏
    const favs = visibleGames.filter((g) => g.favorite).slice(0, 8);
    if (favs.length) {
      const rail = el('div', { class: 'rail-scroll' }, favs.map((g) => window.Cards.buildRailCard(g)));
      body.appendChild(el('div', { class: 'rail-section' }, [
        el('div', { class: 'rail-head' }, [
          el('div', { class: 'rail-title', text: '我的收藏' }),
          el('button', { class: 'rail-more', text: '查看全部 →', onclick: () => goto('favorite') })
        ]),
        rail
      ]));
    }
  }

  /* ---------------- 各种空状态 ---------------- */

  function emptyLibraryView() {
    // 库是空的，但可能只是因为隐藏空间上锁了 —— 文案要说清楚，别让人以为游戏丢了
    const hiddenLocked = window.State.hidden.enabled && !window.State.hidden.unlocked;
    return el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-art', text: hiddenLocked ? '🔒' : '🎮' }),
      el('div', { class: 'empty-title', text: hiddenLocked ? '可见的游戏还在隐藏空间里' : '游戏库还是空的' }),
      el('div', {
        class: 'empty-desc',
        text: hiddenLocked
          ? '隐藏空间当前处于上锁状态，里面的游戏不会显示出来。输入密码后就能看到。'
          : '点下面的按钮，GameHub 会自动翻一遍系统注册表、Steam 和 Epic，把本机已安装的游戏找出来。找到后你自己勾选要收哪些。'
      }),
      el('div', { class: 'empty-actions' }, hiddenLocked ? [
        el('button', { class: 'btn btn-primary btn-lg', text: '解锁隐藏空间', onclick: () => goto('hidden') }),
        el('button', { class: 'btn btn-ghost btn-lg', text: '继续扫描新游戏', onclick: () => runScan() })
      ] : [
        el('button', { class: 'btn btn-primary btn-lg', text: '⟳ 自动嗅探本机游戏', onclick: () => runScan() }),
        el('button', { class: 'btn btn-ghost btn-lg', text: '📂 扫描指定文件夹', onclick: () => runScan({ pickFolder: true }) }),
        el('button', { class: 'btn btn-ghost btn-lg', text: '＋ 手动添加一款', onclick: () => window.Modals.addGame() })
      ])
    ]);
  }

  function emptyFilterView() {
    const S = window.State;
    const hasFilter = S.search.trim() || S.source !== 'all' || S.category;
    return el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-art', text: hasFilter ? '🔍' : '🗂' }),
      el('div', { class: 'empty-title', text: hasFilter ? '没有匹配的游戏' : '这个视图还是空的' }),
      el('div', {
        class: 'empty-desc',
        text: hasFilter
          ? '换个关键词，或者清掉筛选条件再看看。'
          : S.view === 'favorite' ? '在游戏上右键 →「加入收藏」，它就会出现在这里。'
            : S.view === 'recent' ? '启动过游戏之后，这里会显示最近玩过的记录。'
              : '这个分类下暂时没有游戏。'
      }),
      el('div', { class: 'empty-actions' }, hasFilter ? [
        el('button', {
          class: 'btn btn-primary', text: '清空筛选',
          onclick: () => { clearFilters(); }
        })
      ] : [
        el('button', { class: 'btn btn-primary', text: '去看全部游戏', onclick: () => goto('all') })
      ])
    ]);
  }

  /** 隐藏空间未解锁时的界面 */
  function lockScreenView() {
    const pwd = el('input', { class: 'input lock-input', type: 'password', placeholder: '请输入密码' });
    const msg = el('div', { class: 'lock-hint' });
    const h = window.State.hidden;

    const tryUnlock = async () => {
      const r = await API.hiddenUnlock(pwd.value);
      if (r && r.ok) {
        toast('已解锁隐藏空间', 'success');
        await refresh();
      } else {
        msg.textContent = (r && r.error) || '密码不正确';
        msg.classList.add('error');
        pwd.select();
      }
    };
    pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

    // 还没设置过密码：直接引导去启用，不要摆一个用不了的密码框。
    // （之前这里无论有没有启用都显示"已上锁"，标题和说明自相矛盾。）
    if (!h.enabled) {
      return el('div', { class: 'lock-screen' }, [
        el('div', { class: 'lock-icon', text: '🔒' }),
        el('div', { class: 'lock-title', text: '隐藏空间还没启用' }),
        el('div', {
          class: 'lock-desc',
          text: '设一个密码就能把不想被别人看到的游戏藏起来，打开时需要输入密码。'
        }),
        el('div', { class: 'lock-form' }, [
          el('button', {
            class: 'btn btn-primary btn-lg', text: '启用隐藏空间',
            onclick: () => window.Modals.hiddenSpace()
          }),
          el('button', {
            class: 'btn btn-ghost', text: '了解隐藏空间',
            onclick: () => window.App.toast('隐藏的游戏会从所有列表里消失，只有输入密码后才能看到', 'info')
          })
        ])
      ]);
    }

    const node = el('div', { class: 'lock-screen' }, [
      el('div', { class: 'lock-icon', text: '🔐' }),
      el('div', { class: 'lock-title', text: '隐藏空间已上锁' }),
      el('div', {
        class: 'lock-desc',
        text: h.hasHint && h.hint ? `密码提示：${h.hint}` : '输入密码后即可查看被隐藏的游戏。'
      }),
      el('div', { class: 'lock-form' }, [
        pwd,
        el('button', { class: 'btn btn-primary', text: '解锁', onclick: tryUnlock }),
        el('button', {
          class: 'btn btn-ghost', text: '隐藏空间设置',
          onclick: () => window.Modals.hiddenSpace()
        }),
        msg
      ])
    ]);
    setTimeout(() => pwd.focus(), 80);
    return node;
  }

  /* ================================================================
   *  三、侧栏
   * ================================================================ */
  function renderSidebar() {
    const S = window.State;
    const c = S.counts();

    $('#cntAll').textContent = c.all;
    $('#cntRecent').textContent = c.recent;
    $('#cntFav').textContent = c.favorite;

    // 运行中入口：只在真的有游戏在跑时才出现
    const navRunning = $('#navRunning');
    if (c.running > 0) {
      navRunning.hidden = false;
      $('#cntRunning').textContent = c.running;
    } else {
      navRunning.hidden = true;
      if (S.view === 'running') goto('all');
    }

    // 分类列表
    const host = $('#sideCategories');
    host.innerHTML = '';
    const cats = S.categories.filter((x) => x.name);
    if (!cats.length) {
      host.appendChild(el('div', { class: 'form-desc', style: { padding: '6px 9px' }, text: '导入游戏后会自动分类' }));
    }
    for (const cat of cats) {
      const btn = el('button', {
        class: 'side-item' + (S.view === 'category' && S.category === cat.name ? ' active' : ''),
        title: cat.custom ? '自定义分类（右键可重命名 / 删除）' : '自动识别的分类（右键可重命名）',
        onclick: () => gotoCategory(cat.name),
        // 右键分类 → 重命名 / 删除，这就是"管理自定义分类"的入口
        oncontextmenu: (e) => { e.preventDefault(); showCategoryMenu(e.clientX, e.clientY, cat); }
      }, [
        el('span', { class: 'si-icon', text: cat.custom ? '◆' : '·' }),
        el('span', { class: 'si-label', text: cat.name }),
        el('span', { class: 'si-count', text: cat.count })
      ]);
      host.appendChild(btn);
    }

    // 隐藏空间入口
    const h = S.hidden;
    const entry = $('#hiddenEntry');
    $('#hiddenEntryTitle').textContent = '隐藏空间';
    if (!h.enabled) {
      entry.classList.remove('unlocked');
      $('#hiddenEntryIcon').textContent = '🔒';
      $('#hiddenEntrySub').textContent = '未启用 · 点击设置密码';
    } else if (h.unlocked) {
      entry.classList.add('unlocked');
      $('#hiddenEntryIcon').textContent = '🔓';
      $('#hiddenEntrySub').textContent = `已解锁 · ${h.hiddenCount} 款隐藏游戏`;
    } else {
      entry.classList.remove('unlocked');
      $('#hiddenEntryIcon').textContent = '🔒';
      $('#hiddenEntrySub').textContent = '已上锁 · 需要密码';
    }

    // 主视图高亮（游戏库 + 游戏平台两个导航块一起管）
    $$('#sideNav .side-item, #platformNav .side-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.view === S.view);
    });

    // 顶部标题栏的「游戏库 / 游戏平台」跟着当前视图高亮
    $$('.titlebar-nav .tb-nav-btn').forEach((n) => {
      const want = n.dataset.nav === 'platform' ? 'platform' : 'library';
      const on = (want === 'platform') ? S.view === 'platform' : S.view !== 'platform';
      n.classList.toggle('active', on);
    });
  }

  /* ================================================================
   *  四、视图导航
   * ================================================================ */
  function goto(view) {
    const S = window.State;
    if (view !== 'category') S.category = null;
    S.view = view;
    renderSidebar();
    renderContent();
    $('#contentBody').scrollTop = 0;
  }

  function gotoCategory(name) {
    window.State.view = 'category';
    window.State.category = name;
    renderSidebar();
    renderContent();
    $('#contentBody').scrollTop = 0;
  }

  function clearFilters() {
    window.State.search = '';
    window.State.source = 'all';
    window.State.category = null;
    window.State.view = 'all';
    $('#searchInput').value = '';
    $('#sideFilter').value = '';
    $('#searchClear').hidden = true;
    $$('#sourceFilter .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.src === 'all'));
    renderSidebar();
    renderContent();
  }

  /* ================================================================
   *  五、事件绑定
   * ================================================================ */

  /* ---------------- 窗口控制 ---------------- */
  function bindWindowControls() {
    $('#winMin').onclick = () => API.minimize();
    $('#winMax').onclick = () => API.maximize();
    $('#winClose').onclick = () => API.close();
    $('#btnTheme').onclick = () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      setTheme(next);
      API.settingsSet({ theme: next });
    };
    $('#btnSettings').onclick = () => window.Modals.settings();
    $('#btnScanTop').onclick = () => runScan();
  }

  /* ---------------- 侧栏 ---------------- */
  function bindSidebar() {
    $$('#sideNav .side-item, #platformNav .side-item').forEach((btn) => {
      btn.onclick = () => goto(btn.dataset.view);
    });

    // 顶部标题栏导航：游戏库 ↔ 游戏平台
    // （原来这里的「待玩清单」是个没有绑定任何事件的空按钮，点下去毫无反应，
    //   索性换成真正有内容的「游戏平台」，跟侧栏入口保持一致。）
    $$('.titlebar-nav .tb-nav-btn').forEach((btn) => {
      btn.onclick = () => goto(btn.dataset.nav === 'platform' ? 'platform' : 'home');
    });

    $('#hiddenEntry').onclick = async () => {
      const S = window.State;
      // 还没设置过密码 → 直接进设置引导
      if (!S.hidden.enabled) { window.Modals.hiddenSpace(); return; }
      // 已启用 → 进入隐藏空间视图（上锁时会显示解锁界面）
      goto('hidden');
    };

    $('#btnAddGame').onclick = () => window.Modals.addGame();
    $('#btnScanSide').onclick = () => runScan();
    $('#btnCategoryHint').onclick = () => {
      toast('分类是按游戏名称里的关键词自动识别的。可以自己新建分类，一款游戏也能同时属于多个分类；右键分类可重命名或删除。', 'info', 7000);
    };
    // 新建自定义分类
    $('#btnAddCategory').onclick = () => window.Modals.promptCategory({ mode: 'add' });

    // 侧栏筛选框
    const sideFilter = $('#sideFilter');
    sideFilter.addEventListener('input', U.debounce(() => {
      window.State.search = sideFilter.value;
      $('#searchInput').value = sideFilter.value;
      $('#searchClear').hidden = !sideFilter.value;
      renderContent();
    }, 200));
  }

  /* ---------------- 顶部工具条 ---------------- */
  function bindToolbar() {
    // 来源筛选
    $$('#sourceFilter .seg-btn').forEach((btn) => {
      btn.onclick = () => {
        window.State.source = btn.dataset.src;
        $$('#sourceFilter .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        renderContent();
      };
    });

    // 排序
    const sortSel = $('#sortSelect');
    sortSel.value = window.State.sort;
    sortSel.onchange = () => {
      window.State.sort = sortSel.value;
      const [k, d] = sortSel.value.split(':');
      API.settingsSet({ sortBy: k, sortAsc: d === 'asc' });
      renderContent();
    };

    // 网格 / 列表
    $$('#viewToggle .vt-btn').forEach((btn) => {
      btn.onclick = () => {
        window.State.viewMode = btn.dataset.mode;
        $$('#viewToggle .vt-btn').forEach((b) => b.classList.toggle('active', b === btn));
        API.settingsSet({ viewMode: btn.dataset.mode });
        renderContent();
      };
    });

    // 卡片尺寸
    $$('#sizeToggle .sz-btn').forEach((btn) => {
      btn.onclick = () => {
        window.State.cardSize = btn.dataset.size;
        $$('#sizeToggle .sz-btn').forEach((b) => b.classList.toggle('active', b === btn));
        API.settingsSet({ cardSize: btn.dataset.size });
        renderContent();
      };
    });

    // 更多选项（批量处理整个游戏库）
    bindMoreMenu();
  }

  /* ---------------- 更多选项菜单 ---------------- */
  function bindMoreMenu() {
    const btn = $('#btnMore');
    const menu = $('#moreMenu');
    if (!btn || !menu) return;

    btn.onclick = (e) => {
      e.stopPropagation();
      if (menu.hidden) { paintMoreMenu(); menu.hidden = false; btn.classList.add('open'); }
      else hideMoreMenu();
    };
    // 点菜单内部不要冒泡到 document，否则会被"点空白处收起"的逻辑立刻关掉
    menu.addEventListener('click', (e) => e.stopPropagation());
  }

  function hideMoreMenu() {
    const menu = $('#moreMenu');
    const btn = $('#btnMore');
    if (menu) menu.hidden = true;
    if (btn) btn.classList.remove('open');
  }

  function paintMoreMenu() {
    const menu = $('#moreMenu');
    if (!menu) return;
    menu.innerHTML = '';

    const items = [
      {
        icon: '🌐', text: '联网搜索缺失封面', desc: '只给没有封面的游戏联网找封面，搜不到自动跳过',
        fn: () => runSearchMissingCovers()
      },
      {
        icon: '⬇', text: '重新抓取全部 Steam 封面', desc: '已有封面也会被 Steam 官方图覆盖（自己设的不动）',
        fn: () => runSteamCoversAll()
      },
      { sep: true },
      { icon: '🖼', text: '批量提取程序图标当封面', desc: '离线可用，对没有官方封面的游戏兜底', fn: () => runExtractAllIcons() },
      { icon: '🔄', text: '重新计算全部体积', desc: '重新统计每个安装目录占用的空间', fn: () => runCalcAllSizes() },
      { sep: true },
      { icon: '🔐', text: '隐藏空间设置', fn: () => window.Modals.hiddenSpace() },
      { sep: true },
      {
        icon: '🗑', text: '批量删除游戏', desc: '勾选多款一次性从库中移除（不动磁盘文件）',
        fn: () => window.Modals.batchRemove()
      },
      { icon: '⚙', text: '设置', desc: '自定义外观、嗅探、封面联网搜索等选项', fn: () => window.Modals.settings() }
    ];

    for (const it of items) {
      if (it.sep) { menu.appendChild(el('div', { class: 'more-sep' })); continue; }
      menu.appendChild(el('button', {
        class: 'more-item',
        onclick: (e) => { e.stopPropagation(); hideMoreMenu(); it.fn(); }
      }, [
        el('span', { class: 'mi-icon', text: it.icon }),
        el('span', { class: 'mi-body' }, [
          el('span', { class: 'mi-text', text: it.text }),
          it.desc ? el('span', { class: 'mi-desc', text: it.desc }) : null
        ].filter(Boolean))
      ]));
    }
  }

  /**
   * 批量：自动从 Steam 获取封面。
   * 主进程会跳过"用户自己设过封面"和"Steam 搜不到"的游戏，
   * 中途通过 cover:progress 事件把进度打到状态栏。
   */
  async function runSteamCoversAll() {
    if (window.State.busy) { toast('已有任务在进行中', 'warn'); return; }
    const total = window.State.games.filter((g) => !g.hidden).length;
    if (!total) { toast('游戏库里还没有游戏', 'warn'); return; }

    window.State.busy = true;
    $('#scanBar').hidden = false;
    setStatus(`正在从 Steam 查找封面（共 ${total} 款）…`, 'busy');

    const r = await API.coverSteamAll();
    endScanUI();

    if (!r || r.ok === false) {
      setStatus('获取封面失败', 'err');
      toast((r && r.error) || '获取封面失败', 'error');
      return;
    }
    await refresh();

    const skipped = r.skipped || [];
    if (r.fetched > 0) {
      setStatus(`封面更新完成：成功 ${r.fetched} 款`, 'ok');
      // 把跳过的原因也讲清楚，否则用户会以为功能坏了
      const notFound = skipped.filter((s) => s.reason === 'Steam 上没搜到');
      const noImage = skipped.filter((s) => s.reason === 'Steam 图床没有可用封面');
      const custom = skipped.filter((s) => s.reason === '用户自定义封面');
      const detail = [
        notFound.length ? `${notFound.length} 款在 Steam 上没搜到` : '',
        noImage.length ? `${noImage.length} 款没有可用封面` : '',
        custom.length ? `${custom.length} 款保留了你自定义的封面` : ''
      ].filter(Boolean).join('，');
      toast(`已更新 ${r.fetched} 款封面${detail ? '；' + detail : ''}`, 'success', 6500);
      window.Detail.refreshIfOpen();
    } else {
      setStatus('没有找到可用的 Steam 封面', 'warn');
      toast('这些游戏在 Steam 上都没搜到对应条目，已全部跳过。可以试试批量提取程序图标。', 'warn', 7000);
    }
  }

  /**
   * 联网搜索「没有封面」的游戏的封面 —— 设置面板和更多选项都走这一个入口。
   * ----------------------------------------------------------------
   * 行为严格按「搜索不到就算了」来：
   *   · 只排没有封面的游戏（可选的 coverUpgradeIcon 会把程序图标也一并升级）
   *   · 主进程逐个去 Steam 按名字查 AppID，查到就下载官方竖版封面
   *   · 查不到 / 图床没图 / 用户自定义过的 → 静默跳过，只在汇总里露个数字
   *
   * @param {{silent?:boolean, includeIcon?:boolean}} [opts]
   *        silent     = 不在状态栏刷进度、没成果时也不弹提示（启动时的自动任务用）
   *        includeIcon= 强制把「只有程序图标」的游戏也算作缺封面
   * @returns {Promise<object|null>} 主进程返回的结果；无事可做时返回 null
   */
  async function runSearchMissingCovers(opts = {}) {
    if (window.State.busy) { toast('已有任务在进行中', 'warn'); return null; }

    const includeIcon = !!opts.includeIcon || !!(window.State.settings || {}).coverUpgradeIcon;
    // 前端直接先筛一遍：跟主进程的 needsCover 同一套规则，
    // 这样"已经全都有的情况下"连一次 IPC 都不用发。
    const needs = (g) => {
      if (g.coverKind === 'custom' && g.coverPath) return false;
      if (!g.coverPath) return true;
      return includeIcon && g.coverKind === 'icon';
    };
    const targets = window.State.games.filter(needs);
    if (!targets.length) {
      if (!opts.silent) toast('所有游戏都有封面了，不用补', 'info');
      return null;
    }

    window.State.busy = true;
    $('#scanBar').hidden = false;
    setStatus(`正在联网搜索封面（共 ${targets.length} 款缺封面）…`, 'busy');

    const r = await API.coverFillMissing({ includeIcon });
    endScanUI();
    await refresh();
    window.Detail.refreshIfOpen();

    if (!r || r.ok === false) {
      setStatus('封面联网搜索失败', 'err');
      if (!opts.silent) toast((r && r.error) || '封面联网搜索失败', 'error');
      return r;
    }

    const got = r.fetched || 0;
    const skipped = r.skipped || [];
    if (r.cancelled) {
      setStatus('已停止搜索封面', 'warn');
      if (!opts.silent) toast(`已停止，本次补上了 ${got} 款封面`, 'info');
      return r;
    }
    if (got > 0) {
      setStatus(`已联网补上 ${got} 款封面`, 'ok');
      if (!opts.silent) {
        const notFound = skipped.filter((s) => s.reason === '没搜到').length;
        const noImage = skipped.filter((s) => s.reason === '图床没有可用封面').length;
        const detail = [
          notFound ? `${notFound} 款搜不到已跳过` : '',
          noImage ? `${noImage} 款图床没有封面` : ''
        ].filter(Boolean).join('，');
        toast(`已补上 ${got} 款封面${detail ? '；' + detail : ''}`, 'success', 6500);
      }
    } else {
      setStatus('没有搜到可用的联网封面', 'warn');
      if (!opts.silent) {
        toast(`这 ${targets.length} 款游戏都没搜到官方封面，已全部跳过。可以试试批量提取程序图标当封面。`, 'warn', 6500);
      }
    }
    return r;
  }

  /**
   * 启动时的自动补封面任务。
   * 延后两秒再跑：一来让首屏先画完，二来如果用户一上来就手动扫盘，
   * 那边会先把 busy 顶起来，这里检测到就自动放弃，不抢资源。
   */
  async function maybeAutoSearchCovers() {
    const s = window.State.settings || {};
    if (s.autoSearchCoverOnline === false || window.State.busy) return;
    await new Promise((r) => setTimeout(r, 2000));
    if (window.State.busy) return;
    await runSearchMissingCovers({ silent: true });
  }

  /** 批量：把所有缺封面的游戏退化成 exe 图标 */
  async function runExtractAllIcons() {
    if (window.State.busy) { toast('已有任务在进行中', 'warn'); return; }
    const missing = window.State.games.filter((g) => !g.hidden && !g.coverUrl);
    if (!missing.length) { toast('所有游戏都有封面了', 'info'); return; }

    window.State.busy = true;
    $('#scanBar').hidden = false;
    setStatus(`正在提取程序图标（共 ${missing.length} 款）…`, 'busy');
    const r = await API.coverExtractAll();
    endScanUI();
    await refresh();
    setStatus('图标提取完成', 'ok');
    toast(`已为 ${(r && r.done) || 0} 款游戏提取了程序图标`, 'success');
  }

  /** 批量：重新计算全部游戏的安装体积 */
  async function runCalcAllSizes() {
    const ids = window.State.games.filter((g) => !g.hidden && g.installDir).map((g) => g.id);
    if (!ids.length) { toast('没有可以计算体积的游戏（缺少安装目录）', 'warn'); return; }
    toast(`正在后台重算 ${ids.length} 款游戏的体积，完成后会逐个刷新`, 'info', 5000);
    await API.calcSize(ids);
  }

  /* ---------------- 搜索 ---------------- */
  function bindSearch() {
    const input = $('#searchInput');
    const clear = $('#searchClear');

    input.addEventListener('input', U.debounce(() => {
      window.State.search = input.value;
      $('#sideFilter').value = input.value;
      clear.hidden = !input.value;
      // 搜索时自动跳到一个能看全结果的视图
      if (input.value && (window.State.view === 'home')) window.State.view = 'all';
      renderSidebar();
      renderContent();
    }, 200));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; input.dispatchEvent(new Event('input')); input.blur(); }
    });

    clear.onclick = () => {
      input.value = '';
      window.State.search = '';
      $('#sideFilter').value = '';
      clear.hidden = true;
      renderContent();
    };
  }

  /* ---------------- 快捷键 ---------------- */
  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+F 聚焦搜索
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        $('#searchInput').focus();
        $('#searchInput').select();
      }
      // Ctrl+, 打开设置（跟大多数桌面软件一个习惯）
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        window.Modals.settings();
      }
      // Ctrl+R 重新扫描
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        runScan();
      }
      // Esc 关掉各种浮层
      if (e.key === 'Escape') { hideCtxMenu(); hideMoreMenu(); }
    });
    // 点空白处收起浮层
    document.addEventListener('click', () => { hideCtxMenu(); hideMoreMenu(); });
    window.addEventListener('blur', () => { hideCtxMenu(); hideMoreMenu(); });
  }

  /* ---------------- 全局拖拽（防止 Electron 打开被拖入的文件） ---------------- */
  function bindDragGlobals() {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  /* ================================================================
   *  六、卡片交互（供 cards.js 调用）
   * ================================================================ */

  /**
   * 给一张卡片/列表行绑上点击、双击、右键、拖拽换封面等交互
   * @param {HTMLElement} node
   * @param {object} g 游戏对象
   */
  function bindCardEvents(node, g) {
    // 单击 → 详情页
    node.addEventListener('click', (e) => {
      // ⚠ 卡片里的这些小按钮都有自己的动作，不能顺带把详情页也打开。
      //   ⋮ 的 onclick 里已经 stopPropagation 了，这里再兜一道：
      //   stopPropagation 只拦得住"同一个元素上的其他监听"，元素本身冒泡到这里
      //   仍然会走一遍，两处都写才稳。
      if (e.target.closest('.mini-play, .rc-play, .gr-play, .gr-more, .card-more')) return;
      window.Detail.open(g.id);
    });

    // 双击 → 直接启动（Steam 也是这个习惯）
    node.addEventListener('dblclick', (e) => {
      // 双击 ⋮ 会命中 dblclick 把游戏直接启动起来，这里必须放过它
      if (e.target.closest('.card-more, .gr-more')) return;
      e.preventDefault();
      launch(g.id);
    });

    // 右键 → 上下文菜单
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, g);
    });

    // 直接把图片拖到卡片上换封面
    node.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    node.addEventListener('drop', async (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file || !/^image\//.test(file.type)) return;
      e.preventDefault();
      e.stopPropagation();
      const reader = new FileReader();
      reader.onload = async () => {
        const r = await API.coverFromData(g.id, reader.result);
        if (r && r.ok) {
          toast(`「${g.name}」封面已更新`, 'success');
          await refresh();
        } else {
          toast((r && r.error) || '设置封面失败', 'error');
        }
      };
      reader.readAsDataURL(file);
    });
  }

  /* ================================================================
   *  七、右键菜单
   * ================================================================ */
  function showCtxMenu(x, y, g) {
    ctxGame = g;
    const menu = $('#ctxMenu');
    menu.innerHTML = '';

    const items = [
      { icon: '▶', text: window.State.running[g.id] ? '正在运行中' : '启动游戏', fn: () => launch(g.id) },
      { icon: '⏹', text: '结束游戏进程', fn: () => stopGame(g.id), hide: !window.State.running[g.id] },
      { sep: true },
      { icon: '📄', text: '查看详情', fn: () => window.Detail.open(g.id) },
      { icon: '📁', text: '打开安装目录', fn: () => API.openFolder(g.id) },
      { icon: '📋', text: '复制安装路径', fn: () => copyText(g.installDir || g.exePath) },
      { sep: true },
      { icon: g.favorite ? '☆' : '★', text: g.favorite ? '取消收藏' : '加入收藏', fn: () => toggleFavorite(g) },
      {
        icon: g.hidden ? '🔓' : '🔒',
        text: g.hidden ? '移出隐藏空间' : '隐藏这个游戏',
        fn: () => toggleHidden(g)
      },
      { sep: true },
      { icon: '🖼', text: '提取程序图标当封面', fn: () => quickCover(g, () => API.coverExtract(g.id)) },
      {
        icon: '⬇', text: '从 Steam 获取封面', hide: !g.steamAppId,
        fn: () => quickCover(g, () => API.coverSteam(g.id))
      },
      { icon: '🔄', text: '重新计算体积', fn: () => API.calcSize([g.id]) },
      { icon: '✎', text: '编辑信息', fn: () => window.Modals.editGame(g.id) },
      { sep: true },
      { icon: '📦', text: '卸载游戏…', fn: () => window.Modals.uninstallGame(g.id) },
      { icon: '🗑', text: '从库中移除', danger: true, fn: () => window.Modals.confirmRemove([g.id], g.name) }
    ];

    for (const it of items) {
      if (it.hide) continue;
      if (it.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); continue; }
      menu.appendChild(el('button', {
        class: 'ctx-item' + (it.danger ? ' danger' : ''),
        onclick: (e) => { e.stopPropagation(); hideCtxMenu(); it.fn(); }
      }, [el('span', { class: 'ctx-icon', text: it.icon }), el('span', { text: it.text })]));
    }

    // 显示并做边界修正，保证菜单不会跑出窗口
    showMenuAt(menu, x, y);
  }

  /**
   * 卡片右上角「⋮ 更多选项」的菜单。
   *
   * 复用右键菜单那个 `#ctxMenu` 浮层节点 —— 同时只会有一个菜单开着，
   * 再造一个浮层就要处理"两个菜单互相打架"的问题，不划算。
   *
   * @param {number} x 视口坐标（一般传 ⋮ 按钮的右下角）
   * @param {number} y
   * @param {object} g 游戏对象
   */
  function showClearMenu(x, y, g) {
    ctxGame = g;
    const menu = $('#ctxMenu');
    if (!menu) return;
    menu.innerHTML = '';

    const meta = (window.Cards && window.Cards.CLEAR_META) || {};
    const order = (window.Cards && window.Cards.CLEAR_ORDER) || Object.keys(meta);

    // 顶部一行小标题：让用户知道自己正在给哪一款打标记
    menu.appendChild(el('div', { class: 'ctx-head' }, [
      el('span', { class: 'ctx-head-name', text: g.name, title: g.name }),
      el('span', { class: 'ctx-head-tag', text: '通关状态' })
    ]));
    menu.appendChild(el('div', { class: 'ctx-sep' }));

    for (const key of order) {
      const m = meta[key];
      if (!m) continue;
      const on = g.clearState === key;
      menu.appendChild(el('button', {
        class: 'ctx-item ctx-clear' + (on ? ' is-on' : ''),
        title: on ? `当前就是「${m.label}」` : `标记为「${m.label}」`,
        onclick: (e) => {
          e.stopPropagation();
          hideCtxMenu();
          setClearState(g, key);
        }
      }, [
        el('span', { class: 'ctx-icon ctx-clear-icon ' + m.cls, text: on ? '✓' : m.icon }),
        el('span', { class: 'ctx-clear-text', text: m.label }),
        on ? el('span', { class: 'ctx-check', text: '当前' }) : null
      ].filter(Boolean)));
    }

    showMenuAt(menu, x, y);
  }

  /**
   * 写入通关状态。
   *
   * 有意做成"只刷这一张卡"：`App.refresh()` 会整页重绘，滚动位置和入场动画都会重置。
   * 为了让它真的落到实处，IPC 那一层还要带 `silent` 关掉 library:changed 广播
   * —— 广播一响，前端照样会整页重绘，这里的局部刷新就白做了。
   *
   * @param {object} g
   * @param {'cleared'|'multi'|'uncleared'} state
   */
  async function setClearState(g, state) {
    if ((g.clearState || '') === state) {
      toast(`「${g.name}」已经是这个状态了`, 'info');
      return;
    }

    const r = await API.update(g.id, { clearState: state }, { silent: true });
    if (!r || r.clearState !== state) { toast('标记失败', 'error'); return; }

    // 主进程会把整条游戏对象回传，用它覆盖本地对象，保证和磁盘一致
    const live = window.State.games.find((x) => x.id === g.id);
    if (live) live.clearState = r.clearState;
    g.clearState = r.clearState;

    if (window.Cards) window.Cards.refreshClear(g);

    const meta = (window.Cards && window.Cards.CLEAR_META) || {};
    toast(`「${g.name}」已标记为${(meta[state] && meta[state].label) || state}`, 'success');
  }

  /** 把菜单摆到 (x, y)，并做边界修正，保证不会跑出窗口 */
  function showMenuAt(menu, x, y) {
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 8);
    const py = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
  }

  function hideCtxMenu() {
    const menu = $('#ctxMenu');
    if (menu) menu.hidden = true;
    ctxGame = null;
  }

  /**
   * 分类的右键菜单：重命名 / 删除 / 新建。
   * 复用同一个浮层节点，避免多套菜单互相打架。
   */
  function showCategoryMenu(x, y, cat) {
    ctxGame = null;
    const menu = $('#ctxMenu');
    menu.innerHTML = '';

    const items = [
      { icon: '▸', text: `查看「${cat.name}」下的游戏`, fn: () => gotoCategory(cat.name) },
      { sep: true },
      { icon: '✎', text: '重命名这个分类', fn: () => window.Modals.promptCategory({ mode: 'rename', name: cat.name }) },
      { icon: '＋', text: '新建分类', fn: () => window.Modals.promptCategory({ mode: 'add' }) },
      {
        icon: '🗑', text: '删除这个分类', danger: true,
        fn: () => window.Modals.confirmRemoveCategory(cat.name, cat.count)
      }
    ];

    for (const it of items) {
      if (it.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); continue; }
      menu.appendChild(el('button', {
        class: 'ctx-item' + (it.danger ? ' danger' : ''),
        onclick: (e) => { e.stopPropagation(); hideCtxMenu(); it.fn(); }
      }, [el('span', { class: 'ctx-icon', text: it.icon }), el('span', { text: it.text })]));
    }

    showMenuAt(menu, x, y);
  }

  /* ================================================================
   *  八、动作
   * ================================================================ */

  /** 启动游戏 */
  async function launch(id) {
    const g = window.State.games.find((x) => x.id === id);
    if (!g) return;
    if (window.State.running[id]) { toast(`「${g.name}」已经在运行了`, 'warn'); return; }

    setStatus(`正在启动「${g.name}」…`, 'busy');
    const r = await API.launch(id);

    if (r && r.ok) {
      toast(`正在启动「${g.name}」`, 'success');
      // 先本地乐观标记，避免等下一次轮询才显示"运行中"
      window.State.running[id] = { startAt: Date.now(), elapsedMs: 0 };
      renderContent();
      renderSidebar();
    } else {
      setStatus('启动失败', 'err');
      toast((r && r.error) || '启动失败', 'error', 7000);
    }
  }

  /** 结束游戏进程 */
  async function stopGame(id) {
    const g = window.State.games.find((x) => x.id === id);
    if (!g) return;
    const idx = await API.message({
      type: 'warning',
      title: '结束游戏进程',
      message: `确定要强制结束「${g.name}」吗？`,
      detail: '未保存的游戏进度可能会丢失。',
      buttons: ['取消', '强制结束'],
      defaultId: 1,
      cancelId: 0
    });
    if (idx !== 1) return;
    const r = await API.stop(id);
    if (r && r.ok) {
      delete window.State.running[id];
      renderSidebar();
      renderContent();
      toast('已结束游戏进程', 'success');
    } else {
      toast((r && r.error) || '结束进程失败', 'error');
    }
  }

  /** 收藏切换 */
  async function toggleFavorite(g) {
    await API.update(g.id, { favorite: !g.favorite });
    toast(g.favorite ? '已取消收藏' : '已加入收藏', 'success');
    await refresh();
  }

  /**
   * 隐藏 / 移出隐藏
   * 没启用隐藏空间时会先引导去设置密码。
   */
  async function toggleHidden(g) {
    if (g.hidden) {
      const r = await API.hiddenSet([g.id], false);
      if (r && r.ok) {
        toast(`「${g.name}」已移出隐藏空间`, 'success');
        await refresh();
        window.Detail.refreshIfOpen();
      }
      return;
    }
    if (!window.State.hidden.enabled) {
      toast('还没有启用隐藏空间，先设置一个密码吧', 'info');
      window.Modals.hiddenSpace();
      return;
    }
    const r = await API.hiddenSet([g.id], true);
    if (r && r.ok) {
      toast(`「${g.name}」已隐藏，可在隐藏空间里找到`, 'success');
      await refresh();
      window.Detail.refreshIfOpen();
    } else {
      toast((r && r.message) || (r && r.error) || '隐藏失败', 'error');
    }
  }

  /** 封面类小工具：执行后统一提示 */
  async function quickCover(g, action) {
    const r = await action();
    if (r && r.ok) { toast('封面已更新', 'success'); await refresh(); }
    else toast((r && r.error) || '操作失败', 'error');
  }

  /** 复制文本到剪贴板 */
  async function copyText(text) {
    if (!text) { toast('没有可复制的路径', 'warn'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('路径已复制到剪贴板', 'success');
    } catch {
      toast('复制失败', 'error');
    }
  }

  /* ================================================================
   *  九、扫描流程
   * ================================================================ */

  /**
   * 发起扫描。
   * @param {object} [opts]
   *   pickFolder: true   → 先弹文件夹选择器，只扫用户指定的目录
   *   dirs: string[]     → 直接扫这些目录（"自动添加"二级页面用）
   *   onList: (list)=>void → 拿到结果后交给调用方处理，而不是弹默认的扫描结果弹窗
   */
  async function runScan(opts = {}) {
    if (window.State.busy) { toast('已有扫描任务在进行中', 'warn'); return; }

    // 显示进度条
    window.State.busy = true;
    $('#scanBar').hidden = false;
    setStatus('准备扫描…', 'busy');

    let r;
    if (opts.pickFolder) {
      const dirs = await API.pickFolders();
      if (!dirs || dirs.ok === false || !dirs.length) { endScanUI(); return; }
      r = await API.scanFolder({ dirs, mode: opts.mode || 'smart' });
    } else if (opts.dirs && opts.dirs.length) {
      r = await API.scanFolder({ dirs: opts.dirs, mode: opts.mode || 'smart' });
    } else {
      r = await API.scanAuto({ folders: window.State.settings.scanFolders || [] });
    }

    endScanUI();

    if (!r || r.ok === false) {
      toast((r && r.error) || '扫描失败', 'error');
      setStatus('扫描失败', 'err');
      return;
    }

    const list = r.list || [];
    if (!list.length) {
      toast('没有发现新的游戏。可以换个目录再试试。', 'warn', 6000);
      setStatus('扫描完成：没有新发现', 'ok');
      opts.onList && opts.onList([]);
      return;
    }
    setStatus(`扫描完成：发现 ${list.length} 个候选`, 'ok');
    // 交给调用方自己处理（比如画在"自动添加"页面里），否则弹默认的扫描结果窗口
    if (opts.onList) opts.onList(list);
    else window.Modals.scanResults(list);
  }

  function endScanUI() {
    window.State.busy = false;
    $('#scanBar').hidden = true;
    $('#scanBarFill').style.width = '0%';
    $('#scanText').textContent = '';
  }

  /* ================================================================
   *  十、主进程事件订阅
   * ================================================================ */
  function subscribeMainEvents() {
    // 扫描进度
    window.GameHub.on('scan:progress', (p) => {
      if (!p) return;
      $('#scanBar').hidden = false;
      setStatus(p.message || '扫描中…', 'busy');
      $('#scanText').textContent = p.message || '';
      if (p.total && p.current) {
        $('#scanBarFill').style.width = Math.min(100, Math.round((p.current / p.total) * 100)) + '%';
      } else {
        // 没有明确总量时用一条不确定进度条
        const cur = parseFloat($('#scanBarFill').style.width) || 0;
        $('#scanBarFill').style.width = ((cur + 12) % 100) + '%';
      }
    });

    // 数据变化 → 重新拉取
    window.GameHub.on('library:changed', async () => {
      await refresh();
      window.Detail.refreshIfOpen();
    });

    // 体积计算完成 → 局部更新，不重绘整面墙（避免闪烁）
    window.GameHub.on('size:updated', ({ id, sizeBytes }) => {
      const g = window.State.games.find((x) => x.id === id);
      if (!g) return;
      g.sizeBytes = sizeBytes;
      updateCardSizeText(id, sizeBytes);
      updateStatusBar();
    });

    // 游戏启停状态
    window.GameHub.on('game:state', (p) => {
      if (!p) return;
      if (p.action === 'launch') {
        window.State.running[p.id] = { startAt: p.startAt, elapsedMs: 0 };
        renderSidebar(); renderContent();
        setStatus(`「${p.name}」正在运行`, 'busy');
      } else if (p.action === 'tick') {
        if (window.State.running[p.id]) window.State.running[p.id].elapsedMs = p.elapsedMs;
      } else if (p.action === 'exit') {
        delete window.State.running[p.id];
        if (p.durationMs > 5000) {
          toast(`「${p.name}」已退出，本次游玩 ${fmtDuration(p.durationMs)}`, 'success');
        }
        refresh();
        setStatus('就绪', 'ok');
      } else if (p.action === 'error') {
        toast(p.error || '启动出错', 'error', 8000);
      }
    });

    // 隐藏空间被自动上锁
    window.GameHub.on('hidden:locked', () => {
      toast('隐藏空间已自动上锁', 'info');
      if (window.State.view === 'hidden') goto('all');
    });

    // 批量获取封面的进度（复用状态栏那条进度条）
    window.GameHub.on('cover:progress', (p) => {
      if (!p) return;
      $('#scanBar').hidden = false;
      setStatus(p.message || '正在获取封面…', 'busy');
      $('#scanText').textContent = p.message || '';
      if (p.total && p.current) {
        $('#scanBarFill').style.width = Math.min(100, Math.round((p.current / p.total) * 100)) + '%';
      }
    });

    // 主进程发来的提示
    window.GameHub.on('toast', (p) => {
      if (p && p.message) toast(p.message, p.type || 'info');
    });
  }

  /** 局部更新某张卡片的体积文案 */
  function updateCardSizeText(id, sizeBytes) {
    const card = document.querySelector(`.game-card[data-id="${id}"], .game-row[data-id="${id}"]`);
    if (!card) return;
    const sub = card.querySelector('.card-sub');
    if (sub) {
      const spans = sub.querySelectorAll('span');
      // card-sub 里的第 2 个信息通常是体积，直接按文本特征替换
      for (const s of spans) {
        if (/^(B|KB|MB|GB|TB)$/.test(s.textContent.split(' ')[1] || '')) {
          s.textContent = fmtBytes(sizeBytes);
          break;
        }
      }
    }
  }

  /* ================================================================
   *  十一、界面工具
   * ================================================================ */

  /** 应用主题（写 data-theme + 本地缓存） */
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  }
  function applyThemeFromState() {
    const t = window.State.settings && window.State.settings.theme;
    if (t) setTheme(t);
  }

  /** 状态栏左侧文字 + 指示灯 */
  function setStatus(text, kind) {
    $('#sbText').textContent = text;
    const dot = $('#sbDot');
    dot.className = 'sb-dot' + (kind ? ' ' + kind : '');
  }

  /** 状态栏右侧统计 */
  function updateStatusBar() {
    const c = window.State.counts();
    const h = window.State.hidden;
    const parts = [`${c.all} 款游戏`, fmtBytes(c.totalSize)];
    if (c.running) parts.push(`${c.running} 款运行中`);
    if (h.enabled && h.unlocked && c.hidden) parts.push(`隐藏 ${c.hidden} 款`);
    $('#sbStats').textContent = parts.join(' · ');
  }

  /**
   * 弹一条提示
   * @param {string} message
   * @param {'info'|'success'|'warn'|'error'} type
   * @param {number} ms 停留毫秒
   */
  function toast(message, type = 'info', ms = 3600) {
    const icons = { info: 'ℹ', success: '✓', warn: '⚠', error: '✕' };
    const node = el('div', { class: 'toast ' + type }, [
      el('span', { class: 'toast-icon', text: icons[type] || 'ℹ' }),
      el('span', { class: 'toast-msg', text: message })
    ]);
    const stack = $('#toastStack');
    stack.appendChild(node);
    // 最多同时显示 4 条，多了挤掉最早的
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);

    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  /* ================================================================
   *  十二、对外暴露 + 启动
   * ================================================================ */
  window.App = {
    init, refresh, refreshSidebar, renderContent, renderSidebar,
    goto, gotoCategory, clearFilters,
    launch, toggleFavorite, toggleHidden, copyText,
    bindCardEvents, toast, setTheme, setStatus, runScan,
    /** 卡片右上角 ⋮ 的「通关状态」菜单 / 写入 */
    showClearMenu, setClearState,
    /** 联网搜索缺失封面 —— 设置面板里那个按钮直接复用这个 */
    runSearchMissingCovers,
    /** 离线兜底：批量提取程序图标当封面 */
    runExtractIcons: runExtractAllIcons
  };

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((e) => {
      console.error('初始化失败', e);
      setStatus('初始化失败：' + (e.message || e), 'err');
    });
  });
})();
