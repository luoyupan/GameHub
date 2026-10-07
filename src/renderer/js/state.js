/**
 * ============================================================
 *  GameHub - 前端状态与数据筛选  (js/state.js)
 * ------------------------------------------------------------
 *  页面所有数据的唯一来源。负责：
 *   · 缓存主进程返回的游戏列表 / 统计 / 分类 / 设置
 *   · 按「当前视图 + 分类 + 来源 + 搜索词」筛选，再排序
 *   · 视图切换、排序、搜索等交互都改这里的状态，然后统一重绘
 *
 *  ⚠ 隐藏空间规则（前端侧）：
 *     即使隐藏空间已解锁，隐藏的游戏也只在「隐藏空间」这一个视图里出现，
 *     绝不会混进全部游戏 / 分类 / 搜索结果，避免解锁后被别人瞥见。
 * ============================================================
 */
(function () {
  'use strict';

  const { fmtBytes } = window.U;

  const State = {
    /* ---- 原始数据 ---- */
    games: [],
    stats: { total: 0, favorite: 0, hidden: 0, hiddenEnabled: false, unlocked: false, totalSize: 0, totalPlayMs: 0 },
    categories: [],
    settings: {},
    hidden: { enabled: false, unlocked: false, hasHint: false, hint: '', hiddenCount: 0 },

    /* ---- 界面状态 ---- */
    view: 'home',          // home | all | recent | favorite | running | hidden | category
    category: null,        // 当前选中的分类名
    source: 'all',         // all | steam | registry | folder | epic
    search: '',
    sort: 'added:desc',    // "字段:方向"
    viewMode: 'grid',      // grid | list
    cardSize: 'medium',

    /* ---- 运行时 ---- */
    running: {},           // { gameId: { startAt, elapsedMs } }
    busy: false,
    ready: false
  };

  /* ================================================================
   *  数据加载
   * ================================================================ */
  async function load() {
    const r = await window.API.load();
    if (!r || r.ok === false) {
      console.error('加载游戏库失败', r && r.error);
      return false;
    }
    State.games = r.games || [];
    State.stats = r.stats || State.stats;
    State.categories = r.categories || [];
    State.settings = r.settings || {};

    // 同步设置里的界面偏好（首次进入时生效）
    if (!State.ready && State.settings) {
      if (State.settings.viewMode) State.viewMode = State.settings.viewMode;
      if (State.settings.cardSize) State.cardSize = State.settings.cardSize;
      if (State.settings.sortBy) State.sort = `${State.settings.sortBy}:${State.settings.sortAsc ? 'asc' : 'desc'}`;
    }

    // 隐藏空间状态单独取（它有自己的密码逻辑）
    const h = await window.API.hiddenStatus();
    if (h && h.ok !== false) State.hidden = h;

    // 同步"正在运行"标记
    const running = {};
    for (const g of State.games) {
      if (g.running) running[g.id] = { startAt: g.runningSince, elapsedMs: Date.now() - g.runningSince };
    }
    State.running = running;

    State.ready = true;
    return true;
  }

  /* ================================================================
   *  筛选与排序
   * ================================================================ */

  /** 判断某款游戏是否应该出现在当前视图 */
  function matchView(g, view) {
    switch (view) {
      case 'all': return !g.hidden;
      case 'favorite': return !g.hidden && g.favorite;
      case 'recent': return !g.hidden && g.lastPlayedAt > 0;
      case 'running': return !g.hidden && !!State.running[g.id];
      case 'hidden': return !!g.hidden;                  // 只有这个视图能看到隐藏游戏
      case 'category': return !g.hidden && (!State.category || (g.categories || []).includes(State.category));
      case 'home': return !g.hidden;
      default: return !g.hidden;
    }
  }

  /** 搜索匹配：名称 / 别名 / 分类 / 发行商 / 路径 / 备注 */
  function matchSearch(g, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      (g.name || '').toLowerCase().includes(needle) ||
      // altNames 里存着同一款游戏的其它名字（比如 Steam 的英文原名），
      // 所以搜 "Persona 5" 和搜 "女神异闻录" 都能找到同一款游戏
      (g.altNames || []).some((n) => String(n).toLowerCase().includes(needle)) ||
      (g.categories || []).some((c) => c.toLowerCase().includes(needle)) ||
      (g.publisher || '').toLowerCase().includes(needle) ||
      (g.installDir || '').toLowerCase().includes(needle) ||
      (g.note || '').toLowerCase().includes(needle)
    );
  }

  /** 来源匹配 */
  function matchSource(g, src) {
    if (src === 'all') return true;
    return g.source === src;
  }

  /** 排序 */
  function sortGames(list) {
    const [key, dir] = String(State.sort).split(':');
    const sign = dir === 'asc' ? 1 : -1;
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

    return [...list].sort((a, b) => {
      // 正在运行的永远排最前，这是用户最关心的
      const ra = State.running[a.id] ? 1 : 0;
      const rb = State.running[b.id] ? 1 : 0;
      if (ra !== rb) return rb - ra;

      let v = 0;
      switch (key) {
        case 'name': v = collator.compare(a.name || '', b.name || ''); break;
        case 'installDate': v = (a.installDate || 0) - (b.installDate || 0); break;
        case 'lastPlayed': v = (a.lastPlayedAt || 0) - (b.lastPlayedAt || 0); break;
        case 'playTime': v = (a.totalPlayMs || 0) - (b.totalPlayMs || 0); break;
        case 'size': v = (a.sizeBytes || 0) - (b.sizeBytes || 0); break;
        case 'favorite': v = (a.favorite ? 1 : 0) - (b.favorite ? 1 : 0); break;
        case 'added':
        default: v = (a.addedAt || 0) - (b.addedAt || 0); break;
      }
      if (v === 0) v = collator.compare(a.name || '', b.name || '');
      return v * sign;
    });
  }

  /** 取当前视图应显示的游戏列表 */
  function visible(view = State.view) {
    const q = State.search.trim();
    let list = State.games.filter(
      (g) => matchView(g, view) && matchSearch(g, q) && matchSource(g, State.source)
    );
    list = sortGames(list);
    // 最近游玩视图只保留玩过的，并按时间倒序（不被其它排序干扰）
    if (view === 'recent') {
      list.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    }
    return list;
  }

  /** 统计信息（用于侧栏计数与状态栏） */
  function counts() {
    const visibleGames = State.games.filter((g) => !g.hidden);
    return {
      all: visibleGames.length,
      favorite: visibleGames.filter((g) => g.favorite).length,
      recent: visibleGames.filter((g) => g.lastPlayedAt > 0).length,
      running: visibleGames.filter((g) => State.running[g.id]).length,
      hidden: State.games.filter((g) => g.hidden).length,
      totalSize: visibleGames.reduce((s, g) => s + (g.sizeBytes || 0), 0)
    };
  }

  /** 当前视图的标题 */
  function viewTitle() {
    switch (State.view) {
      case 'home': return '首页';
      case 'all': return '全部游戏';
      case 'recent': return '最近游玩';
      case 'favorite': return '我的收藏';
      case 'running': return '正在运行';
      case 'hidden': return '隐藏空间';
      case 'category': return State.category || '分类';
      case 'stats': return '游玩统计';
      case 'platform': return '游戏平台';
      case 'net': return '联机';
      default: return '游戏库';
    }
  }

  /** 视图标题下方的补充说明 */
  function viewHint() {
    if (State.view === 'hidden' && State.hidden.unlocked) return '仅在此处可见 · 上锁后自动隐藏';
    if (State.view === 'stats') return '自动记录每次启动与游玩时长';
    if (State.view === 'platform') return '只读本机平台数据 · 不上传任何信息';
    if (State.view === 'net') return '内网穿透 / P2P / 中转站 · 不提供任何官方中转站';
    if (State.view === 'recent') return '按最近启动时间排序';
    if (State.view === 'favorite') return '右键游戏可加入收藏';
    if (State.search.trim()) return `搜索「${State.search.trim()}」`;
    return '';
  }

  window.State = State;
  window.State.load = load;
  window.State.visible = visible;
  window.State.counts = counts;
  window.State.viewTitle = viewTitle;
  window.State.viewHint = viewHint;
  window.State.matchView = matchView;
  window.State.fmtBytes = fmtBytes;
})();
