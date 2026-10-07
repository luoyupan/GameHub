/**
 * ============================================================
 *  GameHub - 游戏平台账号与游戏库抓取  (src/main/platforms.js)
 * ------------------------------------------------------------
 *  作用：把本机各个游戏平台"已经存在本地的那份数据"读出来，
 *        汇成一个统一的账号 + 游戏库快照，交给界面展示。
 *
 *  ⚠⚠ 隐私承诺（这一条是硬约束，改代码时不要破坏）⚠⚠
 *    1. 本模块【只读】本地文件，从不写回任何平台的文件；
 *    2. 绝不读取、更不会保存任何密码 / 令牌 / 登录凭证 ——
 *       看到 settings.yaml 之类的文件也只取用户名、跳过 password 字段；
 *    3. 所有结果只写进 GameHub 自己的 data.json，留在本机；
 *    4. 联网只发生在两个明确的地方，且都是"去公开图床取图片"：
 *         · 下载 Steam 封面（cdn.cloudflare.steamstatic.com）
 *         · 下载 Steam 头像（avatars.steamstatic.com）
 *       都是 GET 公开资源，不携带任何账号信息，也不上传任何东西。
 *
 *  各平台能拿到多少数据差别很大，这里如实处理，不编造：
 *    · Steam          —— 完整（账号 / 全部玩过的游戏 / 时长 / 成就 / 已装状态）
 *    · Epic / Ubisoft / GOG / Battle.net / EA / Xbox
 *                     —— 检测安装与登录状态 + 已安装游戏；账号名尽力而为
 *  拿不到的字段就置空 / 标记 unknown，由界面决定"没有就不显示"。
 * ============================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const scanner = require('./scanner');
const { parseBinaryKV, countAchievements } = require('./vdfbin');
const appinfo = require('./appinfo');
const imgmeta = require('./imgmeta');

/* ==================================================================
 *  一、平台元数据表
 * ================================================================== */

/**
 * 每个平台的静态信息。
 *  protocol  —— 拉起客户端用的自定义协议前缀（"下载/安装某款游戏"会用到）
 *  exeNames  —— 判定"这个平台装没装"的可执行文件名
 *  dataDirs  —— 判定"这个平台有没有登录过/有没有数据"的目录
 */
const PLATFORMS = [
  {
    id: 'steam',
    name: 'Steam',
    short: 'Steam',
    color: '#1b2838',
    accent: '#66c0f4',
    protocol: 'steam://',
    installProtocol: (appId) => `steam://install/${appId}`,
    runProtocol: (appId) => `steam://run/${appId}`,
    storeProtocol: (appId) => `steam://store/${appId}`,
    exeNames: ['steam.exe'],
    installHints: [
      'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam', 'E:\\Steam',
      'F:\\Steam', 'G:\\Steam', 'H:\\Steam', 'I:\\Steam', 'D:\\Program Files (x86)\\Steam',
      'E:\\Program Files (x86)\\Steam', 'F:\\Program Files (x86)\\Steam'
    ],
    // Steam 的库根目录不等于安装目录，要另外用 scanner 的库发现逻辑找
    customFind: 'steam'
  },
  {
    id: 'epic',
    name: 'Epic Games',
    short: 'Epic',
    color: '#2a2a2a',
    accent: '#ffffff',
    protocol: 'com.epicgames.launcher://',
    // ⚠ 这里以前漏了 runProtocol —— 结果是 Epic 的游戏点「启动」
    //   只会得到一句「Epic Games 不支持「run」」。AppName 就是清单里的那个内部名。
    runProtocol: (appId) => (appId ? `com.epicgames.launcher://apps/${appId}?action=launch` : 'com.epicgames.launcher://'),
    installProtocol: () => 'com.epicgames.launcher://store',
    storeProtocol: () => 'com.epicgames.launcher://store',
    exeNames: ['EpicGamesLauncher.exe'],
    installHints: [
      'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32',
      'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64',
      'D:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32'
    ],
    dataDirs: [
      () => path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic'),
      () => path.join(process.env.LOCALAPPDATA || '', 'EpicGamesLauncher')
    ],
    // 已安装游戏：Epic 用 .item(JSON) 清单
    manifests: () => path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  },
  {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    short: 'Ubisoft',
    color: '#0b1a2b',
    accent: '#00b3ff',
    protocol: 'uplay://',
    installProtocol: () => 'uplay://install',
    storeProtocol: () => 'uplay://store',
    exeNames: ['UbisoftConnect.exe', 'Uplay.exe', 'upc.exe'],
    installHints: [
      'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher',
      'C:\\Program Files\\Ubisoft\\Ubisoft Game Launcher'
    ],
    dataDirs: [() => path.join(process.env.LOCALAPPDATA || '', 'Ubisoft Game Launcher')]
  },
  {
    id: 'gog',
    name: 'GOG Galaxy',
    short: 'GOG',
    color: '#2b1a3d',
    accent: '#a259ff',
    protocol: 'goggalaxy://',
    installProtocol: () => 'goggalaxy://openStore',
    storeProtocol: () => 'goggalaxy://openStore',
    exeNames: ['GalaxyClient.exe'],
    installHints: [
      'C:\\Program Files (x86)\\GOG Galaxy',
      'C:\\Program Files\\GOG Galaxy'
    ],
    dataDirs: [() => path.join(process.env.LOCALAPPDATA || '', 'GOG.com')]
  },
  {
    id: 'battlenet',
    name: 'Battle.net',
    short: '战网',
    color: '#0a1a3d',
    accent: '#00aeff',
    protocol: 'battlenet://',
    installProtocol: () => 'battlenet://',
    storeProtocol: () => 'battlenet://',
    exeNames: ['Battle.net.exe', 'Battle.net Launcher.exe'],
    installHints: [
      'C:\\Program Files (x86)\\Battle.net',
      'C:\\Program Files\\Battle.net'
    ],
    dataDirs: [() => path.join(process.env.LOCALAPPDATA || '', 'Battle.net')]
  },
  {
    id: 'ea',
    name: 'EA App',
    short: 'EA',
    color: '#1a0a0a',
    accent: '#ff4d4d',
    protocol: 'origin://',
    installProtocol: () => 'origin://',
    storeProtocol: () => 'origin://store',
    exeNames: ['EADesktop.exe', 'Origin.exe'],
    installHints: [
      'C:\\Program Files\\Electronic Arts\\EA Desktop',
      'C:\\Program Files (x86)\\Origin'
    ],
    dataDirs: [() => path.join(process.env.LOCALAPPDATA || '', 'Electronic Arts')]
  },
  {
    id: 'xbox',
    name: 'Xbox',
    short: 'Xbox',
    color: '#0d2a16',
    accent: '#6fdc8c',
    protocol: 'ms-gamingoverlay://',
    installProtocol: () => 'ms-gamingoverlay://',
    storeProtocol: () => 'ms-windows-store://gaming',
    exeNames: [],
    installHints: [],
    // Xbox 应用是 UWP，只能通过包目录判断
    dataDirs: [
      () => path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.GamingApp_8wekyb3d8bbwe')
    ]
  }
];

/* ==================================================================
 *  二、小工具
 * ================================================================== */

async function exists(p) {
  if (!p) return false;
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return ''; }
}

async function readJson(p) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
}

/** 列出目录下的文件（可选按后缀过滤），失败返回空数组 */
async function listDir(dir, suffixRe) {
  try {
    const names = await fsp.readdir(dir);
    return suffixRe ? names.filter((n) => suffixRe.test(n)) : names;
  } catch { return []; }
}

/** 从一堆候选路径里找第一个存在的 */
async function firstExisting(paths) {
  for (const p of paths) if (await exists(p)) return p;
  return '';
}

/**
 * 递归列出目录里的所有文件（含子目录），最多下探 depth 层。
 * 用来对付 Steam 那种 <appid>/<hash>/xxx.jpg 的两层结构。
 */
function listFilesDeep(dir, depth, out = []) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isFile()) out.push(p);
    else if (st.isDirectory() && depth > 0) listFilesDeep(p, depth - 1, out);
  }
  return out;
}

/**
 * 素材语言优先级。
 * 这套界面是中文的，所以官方中文素材排最前；
 * 空字符串代表"没有语言后缀"的默认素材（通常是英文原版图）。
 */
const LANG_PREF = ['schinese', 'tchinese', '', 'english', 'japanese', 'koreana'];

/**
 * 按"名字前缀 + 语言 + 宽高比"给一张素材打分，分越低越好；名字对不上返回 null。
 *
 * @param {string} name 文件名
 * @param {{w:number,h:number}} size 真实尺寸
 * @param {string[]} prefixes 认的几种前缀（越靠前越优先，比如 library_hero > header）
 * @param {{exclude?:string[], idealRatio?:number}} opts
 */
function scoreAsset(name, size, prefixes, opts = {}) {
  const lower = String(name).toLowerCase();
  const pi = prefixes.findIndex((p) => lower.startsWith(p));
  if (pi < 0) return null;

  const rest = lower.slice(prefixes[pi].length);       // 例：'_schinese.jpg' / '.jpg'
  if ((opts.exclude || []).some((e) => rest.includes(e))) return null; // 例如 hero_blur

  const lang = rest.replace(/\.[a-z0-9]+$/, '').replace(/^_/, '');
  let li = LANG_PREF.indexOf(lang);
  if (li < 0) li = LANG_PREF.length + 1;

  // 尺寸越接近理想宽高比越优先 —— 名字靠得住时这只是个弱权重，
  // 名字全对不上时靠它兜底（见 pickAsset 的第二轮）
  const ratioOff = opts.idealRatio
    ? Math.round(Math.abs(imgmeta.aspect(size) - opts.idealRatio) * 1000)
    : 0;

  return pi * 1000000 + li * 10000 + ratioOff * 10 + name.length;
}

/**
 * 从一堆图片里挑出某类素材（竖版封面 / 横版大图 / 标志）。
 * 两轮：先认名字（快，不读内容），名字都不认识再按尺寸特征兜底。
 *
 * @param {Array} imgs  [{path,name,size}]，size 可以为 null
 * @param {string} kind 'cover' | 'hero' | 'logo'
 * @param {{skipSize?:boolean}} [opts] skipSize=true 表示只认名字，不用尺寸兜底
 * @returns {{path:string,name:string,size:object}|null}
 */
function pickAsset(imgs, kind, opts = {}) {
  const spec = {
    // 竖版封面：图书馆里那种 2:3 的立绘
    cover: { prefixes: ['library_600x900', 'library_capsule'], ideal: 300 / 450 },
    // 横版大图：详情页顶部背景，别把模糊版 blur 选进来
    hero: { prefixes: ['library_hero', 'library_header', 'header'], ideal: 1920 / 620, exclude: ['blur'] },
    // 标志：通常是透明底 png
    logo: { prefixes: ['library_logo', 'logo'], ideal: 0 }
  }[kind];
  if (!spec) return null;

  /* ---- 第一轮：认名字 ---- */
  let best = null;
  let bestScore = Infinity;
  for (const im of imgs) {
    const s = scoreAsset(im.name, im.size, spec.prefixes, {
      exclude: spec.exclude,
      idealRatio: opts.skipSize ? 0 : spec.ideal
    });
    if (s === null) continue;
    if (s < bestScore) { bestScore = s; best = im; }
  }
  if (best || opts.skipSize) return best;

  /* ---- 第二轮：名字全不认，按真实宽高比兜底 ---- */
  const band = {
    cover: [0.5, 0.85],     // 竖版
    hero: [2.0, 4.0],       // 超宽横幅
    logo: [0.8, 4.0]
  }[kind];
  let fallback = null;
  let fallbackArea = 0;
  for (const im of imgs) {
    const r = imgmeta.aspect(im.size);
    if (!r || r < band[0] || r > band[1]) continue;
    const area = im.size.w * im.size.h;
    if (area > fallbackArea) { fallbackArea = area; fallback = im; }
  }
  return fallback;
}

/** Steam 的 32 位账号 ID ↔ 64 位 SteamID 互转 */
const STEAM_ID_BASE = 76561197960265728n;
function accountIdToSteamId64(accountId) {
  return String(BigInt(accountId) + STEAM_ID_BASE);
}
function steamId64ToAccountId(id64) {
  try { return String(BigInt(id64) - STEAM_ID_BASE); } catch { return ''; }
}

/** 分钟 → 毫秒（顺便挡掉异常值） */
function minutesToMs(min) {
  const n = Number(min);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60000) : 0;
}

/* ==================================================================
 *  三、Steam 适配器（唯一能做到"完整"的平台）
 * ================================================================== */

const Steam = {
  /**
   * 列举 appcache/librarycache/<appid>/ 里已经缓存好的封面。
   *
   * 这比联网下载靠谱得多：实测 steamcommunity.com / api.steampowered.com
   * 在本机都不通，而客户端自己缓存的封面覆盖了大半游戏，而且是纯离线、秒出。
   *
   * ⚠ 这个目录的文件名很花，不能按固定文件名去取（试过，只能命中一半）：
   *   ① 有些是带语言后缀的：library_600x900_schinese.jpg、header_schinese.jpg
   *   ② 有些被塞进一层哈希子目录里：<appid>/<hash>/library_hero.jpg
   *   ③ 还有些是 0 字节或几百字节的哈希占位文件（名字没扩展名）
   *   ④ 竖版封面在有些游戏里叫 library_capsule 而不是 library_600x900
   *   ⑤ header / library_header 也是两种叫法
   * 所以这里的做法是：先把文件捞全（含子目录），
   * 按"名字前缀 + 真实宽高比"一起判断，名字不靠谱时用尺寸兜底。
   *
   * @returns {Map<string,{cover:string,hero:string,logo:string}>}
   */
  async localCovers(root, wantIds) {
    const base = path.join(root, 'appcache', 'librarycache');
    const out = new Map();

    // 只扫游戏库里真正要展示的那几个 appid。全目录有 958 个，库里只用到 248 个，
    // 不筛的话白白多花一倍多时间（实测 1.7s → 0.4s）。
    let dirs = await listDir(base, /^\d+$/);
    if (wantIds && wantIds.size) dirs = dirs.filter((d) => wantIds.has(d));

    /** 量一张图的真实尺寸（只读文件头 64KB） */
    const probe = (f) => {
      try {
        const fd = fs.openSync(f, 'r');
        const head = Buffer.alloc(65536);
        const n = fs.readSync(fd, head, 0, 65536, 0);
        fs.closeSync(fd);
        return imgmeta.imageSize(head.slice(0, n));
      } catch { return { w: 0, h: 0, type: '' }; }
    };

    for (const id of dirs) {
      const files = listFilesDeep(path.join(base, id), 2);
      if (!files.length) continue;

      // 先按体积和文件名粗筛，尽量少开文件句柄
      const imgs = [];
      for (const f of files) {
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (!st.isFile() || st.size < 1024) continue;   // 挡掉 0 字节 / 690 字节的占位文件
        // 只看"像图片的"和完全没有扩展名的（新版 Steam 会把图存成哈希名），其余跳过
        if (!imgmeta.looksLikeImageName(f) && path.extname(f)) continue;
        imgs.push({ path: f, name: path.basename(f), size: null });
      }
      if (!imgs.length) continue;

      /* ---- 第一轮：纯认名字，不读文件内容（绝大多数情况这一步就够） ---- */
      const byName = (kind) => pickAsset(imgs, kind, { skipSize: true });
      let cover = byName('cover');
      let hero = byName('hero');
      const logo = byName('logo');

      /* ---- 第二轮：只有名字全对不上，才真的去量尺寸兜底 ---- */
      if (!cover || !hero) {
        for (const im of imgs) im.size = probe(im.path);
        if (!cover) cover = pickAsset(imgs, 'cover');
        if (!hero) hero = pickAsset(imgs, 'hero');
      }

      if (cover || hero || logo) {
        out.set(id, {
          cover: cover ? cover.path : '',
          hero: hero ? hero.path : '',
          logo: logo ? logo.path : ''
        });
      }
    }
    return out;
  },

  /**
   * 读 appcache/appinfo.vdf —— 客户端缓存的官方应用信息。
   * 这是"没安装的游戏"能拿到**正确名字**的最可靠来源：
   * 成就 schema 里的 gamename 有时是内部代号（260 号会被叫成 ValveTestApp260，
   * 其实它是 CS2），而 appinfo 里就是商店上那个正式名。
   */
  async appInfo(root) {
    return appinfo.parseAppInfo(path.join(root, 'appcache', 'appinfo.vdf'));
  },

  /** 找到 Steam 主安装目录（就是那个带 config/loginusers.vdf 的库） */
  async findInstall() {
    // scanner 里已经有一套成熟逻辑：探 26 个盘符 + 读 libraryfolders.vdf，
    // 能认出 I:\Steam 这种非常规位置。直接复用，别重复造轮子。
    let libs = [];
    try { libs = await scanner.findSteamLibraries(() => {}); } catch { libs = []; }

    for (const lib of libs) {
      if (await exists(path.join(lib, 'config', 'loginusers.vdf'))) return lib;
    }
    // 没有 loginusers.vdf（没登录过）也要能认出"装了 Steam"
    const meta = PLATFORMS.find((p) => p.id === 'steam');
    for (const p of meta.installHints) if (await exists(p)) return p;
    return libs[0] || '';
  },

  /** 读 loginusers.vdf → 本机记住过的所有 Steam 账号 */
  async accounts(root) {
    const txt = await readText(path.join(root, 'config', 'loginusers.vdf'));
    if (!txt) return [];
    let obj = {};
    try { obj = scanner.parseVdf(txt).users || {}; } catch { return []; }

    return Object.entries(obj).map(([id64, v]) => {
      const accId = steamId64ToAccountId(id64);
      return {
        id: id64,
        accountId: accId,
        accountName: (v && v.AccountName) || '',
        personaName: (v && (v.PersonaName || v.AccountName)) || `Steam 用户 ${id64.slice(-4)}`,
        // 最近登录过的账号最可能是"当前在用"的
        autoLogin: !!(v && v.AutoLogin === '1'),
        lastLogin: Number((v && v.Timestamp) || 0) * 1000
      };
    }).sort((a, b) => (b.autoLogin - a.autoLogin) || (b.lastLogin - a.lastLogin));
  },

  /** 读某个账号的 localconfig.vdf → 账号详情 + 玩过的游戏与时长 */
  async userData(root, account) {
    const dir = path.join(root, 'userdata', account.accountId);
    const txt = await readText(path.join(dir, 'config', 'localconfig.vdf'));
    if (!txt) return { profile: null, apps: {} };

    let store = {};
    try { store = scanner.parseVdf(txt).UserLocalConfigStore || {}; } catch { /* 坏文件当空处理 */ }

    // 账号自身的信息（昵称、头像哈希、等级）
    const friends = store.friends || {};
    const me = friends[account.accountId] || {};
    const software = ((store.Software || {}).Valve || {}).Steam || {};
    const profile = {
      personaName: friends.PersonaName || me.name || account.personaName,
      avatarHash: me.avatar || '',
      level: Number(software.PlayerLevel || 0) || 0
    };

    // 游戏与时长：Software.Valve.Steam.apps.<appid> = { Playtime, LastPlayed, Playtime2wks }
    const apps = software.apps || {};
    return { profile, apps };
  },

  /**
   * 只读「时长 + 最近游玩」，别的什么都不碰。
   *
   * 为什么要单独开这么一个方法，而不复用 sync()：
   *   sync() 要读 appinfo.vdf（3.6MB）+ 扫 250 个成就文件 + 找封面，秒级；
   *   这里只解析一个 localconfig.vdf，是毫秒级的。
   *   启动后在后台悄悄对一次库里的时长，用 sync() 会把开机拖慢，用这个不会。
   *
   * ⚠ 语义说明：Steam 记的是**累计时长**，而且只在正常退出游戏时才落盘。
   *   所以这是"下限"而不是实时值，绝不能拿它去覆盖更大的本地记录。
   *
   * @returns {Promise<{ok:boolean, accountId:string, apps:Object<string,{playtimeMs:number,lastPlayed:number}>}>}
   */
  async steamPlaytimes(opts = {}) {
    const root = await this.findInstall();
    if (!root) return { ok: false, reason: 'no-steam', apps: {} };

    const accounts = await this.accounts(root);
    if (!accounts.length) return { ok: false, reason: 'no-account', apps: {} };

    const account = (opts.accountId
      && accounts.find((a) => a.id === opts.accountId || a.accountId === opts.accountId))
      || accounts[0];

    const { apps } = await this.userData(root, account);
    const out = {};
    for (const [appId, v] of Object.entries(apps || {})) {
      if (!appId || appId === '0' || !v) continue;
      const ms = minutesToMs(v.Playtime);
      const last = Number(v.LastPlayed || 0) * 1000;
      if (ms > 0 || last > 0) out[appId] = { playtimeMs: ms, lastPlayed: last };
    }
    return { ok: true, accountId: account.accountId, accountName: account.personaName, apps: out };
  },

  /**
   * 读 appcache/stats 里的成就。
   *
   * 顺带把 schema 里的 gamename 收集起来 —— 这是"没安装的游戏"唯一能离线拿到名字的地方。
   *
   * @returns {{map:Map<string,{unlocked:number,total:number}|null>, names:Map<string,string>}}
   *   map 里值为 null 表示"本地没有这个游戏的成就缓存"，
   *   ⚠ 这跟"0 个成就"是两回事，绝不能混为一谈！
   */
  async achievements(root, accountId) {
    const dir = path.join(root, 'appcache', 'stats');
    const files = await listDir(dir);
    const map = new Map();
    const names = new Map();
    if (!files.length) return { map, names, statsFileCount: 0, userFileCount: 0 };

    // ① 先把所有 schema 扫一遍：拿到 总数 + 游戏名
    const schemaByName = new Map();   // appid → schema 对象
    for (const f of files) {
      const m = f.match(/^UserGameStatsSchema_(\d+)\.bin$/);
      if (!m) continue;
      try {
        const schema = parseBinaryKV(await fsp.readFile(path.join(dir, f)))[m[1]];
        if (!schema) continue;
        schemaByName.set(m[1], schema);
        if (schema.gamename) names.set(m[1], String(schema.gamename));
      } catch { /* 个别坏文件跳过 */ }
    }

    // ② 再读该账号的进度位图，两两配对算出"已解锁/总数"
    //    每个文件只有几百字节，实测 250 个约 0.4 秒，可接受
    const myFiles = files.filter((f) => f.startsWith(`UserGameStats_${accountId}_`));
    for (const f of myFiles) {
      const m = f.match(/_(\d+)\.bin$/);
      if (!m) continue;
      const appId = m[1];
      const schema = schemaByName.get(appId);
      if (!schema) continue;

      let user;
      try { user = parseBinaryKV(await fsp.readFile(path.join(dir, f))); } catch { continue; }

      const r = countAchievements(schema, user);
      // cache 里必须有"数字分组键"才说明真的缓存了进度；
      // 只有 crc / PendingChanges 的是 38 字节的空壳，属于"本地没有数据"。
      const cacheHasGroups = Object.keys(user.cache || {}).some((k) => /^\d+$/.test(k));
      map.set(appId, (r.hasAchievements && cacheHasGroups) ? { unlocked: r.unlocked, total: r.total } : null);
    }

    return { map, names, statsFileCount: files.length, userFileCount: myFiles.length };
  },

  /** 读所有库里已安装的游戏：appmanifest_*.acf */
  async installed(root) {
    let libs = [];
    try { libs = await scanner.findSteamLibraries(() => {}); } catch { libs = []; }
    if (root && !libs.includes(root)) libs.push(root);

    const out = new Map();
    for (const lib of libs) {
      const sa = path.join(lib, 'steamapps');
      const files = await listDir(sa, /^appmanifest_\d+\.acf$/i);
      for (const f of files) {
        const txt = await readText(path.join(sa, f));
        if (!txt) continue;
        let s = null;
        try { s = scanner.parseVdf(txt).AppState; } catch { continue; }
        if (!s || !s.appid) continue;
        out.set(String(s.appid), {
          appId: String(s.appid),
          name: s.name || '',
          installDir: path.join(sa, 'common', s.installdir || s.name || ''),
          sizeBytes: Number(s.SizeOnDisk || 0) || 0,
          lastUpdated: Number(s.LastUpdated || 0) * 1000,
          stateFlags: Number(s.StateFlags || 0) || 0
        });
      }
    }
    return out;
  },

  /**
   * 完整同步 Steam。
   * @param {object} opts
   *   accountId  指定账号（不传 = 用最可能"当前在用"的那个）
   *   onProgress 进度回调
   */
  async sync(opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const root = await this.findInstall();
    if (!root) {
      return { detected: false, installPath: '', loggedIn: false, games: [], warnings: ['没有在本机找到 Steam'] };
    }

    const accounts = await this.accounts(root);
    if (!accounts.length) {
      return {
        detected: true, installPath: root, loggedIn: false, accounts: [], games: [],
        warnings: ['Steam 装了，但没有找到已登录的账号（loginusers.vdf 为空）']
      };
    }

    const account = (opts.accountId && accounts.find((a) => a.id === opts.accountId || a.accountId === opts.accountId)) || accounts[0];
    onProgress({ phase: 'platform', message: `读取 Steam 账号「${account.personaName}」…` });

    const { profile, apps } = await this.userData(root, account);
    onProgress({ phase: 'platform', message: '统计成就数据…' });
    const ach = await this.achievements(root, account.accountId);
    onProgress({ phase: 'platform', message: '核对已安装的游戏…' });
    const inst = await this.installed(root);

    // appid=0 是 Steam 用来记"不在任何 app 里"的时长，不是真游戏，剔掉
    const appIds = new Set([...Object.keys(apps), ...inst.keys()].filter((id) => id && id !== '0'));

    // 名字第一优先：客户端缓存的官方应用信息（3.6MB，实测 1500 条里有 1474 条有名字）
    const info = await this.appInfo(root);
    // 本地已缓存的封面（离线），只扫游戏库里用得到的那些 appid
    const covers = await this.localCovers(root, appIds);

    /* ---- 合并成统一的游戏列表 ---- */
    const games = [];
    const warnings = [];

    let nameFromInfo = 0;
    let nameFallback = 0;

    for (const appId of appIds) {
      const local = apps[appId] || {};
      const ins = inst.get(appId) || null;
      const meta = info.get(appId) || null;
      const cov = covers.get(appId) || null;

      // 名字优先级：appinfo.vdf（官方名，最准）
      //              > 已安装清单 acf
      //              > 成就 schema 的 gamename（可能是内部代号）
      //              > 兜底 "Steam App xxx"（至少不是一片空白）
      let name = (meta && meta.name) || '';
      if (name) nameFromInfo++;
      else if (ins && ins.name) name = ins.name;
      else if (ach.names.get(appId)) name = ach.names.get(appId);
      else { name = `Steam App ${appId}`; nameFallback++; }

      games.push({
        platformId: 'steam',
        appId,
        name,
        // 顺手把开发商/发行商带上（详情页可能用得上，界面没数据时会自动不显示）
        developer: meta ? meta.developer : '',
        publisher: meta ? meta.publisher : '',
        clientIcon: meta ? meta.clientIcon : '',
        appType: meta ? meta.type : '',
        // 封面：优先用客户端缓存好的（离线），没有再交给联网逻辑去补
        localCover: cov ? cov.cover : '',
        localHero: cov ? cov.hero : '',
        localLogo: cov ? cov.logo : '',
        playtimeMs: minutesToMs(local.Playtime),
        playtime2wksMs: minutesToMs(local.Playtime2wks),
        lastPlayed: Number(local.LastPlayed || 0) * 1000,
        achievements: ach.map.get(appId) || null,
        installed: !!ins,
        installDir: ins ? ins.installDir : '',
        sizeBytes: ins ? ins.sizeBytes : 0,
        // 没装、也没时长记录 → 多半是"领了没下"
        neverPlayed: !local.Playtime
      });
    }

    if (nameFallback > 0) {
      warnings.push(`有 ${nameFallback} 个游戏在 Steam 本地缓存里查不到名字，已用 "Steam App + ID" 占位`);
    }

    games.sort((a, b) => (b.playtimeMs - a.playtimeMs) || a.name.localeCompare(b.name, 'zh'));

    const totalPlayMs = games.reduce((s, g) => s + g.playtimeMs, 0);
    let achUnlocked = 0;
    let achTotal = 0;
    let achGames = 0;
    for (const g of games) {
      if (!g.achievements) continue;
      achGames++;
      achUnlocked += g.achievements.unlocked;
      achTotal += g.achievements.total;
    }

    return {
      detected: true,
      installPath: root,
      loggedIn: true,
      account: {
        id: account.id,
        accountId: account.accountId,
        accountName: account.accountName,
        name: (profile && profile.personaName) || account.personaName,
        avatarHash: (profile && profile.avatarHash) || '',
        level: (profile && profile.level) || 0
      },
      accounts,
      games,
      stats: {
        owned: games.length,
        installed: games.filter((g) => g.installed).length,
        notInstalled: games.filter((g) => !g.installed).length,
        withLocalCover: games.filter((g) => g.localCover).length,
        totalPlayMs,
        achGames,
        achUnlocked,
        achTotal
      },
      warnings
    };
  }
};

/* ==================================================================
 *  四、其它平台：检测 + 已安装清单（尽力而为）
 * ================================================================== */

/** 通用：找安装目录 */
async function findInstallDir(meta) {
  // ① 先看 exe 是否存在
  if (meta.exeNames && meta.exeNames.length) {
    const candidates = [];
    for (const hint of meta.installHints || []) {
      for (const exe of meta.exeNames) candidates.push(path.join(hint, exe));
    }
    // 也探一遍所有盘符（跟 scanner 的思路一致，应对自定义安装位置）
    for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const hint of meta.installHints || []) {
        const rel = hint.replace(/^[A-Z]:/i, '');
        for (const exe of meta.exeNames) candidates.push(`${d}:${rel}${path.sep}${exe}`);
      }
    }
    const hit = await firstExisting(candidates);
    if (hit) return { path: path.dirname(hit), exe: hit };
  }
  // ② exe 找不到（比如 UWP 应用），退化为"看数据目录在不在"
  for (const f of meta.dataDirs || []) {
    const p = f();
    if (await exists(p)) return { path: '', exe: '', dataOnly: true };
  }
  return null;
}

/* ==================================================================
 *  Epic：本机安装清单
 * ------------------------------------------------------------
 *  ⚠ 时效性提醒：Epic 在 2026 年推出了重构版启动器，清单路径有可能随之改变。
 *    所以下面的实现刻意**同时探三处**，且每一处都单独失败无害 ——
 *    任何一处失效（路径改了 / reg 被安全策略拦了）都只会少一个源，
 *    不会让整个 Epic 检测挂掉。这也是为什么不把三个源写成"层层依赖"。
 * ================================================================== */

/**
 * 读注册表里的一个字符串值。
 * 读不到一律返回 ''，**绝不抛错** —— 有些安全策略会直接禁掉 reg.exe，
 * 那不是我们能修复的事，当作"这条兜底路径不存在"就行。
 */
async function readRegValue(key, valueName) {
  try {
    // 延迟 require：只有真的用到才引入，避免给模块加顶层依赖
    const { execFile } = require('child_process');
    const out = await new Promise((resolve, reject) => {
      execFile('reg', ['query', key, '/v', valueName],
        { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
    });
    const m = new RegExp(`${valueName}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'im').exec(out);
    return m ? m[1].trim() : '';
  } catch {
    return ''; // reg 不存在 / 被拦 / 键不存在 —— 一律当作读不到
  }
}

/** Manifests 目录的所有候选位置（含注册表里自定义的 AppDataPath） */
async function epicManifestDirs() {
  const pd = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const dirs = [path.join(pd, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')];

  // 有人把 Epic 的用户数据整个挪到别的盘了，注册表里会记着真实位置
  const appDataPath = await readRegValue(
    'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'AppDataPath'
  );
  if (appDataPath) {
    dirs.push(path.join(appDataPath, 'Data', 'Manifests'));
    dirs.push(appDataPath); // 少数情况下 AppDataPath 直接就指着 Manifests
  }
  return [...new Set(dirs)];
}

/**
 * 把一条 Epic 安装记录（.item 文件、或 LauncherInstalled.dat 里的一项）
 * 折算成统一的游戏形状。
 *
 * 过滤原则：**宁可多留一条，不可误杀一条**。
 * 用户明明装了却看不见，比多出来一条 DLC 条目伤害大得多，
 * 所以只在"明确能确定不是游戏本体"时才剔除。
 *
 * @returns {object|null} null 表示不是游戏本体，直接剔掉
 */
function epicGameFromManifest(j) {
  if (!j || typeof j !== 'object') return null;

  const appId = String(j.AppName || j.CatalogItemId || '').trim();
  if (!appId) return null;

  const cats = (Array.isArray(j.AppCategories) ? j.AppCategories : [])
    .map((c) => String(c).toLowerCase());
  const isGame = cats.includes('games');
  const isAddon = cats.includes('addons');
  const launchExe = String(j.LaunchExecutable || '').trim();

  // ① 清单自己说了不是应用本体 → 多半是依附于主游戏的补丁 / 附加包
  if (j.bIsApplication === false) return null;
  // ② 附加内容。别只看有没有 'addons' —— DLC 的记录常常**同时**写着
  //    ["addons","games"]，真正能把主游戏和它区分开的是 LaunchExecutable：
  //    主游戏一定告诉你启动谁，DLC 没有自己的入口。两个条件凑齐才杀。
  if (isAddon && (!isGame || !launchExe)) return null;
  // ③ engines / applications 等非游戏内容（Unreal Engine 就是 applications）
  if (cats.length && !isGame) return null;
  // ④ 连 AppCategories 都没有的裸记录：至少得告诉我们启动哪个 exe 才收下
  if (!cats.length && !launchExe) return null;

  const installDir = String(j.InstallLocation || '').trim();

  return {
    platformId: 'epic',
    appId,
    name: String(j.DisplayName || j.AppName || appId).trim(),
    namespace: String(j.CatalogNamespace || '').trim(),
    catalogItemId: String(j.CatalogItemId || '').trim(),
    version: String(j.AppVersionString || '').trim(),
    launchExe,
    // 拼好的 exe 完整路径 —— 有它才能「不经 Epic 客户端直接启动」，
    // 启动方式是 `{launchPath} -epicportal`（B 路线的自己计时也靠它）
    launchPath: installDir && launchExe ? path.join(installDir, launchExe) : '',
    installed: true,
    installDir,
    sizeBytes: Number(j.InstallSize || 0) || 0,
    /* ⚠ 下面这几个字段 Epic 的**本地文件里根本没有**，不是我们没读到：
     *   累计时长只存在于 Epic 服务器上、成就要走 GraphQL —— 离线一概拿不到。
     *   所以这里如实留空，交给「登录 Epic 账号」那条路去填，界面上也会标注来源。 */
    playtimeMs: 0,
    lastPlayed: Number(j.LastLaunchTime ? new Date(j.LastLaunchTime).getTime() : 0) || 0,
    achievements: null,
    neverPlayed: true,
    // 'local' = 本机安装清单；'api' = 登录后从 Epic 拉到的拥有清单。合并时要用。
    source: 'local'
  };
}

/**
 * 读本机已安装的 Epic 游戏。
 *
 * 三个数据源，全部尽力而为，任一可用即可：
 *   ① 现行 —— %PROGRAMDATA%\Epic\EpicGamesLauncher\Data\Manifests\*.item
 *   ② 旧版 —— %PROGRAMDATA%\Epic\UnrealEngineLauncher\LauncherInstalled.dat
 *   ③ 兜底 —— 注册表 AppDataPath 指向的自定义 Manifests 目录
 *
 * @returns {Promise<Array<object>>}
 */
async function epicInstalled() {
  const out = new Map(); // appId -> game，用 Map 天然去重

  /* ---- ① 现行：Manifests 目录下的每个 .item 是一款已安装内容 ---- */
  for (const dir of await epicManifestDirs()) {
    for (const f of await listDir(dir, /\.item$/i)) {
      const g = epicGameFromManifest(await readJson(path.join(dir, f)));
      if (g && !out.has(g.appId)) out.set(g.appId, g);
    }
  }

  /* ---- ② 旧版：UnrealEngineLauncher 的汇总清单 ---- */
  const dat = path.join(
    process.env.PROGRAMDATA || 'C:\\ProgramData',
    'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'
  );
  const legacy = await readJson(dat);
  if (legacy && Array.isArray(legacy.InstallationList)) {
    for (const item of legacy.InstallationList) {
      const g = epicGameFromManifest(item);
      // ① 里已经有了就不覆盖：新路径的记录通常更新、更准
      if (g && !out.has(g.appId)) out.set(g.appId, g);
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/**
 * Epic 认证客户端的提供者（由 main.js 在启动时注入）。
 *
 * 为什么不在这里直接 require('./epicauth')：
 *   那样 platforms.js 就会间接依赖 electron，单元测试里 require 它会炸。
 *   靠注入一层，platforms.js 依旧保持"纯 Node 可加载"，测试照跑。
 */
let epicAuthProvider = null;

/** main.js 装配时调用，fn 返回一个 epicauth 客户端 */
function setEpicAuth(fn) {
  epicAuthProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 合成本地清单（A 路线）与账号清单（B 路线）。
 *
 * 为什么必须合：两边覆盖的场景**完全不重叠** ——
 *   · 本地清单：只看得见装过的，但知道装在哪、多大、exe 叫什么（能直接启动）
 *   · 账号清单：看得见全部拥有的（含领了没下载的），有封面和开发商，但不知装没装
 * 只拿任何一边都是残缺的。
 *
 * 同一款两边都出现时（键是 AppName）：
 *   · 名字优先用账号那边的 —— 那是商店正式名，本地 DisplayName 有时是缩写
 *   · installed / installDir / launchPath / sizeBytes **只可能**来自本地
 *   · 封面 / 开发商 / 发行商 / steamAppId 反过来只有账号那有
 */
function mergeEpic(localList, apiList) {
  const out = new Map();

  for (const g of localList || []) out.set(g.appId, { ...g });

  for (const g of apiList || []) {
    const cur = out.get(g.appId);
    if (!cur) {
      // 只有账号那有 —— 说明装了但清单丢了，或压根没下载
      out.set(g.appId, { ...g, installed: false });
      continue;
    }
    out.set(g.appId, {
      ...g,
      name: g.name || cur.name,
      installed: true,
      installDir: cur.installDir,
      launchExe: cur.launchExe,
      launchPath: cur.launchPath,
      sizeBytes: cur.sizeBytes,
      version: cur.version,
      source: 'both'
    });
  }

  return [...out.values()];
}

/** 通用：扫一个平台的已安装记录（走注册表卸载项里带平台关键字的条目） */
async function genericInstalled(meta) {
  // 这里刻意不重复实现一遍注册表读取（scanner 里已有），
  // 只在最关键的 Epic 上做精准解析；其余平台如实返回空，
  // 界面会显示"暂不支持读取已安装列表"，而不是编造数据。
  void meta;
  return [];
}

/**
 * 同步一个非 Steam 平台。
 * 能拿到的就填，拿不到就明确留空 + 给一句说明。
 */
async function syncOther(meta, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  onProgress({ phase: 'platform', message: `检测 ${meta.name} …` });

  const found = await findInstallDir(meta);
  if (!found) {
    return {
      detected: false, installPath: '', loggedIn: false, games: [],
      warnings: [`本机没有检测到 ${meta.name}`]
    };
  }

  const warnings = [];
  let account = null;
  let games = [];

  if (meta.id === 'epic') {
    /* ---- Epic 专属：本地清单 + 账号清单一起上 ---- */
    const local = await epicInstalled();

    try {
      const auth = epicAuthProvider ? epicAuthProvider() : null;
      const st = auth ? auth.status() : { loggedIn: false };
      if (st.loggedIn) {
        onProgress({ phase: 'platform', message: '读取 Epic 账号拥有的游戏…' });
        const r = await auth.fetchLibrary((m) => onProgress({ phase: 'platform', message: m }));
        if (r.ok) {
          games = mergeEpic(local, r.games);
          account = st.account;
          /* 清单拿到了，但详情（正式名/封面）没补全 —— 这不是失败，
           * 却正是"游戏库显示不正常"的成因，必须让用户知道而不是干看着一堆代号。 */
          if (r.warn) warnings.push(r.warn);
        } else {
          games = local;
          /* ⚠ 这里**仍然要带上 account**：这是"已经登录、只是列表没拉下来"，
           *   跟"压根没登录"完全是两回事。不带的话界面拿到 loggedIn=false，
           *   就会显示成"账号信息本地读不到"—— 用户明明刚登录成功，会被搞糊涂。
           *   （用户上一版遇到的正是这个：登录明明成功了，界面却说读不到账号。） */
          account = st.account || { name: '已登录' };
          warnings.push(`已登录 Epic 账号，但读取拥有清单失败：${r.error}。已回退到本机已安装的 ${local.length} 款。`);
        }
      } else {
        // "没登录"不是异常，是正常状态。这句提示交给**界面**去渲染
        // （renderLibrary 的 loggedIn===false 分支会显示它，旁边还带一个登录按钮）。
        // 这里再塞一条进 warnings 的话，界面上会出现一模一样的两句话上下排着。
        games = local;
      }
    } catch (e) {
      games = local;
      warnings.push(`读取 Epic 账号数据时出错：${e.message}。已回退到本机已安装清单。`);
    }
  }

  // 账号信息：只有少数平台把用户名明文放在配置文件里，能读就读，读不到就如实说
  if (!account && meta.id === 'ubisoft') {
    const yml = await readText(path.join(process.env.LOCALAPPDATA || '', 'Ubisoft Game Launcher', 'settings.yaml'));
    if (yml) {
      // ⚠ 只取 username，绝不碰同段的 password
      const m = /^\s*username\s*:\s*"?([^"\n\r]*)"?\s*$/m.exec(yml);
      const u = m && m[1].trim();
      if (u) account = { id: u, name: u, accountName: u };
    }
    if (!account) warnings.push('Ubisoft 没有把用户名明文存在本地，账号信息读不到（客户端里仍处于登录状态）');
  }

  if (!account && meta.id !== 'epic' && meta.id !== 'ubisoft') {
    warnings.push(`${meta.name} 的账号信息无法从本地文件读取`);
  }

  if (!games.length && meta.id !== 'epic') {
    warnings.push(`${meta.name} 暂不支持读取已安装游戏列表（可先手动添加，或到平台客户端里确认）`);
  }

  return {
    detected: true,
    installPath: found.path,
    loggedIn: !!account,
    account,
    games,
    stats: {
      owned: games.length,
      installed: games.filter((g) => g.installed).length,
      notInstalled: games.filter((g) => !g.installed).length,
      totalPlayMs: 0, achGames: 0, achUnlocked: 0, achTotal: 0
    },
    warnings
  };
}

/* ==================================================================
 *  五、对外接口
 * ================================================================== */

const META_BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

/** 平台静态元数据（给界面用：名字、配色、协议） */
function metaOf(id) {
  return META_BY_ID.get(id) || null;
}

/** 全部平台的元数据 */
function allMeta() {
  return PLATFORMS.map((p) => ({
    id: p.id, name: p.name, short: p.short, color: p.color, accent: p.accent,
    canSync: p.id === 'steam' || p.id === 'epic' || p.id === 'ubisoft'
  }));
}

/**
 * 只做"检测"：装没装 / 有没有数据。不读游戏库，很快。
 * @returns {Promise<Array>}
 */
async function listPlatforms() {
  const out = [];
  for (const meta of PLATFORMS) {
    let detected = false;
    let installPath = '';
    let note = '';

    if (meta.id === 'steam') {
      installPath = await Steam.findInstall();
      detected = !!installPath;
    } else {
      const found = await findInstallDir(meta);
      detected = !!found;
      installPath = found ? found.path : '';
      if (found && found.dataOnly) note = '只检测到本机数据（可能装在非常规位置）';
    }

    out.push({
      id: meta.id, name: meta.name, short: meta.short,
      color: meta.color, accent: meta.accent,
      canSync: meta.id === 'steam' || meta.id === 'epic' || meta.id === 'ubisoft',
      detected, installPath, note
    });
  }
  return out;
}

/**
 * 同步某个平台的账号 + 游戏库。
 * @param {string} id 平台 id
 * @param {{accountId?:string, onProgress?:Function}} [opts]
 */
async function syncPlatform(id, opts = {}) {
  const meta = META_BY_ID.get(id);
  if (!meta) return { ok: false, error: `未知平台：${id}` };

  try {
    const snap = id === 'steam'
      ? await Steam.sync(opts)
      : await syncOther(meta, opts);

    return {
      ok: true,
      platformId: id,
      platformName: meta.name,
      color: meta.color,
      accent: meta.accent,
      syncedAt: Date.now(),
      // 明确写进快照里，界面会展示给用户看
      privacy: '数据只保存在本机 GameHub 的数据文件里，不会上传到任何服务器。',
      ...snap
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** 拼 Steam 头像地址（本地只有哈希，要联网取图） */
function steamAvatarUrl(hash, size = 'medium') {
  if (!hash) return '';
  return `https://avatars.steamstatic.com/${hash}_${size}.jpg`;
}

module.exports = {
  PLATFORMS,
  allMeta,
  metaOf,
  listPlatforms,
  syncPlatform,
  // 轻量对时长用：只解析 localconfig.vdf，毫秒级（不像 sync 要读 appinfo + 成就缓存）
  steamPlaytimes: (opts) => Steam.steamPlaytimes(opts),
  steamAvatarUrl,
  // 导出给单元测试用
  accountIdToSteamId64,
  steamId64ToAccountId,
  minutesToMs,
  // Epic 账号登录：由 main.js 装配时注入认证客户端
  setEpicAuth,
  mergeEpic,
  _internals: { Steam, findInstallDir, epicInstalled, epicGameFromManifest, epicManifestDirs }
};
