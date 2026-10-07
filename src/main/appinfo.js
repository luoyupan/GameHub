/**
 * ============================================================
 *  GameHub - Steam appinfo.vdf 解析  (src/main/appinfo.js)
 * ------------------------------------------------------------
 *  作用：读 Steam 客户端自己的"应用信息缓存"，给游戏名兜底。
 *
 *  为什么需要它：
 *    本地能拿到"没安装的游戏"名字的地方有三处，可靠程度差很多 ——
 *      ① appinfo.vdf      ★ 客户端缓存的官方名字，最准（本模块负责）
 *      ② appmanifest.acf  只有"已安装"的游戏才有
 *      ③ 成就 schema      内部代号混在里面（比如 260 号叫 ValveTestApp260，其实是 CS2）
 *    用户库里 249 个游戏有 103 个只能落到 ③，名字是错的或干脆没有，
 *    所以必须把 ① 解析出来当第一优先。
 *
 *  ⚠ 只读不写：本模块全程只 fs.readFileSync，不碰 Steam 的任何文件。
 *
 * ── 文件格式（本机实测 v29，magic = 0x07564429）──
 *   文件头 16 字节：
 *     +0  uint32 magic    固定 0x07564429
 *     +4  uint32 universe
 *     +8  uint64 字符串表在整个文件里的偏移
 *   字符串表：uint32 条目数，然后一堆 \0 结尾的 UTF-8 串（键名都从这里取）
 *
 *   之后是记录流，每条记录：
 *     +0   uint32 appid
 *     +4   uint32 size   ← 坑点！它是"本字段之后还剩多少字节"，
 *                          不含 appid + size 这 8 个字节。
 *                          所以 下一条 = 当前 + 8 + size，
 *                          数据区长度 = size - 65（65 = 73 头 - 8）。
 *     +8   uint32 infostate
 *     +12  uint32 last_updated
 *     +16  uint64 pics_token
 *     +24  uint8[20] sha1
 *     +44  uint32 change_number
 *     +48  uint8[20] sha1（第二个，新版才有）
 *     +68  uint32 change_number（第二个）
 *     +72  uint8  固定 0x00
 *     +73  数据区（长度 size - 65）
 *
 *   数据区是二进制 KeyValues，但跟别处不一样：
 *     · 键名   —— 字符串表的 uint32 下标（不是内联字符串）
 *     · 值     —— 内联的（字符串以 \0 结尾，数字定长）
 *     0x00 嵌套对象 → uint32 键名下标
 *     0x01 字符串   → uint32 键名下标 + \0 结尾的内联串
 *     0x02 int32 / 0x03 float32 / 0x04 ptr / 0x07 uint64 / 0x0A int64
 *     0x08 对象结束
 * ============================================================
 */

const fs = require('fs');

/** 记录头长度：从记录起点到数据区 */
const HEAD_SIZE = 73;
/** 数据区长度 = size - 这个值 */
const DATA_ADJUST = 65;
/** 文件头（magic + universe + 字符串表偏移） */
const FILE_HEADER = 16;
/** 记录流起点 */
const RECORD_START = 16;

/* ==================================================================
 *  一、字符串表
 * ================================================================== */

/**
 * 读出文件尾部的字符串表。
 * @param {Buffer} buf
 * @param {number} offset 字符串表偏移
 * @returns {string[]}
 */
function readStringTable(buf, offset) {
  const out = [];
  if (offset <= 0 || offset + 4 > buf.length) return out;

  const count = buf.readUInt32LE(offset);
  let p = offset + 4;
  for (let i = 0; i < count && p < buf.length; i++) {
    const end = buf.indexOf(0, p);
    if (end < 0) break;
    out.push(buf.toString('utf8', p, end));
    p = end + 1;
  }
  return out;
}

/* ==================================================================
 *  二、二进制 KeyValues（键＝下标 / 值＝内联）
 * ================================================================== */

/**
 * 解析一段数据区。
 * @param {Buffer} buf      整个文件
 * @param {string[]} strings 字符串表
 * @param {number} start    数据区起点
 * @param {number} size     数据区长度
 * @param {number} [maxNodes] 防死循环的保险丝
 * @returns {object}
 */
function parseKV(buf, strings, start, size, maxNodes = 200000) {
  let pos = start;
  const end = start + size;
  let guard = 0;

  /** 读一个以 \0 结尾的内联字符串 */
  function readStr() {
    const e = buf.indexOf(0, pos);
    if (e < 0 || e >= end) { pos = end; return ''; }
    const s = buf.toString('utf8', pos, e);
    pos = e + 1;
    return s;
  }

  function obj() {
    const o = {};
    while (pos < end) {
      if (++guard > maxNodes) return o;           // 保险丝：异常数据不至于卡死
      const t = buf[pos++];
      if (t === 0x08) return o;                    // 0x08 = 对象结束

      const ki = buf.readUInt32LE(pos); pos += 4;
      const key = strings[ki] !== undefined ? strings[ki] : '#' + ki;

      if (t === 0x00) { o[key] = obj(); continue; }

      switch (t) {
        case 0x01: o[key] = readStr(); break;                                  // 字符串
        case 0x02: o[key] = buf.readInt32LE(pos); pos += 4; break;             // int32
        case 0x03: o[key] = buf.readFloatLE(pos); pos += 4; break;             // float32
        case 0x04: o[key] = buf.readUInt32LE(pos); pos += 4; break;            // ptr
        case 0x07: o[key] = Number(buf.readBigUInt64LE(pos)); pos += 8; break; // uint64
        case 0x0A: o[key] = Number(buf.readBigInt64LE(pos)); pos += 8; break;  // int64
        default: pos = end; return o;                                          // 不认识的类型：安全退出
      }
    }
    return o;
  }

  return obj();
}

/* ==================================================================
 *  三、整表解析
 * ================================================================== */

/**
 * 解析 appinfo.vdf，抽出每个 appid 的常用字段。
 *
 * @param {string} file appinfo.vdf 的完整路径
 * @param {{want?:Set<string>}} [opts]
 *        want —— 只保留这些 appid（传了能少建很多对象，快一点）
 * @returns {Map<string, {appId:string,name:string,type:string,icon:string,
 *                        clientIcon:string,logo:string,developer:string,
 *                        publisher:string}>}
 */
function parseAppInfo(file, opts = {}) {
  const out = new Map();
  let buf;
  try { buf = fs.readFileSync(file); } catch { return out; }

  // magic 不对（老格式 / 坏文件）就直接放弃，宁可没名字也不要错名字
  if (buf.length < FILE_HEADER + 16 || buf.readUInt32LE(0) !== 0x07564429) return out;

  const strOff = Number(buf.readBigUInt64LE(8));
  const strings = readStringTable(buf, strOff);
  const want = opts.want || null;

  let pos = RECORD_START;
  let guard = 0;
  while (pos + HEAD_SIZE <= strOff && ++guard < 500000) {
    const appId = buf.readUInt32LE(pos);
    const size = buf.readUInt32LE(pos + 4);
    const step = 8 + size;

    // 明显不对就停：size 太小不会是正常记录，appid 越界说明已经跑飞了
    if (size < DATA_ADJUST || appId === 0 || appId > 500000000) break;
    if (pos + step > buf.length) break;

    const id = String(appId);
    if (!want || want.has(id)) {
      let kv = null;
      try { kv = parseKV(buf, strings, pos + HEAD_SIZE, size - DATA_ADJUST); } catch { kv = null; }
      if (kv) {
        // 有的版本外面还包一层 "appinfo"，两种都兼容一下
        const common = kv.common || (kv.appinfo && kv.appinfo.common) || {};
        const assoc = common.associations || {};
        out.set(id, {
          appId: id,
          name: typeof common.name === 'string' ? common.name : '',
          type: typeof common.type === 'string' ? common.type : '',
          icon: typeof common.icon === 'string' ? common.icon : '',
          clientIcon: typeof common.clienticon === 'string' ? common.clienticon : '',
          logo: typeof common.logo === 'string' ? common.logo : '',
          developer: typeof assoc.developer === 'string' ? assoc.developer : '',
          publisher: typeof assoc.publisher === 'string' ? assoc.publisher : ''
        });
      }
    }

    pos += step;
  }
  return out;
}

/** 只要名字：给合并逻辑用的快捷方法 */
function nameMap(file, want) {
  const all = parseAppInfo(file, want ? { want } : undefined);
  const out = new Map();
  for (const [id, v] of all) if (v.name) out.set(id, v.name);
  return out;
}

module.exports = {
  parseAppInfo,
  nameMap,
  readStringTable,
  parseKV,
  HEAD_SIZE,
  DATA_ADJUST
};
