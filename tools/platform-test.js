/**
 * 平台数据层实测：检测各平台 + 完整同步一次 Steam。
 * 用法： node tools/platform-test.js
 */
const P = require('../src/main/platforms');

(async () => {
  console.log('=== 平台检测 ===');
  const list = await P.listPlatforms();
  for (const p of list) {
    console.log(`  ${p.detected ? '✓' : '·'} ${p.name.padEnd(16)} 可同步=${p.canSync ? 'Y' : 'N'}  ${p.installPath || '(未检测到)'}${p.note ? '  ' + p.note : ''}`);
  }

  console.log('\n=== 同步 Steam ===');
  const t0 = Date.now();
  const msgs = [];
  const r = await P.syncPlatform('steam', { onProgress: (p) => msgs.push(p.message) });
  console.log('  用时 ' + (Date.now() - t0) + 'ms, ok=' + r.ok);
  if (!r.ok) { console.log('  错误: ' + r.error); return; }

  console.log('  安装目录: ' + r.installPath);
  console.log('  账号: ' + JSON.stringify(r.account));
  console.log('  统计: ' + JSON.stringify(r.stats));
  console.log('  探测到账号 ' + r.accounts.length + ' 个 → ' + r.accounts.map((a) => a.personaName).join(' / '));
  console.log('  隐私声明: ' + r.privacy);
  console.log('  游戏总数: ' + r.games.length);

  console.log('\n  前 10 个（按时长排序）:');
  for (const g of r.games.slice(0, 10)) {
    const h = (g.playtimeMs / 3600000).toFixed(1);
    const ach = g.achievements ? g.achievements.unlocked + '/' + g.achievements.total : '未知';
    console.log('    ' + (g.installed ? '[已装]' : '[未装]') + ' ' + g.name.slice(0, 34).padEnd(36) + ' ' + h.padStart(8) + 'h  成就 ' + ach);
  }

  const notInstalled = r.games.filter((g) => !g.installed);
  console.log('\n  未安装的游戏: ' + notInstalled.length + ' 个，示例:');
  for (const g of notInstalled.slice(0, 10)) {
    const ach = g.achievements ? g.achievements.unlocked + '/' + g.achievements.total : '未知';
    console.log('    ' + g.name.slice(0, 38).padEnd(40) + ' appid=' + String(g.appId).padEnd(9) + ' 成就=' + ach);
  }

  const noName = r.games.filter((g) => /^Steam App \d+$/.test(g.name)).length;
  const unknownAch = r.games.filter((g) => !g.achievements).length;
  const realAch = r.games.filter((g) => g.achievements).length;
  console.log('\n  质量检查:');
  console.log('    名字没解析出来的: ' + noName + ' 个');
  console.log('    有成就数据的: ' + realAch + ' 个');
  console.log('    成就未知的: ' + unknownAch + ' 个（界面会隐藏成就，而不是错误地显示 0）');
  if (r.warnings.length) console.log('    警告: ' + r.warnings.join(' / '));
})().catch((e) => { console.error(e); process.exit(1); });
