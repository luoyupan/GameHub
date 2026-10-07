/**
 * ZIP 解压模块测试  (tools/unzip-test.js)
 *
 * 重点验证两件事：
 *   ① 真能解出文件（含中文名、含目录结构）
 *   ② **Zip Slip 路径穿越必须被拒绝** —— 这是安全底线，
 *      恶意压缩包可以用 ../../ 把文件写到游戏目录之外
 *
 * 用法： node tools/unzip-test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const U = require('../src/main/unzip');

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

/* ---------- 手工构造一个 zip（不依赖任何压缩工具）---------- */
/**
 * @param {Array<{name:string, data:Buffer|string, method?:0|8}>} files
 */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const method = f.method === undefined ? 8 : f.method;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version
    local.writeUInt16LE(0x800, 6);         // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0, 12);            // date
    local.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len

    locals.push(Buffer.concat([local, nameBuf, body]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const localAll = Buffer.concat(locals);
  const centralAll = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralAll.length, 12);
  end.writeUInt32LE(localAll.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localAll, centralAll, end]);
}

/** 简易 crc32（老 Node 没有 zlib.crc32 时用） */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ (-1)) >>> 0;
}

(async () => {
  console.log('\n=========== ZIP 解压模块测试 ===========\n');
  const tmp = path.join(os.tmpdir(), 'gamehub-unzip-test');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(tmp, { recursive: true });

  try {
    /* ---------------- 1. 基本解压 ---------------- */
    console.log('-- 基本解压 --');

    await ta('能解出单个文件', async () => {
      const zip = path.join(tmp, 'a.zip');
      await fsp.writeFile(zip, buildZip([{ name: 'mod/hello.txt', data: 'hi there' }]));
      const out = path.join(tmp, 'out-a');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok, r.error);
      assert.strictEqual(r.files.length, 1);
      assert.strictEqual(await fsp.readFile(path.join(out, 'mod', 'hello.txt'), 'utf8'), 'hi there');
    });

    await ta('能还原目录结构', async () => {
      const zip = path.join(tmp, 'b.zip');
      await fsp.writeFile(zip, buildZip([
        { name: 'MyMod/', data: '' },
        { name: 'MyMod/a.txt', data: 'A' },
        { name: 'MyMod/sub/b.txt', data: 'B' }
      ]));
      const out = path.join(tmp, 'out-b');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok);
      assert.strictEqual(await fsp.readFile(path.join(out, 'MyMod', 'sub', 'b.txt'), 'utf8'), 'B');
    });

    await ta('store（不压缩）方式也能解', async () => {
      const zip = path.join(tmp, 'c.zip');
      await fsp.writeFile(zip, buildZip([{ name: 'plain.txt', data: 'no compress', method: 0 }]));
      const out = path.join(tmp, 'out-c');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok, r.error);
      assert.strictEqual(await fsp.readFile(path.join(out, 'plain.txt'), 'utf8'), 'no compress');
    });

    await ta('中文文件名正确（UTF-8 标记）', async () => {
      const zip = path.join(tmp, 'd.zip');
      await fsp.writeFile(zip, buildZip([{ name: '高清材质包/说明.txt', data: '中文内容' }]));
      const out = path.join(tmp, 'out-d');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok);
      assert.ok(r.files.some((f) => f.includes('说明.txt')), JSON.stringify(r.files));
    });

    /* ---------------- 2. 安全：Zip Slip ---------------- */
    console.log('-- 安全：路径穿越 --');

    await ta('拒绝 ../ 往上跳的条目', async () => {
      const zip = path.join(tmp, 'evil1.zip');
      await fsp.writeFile(zip, buildZip([{ name: '../../../../evil.txt', data: 'pwned' }]));
      const out = path.join(tmp, 'out-evil1');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok);
      assert.strictEqual(r.files.length, 0, '不该写出任何文件');
      assert.ok(r.skipped.length > 0, '应记为跳过');
    });

    await ta('拒绝绝对路径（盘符）', async () => {
      const zip = path.join(tmp, 'evil2.zip');
      await fsp.writeFile(zip, buildZip([{ name: 'C:\\Windows\\evil.txt', data: 'pwned' }]));
      const out = path.join(tmp, 'out-evil2');
      const r = await U.extractZip(zip, out);
      assert.strictEqual(r.files.length, 0);
    });

    await ta('safeJoin 直接判定也正确', () => {
      const root = path.resolve('D:\\Game\\Mods');
      assert.ok(U.safeJoin(root, 'a/b.txt', false));
      assert.strictEqual(U.safeJoin(root, '../x.txt', false), null);
      assert.strictEqual(U.safeJoin(root, 'a/../../x.txt', false), null);
      assert.strictEqual(U.safeJoin(root, '/etc/passwd', false), null);
      assert.strictEqual(U.safeJoin(root, 'C:\\x.txt', false), null);
    });

    await ta('恶意包不会写到目标目录之外', async () => {
      const zip = path.join(tmp, 'evil3.zip');
      await fsp.writeFile(zip, buildZip([
        { name: 'ok.txt', data: 'fine' },
        { name: '../../outside.txt', data: 'bad' }
      ]));
      const out = path.join(tmp, 'out-evil3');
      const r = await U.extractZip(zip, out);
      assert.ok(fs.existsSync(path.join(out, 'ok.txt')), '正常的该解出来');
      assert.ok(!fs.existsSync(path.join(tmp, 'outside.txt')), '不该写到外面');
    });

    /* ---------------- 3. 边界与异常 ---------------- */
    console.log('-- 边界与异常 --');

    await ta('空 zip 明确报错', async () => {
      const zip = path.join(tmp, 'empty.zip');
      await fsp.writeFile(zip, Buffer.alloc(0));
      const r = await U.extractZip(zip, path.join(tmp, 'out-empty'));
      assert.strictEqual(r.ok, false);
      assert.ok(r.error);
    });

    await ta('不是 zip 的文件明确报错', async () => {
      const zip = path.join(tmp, 'notzip.bin');
      await fsp.writeFile(zip, 'this is definitely not a zip file at all');
      const r = await U.extractZip(zip, path.join(tmp, 'out-notzip'));
      assert.strictEqual(r.ok, false);
    });

    await ta('目标目录不存在时自动创建', async () => {
      const zip = path.join(tmp, 'e.zip');
      await fsp.writeFile(zip, buildZip([{ name: 'x.txt', data: 'X' }]));
      const out = path.join(tmp, 'deep', 'deeper', 'out-e');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok);
      assert.ok(fs.existsSync(path.join(out, 'x.txt')));
    });

    await ta('listZip 能列出条目', async () => {
      const zip = path.join(tmp, 'f.zip');
      await fsp.writeFile(zip, buildZip([
        { name: 'a.txt', data: 'A' },
        { name: 'dir/b.txt', data: 'BBB' }
      ]));
      const list = await U.listZip(zip);
      assert.strictEqual(list.length, 2);
      assert.ok(list.some((x) => x.name === 'a.txt'));
      assert.ok(list.some((x) => x.name === 'dir/b.txt' && x.size === 3));
    });

    await ta('isZipFile 判断正确', async () => {
      const zip = path.join(tmp, 'g.zip');
      await fsp.writeFile(zip, buildZip([{ name: 'a.txt', data: 'A' }]));
      assert.strictEqual(await U.isZipFile(zip), true);

      const not = path.join(tmp, 'g.bin');
      await fsp.writeFile(not, 'nope');
      assert.strictEqual(await U.isZipFile(not), false);

      assert.strictEqual(await U.isZipFile(path.join(tmp, '不存在的文件')), false);
    });

    await ta('flatten 模式把文件平铺出来', async () => {
      const zip = path.join(tmp, 'h.zip');
      await fsp.writeFile(zip, buildZip([{ name: 'deep/nest/x.txt', data: 'X' }]));
      const out = path.join(tmp, 'out-h');
      const r = await U.extractZip(zip, out, { flatten: true });
      assert.ok(r.ok);
      assert.ok(fs.existsSync(path.join(out, 'x.txt')), '应直接落在根目录');
    });

    await ta('进度回调会被调用', async () => {
      const zip = path.join(tmp, 'i.zip');
      await fsp.writeFile(zip, buildZip([
        { name: '1.txt', data: '1' }, { name: '2.txt', data: '2' }, { name: '3.txt', data: '3' }
      ]));
      let calls = 0, last = 0;
      await U.extractZip(zip, path.join(tmp, 'out-i'), {
        onProgress: (d, tt) => { calls++; last = tt; }
      });
      assert.strictEqual(calls, 3);
      assert.strictEqual(last, 3);
    });

    await ta('GBK 编码的文件名也能解出来（不乱码）', async () => {
      // 手工造一个"没有 UTF-8 标记、内容是 GBK 字节"的条目
      const gbk = Buffer.from([0xc8, 0xb7, 0xc8, 0xb7]);   // "确确" 的 GBK
      const nameBuf = gbk;
      const raw = Buffer.from('x');
      const body = zlib.deflateRawSync(raw);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);          // 不带 UTF-8 标记
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(raw), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      const zip = path.join(tmp, 'gbk.zip');
      await fsp.writeFile(zip, Buffer.concat([local, nameBuf, body]));

      const out = path.join(tmp, 'out-gbk');
      const r = await U.extractZip(zip, out);
      assert.ok(r.ok, r.error);
      assert.strictEqual(r.files.length, 1, '应解出一个文件');
      // 名字不该是乱码（乱码情况下会含替换字符或问号）
      assert.ok(!/\ufffd/.test(path.basename(r.files[0])), `文件名乱码：${r.files[0]}`);
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log(`\n============================================`);
  console.log(`结果：通过 ${pass}，失败 ${fail}`);
  console.log(`============================================\n`);
  process.exitCode = fail ? 1 : 0;
})();
