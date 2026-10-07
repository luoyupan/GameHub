/**
 * ============================================================
 *  GameHub - MOD 管理界面  (js/modview.js)
 * ------------------------------------------------------------
 *  详情页里的「MOD 管理」区块。结构：
 *
 *    ┌ 工具条   统计 · 添加 MOD · 创意工坊 · N 网 · 排序
 *    ├ 标签条   全部 / 各创意工坊标签（二级分类的入口）
 *    └ 横列     每个标签一行，行内卡片横向滚动
 *               每张卡：预览图 / 名字 / 标签 / 大小 / 启用状态
 *                        + 启用·禁用 / 定位 / 删除
 *
 *  ── 几条刻意的设计 ──────────────────────────────────────────
 *   · **禁用状态以磁盘为准**。后端把"禁用"实现成给文件改名，
 *     所以这里每次刷新都重新问一遍，不自己记一份状态 ——
 *     两处状态一旦漂移，界面就会说"已禁用"而文件其实是启用的，
 *     那比不显示还糟。
 *   · **删除必须两步**：先弹窗把完整路径铺出来，再动手，
 *     而且后端是移进回收站不是真删。MOD 是用户攒出来的东西，
 *     误删一个整合包可能意味着几十小时。
 *   · **创意工坊的禁用有代价**，界面上明说：改名之后 Steam 会认为
 *     这份内容不完整，下次校验可能重新下载。
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const K = window.DetailKit;
  const { el, fmtBytes, fmtRelative, initialOf, applyGradient } = U;

  /** 区块 key：收起状态记在 DetailKit 里，两个详情页入口共用 */
  const SEC_KEY = 'mods';

  /**
   * 两个兜底分组名。必须和后端 src/main/mods.js 里的常量一字不差 ——
   * 这里对不上，界面就会出现点进去空空如也的分组。
   */
  const UNTAGGED_LOCAL = '本地 MOD';
  const UNTAGGED_WORKSHOP = '创意工坊 · 无标签';
  const PSEUDO = [UNTAGGED_WORKSHOP, UNTAGGED_LOCAL];

  /** 排序选项。enabled 那条最实用 —— 一眼看到哪些还开着 */
  const SORTS = [
    { id: 'name', label: '按名称' },
    { id: 'updated', label: '按更新时间' },
    { id: 'size', label: '按大小' },
    { id: 'enabled', label: '按启用状态' }
  ];

  /* ----------------------------------------------------------------
   *  模块状态
   * ----------------------------------------------------------------
   *  排序 / 筛选 / 当前游戏的 MOD 数据都记在这里。
   *  ⚠ 换一款游戏时必须整体重置 —— 否则会出现"给 A 游戏筛了标签，
   *    点开 B 游戏发现列表是空的"这种事（筛选标签在 B 上根本不存在）。
   * ---------------------------------------------------------------- */
  let state = {
    gameId: '',
    sortBy: 'name',
    sortAsc: true,
    tag: '',          // 空 = 全部
    loading: false,
    data: null,       // 最近一次后端返回
    error: '',
    container: null   // 这个区块的持久容器，重绘时往它里面画
  };

  /* ================================================================
   *  入口：给详情页用的区块
   * ================================================================ */

  /**
   * 构建「MOD 管理」区块。
   * @param {object} g 游戏对象
   * @returns {HTMLElement} 可直接 appendChild 的 .pfd-sec 区块
   */
  function section(g) {
    // 换游戏就重置筛选 —— 见上面模块状态的说明
    if (state.gameId !== g.id) {
      state = { ...state, gameId: g.id, tag: '', error: '', data: null, loading: false };
      // 换游戏时收起上一个游戏开着的内嵌浏览器（上下文都换了，页面留着没意义）
      state.browser = null;
      if (window.BrowserTabs) window.BrowserTabs.modClose();
    }

    state.container = el('div', { class: 'pfd-mod' });
    paint(state.container, g);

    const sec = K.section(SEC_KEY, 'MOD 管理', state.container);
    // 第一次进来才自动拉数据；已经有的直接画（切回来看不用重新等）
    if (!state.data && !state.loading) load(g);
    return sec;
  }

  /* ================================================================
   *  拉数据
   * ================================================================ */

  /**
   * @param {object} g
   * @param {{online?:boolean}} [o]
   */
  let loadSeq = 0;   // 防串场：用户连点两下游戏时，只认最后一次的结果

  async function load(g, o = {}) {
    const seq = ++loadSeq;
    state.loading = true;
    state.error = '';
    paint(state.container, g);

    let r = null;
    try {
      r = await window.API.modList({
        id: g.id,
        online: o.online !== false && !!g.steamAppId,
        sortBy: state.sortBy,
        asc: state.sortAsc
      });
    } catch (e) {
      r = { ok: false, error: (e && e.message) || '读取 MOD 失败' };
    }

    // 这中间用户已经点开别的游戏了 —— 丢弃这次结果，别把旧数据画上去
    if (seq !== loadSeq) return;

    state.loading = false;
    if (r && r.ok) {
      state.data = r;
    } else {
      state.data = null;
      state.error = (r && r.error) || '读取 MOD 失败';
    }
    paint(state.container, g);
  }

  /* ================================================================
   *  重绘
   * ================================================================ */

  function paint(host, g) {
    if (!host) return;
    host.innerHTML = '';

    host.appendChild(toolbar(g));

    /* ---- 内嵌浏览器（主人定的：不跳出去，就嵌在 MOD 管理里）----
     * 开着的时候占据 MOD 列表的位置；面板元素是持久复用的，
     * 断连会自动重建，挂进去之后 modResume 恢复上次地址。 */
    if (state.browser === g.id && window.BrowserTabs) {
      host.appendChild(window.BrowserTabs.modElement(g));
      window.BrowserTabs.modResume();
      return;   // 浏览器面板就占这一块，MOD 列表先不画
    }

    if (state.loading) {
      host.appendChild(el('div', { class: 'pfd-mod-empty' }, [
        el('div', { class: 'pfd-mod-empty-art', text: '⏳' }),
        el('div', { class: 'pfd-mod-empty-t', text: '正在读取 MOD…' }),
        el('div', { class: 'pfd-mod-empty-d', text: '正在扫创意工坊目录和游戏自带的 MOD 文件夹' })
      ]));
      return;
    }

    if (state.error) {
      host.appendChild(el('div', { class: 'pfd-mod-empty' }, [
        el('div', { class: 'pfd-mod-empty-art', text: '⚠' }),
        el('div', { class: 'pfd-mod-empty-t', text: '读取失败' }),
        el('div', { class: 'pfd-mod-empty-d', text: state.error }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '重试',
          onclick: () => load(g)
        })
      ]));
      return;
    }

    const d = state.data;
    if (!d || !d.counts || !d.counts.total) {
      host.appendChild(emptyState(g, d));
      return;
    }

    // 标签筛选条（二级分类的入口）：只有真的存在标签才画
    if (d.tags && d.tags.length) host.appendChild(tagBar(g, d));

    // 横列：一个标签一行
    const groups = groupsFor(d);
    const wrap = el('div', { class: 'pfd-mod-groups' });
    for (const grp of groups) {
      wrap.appendChild(groupRow(g, grp));
    }
    host.appendChild(wrap);

    // 后端的补充说明（例如"连不上创意工坊接口"）—— 有就必须显示，
    // 不然用户看到一堆"创意工坊项目 123456"会以为是自己订错了
    if (d.note) host.appendChild(el('div', { class: 'pfd-mod-note', text: 'ℹ ' + d.note }));
  }

  /**
   * 算出当前要显示的分组。
   *
   * 两种模式，口径**故意不一样**：
   *   · 没选标签 → 用后端给的 groups（按"第一个标签"归属），
   *     一个 MOD 只出现在一组里，不会重复。
   *   · 选了标签 → 从完整列表里按**成员关系**筛（带这个标签就算），
   *     因为用户点「Maps」想看的是"所有带 Maps 的 MOD"，一个都不能少。
   *     这两个口径混用会出 bug：分组按归属、筛选按成员，才各自都对。
   */
  function groupsFor(d) {
    if (!state.tag) return d.groups || [];

    const isPseudo = PSEUDO.includes(state.tag);
    const mods = (d.mods || []).filter((m) => {
      const tags = (m.tags || []).filter(Boolean);
      if (isPseudo) {
        // 兜底桶按"归属"匹配：和 groupKeyOf 的规则保持一致
        const key = tags.length ? tags[0] : (m.kind === 'workshop' ? UNTAGGED_WORKSHOP : UNTAGGED_LOCAL);
        return key === state.tag;
      }
      return tags.includes(state.tag);
    });
    if (!mods.length) return [];
    return [{ tag: state.tag, mods }];
  }

  /* ================================================================
   *  工具条
   * ================================================================ */

  function toolbar(g) {
    const d = state.data;
    const isSteam = !!g.steamAppId;

    /* ---- 统计 ---- */
    const counts = d && d.counts;
    const statText = counts && counts.total
      ? `共 ${counts.total} 个 · 启用 ${counts.enabled} · 禁用 ${counts.disabled}`
        + (counts.workshop ? ` · 创意工坊 ${counts.workshop}` : '')
      : (state.loading ? '读取中…' : '暂无 MOD');

    const row1 = el('div', { class: 'pfd-mod-bar' }, [
      el('span', { class: 'pfd-mod-count', text: statText }),

      /* ---- 添加 MOD ----
       * 主人定的规则：Steam 游戏点它就是去创意工坊订阅；
       * 非 Steam 游戏没有工坊可去，所以只能自己选文件夹。 */
      isSteam
        ? el('button', {
            class: 'btn btn-primary btn-sm',
            text: '➕ 添加 MOD',
            title: `到 Steam 创意工坊给「${g.name}」找 MOD（订阅后会自动装到本地）`,
            onclick: () => openWorkshop(g)
          })
        : el('button', {
            class: 'btn btn-primary btn-sm',
            text: '➕ 添加 MOD',
            title: '这款游戏不在 Steam 上，手动选一个 MOD 文件夹或文件加进来',
            onclick: () => addManual(g)
          }),

      // Steam 游戏额外保留"手动加本地 MOD"的口子 —— 不少 Steam 游戏
      // 同时也有自己的一堆本地 MOD（比如 N 网下的），不给入口反而别扭
      isSteam
        ? el('button', {
            class: 'btn btn-ghost btn-sm', text: '📂 手动添加',
            title: '添加不在创意工坊里的本地 MOD（文件夹或文件）',
            onclick: () => addManual(g)
          })
        : null,

      // Steam 客户端里的工坊页（订阅要在客户端点，网页版只能看）
      isSteam
        ? el('button', {
            class: 'btn btn-ghost btn-sm', text: '🛠 创意工坊',
            title: '在 Steam 客户端里打开创意工坊（订阅/取消订阅要在客户端里做）',
            onclick: () => openWorkshop(g, true)
          })
        : null,

      el('button', {
        class: 'btn btn-ghost btn-sm pfd-mod-nnbtn',
        text: state.browser === g.id ? '🌐 收起 N 网' : '🌐 N 网',
        title: `在 MOD 管理里直接打开 N 网搜「${g.name}」（下载会直接进这款游戏的 MOD 目录）`,
        onclick: () => toggleBrowser(g)
      }),

      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '⬇ 快速导入',
        title: '把下载好的 mod（zip / 文件夹）拖进对话框，自动放进这款游戏的 MOD 目录',
        onclick: () => quickImport(g)
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '🧮 对齐',
        title: '列出全部 mod：一键打包成 zip，或用 MOD 码和朋友核对缺漏',
        onclick: () => alignTool(g)
      }),

      K.spacer(),

      /* ---- 排序 ---- */
      sortSelect(g),
      el('button', {
        class: 'btn btn-ghost btn-sm pfd-mod-dirbtn',
        text: state.sortAsc ? '↑' : '↓',
        title: state.sortAsc ? '当前升序，点击改降序' : '当前降序，点击改升序',
        onclick: () => { state.sortAsc = !state.sortAsc; rerender(g); }
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: '↻ 刷新',
        title: '重新扫描 MOD 目录，并联网刷新创意工坊的名称与标签',
        onclick: () => load(g, { online: true, force: true })
      })
    ].filter(Boolean));

    return row1;
  }

  /** 排序下拉。用原生 select —— 和设置页保持一致，省得再造一套 */
  function sortSelect(g) {
    const sel = el('select', { class: 'pfd-mod-sort', title: 'MOD 排序方式' });
    for (const s of SORTS) {
      sel.appendChild(el('option', { value: s.id, text: s.label }));
    }
    sel.value = state.sortBy;
    sel.addEventListener('change', () => {
      state.sortBy = sel.value;
      rerender(g);
    });
    return sel;
  }

  /* ================================================================
   *  标签（二级分类）筛选条
   * ================================================================ */

  function tagBar(g, d) {
    const bar = el('div', { class: 'pfd-mod-tagbar' });
    // 条目数用后端的 tagCounts（按成员关系统计），别在这里自己数 ——
    // 数错了筛选条会显示"Maps 3"，点进去却只有 1 个
    const cnt = d.tagCounts || {};

    // 「全部」
    bar.appendChild(el('button', {
      class: 'pfd-mod-tag' + (state.tag ? '' : ' is-on'),
      text: `全部 ${d.counts.total}`,
      onclick: () => { state.tag = ''; rerender(g); }
    }));

    // 标签多的时候会挤爆，所以这一条也允许横向滚动
    const rail = el('div', { class: 'pfd-mod-tagrail' });
    for (const t of d.tags) {
      rail.appendChild(el('button', {
        class: 'pfd-mod-tag' + (state.tag === t ? ' is-on' : ''),
        text: `${t} ${cnt[t] || 0}`,
        title: `只看带「${t}」标签的 MOD`,
        onclick: () => { state.tag = state.tag === t ? '' : t; rerender(g); }
      }));
    }
    // 兜底桶（本地 MOD / 创意工坊无标签）也要能单独筛出来。
    // 它们不是真标签，但用户会想"只看本地那些"，所以照样给一个入口。
    for (const p of PSEUDO) {
      if (!cnt[p]) continue;
      rail.appendChild(el('button', {
        class: 'pfd-mod-tag' + (state.tag === p ? ' is-on' : ''),
        text: `${p} ${cnt[p]}`,
        title: p === UNTAGGED_LOCAL ? '游戏目录里发现的本地 MOD' : '创意工坊条目，但作者没设标签',
        onclick: () => { state.tag = state.tag === p ? '' : p; rerender(g); }
      }));
    }
    bar.appendChild(rail);
    return bar;
  }

  /* ================================================================
   *  一行 MOD（横向滚动）
   * ================================================================ */

  function groupRow(g, grp) {
    const rail = el('div', { class: 'pfd-mod-rail' });
    for (const m of grp.mods) rail.appendChild(modCard(g, m));

    return el('div', { class: 'pfd-mod-group' }, [
      el('div', { class: 'pfd-mod-ghead' }, [
        el('span', { class: 'pfd-mod-gname', text: grp.tag }),
        el('span', { class: 'pfd-mod-gcount', text: `${grp.mods.length} 个` })
      ]),
      rail
    ]);
  }

  /**
   * 一张 MOD 卡片。
   *
   * ⚠ 所有文字都走 textContent（el 的 text 属性），不用 innerHTML ——
   *   创意工坊的标题是用户可以自由命名的，里面完全可能有 `<` `&`，
   *   拼 HTML 就等于把注入口子开着。
   */
  function modCard(g, m) {
    const card = el('div', { class: 'pfd-mod-card' + (m.enabled ? '' : ' is-off') });

    /* ---- 预览图 ---- */
    const thumb = el('div', { class: 'pfd-mod-thumb' });
    applyGradient(thumb, m.title || 'MOD');
    if (m.previewUrl) {
      const img = el('img', { src: m.previewUrl, alt: '', loading: 'lazy' });
      // 图挂了就露出底下的渐变 + 首字母，不留破图
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el('div', { class: 'pf-ph', text: initialOf(m.title || 'M') }));
    }
    if (!m.enabled) thumb.appendChild(el('div', { class: 'pfd-mod-offmask', text: '已禁用' }));
    card.appendChild(thumb);

    /* ---- 正文 ---- */
    const body = el('div', { class: 'pfd-mod-body' });

    body.appendChild(el('div', {
      class: 'pfd-mod-name',
      text: m.title || '（未命名）',
      title: m.title || ''
    }));

    // meta：来源 · 大小 · 更新时间。没有的项直接不显示，不拿 0 糊弄
    const meta = [];
    meta.push(m.kind === 'workshop' ? '创意工坊' : (m.source || '本地'));
    if (m.sizeBytes) meta.push(fmtBytes(m.sizeBytes));
    if (m.timeUpdated) meta.push('更新于 ' + fmtRelative(m.timeUpdated * 1000));
    body.appendChild(el('div', { class: 'pfd-mod-meta', text: meta.join(' · ') }));

    // 标签 chips
    if (m.tags && m.tags.length) {
      const chips = el('div', { class: 'pfd-mod-chips' });
      // 最多显示 3 个，多的收成 +N —— 卡片宽度有限，多了会把高度撑乱
      for (const t of m.tags.slice(0, 3)) {
        chips.appendChild(el('span', {
          class: 'pfd-mod-chip', text: t,
          title: `只看「${t}」`,
          onclick: (e) => { e.stopPropagation(); state.tag = t; rerender(g); }
        }));
      }
      if (m.tags.length > 3) {
        chips.appendChild(el('span', {
          class: 'pfd-mod-chip more', text: '+' + (m.tags.length - 3),
          title: m.tags.join(' / ')
        }));
      }
      body.appendChild(chips);
    }
    card.appendChild(body);

    /* ---- 操作 ---- */
    const acts = el('div', { class: 'pfd-mod-acts' });

    acts.appendChild(el('button', {
      class: 'btn btn-sm ' + (m.enabled ? 'btn-ghost' : 'btn-primary'),
      text: m.enabled ? '⏸ 禁用' : '▶ 启用',
      title: m.enabled
        ? '禁用它：把文件改名加上 ' + '.gamehub-disabled 后缀（随时可以启用回来）'
        : '启用它：把文件名改回去',
      onclick: () => toggle(g, m)
    }));

    acts.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', text: '📁 定位', title: '在资源管理器里定位',
      onclick: async () => {
        const r = await window.API.modReveal({ path: m.path });
        if (r && r.ok === false) window.App.toast(r.error || '定位失败', 'error');
      }
    }));

    /* ⚠ 这里用文字「删除」而不是 🗑。
     *   实测 🗑 在 Windows 上（Segoe UI Emoji 的字形 + 这一档字号）
     *   渲染出来是一小块暗红色污渍，根本看不出是垃圾桶 ——
     *   截图放大看过，确认不是错觉。
     *   项目里其它地方的危险按钮本来也全是文字（见 modals.js 的 confirmRemove），
     *   只有我这里用了图标，算我不一致。 */
    acts.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm danger', text: '删除', title: '删除（移入回收站，可以还原）',
      onclick: () => confirmDelete(g, m)
    }));

    card.appendChild(acts);
    return card;
  }

  /* ================================================================
   *  空状态
   * ================================================================ */

  function emptyState(g, d) {
    const isSteam = !!g.steamAppId;
    const tips = [];

    if (isSteam) {
      tips.push('这款游戏在 Steam 上 —— 点「➕ 添加 MOD」会直接跳到它的创意工坊，'
        + '订阅之后 Steam 会自动把 MOD 装到本地，回到这里就能看到。');
    } else {
      tips.push('这款游戏不在 Steam 上，没有创意工坊。'
        + '点「➕ 添加 MOD」选一个 MOD 文件夹（或 mod 文件）加进来。');
    }

    // 把扫描过哪些地方如实说出来 —— 用户才好判断"是我没装 MOD"还是"它没找到"
    const sources = (d && d.sources) || [];
    const scanned = sources.map((s) => s.label + '（' + (s.count || 0) + '）').join('、');

    return el('div', { class: 'pfd-mod-empty' }, [
      el('div', { class: 'pfd-mod-empty-art', text: '🧩' }),
      el('div', { class: 'pfd-mod-empty-t', text: '还没有发现 MOD' }),
      el('div', { class: 'pfd-mod-empty-d', text: tips.join(' ') }),
      scanned ? el('div', { class: 'pfd-mod-empty-d dim', text: '已扫描：' + scanned }) : null,
      el('div', { class: 'pfd-mod-empty-row' }, [
        isSteam
          ? el('button', {
              class: 'btn btn-primary btn-sm', text: '🛠 去创意工坊看看',
              onclick: () => openWorkshop(g)
            })
          : el('button', {
              class: 'btn btn-primary btn-sm', text: '➕ 添加 MOD',
              onclick: () => addManual(g)
            }),
        el('button', {
          class: 'btn btn-primary btn-sm', text: '🌐 N 网找找',
          title: '就在这个区块里打开 N 网，下载会直接进这款游戏的 MOD 目录',
          onclick: () => toggleBrowser(g)
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '📂 指定 MOD 目录',
          title: '自动推断的目录不对时，给这款游戏手动指定一个',
          onclick: () => pickModDir(g)
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '↻ 重新扫描',
          onclick: () => load(g, { online: true, force: true })
        })
      ])
    ].filter(Boolean));
  }

  /* ================================================================
   *  动作
   * ================================================================ */

  /** 重画当前区块（排序/筛选变了都走这里，不重新拉数据） */
  function rerender(g) {
    paint(state.container, g);
  }

  /**
   * 启用 / 禁用。
   *
   * ⚠ 创意工坊的条目改名之后，Steam 会认为这份内容不完整，
   *   下次校验/更新时**可能重新下载一份**。这是这套做法的已知代价，
   *   不能瞒着用户 —— 所以第一次禁用创意工坊 MOD 时会额外提示一句。
   */
  async function toggle(g, m) {
    const want = !m.enabled;
    const r = await window.API.modSetEnabled({ id: g.id, path: m.path, enabled: want });

    if (!r || !r.ok) {
      window.App.toast((r && r.error) || (want ? '启用失败' : '禁用失败'), 'error', 6000);
      return;
    }

    const msg = want ? `已启用「${m.title}」` : `已禁用「${m.title}」`;
    const extra = (!want && m.kind === 'workshop')
      ? '　Steam 下次校验时可能会重新下载它。'
      : '';
    window.App.toast(msg + extra, 'success', extra ? 7000 : 3600);

    // 磁盘真的变了，重新扫一遍（以磁盘为准，不自己改内存里的状态）
    await load(g, { online: false });
  }

  /**
   * 删除前确认。
   *
   * 刻意做得很"啰嗦"：把名字、大小、完整路径一条条摆出来。
   * 原因很简单 —— 这是一次不可逆感很强的操作，用户点之前
   * 必须能确认"删的到底是哪一个"，而不是靠记忆。
   */
  function confirmDelete(g, m) {
    const isWs = m.kind === 'workshop';

    window.Modals.openModal({
      title: '删除这个 MOD？',
      sub: '会移入 Windows 回收站，不是永久删除 —— 后悔了还能还原',
      size: 'sm',
      renderBody: (body) => {
        body.appendChild(el('div', { class: 'mod-del-name', text: m.title || '（未命名）' }));

        const kv = el('div', { class: 'mod-del-kv' });
        const add = (k, v) => {
          if (!v) return;
          kv.appendChild(el('div', { class: 'mod-del-k' , text: k }));
          kv.appendChild(el('div', { class: 'mod-del-v', text: v, title: v }));
        };
        add('来源', m.kind === 'workshop' ? 'Steam 创意工坊' : (m.source || '本地 MOD'));
        add('大小', m.sizeBytes ? fmtBytes(m.sizeBytes) : '未知');
        add('状态', m.enabled ? '当前启用中' : '当前已禁用');
        add('路径', m.path || '');
        body.appendChild(kv);

        if (isWs) {
          body.appendChild(el('div', { class: 'mod-del-warn' }, [
            el('strong', { text: '这是创意工坊内容。' }),
            el('span', {
              text: '删掉本机文件后，只要你的 Steam 账号还订阅着它，'
                  + 'Steam 下次启动这个游戏时会自动重新下载。'
                  + '想彻底不要它，请到创意工坊里取消订阅。'
            })
          ]));
        } else {
          body.appendChild(el('div', { class: 'mod-del-warn' }, [
            el('strong', { text: '这是本地 MOD 文件。' }),
            el('span', {
              text: '它会被移入回收站。GameHub 不会清空回收站，'
                  + '需要的话你自己去里面还原或彻底删除。'
            })
          ]));
        }
      },
      renderFoot: (foot) => {
        foot.appendChild(el('button', {
          class: 'btn btn-ghost', text: '取消',
          onclick: () => window.Modals.closeModal()
        }));
        foot.appendChild(el('button', {
          class: 'btn btn-danger', text: '移入回收站',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = '正在移入回收站…';

            const r = await window.API.modRemove({ gameId: g.id, path: m.path });
            if (!r || !r.ok) {
              btn.disabled = false;
              btn.textContent = '移入回收站';
              window.App.toast((r && r.error) || '删除失败', 'error', 7000);
              return;
            }
            window.Modals.closeModal();
            window.App.toast(`「${m.title}」已移入回收站`, 'success', 6000);
            await load(g, { online: false });
          }
        }));
      }
    });
  }

  /** 打开 Steam 创意工坊（默认网页版；client=true 走 Steam 客户端） */
  async function openWorkshop(g, client) {
    const r = await window.API.modOpenWorkshop({ appId: g.steamAppId, client: !!client });
    if (r && r.ok) {
      if (r.fellBack) {
        window.App.toast('Steam 客户端没响应（可能没装或没运行），已在浏览器里打开创意工坊', 'warn', 7000);
      } else {
        window.App.toast(client ? '正在用 Steam 客户端打开创意工坊…' : '已在浏览器打开创意工坊', 'success');
      }
      return;
    }
    window.App.toast((r && r.error) || '打开创意工坊失败', 'error');
  }

  /**
   * 在**内置浏览器**里打开 N 网找 MOD。
   *
   * 为什么不直接丢给系统浏览器：那样下载完文件躺在「下载」目录，
   * 用户得自己找、自己解压、自己判断该放哪个游戏的哪个子目录 ——
   * 而 MOD 放错目录**不会报错，只会静默失效**，是最折腾人的一步。
   * 内置浏览器能把下载直接接管到这款游戏的 MOD 目录。
   *
   * 打开前先问一次"会下载到哪"，让用户有机会发现目录不对、改成自己指定的。
   */
  /**
   * 在 MOD 管理区块里开关内嵌浏览器（点「🌐 N 网」）。
   *
   * 为什么嵌在这里：主人反馈跳到整个内容区太突兀 —— 就地展开，
   * 浏览器就长在 MOD 管理区块里，点「收起 N 网」恢复 MOD 列表。
   */
  async function toggleBrowser(g) {
    // 已开着 → 收起，恢复 MOD 列表
    if (state.browser === g.id) {
      state.browser = null;
      window.BrowserTabs.modClose();
      paint(state.container, g);
      return;
    }

    // 主进程把「打开哪、会下到哪、标签 id」一起算好；
    // 目录认不出时 target.dir 为空，下载时会退化成弹窗让你选，绝不硬放
    const r = await window.API.modBrowse({ id: g.id, name: g.name });
    if (!r || !r.ok) {
      window.App.toast((r && r.error) || '打开 N 网失败', 'error');
      return;
    }

    state.browser = g.id;
    paint(state.container, g);
    window.BrowserTabs.modOpen(g, { url: r.url, target: r.target, tabId: r.tabId });
  }

  /* ================================================================
   *  快速导入 & 对齐工具
   * ================================================================ */

  /**
   * 快速导入：把下载好的 mod 拖进对话框就进游戏。
   * 拿拖入路径必须走 API.pathForFile —— Electron ≥32 的 File 已经
   * 没有 .path 属性了，得让 preload 里的 webUtils 换（详见 preload 注释）。
   */
  function quickImport(g) {
    const M = window.Modals;
    const { body, foot } = M.openModal({
      title: `快速导入 MOD — ${g.name}`,
      sub: 'zip 压缩包或文件夹都行，可一次拖多个'
    });

    const box = el('div', { class: 'qi-drop' }, [
      el('div', { class: 'qi-drop-icon', text: '⬇' }),
      el('div', { class: 'qi-drop-t', text: '把 mod 拖到这里' }),
      el('div', { class: 'qi-drop-d', text: '松手后自动解压 / 复制到这款游戏的 MOD 目录' })
    ]);
    const resBox = el('div', { class: 'qi-results' });
    body.appendChild(box);
    body.appendChild(resBox);

    async function importPaths(paths) {
      if (!paths || !paths.length) return;
      resBox.innerHTML = '';
      resBox.appendChild(el('div', { class: 'qi-busy', text: '正在导入…' }));
      const r = await window.API.modImportDrop({ id: g.id, paths }).catch(() => null);
      resBox.innerHTML = '';
      if (!r || !r.ok) {
        resBox.appendChild(el('div', { class: 'qi-err', text: (r && r.error) || '导入失败' }));
        return;
      }
      for (const it of r.results) {
        resBox.appendChild(el('div', { class: 'qi-item ' + (it.ok ? 'ok' : 'fail') }, [
          el('span', { class: 'qi-item-name', text: (it.ok ? '✔ ' : '✖ ') + it.name }),
          el('span', { class: 'qi-item-note', text: it.ok ? `${it.action} → ${it.target}` : (it.error || '') })
        ]));
      }
      if (r.imported > 0) {
        window.App.toast(`已导入 ${r.imported} 项，MOD 列表刷新中`, 'success', 4000);
        load(g);          // mod 目录变了，列表重拉
      }
    }

    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('dragging'); });
    box.addEventListener('dragleave', () => box.classList.remove('dragging'));
    box.addEventListener('drop', async (e) => {
      e.preventDefault();
      box.classList.remove('dragging');
      const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])]
        .map((f) => window.API.pathForFile(f))
        .filter(Boolean);
      await importPaths(paths);
    });

    foot.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '📂 从文件选择框挑…',
      onclick: async () => {
        const r = await window.API.modPickFiles().catch(() => null);
        if (r && r.ok) await importPaths(r.paths);
      }
    }));
    foot.appendChild(K.spacer());
    foot.appendChild(el('button', {
      class: 'btn btn-primary btn-sm', text: '完成', onclick: () => M.closeModal()
    }));
  }

  /** 对齐工具：mod 清单 + 打包 + MOD 码 */
  async function alignTool(g) {
    const M = window.Modals;
    const lst = await window.API.modList({ id: g.id, online: false }).catch(() => null);
    const names = lst && lst.ok
      ? (lst.mods || []).map((m) => m.title || m.name).filter(Boolean)
      : [];

    const { body, foot } = M.openModal({
      title: `MOD 对齐工具 — ${g.name}`,
      sub: names.length ? `共 ${names.length} 个 mod` : '这款游戏还没有 mod'
    });

    /* ---- 清单 ---- */
    const listBox = el('div', { class: 'al-list' });
    if (!names.length) {
      listBox.appendChild(el('div', { class: 'al-empty', text: '（空）' }));
    } else {
      names.forEach((n, i) => listBox.appendChild(el('div', { class: 'al-item' }, [
        el('span', { class: 'al-idx', text: String(i + 1) }),
        el('span', { text: n })
      ])));
    }
    body.appendChild(listBox);

    /* ---- 打包 ---- */
    body.appendChild(el('div', { class: 'al-sec-t', text: '📦 快速打包 — 把全部 mod 压成一个 zip，备份或发给别人' }));
    const packNote = el('span', { class: 'al-note' });
    body.appendChild(el('div', { class: 'al-row' }, [
      el('button', {
        class: 'btn btn-primary btn-sm',
        text: '打包为 zip…',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          packNote.textContent = '正在打包…';
          const r = await window.API.modPack({ id: g.id }).catch(() => null);
          btn.disabled = false;
          if (!r || r.canceled) { packNote.textContent = r && !r.ok && r.error ? r.error : ''; return; }
          if (r.ok) {
            packNote.textContent = `✔ 已打包 ${r.count} 项（${(r.size / 1048576).toFixed(1)} MB）`;
            window.App.toast('打包完成：' + r.file, 'success', 5000);
          } else {
            packNote.textContent = r.error || '打包失败';
          }
        }
      }),
      packNote
    ]));

    /* ---- MOD 码 ---- */
    body.appendChild(el('div', { class: 'al-sec-t', text: '🔢 MOD 码 — 按这份 mod 清单生成，发给别人即可核对缺漏' }));
    const codeBox = el('div', { class: 'al-code', text: names.length ? '生成中…' : '（没有 mod，生成不了）' });
    const copyBtn = el('button', {
      class: 'btn btn-ghost btn-sm', text: '复制 MOD 码', disabled: !names.length,
      onclick: async () => {
        try { await navigator.clipboard.writeText(codeBox.dataset.code || ''); window.App.toast('MOD 码已复制', 'success', 2500); }
        catch { window.App.toast('复制失败，请手动选择复制', 'error', 3000); }
      }
    });
    if (names.length) {
      window.API.modCode({ id: g.id }).then((r) => {
        if (r && r.ok) {
          codeBox.dataset.code = r.code;
          codeBox.textContent = r.code.length > 260 ? r.code.slice(0, 260) + ' …' : r.code;
        } else {
          codeBox.textContent = (r && r.error) || '生成失败';
        }
      }).catch(() => { codeBox.textContent = '生成失败'; });
    }
    body.appendChild(el('div', { class: 'al-row' }, [codeBox, copyBtn]));

    /* ---- 导入码对比 ---- */
    body.appendChild(el('div', { class: 'al-sec-t', text: '📥 对比别人的 MOD 码 — 看看自己多了哪些、缺了哪些' }));
    const input = el('textarea', {
      class: 'al-input', rows: 3, spellcheck: false,
      placeholder: '把别人的 MOD 码整串粘到这里（GHMOD1-… 开头）'
    });
    const diffRes = el('div', { class: 'al-diff' });
    body.appendChild(input);
    body.appendChild(el('div', { class: 'al-row' }, [
      el('button', {
        class: 'btn btn-primary btn-sm', text: '对比',
        onclick: async () => {
          const v = (input.value || '').trim();
          if (!v) return;
          diffRes.innerHTML = '';
          diffRes.appendChild(el('div', { class: 'al-note', text: '对比中…' }));
          const r = await window.API.modCodeDiff({ id: g.id, code: v }).catch(() => null);
          diffRes.innerHTML = '';
          if (!r || !r.ok) {
            diffRes.appendChild(el('div', { class: 'qi-err', text: (r && r.error) || '对比失败' }));
            return;
          }
          const mk = (title, items, cls) => {
            const w = el('div', { class: 'al-diff-sec ' + cls }, [el('div', { class: 'al-diff-t', text: title })]);
            if (!items.length) w.appendChild(el('div', { class: 'al-note', text: '（无）' }));
            else items.forEach((n) => w.appendChild(el('div', { class: 'al-diff-item', text: n })));
            return w;
          };
          diffRes.appendChild(el('div', {
            class: 'al-note',
            text: `对方 ${r.total} 个 · 你这边 ${r.localCount} 个 · 相同 ${r.same.length}`
          }));
          diffRes.appendChild(mk(`❌ 你缺少的（${r.missing.length}）`, r.missing, 'miss'));
          diffRes.appendChild(mk(`➕ 你多出的（${r.extra.length}）`, r.extra, 'extra'));
        }
      })
    ]));
    body.appendChild(diffRes);

    foot.appendChild(K.spacer());
    foot.appendChild(el('button', {
      class: 'btn btn-primary btn-sm', text: '完成', onclick: () => M.closeModal()
    }));
  }

  /**
   * 给这款游戏手动指定 MOD 目录。
   *
   * 为什么要有这个入口：自动推断再全也覆盖不到所有游戏，
   * 尤其是改名过的、绿色版的、或者用户自己有习惯放法的。
   * 而 MOD 放错目录不会报错、只会静默失效 —— 必须给用户一个能直接改的口子。
   */
  async function pickModDir(g) {
    const cur = await window.API.modDownloadTarget({ id: g.id }).catch(() => null);

    const r = await window.API.modSetModDir({ id: g.id }).catch(() => null);
    if (!r) { window.App.toast('选择 MOD 目录失败', 'error'); return; }
    if (r.canceled) return;

    window.App.toast(
      `已指定「${g.name}」的 MOD 目录：${r.dir}` +
      (cur && cur.dir && cur.dir !== r.dir ? `（原来是 ${cur.dir}）` : ''),
      'success',
      5000
    );
  }

  /** 手动添加 */
  async function addManual(g) {
    const r = await window.API.modAddManual({
      id: g.id,
      // 默认从游戏安装目录开始找，省得用户从头翻
      installDir: g.installDir || ''
    });
    if (r && r.canceled) return;
    if (r && r.ok) {
      window.App.toast(`已添加「${r.name}」`, 'success');
      await load(g, { online: false });
      return;
    }
    window.App.toast((r && r.error) || '添加失败', 'error');
  }

  /* ================================================================
   *  给脚本用的出口
   * ----------------------------------------------------------------
   *  截图 / 探针要能"停在某个 MOD 状态上"，所以把重绘和排序暴露出去。
   *  这些不是给产品逻辑用的，别在别处调。
   * ================================================================ */
  window.ModView = {
    section,
    /** 当前区块状态（调试用） */
    _state: () => state,
    /** 手动触发一次重绘（脚本切排序/筛选后用） */
    _repaint: (g) => rerender(g)
  };
})();
