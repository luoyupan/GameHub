/**
 * ============================================================
 *  GameHub - MOD 管理模块  (src/main/mods.js)
 * ------------------------------------------------------------
 *  给一款游戏列出它的 MOD，并支持 启用 / 禁用 / 删除 / 添加。
 *
 *  ── MOD 从哪来（三个来源，按可信度排） ──────────────────────
 *   ① Steam 创意工坊：<Steam库>\steamapps\workshop\content\<AppID>\<工坊ID>\
 *      这是订阅式安装的，目录名就是创意工坊的 published file id。
 *      光有 id 没有名字，所以名字/标签/预览图要另外去问 Steam 的公开接口。
 *   ② 游戏自带的 MOD 目录：<安装目录>\mods 之类的常见名字
 *   ③ 用户手动添加的非 Steam MOD（记在 mods.json 里）
 *
 *  ── 两个刻意的设计选择 ──────────────────────────────────────
 *   · **启用/禁用靠文件系统本身，不另存一份状态**。
 *     禁用 = 把目录/文件改名为 xxx.gamehub-disabled，启用 = 改回来。
 *     为什么不记一份「谁被禁用了」的清单：那种状态会和磁盘真实情况漂移
 *     （用户手动改了名字、游戏自己重建了目录、删了又装），
 *     到时候界面显示"已禁用"而文件其实是启用的，比不显示更糟。
 *     现在的做法是**每次以磁盘为准**，永远不会自相矛盾。
 *
 *   · **删除走回收站，不走真删除**。
 *     MOD 是用户花时间攒的东西，误删一个整合包可能意味着几十小时。
 *     所以删除一律 shell.trashItem()（进回收站，还能找回来），
 *     且删之前把完整路径摆给用户看清楚。
 *
 *  ⚠ 本模块不 require electron 到顶层（只在真正要弹框/进回收站时懒加载），
 *    这样才能被纯 Node 的单元测试直接加载。
 * ============================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const scanner = require('./scanner');

/* ------------------------------------------------------------------
 *  常量
 * ------------------------------------------------------------------ */

const MODS_FILE = 'mods.json';          // 用户手动添加的 MOD
const CACHE_FILE = 'mods-cache.json';   // 创意工坊元数据缓存

/**
 * 禁用标记后缀。
 * 选它而不是把文件挪到别的目录：挪走之后游戏可能因为找不到路径而报错，
 * 或者干脆自己重建一个空目录，用户就再也看不出那是被禁用的。
 * 改个名是**可逆且可见**的 —— 用户在资源管理器里也能一眼看懂。
 */
const DISABLED_SUFFIX = '.gamehub-disabled';

/**
 * 游戏自带的 MOD 目录常见名字（大小写敏感的文件系统要逐个试）。
 * 只认这些明确的目录名，**不去猜** —— 猜错会把游戏本体文件当成 MOD。
 */
const MOD_DIR_NAMES = ['mods', 'Mods', 'MODS', 'mod', 'Mod', '~mods', 'plugins', 'Plugins'];

/** 这些不是 MOD，是系统/编辑器留下的垃圾 */
const JUNK_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'readme.txt']);

/**
 * 说明书 / 占位符类文件的后缀。
 *
 * 这些后缀的文件**不可能是能被游戏加载的 MOD** —— 游戏加载的是目录、
 * .pak / .esp / .dll 这类，没人拿 .txt 当 MOD。
 * 加这条是因为实测撞上了：RimWorld 的 `Mods\` 目录里躺着官方给的
 * `Place mods here.txt`，被当成了一个 MOD 列出来（截图里看得清清楚楚），
 * 用户会以为 GameHub 把游戏本体文件认成 MOD 了。
 */
const JUNK_EXTS = new Set(['.txt', '.md', '.nfo', '.url', '.lnk', '.rtf', '.pdf', '.chm']);

/** 名字本身就是说明书/许可证/占位符的（不分后缀） */
const JUNK_PREFIXES = ['readme', 'license', 'licence', 'changelog', 'changes',
  'place mods here', '说明', '使用说明', '安装说明'];

/** 一个 MOD 目录里最多认多少个条目（防止某个畸形目录把界面撑爆） */
const MAX_MODS_PER_DIR = 400;

const UA = 'GameHub/1.0 (+local game library launcher)';

/* ------------------------------------------------------------------
 *  小工具
 * ------------------------------------------------------------------ */

/** 路径归一化（Windows 大小写不敏感，比较路径时统一转小写） */
function normPath(p) {
  return path.normalize(String(p || '')).replace(/[\\/]+$/, '');
}

/** 路径指纹：用来做"路径不变则 id 不变"的稳定 id */
function pathKey(p) {
  return crypto.createHash('sha1').update(normPath(p).toLowerCase()).digest('hex').slice(0, 12);
}

/** 这个名字是禁用状态吗 */
function isDisabledName(name) {
  return String(name || '').toLowerCase().endsWith(DISABLED_SUFFIX);
}

/** 原始名 → 禁用名 */
function disabledName(name) {
  return isDisabledName(name) ? String(name) : String(name) + DISABLED_SUFFIX;
}

/** 禁用名 → 原始名（不是禁用名就原样返回） */
function enabledName(name) {
  const s = String(name || '');
  return isDisabledName(s) ? s.slice(0, -DISABLED_SUFFIX.length) : s;
}

/** 显示用的名字：去掉禁用后缀，也去掉文件扩展名的干扰留给调用方 */
function displayName(name) {
  const base = enabledName(name);
  // 工坊条目目录名是纯数字 id，没有可读性，交给上层用标题覆盖
  return base;
}

/** 这些文件名不值得当 MOD 列出来 */
function isJunk(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return true;
  if (n.startsWith('.')) return true;
  if (JUNK_NAMES.has(n)) return true;

  // 说明书 / 占位符：后缀对得上的，或者名字以前缀开头的
  const dot = n.lastIndexOf('.');
  if (dot > 0 && JUNK_EXTS.has(n.slice(dot))) return true;
  for (const p of JUNK_PREFIXES) {
    if (n.startsWith(p)) return true;
  }
  return false;
}

/** 发一个 HTTPS 请求（自带 https，不引第三方库） */
function request(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body = null, timeout = 15000 } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('URL 不合法：' + urlStr)); }

    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers: { 'User-Agent': UA, ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 就留 null */ }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 用 Electron 的 net 发一个 POST（走 Chromium 的网络栈）。
 *
 * ⚠ 这是这台机器上唯一能连上 `*.steampowered.com` 的一条路，别改回去。
 *
 * 实测（tools/workshop-net-probe.js，三条路并排打出来）：
 *   ① Node https.request  → ✗ unable to verify the first certificate
 *   ② Node fetch（undici） → ✗ 同上（UNABLE_TO_VERIFY_LEAF_SIGNATURE）
 *   ③ Electron net        → ✓ HTTP 200
 *   ④ 渲染进程 fetch       → ✗ Failed to fetch
 *
 * 再往下细分，坏的**只有 `*.steampowered.com`**：
 *   cdn.cloudflare.steamstatic.com ✓ / shared.steamstatic.com ✓
 *   store.steampowered.com ✗ / api.steampowered.com ✗ / api.epicgames.dev ✓
 * 也就是说封面能抓、Epic 能登，只有工坊接口挂 —— 这正好解释了主人截图里
 * 那一行「连不上 Steam 创意工坊接口」，以及为什么是"部分"不通。
 *
 * 根因：Steam 这几个域名的证书链不带中间证书，Node 的 OpenSSL 不会去补，
 * 直接判 UNABLE_TO_VERIFY_LEAF_SIGNATURE；Chromium 有 AIA 补链，自己补齐就过了。
 * 所以这不是"网络不通"，是**两套 TLS 策略的差别** —— 换网络栈就能解决。
 *
 * @returns {Promise<{status:number,text:string,json:object|null}>|null}
 *          当前环境没有 electron.net（纯 Node，比如单元测试）时返回 null
 */
function postFormViaElectronNet(url, headers, body, timeout) {
  let el;
  try { el = require('electron'); } catch { return null; }
  // 纯 Node 里 require('electron') 拿到的是一个字符串（二进制路径），没有 net
  if (!el || !el.net) return null;

  /* ⚠ Content-Length / Host / Connection 这类头**不能自己设**。实测：
   *   同一 URL、同一 body，带上 Content-Length 立刻报 net::ERR_INVALID_ARGUMENT（1ms 就失败），
   *   去掉就 200。而错误信息里一个字都不提是哪个头的问题 —— 只能靠对照实验找出来。
   *   （值是字符串也一样，不是类型问题，是这几个头被 Chromium 接管了。） */
  const safe = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'host' || lk === 'connection') continue;
    safe[k] = v;
  }

  /* ① 首选 net.fetch（Electron ≥ 30）。
   *   比 net.request 省心得多：头、body 长度、超时全按 fetch 语义走，
   *   大 body 也不会有问题。实测 50 个 id（1.8KB）→ HTTP 200、1.3s，
   *   而且直接拿得到 title —— 这才是"能用的那一条"。 */
  if (typeof el.net.fetch === 'function') {
    return el.net.fetch(url, {
      method: 'POST',
      headers: safe,
      body,
      signal: AbortSignal.timeout(timeout)
    }).then(async (res) => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON 交给调用方看状态码 */ }
      return { status: res.status, text, json };
    });
  }

  // ② 老版本 Electron 没有 net.fetch，退回 net.request
  if (typeof el.net.request !== 'function') return null;

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = el.net.request({ method: 'POST', url });
      for (const [k, v] of Object.entries(safe)) req.setHeader(k, v);
    } catch (e) { return reject(e); }

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { req.abort(); } catch { /* 已经结束了 */ }
      reject(new Error('请求超时（' + timeout + 'ms）'));
    }, timeout);

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 交给调用方看状态码 */ }
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * POST 一个表单，拿 JSON。
 *
 * 三条路按顺序试，**把三边的错都累积下来** —— 只留最后一个错误会把真正的原因盖住，
 * 这个坑在 Epic 那次已经付过学费了（当时看到的失败信息和实际原因完全对不上）。
 *
 * 优先 Electron net：见上面 postFormViaElectronNet 的注释，
 * 它是唯一能过 Steam 证书链的一条。fetch / https 留作纯 Node 环境和兜底。
 */
async function postFormJson(url, body, timeout = 20000) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  };
  const tried = [];
  const msg = (e) => (e && e.message ? e.message : String(e));

  // ① Electron net（Chromium 栈）—— 唯一能连上 *.steampowered.com 的一条
  try {
    const p = postFormViaElectronNet(url, headers, body, timeout);
    if (p) return await p;
    tried.push('electron-net → 当前环境没有（纯 Node）');
  } catch (e) {
    tried.push('electron-net → ' + msg(e));
  }

  // ② Node fetch
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeout)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON 交给调用方看状态码 */ }
      return { status: res.status, text, json };
    } catch (e) {
      tried.push('fetch → ' + msg(e) + (e && e.cause && e.cause.code ? '（' + e.cause.code + '）' : ''));
    }
  }

  // ③ Node https
  try {
    return await request(url, { method: 'POST', headers, body, timeout });
  } catch (e) {
    tried.push('https → ' + msg(e));
  }

  const err = new Error(tried.join('；') || '请求失败');
  err.reasons = tried;
  throw err;
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/* ------------------------------------------------------------------
 *  创意工坊：本地 ACF → 体积 / 更新时间（离线可用）
 * ------------------------------------------------------------------ */

/**
 * 解析 appworkshop_<appid>.acf。
 *
 * 这个文件是 Steam 自己维护的「这个游戏的创意工坊装了什么」的账本，
 * 里面有每个工坊条目的体积和更新时间 —— **不需要联网**就能拿到。
 * 名字和标签它没有，那两项只能走 Web 接口，所以这里拿到的是"骨架"。
 *
 * @returns {Map<string, {size:number, timeUpdated:number}>} key = 工坊 id
 */
function parseWorkshopAcf(text) {
  const out = new Map();
  let obj;
  try { obj = scanner.parseVdf(String(text || '')); } catch { return out; }

  const root = obj.AppWorkshop || obj.appworkshop || {};
  const inst = root.WorkshopItemsInstalled || {};
  const det = root.WorkshopItemDetails || {};

  for (const id of Object.keys(inst)) {
    const v = typeof inst[id] === 'object' && inst[id] ? inst[id] : {};
    out.set(String(id), {
      size: Number(v.size || 0) || 0,
      timeUpdated: Number(v.timeupdated || 0) || 0
    });
  }
  // 详情里有更准的更新时间（有些条目只有 Details 没有 Installed）
  for (const id of Object.keys(det)) {
    const v = typeof det[id] === 'object' && det[id] ? det[id] : {};
    const prev = out.get(String(id)) || { size: 0, timeUpdated: 0 };
    out.set(String(id), {
      size: prev.size,
      timeUpdated: Number(v.timeupdated || 0) || prev.timeUpdated
    });
  }
  return out;
}

/* ------------------------------------------------------------------
 *  创意工坊：Web 接口 → 标题 / 标签 / 预览图
 * ------------------------------------------------------------------ */

const WORKSHOP_API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

/**
 * 组装 GetPublishedFileDetails 的表单体。
 *
 * 这个接口**不需要 API key**（读的是公开信息），但它只收 POST 表单，
 * 而且 id 必须以 publishedfileids[N]= 的形式逐个带上下标。
 * 单独抽出来是为了能被测试固定住 —— 这一个字符串拼错，整个标题就全没了。
 */
function workshopApiBody(ids) {
  const list = (ids || []).filter(Boolean);
  const q = new URLSearchParams();
  q.append('itemcount', String(list.length));
  list.forEach((id, i) => q.append(`publishedfileids[${i}]`, String(id)));
  return q.toString();
}

/**
 * 把工坊接口的响应整理成 id → 元数据。
 *
 * ⚠ 一定要按 result 过滤：接口对**不存在的 id 也会回一条**，
 *   只是 result=9。不滤掉的话会给这些幽灵条目编出名字，界面上就多出一堆空白 MOD。
 */
function parseWorkshopDetails(json) {
  const out = new Map();
  const list = (json && json.response && json.response.publishedfiledetails) || [];
  for (const d of list) {
    if (!d || Number(d.result) !== 1) continue;      // 1 = 成功
    const id = String(d.publishedfileid || '');
    if (!id) continue;
    // tags 是个 [{tag:'xxx'}, ...]，有时候是空对象数组
    const tags = (Array.isArray(d.tags) ? d.tags : [])
      .map((t) => String((t && t.tag) || '').trim())
      .filter(Boolean);
    out.set(id, {
      title: String(d.title || '').trim(),
      description: String(d.description || '').trim(),
      tags,
      previewUrl: String(d.preview_url || ''),
      timeUpdated: Number(d.time_updated || 0) || 0,
      fileSize: Number(d.file_size || 0) || 0,
      subscriptions: Number(d.subscriptions || 0) || 0,
      visibility: Number(d.visibility || 0) || 0
    });
  }
  return out;
}

/* ------------------------------------------------------------------
 *  跳转地址
 * ------------------------------------------------------------------ */

/** Steam 创意工坊网页版（一定打得开，订阅要在客户端里点，但网页能看清内容） */
function steamWorkshopWebUrl(appId) {
  return 'https://steamcommunity.com/app/' + encodeURIComponent(String(appId || '')) + '/workshop/';
}

/**
 * 唤起 **Steam 客户端里**的创意工坊页（主人的要求：不要跳外部浏览器）。
 *
 * 为什么用它而不是网页：订阅 / 退订 / 自动下载这些动作**只有客户端能做**，
 * 网页版点订阅最后还是要把你弹回客户端 —— 多绕一圈。
 *
 * ⚠ 两个坑：
 *   1. `shell.openExternal('steam://…')` 在没装 Steam 的机器上**不会抛错**，
 *      Windows 只会弹"你要用什么程序打开它"。所以调用方必须自己先查一遍
 *      Steam 装没装（`platforms._internals.Steam.findInstall()`），
 *      不能靠 try/catch 判断成败。
 *   2. 万一哪天这个 protocol 换了，备选是
 *      `steam://openurl/` + 网页地址 —— 也是在 Steam 里开，只是走内置浏览器。
 */
function steamWorkshopClientUrl(appId) {
  return 'steam://url/SteamWorkshopPage/' + encodeURIComponent(String(appId || ''));
}

/**
 * N 网（Nexus Mods）的游戏搜索地址。
 *
 * ⚠ 实测确认过的参数名是 `keyword`、路径是 /games ——
 *   网上流传的 /search/?gsearch=xxx 那套**是错的**，实测会渲染成空搜索。
 *   Nexus 的页面是前端渲染的，没有稳定的"游戏 slug"可以直接拼，
 *   所以用搜索页最稳。
 */
function nexusSearchUrl(gameName) {
  return 'https://www.nexusmods.com/games?keyword=' + encodeURIComponent(String(gameName || '').trim());
}

/* ------------------------------------------------------------------
 *  分类 / 排序
 * ------------------------------------------------------------------ */

/**
 * 没有工坊标签时的兜底分组。
 *
 * ⚠ 为什么分成两个，而不是笼统一个「未分类」：
 *   创意工坊条目也可能没有标签（作者没设，或者接口没取到），
 *   如果把它和本地 MOD 一起塞进「本地 / 未分类」，用户会看到
 *   自己的创意工坊 MOD 显示成"本地"，直接怀疑是识别错了。
 *   宁可分细一点，也不要给一个会误导的标签。
 */
const UNTAGGED_LOCAL = '本地 MOD';
const UNTAGGED_WORKSHOP = '创意工坊 · 无标签';
/** 这两个不是真标签，是"没有标签"的兜底桶 */
const PSEUDO_GROUPS = [UNTAGGED_WORKSHOP, UNTAGGED_LOCAL];

function isPseudoGroup(tag) {
  return PSEUDO_GROUPS.includes(tag);
}

/** 一个 MOD 该归到哪一组（有标签就取第一个，没有就按来源兜底） */
function groupKeyOf(m) {
  const tags = (m.tags || []).filter(Boolean);
  if (tags.length) return tags[0];
  return m.kind === 'workshop' ? UNTAGGED_WORKSHOP : UNTAGGED_LOCAL;
}

/**
 * 按标签做二级分类。
 *
 * 一款 MOD 可能带多个标签 —— 这里选**第一个标签**当它的归属，
 * 不然同一张卡会在好几组里重复出现，看着像有多个 MOD。
 *
 * @returns {Array<{tag:string, mods:Array}>} 组内已排序
 */
function groupByTag(mods, sortBy = 'name', asc = true) {
  const byTag = new Map();
  for (const m of (mods || [])) {
    const tag = groupKeyOf(m);
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(m);
  }
  const rank = (t) => {
    const i = PSEUDO_GROUPS.indexOf(t);
    return i < 0 ? 0 : i + 1;      // 兜底桶永远垫底，且顺序固定
  };
  const groups = [...byTag.entries()].map(([tag, list]) => ({
    tag, mods: sortMods(list, sortBy, asc)
  }));
  groups.sort((a, b) => {
    const ra = rank(a.tag), rb = rank(b.tag);
    if (ra !== rb) return ra - rb;
    return a.tag.localeCompare(b.tag, 'zh');
  });
  return groups;
}

/** 所有出现过的标签（给筛选条用） */
function collectTags(mods) {
  const set = new Set();
  for (const m of (mods || [])) {
    for (const t of (m.tags || [])) if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

/**
 * 每个标签下有多少个 MOD。
 *
 * ⚠ 这里数的是**成员关系**（标签出现在 tags 数组里就算），
 *   而不是 groupByTag 那种"只认第一个标签"的归属 ——
 *   两者必须分开：分组时一个 MOD 只能站一个位置（不然界面上会重复出现），
 *   但用户点「Maps」想看的是"所有带 Maps 的 MOD"，一个都不能少。
 *   之前把这两件事混成一个，结果点了 Maps 反而看不到带 Maps 的 MOD。
 *
 * 兜底桶（本地 MOD / 创意工坊无标签）按**归属**数 —— 它们本来就不是标签，
 * 不存在"一个 MOD 同时算两个兜底桶"的情况。
 *
 * @returns {Record<string, number>}
 */
function tagCounts(mods) {
  const out = Object.create(null);
  for (const m of (mods || [])) {
    const tags = (m.tags || []).filter(Boolean);
    for (const t of new Set(tags)) out[t] = (out[t] || 0) + 1;
    const key = groupKeyOf(m);
    if (isPseudoGroup(key)) out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * 按"成员关系"筛出带某个标签的 MOD。
 *
 * @param {string} tag 真标签按成员匹配；两个兜底桶按归属匹配
 */
function modsWithTag(mods, tag) {
  return (mods || []).filter((m) => {
    if (isPseudoGroup(tag)) return groupKeyOf(m) === tag;
    return (m.tags || []).filter(Boolean).includes(tag);
  });
}

/**
 * 排序。
 * @param {'workshop'|'local'} [scope] 可选：只保留某一类
 */
function sortMods(mods, by = 'name', asc = true) {
  const arr = [...(mods || [])];
  const dir = asc ? 1 : -1;
  const cmp = {
    // 排序时统一忽略大小写，不然 "abc" 会全排到 "Zzz" 后面
    name: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'),
    size: (a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0),
    updated: (a, b) => (a.timeUpdated || 0) - (b.timeUpdated || 0),
    // 排序里最有用的一条：启用的排前面
    enabled: (a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)
  }[by] || ((a, b) => 0);

  arr.sort((a, b) => {
    const r = cmp(a, b);
    if (r) return r * dir;
    // 次级排序固定按名字，保证顺序稳定（不然每次刷新卡片都在跳）
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
  });
  return arr;
}

/* ------------------------------------------------------------------
 *  客户端
 * ------------------------------------------------------------------ */

/**
 * 建一个 MOD 管理器。
 *
 * @param {{dataDir?:string, onLog?:Function,
 *          steamLibraries?:string[], workshopApi?:string}} [opts]
 *   dataDir        —— MOD 记录与缓存落在哪
 *   steamLibraries —— 直接指定 Steam 库目录（不给就自己探测）。
 *                     测试必须能指定：不然测一次要扫 26 个盘符。
 *   workshopApi    —— 创意工坊接口地址（默认官方的）。
 *                     可注入是为了**能拿本地假服务把整条链路真跑一遍** ——
 *                     上一轮 Epic 那次事故就是栽在"存/取两边的约定"上，
 *                     而那种缝只有跑真代码才测得出来。
 */
function createMods(opts = {}) {
  const dataDir = opts.dataDir || '';
  const log = opts.onLog || (() => {});
  const modsFile = dataDir ? path.join(dataDir, MODS_FILE) : '';
  const cacheFile = dataDir ? path.join(dataDir, CACHE_FILE) : '';
  const fixedLibs = Array.isArray(opts.steamLibraries) ? opts.steamLibraries : null;
  const workshopApi = opts.workshopApi || WORKSHOP_API;

  /** 创意工坊元数据缓存（内存层，避免一次会话里反复读盘） */
  let cache = null;

  /* ---------------- 用户手动添加的条目 ---------------- */

  function readModsFile() {
    if (!modsFile || !fs.existsSync(modsFile)) return { version: 1, manual: {} };
    try {
      const j = JSON.parse(fs.readFileSync(modsFile, 'utf8'));
      return { version: 1, manual: (j && j.manual) || {} };
    } catch (e) {
      log('MOD 记录读取失败：' + e.message);
      return { version: 1, manual: {} };
    }
  }

  function writeModsFile(data) {
    if (!modsFile) return;
    try {
      // 原子写：先写临时文件再改名，避免写一半崩了把记录弄坏
      const tmp = modsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, modsFile);
    } catch (e) {
      log('MOD 记录保存失败：' + e.message);
    }
  }

  function manualFor(gameId) {
    const d = readModsFile();
    return (d.manual && d.manual[gameId]) || [];
  }

  function setManual(gameId, list) {
    const d = readModsFile();
    if (!d.manual) d.manual = {};
    if (list && list.length) d.manual[gameId] = list;
    else delete d.manual[gameId];
    writeModsFile(d);
  }

  /* ---------------- 创意工坊元数据缓存 ---------------- */

  function readCache() {
    if (cache) return cache;
    cache = { version: 1, workshop: {} };
    if (cacheFile && fs.existsSync(cacheFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (j && j.workshop) cache = { version: 1, workshop: j.workshop };
      } catch { /* 缓存坏了当空的，重新拉就是了 */ }
    }
    return cache;
  }

  function writeCache() {
    if (!cacheFile || !cache) return;
    try {
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
      fs.renameSync(tmp, cacheFile);
    } catch { /* 缓存写不进去不影响功能，只是下次还得联网 */ }
  }

  /* ---------------- 发现：创意工坊 ---------------- */

  /**
   * 找出这款游戏所有 Steam 库里的创意工坊内容目录。
   * @returns {Promise<Array<{lib:string, dir:string, acf:string}>>}
   */
  async function findWorkshopRoots(appId) {
    if (!appId) return [];
    let libs = [];
    if (fixedLibs) {
      libs = fixedLibs;
    } else {
      try {
        libs = await scanner.findSteamLibraries(() => {});
      } catch (e) {
        log('查找 Steam 库失败：' + e.message);
        return [];
      }
    }
    const out = [];
    for (const lib of libs) {
      const dir = path.join(lib, 'steamapps', 'workshop', 'content', String(appId));
      if (await isDir(dir)) {
        out.push({
          lib,
          dir,
          acf: path.join(lib, 'steamapps', 'workshop', `appworkshop_${appId}.acf`)
        });
      }
    }
    return out;
  }

  /**
   * 把创意工坊内容目录扫成 MOD 列表。
   * 只做本地能做的事（目录、体积、更新时间），标题和标签留给 enrich。
   */
  async function scanWorkshop(root, acfMap) {
    const out = [];
    let items = [];
    try {
      items = await fsp.readdir(root.dir, { withFileTypes: true });
    } catch { return out; }

    for (const it of items) {
      if (!it.isDirectory()) continue;
      const rawName = it.name;
      if (isJunk(rawName)) continue;
      const disabled = isDisabledName(rawName);
      const wid = enabledName(rawName);
      if (!/^\d+$/.test(wid)) continue;     // 创意工坊目录名一定是纯数字 id

      const full = path.join(root.dir, rawName);
      const meta = acfMap.get(wid) || { size: 0, timeUpdated: 0 };
      out.push({
        id: 'ws:' + wid,
        kind: 'workshop',
        workshopId: wid,
        title: '',                          // 由 enrich 填
        path: full,
        dirName: rawName,
        baseName: wid,
        enabled: !disabled,
        tags: [],
        sizeBytes: meta.size,
        timeUpdated: meta.timeUpdated,
        previewUrl: '',
        source: 'Steam 创意工坊',
        removable: true
      });
      if (out.length >= MAX_MODS_PER_DIR) break;
    }
    return out;
  }

  /* ---------------- 发现：游戏自带 MOD 目录 ---------------- */

  /**
   * 扫安装目录下的常见 MOD 目录。
   * 每个 MOD 目录的**直接子项**（文件夹或文件）各算一个 MOD。
   */
  async function scanLocalDirs(installDir) {
    const out = [];
    if (!installDir) return out;

    for (const dirName of MOD_DIR_NAMES) {
      const dir = path.join(installDir, dirName);
      if (!(await isDir(dir))) continue;

      let items = [];
      try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }

      let n = 0;
      for (const it of items) {
        if (isJunk(it.name)) continue;
        if (n >= MAX_MODS_PER_DIR) break;
        n++;

        const disabled = isDisabledName(it.name);
        const full = path.join(dir, it.name);
        /* ⚠ 目录也要算体积。
         *   大部分 MOD 是**文件夹**（尤其整合包），只 stat 文件的话
         *   列表里会一片"没有大小"，用户根本没法判断哪个占地方。
         *   dirSize 是递归的，但对一个 MOD 目录来说规模可控（有深度上限）。 */
        let size = 0;
        try {
          if (it.isFile()) size = (await fsp.stat(full)).size;
          else if (it.isDirectory()) size = (await scanner.dirSize(full)).bytes;
        } catch { size = 0; }   // 没有权限之类的，算不出来就显示"未知"，不能因此丢掉这一条

        out.push({
          id: 'local:' + pathKey(full),
          kind: 'local',
          workshopId: '',
          title: displayName(it.name),
          path: full,
          dirName: it.name,
          baseName: enabledName(it.name),
          isFile: it.isFile(),
          enabled: !disabled,
          tags: [],
          sizeBytes: size,
          timeUpdated: 0,
          previewUrl: '',
          source: '游戏目录 · ' + dirName,
          // 说明它是从哪个 MOD 目录里发现的，界面上有用
          modDir: dirName,
          removable: true
        });
      }
    }
    return out;
  }

  /** 用户手动添加的条目 → MOD 形状（要重新核对磁盘上还在不在） */
  async function scanManual(gameId) {
    const out = [];
    for (const m of manualFor(gameId)) {
      if (!m || !m.path) continue;
      if (!(await exists(m.path))) continue;       // 已经被删掉的就不要再列出来
      const disabled = isDisabledName(path.basename(m.path));
      let isDirFlag = false;
      let size = Number(m.sizeBytes || 0);
      try {
        const st = await fsp.stat(m.path);
        isDirFlag = st.isDirectory();
        // 手动加的目录同样要算体积，不然它在列表里永远显示"没有大小"
        if (!size) size = isDirFlag ? (await scanner.dirSize(m.path)).bytes : st.size;
      } catch { /* 读不到就按 0 处理，条目本身还是要列出来 */ }
      out.push({
        id: 'manual:' + pathKey(m.path),
        kind: 'local',
        workshopId: '',
        title: m.name || displayName(path.basename(m.path)),
        path: m.path,
        dirName: path.basename(m.path),
        baseName: enabledName(path.basename(m.path)),
        isFile: !isDirFlag,
        enabled: !disabled,
        tags: [],
        sizeBytes: size,
        timeUpdated: 0,
        previewUrl: '',
        source: '手动添加',
        manual: true,
        removable: true
      });
    }
    return out;
  }

  /* ---------------- 补全工坊元数据 ---------------- */

  /**
   * 给创意工坊 MOD 补上标题 / 标签 / 预览图。
   *
   * 策略：**先用缓存**，只对缓存里没有或过期的 id 发请求。
   * 注意这个接口即使失败也不能影响"列出 MOD 列表" —— 名字退化成
   * "创意工坊项目 123456" 也比整个列表出不来强。
   *
   * @param {Array|null} wanted 只刷新这些 id（null = 全部缺失/过期的）
   */
  async function enrichWorkshop(mods, wanted = null, force = false) {
    const c = readCache();
    const need = [];
    const now = Date.now();
    const TTL = 7 * 24 * 3600 * 1000;      // 7 天。工坊条目的名字标签极少变

    for (const m of mods) {
      if (m.kind !== 'workshop') continue;
      const hit = c.workshop[m.workshopId];
      if (wanted && !wanted.includes(m.workshopId)) {
        // 没被要求刷新：有缓存就用缓存
        if (hit) applyMeta(m, hit);
        continue;
      }
      if (!force && hit && (now - (hit.fetchedAt || 0) < TTL)) { applyMeta(m, hit); continue; }
      need.push(m.workshopId);
    }

    let fetched = 0;
    let failed = '';
    if (need.length) {
      for (let i = 0; i < need.length; i += 50) {     // 一次别塞太多，分批
        const batch = need.slice(i, i + 50);
        try {
          const r = await postFormJson(workshopApi, workshopApiBody(batch), 20000);
          if (r.status !== 200 || !r.json) {
            failed = `Steam 创意工坊接口返回 HTTP ${r.status}`;
            continue;
          }
          const details = parseWorkshopDetails(r.json);
          for (const [id, meta] of details) {
            c.workshop[id] = { ...meta, fetchedAt: now };
            fetched++;
          }
        } catch (e) {
          failed = '连不上 Steam 创意工坊接口（' + (e.message || e) + '）';
        }
      }
      if (fetched) writeCache();
    }

    // 补一遍（包括刚拿到的）
    for (const m of mods) {
      if (m.kind !== 'workshop') continue;
      const hit = c.workshop[m.workshopId];
      if (hit) applyMeta(m, hit);
      if (!m.title) m.title = '创意工坊项目 ' + m.workshopId;   // 兜底，至少有名字
    }
    return { fetched, failed };
  }

  function applyMeta(m, meta) {
    if (meta.title) m.title = meta.title;
    if (Array.isArray(meta.tags) && meta.tags.length) m.tags = meta.tags.slice();
    if (meta.previewUrl) m.previewUrl = meta.previewUrl;
    if (!m.timeUpdated && meta.timeUpdated) m.timeUpdated = meta.timeUpdated;
    if (!m.sizeBytes && meta.fileSize) m.sizeBytes = meta.fileSize;
    if (meta.description) m.desc = meta.description;
    if (meta.subscriptions) m.subs = meta.subscriptions;
  }

  /* ---------------- 对外：列清单 ---------------- */

  /**
   * 列出某款游戏的全部 MOD。
   *
   * @param {object} game 库里的游戏对象（要 installDir / steamAppId / id）
   * @param {{online?:boolean, force?:boolean, sortBy?:string, asc?:boolean}} [o]
   * @returns {Promise<{ok:boolean, mods:Array, groups:Array, tags:Array,
   *                    sources:Array, counts:object, note:string}>}
   */
  async function list(game, o = {}) {
    if (!game) return { ok: false, error: '没有指定游戏' };
    const online = o.online !== false;
    const sortBy = o.sortBy || 'name';
    const asc = o.asc !== false;

    const sources = [];
    let mods = [];

    /* ① Steam 创意工坊 */
    const appId = String(game.steamAppId || '').trim();
    if (appId) {
      const roots = await findWorkshopRoots(appId);
      if (roots.length) {
        let total = 0;
        for (const root of roots) {
          let acfMap = new Map();
          try {
            const txt = await fsp.readFile(root.acf, 'utf8');
            acfMap = parseWorkshopAcf(txt);
          } catch { /* 没有 acf 也能列出目录，只是没有体积和更新时间 */ }
          const got = await scanWorkshop(root, acfMap);
          total += got.length;
          mods.push(...got);
        }
        sources.push({ kind: 'workshop', label: 'Steam 创意工坊', count: total, paths: roots.map((r) => r.dir) });
      } else {
        sources.push({
          kind: 'workshop', label: 'Steam 创意工坊', count: 0,
          paths: [], note: '这个 AppID 下还没有订阅任何创意工坊内容'
        });
      }
    }

    /* ② 游戏自带 MOD 目录 */
    const localDirs = await scanLocalDirs(game.installDir);
    if (localDirs.length) {
      mods.push(...localDirs);
      const names = [...new Set(localDirs.map((m) => m.modDir))];
      sources.push({ kind: 'local', label: '游戏 MOD 目录', count: localDirs.length, paths: names });
    }

    /* ③ 手动添加的 */
    const manual = await scanManual(game.id);
    if (manual.length) {
      mods.push(...manual);
      sources.push({ kind: 'manual', label: '手动添加', count: manual.length, paths: [] });
    }

    /* ④ 去掉重复：同一路径只留一条（比如刚好手动加的就在 mods 目录里） */
    const seen = new Map();
    for (const m of mods) {
      const key = normPath(m.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.set(key, m);
    }
    mods = [...seen.values()];

    /* ⑤ 补工坊元数据 */
    let note = '';
    if (online && mods.some((m) => m.kind === 'workshop')) {
      const r = await enrichWorkshop(mods, null, !!o.force);
      if (r.failed) note = r.failed + '，暂用本地记录里的信息';
    } else if (!online) {
      for (const m of mods) {
        if (m.kind === 'workshop') {
          const hit = readCache().workshop[m.workshopId];
          if (hit) applyMeta(m, hit);
          if (!m.title) m.title = '创意工坊项目 ' + m.workshopId;
        }
      }
    }

    const enabled = mods.filter((m) => m.enabled).length;
    const sorted = sortMods(mods, sortBy, asc);
    return {
      ok: true,
      mods: sorted,
      groups: groupByTag(mods, sortBy, asc),
      tags: collectTags(mods),
      // 标签筛选条要显示"每个标签多少个" —— 按成员关系统计，
      // 和 groups 的归属口径**故意不一样**（见 tagCounts 的注释）
      tagCounts: tagCounts(mods),
      sources,
      note,
      counts: {
        total: mods.length,
        enabled,
        disabled: mods.length - enabled,
        workshop: mods.filter((m) => m.kind === 'workshop').length,
        local: mods.filter((m) => m.kind !== 'workshop').length
      }
    };
  }

  /* ---------------- 对外：启用 / 禁用 ---------------- */

  /**
   * 启用或禁用一个 MOD —— 靠改名字实现。
   *
   * 为什么不用"删掉配置文件"或者"移走"：
   *   改名是**可逆、可见、不丢数据**的。用户在资源管理器里就能看出
   *   哪些是被禁用的，也不需要 GameHub 在场就能自己改回来。
   *
   * ⚠ 创意工坊的条目被改名之后，Steam 会认为这份内容"不完整"，
   *   下次校验/更新时可能重新下载一份。这是这套做法的已知代价，
   *   界面上有提示，不能瞒着用户。
   *
   * @param {{path:string, enabled:boolean, dirName:string}} mod
   * @param {boolean} enabled 目标状态
   */
  async function setEnabled(mod, enabled) {
    const p = normPath(mod && mod.path);
    if (!p) return { ok: false, error: '没有指定 MOD 路径' };
    if (!(await exists(p))) return { ok: false, error: '这个 MOD 已经不在磁盘上了，刷新一下列表' };

    const base = path.basename(p);
    const wantDisabled = !enabled;
    const nowDisabled = isDisabledName(base);
    if (wantDisabled === nowDisabled) {
      return { ok: true, unchanged: true, path: p, enabled: !!enabled };
    }

    const target = path.join(path.dirname(p), wantDisabled ? disabledName(base) : enabledName(base));
    if (await exists(target)) {
      return { ok: false, error: `改不动：已经存在同名的「${path.basename(target)}」，请手动处理` };
    }
    try {
      await fsp.rename(p, target);
    } catch (e) {
      // 最常见的原因是游戏/Mod 加载器正开着，文件被占用
      return { ok: false, error: '改名失败（文件可能正被游戏占用）：' + (e.message || e) };
    }
    log(`MOD ${enabled ? '启用' : '禁用'}：${path.basename(target)}`);
    return { ok: true, path: target, enabled: !!enabled };
  }

  /* ---------------- 对外：删除（进回收站） ---------------- */

  /**
   * 删除一个 MOD —— **移进回收站，不是真删除**。
   *
   * 这是刻意的：MOD 是用户攒出来的东西，误删一个整合包可能意味着
   * 几十小时的重装。回收站里的东西还能捞回来，真删就没了。
   * 调用方（主进程）负责先把完整路径确认给用户看，这个函数只管执行。
   */
  async function remove(mod) {
    const p = normPath(mod && mod.path);
    if (!p) return { ok: false, error: '没有指定 MOD 路径' };
    if (!(await exists(p))) {
      // 磁盘上已经没有了 —— 当成"删过了"，顺手清掉手动记录
      return { ok: true, alreadyGone: true, path: p };
    }

    // 安全底线：绝不允许删到盘符根、Steam 库根、steamapps 这类关键目录。
    // 万一上层传错了 path，这里是最后一道闸。
    const lower = p.toLowerCase();
    const base = path.basename(p).toLowerCase();
    if (!base || /^[a-z]:$/.test(lower) || base === 'steamapps' || base === 'common'
        || lower.endsWith('\\steamapps\\workshop') || lower.endsWith('/steamapps/workshop')) {
      return { ok: false, error: '拒绝对这个路径执行删除（它像是关键目录，不是单个 MOD）' };
    }

    let electron;
    try { electron = require('electron'); } catch { electron = null; }
    if (!electron || !electron.shell || !electron.shell.trashItem) {
      return { ok: false, error: '当前环境无法移入回收站（只在桌面端可用）' };
    }
    try {
      await electron.shell.trashItem(p);
    } catch (e) {
      /* ⚠ 这里不能用"抛错 = 失败"来判断。实测（tools/trash-probe.js）：
       *   本机 trashItem 抛「Operation was aborted」，可原路径已经没了、
       *   回收站里也躺着那个文件夹（$I 元数据指回原路径）。
       *   也就是说这只是一次**假失败回调** —— 操作其实成功了。
       *
       *   要是不管三七二十一就报错，主人点了删除、东西明明进了回收站，
       *   界面却弹一句"失败"，他会以为没删掉、跑去资源管理器手动删，
       *   或者在游戏里以为 MOD 还在。所以真正的判据是**磁盘**，不是这个 promise。 */
      if (!(await exists(p))) {
        log('MOD 已移入回收站（系统回调误报中断，但文件确实已挪走）：' + p);
        return { ok: true, path: p, trashed: true, callbackAborted: true };
      }
      return { ok: false, error: '移入回收站失败（文件可能正被占用）：' + (e.message || e) };
    }
    log('MOD 已移入回收站：' + p);
    return { ok: true, path: p, trashed: true };
  }

  /* ---------------- 对外：手动添加 / 移除 ---------------- */

  /**
   * 手动添加一个 MOD（选中的文件夹或文件）。
   * 非 Steam 游戏主要靠这条路把 MOD 纳进来。
   */
  async function addManual(gameId, targetPath) {
    const p = normPath(targetPath);
    if (!gameId || !p) return { ok: false, error: '缺少参数' };
    if (!(await exists(p))) return { ok: false, error: '这个路径不存在' };

    const list0 = manualFor(gameId);
    const key = p.toLowerCase();
    if (list0.some((m) => normPath(m.path).toLowerCase() === key)) {
      return { ok: false, error: '这个 MOD 已经在列表里了' };
    }

    let isDirFlag = false;
    try { isDirFlag = (await fsp.stat(p)).isDirectory(); } catch { /* 忽略 */ }

    list0.push({
      name: displayName(path.basename(p)),
      path: p,
      isDir: isDirFlag,
      addedAt: Date.now()
    });
    setManual(gameId, list0);
    log('手动添加 MOD：' + p);
    return { ok: true, path: p, name: displayName(path.basename(p)) };
  }

  /** 从手动记录里摘掉（不碰磁盘文件 —— 用户只是不想让它出现在 GameHub 里） */
  function forgetManual(gameId, modPath) {
    const key = normPath(modPath).toLowerCase();
    const list0 = manualFor(gameId).filter((m) => normPath(m.path).toLowerCase() !== key);
    setManual(gameId, list0);
    return { ok: true };
  }

  /** 手动记录里这个路径存在吗（决定删除时要不要顺带清记录） */
  function isManual(gameId, modPath) {
    const key = normPath(modPath).toLowerCase();
    return manualFor(gameId).some((m) => normPath(m.path).toLowerCase() === key);
  }

  return {
    list,
    setEnabled,
    remove,
    addManual,
    forgetManual,
    isManual,
    /** 给单元测试 / 自检用的内部件 */
    _internals: {
      normPath, pathKey, isDisabledName, disabledName, enabledName, displayName, isJunk,
      parseWorkshopAcf, workshopApiBody, parseWorkshopDetails,
      groupByTag, collectTags, sortMods, tagCounts, modsWithTag, groupKeyOf, isPseudoGroup,
      steamWorkshopWebUrl, steamWorkshopClientUrl, nexusSearchUrl,
      DISABLED_SUFFIX, MOD_DIR_NAMES, PSEUDO_GROUPS, UNTAGGED_LOCAL, UNTAGGED_WORKSHOP
    }
  };
}

module.exports = {
  createMods,
  /* 纯函数直接导出，测试和截图脚本都不用再造一个实例 */
  normPath, pathKey, isDisabledName, disabledName, enabledName, displayName, isJunk,
  parseWorkshopAcf, workshopApiBody, parseWorkshopDetails,
  groupByTag, collectTags, sortMods, tagCounts, modsWithTag, groupKeyOf, isPseudoGroup,
  steamWorkshopWebUrl, steamWorkshopClientUrl, nexusSearchUrl,
  postFormViaElectronNet, postFormJson,
  DISABLED_SUFFIX, MOD_DIR_NAMES, PSEUDO_GROUPS, UNTAGGED_LOCAL, UNTAGGED_WORKSHOP, WORKSHOP_API
};
