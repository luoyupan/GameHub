/**
 * ============================================================
 *  GameHub - 主进程能力调用封装  (js/api.js)
 * ------------------------------------------------------------
 *  把 preload 暴露的 window.GameHub 再包一层：
 *   · 统一 try/catch，任何 IPC 出错都变成 { ok:false, error } 而不是抛异常
 *   · 统一 JSON 化（Electron 的 IPC 对某些对象会丢失原型）
 *   · 提供几个组合动作（如「扫描 → 导入选中的游戏」）
 * ============================================================
 */
(function () {
  'use strict';

  /** 原始桥接对象（preload 注入） */
  const raw = window.GameHub;

  /** 安全调用：永远返回对象，永不抛错 */
  async function safe(fn, ...args) {
    try {
      const r = await fn(...args);
      return r === undefined ? { ok: true } : r;
    } catch (e) {
      console.error('[API 调用失败]', e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  const API = {
    /* ---------------- 基础 ---------------- */
    info: () => safe(raw.info),

    /* ---------------- 库数据 ---------------- */
    /**
     * 拉取游戏列表 + 统计 + 分类 + 设置。
     * includeHidden 一律传 true —— 真正要不要过滤由主进程按「隐藏空间是否已解锁」决定，
     * 前端的开关说了不算，这样上锁时数据根本不会流到页面里。
     */
    load: (opts) => safe(raw.library.list, { includeHidden: true, ...(opts || {}) }),
    /**
     * 更新游戏字段。
     * @param {string} id
     * @param {object} patch
     * @param {{silent?:boolean}} [opts] silent = 改动不影响任何统计/筛选，
     *        就别广播 library:changed（那会让前端整页重绘、滚动位置弹回顶部）
     */
    update: (id, patch, opts) => safe(raw.library.update, id, patch, opts),
    remove: (ids) => safe(raw.library.remove, ids),
    clear: () => safe(raw.library.clear),
    addMany: (games) => safe(raw.library.addMany, games),
    addOne: (game) => safe(raw.library.add, game),

    /* ---------------- 启动 ---------------- */
    launch: (id) => safe(raw.game.launch, id),
    stop: (id) => safe(raw.game.stop, id),
    openFolder: (id) => safe(raw.game.openFolder, id),
    openPath: (p) => safe(raw.game.openPath, p),
    openUrl: (u) => safe(raw.game.openUrl, u),
    calcSize: (ids) => safe(raw.game.calcSize, ids),
    /** 卸载方案说明：走平台卸还是本地卸、目录在哪、多大 */
    uninstallInfo: (id) => safe(raw.game.uninstallInfo, id),
    /** 执行卸载。args: { id, mode:'platform'|'software'|'remove' } */
    uninstall: (args) => safe(raw.game.uninstall, args || {}),

    /* ---------------- 扫描 ---------------- */
    scanAuto: (opts) => safe(raw.scan.auto, opts),
    scanFolder: (args) => safe(raw.scan.folder, args),
    scanCancel: () => safe(raw.scan.cancel),
    defaultFolders: () => safe(raw.scan.defaultFolders),

    /* ---------------- 封面 ---------------- */
    coverExtract: (id) => safe(raw.cover.extract, id),
    coverExtractAll: () => safe(raw.cover.extractAll),
    /** 批量：给库里所有非自定义封面的游戏重新抓一遍 Steam 封面 */
    coverSteamAll: () => safe(raw.cover.steamAll),
    /** 批量：优化版 —— 只处理「没有封面」的游戏，搜不到就跳过 */
    coverFillMissing: (opts) => safe(raw.cover.fillMissing, opts || {}),
    /** 中止正在进行的批量封面搜索 */
    coverCancel: () => safe(raw.cover.cancel),
    coverFromFile: (id, filePath) => safe(raw.cover.setFromFile, id, filePath),
    coverFromData: (id, dataUrl) => safe(raw.cover.setFromData, id, dataUrl),
    coverSteam: (id) => safe(raw.cover.fetchSteam, id),
    /** 详情页用：按名字联网搜这款游戏的封面（没记 AppID 也能搜） */
    coverSearchOne: (id) => safe(raw.cover.searchOne, id),
    coverReset: (id) => safe(raw.cover.reset, id),

    /* ---------------- 游玩统计 ---------------- */
    stats: (period) => safe(raw.stats.get, period),

    /* ---------------- 自定义分类 ---------------- */
    categoryAdd: (name) => safe(raw.category.add, name),
    categoryRename: (oldName, newName) => safe(raw.category.rename, oldName, newName),
    categoryRemove: (name) => safe(raw.category.remove, name),

    /* ---------------- 游戏平台 ---------------- */
    /** 只检测平台装没装，很快 */
    platformList: () => safe(raw.platform.list),
    /** 同步某平台的账号 + 游戏库（Steam 能拿全，其它平台尽力而为） */
    platformSync: (args) => safe(raw.platform.sync, args),
    /** 拉起平台客户端：install / run / store / open */
    platformAction: (args) => safe(raw.platform.action, args),

    /* ---------------- Epic 账号登录 ---------------- */
    /** 当前登录态；available=false 表示这个功能没初始化 */
    epicStatus: () => safe(raw.epic.status),
    /** 弹 Epic 官方登录页让用户授权，返回 {ok, account} */
    epicLogin: () => safe(raw.epic.login),
    /** 清掉本机凭证 */
    epicLogout: () => safe(raw.epic.logout),

    /* ---------------- MOD 管理 ---------------- */
    /**
     * 列出某款游戏的 MOD。
     * online=false 时只用本地 + 缓存（秒出），适合先把界面画出来再联网补名字。
     */
    modList: (args) => safe(raw.mod.list, args || {}),
    /** 启用 / 禁用（靠改文件名实现，可逆） */
    modSetEnabled: (args) => safe(raw.mod.setEnabled, args || {}),
    /** 删除 —— 进回收站，不是真删。args: { gameId, path } */
    modRemove: (args) => safe(raw.mod.remove, args || {}),
    /** 手动添加（不传 path 就弹选择框） */
    modAddManual: (args) => safe(raw.mod.addManual, args || {}),
    /** 只是从 GameHub 的列表里去掉，不碰磁盘文件 */
    modForget: (args) => safe(raw.mod.forget, args || {}),
    modReveal: (args) => safe(raw.mod.reveal, args || {}),
    /** 打开 Steam 创意工坊：args.client=true 走 Steam 客户端，否则走网页 */
    modOpenWorkshop: (args) => safe(raw.mod.openWorkshop, args || {}),
    /** 打开 N 网（Nexus Mods）的游戏搜索页 */
    modOpenNexus: (args) => safe(raw.mod.openNexus, args || {}),
    /** 在内置浏览器里打开 N 网 —— 下载会被接管到该游戏的 MOD 目录 */
    modBrowse: (args) => safe(raw.mod.browse, args || {}),
    /** 预览这款游戏的 MOD 会下载到哪 */
    modDownloadTarget: (args) => safe(raw.mod.downloadTarget, args || {}),
    /** 手动指定这款游戏的 MOD 目录（不传 dir 会弹选择框） */
    modSetModDir: (args) => safe(raw.mod.setModDir, args || {}),

    /* ---------------- MOD 快速导入 / 打包 / MOD 码（对齐工具） ---------------- */
    /** 拖入的路径数组 → 解压/复制进该游戏的 MOD 目录 */
    modImportDrop: (args) => safe(raw.modPort.importDrop, args || {}),
    /** 把这款游戏的 MOD 打包成一个 zip */
    modPack: (args) => safe(raw.modPort.pack, args || {}),
    /** 生成 MOD 码 */
    modCode: (args) => safe(raw.modPort.code, args || {}),
    /** 导入别人的 MOD 码并和本地对比 */
    modCodeDiff: (args) => safe(raw.modPort.codeDiff, args || {}),
    /** 快速导入的备选入口：文件选择框多选 */
    modPickFiles: () => safe(raw.modPort.pickFiles),
    /**
     * 拖放的 File → 磁盘路径。
     * ⚠ Electron ≥32 的 File 没有 .path 了，必须走 preload 里的
     *    webUtils.getPathForFile —— File 对象本身过不了 IPC，只能这样。
     */
    pathForFile: (file) => safe(raw.pathForFile, file),

    /* ---------------- 内置浏览器（MOD 管理内嵌 / 导航栏标签页） ---------------- */
    /** 登记标签的 webview guest id，下载钩子按它反查归属 */
    browserAttach: (args) => safe(raw.browser.attach, args || {}),
    /** 关掉服务里的一个标签 */
    browserCloseTab: (tabId) => safe(raw.browser.closeTab, tabId),
    /** 把链接丢给系统浏览器打开 */
    browserOpenExternal: (url) => safe(raw.browser.openExternal, url),
    /** 写入验证 Cookie（Cloudflare cf_clearance 之类） */
    browserSetCookie: (args) => safe(raw.browser.setCookie, args || {}),

    /* ---------------- 隐藏空间 ---------------- */
    hiddenStatus: () => safe(raw.hidden.status),
    hiddenSetup: (pwd, hint) => safe(raw.hidden.setup, pwd, hint),
    hiddenUnlock: (pwd) => safe(raw.hidden.unlock, pwd),
    hiddenLock: () => safe(raw.hidden.lock),
    hiddenSet: (ids, hidden) => safe(raw.hidden.setHidden, ids, hidden),
    hiddenChangePwd: (o, n, h) => safe(raw.hidden.changePassword, o, n, h),
    hiddenDisable: (pwd) => safe(raw.hidden.disable, pwd),

    /* ---------------- 设置 ---------------- */
    settingsGet: () => safe(raw.settings.get),
    settingsSet: (patch) => safe(raw.settings.set, patch),

    /* ---------------- 外观自定义（背景 / 字体） ---------------- */
    /** 取两个栏位当前背景图地址：{ sidebar, content } */
    appearanceUrls: () => safe(raw.appearance.urls),
    /** 选图并应用。args: { slot:'sidebar'|'content', path? } */
    appearanceSetImage: (args) => safe(raw.appearance.setImage, args || {}),
    /** 清掉某一栏的自定义背景图 */
    appearanceClearImage: (args) => safe(raw.appearance.clearImage, args || {}),
    /** 本机可用字体列表 */
    appearanceFonts: () => safe(raw.appearance.fonts),
    /** 窗口系统材质（透出桌面）：'auto' | 'off' | 'acrylic' | 'mica' | 'tabbed' */
    setDesktopMaterial: (mode) => safe(raw.appearance.setDesktopMaterial, mode),
    /** 系统支不支持透出桌面 */
    desktopMaterialSupport: () => safe(raw.appearance.desktopMaterialSupport),
    /** 主进程推来的窗口材质变化（权威值），返回取消监听的函数 */
    onDesktopMaterial: (cb) => {
      try { return raw.appearance.onDesktopMaterial(cb); } catch (_) { return () => {}; }
    },

    /* ---------------- 对话框 ---------------- */
    pickFolder: () => safe(raw.dialog.pickFolder),
    pickFolders: () => safe(raw.dialog.pickFolders),
    pickExe: () => safe(raw.dialog.pickExe),
    pickImage: () => safe(raw.dialog.pickImage),
    pickImages: () => safe(raw.dialog.pickImages),
    message: (opts) => safe(raw.dialog.message, opts),

    /* ---------------- 窗口 ---------------- */
    minimize: () => raw.win.minimize(),
    maximize: () => raw.win.maximize(),
    close: () => raw.win.close(),
  };

  window.API = API;
})();
