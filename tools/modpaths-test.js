/**
 * MOD 目录规则引擎测试  (tools/modpaths-test.js)
 *
 * 这些用例不是凭空编的 —— 每一条都对应联网查证过的真实规则，
 * 尤其是那些「反直觉」的（Bethesda 放 Data 不放 Mods、
 * 博德之门3 在 AppData 不在游戏目录、欧卡2 是单数 mod 不是 mods）。
 *
 * 用法： node tools/modpaths-test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const M = require('../src/main/modpaths');

let pass = 0, fail = 0;
const failures = [];

/** 同步用例 */
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n      ${e.message}`); }
}

/** 异步用例（detectExisting 是 async 的，必须 await 才能捕获断言） */
async function ta(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n      ${e.message}`); }
}

/* 统一的假环境，保证测试与开发机无关 */
const ENV = {
  HOME: 'C:\\Users\\Tester',
  APPDATA: 'C:\\Users\\Tester\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
  DOCS: 'C:\\Users\\Tester\\Documents'
};
const OPTS = { env: ENV };
/** 只关心"相对游戏目录"的规则时用的游戏壳 */
const G = (name, extra = {}) => Object.assign({
  name,
  installDir: 'D:\\Games\\' + name,
  steamAppId: ''
}, extra);

console.log('\n=========== MOD 目录规则引擎测试 ===========\n');

/* ---------------- 1. Bethesda：Data 而不是 Mods ---------------- */
console.log('-- Bethesda 系列（最容易搞错的一族）--');

t('老滚5 天际 特别版 → Data', () => {
  const r = M.resolveModDir(G('Skyrim Special Edition'), OPTS);
  assert.strictEqual(r.source, 'name', '应按名字命中');
  assert.strictEqual(path.normalize(r.dir), path.normalize('D:\\Games\\Skyrim Special Edition\\Data'));
});

t('老滚5 中文名 → Data', () => {
  const r = M.resolveModDir(G('上古卷轴5：天际'), OPTS);
  assert.strictEqual(path.basename(r.dir), 'Data');
});

t('辐射4 → Data', () => {
  const r = M.resolveModDir(G('Fallout 4'), OPTS);
  assert.strictEqual(path.basename(r.dir), 'Data');
});

t('辐射4 中文名 → Data', () => {
  const r = M.resolveModDir(G('辐射4'), OPTS);
  assert.strictEqual(path.basename(r.dir), 'Data');
});

t('⚠ 不能误判成 Mods：老滚的候选里 Data 要排在 Mods 前', () => {
  const r = M.resolveModDir(G('Skyrim Special Edition'), OPTS);
  const names = r.candidates.map((c) => path.basename(c.dir));
  assert.ok(names.indexOf('Data') < names.indexOf('Mods'), `顺序不对：${names.join(',')}`);
});

/* ---------------- 2. AppID 精确匹配优先 ---------------- */
console.log('-- Steam AppID 精确匹配 --');

t('AppID 489520（天际SE）→ Data', () => {
  const r = M.resolveModDir({ name: '随便什么名字', installDir: 'D:\\X', steamAppId: '489520' }, OPTS);
  assert.strictEqual(r.source, 'appid', `来源应为 appid，实际 ${r.source}`);
  assert.strictEqual(path.normalize(r.dir), path.normalize('D:\\X\\Data'));
});

t('AppID 优先于游戏名（名字会误导时用 AppID 兜住）', () => {
  // 名字里带 "Mods" 但 AppID 是天际 SE —— 必须听 AppID 的
  const r = M.resolveModDir({ name: 'Mods Collection', installDir: 'D:\\Y', steamAppId: '489520' }, OPTS);
  assert.strictEqual(r.source, 'appid');
  assert.strictEqual(path.basename(r.dir), 'Data');
});

t('AppID 1086940（博德之门3）→ AppData 下，不在游戏目录', () => {
  const r = M.resolveModDir({ name: 'Baldurs Gate 3', installDir: 'D:\\BG3', steamAppId: '1086940' }, OPTS);
  assert.ok(r.dir.includes('AppData'), `应在 AppData 下，实际 ${r.dir}`);
  assert.ok(!r.dir.startsWith('D:\\BG3'), '不应落在游戏安装目录里');
});

t('非法 AppID 不炸', () => {
  for (const bad of ['', 'abc', null, undefined, 0, -1]) {
    assert.strictEqual(M.ruleByAppId(bad), null);
  }
});

/* ---------------- 3. 不在游戏目录里的那些 ---------------- */
console.log('-- MOD 不在游戏安装目录里的游戏 --');

t('博德之门3 按名字 → %LOCALAPPDATA%', () => {
  const r = M.resolveModDir(G("Baldur's Gate 3"), OPTS);
  assert.strictEqual(r.source, 'name');
  assert.ok(r.dir.includes('Larian Studios'), r.dir);
  assert.ok(r.dir.includes('Mods'), r.dir);
});

t('我的世界 → %APPDATA%\\.minecraft\\mods', () => {
  const r = M.resolveModDir(G('Minecraft'), OPTS);
  assert.ok(r.dir.includes('.minecraft'), r.dir);
  assert.strictEqual(path.basename(r.dir), 'mods');
});

t('模拟农场25 → 文档\\My Games 下', () => {
  const r = M.resolveModDir(G('Farming Simulator 25'), OPTS);
  assert.ok(r.dir.includes('My Games'), r.dir);
  assert.ok(r.dir.includes('FarmingSimulator2025'), r.dir);
});

t('欧卡2 → 文档下，且是单数 mod（不是 mods）', () => {
  const r = M.resolveModDir(G('Euro Truck Simulator 2'), OPTS);
  assert.ok(r.dir.includes('Euro Truck Simulator 2'), r.dir);
  assert.strictEqual(path.basename(r.dir), 'mod', '欧卡是单数 mod');
});

t('僵尸毁灭工程 → 用户目录\\Zomboid\\mods', () => {
  const r = M.resolveModDir(G('Project Zomboid'), OPTS);
  assert.ok(r.dir.includes('Zomboid'), r.dir);
});

/* ---------------- 4. 反直觉的相对路径 ---------------- */
console.log('-- 路径反直觉的游戏 --');

t('赛博朋克2077 → archive/pc/mod', () => {
  const r = M.resolveModDir(G('Cyberpunk 2077'), OPTS);
  const tail = r.dir.replace(/^.*Cyberpunk 2077[\\/]/, '').replace(/\\/g, '/');
  assert.strictEqual(tail, 'archive/pc/mod', tail);
});

t('黑神话悟空 → b1/Content/Paks/~mods', () => {
  const r = M.resolveModDir(G('黑神话：悟空'), OPTS);
  assert.ok(r.dir.replace(/\\/g, '/').endsWith('b1/Content/Paks/~mods'), r.dir);
});

t('怪物猎人世界 → nativePC', () => {
  const r = M.resolveModDir(G('Monster Hunter: World'), OPTS);
  assert.strictEqual(path.basename(r.dir), 'nativePC');
});

t('骑马与砍杀2 → Modules（不是 Mods）', () => {
  const r = M.resolveModDir(G('Mount & Blade II: Bannerlord'), OPTS);
  assert.strictEqual(path.basename(r.dir), 'Modules');
});

t('无人深空 → GAMEDATA/PCBANKS/MODS', () => {
  const r = M.resolveModDir(G("No Man's Sky"), OPTS);
  assert.ok(r.dir.replace(/\\/g, '/').toUpperCase().endsWith('GAMEDATA/PCBANKS/MODS'), r.dir);
});

t('英灵神殿 → BepInEx/plugins', () => {
  const r = M.resolveModDir(G('Valheim'), OPTS);
  assert.ok(r.dir.replace(/\\/g, '/').endsWith('BepInEx/plugins'), r.dir);
});

t('巫师3 → Mods', () => {
  const r = M.resolveModDir(G('The Witcher 3: Wild Hunt'), OPTS);
  assert.strictEqual(path.basename(r.dir), 'Mods');
});

/* ---------------- 5. 常见通用情况 ---------------- */
console.log('-- 通用 Mods 目录 --');

for (const [name, expect] of [
  ['Stardew Valley', 'Mods'],
  ['Terraria', 'Mods'],
  ['RimWorld', 'Mods'],
  ['7 Days to Die', 'Mods'],
  ['Hollow Knight', 'Mods']
]) {
  t(`${name} → ${expect}`, () => {
    const r = M.resolveModDir(G(name), OPTS);
    assert.strictEqual(path.basename(r.dir), expect);
  });
}

t('城市天际线 → Files/Mods', () => {
  const r = M.resolveModDir(G('Cities: Skylines'), OPTS);
  assert.ok(r.dir.replace(/\\/g, '/').endsWith('Files/Mods'), r.dir);
});

/* ---------------- 6. 手动覆盖 ---------------- */
console.log('-- 用户手动覆盖 --');

t('传入 override 时一律听用户的', () => {
  const r = M.resolveModDir(G('Skyrim Special Edition'), { env: ENV, override: 'E:\\MyMods\\Skyrim' });
  assert.strictEqual(r.dir, 'E:\\MyMods\\Skyrim');
  assert.strictEqual(r.source, 'override');
});

t('override 优先级高于 AppID', () => {
  const r = M.resolveModDir(
    { name: 'X', installDir: 'D:\\X', steamAppId: '489520' },
    { env: ENV, override: 'Z:\\Whatever' }
  );
  assert.strictEqual(r.dir, 'Z:\\Whatever');
});

/* ---------------- 7. 兜底与异常 ---------------- */
console.log('-- 兜底与异常处理 --');

t('完全不认识的游戏 → 仍有候选（通用兜底）', () => {
  const r = M.resolveModDir(G('某个从没听过的独立游戏'), OPTS);
  assert.ok(r.candidates.length > 0, '至少该给出通用候选');
  assert.strictEqual(r.source, 'fallback');
});

t('没有安装目录时不炸', () => {
  const r = M.resolveModDir({ name: 'Skyrim' }, OPTS);
  assert.ok(r.ok || !r.ok);      // 只要不抛异常
});

t('空对象不炸', () => {
  const r = M.resolveModDir({}, OPTS);
  assert.ok(typeof r === 'object');
});

t('null / undefined 不炸', () => {
  assert.ok(typeof M.resolveModDir(null, OPTS) === 'object');
  assert.ok(typeof M.resolveModDir(undefined, OPTS) === 'object');
});

t('候选列表不重复', () => {
  const r = M.resolveModDir(G('Skyrim Special Edition'), OPTS);
  const lower = r.candidates.map((c) => c.dir.toLowerCase());
  assert.strictEqual(new Set(lower).size, lower.length, '候选里有重复路径');
});

/* ---------------- 8. 名字归一化 ---------------- */
console.log('-- 名字归一化 --');

t('全角冒号、™、多余空格都能匹配', () => {
  assert.strictEqual(path.basename(M.resolveModDir(G('上古卷轴5：天际'), OPTS).dir), 'Data');
  assert.strictEqual(path.basename(M.resolveModDir(G('The  Witcher™  3'), OPTS).dir), 'Mods');
  assert.strictEqual(path.basename(M.resolveModDir(G('SKYRIM SPECIAL EDITION'), OPTS).dir), 'Data');
});

t('别名（Steam 英文名）也参与匹配', () => {
  const r = M.resolveModDir({ name: '上古卷轴', altNames: ['The Elder Scrolls V: Skyrim'], installDir: 'D:\\S' }, OPTS);
  assert.strictEqual(path.basename(r.dir), 'Data');
});

/* ---------------- 9. 磁盘探测 ---------------- */
console.log('-- 磁盘探测（异步，单独跑）--');

(async () => {
  const tmp = path.join(os.tmpdir(), 'gamehub-modpaths-test');
  const gameDir = path.join(tmp, 'FakeGame');
  await require('fs/promises').mkdir(path.join(gameDir, 'Mods'), { recursive: true });
  await require('fs/promises').mkdir(path.join(gameDir, 'bin', 'x64'), { recursive: true });

  try {
    const found = await M.detectExisting(gameDir);
    t('能探测到已存在的 Mods 目录', () => {
      assert.ok(found.some((f) => path.basename(f.dir) === 'Mods'), JSON.stringify(found));
    });
    t('不存在的目录不会出现在探测结果里', () => {
      assert.ok(!found.some((f) => path.basename(f.dir) === 'Data'));
    });
    t('探测结果不重复', () => {
      const l = found.map((f) => f.dir.toLowerCase());
      assert.strictEqual(new Set(l).size, l.length);
    });
  } finally {
    await require('fs/promises').rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  // detectExisting 是 async，必须 await 再断言
  await ta('探测不存在的目录返回空数组', async () => {
    assert.deepStrictEqual(await M.detectExisting(''), []);
    assert.deepStrictEqual(await M.detectExisting(null), []);
    assert.deepStrictEqual(await M.detectExisting('D:\\根本不存在的目录'), []);
  });

  /* ---------------- 10. 规则表自身体检 ---------------- */
  console.log('-- 规则表体检 --');

  t('每条 BY_NAME 规则都有 keys / dir / scope', () => {
    for (const r of M.BY_NAME) {
      assert.ok(Array.isArray(r.keys) && r.keys.length, '缺少 keys');
      assert.ok(typeof r.dir === 'string' && r.dir, '缺少 dir');
      assert.ok(Object.values(M.SCOPE).includes(r.scope), `未知 scope: ${r.scope}`);
    }
  });

  t('每条 BY_NAME 规则都写了给用户看的说明', () => {
    for (const r of M.BY_NAME) {
      assert.ok(r.note && r.note.length > 5, `规则 ${r.keys[0]} 缺少说明`);
    }
  });

  t('BY_APPID 里每个条目都有合法 scope', () => {
    for (const [id, r] of Object.entries(M.BY_APPID)) {
      assert.ok(Object.values(M.SCOPE).includes(r.scope), `AppID ${id} 的 scope 不合法`);
      assert.ok(r.dir, `AppID ${id} 缺少 dir`);
    }
  });

  t('sourceLabel 覆盖所有来源', () => {
    for (const s of ['override', 'appid', 'name', 'fallback', 'detect', 'unknown']) {
      assert.ok(M.sourceLabel(s) && M.sourceLabel(s) !== s, `${s} 没有中文说明`);
    }
  });

  /* ---------------- 结果 ---------------- */
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log(`\n============================================`);
  console.log(`结果：通过 ${pass}，失败 ${fail}`);
  console.log(`============================================\n`);
  process.exitCode = fail ? 1 : 0;
})();
