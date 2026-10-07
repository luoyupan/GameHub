/**
 * ============================================================
 *  GameHub - ZIP 打包器  (main/zipwrite.js)
 * ------------------------------------------------------------
 *  MOD 对齐工具的「快速打包」要把游戏的 MOD 目录压成 zip。
 *  Node 没有现成的 zip 打包 API，第三方依赖又不想引（项目一贯零依赖），
 *  所以手写一个 —— 其实没那么可怕：
 *
 *    zip = 一堆 [本地文件头 + 数据] + 一张 [中央目录表] + 一个 [EOCD 尾记录]
 *
 *  压缩用 Node 自带的 zlib.deflateRawSync（zip 的 deflate 就是裸 deflate 流），
 *  CRC32 自己实现（查表法，几十行）。
 *
 *  ⚠ 配套的解压在 unzip.js，本模块的产出必须能被它原样解回来 ——
 *    modport-test.js 里有「打包 → 解压 → 逐字节比对」的往返测试。
 * ============================================================
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

/* ---------------- CRC32（查表法） ---------------- */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 8)) : (c >>> 8);
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** DOS 时间（zip 头里就这么存，精度 2 秒） */
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 生成 zip 的核心。
 * @param {Array<{name:string, data?:Buffer, dir?:boolean, store?:boolean, mtime?:Date}>} entries
 *   name 用正斜杠相对路径；dir=true 时 data 忽略；store=true 不压缩（图片等已压格式更快）
 * @returns {Buffer}
 */
function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const isDir = !!e.dir;
    const data = isDir ? Buffer.alloc(0) : (e.data || Buffer.alloc(0));
    const method = isDir || e.store ? 0 : 8;               // 0=store 8=deflate
    const comp = method === 0 ? data : zlib.deflateRawSync(data);
    const crc = isDir ? 0 : crc32(data);
    const { time, date } = dosDateTime(e.mtime || new Date());

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header 签名
    lh.writeUInt16LE(20, 4);           // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);       // bit11：文件名是 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // extra 长度
    local.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory 签名
    ch.writeUInt16LE(20, 4);           // 制作版本
    ch.writeUInt16LE(20, 6);           // 需要版本
    ch.writeUInt16LE(0x0800, 8);       // UTF-8 名
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(isDir ? 0x10 : 0, 38);  // 外部属性 bit4：目录
    ch.writeUInt32LE(offset, 42);      // 本地头偏移
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);   // EOCD 签名
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);      // 中央目录起点 = 本地数据总长

  return Buffer.concat([...local, cdBuf, eocd]);
}

/** 递归收集一个目录下的全部文件（返回相对路径 + 绝对路径 + 数据在写入时再读） */
async function collectFiles(dir, prefix = '') {
  const out = [];
  let items = [];
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const rel = prefix ? prefix + '/' + it.name : it.name;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      out.push({ name: rel + '/', dir: true });
      out.push(...await collectFiles(full, rel));
    } else if (it.isFile()) {
      out.push({ name: rel, fullPath: full });
    }
  }
  return out;
}

/**
 * 把若干「源」（目录或文件）打进一个 zip，各自占一个顶层名字。
 * @param {Array<{srcPath:string, topName:string}>} sources
 * @param {{storeExts?:string[]}} opts storeExts 里的扩展名不压缩（jpg/png/mp3 这类）
 * @returns {Promise<Buffer>}
 */
async function createZipFromPaths(sources, opts = {}) {
  const storeExts = new Set((opts.storeExts || ['.jpg', '.jpeg', '.png', '.webp', '.mp3', '.mp4', '.ogg', '.bk2', '.bik']).map((s) => s.toLowerCase()));
  const entries = [];
  const used = new Set();
  for (const src of sources) {
    let st = null;
    try { st = await fsp.stat(src.srcPath); } catch { continue; }
    // 顶层名字唯一化（两个 mod 同名时加后缀，别互相覆盖）
    let top = src.topName;
    let n = 2;
    while (used.has(top.toLowerCase())) top = `${src.topName} (${n++})`;
    used.add(top.toLowerCase());

    if (st.isDirectory()) {
      entries.push({ name: top + '/', dir: true, mtime: st.mtime });
      const files = await collectFiles(src.srcPath, top);
      for (const f of files) {
        if (f.dir) { entries.push({ name: f.name, dir: true, mtime: st.mtime }); continue; }
        const data = await fsp.readFile(f.fullPath);
        const isStore = storeExts.has(path.extname(f.name).toLowerCase());
        entries.push({ name: f.name, data, store: isStore, mtime: st.mtime });
      }
    } else {
      const data = await fsp.readFile(src.srcPath);
      const isStore = storeExts.has(path.extname(top).toLowerCase());
      entries.push({ name: top, data, store: isStore, mtime: st.mtime });
    }
  }
  return createZip(entries);
}

module.exports = { createZip, createZipFromPaths, collectFiles, crc32 };
