/**
 * ============================================================
 *  GameHub - 游戏平台页面  (js/platformview.js)
 * ------------------------------------------------------------
 *  两级结构：
 *    ① 平台总览 —— 逐个平台检测「装没装 / 登没登录」，点进去看它的库
 *    ② 平台库   —— 账号卡 + 游戏网格
 *
 *  这一页要兑现的四条需求：
 *    · 登录后自动拿到账号信息（只读本地文件，不上传）
 *    · 自动刮取账号拥有的游戏，以及时长、成就进度
 *    · 没下载的游戏黑白显示，但仍能点开看详情
 *    · 能下载时用平台自己的协议拉起客户端（steam://install/xxx）
 *
 *  ⚠ 数据口径（务必跟界面文案保持一致，别误导读用户）：
 *    · 成就为 null 表示「本地没有这个游戏的成就缓存」，
 *      跟「0 个成就」完全是两回事 —— 前者必须整块不显示，不能画 0/0。
 *    · Steam 的 appinfo.vdf 只缓存最近见过的约 1500 个 app，
 *      极少数冷门/短时游戏查不到名字，会显示成 "Steam App xxx"。
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const API = window.API;
  /** 详情页共用构件 —— 和「全部游戏」的详情页走同一套，别自己造 */
  const K = window.DetailKit;
  const { el, fmtDuration, fmtBytes, fmtDate, applyGradient, initialOf } = U;

  /**
   * 读一个设置开关。用户没动过这项时按传进来的默认值走
   * （老版本的数据文件里没有这些字段，读出来是 undefined）。
   * @param {string} key
   * @param {boolean} [def=true]
   */
  function pref(key, def = true) {
    const s = window.State && window.State.settings;
    if (!s || s[key] === undefined || s[key] === null) return def;
    return !!s[key];
  }
  /** 设置项：打开「平台总览」时自动同步已登录平台 */
  const autoSync = () => pref('platformAutoSync');

  /* ================================================================
   *  模块内状态
   * ================================================================ */

  /** 平台检测结果（listPlatforms 的返回值） */
  let platformList = [];
  /** 已同步的快照： platformId → snapshot */
  const snapshots = new Map();
  /** 当前展开的平台 id（null = 停在总览） */
  let current = null;
  /**
   * 正在同步中的平台： platformId → Promise。
   *
   * ⚠ 这里有两个必须守住的点：
   *   ① 锁要「按平台」，不能用一个全局布尔 ——
   *      总览页会同时预热 Steam / Epic / Ubisoft，用全局锁后两个会被直接丢掉。
   *   ② 重复请求要**返回同一个 Promise**，不能直接 return ——
   *      预热还没跑完时用户就点进了平台页，如果这里直接返回，
   *      调用方以为同步完了，可快照还没写进去，页面就停在"还没有同步到数据"的空状态。
   */
  const inflight = new Map();

  /** 第二级页面的筛选条件 */
  const filter = { status: 'all', search: '', sort: 'playtime' };

  /**
   * Epic 账号的登录态。
   *
   * 和 Steam 不一样：Steam 的账号是本机客户端登录着就能读到，
   * Epic 必须**用户主动在这边登录一次**才能拿到拥有清单。
   * available = 主进程那边这个功能没初始化出来（一般是环境原因）。
   */
  let epic = { loggedIn: false, available: false, account: null };

  /** 拉一次 Epic 登录态。use it before 任何要用 Epic 登录态的渲染。 */
  async function refreshEpic() {
    try {
      const r = await API.epicStatus();
      epic = { loggedIn: !!(r && r.loggedIn), available: !!(r && r.available), account: (r && r.account) || null };
    } catch {
      // 取不到就当没登录 —— 界面会退化成"只能看本地已安装"，不会崩
      epic = { loggedIn: false, available: false, account: null };
    }
    return epic;
  }

  /* ================================================================
   *  Epic 登录遮罩
   * ------------------------------------------------------------
   *  点「登录」会弹出一个**独立的** Epic 登录窗口。
   *  如果主窗口只是底部状态栏变一行字，用户很容易压根没注意到那个新窗口
   *  （尤其是它没抢到焦点的时候），会以为程序卡死了。
   *  所以这里铺一层遮罩：把话说清楚，并明确告诉用户下一步做什么。
   * ================================================================ */
  const VEIL_ID = 'pfEpicVeil';

  function showLoginVeil() {
    hideLoginVeil();
    document.body.appendChild(el('div', { class: 'pf-veil', id: VEIL_ID }, [
      el('div', { class: 'pf-veil-card' }, [
        el('div', { class: 'pf-veil-spin' }),
        el('div', { class: 'pf-veil-title', text: '正在打开 Epic 登录窗口' }),
        el('div', {
          class: 'pf-veil-desc',
          text: '请在弹出的窗口里用你的 Epic 账号登录。账号密码不会经过 GameHub，'
              + '登录完成后该窗口会自动关闭。'
        }),
        el('div', {
          class: 'pf-veil-hint',
          text: '没看到登录窗口？它可能被挡在后面了，按 Alt+Tab 切过去。'
        })
      ])
    ]));
  }

  function hideLoginVeil() {
    const v = document.getElementById(VEIL_ID);
    if (v) v.remove();
  }

  /**
   * 登录 / 登出 Epic。
   * @param {'login'|'logout'} action
   */
  async function epicAccount(action) {
    if (action === 'logout') {
      const r = await API.epicLogout();
      if (!r || r.ok === false) { toast((r && r.error) || '退出失败', 'error'); return; }
      epic = { ...epic, loggedIn: false, account: null };
      snapshots.delete('epic');        // 快照里还带着账号数据，必须丢掉重新同步
      await sync('epic', () => window.App.renderContent());
      toast('已退出 Epic 账号（本机凭证已清除）', 'success');
      return;
    }

    // 铺遮罩 → 等登录窗关闭 / 登录成功 → 无论成败都要收回遮罩
    showLoginVeil();
    window.App.setStatus('正在打开 Epic 登录页，请在弹出的窗口里完成登录…', 'busy');

    let r = null;
    try {
      r = await API.epicLogin();
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '登录过程出错' };
    } finally {
      hideLoginVeil();
    }

    if (r && r.ok) {
      await refreshEpic();
      snapshots.delete('epic');        // 重来一次，让这一轮数据带上账号清单
      await sync('epic', () => window.App.renderContent());
      toast('Epic 账号登录成功，正在读取拥有清单', 'success');
    } else {
      toast((r && r.error) || 'Epic 登录失败', 'error');
      window.App.setStatus('Epic 登录未完成', 'err');
    }
  }

  /** 平台详情浮层当前展示的游戏 */
  let detailGame = null;
  /* 区块收起状态不用在这里记了 —— 统一放在 js/detailkit.js 里，
     和「全部游戏」的详情页共用，免得这边收起那边还是展开的。 */

  /** 平台图标用的首字母缩写 */
  const SHORT_LABEL = {
    steam: 'Steam', epic: 'E', ubisoft: 'U', gog: 'GOG',
    battlenet: 'B', ea: 'EA', xbox: 'X'
  };

  /* ================================================================
   *  入口：由 app.js 在 view === 'platform' 时调用
   * ================================================================ */
  async function render(host) {
    if (!host) return;
    host.innerHTML = '';

    const page = el('div', { class: 'pf-page' });
    host.appendChild(page);

    // 隐私声明放在最上面 —— 这一页要读平台数据，先把话说清楚
    page.appendChild(privacyBar());

    if (!platformList.length) {
      paintLoading(page, '正在检测本机已安装的游戏平台');
      const r = await API.platformList();
      platformList = (r && r.ok && r.platforms) ? r.platforms : [];
    }

    // Epic 的登录态跟"平台装没装"是两回事，单独取一次
    await refreshEpic();

    // 记住上次打开过哪个平台，切走再回来还在原地
    if (current) renderLibrary(page, current);
    else renderOverview(page);
  }

  /** 隐私声明条幅 */
  function privacyBar() {
    return el('div', { class: 'pf-privacy' }, [
      el('span', { class: 'pf-pv-icon', text: '🔒' }),
      el('div', {}, [
        el('b', { text: '数据只留在本机。' }),
        el('span', {
          text: 'GameHub 只是读取各平台客户端已经存在你电脑上的那份数据（账号名、游戏列表、时长、成就），'
              + '不读取任何密码或登录凭证，不上传到任何服务器，也不会写回平台的文件。'
        })
      ])
    ]);
  }

  function paintLoading(page, text) {
    const old = page.querySelector('.pf-loading');
    if (old) old.remove();
    page.appendChild(el('div', { class: 'pf-loading pf-dots', text }));
  }

  /* ================================================================
   *  ① 平台总览
   * ================================================================ */
  function renderOverview(page) {
    current = null;
    page.querySelectorAll('.pf-crumb, .pf-grid, .pf-account, .pf-toolbar, .pf-games, .pf-empty, .pf-notes, .pf-loading')
      .forEach((n) => n.remove());

    if (!platformList.length) {
      page.appendChild(el('div', { class: 'pf-empty' }, [
        el('div', { class: 'pf-empty-art', text: '🛰' }),
        el('div', { text: '没有检测到任何游戏平台' })
      ]));
      return;
    }

    // 一行说明 + 「重新检测」：
    // 检测结果只在第一次进这一页时算，装了新平台不该非得重启程序才能看到
    const on = platformList.filter((p) => p.detected).length;
    page.appendChild(el('div', { class: 'pf-toolbar' }, [
      el('span', { class: 'pf-crumb-title', text: `本机共检测到 ${on} / ${platformList.length} 个平台` }),
      el('span', { style: { flex: '1' } }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '⟳ 重新检测',
        onclick: async () => {
          const r = await API.platformList();
          if (r && r.ok && r.platforms) platformList = r.platforms;
          window.App.renderContent();
        }
      })
    ]));

    const grid = el('div', { class: 'pf-grid' });
    platformList.forEach((p) => grid.appendChild(platformCard(p)));
    page.appendChild(grid);

    // 已装的平台顺手预热一下快照，用户点进去就不用等。
    // ⚠ 回调里要确认"用户还停在总览页"：
    //   如果这期间他已经点进某个平台了，这里再调 renderOverview 会把导航重置回总览。
    // 设置里关掉「打开总览时自动同步」就不预热了，账号 / 拥有列表等用户点「同步」再读。
    if (autoSync()) {
      platformList.filter((p) => p.detected && p.canSync).forEach((p) => {
        if (!snapshots.has(p.id)) {
          sync(p.id, () => {
            if (current === null && page.isConnected) window.App.renderContent();
          });
        }
      });
    }
  }

  /** 单张平台卡片 */
  function platformCard(p) {
    const snap = snapshots.get(p.id);
    const card = el('div', {
      class: 'pf-card' + (p.detected ? '' : ' is-off'),
      style: { '--pf-color': p.accent || 'var(--accent)' }
    });

    card.appendChild(el('div', { class: 'pf-card-head' }, [
      el('div', { class: 'pf-badge', text: SHORT_LABEL[p.id] || p.short || p.name.slice(0, 2) }),
      el('div', {}, [
        el('div', { class: 'pf-card-name', text: p.name }),
        el('div', {
          class: 'pf-card-sub',
          text: p.detected ? (p.installPath || '已检测到客户端') : '本机未检测到',
          title: p.installPath || ''
        })
      ])
    ]));

    card.appendChild(el('div', {
      class: 'pf-status' + (p.detected ? ' on' : ''),
      text: p.detected ? '已安装' : '未安装'
    }));

    /* ---- 账号区 ---- */
    if (snap && snap.ok && snap.account) {
      card.appendChild(el('div', { class: 'pf-acct' }, [
        avatarImg(snap.account, 34, 'pf-acct-avatar'),
        el('div', {}, [
          el('div', { class: 'pf-acct-name', text: snap.account.name || snap.account.accountName || '已登录' }),
          el('div', {
            class: 'pf-acct-meta',
            text: snap.account.level ? `Steam 等级 ${snap.account.level}` : (snap.account.accountName || '')
          })
        ])
      ]));
    } else if (snap && snap.ok && snap.loggedIn === false) {
      card.appendChild(el('div', { class: 'pf-acct' }, [
        el('div', {
          class: 'pf-acct-none',
          // Epic 现在能在这边登录了，得给句有用的话；其它平台才是真的读不到
          text: (p.id === 'epic' && epic.available && !epic.loggedIn)
            ? '未登录 —— 登录后可显示全部拥有的游戏（含没下载的）'
            : '客户端里登录可见，本地读不到账号名'
        })
      ]));
    } else if (p.detected) {
      card.appendChild(el('div', { class: 'pf-acct' }, [
        el('div', { class: 'pf-acct-none', text: snapshots.has(p.id) ? '同步中…' : '点「同步」读取账号与游戏库' })
      ]));
    }

    /* ---- 统计区 ---- */
    if (snap && snap.ok && snap.stats) {
      const s = snap.stats;
      card.appendChild(el('div', { class: 'pf-card-stats' }, [
        miniStat(String(s.owned || 0), '拥有'),
        miniStat(String(s.installed || 0), '已安装'),
        miniStat(fmtDuration(s.totalPlayMs || 0), '总时长'),
        s.achTotal ? miniStat(`${s.achUnlocked}/${s.achTotal}`, '成就') : null
      ].filter(Boolean)));
    }

    /* ---- 操作区 ---- */
    const actions = el('div', { class: 'pf-card-actions' });
    if (p.detected) {
      actions.appendChild(el('button', {
        class: 'btn btn-primary btn-sm',
        text: snapshots.has(p.id) ? '↻ 重新同步' : '⟳ 同步',
        onclick: async (e) => {
          e.stopPropagation();
          await sync(p.id, () => window.App.renderContent());
        }
      }));
      actions.appendChild(el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '打开客户端',
        onclick: async (e) => {
          e.stopPropagation();
          const r = await API.platformAction({ id: p.id, action: 'open' });
          if (!r || r.ok === false) window.App.toast((r && r.error) || '拉起客户端失败', 'error');
        }
      }));
    }
    // Epic 独有：账号登录。Steam 那边登录态是从本机客户端读的，不需要这一步
    appendEpicButtons(actions, p);
    card.appendChild(actions);

    // 整卡点击 → 进第二级（没检测到的不给点）
    if (p.detected) {
      card.onclick = async () => {
        if (!snapshots.has(p.id)) await sync(p.id);
        current = p.id;
        window.App.renderContent();
      };
    }

    return card;
  }

  /**
   * 给操作区追加 Epic 登录相关的按钮。
   *
   * 只对 Epic 生效 —— Steam / Ubisoft 的登录态是本机客户端登录着就能读到，
   * 不需要用户再授权一次；唯独 Epic 必须在这儿单独登。
   */
  function appendEpicButtons(actions, p) {
    if (p.id !== 'epic' || !epic.available || !p.detected) return;

    if (epic.loggedIn) {
      actions.appendChild(el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '⎋ 退出登录',
        title: '清除本机保存的 Epic 凭证（不影响 Epic 客户端自己的登录状态）',
        onclick: async (e) => { e.stopPropagation(); await epicAccount('logout'); }
      }));
    } else {
      actions.appendChild(el('button', {
        class: 'btn btn-primary btn-sm',
        text: '🔑 登录账号',
        title: '登录后可显示账号里全部拥有的游戏，含领了没下载的',
        onclick: async (e) => { e.stopPropagation(); await epicAccount('login'); }
      }));
    }
  }

  function miniStat(v, k) {
    return el('div', { class: 'pf-mini-stat' }, [
      el('div', { class: 'pf-mini-v', text: v }),
      el('div', { class: 'pf-mini-k', text: k })
    ]);
  }

  /**
   * 头像。
   *
   * ⚠ 这里必须用"首字母打底 + 头像盖上去"的两层结构，不能等 onerror 再换节点：
   *   Steam 的头像存在 avatars.steamstatic.com，本机实测这个域是**连不上**的，
   *   图片会一直卡在 pending 状态（既不加载成功也不报错），
   *   于是页面上只剩下一个空心圆圈 —— 看着就像功能坏了。
   *   首字母铺在底层，头像能出来就盖住它，出不来也至少有东西看。
   */
  function avatarImg(account, size, cls) {
    const url = account && (account.avatarUrl || account.avatarUrlLarge);
    const box = el('div', {
      class: cls,
      style: {
        width: size + 'px', height: size + 'px', flex: 'none',
        borderRadius: '50%', overflow: 'hidden', position: 'relative',
        display: 'grid', placeItems: 'center',
        background: 'var(--bg-4)', border: '1px solid var(--line-2)'
      }
    });

    // 底层：首字母
    box.appendChild(el('span', {
      style: {
        position: 'absolute', inset: '0', display: 'grid', placeItems: 'center',
        fontSize: (size * 0.42) + 'px', fontWeight: '700', color: 'var(--text-2)'
      },
      text: initialOf((account && account.name) || '?')
    }));

    if (url) {
      const img = el('img', {
        src: url, alt: '',
        style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', position: 'relative' }
      });
      // 加载失败就把图片摘掉，露出底下的首字母
      img.addEventListener('error', () => img.remove());
      box.appendChild(img);
    }
    return box;
  }

  /* ================================================================
   *  同步一个平台
   * ================================================================ */
  /**
   * 同步一个平台。同一平台的并发调用共享同一个 Promise。
   * @param {string} id
   * @param {Function} [after] 成功后的回调；不传就整体重绘当前页
   * @returns {Promise<object|null>} 快照
   */
  function sync(id, after) {
    if (inflight.has(id)) return inflight.get(id);

    const p = platformList.find((x) => x.id === id) || { id, name: id };
    window.App.setStatus(`正在读取 ${p.name} 的数据…`, 'busy');

    const task = (async () => {
      try {
        const r = await API.platformSync({ id });
        if (r && r.ok) {
          snapshots.set(id, r);
          if (after) after();
          else window.App.renderContent();
          window.App.setStatus(`${p.name} 同步完成`, 'ok');
          return r;
        }
        toast((r && r.error) || `${p.name} 同步失败`, 'error');
        window.App.setStatus('同步失败', 'err');
        return null;
      } catch (e) {
        toast(`${p.name} 同步出错：${e.message}`, 'error');
        return null;
      } finally {
        inflight.delete(id);
      }
    })();

    inflight.set(id, task);
    return task;
  }

  /** 统一走一遍 App 的提示条，App 不在（极早期调用）时退化成 console */
  function toast(msg, type) {
    if (window.App && window.App.toast) window.App.toast(msg, type);
    else console.warn('[平台]', msg);
  }

  /* ================================================================
   *  ② 平台游戏库
   * ================================================================ */
  function renderLibrary(page, id) {
    const snap = snapshots.get(id);
    const meta = platformList.find((x) => x.id === id) || snap || { id, name: id, accent: 'var(--accent)' };

    page.querySelectorAll('.pf-crumb, .pf-grid, .pf-account, .pf-toolbar, .pf-games, .pf-empty, .pf-notes, .pf-loading')
      .forEach((n) => n.remove());

    /* ---- 面包屑 ---- */
    page.appendChild(el('div', { class: 'pf-crumb' }, [
      el('button', {
        class: 'pf-back', text: '← 平台总览',
        onclick: () => { current = null; window.App.renderContent(); }
      }),
      el('span', { class: 'pf-crumb-title', text: meta.name || id })
    ]));

    if (!snap || !snap.ok) {
      // 正在同步中就别摆"立即同步"按钮了 —— 那会让人以为没在干活，
      // 而且再点一次也只是复用同一个请求，没有任何额外效果。
      const busy = inflight.has(id);
      page.appendChild(el('div', { class: 'pf-empty' }, [
        el('div', { class: 'pf-empty-art', text: busy ? '📡' : '🛰' }),
        el('div', {
          class: busy ? 'pf-dots' : '',
          text: busy ? '正在读取该平台的数据' : ((snap && snap.error) || '还没有同步到这个平台的数据')
        }),
        busy ? null : el('div', {
          class: 'pf-card-actions', style: { justifyContent: 'center', marginTop: '14px' }
        }, [
          el('button', {
            class: 'btn btn-primary', text: '立即同步',
            onclick: () => sync(id, () => window.App.renderContent())
          })
        ])
      ].filter(Boolean)));
      return;
    }

    /* ---- 账号卡 ---- */
    if (snap.account) {
      page.appendChild(accountCard(snap));
    } else if (snap.loggedIn === false) {
      // Epic 独有："没登录"是能解决的 —— 给它一个登录按钮，别只报错
      const actionable = id === 'epic' && epic.available && !epic.loggedIn;
      const notes = [
        el('div', { class: 'pf-note' }, [
          el('span', { class: 'n-ico', text: actionable ? '🔑' : 'ℹ' }),
          el('span', {
            text: actionable
              ? '当前没有登录 Epic 账号，只显示本机已安装的游戏。登录后可看到账号里全部拥有的游戏（含领了没下载的）。'
              : `${meta.name} 的账号信息本地读不到（客户端里可能仍然是登录状态）。已安装的游戏列表不受影响。`
          })
        ])
      ];
      if (actionable) {
        notes.push(el('div', {
          class: 'pf-card-actions',
          style: { justifyContent: 'center', marginTop: '14px' }
        }, [
          el('button', {
            class: 'btn btn-primary',
            text: '登录 Epic 账号',
            onclick: async () => { await epicAccount('login'); }
          })
        ]));
      }
      page.appendChild(el('div', { class: 'pf-notes' }, notes));
    }

    /* ---- 提示区：把"做不到什么"如实说出来 ---- */
    if (Array.isArray(snap.warnings) && snap.warnings.length) {
      page.appendChild(el('div', { class: 'pf-notes' }, snap.warnings.map((w) =>
        el('div', { class: 'pf-note' }, [
          el('span', { class: 'n-ico', text: '⚠' }),
          el('span', { text: w })
        ])
      )));
    }

    /* ---- 工具条 ---- */
    page.appendChild(toolbar(snap, meta));

    /* ---- 游戏网格 ---- */
    const list = visibleGames(snap);
    if (!list.length) {
      page.appendChild(el('div', { class: 'pf-empty' }, [
        el('div', { class: 'pf-empty-art', text: '🔍' }),
        el('div', { text: '没有匹配的游戏' })
      ]));
      return;
    }

    const grid = el('div', { class: 'pf-games size-medium' });
    list.forEach((g) => grid.appendChild(gameCard(g, meta)));
    page.appendChild(grid);
  }

  /** 账号信息大卡 */
  function accountCard(snap) {
    const a = snap.account;
    const s = snap.stats || {};
    return el('div', {
      class: 'pf-account',
      style: { '--pf-color': snap.accent || 'var(--accent)' }
    }, [
      avatarImg(a, 68, 'pf-acct-big'),
      el('div', { class: 'pf-acct-info' }, [
        el('div', { class: 'pf-acct-big-name' }, [
          el('span', { text: a.name || a.accountName || '已登录' }),
          a.level ? el('span', { class: 'pf-level', text: 'Lv.' + a.level }) : null
        ].filter(Boolean)),
        el('div', { class: 'pf-acct-line' }, [
          a.accountName ? el('span', { text: '账号 ' + a.accountName }) : null,
          a.id ? el('span', { text: 'ID ' + a.id }) : null,
          snap.syncedAt ? el('span', { text: '同步于 ' + fmtDate(snap.syncedAt) }) : null
        ].filter(Boolean))
      ]),
      el('div', { class: 'pf-kpis' }, [
        kpi(String(s.owned || 0), '拥有'),
        kpi(String(s.installed || 0), '已安装'),
        kpi(String(s.notInstalled || 0), '未安装'),
        kpi(fmtDuration(s.totalPlayMs || 0), '总时长'),
        s.achTotal ? kpi(`${s.achUnlocked}/${s.achTotal}`, '成就') : null
      ].filter(Boolean))
    ]);
  }

  function kpi(v, k) {
    return el('div', { class: 'pf-kpi' }, [
      el('div', { class: 'pf-kpi-v', text: v }),
      el('div', { class: 'pf-kpi-k', text: k })
    ]);
  }

  /** 工具条：筛选 / 搜索 / 排序 */
  function toolbar(snap, meta) {
    const wrap = el('div', { class: 'pf-toolbar' });

    const seg = el('div', { class: 'pf-seg' });
    [['all', '全部'], ['installed', '已安装'], ['not', '未安装']].forEach(([k, label]) => {
      seg.appendChild(el('button', {
        class: 'pf-seg-btn' + (filter.status === k ? ' active' : ''),
        text: label,
        onclick: () => { filter.status = k; window.App.renderContent(); }
      }));
    });
    wrap.appendChild(seg);

    const search = el('input', {
      class: 'pf-search',
      type: 'text',
      placeholder: '搜索这个平台里的游戏…',
      value: filter.search
    });
    search.addEventListener('input', U.debounce(() => {
      filter.search = search.value;
      window.App.renderContent();
      // 重绘后焦点丢了，补回来，不然打一个字就要重新点一次输入框
      const again = document.querySelector('.pf-search');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 220));
    wrap.appendChild(search);

    const sel = el('select', { class: 'pf-select' }, [
      el('option', { value: 'playtime', text: '按游玩时长' }),
      el('option', { value: 'name', text: '按名称' }),
      el('option', { value: 'recent', text: '按最近游玩' }),
      el('option', { value: 'ach', text: '按成就进度' })
    ]);
    sel.value = filter.sort;
    sel.addEventListener('change', () => { filter.sort = sel.value; window.App.renderContent(); });
    wrap.appendChild(sel);

    wrap.appendChild(el('span', { class: 'spacer', style: { flex: '1' } }));
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '↻ 重新同步',
      onclick: () => sync(meta.id, () => window.App.renderContent())
    }));
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '打开客户端',
      onclick: async () => {
        const r = await API.platformAction({ id: meta.id, action: 'open' });
        if (!r || r.ok === false) window.App.toast((r && r.error) || '拉起客户端失败', 'error');
      }
    }));
    return wrap;
  }

  /** 按当前筛选/排序条件算出要显示的游戏 */
  function visibleGames(snap) {
    let list = (snap.games || []).slice();
    if (filter.status === 'installed') list = list.filter((g) => g.installed);
    else if (filter.status === 'not') list = list.filter((g) => !g.installed);

    const q = filter.search.trim().toLowerCase();
    if (q) list = list.filter((g) => (g.name || '').toLowerCase().includes(q) || String(g.appId).includes(q));

    const cmp = {
      playtime: (a, b) => (b.playtimeMs || 0) - (a.playtimeMs || 0),
      name: (a, b) => (a.name || '').localeCompare(b.name || '', 'zh'),
      recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0),
      ach: (a, b) => achPct(b) - achPct(a)
    }[filter.sort] || ((a, b) => 0);

    return list.sort(cmp);
  }

  /** 成就完成度（没数据返回 -1，排序时排最后） */
  function achPct(g) {
    if (!g.achievements || !g.achievements.total) return -1;
    return g.achievements.unlocked / g.achievements.total;
  }

  /* ================================================================
   *  游戏卡片（未安装 = 黑白 + 角标，仍可点开详情）
   * ================================================================ */

  /**
   * 给一张卡挑图。
   * 优先级：竖版封面 → 横版大图 → 标志。
   * 竖版封面不是每款游戏都有（Steam 只给"真装过/看过"的游戏下竖图），
   * 但横版大图覆盖率高得多；宽高比对不上时 CSS 的 object-fit: cover
   * 会自动裁中间那块，比直接摆一个字母占位好看太多。
   */
  function artOf(g) {
    // 本地缓存优先（离线可用、秒出）；没有再用登录后拉到的 Epic CDN 图（要联网）
    return g.localCoverUrl || g.coverUrl
        || g.localHeroUrl || g.heroUrl
        || g.localLogoUrl || g.logoUrl || '';
  }

  function gameCard(g, meta) {
    const card = el('div', {
      class: 'pf-game' + (g.installed ? '' : ' not-installed'),
      onclick: () => openDetail(g, meta)
    });

    const cover = el('div', { class: 'pf-cover' });
    applyGradient(cover, g.name);
    const src = artOf(g);
    if (src) {
      const img = el('img', { src, alt: '', loading: 'lazy' });
      // 本地缓存万一失效（文件被 Steam 清理），退化成渐变色块，不留破图
      img.addEventListener('error', () => img.remove());
      cover.appendChild(img);
    } else {
      cover.appendChild(el('div', { class: 'pf-ph', text: initialOf(g.name) }));
    }
    cover.appendChild(el('div', {
      class: 'pf-flag' + (g.installed ? ' installed' : ''),
      text: g.installed ? '已安装' : '未安装'
    }));

    // 悬停浮出的操作：未安装 → 下载；已安装 → 启动
    const hover = el('div', { class: 'pf-hover' });
    hover.appendChild(el('button', {
      text: g.installed ? '启动' : '⬇ 下载',
      onclick: async (e) => {
        e.stopPropagation();
        const r = await API.platformAction({
          id: meta.id, action: g.installed ? 'run' : 'install', appId: g.appId
        });
        if (r && r.ok) {
          window.App.toast(g.installed ? `已请求 ${meta.name} 启动游戏` : `已拉起 ${meta.name} 的下载`, 'success');
        } else {
          window.App.toast((r && r.error) || '操作失败', 'error');
        }
      }
    }));
    hover.appendChild(el('button', {
      class: 'ghost', text: 'ℹ', title: '查看详情',
      onclick: (e) => { e.stopPropagation(); openDetail(g, meta); }
    }));
    cover.appendChild(hover);

    card.appendChild(cover);

    /* ---- 卡片下方：名字 + 时长 + 成就 ---- */
    const metaRow = el('div', { class: 'pf-game-meta' }, [
      el('span', { text: g.playtimeMs ? fmtDuration(g.playtimeMs) : '未玩过' })
    ]);
    if (g.achievements && g.achievements.total) {
      metaRow.appendChild(el('span', {
        class: 'pf-ach has',
        text: `🏆 ${g.achievements.unlocked}/${g.achievements.total}`
      }));
    }

    card.appendChild(el('div', { class: 'pf-game-body' }, [
      el('div', { class: 'pf-game-name', text: g.name, title: g.name }),
      metaRow
    ]));

    return card;
  }

  /* ================================================================
   *  平台游戏详情浮层
   * ------------------------------------------------------------
   *  ⚠ 和「全部游戏」的详情页（detail.js）共用 js/detailkit.js 的构件，
   *    两边必须长得一模一样，不要在这里另起炉灶写 DOM。
   * ================================================================ */
  function openDetail(g, meta) {
    detailGame = g;
    const layer = U.$('#platformDetailLayer');
    if (!layer) return;
    layer.innerHTML = '';

    layer.appendChild(el('div', { class: 'detail-backdrop', onclick: closeDetail }));

    /* ---- 标题旁的时长与成就：没有数据就不渲染，绝不显示 0/0 ---- */
    const statList = [];
    if (g.playtimeMs) {
      statList.push({ value: fmtDuration(g.playtimeMs), key: '游玩时间' });
      if (g.playtime2wksMs) statList.push({ value: fmtDuration(g.playtime2wksMs), key: '最近两周' });
    }
    if (g.achievements && g.achievements.total) {
      statList.push({
        value: `${g.achievements.unlocked}/${g.achievements.total}`,
        key: '成就',
        tone: 'ach'
      });
    }
    if (!g.installed) statList.push({ value: '', key: '⬇ 尚未下载' });

    const tags = [];
    if (!g.installed) tags.push({ text: '⬇ 未安装（黑白显示）' });
    if (g.appType) tags.push({ text: g.appType });

    /* ---- 骨架 ---- */
    const sk = K.skeleton({
      title: g.name,
      coverUrl: artOf(g),
      heroUrl: g.localHeroUrl || '',
      stats: statList,
      tags,
      onClose: closeDetail
    });

    /* ---- 操作条 ---- */
    K.fillBar(sk.bar, [
      el('button', {
        class: 'btn btn-play btn-lg',
        text: g.installed ? '▶ 启动游戏' : '⬇ 下载游戏',
        onclick: async () => {
          const r = await API.platformAction({
            id: meta.id, action: g.installed ? 'run' : 'install', appId: g.appId
          });
          if (r && r.ok) {
            window.App.toast(g.installed ? '已请求客户端启动' : `已拉起 ${meta.name} 的下载，请在客户端里确认`, 'success');
          } else {
            window.App.toast((r && r.error) || '操作失败', 'error');
          }
        }
      }),
      el('button', {
        class: 'btn btn-ghost',
        text: '🏪 商店页面',
        onclick: async () => {
          const r = await API.platformAction({ id: meta.id, action: 'store', appId: g.appId });
          if (!r || r.ok === false) window.App.toast((r && r.error) || '打开商店页失败', 'error');
        }
      }),
      g.installDir ? el('button', {
        class: 'btn btn-ghost',
        text: '📁 打开安装目录',
        onclick: async () => {
          const r = await API.openPath(g.installDir);
          if (r && r.ok === false) window.App.toast(r.error || '打开目录失败', 'error');
        }
      }) : null,
      K.spacer(),
      K.barMeta(`${meta.name} · AppID ${g.appId}`)
    ]);

    /* ---- 正文：可收起的区块 ---- */
    sk.body.appendChild(K.section('cover', '封面', K.arts([
      { label: '竖版封面', url: g.localCoverUrl, width: 110 },
      { label: '横版大图', url: g.localHeroUrl, width: 220 },
      { label: '标志', url: g.localLogoUrl, width: 140 }
    ])));
    sk.body.appendChild(K.section('info', '详细信息', buildInfoSection(g, meta)));
    if (g.achievements && g.achievements.total) {
      sk.body.appendChild(K.section('ach', '成就进度', K.achBar(
        g.achievements,
        '数据来自本机 Steam 客户端缓存的成就位图，只包含平台记录到的进度；没在此平台解锁过的成就不会显示。'
      )));
    }

    layer.appendChild(sk.panel);
    layer.hidden = false;

    document.addEventListener('keydown', escHandler);
  }

  /** 详细信息区 */
  function buildInfoSection(g, meta) {
    return K.kv([
      ['平台', meta.name],
      ['AppID', String(g.appId)],
      ['安装状态', g.installed ? '已安装' : '未安装'],
      ['游玩时长', g.playtimeMs ? fmtDuration(g.playtimeMs) : '未玩过'],
      ['最近两周', g.playtime2wksMs ? fmtDuration(g.playtime2wksMs) : '—'],
      ['最近游玩', g.lastPlayed ? fmtDate(g.lastPlayed) : '—'],
      ['占用空间', g.sizeBytes ? fmtBytes(g.sizeBytes) : (g.installed ? '未统计' : '—')],
      ['开发商', g.developer || '—'],
      ['发行商', g.publisher || '—'],
      ['类型', g.appType || '—'],
      ['安装路径', g.installDir || '—', 'path']
    ]);
  }

  function closeDetail() {
    const layer = U.$('#platformDetailLayer');
    if (layer) { layer.hidden = true; layer.innerHTML = ''; }
    detailGame = null;
    document.removeEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape') closeDetail();
  }

  /* ================================================================
   *  对外：给详情页（detail.js）查平台数据用
   * ================================================================ */

  /**
   * 按平台 + appId 找一条已同步的游戏记录。
   * detail.js 用它把"时长 / 成就"补到游戏库的详情页上。
   */
  function findGame(platformId, appId) {
    const snap = snapshots.get(platformId);
    if (!snap || !snap.games) return null;
    return snap.games.find((g) => String(g.appId) === String(appId)) || null;
  }

  /** Steam 游戏库里某款游戏对应的平台数据（用 steamAppId 反查） */
  function findBySteamAppId(appId) {
    if (!appId) return null;
    return findGame('steam', appId);
  }

  /** 确保某个平台已同步过（没有就同步一次），返回快照 */
  async function ensure(platformId) {
    if (snapshots.has(platformId)) return snapshots.get(platformId);
    const r = await API.platformSync({ id: platformId });
    if (r && r.ok) snapshots.set(platformId, r);
    return r;
  }

  window.PlatformView = {
    render,
    findGame,
    findBySteamAppId,
    ensure,
    /**
     * 丢掉缓存、重新同步一次。
     *
     * 为什么需要：ensure() 命中缓存就直接返回，这在日常使用里是对的
     * （别每次切页都去问一遍 Epic），但脚本要的是"此刻的真实结果"。
     * 拿缓存去截图，等于拿上次的结论当证据。
     */
    resync: async (id) => { snapshots.delete(id); return ensure(id); },
    /** 当前停在哪个平台的库里（给顶部标题用） */
    currentPlatform: () => current,
    platformName: (id) => {
      const p = platformList.find((x) => x.id === id);
      return p ? p.name : id;
    },
    /** 页面被切走时清掉筛选，免得下次进来看到莫名其妙的空列表 */
    resetFilter: () => { filter.status = 'all'; filter.search = ''; },
    /**
     * 退回平台总览。
     *
     * ⚠ 为什么需要这么个出口：`current` 是特意做成"记住上次停在哪个平台"的
     *   （为了让用户在各视图之间来回切时不丢位置），但它也意味着外部没法
     *   可预期地回到总览页 —— 截图脚本 / 自检脚本需要一个确定的起点。
     */
    gotoOverview: () => { current = null; filter.status = 'all'; filter.search = ''; },
    /** 展开某个平台的库（给脚本用，模拟用户点卡片） */
    gotoPlatform: (id) => { current = id; filter.status = 'all'; filter.search = ''; },
    /**
     * 登录遮罩的开关。
     * 导出是为了让截图 / 自检脚本能拍到**真实实现**，
     * 而不是在脚本里复刻一份 DOM —— 复刻的那份永远测不出真实样式出了什么问题。
     */
    showLoginVeil,
    hideLoginVeil
  };
})();
