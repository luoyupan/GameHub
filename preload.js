/**
 * ============================================================
 *  GameHub - 预加载脚本（Preload Script）
 * ------------------------------------------------------------
 *  运行在「渲染进程」与「主进程」之间的隔离沙箱里。
 *  作用：把主进程的能力，以一个个明确的、受控的方法暴露给前端页面，
 *        前端只能调用这里列出的方法，不能直接碰 Node / 文件系统。
 *  安全要点：contextIsolation 开启 + nodeIntegration 关闭，
 *           所有跨进程调用都必须经过 ipcRenderer.invoke。
 * ============================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程 -> 渲染进程的单向事件白名单（防止监听任意通道） */
const EVENTS = [
  'scan:progress',      // 扫描进度
  'scan:done',          // 扫描结束
  'library:changed',    // 游戏库数据发生变化
  'size:updated',       // 某个游戏目录体积计算完成
  'game:state',         // 游戏运行/退出状态
  'hidden:locked',      // 隐藏空间被自动上锁
  'cover:progress',     // 批量获取封面的进度
  'platform:progress',  // 平台库同步进度
  'browser:event',      // 内置浏览器的动静（标签开关、下载进度等）
  'toast'               // 主进程发来的提示消息
];

contextBridge.exposeInMainWorld('GameHub', {
  /* ---------------- 基础信息 ---------------- */
  info: () => ipcRenderer.invoke('app:info'),

  /* ---------------- 窗口控制（无边框窗口自绘按钮） ---------------- */
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    openDevTools: () => ipcRenderer.invoke('win:devtools')
  },

  /* ---------------- 设置项 ---------------- */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },

  /* ---------------- 外观自定义（左右栏背景 + 字体） ----------------
   * 背景图会被复制进数据目录，所以原图后来删掉也不影响显示。 */
  appearance: {
    /** 取两个栏位当前背景图的地址：{ sidebar, content } */
    urls: () => ipcRenderer.invoke('appearance:urls'),
    /** 选图并应用。args: { slot:'sidebar'|'content', path?:'指定路径' } */
    setImage: (args) => ipcRenderer.invoke('appearance:setImage', args || {}),
    /** 清掉某一栏的自定义背景图 */
    clearImage: (args) => ipcRenderer.invoke('appearance:clearImage', args || {}),
    /** 本机可用字体列表 */
    fonts: () => ipcRenderer.invoke('appearance:fonts'),
    /**
     * 设置窗口的系统背景材质 —— 这是唯一能"透出桌面"的办法。
     * 页面里的 backdrop-filter 只采样页面内内容，看不到窗口外面。
     * mode: 'auto'（跟随背景材质）| 'off'（强制不透）
     *       | 'acrylic'（亚克力）| 'mica'（云母）| 'tabbed'
     */
    setDesktopMaterial: (mode) => ipcRenderer.invoke('appearance:desktopMaterial', mode),
    /** 当前系统支不支持透出桌面（界面靠它决定要不要禁用选项） */
    desktopMaterialSupport: () => ipcRenderer.invoke('appearance:desktopMaterialSupport'),
    /**
     * 监听主进程推来的「窗口材质已变化」。
     * 主进程才是权威：auto 模式下它要按背景材质换算，
     * 页面自己猜容易和真实状态对不上。返回一个取消监听的函数。
     */
    onDesktopMaterial: (cb) => {
      const h = (_e, payload) => cb(payload || {});
      ipcRenderer.on('appearance:material', h);
      return () => ipcRenderer.removeListener('appearance:material', h);
    }
  },

  /* ---------------- 游戏库增删改查 ---------------- */
  library: {
    list: (opts) => ipcRenderer.invoke('library:list', opts || {}),
    add: (game) => ipcRenderer.invoke('library:add', game),
    addMany: (games) => ipcRenderer.invoke('library:addMany', games),
    update: (id, patch, opts) => ipcRenderer.invoke('library:update', id, patch, opts),
    remove: (ids) => ipcRenderer.invoke('library:remove', ids),
    clear: () => ipcRenderer.invoke('library:clear')
  },

  /* ---------------- 启动 / 定位 / 卸载 ---------------- */
  game: {
    launch: (id) => ipcRenderer.invoke('game:launch', id),
    stop: (id) => ipcRenderer.invoke('game:stop', id),
    openFolder: (id) => ipcRenderer.invoke('game:openFolder', id),
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    openUrl: (u) => ipcRenderer.invoke('shell:openUrl', u),
    calcSize: (ids) => ipcRenderer.invoke('game:calcSize', ids),
    /** 卸载前的方案说明：走平台还是本地卸、目录多大、在哪 */
    uninstallInfo: (id) => ipcRenderer.invoke('game:uninstallInfo', id),
    /** 执行卸载。args: { id, mode:'platform'|'software'|'remove' } */
    uninstall: (args) => ipcRenderer.invoke('game:uninstall', args || {})
  },

  /* ---------------- 扫描嗅探 ---------------- */
  scan: {
    auto: (opts) => ipcRenderer.invoke('scan:auto', opts || {}),
    folder: (args) => ipcRenderer.invoke('scan:folder', args || {}),
    cancel: () => ipcRenderer.invoke('scan:cancel'),
    defaultFolders: () => ipcRenderer.invoke('scan:defaultFolders')
  },

  /* ---------------- 封面 / 图标 ---------------- */
  cover: {
    extract: (id) => ipcRenderer.invoke('cover:extract', id),
    extractAll: () => ipcRenderer.invoke('cover:extractAll'),
    steamAll: () => ipcRenderer.invoke('cover:steamAll'),
    // 只给「没有封面」的游戏联网搜封面，搜不到的自动跳过
    fillMissing: (opts) => ipcRenderer.invoke('cover:missing', opts || {}),
    // 中止上面那个批量任务
    cancel: () => ipcRenderer.invoke('cover:cancel'),
    setFromFile: (id, filePath) => ipcRenderer.invoke('cover:setFromFile', { id, filePath }),
    setFromData: (id, dataUrl) => ipcRenderer.invoke('cover:setFromData', { id, dataUrl }),
    fetchSteam: (id) => ipcRenderer.invoke('cover:fetchSteam', id),
    // 详情页用：按名字联网搜这款游戏的封面（没有 AppID 也能用）
    searchOne: (id) => ipcRenderer.invoke('cover:searchOne', id),
    reset: (id) => ipcRenderer.invoke('cover:reset', id)
  },

  /* ---------------- 游玩统计 ---------------- */
  stats: {
    get: (period) => ipcRenderer.invoke('stats:get', period)
  },

  /* ---------------- 自定义分类 ---------------- */
  category: {
    add: (name) => ipcRenderer.invoke('category:add', name),
    rename: (oldName, newName) => ipcRenderer.invoke('category:rename', { oldName, newName }),
    remove: (name) => ipcRenderer.invoke('category:remove', name)
  },

  /* ---------------- 游戏平台（账号 / 游戏库抓取） ---------------- */
  platform: {
    list: () => ipcRenderer.invoke('platform:list'),
    sync: (args) => ipcRenderer.invoke('platform:sync', args || {}),
    // action: install（拉起客户端下载）/ run / store（打开商店页）/ open（打开客户端）
    action: (args) => ipcRenderer.invoke('platform:action', args || {})
  },

  /* ---------------- Epic 账号登录 ----------------
   * 登录走 Epic 官方页面，账号密码不经过 GameHub；
   * 换回来的 token 加密存在本机，只用于读取用户自己的拥有清单与封面。 */
  epic: {
    status: () => ipcRenderer.invoke('epic:status'),
    login: () => ipcRenderer.invoke('epic:login'),
    logout: () => ipcRenderer.invoke('epic:logout')
  },

  /* ---------------- MOD 管理 ----------------
   *  · 列出 / 启用 / 禁用 / 删除（删除一律进回收站，不是真删）
   *  · Steam 游戏点「添加 MOD」= 跳创意工坊；非 Steam 自己选文件夹添加 */
  mod: {
    list: (args) => ipcRenderer.invoke('mod:list', args || {}),
    setEnabled: (args) => ipcRenderer.invoke('mod:setEnabled', args || {}),
    remove: (args) => ipcRenderer.invoke('mod:remove', args || {}),
    addManual: (args) => ipcRenderer.invoke('mod:addManual', args || {}),
    forget: (args) => ipcRenderer.invoke('mod:forget', args || {}),
    reveal: (args) => ipcRenderer.invoke('mod:reveal', args || {}),
    openWorkshop: (args) => ipcRenderer.invoke('mod:openWorkshop', args || {}),
    openNexus: (args) => ipcRenderer.invoke('mod:openNexus', args || {}),
    /**
     * 在**内置浏览器**里打开 N 网找 MOD。
     * 和 openNexus 的区别：这个下载会被 GameHub 接管，
     * 直接落到这款游戏的 MOD 目录，不用自己找文件、自己判断放哪。
     */
    browse: (args) => ipcRenderer.invoke('mod:browse', args || {}),
    /** 预览：这款游戏的 MOD 会下载到哪（打开浏览器前先确认一次） */
    downloadTarget: (args) => ipcRenderer.invoke('mod:downloadTarget', args || {}),
    /** 给这款游戏手动指定 MOD 目录（传 dir 为空则弹选择框） */
    setModDir: (args) => ipcRenderer.invoke('mod:setModDir', args || {})
  },

  /* ---------------- 内置浏览器（MOD 管理内嵌 / 导航栏标签页） ---------------- */
  browser: {
    /**
     * 渲染层报告：标签 tabId 的 webview 挂上来了，guest 的
     * webContents id 是 wcId。下载钩子按它反查归属，必须登记。
     */
    attach: (args) => ipcRenderer.invoke('browser:attach', args || {}),
    /** 关掉服务里的一个标签（渲染层收起内嵌浏览器时调） */
    closeTab: (tabId) => ipcRenderer.invoke('browser:closeTab', String(tabId || '')),
    /** 把单个链接丢给系统浏览器打开（工具条的 ↗ 按钮） */
    openExternal: (url) => ipcRenderer.invoke('browser:openExternal', url),
    /** 写入验证 Cookie（系统浏览器过完 Cloudflare 后搬通行证过来） */
    setCookie: (args) => ipcRenderer.invoke('browser:setCookie', args || {})
  },

  /* ---------------- 隐藏空间 ---------------- */
  hidden: {
    status: () => ipcRenderer.invoke('hidden:status'),
    setup: (password, hint) => ipcRenderer.invoke('hidden:setup', { password, hint }),
    unlock: (password) => ipcRenderer.invoke('hidden:unlock', password),
    lock: () => ipcRenderer.invoke('hidden:lock'),
    setHidden: (ids, hidden) => ipcRenderer.invoke('hidden:setHidden', { ids, hidden }),
    changePassword: (oldPwd, newPwd, hint) =>
      ipcRenderer.invoke('hidden:changePassword', { oldPwd, newPwd, hint }),
    disable: (password) => ipcRenderer.invoke('hidden:disable', password)
  },

  /* ---------------- 系统对话框 ---------------- */
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickFolders: () => ipcRenderer.invoke('dialog:pickFolders'),
    pickExe: () => ipcRenderer.invoke('dialog:pickExe'),
    pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
    pickImages: () => ipcRenderer.invoke('dialog:pickImages'),
    message: (opts) => ipcRenderer.invoke('dialog:message', opts)
  },

  /* ---------------- 事件订阅（返回取消订阅函数） ---------------- */
  on: (channel, handler) => {
    if (!EVENTS.includes(channel)) return () => {};
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
