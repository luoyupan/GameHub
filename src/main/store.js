/**
 * ============================================================
 *  GameHub - 本地数据持久化模块  (src/main/store.js)
 * ------------------------------------------------------------
 *  把游戏库与设置项存成 JSON 文件，放在 Electron 的 userData 目录里：
 *      %APPDATA%\GameHub\library.json    —— 游戏库数据
 *      %APPDATA%\GameHub\covers\         —— 封面图片缓存
 *
 *  特性：
 *   · 原子写入（先写 .tmp 再 rename），避免断电 / 崩溃把存档写坏
 *   · 首次运行自动生成默认设置
 *   · 旧版本数据自动补全缺失字段（向前兼容）
 * ============================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** 设置项默认值 */
const DEFAULT_SETTINGS = {
  theme: 'dark',              // 主题：dark | light
  sortBy: 'added',            // 排序：added | name | installDate | lastPlayed | playTime | size | favorite
  sortAsc: false,             // 升降序（默认新加入的排前面，跟 Steam 一致）
  viewMode: 'grid',           // 视图：grid（封面墙）| list（列表）
  cardSize: 'medium',         // 卡片大小：small | medium | large | huge
  scanFolders: [],            // 用户添加的扫描目录 [{ path, mode }]
  autoScanOnStart: true,      // 启动时自动嗅探系统已安装游戏
  autoFetchSteamCover: false, // 是否联网抓 Steam 官方封面
  customCategories: [],       // 用户自己新建的分类名（即使一款游戏都没有也保留）
  statsPeriod: 'month',       // 统计页上次看的周期：week | month | quarter | year | all

  /* ---- 卡片外观（第八轮「设置」里新增的自定义项） ---- */
  cardAchievements: true,     // 卡片上显示成就角标 🏆 12/135（数据来自 Steam 本地缓存）
  cardNameMarquee: true,      // 位置不够时，鼠标悬停卡片把完整游戏名横向滚出来
  cardHoverPlay: true,        // 鼠标悬停封面时显示「▶ 启动」浮层按钮

  /* ---- 界面字体（可自定义字体族与字号） ---- */
  fontFamily: '',             // 空 = 跟随内置默认字体栈；也可填任意本机字体名
  fontSize: 13.5,             // 界面基础字号（px），范围 11 ~ 20

  /* ---- 透出桌面（系统级窗口材质）----
   *  这点是 CSS 做不到的：页面里的 backdrop-filter 只能采样「页面内」已绘制的内容，
   *  永远看不到窗口外面。要让窗口真的透出桌面，必须让 Windows 自己去合成 ——
   *  也就是 Electron 的 win.setBackgroundMaterial()。
   *
   *    acrylic  亚克力：透出桌面 + 明显模糊
   *    mica     云母：只透桌面壁纸，偏沉稳
   *    tabbed   标签页材质
   *    off      强制不透（就算背景用了玻璃材质也不透）
   *    auto     自动（默认）：任一栏用了磨砂 / 亚克力 / 玻璃 / 液态玻璃
   *             就自动切到 acrylic 透出桌面，否则保持不透明
   *
   *  ⚠ 仅 Windows 11（build 22000+）支持，其它系统会被静默忽略。 */
  desktopMaterial: 'auto',

  /* ---- 背景自定义：左侧栏与右侧内容区各自独立 ----
   * type 三种形态：
   *   default  —— 用主题自带的纯色底（默认）
   *   image    —— 用户自己的图片，可调透明度 / 模糊 / 压暗
   *   material —— 磨砂玻璃 / 亚克力 / 玻璃质感（纯 CSS 合成）
   * image 存的是相对 dataDir 的路径（如 bg/sidebar-a1b2.jpg），
   * 这样整个数据目录可以直接搬走。 */
  bg: {
    sidebar: {
      type: 'default',
      image: '',
      fit: 'cover',        // cover | contain | tile | center
      opacity: 0.45,       // 图片本身的不透明度
      blur: 0,             // 图片模糊半径（px）
      dim: 0.5,            // 压暗遮罩强度，保证文字可读
      material: 'frosted', // frosted 磨砂 | acrylic 亚克力 | glass 玻璃 | liquid 液态玻璃
      tint: 0.5            // 材质底色浓度
    },
    content: {
      type: 'default',
      image: '',
      fit: 'cover',
      opacity: 0.45,
      blur: 0,
      dim: 0.5,
      material: 'frosted',
      tint: 0.5
    }
  },

  /* ---- 封面与联网 ---- */
  autoSearchCoverOnline: true,// 启动 / 导入游戏后，自动为「没有封面」的游戏联网搜封面
  coverUpgradeIcon: false,    // 联网搜封面时，是否把已经提取的程序图标也升级成官方封面
  coverMatchLevel: 'normal',  // 联网搜封面的名称匹配严格度：loose | normal | strict

  /* ---- 游戏平台 ---- */
  platformAutoSync: true,     // 打开「平台总览」时自动同步已登录平台的账号与游戏库

  /* ---- MOD 下载（内置浏览器）----
   * 用内置浏览器在 N 网这类站点下载 MOD 时，文件落到哪。
   *
   *   mode
   *     game   —— 自动落到这款游戏的 MOD 目录（按 modpaths.js 的规则推断，
   *               认不出来时才退化成询问）
   *     custom —— 固定落到下面 customDir 指定的文件夹
   *     ask    —— 每次都弹一个保存对话框让用户自己选
   *
   * ⚠ 默认给 game 而不是 ask：MOD 放错目录**不会报错、只会静默失效**，
   *   让用户每次自己选等于把最难的判断题丢给用户。
   *   认不出来的时候会自动退化成询问，不会硬放到错误的地方。
   *
   * autoExtract：MOD 基本都是压缩包，下完自动解压到目标目录（目前支持 zip）。
   * overrides：  针对单款游戏手动指定的目录（gameId → 目录），优先级最高。 */
  modDownload: {
    mode: 'game',
    customDir: '',
    autoExtract: true,
    overrides: {}
  },

  hidden: {
    enabled: false,           // 是否已启用隐藏空间
    salt: '',                 // 密码盐（随机）
    hash: '',                 // 密码哈希（scrypt）
    hint: '',                 // 密码提示语
    autoLockMinutes: 5        // 闲置多久自动上锁（0 = 不自动锁）
  },
  windowBounds: null          // 记住窗口大小与位置
};

/**
 * 通关状态的可选值。
 *
 * ⚠ 不存在"未标记"这一档：主人定的规则是**所有添加的游戏默认未通关**，
 *   所以每张卡从入库起就带着状态，不存在"空的"那个中间态。
 *   老数据里读到空串一律归到 'uncleared'（见 normalizeGame）。
 */
const CLEAR_STATES = ['cleared', 'multi', 'uncleared'];
/** 入库时的默认值：未通关 */
const CLEAR_DEFAULT = 'uncleared';

/** 游戏对象缺失字段的默认值 */
const GAME_DEFAULTS = {
  publisher: '',
  version: '',
  categories: [],
  altNames: [],        // 别名（例如 Steam 的英文名），只用于搜索匹配
  installDate: 0,
  sizeBytes: 0,
  sizeComputedAt: 0,
  favorite: false,
  hidden: false,
  clearState: CLEAR_DEFAULT, // 通关状态：cleared(通关) | multi(多结局通关) | uncleared(未通关，默认)
  playCount: 0,
  totalPlayMs: 0,
  lastPlayedAt: 0,
  // 时长来源：GameHub 自己只统计"从它这里启动"的那些局，所以对 Steam 游戏来说
  // 这个数字天然偏小。从 Steam 的 localconfig.vdf 对过一次之后置 true，
  // 界面上据此说明"含 Steam 记录"，免得用户以为游戏库把时长算错了。
  playtimeFromSteam: false,
  steamSyncedAt: 0,
  coverPath: '',       // 相对 userData 的文件名，如 covers/abc.png
  coverKind: 'none',   // none | icon | custom | steam
  steamAppId: '',
  launchArgs: '',
  note: '',
  missing: false,      // 路径已失效（游戏被卸载 / 移动）
  addedAt: 0,
  updatedAt: 0
};

class Store {
  /**
   * @param {string} dataDir 数据目录（由主进程传入 app.getPath('userData')）
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.coverDir = path.join(dataDir, 'covers');
    // 用户自定义的界面背景图（左栏 / 右栏各一张）存在这里
    this.bgDir = path.join(dataDir, 'bg');
    this.data = { version: 2, games: [], sessions: [], settings: { ...DEFAULT_SETTINGS } };
    this._dirty = false;
    this._timer = null;
  }

  /** 初始化：建目录 + 读档 */
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.coverDir, { recursive: true });
    await fsp.mkdir(this.bgDir, { recursive: true });
    await this.load();
  }

  /** 从磁盘读取数据文件 */
  async load() {
    try {
      const txt = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(txt);
      this.data.games = Array.isArray(parsed.games) ? parsed.games.map(normalizeGame) : [];
      // 游玩会话历史（老版本数据里没有这个字段，默认空数组）
      this.data.sessions = Array.isArray(parsed.sessions) ? parsed.sessions.filter(isValidSession) : [];
      // 设置项做「深合并」，保证新增的默认字段能补到老数据上
      this.data.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), parsed.settings || {});
      this.data.settings.hidden = deepMerge(DEFAULT_SETTINGS.hidden, (parsed.settings || {}).hidden || {});
    } catch {
      // 文件不存在或损坏 → 用默认值重建（损坏文件先备份，避免用户数据无声丢失）
      if (await exists(this.file)) {
        await fsp.copyFile(this.file, this.file + '.bak').catch(() => {});
      }
      this.data = { version: 2, games: [], sessions: [], settings: structuredClone(DEFAULT_SETTINGS) };
    }
    return this.data;
  }

  /** 立即写盘（原子写入） */
  async save() {
    const tmp = this.file + '.tmp';
    const json = JSON.stringify(this.data, null, 2);
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, this.file);
    this._dirty = false;
  }

  /** 延迟写盘：高频操作（如更新游玩时长）合并成一次 IO */
  saveSoon(delay = 800) {
    this._dirty = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save().catch(() => {});
    }, delay);
  }

  /** 关闭前确保数据落盘 */
  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._dirty) await this.save().catch(() => {});
  }

  /* ---------------- 设置项 ---------------- */
  getSettings() { return this.data.settings; }

  async setSettings(patch) {
    this.data.settings = deepMerge(this.data.settings, patch || {});
    await this.save();
    return this.data.settings;
  }

  /* ---------------- 游戏库 ---------------- */
  getGames() { return this.data.games; }

  findGame(id) { return this.data.games.find((g) => g.id === id); }

  addGame(game) {
    const g = normalizeGame(game);
    if (!g.addedAt) g.addedAt = Date.now();
    g.updatedAt = Date.now();
    this.data.games.push(g);
    return g;
  }

  removeGames(ids) {
    const set = new Set(ids);
    const before = this.data.games.length;
    this.data.games = this.data.games.filter((g) => !set.has(g.id));
    return before - this.data.games.length;
  }

  /** 封面文件绝对路径（渲染进程要用 file:// 引用它） */
  coverAbs(rel) {
    if (!rel) return '';
    return path.join(this.dataDir, rel);
  }

  /** 背景图绝对路径 */
  bgAbs(rel) {
    if (!rel) return '';
    return path.join(this.dataDir, rel);
  }

  /** 把封面信息写回某个游戏（封面模块专用） */
  updateGameCover(id, { coverPath, coverKind }) {
    const g = this.findGame(id);
    if (!g) return null;
    g.coverPath = coverPath || '';
    g.coverKind = coverKind || 'none';
    g.updatedAt = Date.now();
    this.saveSoon();
    return g;
  }

  /* ---------------- 游玩会话历史 ----------------
   *  只有"累计时长"是没法做周/月/季/年统计的，
   *  所以每结束一局就记一条流水：{ gameId, at: 结束时刻, ms: 本次时长 }。
   *  用容量上限 + 时间窗双重裁剪，避免数据文件无限膨胀。
   * ---------------------------------------------- */

  /** 取全部会话（按结束时间升序） */
  getSessions() { return this.data.sessions; }

  /**
   * 追加一条游玩会话。
   * @param {{gameId:string, at:number, ms:number, legacy?:boolean}} s
   */
  addSession(s) {
    if (!s || !isValidSession(s)) return null;
    this.data.sessions.push({
      gameId: String(s.gameId),
      at: Number(s.at) || Date.now(),
      ms: Number(s.ms) || 0,
      legacy: !!s.legacy
    });
    this._trimSessions();
    this.saveSoon();
    return this.data.sessions[this.data.sessions.length - 1];
  }

  /** 批量追加（迁移历史数据时用），只写一次盘 */
  addSessions(list) {
    let n = 0;
    for (const s of list || []) {
      if (!isValidSession(s)) continue;
      this.data.sessions.push({
        gameId: String(s.gameId),
        at: Number(s.at) || Date.now(),
        ms: Number(s.ms) || 0,
        legacy: !!s.legacy
      });
      n++;
    }
    if (n) { this._trimSessions(); this.saveSoon(); }
    return n;
  }

  /** 删掉某款游戏的全部会话（移除游戏时一起清理） */
  removeSessions(gameIds) {
    const set = new Set(Array.isArray(gameIds) ? gameIds : [gameIds]);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => !set.has(s.gameId));
    return before - this.data.sessions.length;
  }

  /** 裁剪：先按时间窗丢掉过老的，再按容量丢掉最早的 */
  _trimSessions() {
    const cutoff = Date.now() - SESSION_KEEP_DAYS * 24 * 3600 * 1000;
    let arr = this.data.sessions.filter((s) => s.at >= cutoff);
    if (arr.length > SESSION_MAX) arr = arr.slice(arr.length - SESSION_MAX);
    arr.sort((a, b) => a.at - b.at);
    this.data.sessions = arr;
  }

  /** 删除一个封面缓存文件 */
  async removeCoverFile(rel) {
    if (!rel) return;
    try { await fsp.unlink(this.coverAbs(rel)); } catch { /* 文件不在就算了 */ }
  }
}

/* ------------------------------------------------------------------
 *  小工具
 * ------------------------------------------------------------------ */

/** 会话历史最多保留多少条（约 400 天 × 每天 12 局也够用） */
const SESSION_MAX = 5000;
/** 会话历史最长保留多少天（季/年统计需要跨年，所以给足 400 天） */
const SESSION_KEEP_DAYS = 400;

/** 一条会话记录是否有效（防手改数据文件塞进脏数据） */
function isValidSession(s) {
  return !!s && typeof s === 'object' && s.gameId && Number(s.ms) > 0 && Number(s.at) > 0;
}

/** 补全游戏对象的缺失字段 */
function normalizeGame(g) {
  const out = { ...GAME_DEFAULTS, ...(g || {}) };
  out.categories = Array.isArray(out.categories) && out.categories.length ? out.categories : ['其他'];
  out.name = String(out.name || '未命名游戏').trim();
  out.sizeBytes = Number(out.sizeBytes) || 0;
  out.installDate = Number(out.installDate) || 0;
  out.playCount = Number(out.playCount) || 0;
  out.totalPlayMs = Number(out.totalPlayMs) || 0;
  out.lastPlayedAt = Number(out.lastPlayedAt) || 0;
  out.playtimeFromSteam = !!out.playtimeFromSteam;
  out.steamSyncedAt = Number(out.steamSyncedAt) || 0;
  out.favorite = !!out.favorite;
  out.hidden = !!out.hidden;
  // ⚠ 一定要过白名单：这个字段是从 json 里读进来的，手改过的存档/脏数据
  //   如果直接透传，前端 clearMeta() 查不到就会渲染出一个空的角标。
  //   认不出来的值（含老数据里的空串）一律回落到"未通关"，
  //   而不是留空 —— 空的会让卡片上一个状态都不显示，和默认规则不一致。
  out.clearState = CLEAR_STATES.includes(out.clearState) ? out.clearState : CLEAR_DEFAULT;
  return out;
}

/** 递归对象合并（用于设置项向前兼容） */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = out[k];
    const pv = patch[k];
    if (bv && pv && typeof bv === 'object' && typeof pv === 'object' && !Array.isArray(bv) && !Array.isArray(pv)) {
      out[k] = deepMerge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

module.exports = {
  Store, DEFAULT_SETTINGS, GAME_DEFAULTS, normalizeGame, deepMerge,
  isValidSession, SESSION_MAX, SESSION_KEEP_DAYS, CLEAR_STATES, CLEAR_DEFAULT
};
