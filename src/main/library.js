/**
 * ============================================================
 *  GameHub - 游戏库业务逻辑层  (src/main/library.js)
 * ------------------------------------------------------------
 *  夹在「数据文件」与「界面」之间，负责所有规则判定：
 *    · 游戏的新增 / 修改 / 删除 / 去重
 *    · 收藏、分类、备注
 *    · 游玩次数与游玩时长统计
 *    · 【隐藏空间】—— 密码保护 + 服务端过滤
 *
 *  隐藏空间的安全设计（要点）：
 *    1. 密码用 scrypt + 随机盐做单向哈希，明文绝不落盘；
 *    2. 未解锁时，隐藏的游戏在主进程就被过滤掉，
 *       前端拿不到数据，所以打开开发者工具也看不到；
 *    3. 闲置超过设定时长自动上锁。
 * ============================================================
 */

const crypto = require('crypto');
const path = require('path');
const scanner = require('./scanner');
const statsMod = require('./stats');
const { CLEAR_STATES, CLEAR_DEFAULT } = require('./store');

/** scrypt 参数：N 越大越慢越安全，这里取兼顾体验的参数 */
const SCRYPT_KEYLEN = 64;

/**
 * 「R18」特殊标签。
 * 用户要求：给游戏打上这个标签 → 自动放进隐藏空间。
 * ⚠ 只有在隐藏空间【已启用】时才真的去隐藏：
 *    否则游戏会变成 hidden=true 但又没有密码入口可以解锁，
 *    结果就是游戏从界面上彻底消失、再也找不回来（这是个很危险的坑）。
 */
const R18_TAG = 'R18';

class Library {
  constructor(store) {
    this.store = store;
    this._unlocked = false;      // 隐藏空间是否已解锁
    this._unlockAt = 0;
    this._lockTimer = null;
    this._onLock = null;         // 自动上锁时的回调（用于通知界面）
    this._hiddenPasswordCache = null; // 解锁后暂存明文，便于"修改密码"校验
  }

  /* ================================================================
   *  一、基础查询
   * ================================================================ */

  /**
   * 取游戏列表。
   * @param {{includeHidden?:boolean}} opts
   *        includeHidden 只为 true 且隐藏空间已解锁时，才会返回隐藏的游戏
   */
  list(opts = {}) {
    const all = this.store.getGames();
    const wantHidden = !!opts.includeHidden && this._unlocked;
    return all.filter((g) => (g.hidden ? wantHidden : true));
  }

  /** 统计信息（同样遵守隐藏空间规则，避免泄露隐藏游戏的数量） */
  stats() {
    const visible = this.list({});
    const unlocked = this._unlocked;
    return {
      total: visible.length,
      favorite: visible.filter((g) => g.favorite).length,
      hidden: unlocked ? this.store.getGames().filter((g) => g.hidden).length : 0,
      hiddenEnabled: !!this.store.getSettings().hidden.enabled,
      unlocked,
      totalSize: visible.reduce((s, g) => s + (g.sizeBytes || 0), 0),
      totalPlayMs: visible.reduce((s, g) => s + (g.totalPlayMs || 0), 0)
    };
  }

  /**
   * 汇总当前存在的所有分类（含数量），用于左侧栏。
   * 会把用户自建的分类也列出来（哪怕当前一款游戏都没归到它下面），
   * 否则"新建分类"会显得没生效。
   */
  categories() {
    const map = new Map();
    for (const g of this.list({})) {
      for (const c of g.categories || []) {
        map.set(c, (map.get(c) || 0) + 1);
      }
    }
    const custom = this.store.getSettings().customCategories || [];
    const customSet = new Set(custom);
    for (const c of custom) if (!map.has(c)) map.set(c, 0);

    return [...map.entries()]
      .map(([name, count]) => ({ name, count, custom: customSet.has(name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  }

  /* ================================================================
   *  一-b、自定义分类（用户可以自己建分类，一个游戏可以有多个）
   * ================================================================ */

  /** 分类名规范化 + 校验 */
  static normalizeCategory(name) {
    const v = String(name || '').trim().replace(/\s+/g, ' ');
    if (!v) return { ok: false, error: '分类名不能为空' };
    if (v.length > 16) return { ok: false, error: '分类名最多 16 个字' };
    return { ok: true, name: v };
  }

  /** 新建一个自定义分类（即使暂时没有游戏用它，也会留在侧栏） */
  async addCategory(name) {
    const r = Library.normalizeCategory(name);
    if (!r.ok) return r;
    const custom = this.store.getSettings().customCategories || [];
    const exists = custom.some((c) => c.toLowerCase() === r.name.toLowerCase());
    const inUse = this.categories().some((c) => c.name.toLowerCase() === r.name.toLowerCase());
    if (exists || inUse) return { ok: false, error: '这个分类已经存在了' };

    await this.store.setSettings({ customCategories: [...custom, r.name] });
    return { ok: true, name: r.name };
  }

  /**
   * 重命名分类：同时改掉所有游戏身上的这个分类标签。
   * 这样不会出现"分类改了名、游戏却还挂在旧名字下"的孤儿数据。
   */
  async renameCategory(oldName, newName) {
    const from = String(oldName || '').trim();
    const r = Library.normalizeCategory(newName);
    if (!r.ok) return r;
    if (from === r.name) return { ok: true, name: r.name, changed: 0 };

    const custom = this.store.getSettings().customCategories || [];
    const nextCustom = custom.map((c) => (c === from ? r.name : c));
    // 游戏身上的标签替换（去重，避免本来就同时有两个名字时出现重复项）
    let changed = 0;
    for (const g of this.store.getGames()) {
      const cats = g.categories || [];
      if (!cats.includes(from)) continue;
      const merged = [...new Set(cats.map((c) => (c === from ? r.name : c)))];
      g.categories = merged;
      g.updatedAt = Date.now();
      changed++;
    }
    await this.store.setSettings({ customCategories: [...new Set(nextCustom)] });
    this.store.saveSoon();
    return { ok: true, name: r.name, changed };
  }

  /**
   * 删除分类：从自定义列表里去掉，并从所有游戏身上摘掉这个标签。
   * 摘完如果一个游戏一个分类都不剩，就补一个"其他"，避免出现无分类的孤儿。
   */
  async removeCategory(name) {
    const target = String(name || '').trim();
    if (!target) return { ok: false, error: '分类名不能为空' };

    const custom = (this.store.getSettings().customCategories || []).filter((c) => c !== target);
    let changed = 0;
    for (const g of this.store.getGames()) {
      const cats = g.categories || [];
      if (!cats.includes(target)) continue;
      const left = cats.filter((c) => c !== target);
      g.categories = left.length ? left : ['其他'];
      g.updatedAt = Date.now();
      changed++;
    }
    await this.store.setSettings({ customCategories: custom });
    this.store.saveSoon();
    return { ok: true, changed };
  }

  /* ================================================================
   *  一-c、R18 自动隐藏
   * ================================================================ */

  /** 这个游戏是否带 R18 标签（大小写不敏感） */
  static isR18(game) {
    // game 可能是 null / undefined（比如调用方拿到一条脏数据），这里兜住别抛
    const cats = (game && game.categories) || [];
    return cats.some((c) => String(c).trim().toUpperCase() === R18_TAG);
  }

  /**
   * 把带 R18 标签的游戏收进隐藏空间。
   *
   * 为什么要传 ids 而不是每次都全量扫：
   *   用户在隐藏空间里手动把某款 R18 游戏"移出隐藏"是他的自由，
   *   如果每次改个备注就全量重扫，那款游戏又会被悄悄藏回去，很容易让人困惑。
   *   所以只在"刚打上标签"和"刚启用隐藏空间"这两个时机触发。
   *
   * @param {string[]} [ids] 只处理这些游戏；不传 = 全量（启用隐藏空间后补一次）
   * @returns {{hidden:string[], pending:string[]}}
   *          hidden  = 这次被隐藏的
   *          pending = 打了 R18 但因为隐藏空间没启用、暂时没法隐藏的
   */
  syncR18(ids) {
    const enabled = !!this.store.getSettings().hidden.enabled;
    const only = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const hidden = [];
    const pending = [];
    for (const g of this.store.getGames()) {
      if (only && !only.has(g.id)) continue;
      if (!Library.isR18(g)) continue;
      if (g.hidden) continue;
      if (!enabled) { pending.push(g.name); continue; }
      g.hidden = true;
      g.updatedAt = Date.now();
      hidden.push(g.name);
    }
    if (hidden.length) this.store.saveSoon();
    return { hidden, pending };
  }

  /* ================================================================
   *  一-d、游玩统计
   * ================================================================ */

  /**
   * 按周期算游玩统计。
   * @param {string} period week | month | quarter | year | all
   */
  stats(period = 'month') {
    const games = this.list({});   // 遵守隐藏空间规则，隐藏的游戏不参与统计
    return statsMod.computeStats(this.store.getSessions(), games, period);
  }

  /**
   * 老数据迁移：升级前只存了"累计时长"，没有一局一局的流水，
   * 那样周/月/季/年统计会全是空的。
   * 这里把累计时长一次性挂到「最近一次游玩」那天，作为一条标记为 legacy 的记录，
   * 让统计页一开始就有内容；界面会注明含升级前的累计值。
   */
  migrateLegacyPlaytime() {
    if (this.store.getSessions().length) return 0;
    const list = [];
    for (const g of this.store.getGames()) {
      if ((g.totalPlayMs || 0) > 60000 && (g.lastPlayedAt || 0) > 0) {
        list.push({ gameId: g.id, at: g.lastPlayedAt, ms: g.totalPlayMs, legacy: true });
      }
    }
    if (!list.length) return 0;
    return this.store.addSessions(list);
  }

  /* ================================================================
   *  二、增删改
   * ================================================================ */

  /**
   * 批量添加（通常来自扫描结果确认）。
   * 自动跳过库里已经存在的游戏（按 id / 安装目录 / 可执行文件三重判断）。
   * @returns {{added:Array, skipped:Array}}
   */
  addMany(specs) {
    const added = [];
    const skipped = [];
    const existingIds = new Set(this.store.getGames().map((g) => g.id));
    const existingDirs = new Set(
      this.store.getGames().filter((g) => g.installDir).map((g) => path.normalize(g.installDir).toLowerCase())
    );
    const existingExes = new Set(
      this.store.getGames().filter((g) => g.exePath).map((g) => path.normalize(g.exePath).toLowerCase())
    );

    for (const spec of specs || []) {
      const dir = spec.installDir ? path.normalize(spec.installDir).toLowerCase() : '';
      const exe = spec.exePath ? path.normalize(spec.exePath).toLowerCase() : '';
      if (existingIds.has(spec.id) || (dir && existingDirs.has(dir)) || (exe && existingExes.has(exe))) {
        skipped.push(spec);
        continue;
      }
      const g = this.store.addGame({
        ...spec,
        addedAt: Date.now(),
        categories: spec.categories && spec.categories.length ? spec.categories : undefined
      });
      existingIds.add(g.id);
      if (dir) existingDirs.add(dir);
      if (exe) existingExes.add(exe);
      added.push(g);
    }
    this.store.saveSoon();
    // R18 自动隐藏由 IPC 层调用 syncR18() 统一处理，这里只负责入库
    return { added, skipped };
  }

  /** 添加单个游戏 */
  addOne(spec) {
    return this.addMany([spec]).added[0] || null;
  }

  /**
   * 更新游戏字段。
   * @param {string} id
   * @param {object} patch 允许的字段：name/categories/favorite/hidden/exePath/installDir/note/launchArgs/coverPath/coverKind/publisher/version
   */
  update(id, patch) {
    const g = this.store.findGame(id);
    if (!g) return null;
    const allowed = [
      'name', 'categories', 'favorite', 'hidden', 'exePath', 'installDir', 'note',
      'launchArgs', 'coverPath', 'coverKind', 'publisher', 'version', 'installDate',
      'sizeBytes', 'steamAppId', 'missing', 'playCount', 'totalPlayMs', 'lastPlayedAt',
      'clearState'
    ];
    for (const k of Object.keys(patch || {})) {
      if (allowed.includes(k)) g[k] = patch[k];
    }
    if (patch && patch.categories) {
      g.categories = Array.isArray(patch.categories) && patch.categories.length ? patch.categories : ['其他'];
    }
    // 通关状态必须是白名单里的值，认不出来的一律当"未通关"—— 这是入库默认值，
    // 也是唯一一个可以无条件回落的档位（空串在这里没有意义）
    if (patch && 'clearState' in patch) {
      g.clearState = CLEAR_STATES.includes(g.clearState) ? g.clearState : CLEAR_DEFAULT;
    }
    g.updatedAt = Date.now();
    this.store.saveSoon();
    // 说明：R18 自动隐藏不在这里做，而是由 IPC 层统一调用 syncR18()，
    // 这样调用方能拿到"隐藏了哪些 / 哪些因为没启用隐藏空间而搁置"的结果去提示用户。
    return g;
  }

  /** 删除游戏（同时清掉它的封面缓存文件） */
  remove(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    // 先删封面文件。
    // ⚠ 这里不看 coverKind —— 除了用户自己上传的那张（那是他的文件），
    //   从 Steam 抓的、从 exe 抠的，都只是躺在 userData/covers 里的缓存，
    //   游戏都删了留着就是一堆没主的垃圾（批量删几十款时会攒出几十 MB）。
    for (const id of list) {
      const g = this.store.findGame(id);
      if (g && g.coverPath && g.coverKind !== 'custom') {
        this.store.removeCoverFile?.(g.coverPath);
      }
    }
    const n = this.store.removeGames(list);
    // 游戏没了，它的游玩流水也一起清掉，否则统计里会出现"已移除的游戏"
    this.store.removeSessions(list);
    this.store.saveSoon();
    return n;
  }

  /** 清空整个游戏库（保留设置与隐藏空间密码） */
  clear() {
    const n = this.store.getGames().length;
    this.store.data.games = [];
    this.store.data.sessions = [];
    this.store.saveSoon();
    return n;
  }

  /* ================================================================
   *  三、隐藏空间
   * ================================================================ */

  /** 简单的密码哈希：scrypt(密码, 盐) */
  static hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  }

  /** 恒定时间比较，防止时序攻击推出密码 */
  static safeEqual(a, b) {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  /** 隐藏空间状态（不泄露任何敏感信息） */
  hiddenStatus() {
    const h = this.store.getSettings().hidden;
    return {
      enabled: !!h.enabled,
      unlocked: this._unlocked,
      hasHint: !!h.hint,
      hint: this._unlocked || !h.enabled ? '' : h.hint,  // 提示语只有上锁时才给，用于辅助回忆
      hiddenCount: this._unlocked ? this.store.getGames().filter((g) => g.hidden).length : 0,
      autoLockMinutes: h.autoLockMinutes
    };
  }

  /** 首次启用隐藏空间：设置密码 */
  async setupHidden(password, hint = '') {
    const pwd = String(password || '').trim();
    if (pwd.length < 3) return { ok: false, error: '密码至少 3 位' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = Library.hashPassword(pwd, salt);
    await this.store.setSettings({
      hidden: { enabled: true, salt, hash, hint: String(hint || '').slice(0, 60) }
    });
    this._hiddenPasswordCache = pwd;
    this.unlockHidden(pwd); // 启用后直接进入解锁状态

    // 启用成功 → 之前因为"没启用"而搁置的 R18 游戏，现在补上隐藏
    const r18 = this.syncR18();
    return { ok: true, r18 };
  }

  /** 解锁隐藏空间 */
  unlockHidden(password) {
    const h = this.store.getSettings().hidden;
    if (!h.enabled) return { ok: false, error: '尚未启用隐藏空间' };
    const tryHash = Library.hashPassword(String(password || ''), h.salt);
    if (!Library.safeEqual(tryHash, h.hash)) {
      return { ok: false, error: '密码不正确' };
    }
    this._unlocked = true;
    this._unlockAt = Date.now();
    this._hiddenPasswordCache = String(password || '');
    this._armAutoLock();
    return { ok: true };
  }

  /** 上锁 */
  lockHidden(notify = true) {
    this._unlocked = false;
    this._hiddenPasswordCache = null;
    if (this._lockTimer) { clearTimeout(this._lockTimer); this._lockTimer = null; }
    if (notify && this._onLock) this._onLock();
    return { ok: true };
  }

  /** 任意界面操作都调用一下，用于"闲置计时"刷新 */
  touch() {
    if (this._unlocked) this._armAutoLock();
  }

  /** 安排自动上锁定时器 */
  _armAutoLock() {
    if (this._lockTimer) clearTimeout(this._lockTimer);
    const minutes = Number(this.store.getSettings().hidden.autoLockMinutes) || 0;
    if (!minutes || !this._unlocked) return;
    this._lockTimer = setTimeout(() => this.lockHidden(true), minutes * 60 * 1000);
    if (this._lockTimer.unref) this._lockTimer.unref();
  }

  /** 设置自动上锁回调 */
  onAutoLock(fn) { this._onLock = fn; }

  /** 修改隐藏空间密码 */
  async changeHiddenPassword(oldPwd, newPwd, hint) {
    const h = this.store.getSettings().hidden;
    if (!h.enabled) return { ok: false, error: '尚未启用隐藏空间' };
    if (!Library.safeEqual(Library.hashPassword(String(oldPwd || ''), h.salt), h.hash)) {
      return { ok: false, error: '原密码不正确' };
    }
    const pwd = String(newPwd || '').trim();
    if (pwd.length < 3) return { ok: false, error: '新密码至少 3 位' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = Library.hashPassword(pwd, salt);
    await this.store.setSettings({ hidden: { salt, hash, hint: String(hint ?? h.hint ?? '').slice(0, 60) } });
    this._hiddenPasswordCache = pwd;
    return { ok: true };
  }

  /**
   * 关闭隐藏空间（需要密码）。
   * 关闭后所有隐藏的游戏会重新变回普通游戏，不会丢失。
   */
  async disableHidden(password) {
    const h = this.store.getSettings().hidden;
    if (!h.enabled) return { ok: false, error: '尚未启用隐藏空间' };
    if (!Library.safeEqual(Library.hashPassword(String(password || ''), h.salt), h.hash)) {
      return { ok: false, error: '密码不正确' };
    }
    // 把隐藏的游戏全部恢复为可见
    for (const g of this.store.getGames()) {
      if (g.hidden) g.hidden = false;
    }
    this._unlocked = false;
    await this.store.setSettings({ hidden: { enabled: false, salt: '', hash: '', hint: '' } });
    return { ok: true };
  }

  /** 批量设置隐藏 / 取消隐藏（隐藏必须已经解锁过隐藏空间） */
  setHidden(ids, hidden) {
    if (hidden && !this.store.getSettings().hidden.enabled) {
      return { ok: false, error: 'NO_HIDDEN_SPACE', message: '请先启用隐藏空间并设置密码' };
    }
    const list = Array.isArray(ids) ? ids : [ids];
    let n = 0;
    for (const id of list) {
      const g = this.store.findGame(id);
      if (g) { g.hidden = !!hidden; g.updatedAt = Date.now(); n++; }
    }
    this.store.saveSoon();
    return { ok: true, count: n };
  }

  /* ================================================================
   *  四、游玩记录
   * ================================================================ */

  /** 记录一次启动 */
  recordLaunch(id) {
    const g = this.store.findGame(id);
    if (!g) return null;
    g.playCount = (g.playCount || 0) + 1;
    g.lastPlayedAt = Date.now();
    this.store.saveSoon();
    return g;
  }

  /**
   * 记录一次退出，累加游玩时长。
   * @param {string} id
   * @param {number} ms 本次运行的毫秒数
   * @param {number} [sessionEnd] 会话结束时间（默认为此刻，用于进程守护模式）
   */
  recordSession(id, ms, sessionEnd) {
    const g = this.store.findGame(id);
    if (!g) return null;
    // 少于 5 秒的算误触，不计入
    if (ms > 5000) {
      g.totalPlayMs = (g.totalPlayMs || 0) + ms;
      g.lastPlayedAt = sessionEnd || (Date.now());
      // 同时记一条流水：周/月/季/年统计全靠它，只有累计值是算不出周期的
      this.store.addSession({ gameId: id, at: g.lastPlayedAt, ms });
    }
    this.store.saveSoon();
    return g;
  }

  /**
   * 把 Steam 记的时长 / 最近游玩并进游戏库。
   *
   * ── 为什么需要这一步 ──────────────────────────────────────────
   * 游戏库的 totalPlayMs 只统计"从 GameHub 启动"的那些局。可现实是：
   * 同一款游戏，用户可能在 Steam 客户端里玩了几十小时，然后才把它加进 GameHub。
   * 于是详情页会出现两个都很"合理"、但互相打架的画面 ——
   *   有的游戏（从 GameHub 启动过）时长 + 成就都有，
   *   有的游戏（没从 GameHub 启动过）时长是"未玩过"、连成就那一行都不见了，
   * 而这两款游戏在 Steam 上的数据其实是同样齐全的。
   * 主人反馈的「有的有游戏时间和成就有的就没有」就是这个。
   *
   * ── 合并规则（只增不减，两条都不可省） ────────────────────────
   * ① 只往大了取：Steam 的值再小也不许把本地记录改小。
   *    本地是"从 GameHub 启动后实时累加"的，比 Steam 的落盘值更新，
   *    一旦被覆盖，用户会看到时长凭空倒退。
   * ② Steam 自己也是"正常退出才落盘"，所以它只是**下限**，不是真值。
   *
   * @param {Object<string,{playtimeMs:number,lastPlayed:number}>} apps appId → 时长
   * @returns {{changed:number, updated:string[]}}
   */
  mergeSteamPlaytime(apps) {
    const map = apps || {};
    const updated = [];
    const now = Date.now();

    for (const g of this.store.getGames()) {
      if (!g.steamAppId) continue;
      const rec = map[String(g.steamAppId)];
      if (!rec) continue;

      let touched = false;
      const steamMs = Number(rec.playtimeMs) || 0;
      const steamAt = Number(rec.lastPlayed) || 0;

      if (steamMs > (g.totalPlayMs || 0)) {
        g.totalPlayMs = steamMs;
        g.playtimeFromSteam = true;
        touched = true;
      }
      if (steamAt > (g.lastPlayedAt || 0)) {
        g.lastPlayedAt = steamAt;
        touched = true;
      }
      if (touched) {
        g.steamSyncedAt = now;
        g.updatedAt = now;
        updated.push(g.id);
      }
    }

    if (updated.length) this.store.saveSoon();
    return { changed: updated.length, updated };
  }

  /** 路径有效性检查：游戏被卸载/移动后打上 missing 标记 */
  async checkMissing() {
    const changed = [];
    for (const g of this.store.getGames()) {
      const target = g.exePath || g.installDir;
      if (!target) continue;
      const ok = await pathExists(target);
      const missing = !ok;
      if (!!g.missing !== missing) { g.missing = missing; changed.push(g.id); }
    }
    if (changed.length) this.store.saveSoon();
    return changed;
  }

  /** 为指定游戏补全体积（后台任务用） */
  async computeSize(id, onTick) {
    const g = this.store.findGame(id);
    if (!g || !g.installDir) return null;
    const { bytes } = await scanner.dirSize(g.installDir, onTick);
    g.sizeBytes = bytes;
    g.sizeComputedAt = Date.now();
    this.store.saveSoon();
    return g;
  }
}

async function pathExists(p) {
  try { await require('fs/promises').access(p); return true; } catch { return false; }
}

module.exports = { Library };
