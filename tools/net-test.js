#!/usr/bin/env node
/**
 * ============================================================
 *  GameHub 联机模块测试  (tools/net-test.js)
 * ------------------------------------------------------------
 *  分三层测：
 *   ① 纯逻辑：房间码 / 地址分类 / 报文编解码 / 延迟丢包计量
 *   ② P2P 直连：本机起房主 + 客人，真的握手、真的互发心跳
 *   ③ 中转站：起一个真的中转站进程，两房客通过它握手
 *
 *  ② ③ 都是**真跑网络**的（只是都跑在 127.0.0.1 上），
 *  所以测出来的不是"我猜它应该能通"，而是"它真的通了"。
 * ============================================================
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const P = require('../src/main/net/protocol.js');
const codecs = require('../src/main/net/codecs.js');
const netprobe = require('../src/main/net/netprobe.js');
const { NetRoom, PingMeter } = require('../src/main/net/roomsvc.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `实际 ${a} / 期望 ${e}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================
 *  ① 纯逻辑
 * ================================================================ */
async function testCodecs() {
  section('房间码');

  const info = {
    mode: 'p2p', name: '周末帕鲁车', host: '2001:db8::1',
    port: 41234, gamePort: 7777, hasPass: true, game: '幻兽帕鲁'
  };
  const code = codecs.buildRoomCode(info);
  ok('能生成房间码', typeof code === 'string' && code.startsWith('GHNET1-'));
  const back = codecs.parseRoomCode(code);
  ok('往返后字段一致', back && back.name === info.name && back.host === info.host
    && back.port === info.port && back.gamePort === 7777 && back.hasPass === true);

  // ⚠ 篡改要改**中间**：base64 尾巴上的几个字符属于"填充位"，
  //   改了可能解出同样的字节，测不出 CRC 有没有在工作。
  const mid = Math.floor(code.length / 2);
  const bad = code.slice(0, mid) + (code[mid] === 'A' ? 'B' : 'A') + code.slice(mid + 1);
  ok('码被动过 → 判无效', codecs.parseRoomCode(bad) === null);
  ok('格式不对 → 判无效', codecs.parseRoomCode('GHNET1-00000000-AAAA') === null);
  ok('空 / 乱码 → 判无效', codecs.parseRoomCode('') === null && codecs.parseRoomCode('你好世界') === null);

  ok('房间名不能空', codecs.buildRoomCode({ mode: 'p2p', name: '  ' }) === null);
  ok('模式不在白名单 → 拒', codecs.buildRoomCode({ mode: 'evil', name: 'x' }) === null);
  ok('host 里塞 URL → 拒', codecs.buildRoomCode({ mode: 'p2p', name: 'x', host: 'http://evil.com/a' }) === null);
  ok('host 里塞脚本 → 拒', codecs.buildRoomCode({ mode: 'p2p', name: 'x', host: '<script>' }) === null);
  ok('端口越界 → 直接丢掉这个字段', (() => {
    const c = codecs.parseRoomCode(codecs.buildRoomCode({ mode: 'p2p', name: 'x', port: 99999 }));
    return c && c.port === undefined;
  })());

  ok('密码哈希稳定', codecs.passHash('房间', '123') === codecs.passHash('房间', '123'));
  ok('密码不同 → 哈希不同', codecs.passHash('房间', '123') !== codecs.passHash('房间', '124'));
  ok('房间名不同 → 哈希不同', codecs.passHash('A', '123') !== codecs.passHash('B', '123'));

  const relayCode = codecs.buildRoomCode({ mode: 'relay', name: '中转房', host: '1.2.3.4', port: 40000 });
  ok('中转站码能解析', codecs.parseRoomCode(relayCode).mode === 'relay');
  const tunnelCode = codecs.buildRoomCode({ mode: 'tunnel', name: '穿透房', host: 'xxx.frp.cn', port: 12345 });
  ok('内网穿透码能解析', codecs.parseRoomCode(tunnelCode).mode === 'tunnel');
}

function testCrc() {
  section('CRC32（zip 头 / MOD 码 / 房间码共用同一个）');

  // 标准测试向量 —— 建表时把 >>>1 写成 >>>8 就会全错，这几个值能当场抓住
  const VECTORS = [
    ['', 0x00000000],
    ['a', 0xE8B7BE43],
    ['abc', 0x352441C2],
    ['hello', 0x3610A686],
    ['The quick brown fox jumps over the lazy dog', 0x414FA339]
  ];
  for (const [s, exp] of VECTORS) {
    const got = codecs.crc32(Buffer.from(s, 'utf8'));
    ok(`crc32(${JSON.stringify(s.slice(0, 12))}${s.length > 12 ? '…' : ''})`, got === exp,
      `实际 ${got.toString(16)} / 期望 ${exp.toString(16)}`);
  }
  const zw = require('../src/main/zipwrite.js');
  ok('codecs 与 zipwrite 用的是同一份 CRC', codecs.crc32(Buffer.from('hello')) === zw.crc32(Buffer.from('hello')));
  ok('CRC 能识别中文', codecs.crc32(Buffer.from('房间', 'utf8')) !== codecs.crc32(Buffer.from('房房', 'utf8')));
}

function testProbe() {
  section('网络体检（地址分类）');

  ok('公网 IPv4 认得出来', netprobe.isGlobalIPv4('8.8.8.8') === true);
  ok('192.168 不算公网', netprobe.isGlobalIPv4('192.168.1.5') === false);
  ok('10.x 不算公网', netprobe.isGlobalIPv4('10.0.0.7') === false);
  ok('172.16-31 不算公网', netprobe.isGlobalIPv4('172.20.1.1') === false);
  ok('172.32 其实是公网', netprobe.isGlobalIPv4('172.32.1.1') === true);
  ok('运营商大内网 100.64/10 不算公网', netprobe.isGlobalIPv4('100.100.1.1') === false);
  ok('169.254 链路本地不算公网', netprobe.isGlobalIPv4('169.254.3.3') === false);
  ok('127.0.0.1 不算公网', netprobe.isGlobalIPv4('127.0.0.1') === false);

  ok('2408 段 IPv6 算公网', netprobe.isGlobalIPv6('2408:8207:78cc::1') === true);
  ok('2001 段 IPv6 算公网', netprobe.isGlobalIPv6('2001:db8::1') === true);
  ok('fe80 链路本地不算', netprobe.isGlobalIPv6('fe80::1') === false);
  ok('fd00 内网 ULA 不算', netprobe.isGlobalIPv6('fd00::1') === false);
  ok('::1 不算', netprobe.isGlobalIPv6('::1') === false);
  ok('带 % 网卡后缀也能判', netprobe.isGlobalIPv6('fe80::1%12') === false);

  const a = netprobe.classifyAddresses();
  ok('枚举网卡返回三个桶', Array.isArray(a.globalIPv4) && Array.isArray(a.globalIPv6) && Array.isArray(a.privateIPv4));
}

function testProtocol() {
  section('报文编解码');

  const f1 = P.encode(P.T.HELLO, 7, { rid: 'abc', name: '玩家' }, 0);
  const d1 = P.decode(f1);
  ok('控制帧往返', d1 && d1.type === P.T.HELLO && d1.seq === 7 && d1.json.rid === 'abc' && d1.json.name === '玩家');

  const f2 = P.encode(P.T.PING, 9, { ts: 123, from: 42 }, 42);
  const d2 = P.decode(f2);
  ok('to 字段能对上', d2 && d2.to === 42 && d2.json.from === 42);

  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const d3 = P.decode(P.encodeData(11, 99, payload, 5));
  ok('DATA 帧往返', d3 && d3.type === P.T.DATA && d3.connId === 99 && d3.data.equals(payload));

  const d4 = P.decode(P.encodeConn(P.T.OPEN, 3, 88, { from: 12 }, 12));
  ok('OPEN 帧往返（带 from）', d4 && d4.type === P.T.OPEN && d4.connId === 88 && d4.json.from === 12);

  ok('太短 → null', P.decode(Buffer.alloc(5)) === null);
  ok('magic 不对 → null', P.decode(Buffer.from('XXXX12345678')) === null);
  ok('版本不对 → null', P.decode((() => { const b = P.encode(P.T.PING, 1, {}); b.writeUInt8(99, 2); return b; })()) === null);
  ok('JSON 坏了 → null', P.decode((() => {
    const b = Buffer.alloc(P.HEAD + 3);
    P.encode(P.T.PING, 1, {}).copy(b);
    b.write('!!!', P.HEAD, 'ascii');
    return b;
  })()) === null);
  ok('非 Buffer → null', P.decode('hello') === null && P.decode(null) === null);
}

function testMeter() {
  section('延迟 / 丢包计量');

  const m = new PingMeter();
  const s1 = m.next(); const s2 = m.next(); const s3 = m.next();
  ok('发三个心跳', [s1, s2, s3].every((x) => x > 0));
  // 手动把时间戳往前挪，制造一个"明确的往返延迟"
  m.outcomes.forEach((o) => { o.ts -= 100; });
  m.ack(s1); m.ack(s2);   // s3 不回 = 丢包
  m.sweep();
  const st = m.stats();
  ok('延迟算得出来', st.rtt >= 0);
  ok('丢包率在 0..1 之间', st.loss >= 0 && st.loss <= 1);

  const m2 = new PingMeter();
  const q = m2.next();
  m2.ack(q);
  eq('全回来 → 丢包 0', m2.stats().loss, 0);

  const m3 = new PingMeter();
  for (let i = 0; i < 4; i++) m3.next();
  m3.outcomes.forEach((o) => { o.ts -= 5000; });   // 全超时
  m3.sweep();
  eq('全丢 → 丢包 1', m3.stats().loss, 1);

  ok('不认识的序号 → 不认', (() => { const m4 = new PingMeter(); return m4.ack(12345) === null; })());
}

/* ================================================================
 *  ② P2P 直连（真握手）
 * ================================================================ */
async function testP2P() {
  section('P2P 直连往返（127.0.0.1）');

  const host = new NetRoom();
  const guest = new NetRoom();
  const PORT = 47311;

  const hr = await host.host({
    mode: 'p2p', name: 'P2P 测试房', pass: 'pwd', game: '测试游戏', gamePort: 7777,
    listenPort: PORT, publicHost: '127.0.0.1'
  });
  ok('房主建房成功', hr && hr.ok, hr && hr.error);
  if (!hr.ok) return;
  ok('房间码是 p2p', codecs.parseRoomCode(hr.code).mode === 'p2p');
  ok('公布的地址就是我指定的', hr.publicAddr.ip === '127.0.0.1' && hr.publicAddr.port === PORT);

  const gr = await guest.join(hr.code, 'pwd', {});
  ok('客人加入成功', gr && gr.ok, gr && gr.error);
  if (!gr.ok) { host.leave(); return; }

  await sleep(2600);   // 等两轮心跳

  const hs = host.snapshot();
  const gs = guest.snapshot();
  ok('房主看到 1 个成员', hs.members.length >= 2, JSON.stringify(hs.members));
  ok('客人看到房主', gs.members.some((m) => m.isHost && !m.isMe), JSON.stringify(gs.members));
  ok('客人这边量到了延迟', gs.rtt >= 0);
  ok('延迟是个合理的数（<2s）', gs.rtt >= 0 && gs.rtt < 2000, `rtt=${gs.rtt}`);
  ok('丢包率在 0..1', gs.loss >= 0 && gs.loss <= 1);

  // 密码错了应该进不来（rid 对不上 → 房主回 REJECT）
  const wrong = new NetRoom();
  const wr = await wrong.join(hr.code, 'wrong-pwd', {});
  ok('密码错 → 进不来', wr && wr.ok === false, JSON.stringify(wr));
  wrong.leave();

  guest.leave();
  await sleep(100);
  host.leave();
  ok('两边都能正常离开', host.active === false && guest.active === false);
}

/* ================================================================
 *  ②' 游戏隧道：TCP → UDP → TCP 全链路
 * ================================================================ */
async function testTunnel() {
  section('游戏隧道（本机起一个假游戏服，客人连进来要能原样收到回音）');

  const net = require('net');
  const GAME_PORT = 47881;   // 假装这是游戏监听的端口
  const LOCAL_PORT = 47882;  // 客人本机的隧道入口

  // 起一个"游戏"：收到什么回什么（echo）
  const game = net.createServer((s) => {
    s.on('data', (d) => s.write(d));
  });
  const gameUp = await new Promise((res) => {
    game.on('error', (e) => res(false));
    game.listen(GAME_PORT, '127.0.0.1', () => res(true));
  });
  ok('假游戏服起来了', gameUp);
  if (!gameUp) return;

  const host = new NetRoom();
  const guest = new NetRoom();
  const hr = await host.host({
    mode: 'p2p', name: '隧道测试房', pass: '', gamePort: GAME_PORT,
    listenPort: 47313, publicHost: '127.0.0.1', tunnel: true
  });
  ok('房主建房成功（带隧道）', hr && hr.ok, hr && hr.error);
  if (!hr.ok) { game.close(); return; }

  const gr = await guest.join(hr.code, '', { tunnel: true, tunnelPort: LOCAL_PORT });
  ok('客人加入成功（带隧道）', gr && gr.ok, gr && gr.error);
  if (!gr.ok) { host.leave(); game.close(); return; }
  await sleep(300);
  ok('客人这边的隧道监听起来了', guest.tunnelOn && guest.tunnelPort === LOCAL_PORT, `tunnelOn=${guest.tunnelOn} port=${guest.tunnelPort}`);

  // 客人把"游戏"连到本机隧道口，发一句话，等回音
  const echoed = await new Promise((res) => {
    const s = net.connect(LOCAL_PORT, '127.0.0.1');
    let got = null;
    const finish = (v) => { try { s.destroy(); } catch { } res(v); };
    const timer = setTimeout(() => finish(got), 6000);
    s.on('connect', () => s.write('ping-from-guest-你好'));
    s.on('data', (d) => {
      got = d.toString('utf8');
      if (got === 'ping-from-guest-你好') { clearTimeout(timer); finish(got); }
    });
    s.on('error', () => { clearTimeout(timer); finish(null); });
  });
  ok('数据穿过去了又回来了（TCP→UDP→TCP）', echoed === 'ping-from-guest-你好', `收到 ${JSON.stringify(echoed)}`);

  guest.leave();
  await sleep(100);
  host.leave();
  game.close();
  ok('隧道收尾干净', guest.conns.size === 0 && host.conns.size === 0);
}

/* ================================================================
 *  ③ 中转站（真起一个进程）
 * ================================================================ */
async function testRelay() {
  section('中转站往返（真起服务器）');

  const PORT = 47312;
  const proc = spawn(process.execPath, [path.join(__dirname, 'relay-server.js'), String(PORT), '4'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let booted = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) booted = true; });
  proc.stderr.on('data', () => { });

  // 等中转站起来
  for (let i = 0; i < 40 && !booted; i++) await sleep(50);
  ok('中转站进程起来了', booted);
  if (!booted) { try { proc.kill(); } catch { } return; }

  const a = new NetRoom();
  const b = new NetRoom();

  const ar = await a.host({
    mode: 'relay', name: '中转测试房', pass: 'pwd', game: '测试游戏', gamePort: 7777,
    relayHost: '127.0.0.1', relayPort: PORT
  });
  ok('房主挂到中转站上了', ar && ar.ok, ar && ar.error);
  if (!ar.ok) { try { proc.kill(); } catch { } return; }
  ok('房间码是 relay', codecs.parseRoomCode(ar.code).mode === 'relay');

  const br = await b.join(ar.code, 'pwd', {});
  ok('第二个人通过中转站进来了', br && br.ok, br && br.error);

  await sleep(2600);
  const as = a.snapshot();
  const bs = b.snapshot();
  ok('A 看到了成员', as.members.length >= 2, JSON.stringify(as.members));
  ok('B 看到了房主', bs.members.some((m) => m.isHost && !m.isMe), JSON.stringify(bs.members));
  ok('B 量到了延迟', bs.rtt >= 0 && bs.rtt < 2000, `rtt=${bs.rtt}`);
  ok('走的是中转（via=relay）', bs.members.every((m) => m.isMe || m.via === 'relay'));

  const c = new NetRoom();
  const cr = await c.join(ar.code, 'wrong', {});
  ok('密码错 → 被挡在外面', cr && cr.ok === false, JSON.stringify(cr));
  c.leave();

  b.leave(); a.leave();
  try { proc.kill(); } catch { }
  ok('收尾干净', a.active === false && b.active === false);
}

/* ================================================================
 *  跑
 * ================================================================ */
(async () => {
  console.log('════════ GameHub 联机模块测试 ════════');
  await testCodecs();
  testCrc();
  testProbe();
  testProtocol();
  testMeter();
  await testP2P();
  await testTunnel();
  await testRelay();

  console.log(`\n════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
  if (fail) { console.log('失败项：' + failures.join('、')); process.exit(1); }
  // 网络测试会留下 socket/timer，这里强制收尾，别让进程挂着不退出
  process.exit(0);
})().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(1);
});
