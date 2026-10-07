/**
 * ============================================================
 *  GameHub - 二进制 KeyValues (Binary VDF) 解析器
 *  (src/main/vdfbin.js)
 * ------------------------------------------------------------
 *  Valve 在很多地方用"二进制版"的 KeyValues 存缓存，例如：
 *    <Steam>/appcache/stats/UserGameStats_<账号>_<appid>.bin   成就解锁位图
 *    <Steam>/appcache/stats/UserGameStatsSchema_<appid>.bin    成就定义（名字/总数）
 *
 *  格式说明（每个字段 = 1 字节类型 + 以 \0 结尾的键名 + 值）：
 *    0x00 嵌套对象（读到 0x08 结束）
 *    0x01 字符串（\0 结尾）
 *    0x02 int32
 *    0x03 float32
 *    0x04 指针 / uint32
 *    0x05 宽字符串（UTF-16LE，双 \0 结尾）
 *    0x06 颜色（4 字节）
 *    0x07 uint64
 *    0x08 对象结束
 *    0x0A int64
 *
 *  ⚠ 这是**只读**解析器：只认识格式、不写回。任何不认识的类型都安全停下，
 *    宁可少解析一点，也不能把内存读崩。
 * ============================================================
 */

/** 类型常量 */
const T = {
  NONE: 0x00,
  STRING: 0x01,
  INT32: 0x02,
  FLOAT32: 0x03,
  PTR: 0x04,
  WSTRING: 0x05,
  COLOR: 0x06,
  UINT64: 0x07,
  END: 0x08,
  INT64: 0x0a
};

/**
 * 解析二进制 KeyValues。
 * @param {Buffer} buf
 * @param {{maxDepth?:number}} [opts] maxDepth 防御畸形文件导致的深递归
 * @returns {object} 解析出来的普通对象
 */
function parseBinaryKV(buf, opts = {}) {
  const maxDepth = opts.maxDepth || 32;
  let pos = 0;

  /** 读一个 \0 结尾的字符串 */
  function readString() {
    const end = buf.indexOf(0, pos);
    if (end < 0) { pos = buf.length; return ''; }
    const s = buf.toString('utf8', pos, end);
    pos = end + 1;
    return s;
  }

  /** 读一个 UTF-16LE 宽字符串（以 0x0000 结尾） */
  function readWString() {
    let s = '';
    while (pos + 1 < buf.length) {
      const c = buf.readUInt16LE(pos);
      pos += 2;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readObject(depth) {
    const out = {};
    if (depth > maxDepth) return out;

    while (pos < buf.length) {
      const type = buf[pos++];

      // 对象结束
      if (type === T.END) return out;

      const key = readString();

      switch (type) {
        case T.NONE:
          out[key] = readObject(depth + 1);
          break;
        case T.STRING:
          out[key] = readString();
          break;
        case T.INT32:
          if (pos + 4 > buf.length) return out;
          out[key] = buf.readInt32LE(pos);
          pos += 4;
          break;
        case T.FLOAT32:
          if (pos + 4 > buf.length) return out;
          out[key] = buf.readFloatLE(pos);
          pos += 4;
          break;
        case T.PTR:
        case T.COLOR:
          if (pos + 4 > buf.length) return out;
          out[key] = buf.readUInt32LE(pos);
          pos += 4;
          break;
        case T.WSTRING:
          out[key] = readWString();
          break;
        case T.UINT64:
          if (pos + 8 > buf.length) return out;
          out[key] = Number(buf.readBigUInt64LE(pos));
          pos += 8;
          break;
        case T.INT64:
          if (pos + 8 > buf.length) return out;
          out[key] = Number(buf.readBigInt64LE(pos));
          pos += 8;
          break;
        default:
          // 不认识/越界 —— 直接收工，绝不硬读
          return out;
      }
    }
    return out;
  }

  try {
    return readObject(0);
  } catch {
    return {};
  }
}

/**
 * 从 Steam 的"成就位图缓存"里数出已解锁数量。
 *
 * Steam 的存法是：把成就按 32 个一组打包成位图，
 *   UserGameStats_<账号>_<appid>.bin → cache.<组号>.data = int32 位掩码
 *   UserGameStatsSchema_<appid>.bin  → <appid>.stats.<组号>.bits = { 位号: 成就API名 }
 * 第 N 位为 1 就代表该成就已解锁。
 *
 * @param {object} schema 解析后的 schema 对象（已去掉最外层 appid 键）
 * @param {object} user   解析后的用户缓存对象（cache 那一层）
 * @returns {{unlocked:number, total:number, hasAchievements:boolean}}
 */
function countAchievements(schema, user) {
  const res = { unlocked: 0, total: 0, hasAchievements: false };
  if (!schema || !schema.stats) return res;

  const cache = (user && user.cache) || user || {};

  for (const [groupId, group] of Object.entries(schema.stats)) {
    const bits = (group && group.bits) || {};
    const n = Object.keys(bits).length;
    if (!n) continue;                       // 这一组不是成就（普通统计项没有 bits）

    // ⚠ 位运算是 32 位有符号的：data 为 -1 时其实 32 位全 1。
    //   必须用 `>>> 0` 转成无符号再逐位判，否则负数的符号位会算错。
    const raw = (cache[groupId] && cache[groupId].data) | 0;
    const mask = raw >>> 0;

    for (let b = 0; b < n; b++) {
      // 超过 31 位（Steam 每组最多 32 位）就不该出现，防御一下
      if (b < 32 && (mask & (1 << b))) res.unlocked++;
    }
    res.total += n;
  }

  res.hasAchievements = res.total > 0;
  return res;
}

module.exports = { parseBinaryKV, countAchievements };
