/**
 * ============================================================
 *  GameHub - MOD 管理：端到端集成测试  (tools/mods-test.js)
 * ------------------------------------------------------------
 *  为什么不能只测纯函数：
 *    上一轮 Epic 那次事故，108 项纯函数测试全绿，功能却是坏的 ——
 *    因为坏在两处代码的**约定**上（一个存 Map 用的键，一个查 Map 用的键）。
 *    纯函数测试喂进去的都是理想数据，正好把那条缝绕开了。
 *
 *  所以这里搭一套**真的东西**：
 *    · 真的临时目录，真的 Steam 库结构，真的 appworkshop.acf
 *    · 真的起一个 HTTP 服务当创意工坊接口，真的发请求、真的解析
 *    · 真的调 createMods() 去 list / 改名 / 添加 / 删除
 *  只把"外部世界"（Steam 的服务器）换成可控的，其余一律走真代码。
 *
 *  跑法： node tools/mods-test.js
 * ============================================================
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');

const MODS = require('../src/main/mods');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; failures.push(name); }
}

/* ------------------------------------------------------------------
 *  搭环境
 * ------------------------------------------------------------------ */

const ROOT = path.join(os.tmpdir(), 'gamehub-modtest');
const DATA = path.join(ROOT, 'data');
const STEAM = path.join(ROOT, 'steam');
const GAME = path.join(ROOT, 'game');

/** 两个假的创意工坊条目 id（真的 id 只在这台机器上存在，测试里自造） */
const WS_A = '1000000001';
const WS_B = '1000000002';
const WS_GONE = '1000000003';      // 工坊那边查不到（result=9）

/** 模拟接口返回的"真实形状"数据 */
const API_DB = {
  [WS_A]: {
    title: 'Bigger World', tags: ['Maps', 'Gameplay'],
    preview_url: 'https://cdn.example/big.jpg', time_updated: 1700000000, file_size: 5242880
  },
  [WS_B]: {
    title: 'Rocket Mouse Fix', tags: ['Bug Fixes'],
    preview_url: 'https://cdn.example/fix.jpg', time_updated: 1700000500, file_size: 2048
  }
};

/** 接口的可控行为开关 */
const apiCtl = { mode: 'ok', hits: 0, lastBody: '' };

function buildApiResponse(ids) {
  return {
    response: {
      publishedfiledetails: ids.map((id) => {
        const d = API_DB[id];
        // 查不到的就回 result=9 —— 跟真接口的行为一致
        if (!d) return { publishedfileid: id, result: 9 };
        return {
          publishedfileid: id, result: 1, ...d,
          tags: d.tags.map((tag) => ({ tag }))
        };
      })
    }
  };
}

let server = null;
let serverPort = 0;

function startApiServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        apiCtl.hits++;
        apiCtl.lastBody = body;

        if (apiCtl.mode === 'down') { res.writeHead(500); res.end('nope'); return; }
        if (apiCtl.mode === 'garbage') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>这不是 JSON</html>');
          return;
        }
        // 真的按表单体里的 publishedfileids[N] 取 id，不靠猜
        const q = new URLSearchParams(body);
        const ids = [];
        for (let i = 0; i < Number(q.get('itemcount') || 0); i++) {
          ids.push(q.get(`publishedfileids[${i}]`));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildApiResponse(ids)));
      });
    });
    server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); });
  });
}

/** 建目录（带内容，好让体积不是 0） */
async function mkdirWith(dir, file, content = 'x'.repeat(100)) {
  await fsp.mkdir(dir, { recursive: true });
  if (file) await fsp.writeFile(path.join(dir, file), content);
}

async function setup() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(DATA, { recursive: true });

  /* ---- Steam 库结构 ---- */
  const wsContent = path.join(STEAM, 'steamapps', 'workshop', 'content', '1206560');
  await mkdirWith(path.join(wsContent, WS_A), 'map.dat', 'a'.repeat(4096));
  await mkdirWith(path.join(wsContent, WS_B), 'patch.dll', 'b'.repeat(2048));
  // 被禁用过的条目：目录名带后缀，扫描时必须认出这是"已禁用"并且名字还原
  await mkdirWith(path.join(wsContent, WS_GONE + MODS.DISABLED_SUFFIX), 'mod.pak', 'c'.repeat(512));

  await fsp.writeFile(
    path.join(STEAM, 'steamapps', 'workshop', 'appworkshop_1206560.acf'),
    '"AppWorkshop"\n{\n\t"appid"\t\t"1206560"\n'
    + '\t"WorkshopItemsInstalled"\n\t{\n'
    + `\t\t"${WS_A}"\n\t\t{\n\t\t\t"size"\t\t"4096"\n\t\t\t"timeupdated"\t\t"1700000000"\n\t\t}\n`
    + `\t\t"${WS_B}"\n\t\t{\n\t\t\t"size"\t\t"2048"\n\t\t\t"timeupdated"\t\t"1700000500"\n\t\t}\n`
    + '\t}\n}', 'utf8');

  /* ---- 游戏自带的 mods 目录 ---- */
  await mkdirWith(path.join(GAME, 'mods', 'Mod Alpha'), 'alpha.pak', 'A'.repeat(3000));
  await mkdirWith(path.join(GAME, 'mods', 'Mod Beta'), 'beta.pak', 'B'.repeat(1500));
  await fsp.writeFile(path.join(GAME, 'mods', 'desktop.ini'), 'junk');   // 必须被忽略
  await mkdirWith(path.join(GAME, 'mods', 'Mod Gamma' + MODS.DISABLED_SUFFIX), 'g.pak', 'G'.repeat(800));
  // 干扰项：不在 MOD 目录名单里的文件夹，绝不能被当成 MOD
  await mkdirWith(path.join(GAME, 'bin'), 'game.exe', 'MZ');
}

function makeManager() {
  return MODS.createMods({
    dataDir: DATA,
    steamLibraries: [STEAM],                                  // 别去扫 26 个盘符
    workshopApi: `http://127.0.0.1:${serverPort}/`,           // 指向本地假接口
    onLog: () => {}
  });
}

/** 游戏对象：Steam 游戏（有 AppID，能去创意工坊） */
const steamGame = () => ({
  id: 'g-steam', name: 'WorldBox', steamAppId: '1206560', installDir: GAME
});
/** 游戏对象：非 Steam 游戏（只能自己加） */
const localGame = () => ({ id: 'g-local', name: '某单机游戏', steamAppId: '', installDir: GAME });

const byTitle = (list, title) => list.find((m) => m.title === title);

/* ==================================================================
 *  跑
 * ================================================================== */
(async () => {
  console.log('\n[MOD] 端到端集成测试');
  await setup();
  await startApiServer();
  const mods = makeManager();

  /* ---------------- 发现 ---------------- */
  console.log('\n  发现与元数据');

  let r = null;
  await t('能同时扫出创意工坊条目 + 游戏自带 MOD 目录', async () => {
    r = await mods.list(steamGame());
    assert.ok(r.ok, 'list 必须成功');
    const titles = r.mods.map((m) => m.title);
    assert.ok(titles.includes('Bigger World'), '创意工坊的条目要能列出来');
    assert.ok(titles.includes('Mod Alpha'), '游戏自带 mods 目录里的也要能列出来');
    assert.ok(titles.includes('Mod Beta'));
    assert.strictEqual(r.counts.total, 6, `应该是 2 工坊启用 + 1 工坊禁用 + 3 本地 = 6，实际 ${r.counts.total}：${titles}`);
  });

  await t('dir 里的 desktop.ini 之类的垃圾不会被当成 MOD', async () => {
    assert.ok(!r.mods.some((m) => /desktop\.ini/i.test(m.title)), '系统垃圾文件必须被过滤');
    assert.ok(!r.mods.some((m) => m.title === 'bin'), '不在 MOD 目录名单里的文件夹不能被当成 MOD');
  });

  await t('★ 创意工坊的名字来自接口，不是一串数字 id', async () => {
    const a = byTitle(r.mods, 'Bigger World');
    assert.ok(a, '接口给了 title，列表里就必须是它');
    assert.strictEqual(a.kind, 'workshop');
    assert.strictEqual(a.workshopId, WS_A);
    assert.ok(!/^\d+$/.test(a.title), '绝不能把 id 直接当名字显示');
  });

  await t('★ 标签取回来了，二级分类因此能成立', async () => {
    const a = byTitle(r.mods, 'Bigger World');
    assert.deepStrictEqual(a.tags, ['Maps', 'Gameplay']);
    assert.deepStrictEqual(r.tags.sort(), ['Bug Fixes', 'Gameplay', 'Maps'].sort());
    assert.strictEqual(r.tagCounts['Maps'], 1);
  });

  await t('★ 分组正确：本地 MOD 和无标签的工坊条目各归各的兜底桶', async () => {
    const tags = r.groups.map((g) => g.tag);
    assert.ok(tags.includes('Maps') && tags.includes('Bug Fixes'));
    // 两个兜底桶都要排在真标签后面
    const firstPseudo = tags.findIndex((x) => x === MODS.UNTAGGED_WORKSHOP || x === MODS.UNTAGGED_LOCAL);
    assert.ok(firstPseudo > 0, '兜底桶不该排在最前面');
    assert.ok(tags.slice(firstPseudo).every((x) => x === MODS.UNTAGGED_WORKSHOP || x === MODS.UNTAGGED_LOCAL),
      '兜底桶必须全部垫底');

    const localBucket = r.groups.find((g) => g.tag === MODS.UNTAGGED_LOCAL);
    assert.deepStrictEqual(localBucket.mods.map((m) => m.title).sort(),
      ['Mod Alpha', 'Mod Beta', 'Mod Gamma'].sort(), '本地 MOD 归「本地 MOD」');
    // WS_GONE 是工坊条目但接口查不到，没有标签 —— 它必须归"创意工坊 · 无标签"，
    // 而不是混进"本地 MOD"里（那会让用户以为识别错了来源）
    const wsBucket = r.groups.find((g) => g.tag === MODS.UNTAGGED_WORKSHOP);
    assert.strictEqual(wsBucket.mods.length, 1);
    assert.strictEqual(wsBucket.mods[0].kind, 'workshop');
  });

  await t('体积：文件夹型 MOD 也要有大小（大部分 MOD 是文件夹）', async () => {
    const a = byTitle(r.mods, 'Bigger World');
    assert.strictEqual(a.sizeBytes, 4096, 'acf 里的 size 要能读出来');
    const alpha = byTitle(r.mods, 'Mod Alpha');
    assert.strictEqual(alpha.sizeBytes, 3000, '本地文件夹 MOD 要真的递归算体积，不能是 0');
  });

  await t('★ 目录名带禁用后缀 = 已禁用，且显示名要还原干净', async () => {
    const gone = r.mods.find((m) => m.workshopId === WS_GONE);
    assert.ok(gone, '带 .gamehub-disabled 后缀的条目也要列出来（不然用户没法启用它）');
    assert.strictEqual(gone.enabled, false, '后缀在 = 已禁用');
    assert.strictEqual(gone.baseName, WS_GONE, 'baseName 要是不带后缀的原名，启用时靠它改回去');

    const gamma = r.mods.find((m) => m.baseName === 'Mod Gamma');
    assert.ok(gamma, '本地 MOD 同理');
    assert.strictEqual(gamma.title, 'Mod Gamma', '显示名里不能出现 .gamehub-disabled 这种技术后缀');
    assert.strictEqual(gamma.enabled, false);
  });

  await t('接口查不到的条目会退化成"创意工坊项目 <id>"，不会变成空名字', async () => {
    const gone = r.mods.find((m) => m.workshopId === WS_GONE);
    assert.ok(/创意工坊项目/.test(gone.title), '拿不到标题时至少要给一个能看的占位');
  });

  await t('接口确实被调到了，而且 id 是按下标规范传的', async () => {
    assert.ok(apiCtl.hits > 0, '必须真的发过请求');
    // 表单体是 URL 编码过的，要解出来再查（%5B0%5D → [0]）
    const q = new URLSearchParams(apiCtl.lastBody);
    assert.ok(q.get('publishedfileids[0]'), '下标形式不能拼错');
    assert.ok(Number(q.get('itemcount')) > 0, 'itemcount 必须和 id 个数对得上');
  });

  /* ---------------- 启用 / 禁用 ---------------- */
  console.log('\n  启用 / 禁用（真的改磁盘上的名字）');

  await t('★ 禁用：磁盘上目录真的被改名了', async () => {
    const a = byTitle(r.mods, 'Bigger World');
    const res = await mods.setEnabled(a, false);
    assert.ok(res.ok, '禁用要成功：' + (res.error || ''));
    assert.strictEqual(res.enabled, false);

    const dir = path.join(STEAM, 'steamapps', 'workshop', 'content', '1206560');
    const names = await fsp.readdir(dir);
    assert.ok(names.includes(WS_A + MODS.DISABLED_SUFFIX), '目录名必须真的带上禁用后缀');
    assert.ok(!names.includes(WS_A), '原名不能再存在');
  });

  await t('★ 禁用后重新 list：状态跟着磁盘走，不是靠内存记的', async () => {
    const r2 = await mods.list(steamGame());
    const a = byTitle(r2.mods, 'Bigger World');
    assert.ok(a, '禁用之后仍然要列出来（用户还得能点回去启用）');
    assert.strictEqual(a.enabled, false, '状态必须反映磁盘的真实情况');
    assert.strictEqual(r2.counts.disabled, 3, 'WS_A + WS_GONE + Mod Gamma');
  });

  await t('★ 启用：名字一字不差地改回原样（来回一趟不能有损耗）', async () => {
    const r2 = await mods.list(steamGame());
    const a = byTitle(r2.mods, 'Bigger World');
    const res = await mods.setEnabled(a, true);
    assert.ok(res.ok, '启用要成功：' + (res.error || ''));

    const dir = path.join(STEAM, 'steamapps', 'workshop', 'content', '1206560');
    const names = await fsp.readdir(dir);
    assert.ok(names.includes(WS_A), '必须精确还原成最初那个名字');
    assert.ok(!names.includes(WS_A + MODS.DISABLED_SUFFIX));

    const r3 = await mods.list(steamGame());
    assert.strictEqual(byTitle(r3.mods, 'Bigger World').enabled, true);
  });

  await t('重复禁用是幂等的（不会变成 xxx.disabled.disabled）', async () => {
    const r2 = await mods.list(steamGame());
    const g = r2.mods.find((m) => m.baseName === 'Mod Gamma');
    const res = await mods.setEnabled(g, false);
    assert.ok(res.ok);
    assert.ok(res.unchanged, '本来就是禁用的，应该直接报"没变化"而不是再改一次名');
    const names = await fsp.readdir(path.join(GAME, 'mods'));
    assert.ok(names.includes('Mod Gamma' + MODS.DISABLED_SUFFIX));
    assert.ok(!names.some((n) => n.includes(MODS.DISABLED_SUFFIX + MODS.DISABLED_SUFFIX)));
  });

  await t('对不存在的路径动手 → 给出人话错误，不抛异常', async () => {
    const res = await mods.setEnabled({ path: path.join(ROOT, '不存在的东西') }, false);
    assert.strictEqual(res.ok, false);
    assert.ok(/刷新|不在/.test(res.error), '错误里要说清是"文件没了"，而不是甩一个 ENOENT');
  });

  /* ---------------- 手动添加 ---------------- */
  console.log('\n  手动添加 / 摘除');

  await t('★ 非 Steam 游戏也能自己把 MOD 加进来', async () => {
    const extra = path.join(ROOT, 'external', '超好看的皮肤包');
    await mkdirWith(extra, 'skin.dds', 'S'.repeat(700));

    const add = await mods.addManual('g-local', extra);
    assert.ok(add.ok, '手动添加要成功：' + (add.error || ''));

    const rl = await mods.list(localGame());
    const m = rl.mods.find((x) => x.path === extra);
    assert.ok(m, '加进来的 MOD 必须出现在列表里');
    assert.strictEqual(m.title, '超好看的皮肤包');
    assert.strictEqual(m.manual, true, '要标出来它是手动加的');
    assert.ok(m.source.includes('手动'), '来源要写清楚，用户才知道它是哪来的');
  });

  await t('重复添加同一个 → 拒绝并说明，不是默默加两条', async () => {
    const extra = path.join(ROOT, 'external', '超好看的皮肤包');
    const again = await mods.addManual('g-local', extra);
    assert.strictEqual(again.ok, false);
    assert.ok(/已经在/.test(again.error));
  });

  await t('手动加的 MOD 也能启用/禁用', async () => {
    const rl = await mods.list(localGame());
    const m = rl.mods.find((x) => x.manual);
    const res = await mods.setEnabled(m, false);
    assert.ok(res.ok, res.error);
    const names = await fsp.readdir(path.join(ROOT, 'external'));
    assert.ok(names.includes('超好看的皮肤包' + MODS.DISABLED_SUFFIX));
    await mods.setEnabled({ path: res.path }, true);   // 还原，别影响后面的断言
  });

  await t('forget 只把它从列表里拿掉，磁盘文件一个都不能动', async () => {
    const extra = path.join(ROOT, 'external', '超好看的皮肤包');
    mods.forgetManual('g-local', extra);
    assert.ok(fs.existsSync(extra), 'forget 绝不能删文件');
    const rl = await mods.list(localGame());
    assert.ok(!rl.mods.some((x) => x.manual), '列表里不该再有它');
  });

  await t('磁盘上被删掉的手动记录会自动消失（不留点不动的幽灵条目）', async () => {
    const ghost = path.join(ROOT, 'external', '会被删掉的');
    await mkdirWith(ghost, 'x.pak');
    await mods.addManual('g-local', ghost);
    await fsp.rm(ghost, { recursive: true, force: true });
    const rl = await mods.list(localGame());
    assert.ok(!rl.mods.some((x) => x.path === ghost), '文件都没了就不该还列在那儿');
  });

  /* ---------------- 缓存与降级 ---------------- */
  console.log('\n  缓存与断网降级');

  await t('★ 接口挂掉时：名字从缓存里拿，列表照样完整', async () => {
    apiCtl.mode = 'down';
    // 换一个全新的实例，逼它重读缓存文件（模拟"重启程序 + 网断了"）
    const m2 = MODS.createMods({
      dataDir: DATA, steamLibraries: [STEAM],
      workshopApi: `http://127.0.0.1:${serverPort}/`, onLog: () => {}
    });
    const r2 = await m2.list(steamGame());
    assert.ok(r2.ok);
    assert.ok(byTitle(r2.mods, 'Bigger World'), '缓存过标题的条目，断网也该显示真名字');
    assert.ok(byTitle(r2.mods, 'Mod Alpha'), '本地 MOD 跟联网毫无关系，必须一个不少');
  });

  await t('★ 接口返回垃圾数据时不崩，并且**明确告诉用户**名字可能不全', async () => {
    apiCtl.mode = 'garbage';
    const m3 = MODS.createMods({
      dataDir: path.join(ROOT, 'data-fresh'),   // 空缓存，逼它真的去请求
      steamLibraries: [STEAM],
      workshopApi: `http://127.0.0.1:${serverPort}/`, onLog: () => {}
    });
    const r3 = await m3.list(steamGame());
    assert.ok(r3.ok, '接口坏了不能把整个列表拖垮');
    assert.ok(r3.mods.length >= 6, '本地能扫出来的东西一个都不能少');
    assert.ok(r3.note, '必须给出一条说明 —— 用户看到一串 id 得知道是为什么');
    assert.ok(/创意工坊|接口/.test(r3.note), '说明里要点出是创意工坊那边的问题');
    assert.ok(r3.mods.every((m) => m.title), '就算降级，也不能出现没有名字的条目');
  });

  /* ---------------- 删除的安全闸 ---------------- */
  console.log('\n  删除的安全闸');

  await t('★ 关键目录一律拒绝（上层传错路径时的最后一道闸）', async () => {
    for (const bad of [
      path.join(STEAM, 'steamapps', 'workshop'),
      path.join(STEAM, 'steamapps'),
      path.join(STEAM, 'steamapps', 'common')
    ]) {
      await fsp.mkdir(bad, { recursive: true }).catch(() => {});
      const res = await mods.remove({ path: bad });
      assert.strictEqual(res.ok, false, `${bad} 这种关键目录必须拒绝`);
      assert.ok(/关键目录/.test(res.error));
    }
  });

  await t('对已经不存在的路径动手 → 当成"已经删过了"，不报错', async () => {
    const res = await mods.remove({ path: path.join(ROOT, '压根没有') });
    assert.ok(res.ok && res.alreadyGone);
  });

  await t('非 Electron 环境下会如实说"进不了回收站"，而不是偷偷真删', async () => {
    const target = path.join(GAME, 'mods', 'Mod Beta');
    const res = await mods.remove({ path: target });
    // 跑在纯 Node 里，没有 electron.shell.trashItem
    assert.strictEqual(res.ok, false);
    assert.ok(/回收站/.test(res.error), '错误信息要说明是回收站不可用');
    assert.ok(fs.existsSync(target), '★ 兜底失败时绝不能把文件删掉');
  });

  /* ---------------- 非 Steam 游戏 ---------------- */
  console.log('\n  非 Steam 游戏');

  await t('非 Steam 游戏不会去扫 Steam 工坊，只列本地 MOD', async () => {
    // 断掉接口，确保它没偷偷去请求
    apiCtl.mode = 'down';
    const before = apiCtl.hits;
    const rl = await mods.list(localGame());
    assert.strictEqual(apiCtl.hits, before, '没有 steamAppId 就压根不该去请求创意工坊');
    assert.ok(rl.mods.every((m) => m.kind !== 'workshop'), '不能出现创意工坊条目');
    assert.ok(rl.mods.some((m) => m.title === 'Mod Alpha'), '本地的还是要列出来');
  });

  await t('没有 Steam 库时也不崩（empty 路径）', async () => {
    const m4 = MODS.createMods({ dataDir: path.join(ROOT, 'd4'), steamLibraries: [], onLog: () => {} });
    const r4 = await m4.list({ id: 'x', name: 'X', steamAppId: '999999', installDir: GAME });
    assert.ok(r4.ok);
    assert.ok(r4.mods.some((m) => m.title === 'Mod Alpha'), 'Steam 那边什么都没有，本地照样要列');
  });

  /* ---------------- 收尾 ---------------- */
  server.close();
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试自身崩了：', e.stack);
  process.exit(1);
});
