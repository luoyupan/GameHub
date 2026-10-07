#!/usr/bin/env node
/**
 * ============================================================
 *  GameHub 联机 - 中转站服务器（独立单文件）
 * ------------------------------------------------------------
 *  用法：
 *      node relay-server.js [端口] [最大房间人数]
 *      node relay-server.js 40000 8
 *
 *  这是**玩家自己提供的**中转站，GameHub 官方不提供任何公共中转站。
 *  找一台有公网 IP 的机器（云服务器 / 有端口映射的家宽都行），
 *  把这个文件拷上去跑起来，把 ip:端口 填进 GameHub 的「中转站」里即可。
 *
 *  它做的事只有一件：按房间号 rid 把 UDP 包在同房间的人之间广播。
 *  · 认不出游戏内容 —— 载荷对它是不透明的字节
 *  · 认不出房间名/密码 —— 只看到一个 rid（房间名+密码派生出的哈希）
 *  · 不落盘、不记录、重启即空
 *
 *  ⚠ 防火墙要放行这个 UDP 端口（云服务器记得去安全组开）。
 * ============================================================
 */
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 40000;
const MAX_MEMBERS = Number(process.argv[3]) || 8;
const IDLE_MS = 40000;          // 多久没包就把人踢出房间
const HEAD = 12;                // 帧头长度，跟 protocol.js 保持一致

/* 帧头：magic(2) ver(1) type(1) seq(4) to(4) */
const MAGIC = 0x4748;
const VER = 1;
const T = { HELLO: 1, WELCOME: 2, REJECT: 3, JOIN: 4, LEAVE: 5, DATA: 12 };

/** rooms: rid → Map<"ip:port", { id, addr, lastSeen }> */
const rooms = new Map();
const keyOf = (a) => `${a.address}:${a.port}`;

function encode(type, seq, obj, to) {
  const body = Buffer.from(JSON.stringify(obj || {}), 'utf8');
  const buf = Buffer.alloc(HEAD + body.length);
  buf.writeUInt16BE(MAGIC, 0);
  buf.writeUInt8(VER, 2);
  buf.writeUInt8(type, 3);
  buf.writeUInt32BE(seq >>> 0, 4);
  buf.writeUInt32BE(to >>> 0, 8);
  body.copy(buf, HEAD);
  return buf;
}

function send(sock, buf, addr) {
  try { sock.send(buf, addr.port, addr.address); } catch { /* 抖动忽略 */ }
}

const sock = dgram.createSocket('udp4');

sock.on('message', (msg, rinfo) => {
  if (msg.length < HEAD || msg.readUInt16BE(0) !== MAGIC || msg.readUInt8(2) !== VER) return;
  const type = msg.readUInt8(3);
  const seq = msg.readUInt32BE(4);
  const addr = { address: rinfo.address, port: rinfo.port };
  const myKey = keyOf(addr);

  /* ---------- 入房申请 ---------- */
  if (type === T.HELLO) {
    let j = {};
    try { j = JSON.parse(msg.slice(HEAD).toString('utf8') || '{}'); } catch { return; }
    const rid = String(j.rid || '').slice(0, 32);
    if (!rid) return;

    let room = rooms.get(rid);
    if (!room) { room = new Map(); rooms.set(rid, room); }
    if (room.has(myKey)) {
      // 重发了一次 HELLO（可能上一条回包丢了）—— 再答一次，别重复计数
      const me = room.get(myKey);
      send(sock, encode(T.WELCOME, seq, {
        id: me.id, hostId: room.values().next().value.id, rid,
        members: [...room.values()].map((m) => ({ id: m.id, name: m.name }))
      }, me.id), addr);
      return;
    }
    if (room.size >= MAX_MEMBERS) {
      send(sock, encode(T.REJECT, seq, { reason: '房间满了' }, 0), addr);
      return;
    }

    const id = crypto.randomInt(1, 0x7ffffffe);
    const me = { id, addr, name: String(j.name || '玩家').slice(0, 24), lastSeen: Date.now() };
    room.set(myKey, me);
    const hostId = room.values().next().value.id;

    send(sock, encode(T.WELCOME, seq, {
      id, hostId, rid, members: [...room.values()].map((m) => ({ id: m.id, name: m.name }))
    }, id), addr);

    // 通知房间里其他人
    const joinMsg = encode(T.JOIN, seq, { member: { id, name: me.name } }, 0);
    for (const [k, m] of room) if (k !== myKey) send(sock, joinMsg, m.addr);

    console.log(`[${new Date().toLocaleTimeString()}] ${me.name} 进入房间 ${rid.slice(0, 8)}（${room.size} 人）`);
    return;
  }

  /* ---------- 其它帧：在同房间内广播（原样转发，不看内容） ---------- */
  // 反查这个地址属于哪个房间
  let rid = null;
  let room = null;
  for (const [r, m] of rooms) {
    const hit = m.get(myKey);
    if (hit) { rid = r; room = m; hit.lastSeen = Date.now(); break; }
  }
  if (!room) return;   // 不认识的人，直接丢

  for (const [k, m] of room) {
    if (k === myKey) continue;
    send(sock, msg, m.addr);
  }
});

/* ---------- 定时清理掉线的人 ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [rid, room] of rooms) {
    for (const [k, m] of room) {
      if (now - m.lastSeen > IDLE_MS) {
        room.delete(k);
        const leave = encode(T.LEAVE, 0, { id: m.id }, 0);
        for (const [k2, m2] of room) send(sock, leave, m2.addr);
        console.log(`[${new Date().toLocaleTimeString()}] ${m.name} 超时离开 ${rid.slice(0, 8)}`);
      }
    }
    if (!room.size) rooms.delete(rid);
  }
}, 10000);

sock.on('listening', () => {
  const a = sock.address();
  console.log('──────────────────────────────────────────');
  console.log(' GameHub 联机中转站已启动');
  console.log(` 监听   : UDP ${a.address}:${a.port}`);
  console.log(` 每房上限: ${MAX_MEMBERS} 人`);
  console.log(' 把这个地址填进 GameHub 联机页的「中转站」里');
  console.log(' （防火墙/安全组记得放行这个 UDP 端口）');
  console.log('──────────────────────────────────────────');
});
sock.on('error', (e) => { console.error('中转站出错：', e && e.message); });
sock.bind(PORT);
