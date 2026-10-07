/**
 * ============================================================
 *  GameHub - 游玩统计页面  (js/statsview.js)
 * ------------------------------------------------------------
 *  仿 Steam「年度总结」的排版，但一屏就能看完，不用一页页翻。
 *
 *  一屏回答三个问题：
 *    · 玩了多久     → 顶部大数字 + 每日/每月趋势柱状图
 *    · 喜欢什么类型 → 按类型拆分的时长条（占比重）
 *    · 打开多少次   → 按类型拆分的次数条，以及按游戏的排行
 *
 *  周期：本周 / 本月 / 本季度 / 今年 / 全部时间
 *
 *  说明：一款游戏可以有多个分类，统计时它会同时计入每个分类，
 *        所以各分类相加会大于总时长。这是刻意的（问题问的是"喜好"），
 *        页面上也写了注释，免得被当成数据错误。
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const { el, fmtDuration } = U;
  const API = window.API;

  /** 周期选项（与主进程 stats.js 的 PERIODS 对应） */
  const PERIODS = [
    { key: 'week', label: '本周', sub: '最近 7 天内的这一周' },
    { key: 'month', label: '本月', sub: '本月 1 号至今' },
    { key: 'quarter', label: '本季度', sub: '本季度首月 1 号至今' },
    { key: 'year', label: '今年', sub: '1 月 1 号至今' },
    { key: 'all', label: '全部', sub: '游戏库里的累计数据' }
  ];

  /** 当前选中的周期（渲染时从 State 里读，切走再回来能记住） */
  let period = 'month';
  /** 当前周期的数据缓存 */
  let data = null;
  let loading = false;

  /* ================================================================
   *  入口：把统计页画到内容区
   * ================================================================ */
  async function render(host) {
    if (!host) return;

    // 周期优先用上次记住的
    const saved = window.State.settings && window.State.settings.statsPeriod;
    if (saved && PERIODS.some((p) => p.key === saved)) period = saved;

    host.innerHTML = '';
    const shell = el('div', { class: 'stats-page' });
    host.appendChild(shell);

    // 先画骨架（周期切换 + 加载中），数据回来再填内容
    renderShell(shell);
    await loadAndPaint(shell);
  }

  /** 周期切换 + 内容容器 */
  function renderShell(shell) {
    // 顶部：标题 + 周期切换
    const tabs = el('div', { class: 'stats-tabs' });
    for (const p of PERIODS) {
      tabs.appendChild(el('button', {
        class: 'stats-tab' + (p.key === period ? ' active' : ''),
        text: p.label,
        title: p.sub,
        dataset: { period: p.key },
        onclick: async () => {
          if (loading || p.key === period) return;
          period = p.key;
          // 记住选择，下次进统计页还是这个周期
          API.settingsSet({ statsPeriod: period });
          shell.querySelectorAll('.stats-tab').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
          await loadAndPaint(shell);
        }
      }));
    }

    shell.appendChild(el('div', { class: 'stats-head' }, [
      el('div', {}, [
        el('div', { class: 'stats-title', text: '游玩统计' }),
        el('div', { class: 'stats-sub', text: '看看你最近在玩什么、玩了多久' })
      ]),
      tabs
    ]));

    shell.appendChild(el('div', { class: 'stats-content', id: 'statsContent' }));
  }

  /** 拉数据并重画内容区 */
  async function loadAndPaint(shell) {
    const box = shell.querySelector('#statsContent');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'stats-loading', text: '正在统计…' }));

    loading = true;
    const r = await API.stats(period);
    loading = false;
    // 切换过程中用户可能已经切到别的页面了
    if (!box.isConnected) return;

    if (!r || r.ok === false) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-art', text: '⚠' }),
        el('div', { class: 'empty-title', text: '统计失败' }),
        el('div', { class: 'empty-desc', text: (r && r.error) || '暂时拿不到统计数据，稍后再试试。' })
      ]));
      return;
    }

    data = r;
    box.innerHTML = '';
    paintContent(box, r);
  }

  /* ================================================================
   *  内容绘制
   * ================================================================ */
  function paintContent(box, d) {
    const hasData = d.totals.ms > 0 || d.totals.count > 0;

    /* ---------- ① 大数字卡片 ---------- */
    box.appendChild(el('div', { class: 'stats-hero' }, [
      bigCard('总游玩时长', fmtDuration(d.totals.ms || 0), d.totals.ms > 0 ? `${fmtHours(d.totals.ms)} 小时` : '还没有记录', 'clock'),
      bigCard('启动次数', String(d.totals.count || 0) + ' 次', d.totals.avgMs > 0 ? `平均每次 ${fmtDuration(d.totals.avgMs)}` : '—', 'play'),
      bigCard('玩过的游戏', String(d.totals.gameCount || 0) + ' 款', d.totals.gameCount ? '至少打开过一次' : '—', 'game'),
      bigCard('最爱的类型', d.peak && d.peak.topCategory ? d.peak.topCategory.name : '暂无',
        d.peak && d.peak.topCategory ? fmtDuration(d.peak.topCategory.ms) : '这个周期还没玩', 'heart')
    ]));

    if (!hasData) {
      box.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-art', text: '📈' }),
        el('div', { class: 'empty-title', text: `${d.label}还没有游玩记录` }),
        el('div', {
          class: 'empty-desc',
          text: '游玩时长是从你从这个版本开始启动游戏算起的。启动几次游戏之后，这里就会自动长出图表来。'
        }),
        el('div', { class: 'empty-actions' }, [
          el('button', { class: 'btn btn-primary', text: '去看看游戏库', onclick: () => window.App.goto('all') })
        ])
      ]));
      return;
    }

    /* ---------- ② 一句话亮点 ---------- */
    const facts = [];
    if (d.peak && d.peak.topGame) {
      facts.push(`玩得最多的是《${d.peak.topGame.name}》，共 ${fmtDuration(d.peak.topGame.ms)}`);
    }
    if (d.peak && d.peak.topCategory) {
      facts.push(`最喜欢的类型是「${d.peak.topCategory.name}」，打开过 ${d.peak.topCategory.count} 次`);
    }
    if (d.peak && d.peak.bestDay) {
      facts.push(`最投入的一天是 ${d.peak.bestDay.label}，玩了 ${fmtDuration(d.peak.bestDay.ms)}`);
    }
    if (facts.length) {
      box.appendChild(el('div', { class: 'stats-highlight' }, [
        el('div', { class: 'sh-icon', text: '✦' }),
        el('div', { class: 'sh-list' }, facts.map((t) => el('div', { class: 'sh-item', text: t })))
      ]));
    }

    /* ---------- ③ 趋势柱状图 ---------- */
    if (d.trend && d.trend.length) {
      box.appendChild(card('游玩趋势', trendByMonthHint(d), trendChart(d.trend)));
    }

    /* ---------- ④ 类型偏好（时长 / 次数 两条并排） ---------- */
    const twoCol = el('div', { class: 'stats-row' }, [
      card('喜欢玩什么类型', '按游玩时长排序 · 占该周期的比重', catBars(d.byCategory, 'ms', d.totals.ms)),
      card('打开多少次什么类型', '按启动次数排序', catBars(d.byCategory, 'count', d.totals.count))
    ]);
    box.appendChild(twoCol);

    /* ---------- ⑤ 游戏时长排行 ---------- */
    box.appendChild(card('玩了多久（按游戏）', '这个周期里每款游戏的实际投入', gameRows(d.byGame)));

    /* ---------- ⑥ 脚注 ---------- */
    box.appendChild(el('div', {
      class: 'stats-note',
      text: '注：一款游戏可以有多个分类，会被同时计入每个分类，所以各类型相加会大于总时长。'
    }));
  }

  /** 大数字卡片 */
  function bigCard(label, value, sub, icon) {
    return el('div', { class: 'stats-big' }, [
      el('div', { class: 'sb-icon', text: ICONS[icon] || '•' }),
      el('div', { class: 'sb-body' }, [
        el('div', { class: 'sb-label', text: label }),
        el('div', { class: 'sb-value', text: value, title: value }),
        el('div', { class: 'sb-sub', text: sub })
      ])
    ]);
  }

  const ICONS = { clock: '◷', play: '▶', game: '▦', heart: '★' };

  /** 通用卡片外壳 */
  function card(title, sub, content) {
    return el('div', { class: 'stats-card' }, [
      el('div', { class: 'sc-head' }, [
        el('div', { class: 'sc-title', text: title }),
        sub ? el('div', { class: 'sc-sub', text: sub }) : null
      ].filter(Boolean)),
      content
    ]);
  }

  /**
   * 趋势柱状图（纯 CSS 高度百分比实现，不引任何图表库）
   * @param {Array<{label:string,ms:number,count:number}>} trend
   */
  function trendChart(trend) {
    const max = Math.max(...trend.map((t) => t.ms), 1);
    const wrap = el('div', { class: 'trend-chart' });
    // 柱子太多时（月视图最多 31 根）只显示间隔标签
    const step = trend.length > 16 ? 3 : 1;

    trend.forEach((t, i) => {
      const pct = Math.max(t.ms > 0 ? 4 : 0, Math.round((t.ms / max) * 100));
      const bar = el('div', {
        class: 'trend-col',
        title: `${t.label}：${t.ms > 0 ? fmtDuration(t.ms) : '没有游玩'} · ${t.count} 次`
      }, [
        el('div', { class: 'trend-bar-wrap' }, [
          el('div', { class: 'trend-bar', style: { height: pct + '%' } })
        ]),
        el('div', { class: 'trend-label', text: (i % step === 0) ? t.label : '' })
      ]);
      wrap.appendChild(bar);
    });
    return wrap;
  }

  function trendByMonthHint(d) {
    if (d.period === 'quarter') return '按月份汇总 · 本季度每月投入';
    if (d.period === 'year') return '按月份汇总 · 今年每月投入';
    return '按天汇总 · 柱子的高度代表当天玩了多久';
  }

  /**
   * 分类条：横向条形 + 数值
   * @param {Array} list byCategory
   * @param {'ms'|'count'} mode
   * @param {number} total 用于算百分比
   */
  function catBars(list, mode, total) {
    const items = (list || []).filter((c) => (mode === 'ms' ? c.ms > 0 : c.count > 0)).slice(0, 10);
    if (!items.length) {
      return el('div', { class: 'stats-empty-line', text: '这个周期还没有对应记录' });
    }
    const max = Math.max(...items.map((c) => (mode === 'ms' ? c.ms : c.count)), 1);
    const wrap = el('div', { class: 'cat-bars' });

    items.forEach((c, i) => {
      const val = mode === 'ms' ? c.ms : c.count;
      const pct = Math.round((val / max) * 100);
      const share = total > 0 ? Math.round((val / total) * 100) : 0;
      wrap.appendChild(el('div', { class: 'cat-bar-row' }, [
        el('div', { class: 'cb-rank', text: String(i + 1) }),
        el('div', { class: 'cb-main' }, [
          el('div', { class: 'cb-top' }, [
            el('div', { class: 'cb-name', text: c.name, title: c.name }),
            el('div', {
              class: 'cb-val',
              text: mode === 'ms' ? fmtDuration(c.ms) : String(c.count) + ' 次',
              title: `占比 ${share}%`
            })
          ]),
          el('div', { class: 'cb-track' }, [
            el('div', { class: 'cb-fill', style: { width: pct + '%' } })
          ])
        ]),
        el('div', { class: 'cb-share', text: share + '%' })
      ]));
    });
    return wrap;
  }

  /** 按游戏的时长排行 */
  function gameRows(list) {
    const items = (list || []).slice(0, 12);
    if (!items.length) {
      return el('div', { class: 'stats-empty-line', text: '这个周期还没有游玩记录' });
    }
    const wrap = el('div', { class: 'game-rows' });
    items.forEach((g, i) => {
      wrap.appendChild(el('div', {
        class: 'game-row',
        title: `点击查看《${g.name}》详情`,
        onclick: () => window.Detail.open(g.id)
      }, [
        el('div', { class: 'gr-rank', text: '#' + (i + 1) }),
        el('div', { class: 'gr-main' }, [
          el('div', { class: 'gr-name', text: g.name, title: g.name }),
          el('div', { class: 'gr-cats', text: (g.categories || []).join(' · ') || '未分类' })
        ]),
        el('div', { class: 'gr-bar' }, [
          el('div', { class: 'gr-fill', style: { width: Math.round((g.shareMs || 0) * 100) + '%' } })
        ]),
        el('div', { class: 'gr-time', text: fmtDuration(g.ms) })
      ]));
    });
    return wrap;
  }

  /** 毫秒 → 保留一位小数的"小时"文案 */
  function fmtHours(ms) {
    const h = ms / 3600000;
    if (h >= 100) return String(Math.round(h));
    return h.toFixed(1);
  }

  window.StatsView = { render };
})();
