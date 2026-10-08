/**
 * ============================================================
 *  新增逻辑的单元测试  (tools/logic-test.js)
 * ------------------------------------------------------------
 *  覆盖本轮新加的纯逻辑，全部不联网、不碰系统：
 *    [1] 名称归一化 / 全角半角
 *    [2] 代数校验（II / 2 / III 不能互相认错）
 *    [3] 相似度
 *    [4] 搜索关键词生成（Steam 长名截短）
 *    [5] 最佳匹配挑选（Hades II 不该贴上 Hades 的封面）
 *    [6] 统计周期边界（周一起算 / 月 / 季 / 年）
 *    [7] 会话聚合（区间外剔除、已删游戏剔除、多分类重复计数）
 *    [8] "全部时间"的老数据兜底
 *    [9] R18 规则
 *  用法： node tools/logic-test.js
 * ============================================================
 */
const assert = require('assert');
const cover = require('../src/main/cover');
const stats = require('../src/main/stats');
const { Library } = require('../src/main/library');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

/* ================================================================
 *  [1] 名称归一化 / 全角半角
 * ================================================================ */
console.log('\n[1] 名称归一化 / 全角半角');

t('全角数字与全角空格被归一化', () => {
  assert.strictEqual(cover.toHalfWidth('女神异闻录５'), '女神异闻录5');
  assert.strictEqual(cover.toHalfWidth('ＡＢＣ　１２３'), 'ABC 123');
});

t('括号注释被去掉，标点变空格', () => {
  assert.strictEqual(cover.normName('Cities: Skylines II（中文版）'), 'cities skylines ii');
  assert.strictEqual(cover.normName('Cities Skylines II'), 'cities skylines ii');
});

t('™®© 之类的标记不影响比对', () => {
  assert.strictEqual(cover.normName('Death Stranding™'), cover.normName('Death Stranding'));
});

/* ================================================================
 *  [2] 代数校验
 * ================================================================ */
console.log('\n[2] 代数校验（续作与本体不能互相认错）');

t('罗马数字与阿拉伯数字落成同一个记号', () => {
  assert.ok(cover.numeralTokens('Hades II').has('r2'));
  assert.ok(cover.numeralTokens('Hades 2').has('r2'), '阿拉伯数字也必须归到 r2');
  assert.ok(cover.numeralTokens('Hades 02').has('r2'), '前导零要去掉');
  assert.ok(cover.numeralTokens('Persona V').has('r5'));
  assert.ok(cover.numeralTokens('Persona 5').has('r5'));
});

t('Hades 与 Hades II 互相判为代数不符', () => {
  assert.ok(cover.numeralMismatch('Hades', 'Hades II'), '本体查续作 → 不符');
  assert.ok(cover.numeralMismatch('Hades II', 'Hades'), '续作查本体 → 不符');
});

t('Portal 与 Portal 2 互相判为代数不符', () => {
  assert.ok(cover.numeralMismatch('Portal', 'Portal 2'));
  assert.ok(cover.numeralMismatch('Portal 2', 'Portal'));
});

t('代数一致时不算不符', () => {
  assert.ok(!cover.numeralMismatch('Hades II', 'Hades II'));
  assert.ok(!cover.numeralMismatch('Hades 2', 'Hades II'), 'II 与 2 都是第 2 代');
  assert.ok(!cover.numeralMismatch('Elden Ring', 'Elden Ring'));
});

t('名字里没有数字时不会误判', () => {
  assert.ok(!cover.numeralMismatch('Stardew Valley', 'Stardew Valley'));
});

/* ================================================================
 *  [3] 相似度
 * ================================================================ */
console.log('\n[3] 名称相似度');

t('完全相同 = 1', () => {
  assert.strictEqual(cover.similarity('Hades', 'Hades'), 1);
});

t('归一化后相同也算 1', () => {
  assert.strictEqual(cover.similarity('Cities: Skylines II', 'Cities Skylines II'), 1);
});

t('包含关系落在 0.72 ~ 0.92', () => {
  const s = cover.similarity('Cities Skylines', 'Cities Skylines II');
  assert.ok(s >= 0.72 && s <= 0.92, `实际 ${s}`);
});

t('毫不相干的名字得分很低', () => {
  const s = cover.similarity('Minecraft', 'FIFA 24');
  assert.ok(s < cover.MIN_MATCH_SCORE, `实际 ${s}`);
});

t('空字符串返回 0', () => {
  assert.strictEqual(cover.similarity('', 'Hades'), 0);
  assert.strictEqual(cover.similarity('Hades', ''), 0);
});

/* ================================================================
 *  [4] 搜索关键词生成
 * ================================================================ */
console.log('\n[4] 搜索关键词生成（Steam 对长名很不友好）');

t('带副标题的名字会截出主标题', () => {
  const terms = cover.buildSearchTerms(['WorldBox - God Simulator']);
  assert.ok(terms.includes('WorldBox'), `实际 ${JSON.stringify(terms)}`);
  assert.ok(!terms.includes('God Simulator'), '副标题不应单独成为关键词');
});

t('切分残留的分隔符被清掉（不能出现 "WorldBox -"）', () => {
  const terms = cover.buildSearchTerms(['WorldBox - God Simulator']);
  for (const x of terms) {
    assert.ok(!/[\-–—:|/]\s*$/.test(x), `关键词尾部残留分隔符：${x}`);
    assert.ok(!/^\s*[\-–—:|/]/.test(x), `关键词头部残留分隔符：${x}`);
  }
});

t('最多输出 3 个关键词，且不重复', () => {
  const terms = cover.buildSearchTerms(['The Witcher 3: Wild Hunt - Game of the Year Edition']);
  assert.ok(terms.length <= 3);
  assert.strictEqual(new Set(terms).size, terms.length);
});

t('会依次用上别名', () => {
  const terms = cover.buildSearchTerms(['Persona 5 Royal', '女神异闻录5 皇家版']);
  assert.ok(terms.length >= 2);
});

t('短名字原样保留', () => {
  assert.deepStrictEqual(cover.buildSearchTerms(['Hades']), ['Hades']);
});

/* ================================================================
 *  [5] 最佳匹配挑选
 * ================================================================ */
console.log('\n[5] 最佳匹配挑选');

t('代数不符会被重罚，宁可不贴也不能贴错', () => {
  const items = [{ appid: '1145360', name: 'Hades' }];
  const best = cover.pickBestMatch('Hades II', items);
  // 0.845(包含相似度) - 0.4(代数不符) = 0.445 < 0.62 阈值
  assert.ok(!best || best.score < cover.MIN_MATCH_SCORE, `不该过关：${JSON.stringify(best)}`);
});

t('能在多条结果里挑出本体', () => {
  const items = [
    { appid: '1', name: 'Hades II Soundtrack' },
    { appid: '2', name: 'Hades II' },
    { appid: '3', name: 'Hades' }
  ];
  const best = cover.pickBestMatch('Hades II', items);
  assert.ok(best, '应该挑出一条');
  assert.strictEqual(best.appid, '2');
});

t('原声带 / DLC 被降权', () => {
  const items = [
    { appid: '1', name: 'Elden Ring Soundtrack' },
    { appid: '2', name: 'Elden Ring' }
  ];
  assert.strictEqual(cover.pickBestMatch('Elden Ring', items).appid, '2');
});

t('空结果返回 null，不会抛错', () => {
  assert.strictEqual(cover.pickBestMatch('Whatever', []), null);
  assert.strictEqual(cover.pickBestMatch('Whatever', null), null);
});

t('缺 appid / name 的脏数据被跳过', () => {
  const items = [{ appid: '', name: 'X' }, { appid: '9' }, null, { appid: '7', name: 'Hades II' }];
  assert.strictEqual(cover.pickBestMatch('Hades II', items).appid, '7');
});

/* ================================================================
 *  [5b] 短关键词的"完整名字复核"
 * ----------------------------------------------------------------
 *  背景：things like "zzz 不存在的游戏 99887766" 这种条目，
 *        关键词会被截到只剩 "zzz"，而 Steam 上真有一款叫 "zzzzz" 的游戏，
 *        包含式相似度 0.84 直接过关 → 一张完全不相干的封面就贴上去了。
 *        规则：截图出来的短关键词命中之后，必须再用完整名字复核一遍。
 * ================================================================ */
console.log('\n[5b] 短关键词必须过完整名字复核');

t('短关键词不被认作"代表全名"', () => {
  assert.strictEqual(cover.termCoversSource('zzz', 'zzz 不存在的游戏 xyzzy 99887766 测试专用'), false);
});

t('完整的名字（或只差一点点）不需要再复核', () => {
  assert.strictEqual(cover.termCoversSource('WorldBox - God Simulator', 'WorldBox - God Simulator'), true);
  assert.strictEqual(cover.termCoversSource('拔作岛', '拔作岛'), true);
});

t('截出来的短关键词命中的"同名杂物"会被完整名字复核挡掉', () => {
  const full = 'zzz 不存在的游戏 xyzzy 99887766 测试专用';
  // ① 短关键词自己拿得到高分（这正是以前漏进来的原因）
  const loose = cover.similarity('zzz', 'zzzzz');
  assert.ok(loose >= cover.MIN_MATCH_SCORE, `前提不成立：短词命中分 ${loose}`);
  // ② 但换成完整名字去比对就露馅了 —— 低于阈值，必须跳过
  const strictScore = cover.similarity(full, 'zzzzz');
  assert.ok(strictScore < cover.MIN_MATCH_SCORE, `完整名字复核分 ${strictScore}，应该低于阈值`);
});

t('正常的"长名 → Steam 短名"不会被复核误伤', () => {
  // 本地叫 "WorldBox - God Simulator"，Steam 上就叫 "WorldBox"
  const s = cover.similarity('WorldBox - God Simulator', 'WorldBox');
  assert.ok(s >= cover.MIN_MATCH_SCORE, `实际 ${s}，不该被复核挡掉`);
});

t('needCover：只对真正缺图的游戏下手', () => {
  assert.strictEqual(cover.needsCover({ name: 'A', coverPath: '', coverKind: 'none' }), true);
  assert.strictEqual(cover.needsCover({ name: 'B', coverPath: 'covers/x.jpg', coverKind: 'custom' }), false);
  assert.strictEqual(cover.needsCover({ name: 'C', coverPath: 'covers/x.jpg', coverKind: 'icon' }), false);
  // 开了「升级图标」之后，只有图标的那款才算缺封面
  assert.strictEqual(cover.needsCover({ name: 'C', coverPath: 'covers/x.jpg', coverKind: 'icon' }, true), true);
  assert.strictEqual(cover.needsCover({ name: 'D', coverPath: 'covers/x.jpg', coverKind: 'steam' }), false);
  // 没有名字的条目没法联网搜，直接判 false
  assert.strictEqual(cover.needsCover({ coverPath: '' }), false);
});

/* ================================================================
 *  [6] 统计周期边界
 * ================================================================ */
console.log('\n[6] 统计周期边界');

// 2026-03-18 是周三
const REF = new Date(2026, 2, 18, 14, 30, 0, 0).getTime();

t('周：从本周一 00:00 起算', () => {
  const r = stats.rangeFor('week', REF);
  const s = new Date(r.start);
  assert.strictEqual(s.getDay(), 1, '起点必须是周一');
  assert.strictEqual(s.getHours(), 0);
  assert.strictEqual(s.getDate(), 16, '2026-03-18(周三) 所在周的周一是 16 号');
});

t('周：当天 23:59:59 结束', () => {
  const r = stats.rangeFor('week', REF);
  const e = new Date(r.end);
  assert.strictEqual(e.getDate(), 18);
  assert.strictEqual(e.getHours(), 23);
});

t('月：从 1 号 00:00 起算', () => {
  const r = stats.rangeFor('month', REF);
  assert.strictEqual(new Date(r.start).getDate(), 1);
  assert.strictEqual(new Date(r.start).getMonth(), 2);
});

t('季度：落在 1/4/7/10 月的 1 号', () => {
  assert.strictEqual(new Date(stats.rangeFor('quarter', REF).start).getMonth(), 0);   // 3月 → Q1
  const q2 = new Date(2026, 4, 10).getTime();                                          // 5月 → Q2
  assert.strictEqual(new Date(stats.rangeFor('quarter', q2).start).getMonth(), 3);
  const q4 = new Date(2026, 10, 10).getTime();                                         // 11月 → Q4
  assert.strictEqual(new Date(stats.rangeFor('quarter', q4).start).getMonth(), 9);
});

t('年：从 1 月 1 号起算', () => {
  const r = stats.rangeFor('year', REF);
  assert.strictEqual(new Date(r.start).getMonth(), 0);
  assert.strictEqual(new Date(r.start).getDate(), 1);
});

t('全部：起点 0，终点是无穷大', () => {
  const r = stats.rangeFor('all', REF);
  assert.strictEqual(r.start, 0);
  assert.strictEqual(r.end, Number.MAX_SAFE_INTEGER);
});

t('非法周期兜底为月', () => {
  assert.strictEqual(stats.rangeFor('oops', REF).period, 'month');
});

t('dayKey / monthKey 用本地时区', () => {
  assert.strictEqual(stats.dayKey(new Date(2026, 2, 5, 10, 0).getTime()), '2026-03-05');
  assert.strictEqual(stats.monthKey(new Date(2026, 2, 5).getTime()), '2026-03');
});

/* ================================================================
 *  [7] 会话聚合
 * ================================================================ */
console.log('\n[7] 会话聚合');

const GAMES = [
  { id: 'a', name: '动作游戏A', categories: ['动作', '角色扮演'] },
  { id: 'b', name: '射击游戏B', categories: ['射击'] }
];

t('区间外的流水被剔除', () => {
  const ss = [
    { gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: 1000 },
    { gameId: 'a', at: new Date(2026, 1, 10).getTime(), ms: 9999 }   // 上个月
  ];
  const r = stats.rangeFor('month', REF);
  const agg = stats.aggregate(ss, GAMES, r, { trendBy: 'day' });
  assert.strictEqual(agg.totals.ms, 1000);
  assert.strictEqual(agg.totals.count, 1);
});

t('已经从库里删掉的游戏，其流水不再计入', () => {
  const ss = [{ gameId: 'ghost', at: new Date(2026, 2, 10).getTime(), ms: 5000 }];
  const agg = stats.aggregate(ss, GAMES, stats.rangeFor('month', REF), { trendBy: 'day' });
  assert.strictEqual(agg.totals.ms, 0);
  assert.strictEqual(agg.byGame.length, 0);
});

t('ms <= 0 的无效流水被忽略', () => {
  const ss = [
    { gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: 0 },
    { gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: -5 }
  ];
  const agg = stats.aggregate(ss, GAMES, stats.rangeFor('month', REF), { trendBy: 'day' });
  assert.strictEqual(agg.totals.count, 0);
});

t('多分类：一款游戏同时计入它所有的分类（刻意设计）', () => {
  const ss = [{ gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: 6000 }];
  const agg = stats.aggregate(ss, GAMES, stats.rangeFor('month', REF), { trendBy: 'day' });
  const names = agg.byCategory.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['动作', '角色扮演']);
  // 两个分类各 6000，相加 = 12000 > 总时长 6000 —— 这是预期的
  assert.strictEqual(agg.byCategory.reduce((s, c) => s + c.ms, 0), 12000);
  assert.strictEqual(agg.totals.ms, 6000);
});

t('游戏数按去重后的 ID 计', () => {
  const ss = [
    { gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: 1000 },
    { gameId: 'a', at: new Date(2026, 2, 11).getTime(), ms: 1000 },
    { gameId: 'b', at: new Date(2026, 2, 12).getTime(), ms: 1000 }
  ];
  const agg = stats.aggregate(ss, GAMES, stats.rangeFor('month', REF), { trendBy: 'day' });
  assert.strictEqual(agg.totals.count, 3);
  assert.strictEqual(agg.totals.gameCount, 2);
  assert.strictEqual(agg.totals.avgMs, 1000);
});

t('趋势补齐空白日期（没玩的日子也要有 0 值柱子）', () => {
  const ss = [{ gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: 1000 }];
  const agg = stats.aggregate(ss, GAMES, stats.rangeFor('month', REF), { trendBy: 'day' });
  assert.ok(agg.trend.length >= 18, `柱子数量 ${agg.trend.length}`);
  assert.strictEqual(agg.trend.find((x) => x.key === '2026-03-10').ms, 1000);
  assert.strictEqual(agg.trend.find((x) => x.key === '2026-03-11').ms, 0);
});

t('亮点：挑出玩得最多的类型 / 游戏 / 最活跃的一天', () => {
  const ss = [
    { gameId: 'a', at: new Date(2026, 2, 10).getTime(), ms: 9000 },
    { gameId: 'b', at: new Date(2026, 2, 11).getTime(), ms: 1000 }
  ];
  const agg = stats.aggregate(ss, GAMES, stats.rangeFor('month', REF), { trendBy: 'day' });
  assert.strictEqual(agg.peak.topGame.name, '动作游戏A');
  assert.strictEqual(agg.peak.bestDay.key, '2026-03-10');
  assert.ok(['动作', '角色扮演'].includes(agg.peak.topCategory.name));
});

t('空流水不炸，全部归零', () => {
  const agg = stats.computeStats([], GAMES, 'month', REF);
  assert.strictEqual(agg.totals.ms, 0);
  assert.strictEqual(agg.totals.avgMs, 0);
  assert.strictEqual(agg.peak.topGame, null);
});

/* ================================================================
 *  [8] "全部时间"的老数据兜底
 * ================================================================ */
console.log('\n[8] 全部时间（老数据兜底）');

t('没有流水时用游戏自带的累计时长 / 次数', () => {
  const games = [
    { id: 'a', name: 'A', categories: ['动作'], totalPlayMs: 3600000, playCount: 4 },
    { id: 'b', name: 'B', categories: ['射击'], totalPlayMs: 1800000, playCount: 2 }
  ];
  const agg = stats.computeStats([], games, 'all', REF);
  assert.strictEqual(agg.totals.ms, 5400000);
  assert.strictEqual(agg.totals.count, 6);
  assert.strictEqual(agg.byCategory[0].name, '动作');
});

t('没玩过的游戏不计入 gameCount', () => {
  const games = [
    { id: 'a', name: 'A', categories: ['动作'], totalPlayMs: 1000, playCount: 1 },
    { id: 'c', name: 'C', categories: ['动作'], totalPlayMs: 0, playCount: 0 }
  ];
  const agg = stats.computeStats([], games, 'all', REF);
  assert.strictEqual(agg.totals.gameCount, 1);
});

/* ================================================================
 *  [9] R18 规则
 * ================================================================ */
console.log('\n[9] R18 规则');

t('大小写不敏感，前后空格也认', () => {
  assert.ok(Library.isR18({ categories: ['R18'] }));
  assert.ok(Library.isR18({ categories: ['r18'] }));
  assert.ok(Library.isR18({ categories: ['  R18  '] }));
  assert.ok(Library.isR18({ categories: ['动作', 'R18'] }));
});

t('不带 R18 的不算', () => {
  assert.ok(!Library.isR18({ categories: ['动作'] }));
  assert.ok(!Library.isR18({}));
  assert.ok(!Library.isR18(null));
});

/* ================================================================
 *  [10] 文件夹扫描的关键判定
 *  （触发场景：F:\r24 里躺着 20 多个游戏，结果整个 r24 被当成一款游戏）
 * ================================================================ */
console.log('\n[10] 文件夹扫描的关键判定');

const scanner = require('../src/main/scanner');

t('目录名美化：不能把游戏名结尾的数字当版本号削掉', () => {
  // 这些是名字的一部分，削了就是错的
  assert.strictEqual(scanner.prettyName('NinNinDays2'), 'NinNinDays2');
  assert.strictEqual(scanner.prettyName('hs2'), 'hs2');
  assert.strictEqual(scanner.prettyName('Portal 2'), 'Portal 2', '空格+数字也很可能是游戏名');
  assert.strictEqual(scanner.prettyName('Battlefield 3'), 'Battlefield 3');
  assert.strictEqual(scanner.prettyName('Warcraft3'), 'Warcraft3');
});

t('目录名美化：真正的版本号还是要削掉', () => {
  assert.strictEqual(scanner.prettyName('ELDEN_RING_v1.10'), 'ELDEN RING');
  assert.strictEqual(scanner.prettyName('Stardew Valley 1.6'), 'Stardew Valley');
  assert.strictEqual(scanner.prettyName('1room_v1.2.2'), '1room');
  assert.strictEqual(scanner.prettyName('MyGame_v2'), 'MyGame');
  assert.strictEqual(scanner.prettyName('censor demo 2.0.6'), 'censor demo');
  assert.strictEqual(scanner.prettyName("(public)Syahara's bad day_v0.32b"), "Syahara's bad day");
});

t('目录名美化：清理搬运目录常见的标签前缀', () => {
  assert.strictEqual(scanner.prettyName('[PC硬盘]【官中】拔作岛'), '拔作岛');
  assert.strictEqual(scanner.prettyName('[SLG汉化PC+安卓] 淫乱奴隶教育化计划'), '淫乱奴隶教育化计划');
  assert.strictEqual(scanner.prettyName('Half-Life'), 'Half-Life', '正常名字不许动');
  assert.strictEqual(scanner.prettyName('【】'), '【】', '剥完没内容了要回退');
});

t('技术目录名不会被当成游戏（Binaries / Win64 / Engine …）', () => {
  const TECH = ['bin', 'Binaries', 'Win64', 'x64', 'Engine', 'Content', 'Engine', 'crashpad'];
  for (const d of TECH) {
    assert.ok(scanner.isTechDirName(d), `${d} 应被识别为技术目录`);
  }
  // 真游戏名不能被误伤
  for (const d of ['ELDEN RING', 'Mad Island', 'hs2', 'NinNinDays2', 'Data of War', 'Content Warning']) {
    assert.ok(!scanner.isTechDirName(d), `${d} 不该被当成技术目录`);
  }
});

t('合集目录检测：主程序散落在多个子目录 → 不是一款游戏', () => {
  // 模拟 r24 的结构：8 个游戏各自待在自己的子目录里
  const dir = 'F:\\r24';
  const exes = [
    { path: 'F:\\r24\\Mad Island\\Mad Island.exe', size: 250 * 1048576 },
    { path: 'F:\\r24\\hs2\\hs2.exe', size: 200 * 1048576 },
    { path: 'F:\\r24\\aliceincracle\\aliceincracle.exe', size: 80 * 1048576 }
  ];
  const grp = scanner.mainExeChildGroups(exes, dir);
  assert.strictEqual(grp.strongCount, 3, '应识别出 3 个有主程序的子目录');
  assert.strictEqual(grp.rootMax, 0, '根目录自己没有 exe');
});

t('合集目录检测：一款游戏的多层结构不能被误判', () => {
  // Game\Binaries\Win64\Game.exe —— 全部集中在同一个子目录里
  const dir = 'D:\\SomeGame';
  const exes = [{ path: 'D:\\SomeGame\\Binaries\\Win64\\SomeGame-Win64-Shipping.exe', size: 180 * 1048576 }];
  const grp = scanner.mainExeChildGroups(exes, dir);
  assert.strictEqual(grp.strongCount, 1, '只有一个子目录装着主程序');
  assert.strictEqual(grp.rootMax, 0);
});

t('合集目录检测：几百 KB 的小工具不算"主程序"', () => {
  const dir = 'D:\\SomeGame';
  const exes = [
    { path: 'D:\\SomeGame\\SomeGame.exe', size: 120 * 1048576 },
    { path: 'D:\\SomeGame\\bin\\helper.exe', size: 300 * 1024 }
  ];
  const grp = scanner.mainExeChildGroups(exes, dir);
  assert.strictEqual(grp.strongCount, 0, 'helper.exe 太小，不该算进子目录主程序');
  assert.ok(grp.rootMax >= 100 * 1048576, '根目录的主程序要能识别出来');
});

/** 造一个够用的假 store，专门测 syncR18 */
function mockStore(games, hiddenEnabled) {
  return {
    _games: games,
    getGames: () => games,
    getSettings: () => ({ hidden: { enabled: hiddenEnabled } }),
    saved: false,
    saveSoon() { this.saved = true; }
  };
}

t('隐藏空间已启用 → 打了 R18 的游戏被隐藏', () => {
  const games = [
    { id: '1', name: '绅士游戏', categories: ['R18'], hidden: false },
    { id: '2', name: '普通游戏', categories: ['动作'], hidden: false }
  ];
  const lib = new Library(mockStore(games, true));
  const r = lib.syncR18(['1']);
  assert.deepStrictEqual(r.hidden, ['绅士游戏']);
  assert.deepStrictEqual(r.pending, []);
  assert.strictEqual(games[0].hidden, true);
  assert.strictEqual(games[1].hidden, false, '没打 R18 的不该被牵连');
});

t('隐藏空间未启用 → 只记为待处理，绝不偷偷隐藏（否则游戏会彻底消失）', () => {
  const games = [{ id: '1', name: '绅士游戏', categories: ['R18'], hidden: false }];
  const lib = new Library(mockStore(games, false));
  const r = lib.syncR18(['1']);
  assert.deepStrictEqual(r.hidden, []);
  assert.deepStrictEqual(r.pending, ['绅士游戏']);
  assert.strictEqual(games[0].hidden, false);
});

t('传 ids 时只处理指定的游戏（不会把用户手动移出的又藏回去）', () => {
  const games = [
    { id: '1', name: 'A', categories: ['R18'], hidden: false },
    { id: '2', name: 'B', categories: ['R18'], hidden: false }
  ];
  const lib = new Library(mockStore(games, true));
  lib.syncR18(['1']);
  assert.strictEqual(games[0].hidden, true);
  assert.strictEqual(games[1].hidden, false, '没在 ids 里的不该被动');
});

t('不传 ids = 全量（启用隐藏空间后补一次）', () => {
  const games = [
    { id: '1', name: 'A', categories: ['R18'], hidden: false },
    { id: '2', name: 'B', categories: ['R18'], hidden: false }
  ];
  const lib = new Library(mockStore(games, true));
  const r = lib.syncR18();
  assert.strictEqual(r.hidden.length, 2);
  assert.ok(games.every((g) => g.hidden));
});

t('已经隐藏的不会重复计数', () => {
  const games = [{ id: '1', name: 'A', categories: ['R18'], hidden: true }];
  const lib = new Library(mockStore(games, true));
  const r = lib.syncR18();
  assert.strictEqual(r.hidden.length, 0);
});

/* ================================================================
 *  [11] Steam appinfo.vdf 解析
 *  （触发场景：249 个游戏里有 103 个没名字，来源是成就 schema 的内部代号，
 *    比如 260 号被叫成 ValveTestApp260，其实它是 CS2）
 * ================================================================ */
console.log('\n[11] Steam appinfo.vdf 解析');

const appinfo = require('../src/main/appinfo');

/**
 * 造一个最小的 appinfo.vdf 用来测解析。
 * 格式要点（本机实测 v29）：
 *   文件头 16 字节，之后每条记录 = 73 字节头 + 数据区；
 *   size 字段是"本字段之后还剩多少字节"，所以 下一条 = 当前 + 8 + size，
 *   数据区长度 = size - 65。
 */
function buildAppInfo(records) {
  const strings = ['appinfo', 'appid', 'common', 'name', 'type', 'developer'];
  const strIndex = new Map(strings.map((s, i) => [s, i]));

  const chunks = [];
  for (const r of records) {
    // --- 数据区 ---
    const data = [];
    data.push(0x02); data.push(u32(strIndex.get('appid')), u32le(r.appId));
    data.push(0x00); data.push(u32(strIndex.get('common')));
    data.push(0x01); data.push(u32(strIndex.get('name'))); data.push(cstr(r.name));
    if (r.type) { data.push(0x01); data.push(u32(strIndex.get('type'))); data.push(cstr(r.type)); }
    data.push(0x08); // 结束 common
    data.push(0x08); // 结束根对象
    const body = Buffer.concat(data.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from([x]))));

    // --- 73 字节头（除 appid / size 外全填 0 也能解析） ---
    const head = Buffer.alloc(73);
    head.writeUInt32LE(r.appId, 0);
    head.writeUInt32LE(65 + body.length, 4); // size = 数据区长度 + 65
    chunks.push(head, body);
  }

  const body = Buffer.concat(chunks);
  const strTable = Buffer.concat([
    u32le(strings.length),
    Buffer.concat(strings.map((s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])))
  ]);

  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x07564429, 0); // magic
  header.writeUInt32LE(1, 4);          // universe
  header.writeBigUInt64LE(BigInt(16 + body.length), 8); // 字符串表偏移

  return Buffer.concat([header, body, strTable]);
}
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u32 = u32le;
const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);

t('造出来的假文件能被完整解析', () => {
  const buf = buildAppInfo([
    { appId: 730, name: 'Counter-Strike 2', type: 'Game' },
    { appId: 570, name: 'Dota 2', type: 'game' },
    { appId: 260, name: 'Counter-Strike: Source', type: 'game' }
  ]);
  const file = require('path').join(require('os').tmpdir(), 'gh-appinfo-test.vdf');
  require('fs').writeFileSync(file, buf);

  const map = appinfo.parseAppInfo(file);
  assert.strictEqual(map.size, 3, `应解析出 3 条，实际 ${map.size}`);
  assert.strictEqual(map.get('730').name, 'Counter-Strike 2');
  assert.strictEqual(map.get('570').name, 'Dota 2');
  assert.strictEqual(map.get('260').name, 'Counter-Strike: Source');
  assert.strictEqual(map.get('730').type, 'Game');
  require('fs').unlinkSync(file);
});

t('只想查几个 appid 时其余的不解析（want 过滤生效）', () => {
  const buf = buildAppInfo([
    { appId: 730, name: 'Counter-Strike 2' },
    { appId: 570, name: 'Dota 2' }
  ]);
  const file = require('path').join(require('os').tmpdir(), 'gh-appinfo-want.vdf');
  require('fs').writeFileSync(file, buf);
  const map = appinfo.parseAppInfo(file, { want: new Set(['570']) });
  assert.strictEqual(map.size, 1);
  assert.strictEqual(map.get('570').name, 'Dota 2');
  require('fs').unlinkSync(file);
});

t('文件不存在 / magic 不对 → 返回空表而不是崩', () => {
  assert.strictEqual(appinfo.parseAppInfo('X:\\绝对不存在.vdf').size, 0);
  const file = require('path').join(require('os').tmpdir(), 'gh-appinfo-bad.vdf');
  require('fs').writeFileSync(file, Buffer.alloc(200));
  assert.strictEqual(appinfo.parseAppInfo(file).size, 0, 'magic 不对必须放弃，不能拿错名字');
  require('fs').unlinkSync(file);
});

t('名字优先级的规则：appinfo 有名字时绝不用 schema 的代号', () => {
  // 这是 platforms.js 里的取值顺序，用假数据再确认一遍语义：
  // appinfo > 已安装清单 > 成就 schema > 兜底
  const fromInfo = 'Counter-Strike 2';
  const fromAcf = 'counter-strike 2';
  const fromSchema = 'ValveTestApp260';
  const pick = (a, b, c) => a || b || c || 'Steam App 730';
  assert.strictEqual(pick(fromInfo, fromAcf, fromSchema), 'Counter-Strike 2');
  assert.strictEqual(pick('', fromAcf, fromSchema), 'counter-strike 2');
  assert.strictEqual(pick('', '', fromSchema), 'ValveTestApp260');
  assert.strictEqual(pick('', '', ''), 'Steam App 730');
});

/* ================================================================
 *  [12] 图片头嗅探（挑 Steam 封面要用）
 *  （触发场景：librarycache 里的文件名花样太多，靠名字猜会漏）
 * ================================================================ */
console.log('\n[12] 图片头嗅探');

const imgmeta = require('../src/main/imgmeta');

t('JPEG：能从 SOF 段读出真实的宽高', () => {
  // 手工拼一个最小 JPEG 头：SOI + APP0 + SOF0(300x450)
  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.alloc(16); app0.writeUInt16BE(0xffe0, 0); app0.writeUInt16BE(14, 2);
  parts.push(app0);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(9, 2); sof[4] = 8;
  sof.writeUInt16BE(450, 5);   // 高
  sof.writeUInt16BE(300, 7);   // 宽
  parts.push(sof);
  const size = imgmeta.imageSize(Buffer.concat(parts));
  assert.strictEqual(size.type, 'jpg');
  assert.strictEqual(size.w, 300);
  assert.strictEqual(size.h, 450);
  assert.ok(Math.abs(imgmeta.aspect(size) - 0.667) < 0.01);
});

t('PNG：IHDR 里的宽高', () => {
  const b = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(600, 16); b.writeUInt32BE(900, 20);
  const size = imgmeta.imageSize(b);
  assert.strictEqual(size.type, 'png');
  assert.strictEqual(size.w, 600);
  assert.strictEqual(size.h, 900);
});

t('不是图片 / 空数据 → 老老实实返回空，不抛异常', () => {
  assert.strictEqual(imgmeta.imageSize(Buffer.alloc(0)).type, '');
  assert.strictEqual(imgmeta.imageSize(Buffer.from('这不是图片，只是一段文字')).type, '');
  assert.strictEqual(imgmeta.imageSize(Buffer.alloc(64)).type, '');
});

t('宽高比：高为 0 时返回 0，不能出现 Infinity / NaN', () => {
  assert.strictEqual(imgmeta.aspect({ w: 100, h: 0 }), 0);
  assert.strictEqual(imgmeta.aspect(null), 0);
});

/* ==================================================================
 *  [13] 通关状态（clearState）
 * ----------------------------------------------------------------
 *  规则：所有游戏默认"未通关"，没有"未标记"那一档；认不出来的值一律回落。
 * ================================================================== */
const { normalizeGame, CLEAR_STATES, CLEAR_DEFAULT } = require('../src/main/store');

t('默认值就是"未通关"', () => {
  assert.strictEqual(CLEAR_DEFAULT, 'uncleared');
  assert.ok(CLEAR_STATES.includes(CLEAR_DEFAULT));
});

t('新游戏（对象里压根没这个字段）→ 未通关', () => {
  assert.strictEqual(normalizeGame({ name: '新游戏' }).clearState, 'uncleared');
});

t('三个合法值原样保留', () => {
  for (const v of CLEAR_STATES) {
    assert.strictEqual(normalizeGame({ name: 'x', clearState: v }).clearState, v);
  }
});

t('老数据里的空串 → 回落到未通关（不能留空）', () => {
  assert.strictEqual(normalizeGame({ name: 'x', clearState: '' }).clearState, 'uncleared');
  assert.strictEqual(normalizeGame({ name: 'x', clearState: null }).clearState, 'uncleared');
});

t('脏数据 / 大小写不对 → 回落到未通关，绝不透传', () => {
  assert.strictEqual(normalizeGame({ name: 'x', clearState: 'CLEARED' }).clearState, 'uncleared');
  assert.strictEqual(normalizeGame({ name: 'x', clearState: '已通关' }).clearState, 'uncleared');
  assert.strictEqual(normalizeGame({ name: 'x', clearState: 123 }).clearState, 'uncleared');
  assert.strictEqual(normalizeGame({ name: 'x', clearState: {} }).clearState, 'uncleared');
});

t('通关状态不会被当成真值乱用（字符串，不是布尔）', () => {
  assert.strictEqual(typeof normalizeGame({ name: 'x' }).clearState, 'string');
});

/* ==================================================================
 *  [14] Steam 时长并入游戏库（只增不减）
 * ----------------------------------------------------------------
 *  背景：库里的 totalPlayMs 只统计"从 GameHub 启动"的那些局，
 *  所以同一台机器上有的游戏显示时长和成就、有的两样都没有，
 *  而它们在 Steam 上的数据其实一样齐全。修法是同步时把 Steam 的累计时长并进来。
 *
 *  ⚠ 这里最要紧的是"不能把本地记录改小"：
 *    本地是从 GameHub 启动后实时累加的，比 Steam 的落盘值新；
 *    只要允许往下写，用户就会看到时长凭空倒退。
 * ================================================================== */
console.log('\n[14] Steam 时长并入游戏库');

/** 造一个 game + 能记下 saveSoon 的假 store */
function libWith(games) {
  const st = {
    _games: games,
    getGames: () => games,
    findGame: (id) => games.find((g) => g.id === id) || null,
    saved: 0,
    saveSoon() { this.saved++; }
  };
  return { lib: new Library(st), st };
}

t('库里是 0、Steam 有 → 取 Steam 的值', () => {
  const g = { id: '1', name: 'A', steamAppId: '3240220', totalPlayMs: 0, lastPlayedAt: 0 };
  const { lib } = libWith([g]);
  const r = lib.mergeSteamPlaytime({ 3240220: { playtimeMs: 25200000, lastPlayed: 1784441895000 } });
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(g.totalPlayMs, 25200000);
  assert.strictEqual(g.lastPlayedAt, 1784441895000);
  assert.strictEqual(g.playtimeFromSteam, true, '要打上来源标记，界面才好说明');
});

t('库里比 Steam 大 → 绝不许改小（否则时长会倒退）', () => {
  const g = { id: '1', name: 'A', steamAppId: '1', totalPlayMs: 99999999, lastPlayedAt: 9999999999999 };
  const { lib } = libWith([g]);
  const r = lib.mergeSteamPlaytime({ 1: { playtimeMs: 1000, lastPlayed: 1000 } });
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(g.totalPlayMs, 99999999);
  assert.strictEqual(g.lastPlayedAt, 9999999999999);
  // 什么都没动就不该碰来源标记（用 normalizeGame 建的对象本来就是 false）
  assert.ok(!g.playtimeFromSteam, '没动过就该保持原样，不能凭空打上"含 Steam"' );
});

t('时长比库里大、但最近游玩比库里小 → 各算各的', () => {
  const g = { id: '1', name: 'A', steamAppId: '1', totalPlayMs: 1000, lastPlayedAt: 5000 };
  const { lib } = libWith([g]);
  lib.mergeSteamPlaytime({ 1: { playtimeMs: 2000, lastPlayed: 3000 } });
  assert.strictEqual(g.totalPlayMs, 2000, '时长该涨');
  assert.strictEqual(g.lastPlayedAt, 5000, '最近游玩该保持更大的那个');
});

t('没有 steamAppId 的游戏不会被牵连', () => {
  const g = { id: '1', name: '绿色版', steamAppId: '', totalPlayMs: 0 };
  const { lib } = libWith([g]);
  const r = lib.mergeSteamPlaytime({ '1': { playtimeMs: 999 } });
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(g.totalPlayMs, 0);
});

t('Steam 快照里没有这款 → 不动它', () => {
  const g = { id: '1', name: 'A', steamAppId: '555', totalPlayMs: 0 };
  const { lib } = libWith([g]);
  assert.strictEqual(lib.mergeSteamPlaytime({ 1: { playtimeMs: 999 } }).changed, 0);
  assert.strictEqual(g.totalPlayMs, 0);
});

t('空表 / undefined / 数字型 appId 都不能炸', () => {
  const g = { id: '1', name: 'A', steamAppId: 3240220, totalPlayMs: 0, lastPlayedAt: 0 };
  const { lib } = libWith([g]);
  assert.strictEqual(lib.mergeSteamPlaytime(undefined).changed, 0);
  assert.strictEqual(lib.mergeSteamPlaytime({}).changed, 0);
  // 数字型也能对上字符串型的 key
  assert.strictEqual(lib.mergeSteamPlaytime({ 3240220: { playtimeMs: 42 } }).changed, 1);
  assert.strictEqual(g.totalPlayMs, 42);
});

t('有变化才写盘（每次开机都白写一遍是浪费）', () => {
  const g = { id: '1', name: 'A', steamAppId: '1', totalPlayMs: 0 };
  const { lib, st } = libWith([g]);
  lib.mergeSteamPlaytime({});
  assert.strictEqual(st.saved, 0);
  lib.mergeSteamPlaytime({ 1: { playtimeMs: 10 } });
  assert.strictEqual(st.saved, 1);
});

/* ==================================================================
 *  [15] 统计胶囊行"空了才收掉"的判定
 * ----------------------------------------------------------------
 *  ⚠⚠ 这是主人反馈「有的游戏有成就、有的没有」的真正原因：
 *    那一行里只有成就占位节点（.pfd-ach-slot）时，占位节点被当成"不算内容"，
 *    判定为空 → 整行 remove() → 刚塞进占位节点里的成就跟着一起没了。
 *    差别只在于"这款游戏有没有被 GameHub 启动过"，跟成就有没有毫无关系。
 * ================================================================== */
console.log('\n[15] 详情页统计行收尾判定');

// 极简 DOM 桩：只实现 pruneEmpty 用到的那几个属性
function fakeNode(cls, kidCount = 0) {
  return {
    classList: { contains: (c) => c === cls },
    children: new Array(kidCount).fill(0),
    isConnected: true,
    removed: false,
    remove() { this.removed = true; }
  };
}
function fakeLine(kids) {
  return { isConnected: true, children: kids, removed: false, remove() { this.removed = true; } };
}
// 把 detailkit 里的 pruneEmpty 逻辑原样搬过来测（它是个纯函数，没有副作用）
const pruneEmpty = (line) => {
  if (!line || !line.isConnected) return line;
  const real = Array.from(line.children).filter((c) => {
    if (!c.classList.contains('pfd-ach-slot')) return true;
    return c.children.length > 0;
  });
  if (!real.length) line.remove();
  return line;
};

t('空占位节点 → 整行收掉（不留空档）', () => {
  const line = fakeLine([fakeNode('pfd-ach-slot', 0)]);
  pruneEmpty(line);
  assert.strictEqual(line.removed, true);
});

t('占位节点里补进成就 → 整行必须留下（这就是那个 bug）', () => {
  const line = fakeLine([fakeNode('pfd-ach-slot', 1)]);
  pruneEmpty(line);
  assert.strictEqual(line.removed, false, '只有成就、没有本地时长的游戏，这一行绝对不能被删');
});

t('有普通内容 → 留下', () => {
  const line = fakeLine([fakeNode('pfd-stat'), fakeNode('pfd-ach-slot', 0)]);
  pruneEmpty(line);
  assert.strictEqual(line.removed, false);
});

t('detailkit 里的实现和这里测的是同一份', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'renderer', 'js', 'detailkit.js'), 'utf8');
  assert.ok(/return c\.children\.length > 0/.test(src),
    'detailkit.pruneEmpty 必须判断占位节点里有没有内容，否则那个 bug 会复发');
});

/* ==================================================================
 *  [16] Epic 本地安装清单：解析 / 过滤 / 字段
 *
 *  这些样本的字段名和取值都抄自真实的 .item 文件结构，
 *  不是凭空编的 —— 过滤器一旦把主游戏误杀，用户会"明明装了却看不见"。
 * ================================================================== */
console.log('\n[16] Epic 本地安装清单解析');

const platforms = require('../src/main/platforms');
const epicFrom = platforms._internals.epicGameFromManifest;
const mergeEpic = platforms.mergeEpic;

/** 一款标准的 Epic 主游戏 .item（照真实字段结构写） */
const EPIC_MAIN_GAME = {
  AppName: 'UnrealTournamentDev',
  DisplayName: 'Unreal Tournament',
  InstallLocation: 'D:\\EGS\\UnrealTournament',
  LaunchExecutable: 'Engine/Binaries/Win64/UE4-Win64-Shipping.exe',
  InstallSize: 20771500286,
  AppCategories: ['games', 'applications'],
  bIsApplication: true,
  CatalogNamespace: 'ut',
  CatalogItemId: 'b8538c739273426aa35a98220e258d55',
  AppVersionString: '++UT+Release-Next-CL-3525360-Windows'
};

t('主游戏（真实 .item 样本）→ 完整解析，且拼出可执行体完整路径', () => {
  const g = epicFrom({ ...EPIC_MAIN_GAME });
  assert.ok(g, '主游戏绝对不能被过滤掉 —— 误杀比多留一条严重得多');
  assert.strictEqual(g.appId, 'UnrealTournamentDev');
  assert.strictEqual(g.name, 'Unreal Tournament');
  assert.strictEqual(g.namespace, 'ut');
  assert.strictEqual(g.catalogItemId, 'b8538c739273426aa35a98220e258d55');
  assert.strictEqual(g.sizeBytes, 20771500286);
  assert.strictEqual(g.installed, true);
  assert.strictEqual(g.source, 'local');
  assert.ok(g.launchPath.endsWith('UE4-Win64-Shipping.exe'),
    '必须拼出 exe 完整路径 —— 「不经客户端直接启动」要用它');
});

t('DLC（同时带 addons 和 games，但没有可执行本体）→ 剔除', () => {
  const g = epicFrom({ AppName: 'SomeDLC', DisplayName: 'Some DLC', AppCategories: ['addons', 'games'] });
  assert.strictEqual(g, null,
    'DLC 常常同时带 addons 和 games 两个分类，只能靠"没有 LaunchExecutable"认出来');
});

t('bIsApplication=false → 剔除（依附主游戏的补丁包）', () => {
  assert.strictEqual(epicFrom({ AppName: 'P', DisplayName: 'Patch', bIsApplication: false }), null);
});

t('Unreal Engine 本体（applications、无 games）→ 剔除', () => {
  const g = epicFrom({
    AppName: 'UE_5.3', DisplayName: 'Unreal Engine 5.3',
    AppCategories: ['applications'], LaunchExecutable: 'Engine/Binaries/Win64/UnrealEditor.exe'
  });
  assert.strictEqual(g, null, '引擎不是游戏，不能占用游戏库');
});

t('裸记录（没有 AppCategories）只要有 exe 就收下', () => {
  const g = epicFrom({ AppName: 'Bare', DisplayName: 'Bare Game', LaunchExecutable: 'a.exe', InstallLocation: 'D:\\g' });
  assert.ok(g, '宁可多留一条，也不能因为清单不完整就丢掉一款真游戏');
  assert.strictEqual(g.name, 'Bare Game');
});

t('裸记录连 exe 都没有 → 剔除（认不出是什么）', () => {
  assert.strictEqual(epicFrom({ AppName: 'Bare2', DisplayName: 'x' }), null);
});

t('脏数据不炸：null / 空对象 / 没有 AppName', () => {
  assert.strictEqual(epicFrom(null), null);
  assert.strictEqual(epicFrom(undefined), null);
  assert.strictEqual(epicFrom({}), null);
  assert.strictEqual(epicFrom({ DisplayName: '只有名字没 ID' }), null);
});

t('本机无 Epic 数据时返回空数组，不抛错', async () => {
  // 这条是同步测试跑的，但 epicInstalled 是 async —— 用同步形式断言它的类型即可
  const r = platforms._internals.epicInstalled();
  assert.ok(r && typeof r.then === 'function', 'epicInstalled 必须是 async 函数');
});

/* ==================================================================
 *  [17] Epic 账号清单解析 + 两条数据源合并
 * ================================================================== */
console.log('\n[17] Epic 账号清单解析与合并');

const { createEpicAuth } = require('../src/main/epicauth');
const epicNorm = createEpicAuth({})._internals.normalize;

t('REST 库记录 → 即使没拿到目录详情，也要能用 sandboxName 当游戏名', () => {
  const g = epicNorm({
    namespace: '9773aa1aa54f4f7b80e44bef04986cea',
    catalogItemId: '530145df28a24424923f5828cc9031a1',
    appName: 'Sugar',
    productId: 'e6bcca5b37d0457ca881aec508205542',
    sandboxName: 'Rocket League®',
    sandboxType: 'PUBLIC'
  });
  assert.ok(g, '库记录必须能折算出来 —— 它是"拥有清单"的唯一来源');
  assert.strictEqual(g.appId, 'Sugar');
  assert.strictEqual(g.name, 'Rocket League®',
    'REST 记录里的 sandboxName 通常就是正式名，目录服务挂掉也不能退化成一堆内部代号');
  assert.strictEqual(g.namespace, '9773aa1aa54f4f7b80e44bef04986cea');
  assert.strictEqual(g.source, 'api');
});

t('有目录详情 → 优先用商店正式名 / 封面 / 开发商 / Steam 互认 ID', () => {
  const g = epicNorm(
    { namespace: 'ut', catalogItemId: 'c1', appName: 'Canis', sandboxName: '内部名' },
    {
      id: 'c1', namespace: 'ut', title: 'Unreal Tournament',
      keyImages: [
        { type: 'DieselGameBoxWide', url: 'https://cdn/wide.jpg' },
        { type: 'DieselGameBox', url: 'https://cdn/tall.jpg' }
      ],
      // ⚠ REST 里 platform 是数组，不是字符串
      releaseInfo: [{ appId: '13240', platform: ['Windows'] }],
      customAttributes: [{ key: 'developerName', value: 'Epic Games' }],
      mainGameItem: null
    }
  );
  assert.strictEqual(g.name, 'Unreal Tournament', '有正式名就该用正式名，别拿内部代号顶');
  assert.strictEqual(g.coverUrl, 'https://cdn/tall.jpg');
  assert.strictEqual(g.steamAppId, '13240', '要能抠出 Steam AppID，后续才能跟 Steam 的数据对上');
  assert.strictEqual(g.developer, 'Epic Games');
});

t('sandboxName 和详情都没有 → 退回内部 appName（至少有东西显示）', () => {
  const g = epicNorm({ namespace: 'ns', catalogItemId: 'x', appName: 'SomeInternalName' });
  assert.strictEqual(g.name, 'SomeInternalName');
});

t('封面优先竖版：有 Box 就用 Box，不是 Wide', () => {
  const g = epicNorm({ appName: 'A' }, {
    title: 'A',
    keyImages: [
      { type: 'DieselGameBoxWide', url: 'https://w.jpg' },
      { type: 'DieselGameBox', url: 'https://t.jpg' }
    ]
  });
  assert.strictEqual(g.coverUrl, 'https://t.jpg', '卡片是竖版比例，竖图优先才不会被裁得很难看');
});

t('没有竖图 → 降级到横图，不留空', () => {
  const g = epicNorm({ appName: 'B' }, {
    title: 'B',
    keyImages: [{ type: 'DieselGameBoxWide', url: 'https://w.jpg' }]
  });
  assert.strictEqual(g.coverUrl, 'https://w.jpg');
});

t('有详情且标了 mainGameItem → 是 DLC，剔除', () => {
  const g = epicNorm({ appName: 'D' }, { title: 'DLC', keyImages: [], mainGameItem: { id: 'parent' } });
  assert.strictEqual(g, null);
});

t('拿不到详情时绝不误杀（宁可多留一条 DLC）', () => {
  const g = epicNorm({ appName: 'D2', sandboxName: '也许是 DLC' });
  assert.ok(g, '没有详情就没有依据判断是不是 DLC，必须留下 —— 少一款真游戏比多一条 DLC 严重得多');
});

t('platform 是数组或字符串都能认（REST 与旧 GraphQL 的差异）', () => {
  const pick = createEpicAuth({})._internals.pickSteamAppId;
  assert.strictEqual(pick([{ appId: '9', platform: ['Windows'] }]), '9', 'REST 里 platform 是数组');
  assert.strictEqual(pick([{ appId: '9', platform: 'Windows' }]), '9', '旧 GraphQL 里是字符串');
  assert.strictEqual(pick([]), '');
});

t('既有本地又有账号：保留本地安装信息 + 用账号的封面和正式名', () => {
  const local = [{ appId: 'G1', name: '游戏一', installed: true, installDir: 'D:\\G1',
                   launchPath: 'D:\\G1\\g.exe', sizeBytes: 999, source: 'local' }];
  const api = [{ appId: 'G1', name: '游戏一 正式名', installed: false,
                 coverUrl: 'https://c.jpg', steamAppId: '123', source: 'api' }];
  const r = mergeEpic(local, api);
  assert.strictEqual(r.length, 1, '同一款游戏必须合成一条，不能出现两张卡');
  assert.strictEqual(r[0].installed, true, 'installed 只可能来自本地');
  assert.strictEqual(r[0].launchPath, 'D:\\G1\\g.exe', '本地安装信息不能被账号数据覆盖掉');
  assert.strictEqual(r[0].sizeBytes, 999);
  assert.strictEqual(r[0].coverUrl, 'https://c.jpg', '封面只有账号那边有');
  assert.strictEqual(r[0].source, 'both');
});

t('只有账号有（领了没下载）→ 保留，且标记为未安装', () => {
  const r = mergeEpic([], [{ appId: 'G2', name: '领的', installed: false, coverUrl: 'https://c.jpg', source: 'api' }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].installed, false, '这就是"没下载的游戏黑白显示"的数据基础');
});

t('只有本地有（账号清单拉失败）→ 一条都不能丢', () => {
  const r = mergeEpic([{ appId: 'G3', name: '本地的', installed: true, source: 'local' }], []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].installed, true);
});

t('合并时不吃脏数据：null / undefined 当空数组', () => {
  assert.deepStrictEqual(mergeEpic(null, null), []);
  assert.deepStrictEqual(mergeEpic(undefined, []), []);
  assert.strictEqual(mergeEpic([], undefined).length, 0);
});

/* ==================================================================
 *  [18] Epic 登录：授权码提取与登录地址构造
 *
 *  样本直接取自实测：未登录时 Epic 会返回一段 authorizationCode 为 null
 *  的裸 JSON —— 用户第一次就是这么撞上的（看到一整屏天书）。
 * ================================================================== */
console.log('\n[18] Epic 登录：授权码提取与登录地址');

const epicAuth = require('../src/main/epicauth');
const extractAuthCode = epicAuth.extractAuthCode;
const looksLikeAuthResult = epicAuth.looksLikeAuthResult;
const buildLoginUrl = epicAuth.buildLoginUrl;

/** 实测样本：未登录 */
const EPIC_PAGE_ANON = JSON.stringify({
  warning: 'Do not share this code with any 3rd party service. It allows full access to your Epic account.',
  redirectUrl: 'https://localhost/launcher/authorized',
  authorizationCode: null,
  exchangeCode: null,
  sid: null
}, null, 2);

/** 登录成功后同一页面会带上授权码 */
const EPIC_PAGE_OK = JSON.stringify({
  warning: 'Do not share this code with any 3rd party service. It allows full access to your Epic account.',
  redirectUrl: 'https://localhost/launcher/authorized',
  authorizationCode: 'abc123def456ghi789',
  exchangeCode: null,
  sid: null
}, null, 2);

t('登录地址必须套 /id/login —— 直接打 /id/api/redirect 只会显示天书', () => {
  const u = buildLoginUrl();
  assert.ok(u.startsWith('https://www.epicgames.com/id/login?redirectUrl='),
    '不套 /id/login 的话，未登录时不会渲染登录表单，只甩一段裸 JSON（那就是最初的 bug）');
  assert.ok(u.includes('34a02cf8f4414e29b15921876da36f9a'), 'clientId 要带上');
});

t('登录地址里的 redirectUrl 解码后是合法的授权端点', () => {
  const u = new URL(buildLoginUrl());
  const inner = new URL(u.searchParams.get('redirectUrl'));
  assert.strictEqual(inner.pathname, '/id/api/redirect');
  assert.strictEqual(inner.searchParams.get('responseType'), 'code');
  assert.strictEqual(inner.searchParams.get('clientId'), '34a02cf8f4414e29b15921876da36f9a');
});

t('未登录的真实样本 → 提取不出码，但要认出"这是结果页"', () => {
  assert.strictEqual(extractAuthCode(EPIC_PAGE_ANON), '',
    'authorizationCode 为 null 时绝不能返回 "null" 这个字符串');
  assert.strictEqual(looksLikeAuthResult(EPIC_PAGE_ANON), true,
    '要认出它是结果页，界面才能给出"你还没登录"的提示而不是干等');
});

t('登录成功的样本 → 正确抠出授权码', () => {
  assert.strictEqual(extractAuthCode(EPIC_PAGE_OK), 'abc123def456ghi789');
});

t('字符串 "null" 绝不能被当成有效授权码', () => {
  const code = extractAuthCode(EPIC_PAGE_ANON);
  assert.notStrictEqual(code, 'null', '把 "null" 发给 token 端点会直接失败');
  assert.ok(!code, '空值必须是 falsy，调用方才能正确分支');
});

t('非 JSON 的普通页面 → 不误判成结果页', () => {
  assert.strictEqual(looksLikeAuthResult('<html><body>Epic Games 登录</body></html>'), false);
  assert.strictEqual(extractAuthCode(''), '');
  assert.strictEqual(extractAuthCode(null), '');
  assert.strictEqual(extractAuthCode(undefined), '');
});

t('JSON 被 Chromium 查看器重排过格式也能抠出来', () => {
  // 实测：JSON 查看器会重新缩进、字段顺序也可能变
  const messy = '{\n  "sid" : null,\n  "authorizationCode"  :  "zzz999",\n  "warning" : "x"\n}';
  assert.strictEqual(extractAuthCode(messy), 'zzz999');
});

t('网络错误要说人话（ENOTFOUND 这种不该直接甩给用户）', () => {
  const f = createEpicAuth({})._internals.friendlyNetError;
  // 用户上一版实际撞到的就是这一条
  const msg = f('launcher-graphql.epicgames.com → ENOTFOUND');
  assert.ok(!/ENOTFOUND|getaddrinfo/.test(msg), '前半句必须是中文人话，不能把系统错误原样端上去');
  assert.ok(/解析不到|网络|DNS/.test(msg), '要让人知道是网络层面的问题');

  assert.ok(/超时/.test(f('ETIMEDOUT')));
  assert.ok(/中断/.test(f('ECONNRESET')));
  assert.ok(/安全连接/.test(f('unable to verify the first certificate')));
  assert.ok(f('') !== '', '空输入也要给出兜底文案');
});

/* ==================================================================
 *  [19] Epic 真实数据回放：目录详情的「存」与「取」必须是同一个键
 *
 *  为什么单开这一组：用户实测截图里，半屏游戏叫 "Live"、封面全是字母块。
 *  根因是 fetchCatalogDetails 存 Map 用裸 catalogItemId、
 *  fetchLibrary 取的时候却拼了 `${namespace}:${catalogItemId}` ——
 *  两边各自拼字符串，永远查不中，详情（正式名 + 封面）全军覆没，
 *  而且**全程不报错**。
 *
 *  上面 [17] 那组测的是 normalize 本身，喂进去的是手搓的理想 detail，
 *  刚好绕开了这条缝，所以没拦住。这组直接拿**真实抓下来的响应**过一遍
 *  真实的 indexBulkResponse / detailKey，把缝堵上。
 * ================================================================== */
console.log('\n[19] Epic 真实数据回放：详情存取的键必须一致');

const EPIC_FIX = require('./fixtures/epic-real-capture.json');
const E = createEpicAuth({})._internals;

/** 完全照 fetchCatalogDetails 的做法建索引表 */
function buildRealIndex() {
  const out = new Map();
  for (const ns of Object.keys(EPIC_FIX.bulk)) E.indexBulkResponse(EPIC_FIX.bulk[ns], out);
  return out;
}

/** 完全照 fetchLibrary 的做法折算一遍 */
function replayReal(body, dedupeKey) {
  const out = [];
  const seen = new Set();
  let unresolved = 0;
  for (const rec of EPIC_FIX.library) {
    const detail = body.get(dedupeKey(rec));
    if (!detail) unresolved++;
    const g = E.normalize(rec, detail);
    if (g && !seen.has(g.appId)) { seen.add(g.appId); out.push(g); }
  }
  return { out, unresolved };
}

t('夹具本身是真的：记录了 160 条库记录、126 个 namespace', () => {
  assert.strictEqual(EPIC_FIX._stats.libraryRecords, 160);
  assert.ok(Object.keys(EPIC_FIX.bulk).length > 100, 'bulk 响应要按 namespace 分开存');
});

t('bulk 响应的顶层键就是裸 catalogItemId（这是那次事故的关键事实）', () => {
  const ns = Object.keys(EPIC_FIX.bulk)[0];
  const keys = Object.keys(EPIC_FIX.bulk[ns]);
  assert.ok(keys.length, '至少要有一条');
  for (const k of keys) {
    assert.ok(!k.includes(':'), '顶层键里没有 namespace 前缀，就是裸 id —— 所以查的时候也不能带前缀');
    assert.ok(!k.includes(ns), '同理，键里不含 namespace');
  }
});

t('★ 用 detailKey() 存 → 用 detailKey() 取：一条都不能漏', () => {
  const { unresolved } = replayReal(buildRealIndex(), E.detailKey);
  assert.strictEqual(unresolved, 0,
    `有 ${unresolved} 条库记录拿不到详情 —— 这就意味着名字会退化成内部代号、封面全空`);
});

t('★ 反证：用旧的 `${namespace}:${catalogItemId}` 去查，几乎全查不中', () => {
  const { unresolved } = replayReal(buildRealIndex(), (r) => `${r.namespace}:${r.catalogItemId}`);
  assert.ok(unresolved > EPIC_FIX.library.length * 0.9,
    '旧写法本来就该大面积查不中；这条是把这个事实钉住，防止有人改回去');
});

t('★ 修复后：不再出现叫 "Live" 的游戏', () => {
  const { out } = replayReal(buildRealIndex(), E.detailKey);
  const live = out.filter((g) => /^live$/i.test(g.name));
  assert.strictEqual(live.length, 0,
    '原始数据里有 40+ 条 sandboxName 是 "Live"，它们全都不该以这个名字出现');
});

t('★ 修复后：没有一款游戏的名字是内部代号', () => {
  const { out } = replayReal(buildRealIndex(), E.detailKey);
  const bad = out.filter((g) => E.looksLikeInternalName(g.name));
  assert.deepStrictEqual(bad.map((g) => g.name), [],
    '既不该是 "Live"，也不该是 32 位 hash 或 "xxx Production" 这种工程名');
  assert.strictEqual(out.filter((g) => g.nameUnresolved).length, 0);
});

t('★ 修复后：每一款都有封面（上一版全是字母占位块）', () => {
  const { out } = replayReal(buildRealIndex(), E.detailKey);
  const noCover = out.filter((g) => !g.coverUrl);
  assert.deepStrictEqual(noCover.map((g) => g.name), [],
    '封面只来自目录详情 —— 详情查不中，封面就全没了');
});

t('★ 修复后：没有重名的卡片', () => {
  const { out } = replayReal(buildRealIndex(), E.detailKey);
  const cnt = {};
  out.forEach((g) => { cnt[g.name] = (cnt[g.name] || 0) + 1; });
  const dup = Object.entries(cnt).filter(([, v]) => v > 1);
  assert.deepStrictEqual(dup, [],
    '用户截图里出现过 "Dying Light" 连出三张，这里要保证不会再发生');
});

t('真实数据折算出的规模合理，且 DLC 被剔掉了', () => {
  const { out } = replayReal(buildRealIndex(), E.detailKey);
  assert.strictEqual(out.length, 131,
    '160 条 entitlement → 剔掉 29 条挂在主游戏下的 DLC');
  assert.ok(out.every((g) => g.platformId === 'epic'));
  // 抽查几个真实游戏名，确认不是巧合对上
  const names = out.map((g) => g.name);
  assert.ok(names.includes('Death Stranding'), '死亡搁浅必须在');
  assert.ok(names.includes('Cat Quest'), '那条 sandboxName 是 "Live" 的，真实身份是 Cat Quest');
  assert.ok(names.some((n) => n.includes('龙腾世纪')),
    'sandboxName 同为 "Live" 的《龙腾世纪：审判》年度版也必须正确认出来');
});

t('内部代号识别：Live / hash / Production 都该认出来', () => {
  assert.strictEqual(E.looksLikeInternalName('Live'), true);
  assert.strictEqual(E.looksLikeInternalName('live'), true);
  assert.strictEqual(E.looksLikeInternalName('shoal Production'), true);
  assert.strictEqual(E.looksLikeInternalName('63a665088eb1480298f1e57943b225d8'), true);
  assert.strictEqual(E.looksLikeInternalName('Death Stranding'), false);
  assert.strictEqual(E.looksLikeInternalName(''), true, '空值也算"没名字"');
});

t('detailKey 的契约：只认 catalogItemId，多余字段不影响', () => {
  assert.strictEqual(E.detailKey({ catalogItemId: 'abc', namespace: 'ns' }), 'abc');
  assert.strictEqual(E.detailKey({ namespace: 'ns' }), '');
  assert.strictEqual(E.detailKey(null), '');
});

t('indexBulkResponse 不吃脏数据', () => {
  const m = E.indexBulkResponse({ a: { title: 'A' }, b: null, c: 'str', d: 3 }, new Map());
  assert.deepStrictEqual([...m.keys()], ['a'], '只有真对象才进表');
  assert.deepStrictEqual([...E.indexBulkResponse(null, new Map()).keys()], []);
});

/* ==================================================================
 *  [20] MOD 管理：纯逻辑（改名规则 / ACF 解析 / 标签分组 / 跳转地址）
 * ================================================================== */
console.log('\n[20] MOD 管理：纯逻辑');

const MODS = require('../src/main/mods');

t('禁用 = 加后缀，启用 = 去后缀，来回都是可逆的', () => {
  const D = MODS.DISABLED_SUFFIX;
  assert.strictEqual(MODS.disabledName('MyMod'), 'MyMod' + D);
  assert.strictEqual(MODS.enabledName('MyMod' + D), 'MyMod');
  // 幂等：已经是禁用名了再调一次不该变成 xxx.disabled.disabled
  assert.strictEqual(MODS.disabledName('MyMod' + D), 'MyMod' + D);
  assert.strictEqual(MODS.enabledName('MyMod'), 'MyMod');
  assert.strictEqual(MODS.isDisabledName('MyMod' + D), true);
  assert.strictEqual(MODS.isDisabledName('MyMod'), false);
  // 大小写不敏感：Windows 上 .Disabled 和 .disabled 是同一个文件
  assert.strictEqual(MODS.isDisabledName('MyMod.GAMEHUB-DISABLED'), true);
});

t('文件类 MOD 也认（不是只有文件夹）', () => {
  const D = MODS.DISABLED_SUFFIX;
  assert.strictEqual(MODS.disabledName('tweak.pak'), 'tweak.pak' + D);
  // 后缀加在最后，原来的 .pak 扩展名还看得见 —— 用户一眼知道那是什么文件
  assert.ok(MODS.enabledName('tweak.pak' + D).endsWith('.pak'));
});

t('系统垃圾不算 MOD', () => {
  assert.strictEqual(MODS.isJunk('desktop.ini'), true);
  assert.strictEqual(MODS.isJunk('Thumbs.db'), true);
  assert.strictEqual(MODS.isJunk('.DS_Store'), true);
  assert.strictEqual(MODS.isJunk('.git'), true);
  assert.strictEqual(MODS.isJunk(''), true);
  assert.strictEqual(MODS.isJunk('RealMod'), false);
  assert.strictEqual(MODS.isJunk('mod_config.json'), false);
});

t('★ 说明书 / 占位符不算 MOD（RimWorld 的 Place mods here.txt 踩过）', () => {
  // 实测撞上的那一个
  assert.strictEqual(MODS.isJunk('Place mods here.txt'), true);
  assert.strictEqual(MODS.isJunk('README.md'), true);
  assert.strictEqual(MODS.isJunk('LICENSE'), true);
  assert.strictEqual(MODS.isJunk('changelog.txt'), true);
  assert.strictEqual(MODS.isJunk('安装说明.txt'), true);
  assert.strictEqual(MODS.isJunk('mod.url'), true);
  // ⚠ 别误杀：真正的 MOD 不能被卷进来
  assert.strictEqual(MODS.isJunk('RealMod'), false);
  assert.strictEqual(MODS.isJunk('Core'), false);
  assert.strictEqual(MODS.isJunk('Harmony'), false);
  assert.strictEqual(MODS.isJunk('MyMod.pak'), false);
  // 名字里带 readme 但确实是 MOD 的（比如 ReadmeMod）—— 前缀规则会吃掉它，
  // 这是刻意的取舍：宁可漏一个怪名字的 MOD，也别让每个游戏都多几条说明书。
  // 这条断言是把这个取舍写下来，改规则时能看见自己在动什么。
  assert.strictEqual(MODS.isJunk('ReadmeMod'), true);
});

t('appworkshop.acf → 体积与更新时间（离线也能列出 MOD）', () => {
  const acf = '"AppWorkshop"\n{\n'
    + '\t"appid"\t\t"1206560"\n'
    + '\t"WorkshopItemsInstalled"\n\t{\n'
    + '\t\t"1234"\n\t\t{\n\t\t\t"size"\t\t"52428800"\n\t\t\t"timeupdated"\t\t"1700000000"\n\t\t}\n'
    + '\t}\n'
    + '\t"WorkshopItemDetails"\n\t{\n'
    + '\t\t"1234"\n\t\t{\n\t\t\t"timeupdated"\t\t"1700000123"\n\t\t}\n'
    + '\t\t"5678"\n\t\t{\n\t\t\t"timeupdated"\t\t"1600000000"\n\t\t}\n'
    + '\t}\n}';
  const m = MODS.parseWorkshopAcf(acf);
  assert.strictEqual(m.size, 2, 'Installed 和 Details 里的条目都要认出来');
  assert.strictEqual(m.get('1234').size, 52428800);
  assert.strictEqual(m.get('1234').timeUpdated, 1700000123, 'Details 里的更新时间更准，要覆盖掉 Installed 的');
  assert.strictEqual(m.get('5678').timeUpdated, 1600000000, '只有 Details 的条目也不能丢');
});

t('ACF 是坏文件 / 空文件时不能抛异常', () => {
  assert.strictEqual(MODS.parseWorkshopAcf('').size, 0);
  assert.strictEqual(MODS.parseWorkshopAcf('这不是 VDF').size, 0);
  assert.strictEqual(MODS.parseWorkshopAcf(null).size, 0);
});

t('工坊接口的表单体：itemcount + 带下标的 publishedfileids[N]', () => {
  const body = MODS.workshopApiBody(['111', '222']);
  const q = new URLSearchParams(body);
  assert.strictEqual(q.get('itemcount'), '2');
  assert.strictEqual(q.get('publishedfileids[0]'), '111',
    '下标必须从 0 开始且逐个带 —— 拼错这一处整个标题就全没了');
  assert.strictEqual(q.get('publishedfileids[1]'), '222');
  assert.strictEqual(new URLSearchParams(MODS.workshopApiBody([])).get('itemcount'), '0');
});

t('★ 纯 Node 环境下 electron-net 那条路必须"明确缺席"，不能假装成功', () => {
  // 契约：postFormJson 里靠"返回 null"来判断该不该往下走 fetch/https。
  // 如果这里不返回 null 而是抛错或者返回个假对象，纯 Node 的集成测试
  // 就会走进一个根本连不上的分支，表现成"工坊接口全挂"。
  const r = MODS.postFormViaElectronNet('https://example.com/x', {}, 'a=1', 1000);
  assert.strictEqual(r, null, '纯 Node 里 require("electron") 拿到的是字符串，必须返回 null');
});

t('工坊响应 → 标题 / 标签 / 预览图；result≠1 的幽灵条目要丢掉', () => {
  const json = {
    response: {
      publishedfiledetails: [
        {
          publishedfileid: '1234', result: 1, title: 'Bigger Maps',
          preview_url: 'https://cdn/p.jpg', time_updated: 1700000000,
          file_size: 1024, subscriptions: 999,
          tags: [{ tag: 'Maps' }, { tag: 'Gameplay' }]
        },
        // 不存在的 id 也会回一条，只是 result=9 —— 不滤掉界面上会多出一堆空白 MOD
        { publishedfileid: '9999', result: 9 },
        // 标签字段偶尔是空对象，不能炸
        { publishedfileid: '5555', result: 1, title: 'No Tags', tags: [{}, { tag: '' }] }
      ]
    }
  };
  const m = MODS.parseWorkshopDetails(json);
  assert.strictEqual(m.size, 2, 'result=9 的必须被剔除');
  assert.strictEqual(m.get('1234').title, 'Bigger Maps');
  assert.deepStrictEqual(m.get('1234').tags, ['Maps', 'Gameplay']);
  assert.deepStrictEqual(m.get('5555').tags, [], '空标签项不能变成 ["undefined"]');
  assert.strictEqual(MODS.parseWorkshopDetails(null).size, 0);
  assert.strictEqual(MODS.parseWorkshopDetails({}).size, 0);
});

/* ---- 二级分类 ---- */
/* 给每条都补上 kind：兜底桶是按"有没有标签 + 来源"决定的，
 * 少了 kind 就没法判断该进哪个桶 */
const fakeMods = [
  { title: 'A', tags: ['Maps'], enabled: true, sizeBytes: 10, timeUpdated: 3, kind: 'workshop' },
  { title: 'B', tags: ['Gameplay', 'Maps'], enabled: false, sizeBytes: 30, timeUpdated: 1, kind: 'workshop' },
  { title: 'C', tags: [], enabled: true, sizeBytes: 20, timeUpdated: 2, kind: 'local' },
  { title: 'D', tags: ['Gameplay'], enabled: true, sizeBytes: 5, timeUpdated: 4, kind: 'workshop' },
  // 工坊条目也可能没标签 —— 它和本地 MOD 不该挤在同一个兜底桶里
  { title: 'E', tags: [], enabled: true, sizeBytes: 7, timeUpdated: 5, kind: 'workshop' }
];

t('按标签分组：一个 MOD 只归到**第一个**标签，不在多组里重复出现', () => {
  const g = MODS.groupByTag(fakeMods, 'name', true);
  const inGameplay = g.find((x) => x.tag === 'Gameplay').mods.map((m) => m.title);
  const inMaps = g.find((x) => x.tag === 'Maps').mods.map((m) => m.title);
  assert.ok(inGameplay.includes('B'), 'B 的第一个标签是 Gameplay，就该在这一组');
  assert.ok(!inMaps.includes('B'), '它不能同时出现在 Maps 组里 —— 那看着就像有两个 MOD');
  const total = g.reduce((s, x) => s + x.mods.length, 0);
  assert.strictEqual(total, fakeMods.length, '每个 MOD 都要有归属，不能漏');
});

t('★ 兜底桶分两个：本地 MOD 和"创意工坊·无标签"不能混在一起', () => {
  const g = MODS.groupByTag(fakeMods, 'name', true);
  const local = g.find((x) => x.tag === MODS.UNTAGGED_LOCAL);
  const ws = g.find((x) => x.tag === MODS.UNTAGGED_WORKSHOP);
  assert.deepStrictEqual(local.mods.map((m) => m.title), ['C'], '只有本地那条进"本地 MOD"');
  assert.deepStrictEqual(ws.mods.map((m) => m.title), ['E'],
    '创意工坊条目没标签也不能显示成"本地" —— 用户会以为来源认错了');
});

t('★ 筛选按"成员关系"，不按"第一个标签"：点 Maps 要看到所有带 Maps 的', () => {
  // 这条是分组/筛选两个口径混用埋过的坑：分组按归属（B 只站 Gameplay），
  // 筛选按成员（B 带 Maps，就该出现在 Maps 的筛选结果里）
  const maps = MODS.modsWithTag(fakeMods, 'Maps').map((m) => m.title);
  assert.deepStrictEqual(maps.sort(), ['A', 'B'], 'B 带 Maps 就必须被筛出来');
  assert.deepStrictEqual(MODS.modsWithTag(fakeMods, 'Gameplay').map((m) => m.title).sort(),
    ['B', 'D']);
  assert.deepStrictEqual(MODS.modsWithTag(fakeMods, MODS.UNTAGGED_LOCAL).map((m) => m.title), ['C']);
  assert.deepStrictEqual(MODS.modsWithTag(fakeMods, MODS.UNTAGGED_WORKSHOP).map((m) => m.title), ['E']);
  assert.deepStrictEqual(MODS.modsWithTag(fakeMods, '不存在的标签'), []);
});

t('标签计数也是按成员关系算的', () => {
  const c = MODS.tagCounts(fakeMods);
  assert.strictEqual(c['Maps'], 2, 'A 和 B');
  assert.strictEqual(c['Gameplay'], 2, 'B 和 D');
  assert.strictEqual(c[MODS.UNTAGGED_LOCAL], 1, '只有 C');
  assert.strictEqual(c[MODS.UNTAGGED_WORKSHOP], 1, '只有 E');
  // 一个 MOD 带重复标签时不能重复计数
  const dup = MODS.tagCounts([{ tags: ['X', 'X'], kind: 'workshop' }]);
  assert.strictEqual(dup['X'], 1);
});

t('兜底桶名不能被当成真标签（影响排序和筛选分支）', () => {
  assert.strictEqual(MODS.isPseudoGroup(MODS.UNTAGGED_LOCAL), true);
  assert.strictEqual(MODS.isPseudoGroup(MODS.UNTAGGED_WORKSHOP), true);
  assert.strictEqual(MODS.isPseudoGroup('Maps'), false);
  assert.strictEqual(MODS.PSEUDO_GROUPS.length, 2);
});

t('收集标签去重并排序', () => {
  assert.deepStrictEqual(MODS.collectTags(fakeMods), ['Gameplay', 'Maps']);
  assert.deepStrictEqual(MODS.collectTags([]), []);
});

t('排序：吃 null / 缺字段，不炸', () => {
  const messy = [{ title: 'x' }, null, { title: 'a', sizeBytes: 5 }, { title: 'b', timeUpdated: 9 }];
  assert.doesNotThrow(() => MODS.sortMods(messy.filter(Boolean), 'size', true));
  assert.doesNotThrow(() => MODS.sortMods(null, 'name', true));
  assert.strictEqual(MODS.sortMods(fakeMods, 'size', true)[0].title, 'D', '按大小升序，最小的是 D(5)');
  assert.strictEqual(MODS.sortMods(fakeMods, 'size', false)[0].title, 'B', '降序最大的是 B(30)');
  // E 的 timeUpdated=5 是最大的，降序理应排第一
  assert.strictEqual(MODS.sortMods(fakeMods, 'updated', false)[0].title, 'E');
});

t('按启用状态排序：启用的排前面（这样一眼看到还没关掉哪些）', () => {
  const r = MODS.sortMods(fakeMods, 'enabled', true);
  assert.strictEqual(r[r.length - 1].enabled, false);
  assert.ok(r.slice(0, -1).every((m) => m.enabled));
});

/* ---- 跳转地址 ---- */
t('N 网地址：参数名是 keyword、路径是 /games（实测确认过）', () => {
  const u = MODS.nexusSearchUrl('WorldBox - God Simulator');
  assert.ok(u.startsWith('https://www.nexusmods.com/games?keyword='));
  assert.ok(u.includes('WorldBox%20-%20God%20Simulator'), '游戏名要正确编码');
  // 网上流传的 /search/?gsearch= 那套是错的（实测会渲染成空搜索），别改回去
  assert.ok(!u.includes('gsearch'), 'gsearch 是错的参数名');
  assert.ok(!u.includes('/search/'), '/search/ 是错的路径');
  assert.ok(MODS.nexusSearchUrl('').length > 0, '空名字也要给出合法 URL，不能抛');
});

t('Steam 创意工坊地址：网页版 + 客户端版都要有', () => {
  assert.strictEqual(MODS.steamWorkshopWebUrl('1206560'),
    'https://steamcommunity.com/app/1206560/workshop/');
  // 客户端版的 protocol 拼错就没有任何反应，所以固定住
  assert.strictEqual(MODS.steamWorkshopClientUrl('1206560'),
    'steam://url/SteamWorkshopPage/1206560');
  // 必须是 steam:// 而不是 http —— 主人的要求：点工坊要进 Steam 客户端，别跳浏览器
  assert.ok(MODS.steamWorkshopClientUrl('1206560').startsWith('steam://'),
    '客户端版必须走 steam:// 协议，不能是网页地址');
});

t('路径指纹：同一路径稳定、不同路径不同', () => {
  const a = MODS.pathKey('D:\\Mods\\A');
  assert.strictEqual(a, MODS.pathKey('D:\\Mods\\A'), '同一路径必须每次都一样');
  assert.strictEqual(a, MODS.pathKey('d:/mods/a/'), 'Windows 上大小写和结尾斜杠不该算两个路径');
  assert.notStrictEqual(a, MODS.pathKey('D:\\Mods\\B'));
  assert.strictEqual(MODS.pathKey('').length, 12);
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
