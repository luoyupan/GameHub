/**
 * ============================================================
 *  GameHub - 游戏分类与识别规则模块  (src/main/classify.js)
 * ------------------------------------------------------------
 *  纯逻辑模块，不依赖 Electron，可被单独单元测试。
 *  提供三类能力：
 *    1. classify(name)        —— 依据名称关键词把游戏归入若干分类
 *    2. scoreRegistryEntry()  —— 给一条注册表卸载项打分，判断"它像不像游戏"
 *    3. pickMainExe()         —— 从一个目录里挑出最像"游戏主程序"的 exe
 * ============================================================
 */

/* ------------------------------------------------------------------
 * 一、分类关键词表
 *    key   = 最终展示的中文分类名
 *    value = 命中即归入该分类的关键词（全部小写匹配）
 * ------------------------------------------------------------------ */
const CATEGORY_RULES = [
  { key: '射击', words: ['fps', 'shooter', 'shooting', 'gun', 'sniper', 'csgo', 'counter strike', 'call of duty', 'battlefield', 'halo', 'doom', 'quake', 'apex', 'valorant', 'pubg', 'overwatch', 'crossfire', '穿越火线', '战地', '使命召唤', '生死狙击', '逆战', 'borderlands', '无主之地', 'destiny', '命运', 'titanfall', '泰坦陨落', 'crysis', '孤岛危机', 'metro', '地铁', 'stalker', '潜行者', 'far cry', '孤岛惊魂', 'bioshock', '生化奇兵', 'left 4 dead', '求生之路', 'warframe', '星际战甲', 'remnant', 'escape from tarkov', '逃离塔科夫', 'squad', 'insurgency', 'hell let loose', 'deep rock', 'risk of rain', '反恐精英', '三角洲', 'delta force'] },
  { key: 'MOBA', words: ['moba', 'league of legends', 'dota', '英雄联盟', '王者荣耀', '风暴英雄', 'hon', 'smite'] },
  { key: '大逃杀', words: ['battle royale', 'battlegrounds', 'fortnite', 'naraka', '永劫无间', 'free fire', '大逃杀', '吃鸡'] },
  { key: '角色扮演', words: ['rpg', 'role playing', 'roleplaying', 'final fantasy', 'witcher', 'elder scrolls', 'skyrim', 'fallout', 'dragon', 'persona', 'tales of', 'xenoblade', 'ffxiv', 'ff14', 'ff7', 'diablo', '巫师', '上古卷轴', '辐射', '勇者斗恶龙', '仙剑', '轩辕剑', '古剑奇谭', '剑网', '梦幻西游', '大话西游', '崩坏', '原神', '天命', '女神异闻录', 'persona 5', 'baldur', '博德之门', 'divinity', '神界', 'mass effect', '质量效应', 'dragon age', '龙腾世纪', 'nier', '尼尔', 'octopath', '歧路旅人'] },
  { key: '动作', words: ['action', 'devil may cry', 'bayonetta', 'god of war', 'sekiro', 'dark souls', 'elden ring', 'nioh', 'monster hunter', 'dmc', 'ninja gaiden', '只狼', '黑神话', '悟空', '鬼泣', '塞尔达', '无双', '怪物猎人', '忍者龙剑传', '血源', '仁王', 'hades', '哈迪斯', 'dead cells', '死亡细胞', 'neon abyss', '霓虹深渊', 'lost castle', '失落城堡', 'dying light', '消逝的光芒', 'vampire survivors', '吸血鬼幸存者', 'cult of the lamb', '咩咩启示录', 'enter the gungeon', '挺进地牢', 'gunfire', 'greedfall', 'sifu', '师父', 'ghostrunner', '幽灵行者', 'metal gear', '合金装备', 'hitman', '杀手'] },
  { key: '冒险', words: ['adventure', 'tomb raider', 'uncharted', 'assassin', 'zelda', 'journey', 'life is strange', 'firewatch', '波斯王子', '刺客信条', '神秘海域', '古墓丽影', '鸣潮', 'ori and', '奥日', 'hollow knight', '空洞骑士', 'little nightmares', '小小梦魇', 'outer wilds', '星际拓荒', 'subnautica', '深海迷航', 'no man s sky', '无人深空'] },
  { key: '开放世界', words: ['open world', 'openworld', 'gta', 'grand theft auto', 'red dead', 'cyberpunk', 'saint row', 'just cause', '看门狗', '荒野大镖客', '赛博朋克', '地平线', 'watch dogs', 'mafia', '黑手党', 'sleeping dogs', '热血无赖'] },
  { key: '策略', words: ['strategy', 'civilization', 'total war', 'star craft', 'starcraft', 'warcraft', 'age of empires', 'command', 'xcom', 'crusader kings', 'europa', 'stellaris', 'anno', '三国志', '文明', '星际争霸', '魔兽争霸', '帝国时代', '全面战争', '钢铁雄心', '群星', '纪元', 'hearts of iron', 'company of heroes', '英雄连', 'frostpunk', '冰汽时代', 'they are billions', '亿万僵尸', 'into the breach', '陷阵之志', 'manor lords', '庄园领主', 'tropico', '海岛大亨'] },
  { key: '塔防', words: ['tower defense', 'tower defence', 'defense', '植物大战僵尸', 'plants vs', '王国保卫战', '保卫萝卜', 'they are billions', '亿万僵尸'] },
  { key: '模拟', words: ['simulator', 'simulation', 'tycoon', 'cities skylines', 'skylines', 'the sims', 'stardew', 'farming', 'euro truck', 'american truck', 'planet coaster', 'planet zoo', 'factorio', 'satisfactory', 'rimworld', '模拟', '都市天际线', '模拟人生', '模拟农场', '欧洲卡车', '异星工厂', '幸福工厂', '戴森球', '牧场物语', '星露谷', 'oxygen not included', '缺氧', 'worldbox', 'fantasy map', 'two point', '双点', 'house flipper', '房产达人', 'powerwash', '冲就完事', 'davinci', '微软模拟飞行', 'flight simulator', 'the hunter', '狩猎'] },
  { key: '沙盒', words: ['sandbox', 'minecraft', 'terraria', 'roblox', 'garry', '创世神', '我的世界', '泰拉瑞亚', '迷你世界', 'rimworld', '边缘世界', 'valheim', '英灵神殿'] },
  { key: '生存', words: ['survival', 'survive', 'the forest', 'raft', 'rust', 'ark', 'valheim', 'don t starve', 'dayz', '七日杀', '方舟', '饥荒', '明日之后', '森林', '绿色地狱', 'green hell', 'long dark', '漫漫长夜', 'grounded', '禁闭求生', 'stranded deep', '深陷之地', 'project zomboid', '僵尸毁灭工程', 'palworld', '幻兽帕鲁', 'dying light', '消逝的光芒'] },
  { key: '竞速', words: ['racing', 'race', 'need for speed', 'forza', 'gran turismo', 'dirt', 'asphalt', '极品飞车', '地平线', '狂野飙车', '跑跑卡丁车', 'qq飞车', 'assetto', 'beamng', '神力科莎', 'euro truck', 'trackmania'] },
  { key: '体育', words: ['fifa', 'nba', 'pes ', 'efootball', 'football', 'soccer', 'basketball', 'tennis', 'golf', 'nhl', 'mlb', 'madden', 'wwe', 'rugby', '实况足球', 'fifa online', '足球', '篮球', '网球', '高尔夫', '桌球', 'rocket league', '火箭联盟', 'football manager', '足球经理', 'topspin', '橄榄球'] },
  { key: '格斗', words: ['fighting', 'fighter', 'street fighter', 'tekken', 'mortal kombat', 'king of fighters', 'guilty gear', 'soulcalibur', '铁拳', '拳皇', '街头霸王', '真人快打', '刀剑神域', 'dragon ball', '龙珠'] },
  { key: '恐怖', words: ['horror', 'fear', 'resident evil', 'silent hill', 'outlast', 'dead space', 'phasmophobia', 'the evil within', '生化危机', '寂静岭', '港诡实录', '纸人', '逃生', '层层恐惧', 'carrion', '红怪', 'amnesia', '失忆症', 'alien isolation', '异形隔离', 'dying light', '消逝的光芒', 'lethal company', '致命公司', 'content warning', 'devour', 'forewarned', 'backrooms', '后室'] },
  { key: '解谜', words: ['puzzle', 'portal', 'the witness', 'talos', 'baba is you', 'myst', 'limbo', 'inside', '纪念碑谷', '传送门', '解谜', 'the room', '机械迷城', 'machinarium', 'gorogoa', 'superliminal', 'baba', 'return of the obra dinn', '奥伯拉丁的回归'] },
  { key: '音乐节奏', words: ['rhythm', 'osu', 'beat saber', 'guitar hero', 'rock band', 'djmax', 'muse dash', 'voez', 'cytus', 'deemo', '节奏', '音游', '劲舞团', '太鼓', 'geometry dash', '几何冲刺'] },
  { key: '休闲', words: ['casual', 'party', 'among us', 'fall guys', 'human fall flat', 'overcooked', 'it takes two', '糖豆人', '双人成行', '胡闹厨房', '动物森友会', '蛋仔派对', 'machine party', 'unpacking', 'a little to the left', 'sticky business', 'cooking', '料理', 'farm together', '一起玩农场', 'powerwash'] },
  { key: '卡牌', words: ['card', 'hearthstone', 'slay the spire', 'magic the gathering', 'gwent', 'artifact', 'legends of runeterra', '炉石传说', '杀戮尖塔', '万智牌', '三国杀', 'balatro', '小丑牌', 'inscryption', '邪恶冥刻', 'yu gi oh', '游戏王', 'pokemon tcg'] },
  { key: '独立', words: ['indie', 'hollow knight', 'hades', 'celeste', 'dead cells', 'undertale', 'deltarune', 'cuphead', 'katana zero', '蔚蓝', '茶杯头', '空洞骑士', '杀戮尖塔', '死亡细胞', 'stardew', '星露谷', 'terraria', '泰拉瑞亚', 'ori and', '奥日', 'outer wilds', '星际拓荒', 'dave the diver', '潜水员戴夫', 'vampire survivors', '吸血鬼幸存者', 'balatro', '小丑牌', 'animal well', '九日'] },
  { key: 'VR', words: ['vr', 'virtual reality', 'oculus', 'vive', 'steamvr', '虚拟现实', 'beat saber'] },
  { key: '网游', words: ['online', 'mmorpg', 'mmo', '网络版', '传奇', '奇迹mu', 'dnf', '地下城与勇士', '龙之谷', '剑灵', '天涯明月刀', '逆水寒', '永劫无间', 'warframe', '星际战甲', 'final fantasy xiv', 'ff14', 'lost ark', '命运方舟'] },
  { key: '联机', words: ['co op', 'coop', 'multiplayer', 'multi player', '联机', '局域网', 'among us', 'lethal company', '致命公司', 'content warning', 'helldivers', '绝地潜兵', 'deep rock', '地狱潜者'] },
  { key: '单机', words: ['singleplayer', 'single player', '单机'] }
];

/* 如果所有规则都没命中，会落到这个默认分类 */
const DEFAULT_CATEGORY = '其他';

/**
 * 「在 Steam 上架但不是游戏」的条目。
 * Steam 的 appmanifest 里混着运行库、工具、壁纸软件等等，
 * 它们拿到的分数很高（有 AppID、体积也不小），光靠打分筛不掉，
 * 所以这里点名清理一批最常见的。
 */
const NON_GAME_TITLES = [
  /^steamworks common redistributables?$/i,
  /^steam linux runtime/i,
  /^proton\b/i,
  /^steam vr\b/i,
  /^wallpaper engine$/i,
  /^lossless scaling$/i,
  /^obs studio/i,
  /^rtss\b/i,
  /^blender\b/i,
  /^gpu ?z\b/i,
  /^3dmark\b/i,
  /^cinebench\b/i,
  /^unigine\b/i,
  /^msi afterburner/i,
  /^vulkan\b/i,
  /^directx\b/i,
  /^steam client/i,
  /^dedicated server/i,
  /^server\b/i,
  /^sdk\b/i,
  /^visual studio/i
];

/**
 * 判断一个标题是不是「明显不是游戏」。
 * 注意只匹配整个标题（^...$），避免误伤像 "Wallpaper Engine Simulator" 这种真实游戏名。
 * @param {string} name
 */
function isKnownNonGameTitle(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return NON_GAME_TITLES.some((re) => re.test(n));
}

/**
 * 依据游戏名称自动推断分类，可返回多个分类。
 * @param {string} name 游戏名称（或安装目录名）
 * @returns {string[]} 分类数组，至少包含默认分类
 */
function classify(name) {
  if (!name) return [DEFAULT_CATEGORY];
  const lower = String(name).toLowerCase();
  // 归一化：把标点符号统一换成空格。
  // 这一步很关键 —— "Cities: Skylines II" 里的冒号会把 "cities skylines" 这个
  // 多词关键词从中间切断，归一化之后才能正常匹配上。
  const flat = lower.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
  const haystack = flat || lower;

  const hits = [];
  for (const rule of CATEGORY_RULES) {
    for (const w of rule.words) {
      if (matchWord(haystack, w)) { hits.push(rule.key); break; }
    }
  }
  // 去掉重复 + 最多保留 3 个主要分类，避免标签爆炸
  const uniq = [...new Set(hits)].slice(0, 3);
  return uniq.length ? uniq : [DEFAULT_CATEGORY];
}

/**
 * 关键词匹配。
 * 规则：纯 ASCII 的短关键词（<=3 字符）必须按"单词边界"匹配，
 *      避免 "td" 命中 "study"、"f1" 命中 "f12" 之类的误伤；
 *      中文关键词（以及较长的英文词）直接做包含匹配，
 *      否则 "文明6" 里的数字会把边界判断挡掉。
 */
function matchWord(lowerText, word) {
  const w = word.toLowerCase();
  const isAscii = /^[a-z0-9 ]+$/.test(w);
  if (isAscii && w.length <= 3) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`, 'i');
    return re.test(lowerText);
  }
  return lowerText.includes(w);
}

/** 正则特殊字符转义 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------
 * 二、注册表卸载项的"像不像游戏"打分
 * ------------------------------------------------------------------ */

/** 明显是「软件 / 运行库 / 驱动」而不是游戏的特征词 */
const NOT_GAME_PATTERNS = [
  /update/i, /redistributable/i, /runtime/i, /\bdriver\b/i, /\bsdk\b/i, /\btools?\b/i,
  /\bservice\b/i, /\bhelper\b/i, /\bcomponent\b/i, /\bplugin\b/i, /\bpackage\b/i,
  /\blanguage pack\b/i, /\bdocumentation\b/i, /\bsample\b/i, /\badd-?in\b/i,
  /\bvisual c\+\+/i, /\.net\s/i, /directx/i, /dotnet/i, /jre|java se/i,
  /\bweb\b\s*(view|browser)/i, /browser/i, /\bclient\b\s*(support|service)/i,
  /uninstall/i, /\bpatch\b/i, /\bcleaner\b/i, /\bantivirus\b/i, /\bsecurity\b/i,
  // —— 以下是根据真实机器扫描结果补充的（软件类高频误报） ——
  /音乐|music|cloudmusic|网易云/i,          // 网易云音乐之类
  /夸克|quark|浏览器|chrome|edge\b|firefox/i,
  /加速器|accelerator|vpn|\bboost\b/i,      // 游戏加速器（不是游戏本体）
  /输入法|\bime\b|sogou|搜狗/i,
  /网盘|cloud\s*drive|onedrive|dropbox/i,
  /office|wps|kingsoft/i,
  /\bagent\b/i,                             // QQ Agent 之流的后台代理
  /harness|deepseek|ollama|模型/i           // 本地 AI 工具
];

/** 「启动器 / 平台 / 客户端」这类东西不是可玩的游戏，但要单独减分而不是直接拉黑 */
const LAUNCHER_PATTERNS = [
  /launcher/i, /启动器/i, /竞技平台/i, /游戏平台/i, /\bclient\b$/i, /平台$/
];

/** 已知的「软件厂商」——它们发行的东西多半不是游戏 */
const SOFTWARE_VENDORS = [
  /microsoft/i, /google/i, /adobe/i, /intel/i, /nvidia/i, /^amd\b/i, /realtek/i,
  /oracle/i, /python/i, /jetbrains/i, /docker/i, /vmware/i, /citrix/i, /sap\b/i,
  /autodesk/i, /corel/i, /autocad/i, /wps|kingsoft|金山/i, /tencent\s*technology/i,
  /apple\b/i, /mozilla/i, /logitech/i, /razer/i, /corsair/i, /dell\b/i, /hp\b|hewlett/i,
  /lenovo/i, /asus/i, /acer/i, /samsung/i, /huawei/i, /xiaomi/i, /baidu/i, /alibaba/i,
  /byte\s*dance|bytedance/i, /zoom/i, /slack/i, /tencent\s*meeting/i, /notion/i,
  /postman/i, /git\b/i, /node\.js/i, /electron/i, /unity\s*technologies/i, /epic\s*games\s*launcher/i,
  /net\s*ease|网易/i   // 网易的软件（云音乐、有道等）；网易的游戏会被 Steam 库那边兜住
];

/**
 * 目录路径里出现这些片段 → 强烈暗示是游戏。
 * 注意：这里的关键词必须"够具体"，否则会把软件目录也误判成游戏。
 * 例如早先写了 /netease/，结果 D:\Program Files\NetEase\CloudMusic 被当成了游戏。
 */
const GAME_PATH_HINTS = [
  /steamapps[\\/]/i,
  /[\\/]games?[\\/]/i,          // \Game\ 或 \Games\
  /[\\/]gog games[\\/]/i,
  /[\\/]epic games[\\/]/i,
  /[\\/]riot games[\\/]/i,
  /[\\/]ubisoft[\\/]/i,
  /[\\/]battle\.net[\\/]/i,
  /[\\/]ea games[\\/]/i,
  /[\\/]wegame[\\/]/i,
  /[\\/]perfectworld[\\/]/i,
  /[\\/]microsoft games[\\/]/i,
  /[\\/]hoyoverse[\\/]/i,
  /[\\/]mihoyo[\\/]/i
];

/** 判定为游戏候选的最低分（低于这个分不进扫描结果） */
const CANDIDATE_THRESHOLD = 4;

/**
 * 给一条注册表卸载项打分。
 *
 * 打分不是"越像越好"的模糊判断，而是刻意让每一条高分都必须有硬证据：
 *   · Steam AppID          → 铁证
 *   · 装在 steamapps 等游戏库里 → 强证据
 *   · 体积很大（>3GB）      → 中等证据（很多专业软件也很大，所以只给 3 分）
 * 而软件特征、启动器、厂商名则是明确的减分项。
 * 这样阈值卡在 4 分时，能同时做到"漏报少"和"误报少"。
 *
 * @param {{name:string,publisher:string,installLocation:string,exePath:string,sizeKB:number,steamAppId:string}} entry
 * @returns {{score:number, reasons:string[]}}
 */
function scoreRegistryEntry(entry) {
  let score = 0;
  const reasons = [];
  const name = entry.name || '';
  const pub = entry.publisher || '';
  const loc = entry.installLocation || '';
  const sizeKB = Number(entry.sizeKB || 0);
  const sizeMB = sizeKB / 1024;

  // —— 硬证据 ——
  if (entry.steamAppId) { score += 5; reasons.push('Steam 应用'); }
  if (GAME_PATH_HINTS.some((re) => re.test(loc))) { score += 4; reasons.push('装在游戏库目录'); }
  if (sizeMB > 3000) { score += 3; reasons.push('体积 > 3GB'); }
  else if (sizeMB > 800) { score += 2; reasons.push('体积 > 800MB'); }
  else if (sizeMB > 200) { score += 1; reasons.push('体积 > 200MB'); }
  if (entry.exePath) { score += 1; reasons.push('有主程序'); }

  // —— 软件特征：明确减分 ——
  if (NOT_GAME_PATTERNS.some((re) => re.test(name))) { score -= 6; reasons.push('名称像软件'); }
  if (SOFTWARE_VENDORS.some((re) => re.test(pub))) { score -= 5; reasons.push('发行商为软件厂商'); }
  if (LAUNCHER_PATTERNS.some((re) => re.test(name))) { score -= 3; reasons.push('启动器/平台，不是游戏本体'); }
  if (!loc) { score -= 3; reasons.push('无安装路径'); }
  if (sizeMB > 0 && sizeMB < 60) { score -= 3; reasons.push('体积过小'); }

  return { score, reasons };
}

/**
 * 综合判断一条注册表项是否值得作为游戏候选推给用户。
 * 阈值 4 分：必须至少有"装游戏库里"或"体积很大 + 有主程序"之一才会被收录。
 * 最终仍由用户在「扫描结果」里勾选确认，宁可少推也不要推一堆浏览器进来。
 */
function isGameCandidate(entry) {
  const { score } = scoreRegistryEntry(entry);
  return score >= CANDIDATE_THRESHOLD;
}

/* ------------------------------------------------------------------
 * 三、从一个目录里挑出「最像游戏主程序」的 exe
 * ------------------------------------------------------------------ */

/** exe 文件名黑名单：这些多半不是游戏本体 */
const EXE_BLACKLIST = /^(unins|uninst|uninstall|setup|install(er)?|update|updater|patch|patcher|vcredist|dxsetup|dxwebsetup|dotnet|directx|crashpad|crashhandler|crashreport|unitycrashhandler|bugreport|report|helper|service|daemon|7z|winrar|ffmpeg|obs|node|python|java|javaw|electron|cef|chrome|steam|steamwebhelper|epicgameslauncher|redist|launcher_helper|gdbserver)/i;

/** exe 文件名中出现的这些词 → 基本可以判定不是可玩的入口 */
const EXE_SUFFIX_BLACKLIST = /(crash|handler|report|setup|install|unins|redist|helper|service|updater|debug|console|benchmark|creator|editor|tool|config|settings|telemetry|diagnostic)/i;

/** exe 文件名中出现的这些词 → 可能是入口，加分 */
const EXE_HINT_WORDS = /(game|play|start|launch|run|\bmain\b)/i;

/** 把名称归一化：只保留小写字母数字，便于模糊比较 */
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

/**
 * 在候选 exe 列表中挑选最可能的游戏主程序。
 * @param {Array<{path:string,name:string,size:number,depth:number}>} exes
 * @param {string} folderName 安装目录名（用于与 exe 文件名比对）
 * @returns {{exe:object|null, score:number, reasons:string[]}}
 */
function pickMainExe(exes, folderName) {
  if (!exes || !exes.length) return { exe: null, score: 0, reasons: [] };

  const folderNorm = normalizeName(folderName);
  let best = null;
  let bestScore = -Infinity;
  let bestReasons = [];

  for (const exe of exes) {
    let score = 0;
    const reasons = [];
    const base = exe.name.replace(/\.exe$/i, '');
    const baseNorm = normalizeName(base);

    // 体积：游戏主程序通常不小
    const mb = exe.size / 1048576;
    if (mb >= 100) { score += 6; reasons.push('主程序 > 100MB'); }
    else if (mb >= 20) { score += 4; reasons.push('主程序 > 20MB'); }
    else if (mb >= 3) { score += 2; }
    else if (mb >= 1) { score += 1; }
    else { score -= 3; reasons.push('体积过小'); }

    // 与目录名匹配度：MyGame\MyGame.exe 是最典型的游戏结构
    if (folderNorm && baseNorm === folderNorm) { score += 8; reasons.push('与目录同名'); }
    else if (folderNorm && baseNorm && (baseNorm.includes(folderNorm) || folderNorm.includes(baseNorm))) { score += 4; reasons.push('与目录名相近'); }

    // 关键词
    if (EXE_HINT_WORDS.test(base)) { score += 1.5; }
    // 目录层级越浅越可能是入口
    score -= Math.min(exe.depth, 5) * 0.6;
    // 黑名单
    if (EXE_BLACKLIST.test(base)) { score -= 12; reasons.push('命中黑名单'); }
    else if (EXE_SUFFIX_BLACKLIST.test(base)) { score -= 6; reasons.push('像是辅助工具'); }

    if (score > bestScore) { bestScore = score; best = exe; bestReasons = reasons; }
  }

  return { exe: best, score: bestScore, reasons: bestReasons };
}

module.exports = {
  CATEGORY_RULES,
  DEFAULT_CATEGORY,
  CANDIDATE_THRESHOLD,
  NON_GAME_TITLES,
  classify,
  scoreRegistryEntry,
  isGameCandidate,
  isKnownNonGameTitle,
  pickMainExe,
  normalizeName,
  EXE_BLACKLIST,
  EXE_SUFFIX_BLACKLIST,
  GAME_PATH_HINTS,
  NOT_GAME_PATTERNS,
  LAUNCHER_PATTERNS,
  SOFTWARE_VENDORS
};
