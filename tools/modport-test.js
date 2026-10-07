/**
 * MOD 快速导入 / 打包 / MOD 码 测试  (tools/modport-test.js)
 *
 * 覆盖：
 *   - zipwrite：打包 → unzip.js 解压 → 逐文件比对（往返一致性）
 *   - modport：拖入规划（dir/zip/7z/冲突改名/非法字符）
 *   - mod 码：生成 → 解析往返、篡改检测、对比缺漏
 *
 * 纯 Node，不碰 Electron。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const zipwrite = require('../src/main/zipwrite');
const { extractZip } = require('../src/main/unzip');
const modport = require('../src/main/modport');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n      ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; failures.push(`${name}\n      ${e.message}`); }
}

async function main() {
  console.log('\n=========== MOD 快速导入 / 打包 / MOD 码 ===========\n');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gamehub-modport-'));

  /* ---------------- zipwrite 往返 ---------------- */
  console.log('-- ZIP 打包 ↔ 解压 往返 --');

  await ta('createZip 产出能被 unzip.js 原样解回（中文名 + 嵌套目录 + store）', async () => {
    const zip = zipwrite.createZip([
      { name: '我的Mod/说明.txt', data: Buffer.from('你好，MOD（中文内容）', 'utf8') },
      { name: '我的Mod/scripts/main.pex', data: Buffer.from(Buffer.from('binary-ish \x00\x01\x02 content')) },
      { name: '我的Mod/textures/老滚皮肤.dds', data: Buffer.alloc(1024, 7), store: true },
      { name: '空目录/', dir: true }
    ]);
    const zipPath = path.join(tmp, 'roundtrip.zip');
    await fsp.writeFile(zipPath, zip);

    const dest = path.join(tmp, 'roundtrip-out');
    await fsp.mkdir(dest, { recursive: true });
    const r = await extractZip(zipPath, dest);
    assert.ok(r && r.ok, '解压要成功：' + (r && r.error));

    const a = await fsp.readFile(path.join(dest, '我的Mod/说明.txt'), 'utf8');
    assert.strictEqual(a, '你好，MOD（中文内容）');
    const b = await fsp.readFile(path.join(dest, '我的Mod/scripts/main.pex'));
    assert.strictEqual(b.toString('hex'), Buffer.from('binary-ish \x00\x01\x02 content').toString('hex'));
    const c = await fsp.stat(path.join(dest, '我的Mod/textures/老滚皮肤.dds'));
    assert.strictEqual(c.size, 1024);
    const d = await fsp.stat(path.join(dest, '空目录'));
    assert.ok(d.isDirectory(), '目录条目要被还原成目录');
  });

  await ta('createZipFromPaths：两个 mod 目录各自占一个顶层名字，同名自动加后缀', async () => {
    const srcA = path.join(tmp, 'srcA');
    const srcB = path.join(tmp, 'srcB');
    await fsp.mkdir(path.join(srcA, 'data'), { recursive: true });
    await fsp.mkdir(srcB, { recursive: true });
    await fsp.writeFile(path.join(srcA, 'data', 'a.txt'), 'A-content');
    await fsp.writeFile(path.join(srcB, 'a.txt'), 'B-content');

    const buf = await zipwrite.createZipFromPaths([
      { srcPath: srcA, topName: '同一个名' },
      { srcPath: srcB, topName: '同一个名' }
    ]);
    const zipPath = path.join(tmp, 'two-mods.zip');
    await fsp.writeFile(zipPath, buf);
    const entries = require('../src/main/unzip').listZipFromBuffer(buf).map((e) => e.name);
    assert.ok(entries.some((n) => n.startsWith('同一个名/')), '第一个用原名');
    assert.ok(entries.some((n) => n.startsWith('同一个名 (2)/')), '第二个自动加 (2)');
    assert.ok(!entries.some((n) => n.startsWith('同一个名 (3)')), '不该出现 (3)');
  });

  await ta('storeExts：图片按 store 存（不二次压缩，更快）', async () => {
    const png = Buffer.alloc(2048, 0x89);
    const zip = zipwrite.createZip([{ name: 'x.png', data: png, store: true }]);
    const comp = zip.length;
    // store 模式下 zip 总大小 ≈ 数据大小 + 头；若被 deflate 压缩 2048 个相同字节会小很多
    assert.ok(comp > 2000, 'store 的条目不该被压小，实际 zip=' + comp);
  });

  /* ---------------- 拖入规划 ---------------- */
  console.log('-- 拖入规划 --');

  t('dir → copy；zip → unzip；7z/rar → skip 带原因', () => {
    assert.strictEqual(modport.planDrop({ name: '炫酷武器包', kind: 'dir' }).action, 'copy');
    assert.strictEqual(modport.planDrop({ name: '炫酷武器包.zip', kind: 'zip' }).action, 'unzip');
    const r = modport.planDrop({ name: '大包.7z', kind: 'file' });
    assert.strictEqual(r.action, 'skip');
    assert.ok(/zip/.test(r.reason), '拒绝原因要说明支持什么');
    const r2 = modport.planDrop({ name: '老包.rar', kind: 'file' });
    assert.strictEqual(r2.action, 'skip');
  });

  t('targetName 去掉压缩包扩展名 + 清洗非法字符', () => {
    const r = modport.planDrop({ name: '武器包(带:冒号).zip', kind: 'zip' });
    assert.ok(!r.targetName.includes(':'), 'Windows 非法字符要被换掉：' + r.targetName);
    assert.ok(!/\.zip$/i.test(r.targetName), '解压导入的名字不该带 .zip');
  });

  t('planDropAll：重名自动加后缀，绝不静默覆盖', () => {
    const plans = modport.planDropAll(
      [
        { name: '同一个mod.zip', kind: 'zip' },       // 与目录里已有的撞 → 让位
        { name: '同一个mod (1).zip', kind: 'zip' },   // 自己的名字本来就没人占 → 原样保留
        { name: '同一个mod (2).zip', kind: 'zip' }    // 恰好和第一项让位后的名字撞 → 再让
      ],
      ['同一个mod']
    );
    const targets = plans.map((p) => p.targetName);
    assert.deepStrictEqual(targets, ['同一个mod (2)', '同一个mod (1)', '同一个mod (2) (2)']);
    // 三项互不相同，且都不和目录里已有的撞
    assert.strictEqual(new Set(targets.map((s) => s.toLowerCase())).size, 3);
    assert.ok(!targets.includes('同一个mod'));
  });

  /* ---------------- MOD 码 ---------------- */
  console.log('-- MOD 码 --');

  t('生成 → 解析往返一致，名称被排序去重（码点序，跨机器稳定）', () => {
    const code = modport.buildModCode(['僵尸MOD', '  僵尸MOD ', '武器包', '皮肤']);
    const p = modport.parseModCode(code);
    assert.ok(p, '要能解析');
    assert.strictEqual(p.count, 3, '重复与空白要被清掉');
    assert.deepStrictEqual(p.names, ['僵尸MOD', '武器包', '皮肤'].sort());
    assert.ok(code.startsWith('GHMOD1-3-'), '数量要写在码里：' + code.slice(0, 20));
  });

  t('同一个 mod 集永远生成同一个码（顺序无关）', () => {
    const a = modport.buildModCode(['a', 'b', 'c']);
    const b = modport.buildModCode(['c', 'b', 'a']);
    assert.strictEqual(a, b);
  });

  t('篡改 / 截断 / 乱写的码都拒绝', () => {
    const code = modport.buildModCode(['a', 'b']);
    // 改 base64 段中间一个字符（⚠ 尾字符可能落在 base64 的填充位，改了也不影响解码字节）
    const mid = Math.floor(code.length / 2);
    const flipped = code.slice(0, mid) + (code[mid] === 'x' ? 'y' : 'x') + code.slice(mid + 1);
    assert.notStrictEqual(flipped, code);
    assert.strictEqual(modport.parseModCode(flipped), null, '改 payload 要被 CRC 抓到');
    // 直接把 CRC 段改成错的也要抓到
    const crcTampered = code.replace(/^GHMOD1-(\d+)-[0-9a-f]{8}-/, (m, c) => `GHMOD1-${c}-00000000-`);
    assert.strictEqual(modport.parseModCode(crcTampered), null, '改 CRC 段要拒绝');
    assert.strictEqual(modport.parseModCode(code.slice(0, code.length - 5)), null, '截断要拒绝');
    assert.strictEqual(modport.parseModCode('随便一串文字'), null);
    assert.strictEqual(modport.parseModCode(''), null);
    assert.strictEqual(modport.parseModCode(null), null);
  });

  t('diffModCode：缺的、多的各归各', () => {
    const code = modport.buildModCode(['核心框架', '武器包', '皮肤包']);
    const r = modport.diffModCode(code, ['核心框架', '皮肤包', '多余的光效']);
    assert.deepStrictEqual(r.missing, ['武器包'], '码里有、本地没有 = 缺');
    assert.deepStrictEqual(r.extra, ['多余的光效'], '本地有、码里没有 = 多');
    assert.deepStrictEqual(r.same, ['核心框架', '皮肤包']);
    assert.strictEqual(r.total, 3);
  });

  t('对比忽略大小写 / 全角括号 / 多余空格', () => {
    const code = modport.buildModCode(['SkyUI (中文版)']);
    const r = modport.diffModCode(code, ['skyui （中文版） ']);
    assert.deepStrictEqual(r.missing, []);
    assert.deepStrictEqual(r.extra, []);
    assert.strictEqual(r.same.length, 1);
  });

  t('空码 / 空列表也能对（都空 = 全对上）', () => {
    const code = modport.buildModCode([]);
    assert.ok(code.startsWith('GHMOD1-0-'));
    const r = modport.diffModCode(code, []);
    assert.deepStrictEqual(r.missing, []);
    assert.deepStrictEqual(r.extra, []);
  });

  /* ---------------- 收尾 ---------------- */
  console.log(`\n==================================================`);
  console.log(`结果：通过 ${pass}，失败 ${fail}`);
  console.log(`==================================================`);
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试执行失败:', e); process.exit(1); });
