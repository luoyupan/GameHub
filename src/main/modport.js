/**
 * ============================================================
 *  GameHub - MOD 快速导入与对齐工具  (main/modport.js)
 * ------------------------------------------------------------
 *  主人点的三个功能：
 *   ① 快速导入：把下载好的 mod（zip 压缩包 / 文件夹）拖进对话框就进游戏
 *   ② 快速打包：把这款游戏的 mod 打包成一个 zip，方便备份 / 发给别人
 *   ③ MOD 码：按 mod 名称+数量生成一个短码，别人导入码一对比，
 *      立刻知道自己多了哪些、缺了哪些 mod
 *
 *  这个文件只放**纯逻辑**（不碰 Electron、不碰对话框），全部可单测 ——
 *  真正动文件系统 / 弹窗的部分在 main.js 的 IPC 里。
 * ============================================================
 */
'use strict';

const zlib = require('zlib');

/* ================================================================
 *  ① 快速导入：拖进来的东西怎么处理
 * ================================================================ */

/** Windows 文件名里的非法字符（mod 名来自压缩包内目录名，什么怪字符都可能有） */
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 目标目录里已有同名条目时加后缀 (2) (3)…，绝不静默覆盖 */
function uniqueName(name, existing) {
  const taken = new Set((existing || []).map((s) => String(s).toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const m = name.match(/^(.*?)(\.[^.]+)$/);      // 带扩展名的文件：后缀插在扩展名前
  const base = m ? m[1] : name;
  const ext = m ? m[2] : '';
  let n = 2;
  while (taken.has(`${base} (${n})${ext}`.toLowerCase())) n++;
  return `${base} (${n})${ext}`;
}

/**
 * 规划一个拖入项怎么处理（纯逻辑，不碰磁盘）。
 * @param {{name:string, kind:'dir'|'zip'|'file'}} item kind 由 IPC 层用 fs.stat 判定
 * @returns {{action:'unzip'|'copy'|'skip', targetName:string, reason?:string}}
 *   unzip = 解压后取内容；copy = 原样搬进 mod 目录；skip = 不支持，带原因
 */
function planDrop(item) {
  const raw = String(item.name || '');
  const lower = raw.toLowerCase();
  const base = sanitizeName(raw.replace(/\.(zip|7z|rar)$/i, '')) || '未命名 MOD';

  if (item.kind === 'dir') return { action: 'copy', targetName: base };
  if (lower.endsWith('.zip')) return { action: 'unzip', targetName: base };
  if (lower.endsWith('.7z') || lower.endsWith('.rar')) {
    return { action: 'skip', targetName: base, reason: '暂只支持 zip 压缩包和文件夹（7z / RAR 需要额外解压器，以后再说）' };
  }
  // 其它文件：单文件 mod（.pak / .esm / .dll 之类）原样搬
  if (item.kind === 'file') return { action: 'copy', targetName: sanitizeName(raw) || '未命名' };
  return { action: 'skip', targetName: base, reason: '不认识的条目类型' };
}

/**
 * 批量规划 + 名字冲突处理（后面的项会看到前面占用的名字）。
 * @returns {Array<{item, action, targetName, reason?}>}
 */
function planDropAll(items, existingNames) {
  const used = new Set((existingNames || []).map((s) => String(s).toLowerCase()));
  return (items || []).map((it) => {
    const plan = planDrop(it);
    if (plan.action !== 'skip') {
      plan.targetName = uniqueName(plan.targetName, [...used]);
      used.add(plan.targetName.toLowerCase());
    }
    return { item: it, ...plan };
  });
}

/* ================================================================
 *  ③ MOD 码：mod 名称列表 ⇄ 一个可发微信的短码
 * ================================================================
 *  格式：GHMOD1-<数量>-<crc8hex>-<base64url(deflateRaw(JSON {n:[名称]}))>
 *  - 数量直接写进码里，肉眼看就知道对面装了几个
 *  - crc 防复制时少粘贴了几个字符 —— 传输出错直接报"码不完整"而不是乱对比
 *  - deflate + base64url 让它短一些（mod 名常带大量重复前缀，压得动）
 * ================================================================ */

const CODE_PREFIX = 'GHMOD1';

/** 由 mod 名称列表生成 MOD 码（名称去空白、去空、去重、排序，保证同一个 mod 集永远生成同一个码） */
function buildModCode(names) {
  const clean = cleanNames(names);
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({ n: clean }), 'utf8'));
  const crc = require('./zipwrite').crc32(payload);
  return `${CODE_PREFIX}-${clean.length}-${crc.toString(16).padStart(8, '0')}-${payload.toString('base64url')}`;
}

/** 解析 MOD 码；任何不合法（格式 / CRC / 解压 / JSON）都返回 null，不抛异常 */
function parseModCode(code) {
  try {
    const s = String(code || '').trim();
    const m = s.match(new RegExp(`^${CODE_PREFIX}-(\\d+)-([0-9a-f]{8})-([A-Za-z0-9_-]+)$`));
    if (!m) return null;
    const count = Number(m[1]);
    const payload = Buffer.from(m[3], 'base64url');
    if (require('./zipwrite').crc32(payload) !== parseInt(m[2], 16)) return null;
    const json = JSON.parse(zlib.inflateRawSync(payload).toString('utf8'));
    const names = cleanNames(json && json.n);
    if (names.length !== count) return null;   // 数量字段与内容不符也视为坏码
    return { count, names };
  } catch {
    return null;
  }
}

/**
 * 对比：MOD 码 vs 本地实际装了的。
 * @returns {{missing:string[], extra:string[], same:string[]}}
 *   missing = 码里有、本地没有（缺）；extra = 本地有、码里没有（多）
 */
function diffModCode(code, localNames) {
  const parsed = parseModCode(code);
  if (!parsed) return null;
  const remote = new Set(parsed.names.map(normKey));
  const local = cleanNames(localNames);
  const localKeys = new Map(local.map((n) => [normKey(n), n]));
  const missing = [];
  const extra = [];
  const same = [];
  for (const n of parsed.names) {
    if (localKeys.has(normKey(n))) same.push(n); else missing.push(n);
  }
  for (const n of local) {
    if (!remote.has(normKey(n))) extra.push(n);
  }
  return { missing, extra, same, total: parsed.count };
}

/* ---------------- 公共小件 ---------------- */

function cleanNames(names) {
  const seen = new Set();
  const out = [];
  for (const n of (Array.isArray(names) ? names : [])) {
    const s = String(n || '').trim();
    if (!s) continue;
    const k = normKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  /* ⚠ 必须用码点序（sort 默认），不能用 localeCompare ——
     locale 的排序规则跟机器 ICU 走，同一份 mod 清单在两台机器上
     可能排出不同顺序 → 生成的 MOD 码不一样 → 对不上。 */
  return out.sort();
}

/** 对比用的键：去空白、忽略大小写、全角括号归一（"模拟人生 (1)" vs "模拟人生(1)" 算同一个） */
function normKey(s) {
  return String(s).trim().toLowerCase().replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, ' ');
}

module.exports = {
  sanitizeName,
  uniqueName,
  planDrop,
  planDropAll,
  buildModCode,
  parseModCode,
  diffModCode
};
