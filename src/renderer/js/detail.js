/**
 * ============================================================
 *  GameHub - 游戏详情页  (js/detail.js)
 *  ------------------------------------------------------------
 *  点击封面后弹出的全屏浮层，包含：
 *   · Hero 大图区（横版封面铺满，没有就退化成竖版封面模糊放大）
 *   · 标题旁的游玩时长 / 启动次数 / 成就数
 *   · 启动 / 收藏 / 隐藏 / 打开目录 / 编辑 等操作条
 *   · 完整信息卡：安装日期、体积、游玩时长、路径、发行商、分类…
 *   · 封面管理（联网搜索封面 / 提取图标 / 抓取 / 选本地图片 / 拖拽换图 / 重置）
 *   · 个人备注
 *
 *  ⚠ 所有 DOM 一律走 js/detailkit.js 的共用构件，不许自己另写一套。
 *    「平台总览」里的详情页用的是同一套，两边必须长得一模一样。
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const { el, fmtBytes, fmtDate, fmtRelative, fmtDuration, isIconCover } = U;
  const K = window.DetailKit;

  let layer = null;         // 浮层根节点
  let currentId = null;     // 当前展示的游戏 ID
  let escHandler = null;

  /* ================================================================
   *  打开 / 关闭 / 刷新
   * ================================================================ */
  function open(id) {
    const g = window.State.games.find((x) => x.id === id);
    if (!g) return;
    currentId = id;

    // 注意：必须先拿到浮层根节点再渲染。
    // 之前是先 render() 再取节点，首次打开时 layer 还是 null，会直接抛异常。
    if (!layer) layer = U.$('#detailLayer');
    if (!layer) { console.error('[详情] 找不到浮层节点 #detailLayer'); return; }

    render(g);
    layer.hidden = false;

    // ESC 关闭
    escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
  }

  /** 关闭详情 */
  function close() {
    if (layer) layer.hidden = true;
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    currentId = null;
  }

  /** 详情页开着的时候，数据变化后刷新一下内容 */
  function refreshIfOpen() {
    if (!currentId || !layer || layer.hidden) return;
    const g = window.State.games.find((x) => x.id === currentId);
    if (!g) { close(); return; }
    render(g);
  }

  /* ================================================================
   *  渲染
   * ================================================================ */
  function render(g) {
    layer.innerHTML = '';
    layer.appendChild(el('div', { class: 'detail-backdrop', onclick: close }));

    /* ---------- 标题旁的「游玩时长 / 启动次数 / 成就」 ----------
     * 需求：标题旁边直接看到玩了多久、成就多少（如 12/200）。
     * 没有数据的项一律不渲染 —— 不能拿一个 0 出来糊弄人。
     * 成就只有平台那份快照才知道，先挂一个占位，异步拿到了再填。
     */
    const achSlot = K.slot();
    const statList = [];
    if (g.totalPlayMs > 60000) {
      // ⚠ 这个时长不一定全是 GameHub 记的：Steam 游戏会把 Steam 的累计时长并进来
      //   （见主进程 library.mergeSteamPlaytime）。并过就在悬停提示里说明，
      //   免得用户以为"我才玩了两次怎么就 40 小时"是算错了。
      statList.push({
        value: fmtDuration(g.totalPlayMs),
        key: '游玩时间',
        title: g.playtimeFromSteam
          ? `含 Steam 记录的时长${g.steamSyncedAt ? `（对齐于 ${fmtDate(g.steamSyncedAt)}）` : ''}`
          : '从 GameHub 启动过的累计时长'
      });
    }
    if (g.playCount) statList.push({ value: String(g.playCount), key: '次启动' });
    statList.push(achSlot);

    /* ---------- 标签 ---------- */
    const tags = [];
    if (window.State.running[g.id]) {
      tags.push({ text: '● 运行中 ' + fmtDuration(window.State.running[g.id].elapsedMs || 0) });
    }
    for (const c of (g.categories || [])) {
      tags.push({
        text: c,
        title: '点击查看该分类',
        onclick: () => { close(); window.App.gotoCategory(c); }
      });
    }
    if (g.missing) tags.push({ text: '⚠ 路径失效' });
    if (g.hidden) tags.push({ text: '🔒 已隐藏' });

    /* ---------- 骨架 ---------- */
    const sk = K.skeleton({
      title: g.name,
      coverUrl: g.coverUrl || '',
      coverIcon: isIconCover(g),
      // 游戏库这边没有"横版大图"这个概念，用封面兜底（构件会自动加大模糊）
      heroUrl: '',
      stats: statList,
      tags,
      onClose: close
    });

    /* ---------- 操作条 ---------- */
    const running = !!window.State.running[g.id];
    K.fillBar(sk.bar, [
      el('button', {
        class: 'btn btn-play btn-lg',
        text: running ? '● 正在运行' : '▶  启动游戏',
        onclick: () => window.App.launch(g.id)
      }),
      // 通关状态：既能看（当前项高亮）又能改（点一下就换档）。
      // 和卡片右上角 ⋮ 用的是同一份口径（window.Cards.CLEAR_META）和同一个写入函数，
      // 两处表现不会打架。
      clearSeg(g),
      el('button', {
        class: 'btn btn-ghost',
        text: g.favorite ? '★ 已收藏' : '☆ 收藏',
        onclick: async () => {
          await window.API.update(g.id, { favorite: !g.favorite });
          window.App.toast(g.favorite ? '已取消收藏' : '已加入收藏', 'success');
          window.App.refresh();
        }
      }),
      el('button', {
        class: 'btn btn-ghost',
        text: g.hidden ? '🔓 移出隐藏' : '🔒 隐藏此游戏',
        onclick: () => window.App.toggleHidden(g)
      }),
      el('button', {
        class: 'btn btn-ghost',
        text: '📁 打开目录',
        onclick: async () => {
          const r = await window.API.openFolder(g.id);
          if (r && r.ok === false) window.App.toast(r.error || '打开目录失败', 'error');
        }
      }),
      el('button', {
        class: 'btn btn-ghost',
        text: '✎ 编辑信息',
        onclick: () => window.Modals.editGame(g.id)
      }),
      K.spacer(),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '重算体积',
        title: '重新递归统计安装目录占用空间',
        onclick: async () => {
          window.App.toast('正在后台重算体积…', 'info');
          await window.API.calcSize([g.id]);
        }
      })
    ]);

    /* ---------- 正文 ---------- */
    /* MOD 管理放**最上面** —— 主人要的就是"点进游戏就能看到 MOD"，
     * 而它也确实比"安装日期/占用空间"这些静态信息更常看。 */
    if (window.ModView) sk.body.appendChild(window.ModView.section(g));
    sk.body.appendChild(K.section('info', '详细信息', buildInfo(g)));
    sk.body.appendChild(K.section('cover', '封面', buildCover(g)));
    sk.body.appendChild(K.section('note', '我的备注', buildNote(g)));
    sk.body.appendChild(K.section('danger', '其他', buildDanger(g)));

    layer.appendChild(sk.panel);

    /* ---------- 最后再补异步数据 ----------
     * ⚠ 必须放在 appendChild 之后：PanelView 快照已经缓存时，
     *   这两个函数会在同一个 tick 里同步跑到底，此时节点还没挂到文档上，
     *   构件里的 isConnected 判断会把它当成"用户已经翻页"，直接静默跳过。
     *   症状是成就和大图时有时无，非常难查，所以顺序不能动。
     * GameHub 自己只记时长和封面，成就和「横版大图」只有平台快照才知道。
     */
    fillPlatformAchievements(g, achSlot, sk.statline);
    fillPlatformHero(g, sk.setHeroBg);
  }

  /* ================================================================
   *  各区块内容
   * ================================================================ */

  /**
   * 操作条里的「通关状态」分段控件：三档横排，当前档高亮。
   *
   * 点一下就地换档（只重画这三颗按钮），**不走 refreshIfOpen()** ——
   * 那会把整个面板重渲染，详情页的滚动位置会被弹回顶部，用户正看到一半
   * 的成就列表就没了。
   *
   * @param {object} g 游戏对象（就是 State.games 里那一个，改它即可）
   */
  function clearSeg(g) {
    const C = window.Cards;
    const seg = el('div', { class: 'pfd-clear-seg', title: '通关状态（点击切换）' });

    const paint = () => {
      seg.innerHTML = '';
      for (const key of C.CLEAR_ORDER) {
        const m = C.CLEAR_META[key];
        if (!m) continue;
        const on = (g.clearState || C.CLEAR_DEFAULT) === key;
        seg.appendChild(el('button', {
          class: 'pcs-btn ' + m.cls + (on ? ' is-on' : ''),
          title: on ? `当前就是「${m.label}」` : `标记为「${m.label}」`,
          onclick: async (e) => {
            e.stopPropagation();
            // setClearState 内部已经处理了"重复点同一档"和提示，
            // 这里只需要在它写完之后把高亮重画一遍
            await window.App.setClearState(g, key);
            paint();
          }
        }, [
          el('span', { class: 'pcs-icon', text: m.icon }),
          el('span', { class: 'pcs-text', text: m.label })
        ]));
      }
    };
    paint();
    return seg;
  }

  /** 详细信息：键值网格 */
  function buildInfo(g) {
    const sm = U.sourceMeta(g.source);
    return K.kv([
      ['安装日期', g.installDate ? fmtDate(g.installDate) : '未知', true],
      ['占用空间', g.sizeBytes ? fmtBytes(g.sizeBytes) : '未统计', true],
      ['游玩时长', g.totalPlayMs > 60000 ? fmtDuration(g.totalPlayMs) : '未玩过', true,
        g.playtimeFromSteam
          ? `含 Steam 记录（Steam 报的是 ${fmtDuration(g.totalPlayMs)}${g.steamSyncedAt ? `，对齐于 ${fmtDate(g.steamSyncedAt)}` : ''}）`
          : '只统计从 GameHub 启动过的时长'],
      ['启动次数', g.playCount ? String(g.playCount) + ' 次' : '0 次', true,
        '只有从 GameHub 启动才算，Steam 客户端里直接开的不计'],
      ['最近游玩', fmtRelative(g.lastPlayedAt), true,
        g.playtimeFromSteam ? '含 Steam 记录的最后一次运行时间' : null],
      ['加入库时间', fmtDate(g.addedAt), true],
      ['发行商', g.publisher || '未知', true],
      ['版本', g.version || '未知', true],
      ['来源', sm.label + (g.steamAppId ? ` · AppID ${g.steamAppId}` : ''), true],
      ['分类', (g.categories || []).join(' / ') || '未分类', true],
      ['安装路径', g.installDir || '未记录', 'path'],
      ['主程序', g.exePath || '未指定', 'path']
    ]);
  }

  /**
   * 封面管理：联网搜索 + 提取图标 + 抓取 + 本地图片 + 拖拽区
   * ----------------------------------------------------------------
   * 「🌐 联网搜索封面」和「⬇ 重新抓取封面」不是重复功能：
   *   · 联网搜索：按游戏名去网上搜，**没有 AppID 也能用** ——
   *     自己导的绿色版 / 文件夹扫出来的游戏都属于这种，以前点「从 Steam 获取封面」
   *     只会得到一句「这款游戏没有 Steam ID」，等于没入口。
   *     搜到之后会把 AppID 记回库里，下次直接抓。
   *   · 重新抓取：已经有了 AppID 才显示，用记下来的 ID 直接下官方图（更快）。
   *     万一当初搜错了游戏，还能靠上面那个按钮重搜一次。
   */
  function buildCover(g) {
    const row = el('div', { class: 'pfd-row' }, [
      el('button', {
        class: 'btn btn-primary btn-sm',
        text: '🌐 联网搜索封面',
        title: '按游戏名联网查找官方封面（没有 Steam ID 也能搜；搜不到会告诉你）',
        onclick: (e) => doOnlineSearch(e.currentTarget, g)
      }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '🖼 提取程序图标', onclick: () => doCover(() => window.API.coverExtract(g.id)) }),
      g.steamAppId
        ? el('button', {
            class: 'btn btn-ghost btn-sm',
            text: '⬇ 重新抓取封面',
            title: `用已记录的 Steam AppID ${g.steamAppId} 重新下载官方封面`,
            onclick: () => doCover(() => window.API.coverSteam(g.id))
          })
        : null,
      el('button', {
        class: 'btn btn-ghost btn-sm', text: '📂 选择本地图片',
        onclick: async () => {
          const p = await window.API.pickImage();
          if (!p || p.ok === false) return;
          doCover(() => window.API.coverFromFile(g.id, p));
        }
      }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '↺ 恢复默认', onclick: () => doCover(() => window.API.coverReset(g.id)) })
    ].filter(Boolean));

    // 拖拽换封面
    const drop = el('div', {
      class: 'pfd-drop',
      text: '把图片文件拖到这里，即可设为封面（支持 PNG / JPG / WEBP / BMP）'
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) { window.App.toast('请拖入图片文件', 'warn'); return; }
      const reader = new FileReader();
      reader.onload = () => doCover(() => window.API.coverFromData(g.id, reader.result));
      reader.readAsDataURL(file);
    });

    return el('div', {}, [row, drop]);
  }

  /** 我的备注：失焦自动保存 */
  function buildNote(g) {
    const area = el('textarea', {
      class: 'pfd-note',
      placeholder: '写点备注，比如存档位置、通关进度、Mod 配置…（失焦自动保存）'
    });
    area.value = g.note || '';
    area.addEventListener('blur', async () => {
      if ((g.note || '') === area.value) return;
      await window.API.update(g.id, { note: area.value });
      window.App.toast('备注已保存', 'success');
    });
    return area;
  }

  /** 其他：卸载 / 从库中移除 */
  function buildDanger(g) {
    return el('div', { class: 'pfd-row' }, [
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '📦 卸载游戏',
        title: 'Steam / Epic 的游戏走平台自己的卸载流程；其它游戏由 GameHub 处理',
        onclick: () => window.Modals.uninstallGame(g.id)
      }),
      el('button', {
        class: 'btn btn-danger btn-sm',
        text: '从库中移除（不会删除磁盘文件）',
        onclick: () => window.Modals.confirmRemove([g.id], g.name)
      })
    ]);
  }

  /* ================================================================
   *  杂项
   * ================================================================ */

  /**
   * 异步把平台那边的成就进度补到标题旁。
   * 只在游戏带 steamAppId 时才做；拿不到就什么都不加（不留 "0/0" 这种误导）。
   */
  async function fillPlatformAchievements(g, slot, line) {
    if (!g || !window.PlatformView || !slot) return;

    /** 收尾：整行一个元素都没有的话，把它整个摘掉，别留一条空白 */
    const cleanUpIfEmpty = () => K.pruneEmpty(line || slot.parentElement);

    if (!g.steamAppId) { cleanUpIfEmpty(); return; }

    try {
      let pg = window.PlatformView.findBySteamAppId(g.steamAppId);
      if (!pg) await window.PlatformView.ensure('steam');
      pg = window.PlatformView.findBySteamAppId(g.steamAppId);
      // 用户可能已经翻到别的游戏了，节点也可能被重渲染掉
      if (!pg || !pg.achievements || !pg.achievements.total) return;
      if (!slot.isConnected || currentId !== g.id) return;

      slot.appendChild(K.stat({
        value: `${pg.achievements.unlocked}/${pg.achievements.total}`,
        key: '成就',
        tone: 'ach'
      }));
    } catch { /* 平台数据读不到就算了，不影响详情页其它内容 */ }
    finally { cleanUpIfEmpty(); }
  }

  /**
   * 异步把平台快照里的「横版大图」贴到 Hero 背景上。
   * 这样从「全部游戏」点开的详情页和从「平台总览」点开的，
   * 会铺同一张大图 —— 视觉上才算真的统一（不然一边模糊竖图一边横图）。
   * 拿不到就保持原来的竖版封面模糊兜底，什么都不做。
   */
  async function fillPlatformHero(g, setHeroBg) {
    if (!g || !g.steamAppId || !window.PlatformView || typeof setHeroBg !== 'function') return;
    try {
      let pg = window.PlatformView.findBySteamAppId(g.steamAppId);
      if (!pg) await window.PlatformView.ensure('steam');
      pg = window.PlatformView.findBySteamAppId(g.steamAppId);
      if (!pg || !pg.localHeroUrl) return;
      if (currentId !== g.id) return;      // 用户已经翻到别的游戏了
      setHeroBg(pg.localHeroUrl, false);   // 横版大图不需要加模糊
    } catch { /* 平台数据读不到就用封面兜底，不影响其它内容 */ }
  }

  /** 统一处理封面类操作的返回结果并提示 */
  async function doCover(action) {
    const r = await action();
    if (r && r.ok) {
      window.App.toast('封面已更新', 'success');
      await window.App.refresh();
      refreshIfOpen();
    } else {
      window.App.toast((r && r.error) || '操作失败', 'error');
    }
  }

  /**
   * 「联网搜索封面」：要联网、要等一两秒，所以按钮得自己进"搜索中"状态。
   * ⚠ 成功后 refreshIfOpen() 会把整块面板重渲染掉，手里这个按钮节点会被丢弃，
   *   所以恢复按钮状态前必须判 isConnected，否则是在给一个已下线的节点改文字。
   */
  async function doOnlineSearch(btn, g) {
    if (!btn || btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '🔎 搜索中…';
    window.App.setStatus(`正在联网搜索「${g.name}」的封面…`, 'busy');

    let r = null;
    try {
      r = await window.API.coverSearchOne(g.id);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '联网搜索失败' };
    }

    if (r && r.ok) {
      window.App.setStatus('封面搜索完成', 'ok');
      window.App.toast(
        r.searched && r.appid
          ? `已联网补上封面（匹配到 Steam AppID ${r.appid}）`
          : '封面已更新',
        'success', 6000
      );
      await window.App.refresh();
      refreshIfOpen();
    } else {
      window.App.setStatus('没找到可用的联网封面', 'warn');
      window.App.toast((r && r.error) || '联网搜索封面失败', 'warn', 7000);
    }

    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  window.Detail = { open, close, refreshIfOpen };
})();
