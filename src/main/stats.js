/**
 * ============================================================
 *  GameHub - 游玩统计聚合模块  (src/main/stats.js)
 * ------------------------------------------------------------
 *  把"一局一局的游玩流水"（store.sessions）按周期汇总成界面能直接画的数据。
 *
 *  支持的周期：本周 / 本月 / 本季度 / 今年 / 全部
 *  每个周期输出：
 *    · totals     总时长、启动次数、玩过的游戏数
 *    · byCategory 按类型拆分（时长 + 次数）—— 回答"喜欢玩什么类型/打开多少次"
 *    · byGame     按游戏拆分（时长 TOP）—— 回答"玩了多久"
 *    · trend      趋势（本周/月按天，季度/年按月），用于画柱状图
 *    · peak       一句话亮点（玩得最多的类型 / 游戏 / 最活跃的一天）
 *
 *  多分类的计法（重要）：
 *    一款游戏可以有多个分类，比如"动作 + 角色扮演"。
 *    统计时它会同时计入两个分类的时长与次数，所以各分类相加 > 总时长。
 *    这是刻意的 —— 用户问的是"我喜欢玩什么类型"，而不是做账。
 *    界面里会写清楚这一点，避免被当成 bug。
 *
 *  本模块全部是纯函数（只吃 sessions + games），方便单元测试。
 * ============================================================
 */

/** 支持的周期 */
const PERIODS = ['week', 'month', 'quarter', 'year', 'all'];

/** 各周期的中文名 */
const PERIOD_LABEL = {
  week: '本周',
  month: '本月',
  quarter: '本季度',
  year: '今年',
  all: '全部时间'
};

/* ==================================================================
 *  一、时间区间
 * ================================================================== */

/**
 * 算出某个周期的起止时间。
 * 约定：以传入的 ref（默认现在）所在的自然周/月/季度/年为界。
 *  · 周：周一 00:00 起
 *  · 月：1 号 00:00 起
 *  · 季度：1/4/7/10 月 1 号 00:00 起
 *  · 年：1 月 1 号 00:00 起
 * @param {string} period week|month|quarter|year|all
 * @param {Date|number} [ref]
 * @returns {{period:string, label:string, start:number, end:number}}
 */
function rangeFor(period, ref) {
  const now = ref instanceof Date ? ref : new Date(ref === undefined ? Date.now() : ref);
  const y = now.getFullYear();
  const m = now.getMonth();       // 0-11
  const d = now.getDate();

  const startOfDay = new Date(y, m, d, 0, 0, 0, 0).getTime();
  const end = startOfDay + 24 * 3600 * 1000 - 1;   // 当天 23:59:59.999

  let start = 0;
  switch (period) {
    case 'week': {
      // getDay(): 0=周日，这里换算成"距离本周一多少天"
      const dow = (now.getDay() + 6) % 7;
      start = startOfDay - dow * 24 * 3600 * 1000;
      break;
    }
    case 'month':
      start = new Date(y, m, 1, 0, 0, 0, 0).getTime();
      break;
    case 'quarter':
      start = new Date(y, Math.floor(m / 3) * 3, 1, 0, 0, 0, 0).getTime();
      break;
    case 'year':
      start = new Date(y, 0, 1, 0, 0, 0, 0).getTime();
      break;
    case 'all':
    default:
      start = 0;
      break;
  }

  return {
    period: PERIODS.includes(period) ? period : 'month',
    label: PERIOD_LABEL[PERIODS.includes(period) ? period : 'month'],
    start,
    end: period === 'all' ? Number.MAX_SAFE_INTEGER : end
  };
}

/** 取本地时区的 YYYY-MM-DD */
function dayKey(ts) {
  const dt = new Date(ts);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

/** 取本地时区的 YYYY-MM */
function monthKey(ts) {
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/* ==================================================================
 *  二、聚合
 * ================================================================== */

/**
 * 把一个区间内的会话聚合成统计结果。
 * @param {Array<{gameId:string,at:number,ms:number}>} sessions
 * @param {Map<string,object>|Array<object>} gameMap id → 游戏对象
 * @param {{start:number,end:number}} range
 * @param {{trendBy:'day'|'month'}} [opts]
 */
function aggregate(sessions, gameMap, range, opts = {}) {
  const getGame = gameMap instanceof Map ? (id) => gameMap.get(id) : (id) => (gameMap || []).find((g) => g.id === id);
  const trendBy = opts.trendBy || 'day';

  const catMs = new Map();     // 分类 → 毫秒
  const catCount = new Map();  // 分类 → 次数
  const gameMs = new Map();    // 游戏 ID → 毫秒
  const gameCount = new Map(); // 游戏 ID → 次数
  const trend = new Map();     // 时间桶 → { ms, count }
  const playedIds = new Set();

  let totalMs = 0;
  let totalCount = 0;

  for (const s of sessions || []) {
    if (!s || s.at < range.start || s.at > range.end || !(s.ms > 0)) continue;
    const g = getGame(s.gameId);
    if (!g) continue;   // 游戏已经被移出库 → 这条流水不再参与统计

    totalMs += s.ms;
    totalCount += 1;
    playedIds.add(s.gameId);

    gameMs.set(s.gameId, (gameMs.get(s.gameId) || 0) + s.ms);
    gameCount.set(s.gameId, (gameCount.get(s.gameId) || 0) + 1);

    // 多分类：一个游戏同时算进它所有的分类
    for (const c of g.categories || []) {
      catMs.set(c, (catMs.get(c) || 0) + s.ms);
      catCount.set(c, (catCount.get(c) || 0) + 1);
    }

    const key = trendBy === 'month' ? monthKey(s.at) : dayKey(s.at);
    const cur = trend.get(key) || { ms: 0, count: 0 };
    cur.ms += s.ms;
    cur.count += 1;
    trend.set(key, cur);
  }

  /* --- 按分类 --- */
  const byCategory = [...catMs.entries()].map(([name, ms]) => ({
    name,
    ms,
    count: catCount.get(name) || 0,
    gameCount: new Set((sessions || [])
      .filter((s) => s.at >= range.start && s.at <= range.end && (getGame(s.gameId)?.categories || []).includes(name))
      .map((s) => s.gameId)).size,
    shareMs: totalMs ? ms / totalMs : 0,
    shareCount: totalCount ? (catCount.get(name) || 0) / totalCount : 0
  })).sort((a, b) => b.ms - a.ms || b.count - a.count);

  /* --- 按游戏 --- */
  const byGame = [...gameMs.entries()].map(([id, ms]) => {
    const g = getGame(id) || {};
    return {
      id,
      name: g.name || '已移除的游戏',
      categories: g.categories || [],
      ms,
      count: gameCount.get(id) || 0,
      shareMs: totalMs ? ms / totalMs : 0
    };
  }).sort((a, b) => b.ms - a.ms);

  /* --- 趋势：补齐没有游玩的日期/月份，柱状图才不会歪 --- */
  const trendList = buildTrend(range, trend, trendBy);

  return {
    period: range.period,
    label: range.label,
    start: range.start,
    end: range.end,
    totals: {
      ms: totalMs,
      count: totalCount,
      gameCount: playedIds.size,
      avgMs: totalCount ? Math.round(totalMs / totalCount) : 0
    },
    byCategory,
    byGame,
    trend: trendList,
    peak: pickPeak(byCategory, byGame, trendList)
  };
}

/** 生成连续的时间桶（没游玩的日子补 0） */
function buildTrend(range, trendMap, trendBy) {
  const out = [];
  if (range.period === 'all') return out;
  const dayMs = 24 * 3600 * 1000;

  if (trendBy === 'month') {
    const from = new Date(range.start);
    const to = new Date(Math.min(range.end, Date.now()));
    const cur = new Date(from.getFullYear(), from.getMonth(), 1);
    let guard = 0;
    while (cur <= to && guard++ < 36) {
      const k = monthKey(cur.getTime());
      const hit = trendMap.get(k);
      out.push({ key: k, label: `${cur.getMonth() + 1}月`, ms: hit ? hit.ms : 0, count: hit ? hit.count : 0 });
      cur.setMonth(cur.getMonth() + 1);
    }
    return out;
  }

  const fromKey = range.start;
  const toKey = Math.min(range.end, Date.now());
  // 周视图只保留 7 根柱子，其余最多 31 根
  for (let t = fromKey; t <= toKey; t += dayMs) {
    const k = dayKey(t);
    const hit = trendMap.get(k);
    const dt = new Date(t);
    out.push({
      key: k,
      label: `${dt.getMonth() + 1}/${dt.getDate()}`,
      ms: hit ? hit.ms : 0,
      count: hit ? hit.count : 0
    });
    if (out.length >= 31) break;
  }
  return out;
}

/** 生成一句话亮点 */
function pickPeak(byCategory, byGame, trend) {
  const cat = byCategory[0] || null;
  const game = byGame[0] || null;
  const bestDay = (trend || []).slice().sort((a, b) => b.ms - a.ms)[0] || null;
  const bestDayHasData = bestDay && bestDay.ms > 0;
  return {
    topCategory: cat ? { name: cat.name, ms: cat.ms, count: cat.count } : null,
    topGame: game ? { id: game.id, name: game.name, ms: game.ms } : null,
    bestDay: bestDayHasData ? { key: bestDay.key, label: bestDay.label, ms: bestDay.ms } : null
  };
}

/**
 * 对外入口：按周期算出统计结果。
 * @param {Array} sessions
 * @param {Array} games 当前可见的游戏
 * @param {string} period
 * @param {Date|number} [ref] 参考时间（测试用，可注入固定时间）
 */
function computeStats(sessions, games, period, ref) {
  const range = rangeFor(period, ref);
  // 季度 / 年跨度大，按天画会有上百根柱子，改成按月
  const trendBy = (range.period === 'quarter' || range.period === 'year' || range.period === 'all') ? 'month' : 'day';
  const map = new Map((games || []).map((g) => [g.id, g]));
  const agg = aggregate(sessions, map, range, { trendBy });

  // "全部时间"没有可靠的会话流水（老数据只有累计时长）→ 用游戏自带的累计值兜底
  if (range.period === 'all') {
    const totalMs = (games || []).reduce((s, g) => s + (g.totalPlayMs || 0), 0);
    const totalCount = (games || []).reduce((s, g) => s + (g.playCount || 0), 0);
    const catMs = new Map();
    const catCnt = new Map();
    for (const g of games || []) {
      if (!(g.totalPlayMs > 0) && !(g.playCount > 0)) continue;
      for (const c of g.categories || []) {
        catMs.set(c, (catMs.get(c) || 0) + (g.totalPlayMs || 0));
        catCnt.set(c, (catCnt.get(c) || 0) + (g.playCount || 0));
      }
    }
    const byCategory = [...catMs.entries()].map(([name, ms]) => ({
      name,
      ms,
      count: catCnt.get(name) || 0,
      shareMs: totalMs ? ms / totalMs : 0,
      shareCount: totalCount ? (catCnt.get(name) || 0) / totalCount : 0
    })).sort((a, b) => b.ms - a.ms);
    agg.byCategory = byCategory;
    agg.totals = {
      ms: totalMs,
      count: totalCount,
      gameCount: (games || []).filter((g) => g.totalPlayMs > 0).length,
      avgMs: totalCount ? Math.round(totalMs / totalCount) : 0
    };
    agg.peak = pickPeak(byCategory, agg.byGame, []);
  }

  return agg;
}

module.exports = {
  PERIODS,
  PERIOD_LABEL,
  rangeFor,
  aggregate,
  computeStats,
  dayKey,
  monthKey
};
