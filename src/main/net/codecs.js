/**
 * ============================================================
 *  GameHub 联机 - 房间码  (main/net/codecs.js)
 * ------------------------------------------------------------
 *  房间码 = GHNET1-<crc32hex>-<base64url(deflate(JSON))>
 *
 *  为什么要码不要明文地址：主人的要求 —— 「以代码的形式分享，
 *  防止端口泄露」。明文 host:port 直接发群里等于把家门牌号贴出去；
 *  码本身不透明，且带 CRC 自校验（复制漏尾巴直接报码无效）。
 *
 *  码里**不含密码** —— 密码另输，密码哈希也不进码（防止离线爆破）。
 * ============================================================
 */
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');

const PREFIX = 'GHNET1';

/** 房间信息的白名单字段 —— 码里只放这些，多余的东西进不去 */
function sanitizeInfo(info) {
  const mode = ['p2p', 'relay', 'tunnel'].includes(info.mode) ? info.mode : null;
  if (!mode) return null;
  const name = String(info.name || '').trim().slice(0, 40);
  if (!name) return null;
  const out = { v: 1, mode, name };
  // host 只在需要对方知道地址的模式里出现（p2p = 主机地址；tunnel = 穿透地址；relay = 中转站地址）
  if (info.host) {
    const host = String(info.host).trim().slice(0, 253);
    // 只放行 域名 / IPv4 / IPv6 字面量 —— 防止把奇怪的 URL/脚本塞进码
    if (!/^[a-zA-Z0-9.\-:\[\]]+$/.test(host)) return null;
    out.host = host.replace(/^\[|\]$/g, '');
  }
  if (Number.isInteger(info.port) && info.port > 0 && info.port <= 65535) out.port = info.port;
  if (Number.isInteger(info.gamePort) && info.gamePort > 0 && info.gamePort <= 65535) out.gamePort = info.gamePort;
  out.hasPass = !!info.hasPass;
  if (info.game) out.game = String(info.game).trim().slice(0, 40);
  return out;
}

/** 由房间信息生成房间码（info 会先过白名单清洗） */
function buildRoomCode(info) {
  const clean = sanitizeInfo(info);
  if (!clean) return null;
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify(clean), 'utf8'));
  const crc = crc32(payload);
  return `${PREFIX}-${crc.toString(16).padStart(8, '0')}-${payload.toString('base64url')}`;
}

/** 解析房间码；任何不合法（格式/CRC/JSON/字段）都返回 null */
function parseRoomCode(code) {
  try {
    const s = String(code || '').trim();
    const m = s.match(new RegExp(`^${PREFIX}-([0-9a-f]{8})-([A-Za-z0-9_-]+)$`));
    if (!m) return null;
    const payload = Buffer.from(m[2], 'base64url');
    if (crc32(payload) !== parseInt(m[1], 16)) return null;
    const info = JSON.parse(zlib.inflateRawSync(payload).toString('utf8'));
    if (info.v !== 1) return null;
    // ⚠ 从码里解出来的数据照样过一遍白名单 —— 码是别人给的，不可信
    return sanitizeInfo(info);
  } catch {
    return null;
  }
}

/** 房间密码的校验哈希（进网络的是这个，不是明文密码） */
function passHash(roomName, pass) {
  return crypto.createHash('sha256').update(`${roomName}::${pass || ''}::gamehub`).digest('hex').slice(0, 32);
}

/* ---------------- CRC32（查表法） ----------------
 * 建表是「右移 1 位 × 8 次」，不是一次右移 8 位 —— 详见 zipwrite.js 里那行警告。
 * 这里直接复用 zipwrite 的实现，保证两处永远一致（zip 头 / MOD 码 / 房间码同一个 CRC）。
 */
const crc32 = require('../zipwrite').crc32;

module.exports = { buildRoomCode, parseRoomCode, passHash, sanitizeInfo, crc32 };
