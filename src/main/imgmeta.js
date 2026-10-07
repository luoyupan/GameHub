/**
 * ============================================================
 *  GameHub - 图片基本信息嗅探  (src/main/imgmeta.js)
 * ------------------------------------------------------------
 *  作用：只读文件开头几十个字节，判断"这是不是图片、多大尺寸"。
 *  为什么需要它：
 *    Steam 的 librarycache 里封面文件名花样太多 ——
 *      library_600x900.jpg / library_600x900_schinese.jpg / library_capsule.jpg
 *      还有被塞在 <hash>/ 子目录里的，甚至只有一堆没有扩展名的哈希文件名。
 *    光靠文件名猜不可靠，量一下真实宽高比才踏实：
 *      竖版封面 ≈ 300x450（比例 0.67）→ 正合适铺在 2:3 的卡片上
 *      横版大图 ≈ 1920x620（比例 3.1） → 拿来做详情页背景
 *
 *  ⚠ 纯解析、不依赖任何第三方库、不解码像素，只读文件头。
 *     不认识的格式一律返回 {w:0,h:0,type:''}，绝不抛异常。
 * ============================================================
 */

const EXT_RE = /\.(jpe?g|png|gif|bmp|webp)$/i;

/**
 * 解析图片尺寸。
 * @param {Buffer} b 文件内容（至少前 ~64KB，越大越保险）
 * @returns {{w:number,h:number,type:string}}
 */
function imageSize(b) {
  const none = { w: 0, h: 0, type: '' };
  if (!b || b.length < 8) return none;

  /* ---- PNG：8 字节签名 + IHDR，宽高在 16/20 字节处 ---- */
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
  }

  /* ---- GIF：逻辑屏幕宽高，小端 16 位 ---- */
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), type: 'gif' };
  }

  /* ---- BMP：BITMAPINFOHEADER ---- */
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)), type: 'bmp' };
  }

  /* ---- WEBP：RIFF....WEBP，再分 VP8 / VP8L / VP8X ---- */
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = b.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { w, h, type: 'webp' };
    }
    if (fourcc === 'VP8 ') {
      return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    }
    if (fourcc === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    return none;
  }

  /* ---- JPEG：扫到 SOFn 段，高度在前、宽度在后 ---- */
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // SOF0..SOF15，其中 C4(DHT) / C8(JPG) / CC(DAC) 不是尺寸段
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), type: 'jpg' };
      }
      const segLen = b.readUInt16BE(i + 2);
      if (segLen < 2) break;          // 段长为 0 说明数据坏了，别再往下扫
      i += 2 + segLen;
    }
    return none;
  }

  return none;
}

/** 文件名后缀看起来像图片吗 */
function looksLikeImageName(name) {
  return EXT_RE.test(String(name || ''));
}

/** 宽高比（高度为 0 时返回 0） */
function aspect(size) {
  return size && size.h > 0 ? size.w / size.h : 0;
}

module.exports = { imageSize, looksLikeImageName, aspect };
