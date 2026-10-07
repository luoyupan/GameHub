/**
 * ============================================================
 *  GameHub 联机 - 房间服务  (main/net/roomsvc.js)
 * ------------------------------------------------------------
 *  一个房间 = 一条 UDP 控制通道：
 *    · 握手：HELLO(rid) → WELCOME(分配 id + 成员表) / REJECT
 *    · 心跳：每秒互发 PING/PONG → 算延迟与丢包
 *    · 广播：房主每 2 秒发一次 STATS，把全房间的延迟/丢包表同步给大家
 *    · 隧道：可选的 TCP-over-UDP 转发，让"只能局域网联机"的游戏跨网跑起来
 *
 *  ⚠ 三条边界，写死在这里免得后面改歪：
 *    1. 密码**永不上网** —— 网上跑的只有 rid（房间名的密码哈希派生值），
 *       不知道密码就算拿到码也算不出 rid，进不了房间。
 *    2. rid 相同的两个房间会撞车（同名同密），这是刻意换来的"零服务端"，
 *       房间名请起得特别一点。
 *    3. 中转站模式下中转服务器能看到 rid 和转发的字节，但**解不开游戏流量**；
 *       即便如此也只连自己信得过的中转站。
 * ============================================================
 */
'use strict';

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const P = require('./protocol');
const codecs = require('./codecs');
const netprobe = require('./netprobe');

const PING_MS = 1000;        // 心跳间隔
const STATS_MS = 2000;       // 房主广播延迟表的间隔
const PEER_TIMEOUT = 12000;  // 多久没消息算掉线
const KEEPALIVE_MS = 20000;  // NAT 映射保活（只在需要时）
const MAX_OUTCOMES = 30;     // 丢包率滑动窗口大小
const PONG_WAIT = 2500;      // 超过这个时间没回来就判丢包
const PORT_MIN = 41000;
const PORT_MAX = 59999;

/** 中转站广播时无条件放行的帧（收件人还没被分配 id，帧头的 to 先对不上） */
const PASS = new Set([1 /*HELLO*/, 2 /*WELCOME*/, 3 /*REJECT*/]);

/* ================================================================
 *  延迟 / 丢包 计量器
 * ================================================================ */

/**
 * 一个「我 → 某个对端」的链路质量。
 *
 * 丢包率按滑动窗口算：最近 MAX_OUTCOMES 次心跳里，回了多少、没回多少。
 * 只统计**已经出结果**的包（回了的不算丢，超过 PONG_WAIT 还没回的算丢），
 * 刚发出去还没到时候的不参与计算，否则丢包率会虚高。
 */
class PingMeter {
  constructor() {
    this.outcomes = [];   // [{ seq, ts, rtt|null }]
    this.seq = 0;
    this.rtt = 0;
    this.loss = 0;
  }
  /** 发出一次心跳，返回序号 */
  next() {
    const seq = ++this.seq;
    this.outcomes.push({ seq, ts: Date.now(), rtt: null });
    if (this.outcomes.length > MAX_OUTCOMES) this.outcomes.shift();
    return seq;
  }
  /** 心跳回来了，返回这次的往返延迟（不是自己发的包返回 null） */
  ack(seq) {
    const it = this.outcomes.find((o) => o.seq === seq);
    if (!it || it.rtt !== null) return null;
    it.rtt = Date.now() - it.ts;
    this._recalc();
    return it.rtt;
  }
  /** 每次心跳周期过一遍，把超时的判成丢包 */
  sweep() {
    this._recalc();
  }
  _recalc() {
    const now = Date.now();
    const settled = this.outcomes.filter((o) => o.rtt !== null || (now - o.ts) > PONG_WAIT);
    const lost = settled.filter((o) => o.rtt === null).length;
    this.loss = settled.length ? lost / settled.length : 0;
    const good = settled.filter((o) => o.rtt !== null).map((o) => o.rtt);
    this.rtt = good.length ? Math.round(good.reduce((a, b) => a + b, 0) / good.length) : 0;
  }
  stats() { return { rtt: this.rtt, loss: this.loss }; }
}

/* ================================================================
 *  房间
 * ================================================================ */

class NetRoom extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.mode = null;       // 'p2p' | 'relay'
    this.role = null;       // 'host' | 'guest'
    this.sock = null;
    this.family = 'udp4';
    this.localPort = 0;
    this.remote = null;     // { address, port } —— p2p=房主地址 / relay=中转站地址
    this.rid = '';
    this.selfId = 0;
    this.hostId = 0;
    this.name = '';
    this.game = '';
    this.gamePort = 0;
    this.code = '';
    this.publicAddr = null; // 房主对外公布的地址 { ip, port, kind }
    /** id → { id, name, addr, meter, lastSeen, isHost } */
    this.peers = new Map();
    /** connId → { socket, peerId, local } */
    this.conns = new Map();
    this.tcpServer = null;
    this.tunnelOn = false;
    this.tunnelPort = 0;
    this._seq = 0;
    this._connSeq = 0;
    this._pingTimer = null;
    this._statsTimer = null;
    this._keepTimer = null;
    this._helloTries = 0;
    this._helloTimer = null;
    this._bound = false;
  }

  /* ---------------- 小工具 ---------------- */
  _nextSeq() { return ++this._seq; }

  _send(buf, addr) {
    if (!this.sock || !addr) return;
    try { this.sock.send(buf, addr.port, addr.address); } catch { /* 网络抖动，忽略 */ }
  }

  /** 给某个成员发一帧（p2p 走对端地址，relay 一律发给中转站并标 to） */
  _sendTo(peerId, buf) {
    const peer = this.peers.get(peerId);
    if (this.mode === 'relay') {
      // 中转站会把包广播给同房间其他人，客户端靠帧头里的 to 自己认领
      this._send(buf, this.remote);
      return;
    }
    const addr = peer && peer.addr;
    if (addr) this._send(buf, addr);
  }

  _log(msg) { this.emit('log', String(msg)); }

  _emitState() { this.emit('state', this.snapshot()); }

  /* ============================================================
   *  建房（房主）
   * ============================================================ */
  /**
   * @param {object} opts
   *   mode        'p2p' | 'relay'
   *   name        房间名
   *   pass        房间密码（可空 = 无密码）
   *   game        游戏名（可空）
   *   gamePort    游戏监听端口（隧道用，可空）
   *   family      'ipv4' | 'ipv6' | 'auto'
   *   relayHost / relayPort   中转站地址（mode='relay' 时必填）
   *   tunnel      true = 顺带开 TCP-over-UDP 隧道
   * @returns {Promise<object>} { ok, code, info, publicAddr, advice }
   */
  async host(opts = {}) {
    if (this.active) return { ok: false, error: '已经在一个房间里了' };
    const mode = opts.mode === 'relay' ? 'relay' : 'p2p';
    const name = String(opts.name || '').trim();
    if (!name) return { ok: false, error: '房间名不能为空' };
    if (mode === 'relay' && !(opts.relayHost && Number(opts.relayPort))) {
      return { ok: false, error: '中转站模式必须填中转站地址和端口' };
    }

    this.mode = mode;
    this.role = 'host';
    this.name = name;
    /** 我的昵称：成员表「账号」列和聊天里显示的名字 */
    this.myName = String(opts.myName || '').trim().slice(0, 24) || '房主';
    this.game = String(opts.game || '').trim();
    this.gamePort = Number(opts.gamePort) || 0;
    this.rid = codecs.passHash(name, String(opts.pass || '')).slice(0, 16);
    this.peers.clear();

    // ⚠ P2P 房主自己就是服务器，id 自己发；中转站模式下 id **由中转站分配**，
    //   这里必须留 0 —— 握手包是"selfId 为 0 才发"的，提前填了就一个包都发不出去。
    if (mode === 'p2p') {
      this.selfId = crypto.randomInt(1, 0x7ffffffe);
      this.hostId = this.selfId;
    } else {
      this.selfId = 0;
      this.hostId = 0;
    }

    let advice = '';
    if (mode === 'p2p') {
      const r = await this._bindForHost(opts.family || 'auto', opts);
      if (!r.ok) { this._reset(); return r; }
      advice = r.advice || '';
      this.publicAddr = r.public;
      this.code = codecs.buildRoomCode({
        mode: 'p2p', name, host: r.public.ip, port: r.public.port,
        gamePort: this.gamePort || null, hasPass: !!opts.pass, game: this.game || null
      });
    } else {
      // 中转站模式：本机不监听，大家连同一个中转站，由中转站按 rid 分房间
      this.remote = { address: String(opts.relayHost).trim(), port: Number(opts.relayPort) };
      this.family = net.isIPv6(this.remote.address) ? 'udp6' : 'udp4';
      this.sock = dgram.createSocket(this.family);
      this._wireSocket();
      await new Promise((res) => this.sock.bind(0, () => res()));
      this._bound = true;
      this.publicAddr = { ip: this.remote.address, port: this.remote.port, kind: 'relay' };
      this.code = codecs.buildRoomCode({
        mode: 'relay', name, host: this.remote.address, port: this.remote.port,
        gamePort: this.gamePort || null, hasPass: !!opts.pass, game: this.game || null
      });
      advice = `房间挂在中转站 ${this.remote.address}:${this.remote.port} 上 —— 中转站挂了房间就没了`;
    }

    if (!this.code) { this._reset(); return { ok: false, error: '生成房间码失败' }; }

    this.active = true;

    // 中转站模式下房主也是"连上去"的：先跟中转站握个手，
    // 拿不到 WELCOME 就说明中转站地址填错了 / 没开 / 端口没放行。
    if (mode === 'relay') {
      const hs = await this._helloHandshake('host');
      if (!hs.ok) { this._reset(); return hs; }
      // 房间里已经有人了（同名同密的房间还在），那就按客人算
      if (this.hostId && this.hostId !== this.selfId) this.role = 'guest';
    }

    this._startTimers();
    if (opts.tunnel && this.gamePort) {
      const t = await this._startHostTunnel();
      if (!t.ok) advice += `（隧道没起来：${t.error}）`;
    }
    this._log(`房间「${name}」已开 —— ${this.publicAddr.kind} ${this.publicAddr.ip}:${this.publicAddr.port}`);
    this._emitState();
    return {
      ok: true, code: this.code, rid: this.rid,
      publicAddr: this.publicAddr, advice,
      info: codecs.parseRoomCode(this.code)
    };
  }

  /**
   * 给房主挑网卡、绑端口，并问出"别人真能连进来"的公网地址。
   *
   * opts.publicHost 是给「我自己已经把端口映射好了」的人准备的：
   * 路由器做了 DMZ / 端口转发、或者用了别的内网穿透，直接填外网地址，
   * GameHub 就不再去问 STUN（问出来的反而是错的）。
   *
   * @returns {Promise<{ok:boolean, error?:string, public?:object, advice?:string}>}
   */
  async _bindForHost(familyPref, opts = {}) {
    const addrs = netprobe.classifyAddresses();
    const wantV6 = familyPref === 'ipv6' || (familyPref === 'auto' && addrs.globalIPv6.length > 0);
    const family = wantV6 ? 'udp6' : 'udp4';
    const localIp = wantV6
      ? (addrs.globalIPv6[0] || '')
      : (addrs.globalIPv4[0] || (addrs.privateIPv4[0] || '0.0.0.0'));

    this.family = family;
    this.sock = dgram.createSocket(family);
    this._wireSocket();

    // 端口随机挑，被占了就换一个（最多试 25 次）；测试 / 手动映射时可以指定
    let bound = false;
    const ports = opts.listenPort ? [Number(opts.listenPort)] : Array.from({ length: 25 }, () => crypto.randomInt(PORT_MIN, PORT_MAX));
    for (const port of ports) {
      if (bound) break;
      try {
        await new Promise((res, rej) => {
          const onErr = (e) => rej(e);
          this.sock.once('error', onErr);
          this.sock.bind(port, wantV6 ? '::' : '0.0.0.0', () => {
            this.sock.removeListener('error', onErr);
            res();
          });
        });
        this.localPort = port;
        bound = true;
      } catch { /* 换一个端口再来 */ }
    }
    if (!bound) {
      try { this.sock.close(); } catch { }
      return { ok: false, error: '没有可用的本地端口（42000-59999 全被占了？）' };
    }
    this._bound = true;

    // 手动指定外网地址：跳过 STUN，直接按用户说的公布
    if (opts.publicHost) {
      return {
        ok: true,
        public: { ip: String(opts.publicHost).trim(), port: Number(opts.publicPort) || this.localPort, kind: 'manual' },
        advice: '用的是你手动填的外网地址 —— 得确保它真的能通到本机这个端口'
      };
    }

    // IPv6 全球单播 = 端到端可达，不需要 NAT 那套，直接公布本机地址
    if (wantV6 && localIp) {
      return {
        ok: true,
        public: { ip: localIp, port: this.localPort, kind: 'ipv6' },
        advice: '走 IPv6 直连 —— 双方都得有公网 IPv6 才连得上'
      };
    }

    // IPv4：用**房间这个 socket**去问 STUN，问出来的才是别人能连的 ip:port
    const mapped = await netprobe.stunProbeOnSocket(this.sock, netprobe.STUN_SERVERS[0], 3000);
    const isPublic = addrs.globalIPv4.length > 0 && mapped && addrs.globalIPv4.includes(mapped.ip);
    if (isPublic) {
      return {
        ok: true,
        public: { ip: mapped.ip, port: this.localPort, kind: 'ipv4-public' },
        advice: '本机就在公网 IPv4 上 —— 直连一般能通'
      };
    }
    if (mapped) {
      // NAT 后面：公布映射地址，并定时往 STUN 发个包保住这条映射（洞要一直开着）
      this._startKeepAlive();
      return {
        ok: true,
        public: { ip: mapped.ip, port: mapped.port, kind: 'ipv4-nat' },
        advice: `在 NAT 后面，对外是 ${mapped.ip}:${mapped.port} —— 只在"锥形 NAT"下能被打洞进来；连不上就换中转站或内网穿透`
      };
    }
    // STUN 全不通：只能退到内网地址，同局域网的人还能连
    return {
      ok: true,
      public: { ip: localIp || '127.0.0.1', port: this.localPort, kind: 'lan-only' },
      advice: '探测不到公网出口，只有同一个局域网的人能连进来 —— 建议改用中转站或内网穿透'
    };
  }

  /** NAT 保活：定时往 STUN 发一个包，别让映射被回收 */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepTimer = setInterval(() => {
      if (!this.sock || !this.remote) { /* 还没人进来，也要保活 */ }
      netprobe.stunProbeOnSocket(this.sock, netprobe.STUN_SERVERS[0], 1200).catch(() => { });
    }, KEEPALIVE_MS);
  }
  _stopKeepAlive() { if (this._keepTimer) { clearInterval(this._keepTimer); this._keepTimer = null; } }

  /* ============================================================
   *  加入（客人）
   * ============================================================ */
  /**
   * @param {string} code 房间码
   * @param {string} pass 房间密码（房间设了密码才需要）
   * @param {object} [opts] { tunnel?:boolean, tunnelPort?:number, gamePort?:number }
   */
  async join(code, pass, opts = {}) {
    if (this.active) return { ok: false, error: '已经在一个房间里了' };
    const info = codecs.parseRoomCode(code);
    if (!info) return { ok: false, error: '房间码无效（复制漏了？被改过？）' };
    if (info.mode === 'tunnel') return { ok: false, error: '这是内网穿透的房间码，请到「内网穿透」页直接用地址连接' };
    if (!(info.host && Number(info.port))) return { ok: false, error: '这个房间码里没有地址，换一个试试' };

    this.mode = info.mode;
    this.role = 'guest';
    this.name = info.name;
    this.myName = String(opts.myName || '').trim().slice(0, 24) || '玩家';
    this.game = info.game || '';
    this.gamePort = Number(opts.gamePort || info.gamePort) || 0;
    this.code = String(code).trim();
    this.rid = codecs.passHash(info.name, String(pass || '')).slice(0, 16);
    this.remote = { address: info.host, port: Number(info.port) };
    this.family = net.isIPv6(this.remote.address) ? 'udp6' : 'udp4';
    this.peers.clear();
    this.publicAddr = { ip: info.host, port: Number(info.port), kind: info.mode === 'relay' ? 'relay' : 'p2p' };

    this.sock = dgram.createSocket(this.family);
    this._wireSocket();
    await new Promise((res) => this.sock.bind(0, () => res()));
    this._bound = true;

    // 主动发包 = 给自己这一侧也开一个洞，房主打回来才进得来
    this.active = true;
    const hs = await this._helloHandshake('guest');
    if (!hs.ok) { this._reset(); return hs; }

    // 中转站是"按 rid 现开房间"的：rid 不对会给你**新开一个空房间**而不是拒绝。
    // 客人进完发现屋里一个人都没有，那基本就是房间名/密码不对，或者房主已经关了 ——
    // 直接判失败，别让人对着一个空房间发呆。
    if (this.mode === 'relay' && this.peers.size === 0) {
      this._reset();
      return { ok: false, error: '中转站上没有这个房间：房间名或密码不对，也可能房主已经关了' };
    }

    this._startTimers();
    if (opts.tunnel && this.gamePort) {
      const t = await this._startGuestTunnel(Number(opts.tunnelPort) || this.gamePort);
      if (!t.ok) this._log(`隧道没起来：${t.error}`);
      else this._log(`隧道已开：本机 127.0.0.1:${this.tunnelPort} → 房主的游戏端口 ${this.gamePort}`);
    }
    this._emitState();
    return { ok: true, name: this.name, selfId: this.selfId, hostId: this.hostId, mode: this.mode };
  }

  /* ============================================================
   *  握手
   * ============================================================ */

  /**
   * 发 HELLO 直到收到 WELCOME。
   * 为什么要重发：UDP 会丢，而"第一个包"往往正是被 NAT / 防火墙吃掉的那个；
   * 持续发还有个副作用 —— 给自己这一侧把洞打开，对端才打得回来。
   */
  async _helloHandshake(role) {
    const hello = P.encode(P.T.HELLO, this._nextSeq(), {
      rid: this.rid, name: this.myName, role, game: this.game
    }, 0);
    this._helloTries = 0;
    return new Promise((res) => {
      const finish = (v) => {
        if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = null; }
        this.removeListener('joined', onJoin);
        this.removeListener('error', onErr);
        res(v);
      };
      const onJoin = () => finish({ ok: true });
      const onErr = (e) => finish({ ok: false, error: (e && e.message) || '握手失败' });
      this.once('joined', onJoin);
      this.once('error', onErr);

      const tick = () => {
        if (this.selfId) return;
        this._send(hello, this.remote);
        if (++this._helloTries >= 12) {
          const msg = this.mode === 'relay'
            ? '连不上中转站：地址填错了、服务没开，或者 UDP 端口没放行'
            : '连不上房间：房主不在线、地址不通，或者房间密码不对';
          this._log(msg);
          finish({ ok: false, error: msg });
        }
      };
      tick();
      this._helloTimer = setInterval(tick, 1000);
    });
  }

  /* ============================================================
   *  收包
   * ============================================================ */
  _wireSocket() {
    if (!this.sock) return;
    this.sock.on('message', (msg, rinfo) => {
      const f = P.decode(msg);
      if (!f) return;
      // relay 模式：中转站是广播的，不是发给我的就扔掉。
      // 但 WELCOME / REJECT 是"我还没 id 时"的唯一回信，必须放行，否则永远进不去房间。
      if (this.mode === 'relay' && f.to !== 0 && f.to !== this.selfId && !PASS.has(f.type)) return;
      this._onFrame(f, rinfo);
    });
    this.sock.on('error', (e) => {
      this._log('网络错误：' + (e && e.message));
    });
  }

  _onFrame(f, rinfo) {
    const addr = { address: rinfo.address, port: rinfo.port };

    switch (f.type) {
      /* ---- 有人要进房间 ---- */
      case P.T.HELLO: {
        const j = f.json || {};
        if (j.rid !== this.rid) {
          this._send(P.encode(P.T.REJECT, this._nextSeq(), { reason: '房间名或密码不对' }, 0), addr);
          this._log(`拒绝了一个连入：rid 对不上（${rinfo.address}）`);
          return;
        }
        if (this.role !== 'host') return;   // 客人不处理别人的 HELLO
        const id = crypto.randomInt(1, 0x7ffffffe);
        const member = { id, name: String(j.name || '玩家').slice(0, 24) };
        this.peers.set(id, {
          id, name: member.name, addr, meter: new PingMeter(), lastSeen: Date.now(), isHost: false
        });
        // 新人：告诉他 id、房主 id、现有成员
        this._send(P.encode(P.T.WELCOME, this._nextSeq(), {
          id, hostId: this.hostId, rid: this.rid,
          members: [{ id: this.selfId, name: '房主' }, ...[...this.peers.values()].map((p) => ({ id: p.id, name: p.name }))]
        }, id), addr);
        // 老人：通知一下有人进来了
        for (const p of this.peers.values()) {
          if (p.id === id) continue;
          this._sendTo(p.id, P.encode(P.T.JOIN, this._nextSeq(), { member }, p.id));
        }
        // 中转站模式下房主得主动认识新人（走的不是直连，是广播）
        if (this.mode === 'relay') {
          // 客人收到 WELCOME 后会 PING 房主，房主那时才认识它；这里先补一条直连感知
          this._send(P.encode(P.T.JOIN, this._nextSeq(), { member: { id: this.selfId, name: '房主' } }, id), this.remote);
        }
        this._log(`「${member.name}」加入了房间`);
        this._emitState();
        return;
      }

      /* ---- 进来了 ---- */
      case P.T.WELCOME: {
        const j = f.json || {};
        if (this.selfId) return;                    // 已经进过了
        if (j.rid !== this.rid) return;             // 不是我的房间（relay 广播）
        this.selfId = Number(j.id) || crypto.randomInt(1, 0x7ffffffe);
        this.hostId = Number(j.hostId) || 0;
        if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = null; }
        for (const m of (j.members || [])) {
          const id = Number(m.id);
          if (id === this.selfId) continue;
          this._ensurePeer(id, m.name, this.mode === 'relay' ? null : addr);
        }
        // 房主：p2p 下直连地址就是包来的地方；relay 下统一走中转站
        if (this.hostId && this.hostId !== this.selfId) {
          this._ensurePeer(this.hostId, '房主', this.mode === 'relay' ? null : addr).isHost = true;
        }
        this._log(`已加入「${this.name}」`);
        this._emitState();
        this.emit('joined', { selfId: this.selfId, hostId: this.hostId });
        return;
      }

      case P.T.REJECT: {
        const j = f.json || {};
        if (this.selfId) return;
        this.emit('error', { code: 'reject', message: (j.reason || '被房间拒绝') });
        return;
      }

      case P.T.JOIN: {
        const j = f.json || {};
        const id = Number(j.member && j.member.id);
        if (!id || id === this.selfId) return;
        this._ensurePeer(id, j.member.name, null);
        this._emitState();
        return;
      }

      case P.T.LEAVE: {
        const j = f.json || {};
        const id = Number(j.id);
        if (this.peers.has(id)) {
          this.peers.delete(id);
          this._log(`有人离开了房间`);
          this._emitState();
        }
        return;
      }

      /* ---- 心跳 ---- */
      case P.T.PING: {
        const j = f.json || {};
        const from = Number(j.from) || 0;
        // 回一个 PONG，让对方算延迟
        this._sendTo(from || f.to || 0, P.encode(P.T.PONG, f.seq, { ts: j.ts, from: this.selfId }, from || 0));
        if (from) this._touchPeer(from, addr);
        return;
      }
      case P.T.PONG: {
        const j = f.json || {};
        const from = Number(j.from) || 0;
        const peer = this.peers.get(from);
        if (peer) { peer.meter.ack(f.seq); peer.lastSeen = Date.now(); }
        this._emitState();
        return;
      }

      /* ---- 延迟/丢包总表（房主广播） ---- */
      case P.T.STATS: {
        const j = f.json || {};
        this.statsTable = j.rows || [];
        this._emitState();
        return;
      }

      /* ---- 聊天 ---- */
      case P.T.CHAT: {
        const j = f.json || {};
        this.emit('chat', { from: Number(j.from) || 0, name: j.name || '', text: String(j.text || '') });
        return;
      }

      /* ---- 游戏隧道 ---- */
      case P.T.OPEN: {
        if (this.role !== 'host') return;
        const from = Number((f.json || {}).from) || 0;
        if (from) this._hostOpenConn(f.connId, from);
        return;
      }
      case P.T.CLOSE: {
        this._closeConn(f.connId);
        return;
      }
      case P.T.DATA: {
        const c = this.conns.get(f.connId);
        if (c && c.socket && !c.socket.destroyed) c.socket.write(f.data);
        return;
      }
    }
  }

  _ensurePeer(id, name, addr) {
    let p = this.peers.get(id);
    if (!p) {
      p = { id, name: String(name || '玩家'), addr: addr || null, meter: new PingMeter(), lastSeen: Date.now(), isHost: false };
      this.peers.set(id, p);
    } else {
      if (name && !p.name) p.name = name;
      if (addr && !p.addr) p.addr = addr;
    }
    return p;
  }

  _touchPeer(id, addr) {
    const p = this._ensurePeer(id, '', addr);
    p.lastSeen = Date.now();
    if (addr && !p.addr) p.addr = addr;
    return p;
  }

  /* ============================================================
   *  定时器：心跳 / 掉线清理 / 延迟表广播
   * ============================================================ */
  _startTimers() {
    this._stopTimers();
    this._pingTimer = setInterval(() => {
      if (!this.active) return;
      const now = Date.now();

      // 掉线清理（房主负责踢，客人只管房主还在不在）
      if (this.role === 'host') {
        for (const [id, p] of [...this.peers]) {
          if (now - p.lastSeen > PEER_TIMEOUT) {
            this.peers.delete(id);
            this._sendTo(id, P.encode(P.T.LEAVE, this._nextSeq(), { id }, id));
            for (const q of this.peers.values()) {
              this._sendTo(q.id, P.encode(P.T.LEAVE, this._nextSeq(), { id }, q.id));
            }
            this._emitState();
          }
        }
      } else if (this.hostId) {
        const h = this.peers.get(this.hostId);
        if (h && now - h.lastSeen > PEER_TIMEOUT) {
          this._log('房主掉线了');
          this.emit('error', { code: 'host-lost', message: '房主掉线了' });
          this.leave();
          return;
        }
      }

      // 给每个已知 peer 发心跳
      for (const p of this.peers.values()) {
        const seq = p.meter.next();
        this._sendTo(p.id, P.encode(P.T.PING, seq, { ts: now, from: this.selfId }, p.id));
      }
      for (const p of this.peers.values()) p.meter.sweep();
      this._emitState();
    }, PING_MS);

    if (this.role === 'host') {
      this._statsTimer = setInterval(() => {
        if (!this.active) return;
        const rows = [
          { id: this.selfId, rtt: 0, loss: 0 },
          ...[...this.peers.values()].map((p) => ({ id: p.id, ...p.meter.stats() }))
        ];
        for (const p of this.peers.values()) {
          this._sendTo(p.id, P.encode(P.T.STATS, this._nextSeq(), { rows }, p.id));
        }
      }, STATS_MS);
    }
  }

  _stopTimers() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
  }

  /* ============================================================
   *  游戏隧道（TCP over UDP）
   * ============================================================ */

  /** 房主侧：客人开了连接 → 我连本机游戏端口，两头泵 */
  _hostOpenConn(connId, peerId) {
    if (!this.gamePort) return;
    if (this.conns.has(connId)) return;
    const socket = net.connect(this.gamePort, '127.0.0.1');
    const rec = { socket, peerId, local: false };
    this.conns.set(connId, rec);
    socket.on('connect', () => { this._log(`隧道已接上本机游戏端口 ${this.gamePort}`); });
    socket.on('data', (d) => {
      this._sendTo(peerId, P.encodeData(this._nextSeq(), connId, d, peerId));
    });
    const close = () => {
      if (!this.conns.has(connId)) return;
      this.conns.delete(connId);
      this._sendTo(peerId, P.encodeConn(P.T.CLOSE, this._nextSeq(), connId, { from: this.selfId }, peerId));
    };
    socket.on('close', close);
    socket.on('error', close);
  }

  /** 客人侧：本机起一个 TCP 监听，游戏连它 → 我通过 UDP 转给房主 */
  async _startGuestTunnel(port) {
    if (!this.hostId) return { ok: false, error: '还不知道房主是谁' };
    return new Promise((res) => {
      const srv = net.createServer((socket) => {
        const connId = crypto.randomInt(1, 0x7ffffffe);
        const rec = { socket, peerId: this.hostId, local: true };
        this.conns.set(connId, rec);
        this._sendTo(this.hostId, P.encodeConn(P.T.OPEN, this._nextSeq(), connId, { from: this.selfId }, this.hostId));
        socket.on('data', (d) => {
          this._sendTo(this.hostId, P.encodeData(this._nextSeq(), connId, d, this.hostId));
        });
        const close = () => {
          if (!this.conns.has(connId)) return;
          this.conns.delete(connId);
          this._sendTo(this.hostId, P.encodeConn(P.T.CLOSE, this._nextSeq(), connId, { from: this.selfId }, this.hostId));
        };
        socket.on('close', close);
        socket.on('error', close);
      });
      srv.on('error', (e) => res({ ok: false, error: (e && e.message) || String(e) }));
      srv.listen(port, '127.0.0.1', () => {
        this.tcpServer = srv;
        this.tunnelOn = true;
        this.tunnelPort = port;
        res({ ok: true, port });
      });
    });
  }

  /** 房主侧其实不用本地监听，这里只是把开关记上 */
  async _startHostTunnel() {
    this.tunnelOn = true;
    this.tunnelPort = this.gamePort;
    return { ok: true };
  }

  _closeConn(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    try { c.socket.destroy(); } catch { }
  }

  /* ============================================================
   *  离开 / 快照
   * ============================================================ */
  leave() {
    if (!this.active) return { ok: true };
    if (this.sock && this.peers.size) {
      for (const p of this.peers.values()) {
        this._sendTo(p.id, P.encode(P.T.LEAVE, this._nextSeq(), { id: this.selfId }, p.id));
      }
    }
    this._reset();
    this._log('已离开房间');
    this.emit('left', {});
    this._emitState();
    return { ok: true };
  }

  _reset() {
    this._stopTimers();
    this._stopKeepAlive();
    if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = null; }
    if (this.tcpServer) { try { this.tcpServer.close(); } catch { } this.tcpServer = null; }
    for (const c of this.conns.values()) { try { c.socket.destroy(); } catch { } }
    this.conns.clear();
    if (this.sock) { try { this.sock.close(); } catch { } this.sock = null; }
    this.peers.clear();
    this.active = false;
    this.selfId = 0;
    this.hostId = 0;
    this.tunnelOn = false;
    this.tunnelPort = 0;
    this.statsTable = [];
    this._bound = false;
  }

  /** 房间聊天。name 由渲染层每条带上（主进程不存昵称） */
  chat(text, name) {
    if (!this.active) return { ok: false, error: '不在房间里' };
    const body = { text: String(text || '').slice(0, 500), from: this.selfId, name: String(name || this.myName).slice(0, 24) };
    if (this.mode === 'relay') this._send(P.encode(P.T.CHAT, this._nextSeq(), body, 0), this.remote);
    else for (const p of this.peers.values()) this._sendTo(p.id, P.encode(P.T.CHAT, this._nextSeq(), body, p.id));
    return { ok: true };
  }

  /** 给界面用的快照（IPC 传得动，且不含任何内部对象） */
  snapshot() {
    const table = this.statsTable || [];
    const rows = [...this.peers.values()].map((p) => {
      const st = p.meter.stats();
      const fromTable = table.find((r) => r.id === p.id);
      return {
        id: p.id, name: p.name, isHost: p.id === this.hostId, isMe: p.id === this.selfId,
        rtt: st.rtt || (fromTable ? fromTable.rtt : 0),
        loss: st.loss || (fromTable ? fromTable.loss : 0),
        via: this.mode === 'relay' ? 'relay' : 'direct'
      };
    });
    // 自己的那一行：取所有对端里最差的一条（连房主的那条优先）
    const mine = (() => {
      const host = rows.find((r) => r.isHost);
      const worst = rows.reduce((a, b) => ((b.rtt || 0) > (a.rtt || 0) ? b : a), { rtt: 0, loss: 0 });
      return host || worst || { rtt: 0, loss: 0 };
    })();
    return {
      active: this.active,
      mode: this.mode,
      role: this.role,
      name: this.name,
      game: this.game,
      gamePort: this.gamePort,
      code: this.code,
      selfId: this.selfId,
      hostId: this.hostId,
      publicAddr: this.publicAddr,
      localPort: this.localPort,
      tunnelOn: this.tunnelOn,
      tunnelPort: this.tunnelPort,
      /** 我自己的链路质量 —— 界面上"账号旁边"那两个数就取这个 */
      rtt: mine.rtt || 0,
      loss: mine.loss || 0,
      members: [
        { id: this.selfId, name: this.myName, isHost: this.role === 'host', isMe: true, rtt: 0, loss: 0, via: this.mode || '' },
        ...rows
      ]
    };
  }
}

module.exports = { NetRoom, PingMeter, PORT_MIN, PORT_MAX };
