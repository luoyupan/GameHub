/**
 * ============================================================
 *  GameHub - ZIP 解压（纯 Node，无第三方依赖）
 *  (src/main/unzip.js)
 * ------------------------------------------------------------
 *  为什么自己写而不是装个 unzipper：
 *    打包成单文件 exe 时多一个依赖就多一点体积和一层不确定性，
 *    而 MOD 压缩包 99% 是 zip，格式很固定（store 或 deflate），
 *    用 Node 自带的 zlib 就能解，没必要引库。
 *
 *  边界先说清楚：
 *    ✅ 支持：zip（store / deflate）、中文文件名（UTF-8 与 GBK 两种）、
 *             目录结构还原、超过 4GB 的 ZIP64 读头
 *    ❌ 不支持：加密的 zip、7z / rar / 分卷包 —— 这些会明确报错让界面提示手动解压
 *
 *  ⚠ 安全：拒绝解压到目标目录之外（防 Zip Slip 路径穿越）。
 * ============================================================
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

/** 局部文件头签名 */
const SIG_LOCAL = 0x04034b50;
/** 中央目录签名 */
const SIG_CENTRAL = 0x02014b50;
/** 数字签名（附加在数据末尾，遇到就停止） */
const SIG_DIGITAL = 0x05054b50;

/**
 * 列出 zip 里的条目（不解压）。
 * @param {string} zipPath
 * @returns {Promise<Array<{name:string, size:number, compressed:boolean, isDir:boolean}>>}
 */
async function listZip(zipPath) {
  const buf = await fsp.readFile(zipPath);
  return listZipFromBuffer(buf);
}

/** 从已读进内存的 buffer 列出条目 */
function listZipFromBuffer(buf) {
  const out = [];
  let pos = 0;

  // 顺序扫局部文件头 —— 比从尾部找中央目录更稳（有些包尾部被追加过东西）
  while (pos + 30 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig === SIG_CENTRAL || sig === SIG_DIGITAL) break;   // 到中央目录就结束
    if (sig !== SIG_LOCAL) { pos++; continue; }

    const method = buf.readUInt16LE(pos + 8);
    const flags = buf.readUInt16LE(pos + 6);
    let compSize = buf.readUInt32LE(pos + 18);
    let uncompSize = buf.readUInt32LE(pos + 22);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);

    const nameRaw = buf.subarray(pos + 30, pos + 30 + nameLen);
    const name = decodeName(nameRaw, flags);

    // ZIP64：大小为 0xFFFFFFFF 时真值在 extra 字段里
    const extra = buf.subarray(pos + 30 + nameLen, pos + 30 + nameLen + extraLen);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      const z = readZip64Extra(extra);
      if (z.uncompSize != null) uncompSize = z.uncompSize;
      if (z.compSize != null) compSize = z.compSize;
    }

    const dataStart = pos + 30 + nameLen + extraLen;
    if (dataStart + compSize > buf.length) break;   // 文件被截断，别再往下读

    out.push({
      name,
      size: uncompSize,
      compSize,
      method,
      isDir: /\/$/.test(name) || (uncompSize === 0 && /\/$/.test(name)),
      dataStart,
      encrypted: (flags & 0x1) !== 0
    });

    pos = dataStart + compSize;
  }

  return out;
}

/**
 * 把 zip 解压到目标目录。
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @param {object} [opts]
 * @param {(done:number, total:number)=>void} [opts.onProgress]
 * @param {boolean} [opts.flatten]  true = 忽略压缩包内的目录结构，全部平铺到 destDir
 * @returns {Promise<{ok:boolean, files?:string[], error?:string, skipped?:string[]}>}
 */
async function extractZip(zipPath, destDir, opts = {}) {
  const buf = await fsp.readFile(zipPath);
  const entries = listZipFromBuffer(buf);

  if (!entries.length) return { ok: false, error: '压缩包是空的，或者不是标准的 zip' };

  const encrypted = entries.filter((e) => e.encrypted);
  if (encrypted.length) {
    return { ok: false, error: '这个 zip 加了密，GameHub 解不了，请手动解压' };
  }
  const weird = entries.filter((e) => e.method !== 0 && e.method !== 8);
  if (weird.length) {
    return { ok: false, error: `压缩包用了不支持的压缩方式（${weird[0].method}），请手动解压` };
  }

  await fsp.mkdir(destDir, { recursive: true });

  const written = [];
  const skipped = [];
  let done = 0;

  for (const e of entries) {
    done++;
    if (opts.onProgress) opts.onProgress(done, entries.length);

    // 目录条目：建出来就行
    if (e.isDir) {
      const d = safeJoin(destDir, e.name, opts.flatten);
      if (d) await fsp.mkdir(d, { recursive: true }).catch(() => {});
      continue;
    }

    const target = safeJoin(destDir, e.name, opts.flatten);
    if (!target) { skipped.push(e.name); continue; }   // 路径穿越，拒绝

    await fsp.mkdir(path.dirname(target), { recursive: true });

    const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
    let data;
    try {
      data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 256 * 1024 * 1024 });
    } catch (err) {
      skipped.push(e.name + '（解压失败：' + err.message + '）');
      continue;
    }

    await fsp.writeFile(target, data);
    written.push(target);
  }

  return { ok: true, files: written, skipped };
}

/* ==================================================================
 *  内部工具
 * ================================================================== */

/**
 * 文件名解码。
 * zip 里的名字可能是 UTF-8（flags 第 11 位为 1）也可能是 GBK（老压缩软件常见）。
 * 中文 MOD 包用 GBK 的非常多，这里两种都试。
 */
function decodeName(raw, flags) {
  // 第 11 位（0x800）标明是 UTF-8
  if (flags & 0x800) return raw.toString('utf8');

  const utf8 = raw.toString('utf8');
  // 全是 ASCII 就直接返回，不用纠结
  if (!/[\x80-\xff]/.test(raw)) return utf8;

  // 试着按 GBK 解 —— Node 自带 iconv 之外没有 GBK，这里用一个小表兜不住，
  // 所以退而求其次：用 latin1 解出来的字节再交给调用方是不可靠的，
  // 实际做法是判断 UTF-8 是否合法，不合法就按 GBK 用内置的 TextDecoder 解
  try {
    // 严格校验：含非法序列说明不是 UTF-8
    const dec = new TextDecoder('utf-8', { fatal: true });
    return dec.decode(raw);
  } catch (_) {
    try {
      // Node 内置 TextDecoder 支持 gb18030（含 GBK）
      return new TextDecoder('gb18030').decode(raw);
    } catch (__) {
      return utf8;
    }
  }
}

/** 从 extra 字段里读 ZIP64 扩展信息 */
function readZip64Extra(extra) {
  let p = 0;
  const out = { uncompSize: null, compSize: null };
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + size);
    if (id === 0x0001) {
      if (body.length >= 8) out.uncompSize = Number(body.readBigUInt64LE(0));
      if (body.length >= 16) out.compSize = Number(body.readBigUInt64LE(8));
      return out;
    }
    p += 4 + size;
  }
  return out;
}

/**
 * 把压缩包内的相对路径安全拼到目标目录下。
 * ⚠ 防 Zip Slip：拒绝 ../ 和绝对路径。
 * @returns {string|null} 不安全返回 null
 */
function safeJoin(destDir, name, flatten) {
  let rel = String(name || '').replace(/\\/g, '/');
  // 绝对路径（含盘符）直接拒
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null;

  if (flatten) rel = path.basename(rel);

  const parts = rel.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;      // 往上跳的一律拒绝

  const full = path.resolve(destDir, ...parts);
  const root = path.resolve(destDir);
  // 再兜一层：解析后必须仍在目标目录内
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** 判断一个文件是不是 zip（看开头两个字节 PK） */
async function isZipFile(p) {
  try {
    const fd = await fsp.open(p, 'r');
    const b = Buffer.alloc(2);
    await fd.read(b, 0, 2, 0);
    await fd.close();
    return b[0] === 0x50 && b[1] === 0x4b;
  } catch {
    return false;
  }
}

module.exports = {
  extractZip,
  listZip,
  listZipFromBuffer,
  isZipFile,
  safeJoin,
  decodeName
};
