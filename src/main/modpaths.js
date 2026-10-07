/**
 * ============================================================
 *  GameHub - MOD 目录规则引擎  (src/main/modpaths.js)
 * ------------------------------------------------------------
 *  回答一个问题：**这款游戏的 MOD 该装到哪个文件夹？**
 *
 *  为什么必须单独做成规则表，而不是统一塞 "<游戏目录>/Mods"：
 *    各路游戏的 MOD 目录五花八门，而且**放错了 MOD 不会报错，只会静默失效** ——
 *    用户装完进游戏发现没变化，最常怪到 MOD 头上，其实是目录错了。
 *    举几个真实的差异：
 *      · Bethesda（老滚 / 辐射）    → <游戏目录>/Data        不是 Mods
 *      · 巫师 3                     → <游戏目录>/Mods        且文件夹名必须 mod 开头
 *      · 赛博朋克 2077              → <游戏目录>/archive/pc/mod
 *      · 黑神话 / 幻兽帕鲁          → <游戏目录>/b1/Content/Paks/~mods
 *      · 博德之门 3                 → %LOCALAPPDATA%/Larian Studios/.../Mods  不在游戏目录里
 *      · 我的世界                   → %APPDATA%/.minecraft/mods              不在游戏目录里
 *      · 模拟农场 / 欧卡 2          → 文档/My Games/.../mods                 不在游戏目录里
 *
 *  匹配优先级（从最准到最不准）：
 *    ① Steam AppID 精确匹配      —— 最可靠，同名游戏（如两个 Skyrim）也不会混
 *    ② 游戏名关键词匹配           —— 覆盖绝大多数情况
 *    ③ 通用兜底                  —— 扫一遍常见的 mods / Mods / Data 目录
 *
 *  另外提供「实际探测」：规则说该在 A，但磁盘上真存在的是 B，
 *  那多半是用户自己改过位置，以磁盘为准（见 detectExisting）。
 *
 *  ⚠ 这个模块是纯逻辑，不依赖 Electron，可被 Node 直接单测。
 * ============================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

/* ==================================================================
 *  一、规则表
 * ================================================================== */

/**
 * 位置类型：
 *   game —— 相对游戏安装目录（绝大多数）
 *   user —— 用户目录下（文档 / AppData），与游戏装在哪无关
 *   docs —— 「我的文档 / My Games」下的子目录（模拟农场、欧卡这类）
 */
const SCOPE = { GAME: 'game', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', DOCS: 'docs', HOME: 'home' };

/**
 * 按 Steam AppID 精确匹配。
 * 只收录「同名易混」或「路径特别反直觉」的，常规游戏靠名字匹配就够了。
 *
 * AppID 可以从 Steam 商店 URL 拿到，GameHub 扫描 Steam 库时本来就会记录。
 */
const BY_APPID = {
  // —— Bethesda：MOD 放 Data 而不是 Mods，最容易搞错的一族 ——
  489520: { dir: 'Data', scope: SCOPE.GAME, name: '上古卷轴5 天际 特别版' },
  72850: { dir: 'Data', scope: SCOPE.GAME, name: '上古卷轴5 天际' },
  22380: { dir: 'Data', scope: SCOPE.GAME, name: '辐射4 新维加斯' },
  377160: { dir: 'Data', scope: SCOPE.GAME, name: '辐射4' },
  22370: { dir: 'Data', scope: SCOPE.GAME, name: '辐射3' },
  22330: { dir: 'Data', scope: SCOPE.GAME, name: '湮灭 上古卷轴4' },

  // —— 路径反直觉、或不在游戏目录里的 ——
  292030: { dir: 'Data', scope: SCOPE.GAME, name: '巫师3' },           // 巫师3 用 Mods，见下条
  499450: { dir: 'Mods', scope: SCOPE.GAME, name: '巫师3' },           // 巫师3 GOTY/年度版
  1091500: { dir: 'archive/pc/mod', scope: SCOPE.GAME, name: '赛博朋克2077' },
  1174180: { dir: 'nativePC', scope: SCOPE.GAME, name: '怪物猎人 荒野' },
  582010: { dir: 'nativePC', scope: SCOPE.GAME, name: '怪物猎人 世界' },
  1446780: { dir: 'nativePC', scope: SCOPE.GAME, name: '怪物猎人 崛起' },
  1086940: { dir: "Larian Studios/Baldur's Gate 3/Mods", scope: SCOPE.LOCALAPPDATA, name: '博德之门3' },
  2358720: { dir: 'b1/Content/Paks/~mods', scope: SCOPE.GAME, name: '黑神话 悟空' },
  1623730: { dir: 'Pal/Content/Paks/~mods', scope: SCOPE.GAME, name: '幻兽帕鲁' },
  1245620: { dir: 'Game/mod', scope: SCOPE.GAME, name: '艾尔登法环' },
  814380: { dir: 'Game/mod', scope: SCOPE.GAME, name: '只狼 影逝二度' },
  236390: { dir: 'Mods', scope: SCOPE.GAME, name: '骑马与砍杀2 霸主' },
  413150: { dir: 'Mods', scope: SCOPE.GAME, name: '星露谷物语' },
  1281930: { dir: 'Mods', scope: SCOPE.GAME, name: 'tModLoader 泰拉瑞亚' },
  105600: { dir: 'mod', scope: SCOPE.GAME, name: '泰拉瑞亚' },
  255710: { dir: 'Files/Mods', scope: SCOPE.GAME, name: '城市天际线' },
  294100: { dir: 'Mods', scope: SCOPE.GAME, name: '边缘世界 RimWorld' },
  251570: { dir: 'Mods', scope: SCOPE.GAME, name: '七日杀' },
  108600: { dir: 'mod', scope: SCOPE.DOCS, name: '僵尸毁灭工程', docsSub: 'Zomboid/mods' },
  2208920: { dir: 'mods', scope: SCOPE.DOCS, name: '欧洲卡车模拟2', docsSub: 'Euro Truck Simulator 2/mod' },
  227300: { dir: 'mods', scope: SCOPE.DOCS, name: '美国卡车模拟', docsSub: 'American Truck Simulator/mod' },
  1248130: { dir: 'mods', scope: SCOPE.DOCS, name: '模拟农场22', docsSub: 'My Games/FarmingSimulator2022/mods' },
  2815550: { dir: 'mods', scope: SCOPE.DOCS, name: '模拟农场25', docsSub: 'My Games/FarmingSimulator2025/mods' },
  322330: { dir: 'mods', scope: SCOPE.DOCS, name: '饥荒联机版', docsSub: 'Klei/DoNotStarveTogether/mods' }
};

/**
 * 按游戏名关键词匹配。
 * 顺序有意义：**越具体的放前面**，否则 "辐射" 会先命中 "辐射4" 之前的东西。
 * 每条：
 *   keys  —— 游戏名里包含任一关键词即命中（已做小写比较）
 *   dir   —— MOD 目录（相对 scope 根）
 *   scope —— 见 SCOPE
 *   note  —— 给用户看的一句说明，会显示在界面上
 */
const BY_NAME = [
  /* ---- Bethesda：MOD 放 Data，不是 Mods ---- */
  {
    keys: ['skyrim', '天际', '上古卷轴5', '上古卷轴 5', 'elder scrolls v'],
    dir: 'Data', scope: SCOPE.GAME,
    note: 'Bethesda 游戏把 .esp/.esm/.bsa 与 meshes/textures 放到 Data 目录，不是 Mods'
  },
  {
    keys: ['fallout', '辐射'],
    dir: 'Data', scope: SCOPE.GAME,
    note: '辐射系列同样放 Data 目录；带 .esp 的插件还要在 plugins.txt 里启用'
  },
  {
    keys: ['oblivion', '湮灭', '上古卷轴4', '上古卷轴 4'],
    dir: 'Data', scope: SCOPE.GAME,
    note: '同属 Bethesda，放 Data'
  },

  /* ---- 巫师 3：Mods，且文件夹名必须 mod 开头 ---- */
  {
    keys: ['witcher', '巫师', '猎魔人'],
    dir: 'Mods', scope: SCOPE.GAME,
    note: '巫师3 只加载名字以 mod 开头的文件夹（如 modXXX），放错或改名不当会静默失效'
  },

  /* ---- 赛博朋克 ---- */
  {
    keys: ['cyberpunk', '赛博朋克', '2077'],
    dir: 'archive/pc/mod', scope: SCOPE.GAME,
    note: '.archive 文件放 archive/pc/mod；CET 脚本类放 bin/x64/plugins/cyber_engine_tweaks/mods'
  },

  /* ---- UE4/UE5 的 ~mods 惯例（黑神话、帕鲁等）---- */
  {
    keys: ['black myth', '黑神话', 'wukong', '悟空'],
    dir: 'b1/Content/Paks/~mods', scope: SCOPE.GAME,
    note: '虚幻引擎的 ~mods 目录要自己建；还需要给 Steam 启动参数加 -fileopenlog'
  },
  {
    keys: ['palworld', '幻兽帕鲁'],
    dir: 'Pal/Content/Paks/~mods', scope: SCOPE.GAME,
    note: '同属虚幻引擎，放 Paks/~mods'
  },

  /* ---- 怪物猎人：nativePC ---- */
  {
    keys: ['monster hunter', '怪物猎人', 'monsterhunter', 'mhwi', 'mhrise', 'mhwilds'],
    dir: 'nativePC', scope: SCOPE.GAME,
    note: '怪物猎人系列放 nativePC（RE 引擎的通用做法）'
  },

  /* ---- 生化危机 / 街霸等 RE 引擎 ---- */
  {
    keys: ['resident evil', '生化危机', 'devil may cry', '鬼泣', 'street fighter', '街头霸王'],
    dir: 'mods', scope: SCOPE.GAME,
    note: 'RE 引擎游戏常见 mods 或 natives 目录'
  },

  /* ---- 魂系：需要 Mod Engine 2 ---- */
  {
    keys: ['elden ring', '艾尔登法环', '老头环'],
    dir: 'Game/mod', scope: SCOPE.GAME,
    note: '魂系通常用 Mod Engine 2，MOD 放 Game/mod'
  },
  {
    keys: ['sekiro', '只狼'],
    dir: 'Game/mod', scope: SCOPE.GAME,
    note: '同属魂系，放 Game/mod'
  },
  {
    keys: ['dark souls', '黑暗之魂', '黑暗灵魂', 'darksouls'],
    dir: 'Game/mod', scope: SCOPE.GAME,
    note: '同属魂系，放 Game/mod'
  },

  /* ---- 博德之门 3：在 AppData，不在游戏目录 ---- */
  {
    keys: ["baldur's gate", 'baldurs gate', '博德之门', 'bg3'],
    dir: "Larian Studios/Baldur's Gate 3/Mods", scope: SCOPE.LOCALAPPDATA,
    note: '博德之门3 的 .pak 放在 %LOCALAPPDATA% 下，不在游戏安装目录'
  },
  {
    keys: ['divinity original sin', '神界原罪'],
    dir: 'Larian Studios/Divinity Original Sin 2/Mods', scope: SCOPE.LOCALAPPDATA,
    note: '拉瑞安的游戏 MOD 都在 %LOCALAPPDATA% 下'
  },

  /* ---- Minecraft：在 AppData ---- */
  {
    keys: ['minecraft', '我的世界', 'minecraft launcher'],
    dir: '.minecraft/mods', scope: SCOPE.APPDATA,
    note: 'Minecraft 的 mods 在 %APPDATA%\\.minecraft\\mods；部分启动器会按版本分子目录'
  },

  /* ---- 文档目录下的（模拟农场 / 欧卡 / 僵尸毁灭工程 / 饥荒）---- */
  {
    keys: ['farming simulator', '模拟农场', 'fs22', 'fs25'],
    dir: 'My Games/FarmingSimulator2025/mods', scope: SCOPE.DOCS,
    docsSub: 'My Games/FarmingSimulator2025/mods',
    note: '模拟农场的 MOD 在「文档\\My Games」下，按年份分子目录'
  },
  {
    keys: ['euro truck', '欧洲卡车', 'ets2'],
    dir: 'mod', scope: SCOPE.DOCS, docsSub: 'Euro Truck Simulator 2/mod',
    note: '欧卡2 的 MOD 在「文档\\Euro Truck Simulator 2\\mod」（注意是单数 mod）'
  },
  {
    keys: ['american truck', '美国卡车', 'ats'],
    dir: 'mod', scope: SCOPE.DOCS, docsSub: 'American Truck Simulator/mod',
    note: '美卡同欧卡，在文档目录下'
  },
  {
    keys: ['project zomboid', '僵尸毁灭', 'zomboid'],
    dir: 'mods', scope: SCOPE.HOME, homeSub: 'Zomboid/mods',
    note: '僵尸毁灭工程的 MOD 在用户目录 \\Zomboid\\mods'
  },
  {
    keys: ["don't starve", 'dont starve', '饥荒', 'klei'],
    dir: 'mods', scope: SCOPE.DOCS, docsSub: 'Klei/DoNotStarveTogether/mods',
    note: '饥荒的 MOD 在「文档\\Klei」下'
  },

  /* ---- 游戏目录下的 Mods（最常见的通用情况）---- */
  {
    keys: ['stardew', '星露谷'],
    dir: 'Mods', scope: SCOPE.GAME,
    note: '星露谷用 SMAPI，MOD 解压到 Mods 目录'
  },
  {
    keys: ['terraria', '泰拉瑞亚'],
    dir: 'Mods', scope: SCOPE.GAME,
    note: 'tModLoader 的 MOD 放 Mods 目录'
  },
  {
    keys: ['rimworld', '边缘世界'],
    dir: 'Mods', scope: SCOPE.GAME,
    note: '边缘世界放游戏目录下的 Mods'
  },
  {
    keys: ['7 days to die', '七日杀'],
    dir: 'Mods', scope: SCOPE.GAME,
    note: '七日杀放 Mods'
  },
  {
    keys: ['cities skylines', '城市天际线', '都市天际线'],
    dir: 'Files/Mods', scope: SCOPE.GAME,
    note: '城市天际线的 MOD 在 Files/Mods 下'
  },
  {
    keys: ['mount blade', '骑马与砍杀', 'bannerlord', '霸主'],
    dir: 'Modules', scope: SCOPE.GAME,
    note: '骑马与砍杀2 的 MOD 叫 Modules，不是 Mods'
  },
  {
    keys: ['hollow knight', '空洞骑士'],
    dir: 'Mods', scope: SCOPE.GAME,
    note: '空洞骑士放 Mods'
  },
  {
    keys: ['valheim', '英灵神殿'],
    dir: 'BepInEx/plugins', scope: SCOPE.GAME,
    note: '英灵神殿用 BepInEx，MOD 放 BepInEx/plugins'
  },
  {
    keys: ['subnautica', '深海迷航', '深海迷城'],
    dir: 'BepInEx/plugins', scope: SCOPE.GAME,
    note: '用 BepInEx 加载的 Unity 游戏，MOD 放 BepInEx/plugins'
  },
  {
    keys: ['gta', 'grand theft auto', '侠盗猎车'],
    dir: 'mods', scope: SCOPE.GAME,
    note: 'GTA5 常见 mods 或 scripts 目录（部分需要 OpenIV）'
  },
  {
    keys: ['factorio', '异星工厂'],
    dir: 'mods', scope: SCOPE.GAME,
    note: '异星工厂放 mods'
  },
  {
    keys: ['no man', '无人深空'],
    dir: 'GAMEDATA/PCBANKS/MODS', scope: SCOPE.GAME,
    note: '无人深空放 GAMEDATA/PCBANKS/MODS（全大写）'
  }
];

/** 通用兜底：规则没命中时，按这个顺序在游戏目录里找 */
const FALLBACK_DIRS = ['Mods', 'mods', 'MODS', 'Data', 'mod', 'Mod', '~mods', 'plugins', 'Plugins', 'Modules'];

/* ==================================================================
 *  二、路径解析
 * ================================================================== */

/** 取「文档」目录 */
function docsDir() {
  try {
    // Electron 下 app.getPath('documents') 更准，但这里要保持纯 Node 可测试
    return path.join(os.homedir(), 'Documents');
  } catch {
    return os.homedir();
  }
}

/**
 * 把一个 scope + dir 解析成绝对路径。
 * @param {'game'|'appdata'|'localappdata'|'docs'|'home'} scope
 * @param {string} dir  相对路径（可能含子目录）
 * @param {string} installDir  游戏安装目录（scope=game 时用）
 * @param {object} [env]  可注入环境变量，方便测试
 */
function resolveScope(scope, dir, installDir, env = {}) {
  const home = env.HOME || os.homedir();
  const appdata = env.APPDATA || (process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming') : home);
  const localAppData = env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(home, 'AppData', 'Local') : home);

  switch (scope) {
    case SCOPE.GAME:
      return installDir ? path.join(installDir, dir) : '';
    case SCOPE.APPDATA:
      return path.join(appdata, dir);
    case SCOPE.LOCALAPPDATA:
      return path.join(localAppData, dir);
    case SCOPE.DOCS:
      return path.join(env.DOCS || docsDir(), dir);
    case SCOPE.HOME:
      return path.join(home, dir);
    default:
      return installDir ? path.join(installDir, dir) : '';
  }
}

/** 归一化游戏名用于匹配：小写、去掉标点与多余空格 */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[：:·・\-–—_/\\()[\]{}"'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按 AppID 查规则。
 * @param {string|number} appId
 */
function ruleByAppId(appId) {
  const id = Number(String(appId || '').trim());
  if (!Number.isFinite(id) || id <= 0) return null;
  return BY_APPID[id] || null;
}

/**
 * 按游戏名查规则。
 * @param {string} name
 * @param {string[]} [altNames] 别名（Steam 英文名等）
 */
function ruleByName(name, altNames = []) {
  const hay = normName([name, ...altNames].join(' '));
  if (!hay) return null;
  for (const r of BY_NAME) {
    for (const k of r.keys) {
      if (hay.includes(normName(k))) return r;
    }
  }
  return null;
}

/* ==================================================================
 *  三、对外主接口
 * ================================================================== */

/**
 * 推断一款游戏的 MOD 目录。
 *
 * @param {object} game  游戏对象（用到 name / altNames / steamAppId / installDir）
 * @param {object} [opts]
 * @param {object} [opts.env]      环境变量覆盖（测试用）
 * @param {string} [opts.override] 用户手动指定的目录（最高优先级）
 * @returns {{
 *   ok: boolean,
 *   dir: string,            推荐目录（绝对路径，可能不存在）
 *   exists: boolean,        该目录当前是否存在
 *   source: string,         来源：override | appid | name | fallback | unknown
 *   matched: string|null,   命中的规则名（用于界面展示"按什么规则判定的"）
 *   note: string,           给用户的说明
 *   candidates: Array<{dir:string, exists:boolean, source:string, note:string}>
 * }}
 */
function resolveModDir(game, opts = {}) {
  const g = game || {};
  const installDir = String(g.installDir || '').trim();
  const env = opts.env || {};

  // ① 用户手动覆盖 —— 最高优先级，用户说了算
  if (opts.override) {
    const dir = String(opts.override).trim();
    return {
      ok: true,
      dir,
      exists: fs.existsSync(dir),
      source: 'override',
      matched: null,
      note: '你在设置里手动指定的目录',
      candidates: [{ dir, exists: fs.existsSync(dir), source: 'override', note: '手动指定' }]
    };
  }

  const candidates = [];
  const push = (dir, source, note, matched) => {
    if (!dir) return;
    if (candidates.some((c) => c.dir.toLowerCase() === dir.toLowerCase())) return;
    candidates.push({ dir, exists: fs.existsSync(dir), source, note: note || '', matched: matched || null });
  };

  // ② AppID 精确匹配
  const byId = ruleByAppId(g.steamAppId);
  if (byId) {
    push(resolveScope(byId.scope, byId.dir, installDir, env), 'appid', byId.note || '', byId.name || String(g.steamAppId));
  }

  // ③ 名字关键词匹配
  const byName = ruleByName(g.name, g.altNames);
  if (byName) {
    // 有些规则同时给了 docsSub / homeSub（更精确的子路径）
    const sub = byName.scope === SCOPE.DOCS ? byName.docsSub
      : byName.scope === SCOPE.HOME ? byName.homeSub
        : byName.dir;
    push(resolveScope(byName.scope, sub || byName.dir, installDir, env), 'name', byName.note || '', byName.keys[0]);
  }

  // ④ 通用兜底（只在有安装目录时才有意义）
  if (installDir) {
    for (const d of FALLBACK_DIRS) {
      push(path.join(installDir, d), 'fallback', '游戏目录下已存在的常见 MOD 目录');
    }
  }

  if (!candidates.length) {
    return {
      ok: false, dir: '', exists: false, source: 'unknown', matched: null,
      note: '没认出这款游戏的 MOD 目录规则，需要你手动指定',
      candidates: []
    };
  }

  // 选一个最好的：**已存在的优先于规则判定的**。
  // 规则说该在 A 但磁盘上真有 B，多半是用户自己挪过，以磁盘为准。
  const existing = candidates.find((c) => c.exists);
  const best = existing || candidates[0];

  return {
    ok: true,
    dir: best.dir,
    exists: best.exists,
    source: best.source,
    matched: best.matched || null,
    note: best.note || '',
    candidates
  };
}

/**
 * 探测游戏目录里真实存在的 MOD 目录（不依赖规则表）。
 * 用于「规则没命中」或「想看看还有哪些可选」的场景。
 *
 * @param {string} installDir
 * @param {number} [maxDepth] 往下找几层（默认 2，避免扫整个游戏目录）
 */
async function detectExisting(installDir, maxDepth = 2) {
  const root = String(installDir || '').trim();
  const out = [];
  if (!root || !fs.existsSync(root)) return out;

  const wanted = new Set(FALLBACK_DIRS.map((d) => d.toLowerCase()));
  // 虚幻引擎 / BepInEx 这类嵌套路径也认
  const nested = [
    'b1/Content/Paks/~mods',
    'Pal/Content/Paks/~mods',
    'archive/pc/mod',
    'bin/x64/plugins/cyber_engine_tweaks/mods',
    'BepInEx/plugins',
    'GAMEDATA/PCBANKS/MODS'
  ];

  for (const n of nested) {
    const p = path.join(root, n);
    if (fs.existsSync(p)) out.push({ dir: p, exists: true, source: 'detect', note: '探测到的常见 MOD 路径' });
  }

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let items = [];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      // 跳过明显不是 MOD 目录的
      if (/^(bin|content|engine|shippings?|data\/.*)$/i.test(it.name) && depth > 0) { /* 仍继续往下找 */ }
      const full = path.join(dir, it.name);
      if (wanted.has(it.name.toLowerCase())) {
        out.push({ dir: full, exists: true, source: 'detect', note: '探测到的常见 MOD 路径' });
        continue;                                  // 找到了就不再往里钻
      }
      await walk(full, depth + 1);
    }
  }

  await walk(root, 0);
  return out;
}

/**
 * 给界面用的「这份规则靠不靠谱」描述。
 * @param {string} source  resolveModDir 返回的 source
 */
function sourceLabel(source) {
  return {
    override: '手动指定',
    appid: '按 Steam AppID 精确匹配',
    name: '按游戏名匹配',
    fallback: '通用兜底（游戏目录下的常见目录）',
    detect: '磁盘探测',
    unknown: '未识别'
  }[source] || source;
}

module.exports = {
  SCOPE,
  BY_APPID,
  BY_NAME,
  FALLBACK_DIRS,
  resolveModDir,
  resolveScope,
  detectExisting,
  ruleByAppId,
  ruleByName,
  sourceLabel,
  normName,
  docsDir
};
