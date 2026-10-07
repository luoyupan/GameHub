/**
 * ============================================================
 *  GameHub 联机 - 网络体检  (main/net/netprobe.js)
 * ------------------------------------------------------------
 *  主人的需求：P2P 联机前「自动检测网络是否支持独立的 IPv4 端口
 *  或者是否支持 IPv6 端口」。这份探测回答三个问题：
 *
 *   1. 本机有没有**全局 IPv6**（2000::/3）—— 有就能走 IPv6 直连
 *   2. 本机 IPv4 是不是**公网 IP**（非运营商大内网）—— 是就能直接开端口
 *   3. 向公共 STUN 服务器发探测包 —— 拿到 NAT 出口的映射地址：
 *      · 映射 IP == 本机网卡 IP → 你就在公网上，完美
 *      · 映射 IP != 本机 IP → 你在 NAT 后面，端口映射要看路由器配合
 *
 *  STUN 服务器用国内可达的（腾讯/小米）+ 国外的兜底，谁先回用谁。
 *  探测是纯 UDP 出站，不需要任何服务器部署。
 * ============================================================
 */
'use strict';

const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');

/** STUN 服务器（国内优先）。STUN Binding Request 是固定 20 字节 */
const STUN_SERVERS = [
  { host: 'stun.qq.com', port: 3478 },
  { host: 'stun.miwifi.com', port: 3478 },
  { host: 'stun.syncthing.net', port: 3478 },
  { host: 'stun.l.google.com', port: 19302 }
];

/** 枚举本机网卡地址，按"能不能被别人直接连到"分类 */
function classifyAddresses() {
  const out = { globalIPv4: [], globalIPv6: [], privateIPv4: [] };
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const it of (list || [])) {
      if (it.internal) continue;
      const addr = String(it.address || '');
      if (it.family === 'IPv4') {
        if (isGlobalIPv4(addr)) out.globalIPv4.push(addr);
        else out.privateIPv4.push(addr);
      } else if (it.family === 'IPv6') {
        if (isGlobalIPv6(addr)) out.globalIPv6.push(addr);
      }
    }
  }
  return out;
}

/** RFC1918 + 运营商 CGN(100.64/10) + 链路本地 都不算公网 */
function isGlobalIPv4(addr) {
  if (/^127\./.test(addr) || /^169\.254\./.test(addr)) return false;
  if (/^10\./.test(addr)) return false;
  if (/^192\.168\./.test(addr)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return false; // 100.64.0.0/10 CGNAT
  return true;
}

/** 只认 2000::/3（全球单播）；fe80 链路本地 / fc00::/7 ULA / ::1 都不算 */
function isGlobalIPv6(addr) {
  const a = addr.toLowerCase().split('%')[0];
  if (a === '::1') return false;
  if (a.startsWith('fe80')) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return false;
  // 2000::/3 → 首段 2000-3fff
  const first = parseInt(a.split(':')[0], 16);
  return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff;
}

/** 手搓一个最小 STUN Binding Request（RFC 5389）：20 字节头 + 1 个 SOFTWARE 都不要 */
function stunBindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);          // Binding Request
  buf.writeUInt16BE(0, 2);               // 消息长度
  buf.writeUInt32BE(0x2112A442, 4);      // MAGIC COOKIE（网络字节序，别写成 LE）
  crypto.randomBytes(12).copy(buf, 8);   // 事务 ID
  return buf;
}

/** 解析 STUN 响应里的 XOR-MAPPED-ADDRESS（0x0020），拿不到就退 MAPPED-ADDRESS(0x0001) */
function parseStunResponse(msg, txid) {
  try {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101) return null;
    if (!msg.slice(8, 20).equals(txid)) return null;
    const len = msg.readUInt16BE(2);
    let off = 20;
    const end = 20 + len;
    let mapped = null;
    while (off + 4 <= end) {
      const type = msg.readUInt16BE(off);
      const size = msg.readUInt16BE(off + 2);
      const body = msg.slice(off + 4, off + 4 + size);
      if (type === 0x0020 && body.length >= 8) {
        const cookiePort = body.readUInt16BE(2) ^ 0x2112;
        const port = cookiePort;
        const ipBytes = Buffer.from([
          body[4] ^ 0x21, body[5] ^ 0x12, body[6] ^ 0xA4, body[7] ^ 0x42
        ]);
        mapped = { ip: `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`, port };
        break;
      }
      if (type === 0x0001 && body.length >= 8 && !mapped) {
        mapped = { ip: `${body[4]}.${body[5]}.${body[6]}.${body[7]}`, port: body.readUInt16BE(2) };
      }
      off += 4 + size + (size % 4);
    }
    return mapped;
  } catch {
    return null;
  }
}

/** 向一个 STUN 服务器发探测，超时返回 null */
function stunQuery(server, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const txid = crypto.randomBytes(12);
    const req = stunBindingRequest();
    txid.copy(req, 8);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { }
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', (msg) => finish(parseStunResponse(msg, txid)));
    sock.on('error', () => finish(null));
    sock.send(req, server.port, server.host, () => { });
  });
}

/**
 * 用**已经绑好的那个 socket** 去问 STUN。
 *
 * 为什么非得复用同一个 socket：NAT 的端口映射是按 (本机IP, 本机端口) 分配的，
 * 换一个 socket 就是另一条映射、另一个外网端口，问出来的结果对房间没用。
 * 房主先把房间 socket 绑好，再用它问一次，拿到的才是"别人真能连进来"的地址。
 *
 * @param {import('dgram').Socket} sock 已 bind 的 UDP socket
 */
function stunProbeOnSocket(sock, server, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const txid = Buffer.from(crypto.randomBytes(12));
    const req = stunBindingRequest();
    txid.copy(req, 8);
    let done = false;
    const onMsg = (msg) => {
      const r = parseStunResponse(msg, txid);
      if (r) finish(r);
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener('message', onMsg);
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', onMsg);
    try { sock.send(req, server.port, server.host, () => { }); }
    catch { finish(null); }
  });
}

/** 完整体检：地址分类 + STUN 探测 + P2P 结论 */
async function probeNetwork(onLog = () => { }) {
  const addrs = classifyAddresses();

  // 并行问所有 STUN，谁先答用谁（3 秒超时）
  const answers = (await Promise.all(STUN_SERVERS.map((s) => stunQuery(s)))).filter(Boolean);
  const mapped = answers.length ? answers[0] : null;

  const hasGlobalIPv6 = addrs.globalIPv6.length > 0;
  const isPublicIPv4 = addrs.globalIPv4.length > 0;
  const sameAsLocal = !!(mapped && addrs.globalIPv4.includes(mapped.ip));
  // NAT 后面但 STUN 可达 → 是否直连要看路由器（UPnP/DMZ），标记为"受限"
  const behindNAT = !!mapped && !sameAsLocal;

  let verdict, advice;
  if (hasGlobalIPv6) {
    verdict = 'ipv6-ok';
    advice = '检测到公网 IPv6 —— 支持直连联机。创建房间后把码发给朋友即可（双方都要有 IPv6）';
  } else if (isPublicIPv4 || sameAsLocal) {
    verdict = 'p2p-ok';
    advice = '本机在公网 IPv4 上 —— 支持直连联机';
  } else if (behindNAT) {
    verdict = 'limited';
    advice = 'IPv4 在 NAT 后面（运营商/路由器），直连可能不通 —— 建议用中转站或内网穿透模式；若路由器支持 IPv6 也可以试试';
  } else {
    verdict = 'limited';
    advice = '探测不到公网出口 —— 建议用中转站或内网穿透模式';
  }
  onLog(`[联机] 体检：IPv6=${hasGlobalIPv6 ? '有' : '无'} 公网IPv4=${isPublicIPv4 ? '有' : '无'} NAT出口=${mapped ? mapped.ip : '探测不到'} → ${verdict}`);

  return {
    ok: true,
    addrs,
    stun: mapped,
    stunServers: STUN_SERVERS,
    hasGlobalIPv6,
    isPublicIPv4,
    behindNAT,
    verdict,
    advice,
    p2pReady: verdict === 'p2p-ok' || verdict === 'ipv6-ok'
  };
}

module.exports = {
  classifyAddresses, isGlobalIPv4, isGlobalIPv6,
  stunQuery, stunProbeOnSocket, probeNetwork, STUN_SERVERS
};
