/**
 * ============================================================
 *  GameHub - 联机页面  (js/netview.js)
 * ------------------------------------------------------------
 *  三种联机方式，各解决一种网络处境：
 *
 *   ① 内网穿透 —— 樱花联机 / frp / 花生壳 这类工具你自己在跑，
 *      GameHub 只负责把「域名:端口」包装成房间码、测一下通不通。
 *   ② P2P 直连 —— 先体检（公网 IPv6？公网 IPv4？在不在 NAT 后面？），
 *      过了才开放；建房后以**房间码**分享，码里不写密码、外面看不出端口；
 *      加入后每秒实测延迟与丢包，显示在房间成员旁边。
 *   ③ 中转站   —— 玩家自己提供服务器（tools/relay-server.js 可直接跑），
 *      GameHub **不提供任何官方中转站**，也不为陌生地址/码负责。
 *
 *  界面上刻意做了两件事：
 *    · 顶部标题栏常驻一枚「延迟 · 丢包」徽标 —— 切到别的页面也看得到，
 *      不用专门回联机页才知道自己卡不卡。
 *    · 每种模式都把"它做不到什么"写在卡片上，别让人踩空。
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const API = window.API;
  const { el } = U;

  /* ================================================================
   *  模块内状态
   * ================================================================ */

  /** 当前选中的模式：tunnel | p2p | relay */
  let mode = 'tunnel';
  /** 网络体检结果（null = 还没体检） */
  let probe = null;
  let probing = false;
  /** 当前房间快照（null = 不在房间里） */
  let room = null;
  /** 日志（最新的在上面） */
  const logs = [];
  /** 聊天 */
  const chatLines = [];
  /**
   * 昵称（成员表「账号」列和聊天里显示的名字）。
   * 存 localStorage —— 这是个本地偏好，不值得动全局设置 schema；
   * 进房间时随 HELLO 带过去，中途改的话聊天立刻生效、成员表要重进才换。
   */
  let nickname = '';
  try { nickname = localStorage.getItem('gamehub.net.nickname') || ''; } catch { }
  /** 已订阅主进程事件（只订阅一次） */
  let wired = false;
  /** 上一次渲染出来的根节点，用来判断要不要整体重画 */
  let mounted = null;

  const MODES = [
    {
      id: 'tunnel', icon: '🛰', title: '内网穿透', sub: '樱花联机 / frp / 花生壳',
      desc: '你在穿透工具里已经把游戏端口映射到了一个公网地址，把地址填进来，GameHub 帮你封装成房间码、验一下通不通。',
      cant: '穿透这件事本身 GameHub 不做 —— 地址要从你自己的穿透工具里拿。'
    },
    {
      id: 'p2p', icon: '⚡', title: 'P2P 直连', sub: '自动体检 · 房间码分享',
      desc: '先体检本机网络，确认有公网 IPv6 或公网 IPv4 才开放建房。房间以**码**分享，端口不直接写在群里。',
      cant: '对称型 NAT / 运营商大内网打不了洞 —— 体检会直接告诉你，那时请换穿透或中转站。'
    },
    {
      id: 'relay', icon: '🔁', title: '中转站', sub: '自备服务器 · 不提供官方中转站',
      desc: '填一台你自己（或朋友）跑着中转站的服务器地址，连上后生成码，别人输码就能一起进这个中转房间。',
      cant: 'GameHub 不提供任何公共中转站；陌生地址与陌生码请自己判断，后果自负。'
    }
  ];

  /* ================================================================
   *  小工具
   * ================================================================ */
  function log(msg, kind = 'info') {
    logs.unshift({ t: Date.now(), msg: String(msg), kind });
    if (logs.length > 60) logs.pop();
    paintLogs();
  }

  function toast(msg, type) { if (window.App && window.App.toast) window.App.toast(msg, type || 'info'); }

  /** 延迟 → 颜色（红=差，绿=好；这里只是质量色，跟股票涨跌无关） */
  function rttClass(ms) {
    if (!ms && ms !== 0) return '';
    if (ms < 60) return 'good';
    if (ms < 180) return 'mid';
    return 'bad';
  }
  function lossClass(p) {
    if (!p) return 'good';
    if (p < 0.05) return 'good';
    if (p < 0.2) return 'mid';
    return 'bad';
  }
  const pct = (p) => `${Math.round((p || 0) * 1000) / 10}%`;

  /** 顶部标题栏那枚徽标 */
  function paintBadge() {
    const b = document.getElementById('netBadge');
    if (!b) return;
    if (!room || !room.active) { b.hidden = true; b.className = 'tb-net-badge'; b.textContent = ''; return; }
    const cls = rttClass(room.rtt);
    b.hidden = false;
    b.className = `tb-net-badge ${cls}`;
    b.textContent = `${room.rtt || 0}ms · 丢包 ${pct(room.loss)}`;
    b.title = `联机中「${room.name}」：延迟 ${room.rtt || 0}ms，丢包 ${pct(room.loss)}`;
  }

  async function copyText(t, what) {
    if (!t) { toast('没有可复制的内容', 'warn'); return; }
    try { await navigator.clipboard.writeText(t); toast(`${what || '内容'}已复制`, 'success'); }
    catch { toast('复制失败', 'error'); }
  }

  /** "xxx.frp.cn:12345" → { host, port }；也认 [IPv6]:端口 */
  function splitAddr(s) {
    const t = String(s || '').trim();
    if (!t) return { host: '', port: 0 };
    const m6 = t.match(/^\[(.+?)\]:(\d+)$/);
    if (m6) return { host: m6[1], port: Number(m6[2]) };
    const i = t.lastIndexOf(':');
    if (i > 0 && /^\d+$/.test(t.slice(i + 1))) {
      return { host: t.slice(0, i), port: Number(t.slice(i + 1)) };
    }
    return { host: t, port: 0 };
  }

  /* ================================================================
   *  渲染
   * ================================================================ */
  function render(body) {
    mounted = body;
    body.innerHTML = '';
    body.classList.add('net-body');

    /* 两栏布局（照主人画的草图）：
     *   左栏 = 原本的联机操作区（模式卡 + 表单 + 日志）
     *   右栏 = 房间信息区，常驻 —— 成员表（账号/延迟/丢包）+ 聊天框
     * 右栏常驻的意义：不管你切到哪种模式、有没有进房间，
     * 都能一眼看到"现在房间里谁在、卡不卡"，聊天也不用翻页面找。 */
    const layout = el('div', { class: 'net-layout' });
    const main = el('div', { class: 'net-main' });
    const side = el('div', { class: 'net-side' });

    main.appendChild(modePicker());
    main.appendChild(testNotice());
    if (room && room.active) main.appendChild(roomReadyCard());
    else main.appendChild(formCard());
    main.appendChild(logCard());

    side.appendChild(sideStatus());
    side.appendChild(sideMembers());
    side.appendChild(sideChat());

    layout.appendChild(main);
    layout.appendChild(side);
    body.appendChild(layout);

    wireEvents();
    // 第一次进来顺手体检一次（穿透模式不需要，但结论留着总有用）
    if (!probe && !probing) runProbe(true);
    else paintProbe();
    paintBadge();
    paintLogs();
    paintChat();
  }

  /* ---------------- 模式选择 ---------------- */
  function modePicker() {
    const cards = MODES.map((m) => el('button', {
      class: 'net-mode' + (m.id === mode ? ' active' : ''),
      dataset: { mode: m.id },
      onclick: () => { mode = m.id; render(mounted); }
    }, [
      el('div', { class: 'nm-head' }, [
        el('span', { class: 'nm-icon', text: m.icon }),
        el('span', { class: 'nm-title', text: m.title }),
        el('span', { class: 'nm-sub', text: m.sub })
      ]),
      el('div', { class: 'nm-desc', text: m.desc }),
      el('div', { class: 'nm-cant' }, [
        el('span', { class: 'nm-cant-tag', text: '做不到' }),
        el('span', { text: m.cant })
      ])
    ]));
    return el('div', { class: 'net-modes' }, cards);
  }

  /* ---------------- 坦诚书：这功能没经过真实网络验证 ----------------
   * 写在界面上而不只是文档里 —— 文档没人翻，但每个来用联机的人都会看到这一行。
   * 提前说清楚"连不上是正常的"，比事后让人以为是自己配置错了要强。 */
  function testNotice() {
    return el('div', { class: 'net-notice' }, [
      el('span', { class: 'nn-icon', text: '⚠' }),
      el('span', { class: 'nn-text' }, [
        el('b', { text: '联机功能没有经过真实网络验证。' }),
        document.createTextNode('它只在一台机器的 127.0.0.1 上跑通过，没在两台真实电脑、跨运营商的环境里试过，也没测过任何一款真实游戏 —— 连不上、延迟高、隧道不通都是正常现象，欢迎提。有问题请把下面的「联机日志」贴出来。')
      ])
    ]);
  }

  /* ---------------- 表单区 ---------------- */
  function formCard() {
    const card = el('div', { class: 'net-card' });
    card.appendChild(el('div', { class: 'nc-head' }, [
      el('div', { class: 'nc-title', text: mode === 'tunnel' ? '内网穿透联机' : mode === 'p2p' ? 'P2P 直连联机' : '中转站联机' }),
      el('div', { class: 'nc-sub', text: mode === 'tunnel' ? '把穿透工具给你的地址变成一张可以发出去的房间码' : mode === 'p2p' ? '先体检，过了才开房' : '连你自己的中转站' })
    ]));

    if (mode === 'p2p') card.appendChild(probeBlock());
    if (mode === 'tunnel') card.appendChild(tunnelForm());
    if (mode === 'p2p') card.appendChild(p2pForm());
    if (mode === 'relay') card.appendChild(relayForm());

    card.appendChild(joinBlock());
    return card;
  }

  /* ---------------- 体检 ---------------- */
  function probeBlock() {
    return el('div', { class: 'net-probe', id: 'netProbe' });
  }

  function paintProbe() {
    const box = document.getElementById('netProbe');
    if (!box) return;
    box.innerHTML = '';
    if (probing) {
      box.appendChild(el('div', { class: 'np-busy' }, [
        el('span', { class: 'np-spin', text: '◌' }),
        el('span', { text: '正在体检：查本机地址 + 向 STUN 服务器发探测包…' })
      ]));
      return;
    }
    if (!probe || probe.ok === false) {
      box.appendChild(el('div', { class: 'np-empty' }, [
        el('div', { text: '还没体检。体检是纯 UDP 出站，不会上传任何东西。' }),
        el('button', { class: 'btn btn-primary', text: '开始体检', onclick: () => runProbe(false) })
      ]));
      return;
    }
    const v = probe.verdict;
    const verdictText = { 'ipv6-ok': '可以直连（IPv6）', 'p2p-ok': '可以直连（公网 IPv4）', 'limited': '直连多半不通' }[v] || v;
    const cls = v === 'limited' ? 'bad' : 'good';

    const items = [
      ['公网 IPv6', probe.hasGlobalIPv6 ? `有 · ${probe.addrs.globalIPv6[0]}` : '没有', probe.hasGlobalIPv6],
      ['公网 IPv4', probe.isPublicIPv4 ? `有 · ${probe.addrs.globalIPv4[0]}` : '没有（在局域网/大内网里）', probe.isPublicIPv4],
      ['NAT 出口', probe.stun ? `${probe.stun.ip}:${probe.stun.port}` : '探测不到', !!probe.stun],
      ['本机内网地址', (probe.addrs.privateIPv4 || []).join(' / ') || '无', null]
    ];

    box.appendChild(el('div', { class: `np-verdict ${cls}` }, [
      el('span', { class: 'np-vdot' }),
      el('span', { class: 'np-vtext', text: verdictText }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '重新体检', onclick: () => runProbe(false) })
    ]));
    box.appendChild(el('div', { class: 'np-advice', text: probe.advice || '' }));
    box.appendChild(el('div', { class: 'np-grid' }, items.map(([k, val, good]) => el('div', { class: 'np-item' }, [
      el('span', { class: 'np-k', text: k }),
      el('span', { class: 'np-v' + (good === null ? '' : good ? ' good' : ' bad'), text: val })
    ]))));
  }

  async function runProbe(silent) {
    probing = true;
    paintProbe();
    const r = await API.netProbe();
    probing = false;
    if (r && r.ok !== false) probe = r;
    else if (!silent) toast((r && r.error) || '体检失败', 'error');
    paintProbe();
    // 体检结果会影响"能不能建房"和默认地址族，顺带刷一次表单
    if (mode === 'p2p' && mounted) {
      const f = document.getElementById('netP2pForm');
      if (f) f.replaceWith(p2pForm());
    }
  }

  /* ---------------- 内网穿透表单 ---------------- */
  function tunnelForm() {
    const name = el('input', { class: 'input', id: 'tnName', placeholder: '房间名，比如「周末帕鲁车」', value: '联机房间' });
    const addr = el('input', { class: 'input', id: 'tnAddr', placeholder: 'xxx.frp.cn:12345 或 1.2.3.4:12345' });
    const gamePort = el('input', { class: 'input', id: 'tnGamePort', type: 'number', placeholder: '可选' });
    const out = el('div', { class: 'tn-out', id: 'tnOut' });

    const gen = async () => {
      const { host, port } = splitAddr(addr.value);
      if (!host || !port) { toast('地址要带端口，写成 域名:端口', 'warn'); return; }
      const r = await API.netTunnelCode({
        name: name.value || '联机房间', host, port,
        gamePort: Number(gamePort.value) || 0, game: ''
      });
      if (!r || r.ok === false) { toast((r && r.error) || '生成失败', 'error'); return; }
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'code-box' }, [
        el('div', { class: 'cb-label', text: `房间码 · ${r.info.name}` }),
        el('div', { class: 'cb-code', id: 'tnCode', text: r.code }),
        el('div', { class: 'cb-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', text: '复制房间码', onclick: () => copyText(r.code, '房间码') }),
          el('button', { class: 'btn btn-ghost btn-sm', text: '复制地址', onclick: () => copyText(`${host}:${port}`, '地址') })
        ])
      ]));
      log(`已为 ${host}:${port} 生成内网穿透房间码`, 'ok');
    };

    const test = async () => {
      const { host, port } = splitAddr(addr.value);
      if (!host || !port) { toast('先填地址', 'warn'); return; }
      out.innerHTML = '';
      out.appendChild(el('div', { class: 'np-busy' }, [el('span', { class: 'np-spin', text: '◌' }), el('span', { text: `正在连 ${host}:${port} …` })]));
      const r = await API.netTestAddr({ host, port });
      out.innerHTML = '';
      out.appendChild(el('div', { class: `tn-test ${r && r.ok ? 'good' : 'bad'}` }, [
        el('span', { class: 'tt-icon', text: r && r.ok ? '✓' : '✕' }),
        el('span', { text: r && r.ok ? `通了（${r.ms}ms）· 这个地址能连上` : (r && r.error) || '连不上' })
      ]));
      if (r && r.ok) log(`${host}:${port} 连通，${r.ms}ms`, 'ok');
      else log(`${host}:${port} 连不上：${(r && r.error) || '未知'}`, 'err');
    };

    return el('div', { class: 'net-form', id: 'netTunnelForm' }, [
      field('房间名', name, '给别人看的名字，会写进房间码'),
      field('穿透地址', addr, '从樱花联机 / frp / 花生壳那里拿到的公网地址，带端口'),
      field('游戏端口', gamePort, '选填，只写在码里做备忘，不影响连接'),
      el('div', { class: 'nf-actions' }, [
        el('button', { class: 'btn btn-primary', text: '生成房间码', onclick: gen }),
        el('button', { class: 'btn btn-ghost', text: '测试连通性', onclick: test }),
        el('button', {
          class: 'btn btn-ghost', text: '打开樱花联机',
          onclick: () => API.openUrl ? API.openUrl('https://www.sakurafrp.com/') : null
        })
      ]),
      out,
      el('div', { class: 'nf-tip' }, [
        el('span', { class: 'nf-tip-tag', text: '流程' }),
        el('span', { text: '在穿透工具里把游戏的联机端口映射出去 → 拿到 域名:端口 填到上面 → 生成房间码发给朋友 → 朋友在下面「加入房间」里输码，GameHub 会告诉他地址。' })
      ])
    ]);
  }

  /* ---------------- P2P 表单 ---------------- */
  function p2pForm() {
    const ready = probe && probe.p2pReady;
    const name = el('input', { class: 'input', id: 'p2pName', placeholder: '房间名，比如「周末帕鲁车」' });
    const pass = el('input', { class: 'input', id: 'p2pPass', type: 'password', placeholder: '可留空 = 不设密码' });
    const game = el('input', { class: 'input', id: 'p2pGame', placeholder: '可留空' });
    const gamePort = el('input', { class: 'input', id: 'p2pGamePort', type: 'number', placeholder: '比如 7777' });
    const family = el('select', { class: 'input', id: 'p2pFamily' }, [
      el('option', { value: 'auto', text: '自动（有 IPv6 优先走 IPv6）' }),
      el('option', { value: 'ipv6', text: '只用 IPv6' }),
      el('option', { value: 'ipv4', text: '只用 IPv4' })
    ]);
    const manualHost = el('input', { class: 'input', id: 'p2pManualHost', placeholder: '留空 = 让 GameHub 自己探测' });
    const tunnel = el('input', { type: 'checkbox', id: 'p2pTunnel' });

    const start = async () => {
      if (!name.value.trim()) { toast('先给房间起个名', 'warn'); return; }
      log('正在建房…');
      const r = await API.netHost({
        mode: 'p2p', name: name.value.trim(), pass: pass.value,
        myName: nickname || '玩家',
        game: game.value.trim(), gamePort: Number(gamePort.value) || 0,
        family: family.value, tunnel: tunnel.checked,
        publicHost: manualHost.value.trim() || null
      });
      if (!r || r.ok === false) { toast((r && r.error) || '建房失败', 'error'); log(`建房失败：${(r && r.error) || '未知'}`, 'err'); return; }
      log(`房间已开：${r.publicAddr.ip}:${r.publicAddr.port}（${r.publicAddr.kind}）`, 'ok');
      if (r.advice) log(r.advice, 'info');
      await refreshRoom();
      if (mounted) render(mounted);
    };

    return el('div', { class: 'net-form', id: 'netP2pForm' }, [
      !ready ? el('div', { class: 'nf-warn' }, [
        el('span', { class: 'nf-warn-icon', text: '⚠' }),
        el('span', {
          text: probe
            ? '体检结论是「直连多半不通」。你仍然可以试着建，但大概率连不上 —— 更稳的是内网穿透或中转站。'
            : '还没体检。建P2P房之前建议先体检一次，免得对着一个连不进来的房间码发呆。'
        })
      ]) : null,
      field('房间名', name, '会写进房间码，密码不会'),
      field('房间密码', pass, '密码只在你本机参与校验，永远不上网、也不进码'),
      el('div', { class: 'nf-row' }, [
        field('游戏（选填）', game, ''),
        field('游戏端口', gamePort, '要开「游戏隧道」时才需要')
      ]),
      field('走哪张网', family, 'IPv6 直连成功率最高；IPv4 要看 NAT 类型'),
      field('手动指定外网地址', manualHost, '你在路由器上做了端口映射 / DMZ 的话填这个，GameHub 就不再自己去探测'),
      el('label', { class: 'nf-check' }, [
        tunnel,
        el('span', { text: '开游戏隧道（把本机游戏端口通过 UDP 转给房主 —— 实验特性）' })
      ]),
      el('div', { class: 'nf-actions' }, [
        el('button', { class: 'btn btn-primary btn-lg', text: '开始联机（建房）', onclick: start })
      ]),
      el('div', { class: 'nf-tip' }, [
        el('span', { class: 'nf-tip-tag', text: '分享' }),
        el('span', { text: '建好房之后界面上会出现房间码 —— 把码发给朋友即可。码里只有地址和端口，没有密码；密码请另外单独告诉他。' })
      ])
    ]);
  }

  /* ---------------- 中转站表单 ---------------- */
  function relayForm() {
    const relay = el('input', { class: 'input', id: 'rlAddr', placeholder: '1.2.3.4:40000' });
    const name = el('input', { class: 'input', id: 'rlName', placeholder: '房间名' });
    const pass = el('input', { class: 'input', id: 'rlPass', type: 'password', placeholder: '可留空 = 不设密码' });
    const gamePort = el('input', { class: 'input', id: 'rlGamePort', type: 'number', placeholder: '比如 7777' });
    const tunnel = el('input', { type: 'checkbox', id: 'rlTunnel' });

    const start = async () => {
      const { host, port } = splitAddr(relay.value);
      if (!host || !port) { toast('中转站地址要带端口', 'warn'); return; }
      if (!name.value.trim()) { toast('先给房间起个名', 'warn'); return; }
      log(`正在连接中转站 ${host}:${port} …`);
      const r = await API.netHost({
        mode: 'relay', name: name.value.trim(), pass: pass.value,
        myName: nickname || '玩家',
        gamePort: Number(gamePort.value) || 0, tunnel: tunnel.checked,
        relayHost: host, relayPort: port
      });
      if (!r || r.ok === false) { toast((r && r.error) || '连不上中转站', 'error'); log(`连不上：${(r && r.error) || '未知'}`, 'err'); return; }
      log('已挂到中转站上', 'ok');
      await refreshRoom();
      if (mounted) render(mounted);
    };

    return el('div', { class: 'net-form', id: 'netRelayForm' }, [
      field('中转站地址', relay, '你自己跑起来的那台机器：IP 或域名 + 端口（UDP）'),
      field('房间名', name, '同一台中转站上靠「房间名 + 密码」区分房间'),
      field('房间密码', pass, '不知道密码的人会落进另一个空房间，进不来你这里'),
      field('游戏端口', gamePort, '要开「游戏隧道」时才需要'),
      el('label', { class: 'nf-check' }, [tunnel, el('span', { text: '开游戏隧道（实验）' })]),
      el('div', { class: 'nf-actions' }, [
        el('button', { class: 'btn btn-primary btn-lg', text: '连上中转站并建房', onclick: start })
      ]),
      el('div', { class: 'nf-disclaim' }, [
        el('div', { class: 'nd-title', text: '⚠ 先说清楚' }),
        el('div', {
          text: 'GameHub 不提供任何官方中转站。中转站服务器由玩家自己准备、自己分享：把 tools/relay-server.js 拷到一台有公网 IP 的机器上，`node relay-server.js 40000` 就能跑（记得放行 UDP 端口）。中转站看得到转发了哪些字节，但解不开游戏内容 —— 即便如此，也不要连陌生人给你的地址，GameHub 不为任何陌生链接与房间码负责。'
        }),
        el('div', { class: 'nf-actions' }, [
          el('button', {
            class: 'btn btn-ghost btn-sm', text: '复制中转站启动命令',
            onclick: () => copyText('node relay-server.js 40000 8', '启动命令')
          })
        ])
      ])
    ]);
  }

  /* ---------------- 加入房间 ---------------- */
  function joinBlock() {
    const code = el('textarea', { class: 'input net-code-in', id: 'joinCode', rows: 3, placeholder: '把朋友发来的房间码粘到这里（GHNET1-…）' });
    const pass = el('input', { class: 'input', id: 'joinPass', type: 'password', placeholder: '房间密码（对方没设就不用填）' });
    const tunnelPort = el('input', { class: 'input', id: 'joinTunnelPort', type: 'number', placeholder: '留空 = 用码里的游戏端口' });
    const tunnel = el('input', { type: 'checkbox', id: 'joinTunnel' });
    const out = el('div', { class: 'jn-out', id: 'joinOut' });

    const peek = async () => {
      const r = await API.netParse(code.value);
      out.innerHTML = '';
      if (!r || r.ok === false) {
        out.appendChild(el('div', { class: 'jn-peek bad', text: (r && r.error) || '这码看不懂' }));
        return;
      }
      const i = r.info;
      const label = { p2p: 'P2P 直连', relay: '中转站', tunnel: '内网穿透' }[i.mode] || i.mode;
      out.appendChild(el('div', { class: 'jn-peek good' }, [
        el('div', { class: 'jp-title', text: `${label} · ${i.name}` }),
        el('div', { class: 'jp-line', text: `地址：${i.host}:${i.port}` }),
        i.gamePort ? el('div', { class: 'jp-line', text: `游戏端口：${i.gamePort}` }) : null,
        el('div', { class: 'jp-line', text: i.hasPass ? '这个房间设了密码，需要问房主要' : '这个房间没有密码' }),
        i.mode === 'tunnel' ? el('div', { class: 'jp-tip', text: '这是内网穿透的码 —— 直接用里面的地址连就行，不需要「加入」。' }) : null
      ]));
    };

    const join = async () => {
      const c = code.value.trim();
      if (!c) { toast('先把房间码粘进来', 'warn'); return; }
      log('正在加入房间…');
      const r = await API.netJoin({
        code: c, pass: pass.value, myName: nickname || '玩家',
        tunnel: tunnel.checked,
        tunnelPort: Number(tunnelPort.value) || 0
      });
      if (!r || r.ok === false) { toast((r && r.error) || '加入失败', 'error'); log(`加入失败：${(r && r.error) || '未知'}`, 'err'); return; }
      log('已加入房间', 'ok');
      await refreshRoom();
      if (mounted) render(mounted);
    };

    return el('div', { class: 'net-join' }, [
      el('div', { class: 'nj-head' }, [
        el('div', { class: 'nj-title', text: '加入房间' }),
        el('div', { class: 'nj-sub', text: '输码加入 —— 码里带 CRC 自校验，复制漏了尾巴会直接报"码无效"' })
      ]),
      field('房间码', code, ''),
      el('div', { class: 'nf-row' }, [
        field('房间密码', pass, ''),
        field('隧道端口', tunnelPort, '要开隧道时，本机监听哪个端口')
      ]),
      el('label', { class: 'nf-check' }, [tunnel, el('span', { text: '开游戏隧道（实验）' })]),
      el('div', { class: 'nf-actions' }, [
        el('button', { class: 'btn btn-ghost', text: '先看看这码', onclick: peek }),
        el('button', { class: 'btn btn-primary', text: '加入房间', onclick: join })
      ]),
      out
    ]);
  }

  /* ---------------- 房间卡片（左栏：房间就绪后的简要状态） ----------------
   * 成员表和聊天挪到右栏常驻了，这里只留"房间本身"的信息：
   * 房间码、隧道状态、离开按钮 —— 这些是"操作"，跟右栏的"状态"分开。 */
  function roomReadyCard() {
    const r = room;
    const modeLabel = { p2p: 'P2P 直连', relay: '中转站', tunnel: '内网穿透' }[r.mode] || r.mode;
    const card = el('div', { class: 'net-card net-room' });

    card.appendChild(el('div', { class: 'nc-head' }, [
      el('div', { class: 'nc-title' }, [
        el('span', { text: r.name || '联机房间' }),
        el('span', { class: 'nr-tag', text: modeLabel }),
        el('span', { class: 'nr-tag soft', text: r.role === 'host' ? '我是房主' : '我是客人' })
      ]),
      el('div', { class: 'nc-sub', text: r.publicAddr ? `${r.publicAddr.kind} · ${r.publicAddr.ip}:${r.publicAddr.port}` : '' })
    ]));

    /* ---- 房间码 ---- */
    if (r.code) {
      card.appendChild(el('div', { class: 'code-box' }, [
        el('div', { class: 'cb-label', text: '房间码 · 发给朋友让他加入' }),
        el('div', { class: 'cb-code', text: r.code }),
        el('div', { class: 'cb-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', text: '复制房间码', onclick: () => copyText(r.code, '房间码') })
        ])
      ]));
    }

    /* ---- 游戏隧道状态 ---- */
    card.appendChild(el('div', { class: 'nf-tip' }, [
      el('span', { class: 'nf-tip-tag', text: '隧道' }),
      el('span', {
        text: r.tunnelOn
          ? `已开：${r.role === 'guest' ? `本机 127.0.0.1:${r.tunnelPort} → 房主的游戏端口 ${r.gamePort}` : `转发到本机游戏端口 ${r.gamePort}`}（实验特性）`
          : '没开。建房/加入时勾选「开游戏隧道」即可。'
      })
    ]));

    /* ---- 离开 ---- */
    card.appendChild(el('div', { class: 'nf-actions' }, [
      el('button', {
        class: 'btn btn-danger', text: '离开房间',
        onclick: async () => {
          await API.netLeave();
          room = null;
          chatLines.length = 0;
          log('已离开房间', 'info');
          if (mounted) render(mounted);
        }
      })
    ]));
    return card;
  }

  /* ================================================================
   *  右栏：房间信息区（常驻）
   * ================================================================ */

  /** 顶部：房间状态 + 我的延迟/丢包 + 昵称 */
  function sideStatus() {
    const card = el('div', { class: 'net-card ns-card', id: 'nsStatus' });
    const inRoom = !!(room && room.active);

    card.appendChild(el('div', { class: 'nc-head' }, [
      el('div', { class: 'nc-title', text: inRoom ? '房间状态' : '还没联机' }),
      el('div', { class: 'nc-sub', id: 'nsSub', text: inRoom ? (room.name || '') : '进房间后这里显示延迟与丢包' })
    ]));

    /* 昵称 —— 成员表「账号」列和聊天里显示的名字 */
    const nameIn = el('input', {
      class: 'input ns-name', value: nickname,
      placeholder: '玩家',
      onchange: () => {
        nickname = nameIn.value.trim().slice(0, 24);
        try { localStorage.setItem('gamehub.net.nickname', nickname); } catch { }
        log(`昵称已设为「${nickname || '玩家'}」（进房间时生效，聊天立刻用新名字）`, 'info');
      }
    });
    card.appendChild(el('div', { class: 'nf-field' }, [
      el('div', { class: 'nf-label', text: '我的昵称（账号）' }),
      nameIn,
      el('div', { class: 'nf-hint', text: '聊天里立刻生效；成员表要重进房间才换' })
    ]));

    /* 我的延迟 / 丢包 —— 两个大数字，最显眼的位置。
     * ⚠ 数字单独给 id：每秒刷新只改文本，绝不能整卡重画 ——
     *   不然正改昵称打到一半输入框就被清掉了。 */
    card.appendChild(el('div', { class: 'nr-metrics two' }, [
      el('div', { class: `nr-metric ${inRoom ? rttClass(room.rtt) : ''}` }, [
        el('div', { class: 'nrm-label', text: '我的延迟' }),
        el('div', { class: 'nrm-value' }, [
          el('span', { class: 'nrm-num', id: 'nsRtt', text: inRoom ? `${room.rtt || 0}` : '—' }),
          el('span', { class: 'nrm-unit', text: 'ms' })
        ])
      ]),
      el('div', { class: `nr-metric ${inRoom ? lossClass(room.loss) : ''}` }, [
        el('div', { class: 'nrm-label', text: '丢包率' }),
        el('div', { class: 'nrm-value' }, [
          el('span', { class: 'nrm-num', id: 'nsLoss', text: inRoom ? pct(room.loss) : '—' })
        ])
      ])
    ]));

    return card;
  }

  /** 每秒只刷右栏的数字与成员表，绝不动昵称/聊天输入框（会丢焦点） */
  function paintSideStatus() {
    const inRoom = !!(room && room.active);
    const rtt = document.getElementById('nsRtt');
    const loss = document.getElementById('nsLoss');
    if (rtt) rtt.textContent = inRoom ? `${room.rtt || 0}` : '—';
    if (loss) loss.textContent = inRoom ? pct(room.loss) : '—';
    // 颜色等级跟着数字走（改的是卡片 class，不影响里面的输入框）
    const card = document.getElementById('nsStatus');
    if (card) {
      const ms = card.querySelectorAll('.nr-metric');
      if (ms[0]) ms[0].className = `nr-metric ${inRoom ? rttClass(room.rtt) : ''}`;
      if (ms[1]) ms[1].className = `nr-metric ${inRoom ? lossClass(room.loss) : ''}`;
    }
    // 成员表整卡重画是安全的（里面没有输入框）
    const mem = document.getElementById('nsMembers');
    if (mem) mem.replaceWith(sideMembers());
  }

  /** 成员表：账号 | 延迟 | 丢包 */
  function sideMembers() {
    const card = el('div', { class: 'net-card ns-card', id: 'nsMembers' });
    const inRoom = !!(room && room.active);
    const list = inRoom ? (room.members || []) : [];

    card.appendChild(el('div', { class: 'nc-head' }, [
      el('div', { class: 'nc-title', text: `房间成员（${list.length}）` }),
      el('div', { class: 'nc-sub', text: inRoom ? '每秒刷新' : '—' })
    ]));

    /* 表头：账号 / 延迟 / 丢包 */
    card.appendChild(el('div', { class: 'ns-mem-head' }, [
      el('span', { class: 'nsmh-account', text: '账号' }),
      el('span', { class: 'nsmh-col', text: '延迟' }),
      el('span', { class: 'nsmh-col', text: '丢包' })
    ]));

    if (!inRoom) {
      card.appendChild(el('div', { class: 'nl-empty', text: '还没进房间 —— 房间里的人都列在这里' }));
      return card;
    }

    for (const m of list) {
      card.appendChild(el('div', { class: 'nr-mem' + (m.isMe ? ' me' : '') }, [
        el('span', { class: 'nm-dot' + (m.isHost ? ' host' : '') }),
        el('span', { class: 'nr-mem-name', text: m.name || ('成员 ' + m.id) }),
        m.isHost ? el('span', { class: 'nr-mem-tag', text: '房主' }) : null,
        m.isMe ? el('span', { class: 'nr-mem-tag soft', text: '我' }) : null,
        el('span', { class: 'nr-mem-spacer' }),
        el('span', { class: `nr-mem-rtt ${m.isMe ? '' : rttClass(m.rtt)}`, text: m.isMe ? '—' : `${m.rtt || 0}ms` }),
        el('span', { class: `nr-mem-loss ${m.isMe ? '' : lossClass(m.loss)}`, text: m.isMe ? '—' : pct(m.loss) })
      ]));
    }
    return card;
  }

  /** 聊天框（常驻：进房间才能发，没进房间置灰） */
  function sideChat() {
    const card = el('div', { class: 'net-card ns-card ns-chat-card' });
    const inRoom = !!(room && room.active);

    card.appendChild(el('div', { class: 'nc-head' }, [
      el('div', { class: 'nc-title', text: '房间聊天' }),
      el('div', { class: 'nc-sub', text: inRoom ? '回车发送' : '进房间后开放' })
    ]));

    card.appendChild(el('div', { class: 'nr-chat', id: 'nrChat' }));

    const input = el('input', {
      class: 'input', id: 'nrChatInput',
      placeholder: inRoom ? '说点什么…' : '先进房间',
      disabled: !inRoom
    });
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const t = input.value.trim();
      if (!t || !(room && room.active)) return;
      input.value = '';
      const name = nickname || '我';
      chatLines.push({ name, text: t, me: true });
      paintChat();
      await API.netChat(t, name);
    });
    card.appendChild(el('div', { class: 'nr-chat-send' }, [input]));
    return card;
  }

  function metric(label, value, unit, cls) {
    return el('div', { class: `nr-metric ${cls || ''}` }, [
      el('div', { class: 'nrm-label', text: label }),
      el('div', { class: 'nrm-value' }, [
        el('span', { class: 'nrm-num', text: value }),
        unit ? el('span', { class: 'nrm-unit', text: unit }) : null
      ])
    ]);
  }

  /* ---------------- 日志 ---------------- */
  function logCard() {
    return el('div', { class: 'net-card net-logs', id: 'netLogs' });
  }

  function paintLogs() {
    const box = document.getElementById('netLogs');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'nc-head' }, [
      el('div', { class: 'nc-title', text: '联机日志' }),
      el('div', { class: 'nc-sub', text: '连不上时看这里，比猜有用' })
    ]));
    if (!logs.length) {
      box.appendChild(el('div', { class: 'nl-empty', text: '还没有任何动静' }));
      return;
    }
    for (const l of logs) {
      box.appendChild(el('div', { class: `nl-line ${l.kind}` }, [
        el('span', { class: 'nl-time', text: new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false }) }),
        el('span', { class: 'nl-msg', text: l.msg })
      ]));
    }
  }

  function paintChat() {
    const box = document.getElementById('nrChat');
    if (!box) return;
    box.innerHTML = '';
    if (!chatLines.length) {
      box.appendChild(el('div', { class: 'nl-empty', text: '还没有人说话' }));
      return;
    }
    for (const c of chatLines.slice(-60)) {
      box.appendChild(el('div', { class: 'nrc-line' + (c.me ? ' me' : '') }, [
        el('span', { class: 'nrc-name', text: c.name }),
        el('span', { class: 'nrc-text', text: c.text })
      ]));
    }
    box.scrollTop = box.scrollHeight;
  }

  /** 表单里的一行：标签 + 控件 + 说明 */
  function field(label, control, hint) {
    return el('div', { class: 'nf-field' }, [
      el('div', { class: 'nf-label', text: label }),
      control,
      hint ? el('div', { class: 'nf-hint', text: hint }) : null
    ]);
  }

  /* ================================================================
   *  主进程事件
   * ================================================================ */
  async function refreshRoom() {
    const r = await API.netStatus();
    if (r && r.ok && r.room) {
      room = r.room.active ? r.room : null;
      if (r.room.probe) probe = r.room.probe;
    } else {
      room = null;
    }
    paintBadge();
  }

  function wireEvents() {
    if (wired) return;
    wired = true;

    window.GameHub.on('net:state', (s) => {
      if (!s) return;
      const wasActive = !!(room && room.active);
      room = s.active ? s : null;
      if (s.probe) probe = s.probe;
      // 每秒都会收到新快照：只刷右栏和左栏的房间卡，别整页重画（不然输入框会丢焦点）
      if (window.State.view === 'net' && mounted) {
        const active = !!(room && room.active);
        if (active !== wasActive) {
          // 进房 / 掉线 —— 布局形态变了，整页重画一次
          render(mounted);
        } else if (active) {
          // 只刷数字和成员表；昵称 / 聊天输入框动都不动（会丢焦点、丢已打的字）
          const card = mounted.querySelector('.net-room');
          if (card) card.replaceWith(roomReadyCard());
          paintSideStatus();
          paintChat();
        }
      }
      paintBadge();
    });

    window.GameHub.on('net:event', (e) => {
      if (!e) return;
      if (e.kind === 'log') log(e.message, 'info');
      else if (e.kind === 'error') { log(e.message, 'err'); toast(e.message, 'error'); }
      else if (e.kind === 'chat') { chatLines.push({ name: e.name || ('成员 ' + e.from), text: e.text }); paintChat(); }
      else if (e.kind === 'left') { room = null; if (window.State.view === 'net' && mounted) render(mounted); }
    });

    window.GameHub.on('net:probe', (p) => { if (p && p.ok !== false) { probe = p; paintProbe(); } });
  }

  /* ================================================================
   *  对外
   * ================================================================ */
  window.NetView = {
    render,
    /** 给脚本 / 自检用：当前状态一览 */
    snapshot: () => ({ mode, probe, room, logs: logs.slice(0, 10) }),
    setMode: (m) => { mode = m; if (mounted) render(mounted); },
    runProbe: () => runProbe(false)
  };
})();
