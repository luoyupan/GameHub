/**
 * ============================================================
 *  GameHub 联机 - 报文协议  (main/net/protocol.js)
 * ------------------------------------------------------------
 *  一帧的结构（UDP 上跑，小包优先）：
 *
 *    0..1   MAGIC  'GH'
 *    2      版本   1
 *    3      类型   T.*
 *    4..7   seq    序号（BE）—— PING/PONG 配对、DATA 不做重排
 *    8..11  to     目标成员 id（BE，0 = 广播/所有人）
 *    12..   payload
 *
 *  payload 有两种形态：
 *    · 控制帧 → UTF-8 JSON（好读好调试，包很小，不差这点字节）
 *    · DATA 帧 → [connId:uint32 BE][原始字节]（游戏流量，不进 JSON）
 *
 *  为什么要有 `to`：中转站模式下服务器是把包**广播**给同房间其他人的，
 *  客户端必须自己认领"发给我的"包；P2P 直连时收发都是点对点，`to` 写成 0 即可。
 * ============================================================
 */
'use strict';

const MAGIC = 0x4748;   // 'GH'
const VER = 1;

/** 帧头长度：magic(2) + ver(1) + type(1) + seq(4) + to(4) */
const HEAD = 12;

/** 报文类型 */
const T = {
  HELLO: 1,     // 我要进房间 { rid, name, pass, role, game }
  WELCOME: 2,   // 进来了    { id, hostId, members:[{id,name}], rid }
  REJECT: 3,    // 被拒      { reason }
  JOIN: 4,      // 有人进来了 { member }
  LEAVE: 5,     // 有人走了  { id }
  PING: 6,      // 心跳问    { ts }
  PONG: 7,      // 心跳答    { ts }
  CHAT: 8,      // 房间聊天  { text }
  STATS: 9,     // 房主广播的延迟/丢包表 { rows:[{id,rtt,loss}] }
  OPEN: 10,     // 开一条游戏隧道连接
  CLOSE: 11,    // 关掉一条连接
  DATA: 12      // 游戏流量
};

const TYPE_NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

/** 控制帧：type + seq + to + JSON 对象 → Buffer */
function encode(type, seq, obj = {}, to = 0) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const buf = Buffer.alloc(HEAD + body.length);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt8(VER, 2);
  buf.writeUInt8(type, 3);
  buf.writeUInt32BE(seq >>> 0, 4);
  buf.writeUInt32BE(to >>> 0, 8);
  body.copy(buf, HEAD);
  return buf;
}

/** DATA 帧：4 字节连接号 + 原始字节 */
function encodeData(seq, connId, data, to = 0) {
  const buf = Buffer.alloc(HEAD + 4 + data.length);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt8(VER, 2);
  buf.writeUInt8(T.DATA, 3);
  buf.writeUInt32BE(seq >>> 0, 4);
  buf.writeUInt32BE(to >>> 0, 8);
  buf.writeUInt32BE(connId >>> 0, HEAD);
  Buffer.from(data).copy(buf, HEAD + 4);
  return buf;
}

/** OPEN / CLOSE 帧：payload = 4 字节连接号 + JSON（JSON 里带 from，中转站广播后要靠它认人） */
function encodeConn(type, seq, connId, obj = {}, to = 0) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const buf = Buffer.alloc(HEAD + 4 + body.length);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt8(VER, 2);
  buf.writeUInt8(type, 3);
  buf.writeUInt32BE(seq >>> 0, 4);
  buf.writeUInt32BE(to >>> 0, 8);
  buf.writeUInt32BE(connId >>> 0, HEAD);
  body.copy(buf, HEAD + 4);
  return buf;
}

/**
 * 解一帧。
 * @returns {null|{type:number,name:string,seq:number,to:number,json?:object,connId?:number,data?:Buffer}}
 *          解析不了（太短 / magic 不对 / 版本不对 / JSON 坏）一律 null —— 网络上的包不可信
 */
function decode(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < HEAD) return null;
    if (buf.readUInt16BE(0) !== MAGIC) return null;
    if (buf.readUInt8(2) !== VER) return null;
    const type = buf.readUInt8(3);
    const seq = buf.readUInt32BE(4);
    const to = buf.readUInt32BE(8);
    const out = { type, seq, to, name: TYPE_NAME[type] || 'UNKNOWN' };

    if (type === T.DATA) {
      if (buf.length < HEAD + 4) return null;
      out.connId = buf.readUInt32BE(HEAD);
      out.data = buf.slice(HEAD + 4);
      return out;
    }
    if (type === T.OPEN || type === T.CLOSE) {
      if (buf.length < HEAD + 4) return null;
      out.connId = buf.readUInt32BE(HEAD);
      const t = buf.slice(HEAD + 4).toString('utf8');
      out.json = t ? JSON.parse(t) : {};
      return out;
    }

    const txt = buf.slice(HEAD).toString('utf8');
    out.json = txt ? JSON.parse(txt) : {};
    return out;
  } catch {
    return null;
  }
}

module.exports = { T, TYPE_NAME, HEAD, MAGIC, VER, encode, encodeData, encodeConn, decode };
