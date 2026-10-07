/**
 * ============================================================
 *  GameHub - 卡片渲染  (js/cards.js)
 * ------------------------------------------------------------
 *  三种展现形态：
 *    buildCard()      封面墙卡片（Steam 库的主体，2:3 竖版封面）
 *    buildRow()       列表行（信息密度更高）
 *    buildRailCard()  首页「继续游戏」横向宽卡
 *
 *  封面素材的渲染优先级：
 *    ① 用户自定义图片 → 直接铺满
 *    ② exe 图标       → 居中贴到渐变底上（图标是方形，不能拉伸）
 *    ③ Steam 官方竖版图 → 直接铺满
 *    ④ 什么都没有      → 用游戏名哈希出的渐变色 + 首字（保证永远不出现灰色破图）
 *
 *  成就角标（和「平台总览」的卡片对齐）：
 *    · 卡片/游戏名行放得下 → 右下角常显 🏆 12/135
 *    · 放不下              → 角标让位，鼠标悬停时下面的游戏名横向滚出"名字 + 成就"
 *    数据来自 Steam 客户端本地缓存，只在有数据时显示，绝不画 0/0。
 *
 *  通关状态（卡片左上角角标，右上角 ⋮ 里改）：
 *    '' 不画角标；cleared / multi / uncleared 三种才显示。
 *
 *  全成就（.is-perfect）：
 *    unlocked >= total 且 total > 0 → 悬停时卡片四周浮出旋转的炫彩光晕（纯 CSS）。
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const { el, fmtBytes, fmtDate, fmtRelative, fmtDuration, applyGradient, initialOf, sourceMeta, isIconCover } = U;

  /**
   * 读一个设置开关（放在这里是为了所有默认值只写一处）。
   * 用户没动过这项时一律当作开启 —— 老版本的数据里根本没有这些字段。
   * @param {string} key 设置名
   * @param {boolean} [def=true] 缺省值
   */
  function pref(key, def = true) {
    const s = window.State && window.State.settings;
    if (!s || s[key] === undefined || s[key] === null) return def;
    return !!s[key];
  }

  /* ================================================================
   *  通关状态
   * ------------------------------------------------------------
   *  「⋮ 更多选项」里的三项、卡片角标、列表行的 chip 都从这里取口径，
   *  避免同一个状态在三处各写一份文案然后慢慢跑偏。
   *
   *  ⚠ 没有"未标记"这一档：所有游戏【默认未通关】，从入库起就带状态。
   *    所以每张卡都有一个角标，这里也就不存在"值是空所以不画"的分支
   *    （仍然保留了 null 判断，防的是极端情况下对象里压根没这个字段）。
   * ================================================================ */
  const CLEAR_META = {
    cleared: { value: 'cleared', label: '通关', icon: '✓', cls: 'cc-cleared', tone: 'ok' },
    multi: { value: 'multi', label: '多结局通关', icon: '✦', cls: 'cc-multi', tone: 'gold' },
    uncleared: { value: 'uncleared', label: '未通关', icon: '○', cls: 'cc-uncleared', tone: 'dim' }
  };
  /** 默认档位：入库即"未通关" */
  const CLEAR_DEFAULT = 'uncleared';
  /** 菜单里的固定顺序：从"最强"到"最弱"，用户扫一眼就知道自己在哪一档 */
  const CLEAR_ORDER = ['cleared', 'multi', 'uncleared'];

  /** 取某个状态值的展示信息；没有 / 非法值一律返回 null */
  function clearMetaOf(state) {
    return CLEAR_META[state] || null;
  }

  /**
   * 「这一款通关了没」—— 用来决定 ⋮ 要不要高亮。
   * 只有真的通关（含多结局）才亮；默认的"未通关"不算，
   * 否则满屏的 ⋮ 全是高亮的，等于没有提示。
   */
  function isCleared(g) {
    return !!g.clearState && g.clearState !== CLEAR_DEFAULT;
  }

  /* ================================================================
   *  封面渲染（三种形态共用）
   * ================================================================ */

  /**
   * 生成封面内部内容（不含外层容器）
   * @param {object} g 游戏对象
   * @returns {HTMLElement}
   */
  function coverContent(g) {
    if (g.coverUrl) {
      if (isIconCover(g)) {
        // 方形图标 → 居中放置，不要拉伸变形
        return el('div', { class: 'icon-cover' }, [el('img', { src: g.coverUrl, alt: '', loading: 'lazy' })]);
      }
      return el('img', { src: g.coverUrl, alt: '', loading: 'lazy', draggable: 'false' });
    }
    // 无图：渐变 + 首字 + 名称
    return el('div', { class: 'card-ph' }, [
      el('div', { class: 'card-ph-letter', text: initialOf(g.name) }),
      el('div', { class: 'card-ph-name', text: g.name })
    ]);
  }

  /** 通关状态角标（正常一定有；对象里缺字段时才返回 null） */
  function buildClearBadge(g, variant) {
    const m = clearMetaOf(g.clearState);
    if (!m) return null;
    return el('span', {
      class: (variant === 'row' ? 'chip gr-clear ' : 'badge card-clear ') + m.cls,
      title: '通关状态：' + m.label + '（点卡片右上角 ⋮ 可修改）'
    }, [
      el('span', { class: 'cc-icon', text: m.icon }),
      el('span', { class: 'cc-text', text: m.label })
    ]);
  }

  /**
   * 卡片右上角那簇工具：收藏星 + 「⋮ 更多选项」。
   *
   * ⚠ 「更多选项」必须做成真按钮（不是 span），并且点它的回调里要
   *   stopPropagation —— 否则会先触发卡片的"单击打开详情"。
   *   双击更麻烦：连点两下会命中 dblclick 直接把游戏启动起来，
   *   所以 bindCardEvents 里的 dblclick 也要放过这个元素。
   */
  function buildCardTools(g) {
    const tools = [];
    if (g.favorite) tools.push(el('span', { class: 'card-star', text: '★', title: '已收藏' }));
    tools.push(el('button', {
      class: 'card-more' + (isCleared(g) ? ' is-set' : ''),
      text: '⋮',
      title: isCleared(g) ? `更多选项（当前：${clearMetaOf(g.clearState).label}）` : '更多选项',
      onclick: (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        window.App.showClearMenu(r.right - 4, r.bottom + 4, g);
      }
    }));
    return el('div', { class: 'card-badges-right' }, tools);
  }

  /** 卡片顶部/底部角标 */
  function buildBadges(g) {
    const frag = document.createDocumentFragment();

    // 左上：运行中 / 已失效 / 隐藏 / 通关状态
    const left = [];
    if (window.State.running[g.id]) {
      left.push(el('span', { class: 'badge badge-live' }, [
        el('span', { class: 'dot' }),
        '运行中 ' + fmtDuration(window.State.running[g.id].elapsedMs || 0)
      ]));
    }
    if (g.missing) left.push(el('span', { class: 'badge badge-missing', text: '路径失效' }));
    // 通关状态和"运行中 / 路径失效"一样属于卡片自己的状态，放同一个角落最自然；
    // 挪到右下角会被悬停时的「▶ 启动」浮层压住。
    const clear = buildClearBadge(g);
    if (clear) left.push(clear);
    if (left.length) frag.appendChild(el('div', { class: 'card-badges' }, left));

    // 右上：收藏星 + 更多选项（永远有，所以无条件加）
    frag.appendChild(buildCardTools(g));
    return frag;
  }

  /* ================================================================
   *  ① 封面墙卡片
   * ================================================================ */
  function buildCard(g, index = 0) {
    const cover = el('div', { class: 'card-cover' }, [coverContent(g)]);

    // ⚠ 顺序要紧：悬浮操作层先加，角标后加。
    //   两者都是 inset:0 / 绝对定位，DOM 里排在后面的画在上面。
    //   之前是「角标先、悬浮层后」，结果 .card-overlay 把右上角的「⋮」整个盖住，
    //   用户点 ⋮ 点在悬浮层上、冒泡到卡片 → 打开了详情页。
    //   （CSS 那边也已经给 overlay 关了 pointer-events，这里是第二道保险。）
    if (pref('cardHoverPlay')) {
      cover.appendChild(el('div', { class: 'card-overlay' }, [
        el('button', {
          class: 'mini-play',
          text: window.State.running[g.id] ? '▶ 运行中' : '▶ 启动',
          onclick: (e) => { e.stopPropagation(); window.App.launch(g.id); }
        })
      ]));
    }
    cover.appendChild(buildBadges(g));

    // 副信息行：安装日期 · 体积 · 游玩时长
    const subs = [];
    if (g.installDate) subs.push('安装 ' + fmtDate(g.installDate));
    if (g.sizeBytes) subs.push(fmtBytes(g.sizeBytes));
    if (g.totalPlayMs > 60000) subs.push('已玩 ' + fmtDuration(g.totalPlayMs));

    const subNodes = [];
    subs.forEach((s, i) => {
      if (i > 0) subNodes.push(el('span', { class: 'dot-sep', text: '·' }));
      subNodes.push(el('span', { text: s }));
    });

    const card = el('div', {
      class: 'game-card',
      dataset: { id: g.id, sizeThemed: window.State.cardSize },
      style: { animationDelay: Math.min(index * 16, 260) + 'ms' },
      title: g.name + (g.installDir ? '\n' + g.installDir : '')
    }, [
      cover,
      el('div', { class: 'card-meta' }, [
        // 名字行：默认省略号；放不下时鼠标悬停会横向滚动，把成就一起带出来
        el('div', { class: 'card-name' }, [
          el('div', { class: 'cn-clip' }, [
            el('div', { class: 'cn-track' }, [
              el('span', { class: 'cn-text', text: g.name }),
              el('span', { class: 'cn-ach' })   // 文字由 decorateAchievements 异步填
            ])
          ])
        ]),
        // 副信息行：左边元信息可截断，右边留一个成就角标的位置（有数据才显示）
        el('div', { class: 'card-sub' }, [
          el('span', { class: 'cs-meta' }, subNodes),
          el('span', { class: 'card-ach', hidden: true })
        ])
      ])
    ]);

    applyGradient(card, g.name);
    window.App.bindCardEvents(card, g);
    return card;
  }

  /* ================================================================
   *  ② 列表行
   * ================================================================ */
  function buildRow(g, index = 0) {
    const thumb = el('div', { class: 'gr-thumb' });
    if (g.coverUrl) {
      thumb.appendChild(el('img', { src: g.coverUrl, alt: '', loading: 'lazy', class: isIconCover(g) ? 'as-icon' : '' }));
    } else {
      thumb.appendChild(el('div', { class: 'ph-letter', text: initialOf(g.name) }));
    }
    applyGradient(thumb, g.name);

    // 标签行：来源 + 分类 + 运行中
    const tags = [];
    if (window.State.running[g.id]) {
      tags.push(el('span', { class: 'badge badge-live' }, [el('span', { class: 'dot' }), '运行中']));
    }
    const sm = sourceMeta(g.source);
    tags.push(el('span', { class: 'badge ' + sm.cls, text: sm.label }));
    for (const c of (g.categories || []).slice(0, 3)) tags.push(el('span', { class: 'chip', text: c }));
    if (g.favorite) tags.push(el('span', { class: 'chip', text: '★ 收藏' }));
    // 通关状态和网格卡片用同一个角标构件，只是这里做成 chip 更贴合列表的密度
    const clearChip = buildClearBadge(g, 'row');
    if (clearChip) tags.push(clearChip);
    if (g.missing) tags.push(el('span', { class: 'badge badge-missing', text: '路径失效' }));

    const row = el('div', {
      class: 'game-row',
      dataset: { id: g.id },
      style: { animationDelay: Math.min(index * 12, 220) + 'ms' }
    }, [
      thumb,
      el('div', { class: 'gr-main' }, [
        el('div', { class: 'gr-name', text: g.name }),
        // 末尾挂一个成就 chip，文字同样是异步补的（没有数据就一直藏着）
        el('div', { class: 'gr-tags' }, tags.concat([
          el('span', { class: 'chip gr-ach', hidden: true })
        ]))
      ]),
      el('div', { class: 'gr-col' }, [
        el('strong', { text: g.installDate ? fmtDate(g.installDate) : '未知' }),
        el('span', { text: '安装日期' })
      ]),
      el('div', { class: 'gr-col' }, [
        el('strong', { text: g.sizeBytes ? fmtBytes(g.sizeBytes) : '—' }),
        el('span', { text: '占用空间' })
      ]),
      el('div', { class: 'gr-col' }, [
        el('strong', { text: g.totalPlayMs > 60000 ? fmtDuration(g.totalPlayMs) : '未玩过' }),
        el('span', { text: g.playCount ? `启动 ${g.playCount} 次` : '游玩时长' })
      ]),
      el('button', {
        class: 'gr-more' + (isCleared(g) ? ' is-set' : ''),
        text: '⋮',
        title: isCleared(g) ? `更多选项（当前：${clearMetaOf(g.clearState).label}）` : '更多选项',
        onclick: (e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          window.App.showClearMenu(r.right - 4, r.bottom + 4, g);
        }
      }),
      el('div', { class: 'gr-play', text: '▶', onclick: (e) => { e.stopPropagation(); window.App.launch(g.id); } })
    ]);

    window.App.bindCardEvents(row, g);
    return row;
  }

  /* ================================================================
   *  ③ 首页「继续游戏」宽卡
   * ================================================================ */
  function buildRailCard(g) {
    const card = el('div', { class: 'rail-card', dataset: { id: g.id }, title: g.name });
    applyGradient(card, g.name);

    // 背景：有封面就用封面，没有就纯渐变
    if (g.coverUrl && !isIconCover(g)) {
      card.appendChild(el('img', { class: 'bg', src: g.coverUrl, alt: '', draggable: 'false' }));
    }
    card.appendChild(el('div', { class: 'veil' }));

    const subtitle = g.lastPlayedAt ? '上次游玩 ' + fmtRelative(g.lastPlayedAt) : '尚未启动过';
    card.appendChild(el('div', { class: 'content-wrap' }, [
      el('div', { class: 'rc-name', text: g.name }),
      el('div', { class: 'rc-foot' }, [
        el('span', { class: 'rc-time', text: subtitle + (g.totalPlayMs > 60000 ? ' · 共 ' + fmtDuration(g.totalPlayMs) : '') }),
        el('button', {
          class: 'rc-play',
          text: window.State.running[g.id] ? '运行中' : '▶ 启动',
          onclick: (e) => { e.stopPropagation(); window.App.launch(g.id); }
        })
      ])
    ]));

    window.App.bindCardEvents(card, g);
    return card;
  }

  /* ================================================================
   *  成就角标 —— 卡片右下角显示 🏆 12/135
   * ------------------------------------------------------------
   *  数据来源：Steam 客户端本地缓存（平台快照），不联网、不上传。
   *  库里没有这个平台数据的游戏一律不显示，绝不画 0/0。
   * ================================================================ */

  /** Steam 快照只同步一次；失败也记住，免得每次渲染都去敲一遍主进程 */
  let steamSnapshotOnce = null;

  function ensureSteamSnapshot() {
    if (!window.PlatformView) return Promise.resolve(null);
    if (!steamSnapshotOnce) {
      steamSnapshotOnce = Promise.resolve()
        .then(() => window.PlatformView.ensure('steam'))
        .catch(() => null);
    }
    return steamSnapshotOnce;
  }

  /** 拿某款游戏的成就进度；没有就返回 null（不是 0/0） */
  function achOf(g) {
    if (!g || !g.steamAppId || !window.PlatformView) return null;
    const pg = window.PlatformView.findBySteamAppId(g.steamAppId);
    const a = pg && pg.achievements;
    return a && a.total > 0 ? a : null;
  }

  /**
   * 渲染完后统一补成就角标。
   *
   * 分两步：先用内存里已有的快照同步补一遍（从平台页切回来时快照已经在了，
   * 这一遍就能出结果、不会闪），剩下的靠一次 Steam 同步补齐。
   *
   * @param {HTMLElement} host 放卡片的容器
   * @param {Array} games      这一批卡对应的游戏（顺序无所谓）
   */
  async function decorateAchievements(host, games) {
    if (!host || !games || !games.length) return;
    // 设置里关掉了「卡片显示成就」→ 直接收工，连同步都不用跑
    if (!pref('cardAchievements')) return;
    const byId = new Map(games.map((g) => [String(g.id), g]));

    const apply = () => {
      if (!host.isConnected) return;
      // 封面墙
      for (const card of host.querySelectorAll('.game-card[data-id]')) {
        const g = byId.get(card.dataset.id);
        if (g) paintAch(card, achOf(g));
      }
      // 列表视图：成就做成一个 chip 挂在标签行末尾
      for (const row of host.querySelectorAll('.game-row[data-id]')) {
        const g = byId.get(row.dataset.id);
        if (!g) continue;
        const a = achOf(g);
        const chip = row.querySelector('.gr-ach');
        if (!chip) continue;
        chip.hidden = !a;
        if (a) {
          chip.textContent = `🏆 ${a.unlocked}/${a.total}`;
          chip.title = `成就 ${a.unlocked} / ${a.total}`;
        }
        // 列表行同样享受全成就的流光（条件跟卡片一致，见 paintAch 的注释）
        row.classList.toggle('is-perfect', !!a && a.total > 0 && a.unlocked >= a.total);
      }
    };

    apply();   // ① 现有快照，同步补上

    // ② 还有 Steam 游戏没拿到成就 → 说明 Steam 快照还没同步过，补一次
    const steamGames = games.filter((g) => g.steamAppId);
    if (!steamGames.length || steamGames.every((g) => achOf(g))) return;

    await ensureSteamSnapshot();
    apply();   // ③ 同步完再补一遍
  }

  /**
   * 把成就画到一张卡片上。
   * @param {HTMLElement} card
   * @param {{unlocked:number,total:number}|null} a
   */
  function paintAch(card, a) {
    const badge = card.querySelector('.card-ach');
    const achInName = card.querySelector('.cn-ach');
    if (!badge || !achInName) return;

    if (!a) {
      badge.hidden = true;
      achInName.textContent = '';
      card.classList.remove('ach-tight', 'is-perfect');
      card.querySelector('.card-name').classList.remove('is-scroll');
      return;
    }

    const pct = Math.round((a.unlocked / a.total) * 100);
    const perfect = a.total > 0 && a.unlocked >= a.total;
    const text = `🏆 ${a.unlocked}/${a.total}`;
    badge.textContent = text;
    badge.hidden = false;
    badge.title = `成就 ${a.unlocked} / ${a.total}（已完成 ${pct}%）`
      + (perfect ? ' · 全成就，鼠标悬停有彩蛋' : '');
    achInName.textContent = text;

    // 全成就 → 挂个标记，悬停时卡片四周会浮出炫彩流光。
    // 判定条件写全 a.total > 0：没有成就系统的游戏 a.unlocked 也是 0，
    // 少了这一句就会把"0 / 0"当成 100% 全成就，满屏乱发光。
    card.classList.toggle('is-perfect', perfect);

    measureCard(card);
  }

  /**
   * 量一张卡片：① 底部行放不放得下成就角标 ② 名字行要不要响应悬停。
   * 读的都是 clientWidth / scrollWidth，浏览器会当场同步排版，所以必须
   * 在角标已经显示、文字已经填好之后再调（paintAch 里就是这么排的）。
   */
  function measureCard(card) {
    const nameBox = card.querySelector('.card-name');
    const clip = card.querySelector('.cn-clip');
    const text = card.querySelector('.cn-text');
    const achInName = card.querySelector('.cn-ach');
    const sub = card.querySelector('.card-sub');
    const meta = card.querySelector('.cs-meta');
    const badge = card.querySelector('.card-ach');
    if (!nameBox || !clip || !text || !sub || !meta || !badge) return;

    /* ---- ① 底部行够不够放成就角标 ----
     * 不够就把角标从底部行撤掉，改由"悬停时名字行滚动"来展示 ——
     * 元信息本来就允许截断，但截到只剩两三个字就不如让位给成就。
     *
     * ⚠ 这个"让位"策略建立在"还滚得起来"的前提上：设置里关掉悬停滚动之后，
     *   就必须永远保留右下角角标（tight 恒为 false），否则成就压根没地方露出来。 */
    const marquee = pref('cardNameMarquee');
    const gap = 7;                                   // 和 .card-sub 的 gap 保持一致
    // ⚠ 必须先摘掉 ach-tight 再量：那个类会把角标 display:none，
    //   量出来是 0 宽，于是每次都判定"放得下"，角标会在两次测量之间反复横跳。
    card.classList.remove('ach-tight');
    const badgeW = badge.offsetWidth;
    const avail = sub.clientWidth - badgeW - gap;
    const metaW = meta.scrollWidth;                  // 元信息的自然宽度（截断不影响 scrollWidth）
    // 阈值故意定得"舍不得让"：元信息本来就是用来截断的，只要还能剩下一小截
    // 就给成就角标让路。只有连 60px 都挤不出来（差不多只剩两三个字）才换成悬停滚。
    const tight = marquee && avail < Math.max(60, metaW * 0.35);
    card.classList.toggle('ach-tight', tight);

    /* ---- ② 名字行要不要响应悬停 ----
     * need = 完整名字宽度（tight 时还要加上成就的宽度，因为悬停时它也会滚出来）
     * text.scrollWidth 在省略号状态下依然是完整文本宽度，正好用来判断。
     *
     * ⚠ tight 时必须无条件打开 is-scroll：那种情况下右下角的角标已经被撤掉了，
     *   成就只剩"悬停滚名字"这一条露出的路。名字本来就短（dist≈0）时不加动画，
     *   但角标该出来 —— 否则这张卡的成就会彻底看不见。 */
    const need = text.scrollWidth + (tight && achInName.scrollWidth ? achInName.scrollWidth + 6 : 0);
    const dist = Math.max(0, Math.round(need - clip.clientWidth));

    if (marquee && (dist > 1 || tight)) {
      nameBox.classList.add('is-scroll');
      nameBox.style.setProperty('--mq', dist + 'px');
      // 滚动时长跟着距离走，长的多给点时间，免得滚得像飞一样看不清
      nameBox.style.setProperty('--mq-dur', (3.2 + dist / 26).toFixed(1) + 's');
    } else {
      nameBox.classList.remove('is-scroll');
      nameBox.style.removeProperty('--mq');
      nameBox.style.removeProperty('--mq-dur');
    }
  }

  /**
   * 改完通关状态后，就地刷掉屏幕上那张卡片（或列表行）的角标。
   *
   * 为什么不图省事直接 window.App.refresh()？—— 那是整页重绘：滚动位置弹回顶部、
   * 所有卡片重新播一遍入场动画、正开着的悬停态也全丢。用户只是点了个「通关」，
   * 看到整面墙"唰"地重排一次会以为程序抽风了。
   */
  function refreshClear(g) {
    if (!g) return;
    const nodes = document.querySelectorAll(
      `.game-card[data-id="${g.id}"], .game-row[data-id="${g.id}"]`
    );
    for (const node of nodes) {
      const isRow = node.classList.contains('game-row');
      const old = node.querySelector(isRow ? '.gr-clear' : '.card-clear');
      const fresh = buildClearBadge(g, isRow ? 'row' : 'card');

      if (old && fresh) {
        old.replaceWith(fresh);
      } else if (old) {
        old.remove();
      } else if (fresh) {
        if (isRow) {
          const tags = node.querySelector('.gr-tags');
          // 位置和 buildRow 里的顺序保持一致：插在「路径失效」之前
          const missing = tags && [...tags.children].find((c) => c.classList.contains('badge-missing'));
          if (tags) tags.insertBefore(fresh, missing || null);
        } else {
          // 网格卡片：没有左上一簇（既没运行中也没失效）就补一簇。
          // ⚠ 一定要 appendChild 到封面末尾，不能 insertBefore(firstChild) ——
          //   封面里的元素都是绝对定位，按 DOM 顺序绘制，插到最前面会被封面图盖住。
          const cover = node.querySelector('.card-cover');
          if (!cover) continue;
          const box = cover.querySelector('.card-badges');
          if (box) box.appendChild(fresh);
          else cover.appendChild(el('div', { class: 'card-badges' }, [fresh]));
        }
      }

      // ⋮ 上的"已通关"高亮也跟着切（未通关是默认档，不算高亮）
      const more = node.querySelector(isRow ? '.gr-more' : '.card-more');
      if (more) {
        more.classList.toggle('is-set', isCleared(g));
        more.title = isCleared(g) ? `更多选项（当前：${clearMetaOf(g.clearState).label}）` : '更多选项';
      }
    }
  }

  /** 卡片宽度会随窗口缩放/卡片尺寸档位变化，重新量一遍 */
  const remeasureAll = U.debounce(() => {
    for (const card of document.querySelectorAll('.game-card[data-id]')) {
      if (!card.querySelector('.card-ach:not([hidden])')) continue;
      measureCard(card);
    }
  }, 160);

  window.addEventListener('resize', remeasureAll);

  /* ================================================================
   *  骨架屏（加载时占位，避免内容"跳出来"）
   * ================================================================ */
  function skeleton(count = 12) {
    const grid = el('div', { class: 'game-grid', dataset: { size: window.State.cardSize } });
    for (let i = 0; i < count; i++) grid.appendChild(el('div', { class: 'skeleton-card' }));
    return grid;
  }

  window.Cards = {
    buildCard, buildRow, buildRailCard, skeleton, coverContent, applyGradient,
    /** 渲染完后调一次：给卡片补成就角标、算好名字行要不要滚动 */
    decorateAchievements,
    /** 通关状态的口径：菜单 / 卡片角标 / 列表 chip 共用这一份 */
    CLEAR_META, CLEAR_ORDER, CLEAR_DEFAULT, clearMetaOf, isCleared,
    /** 改完通关状态后就地刷新角标（不整页重绘） */
    refreshClear
  };
})();
