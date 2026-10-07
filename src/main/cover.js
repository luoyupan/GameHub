/**
 * ============================================================
 *  GameHub - 封面与图标管理模块  (src/main/cover.js)
 * ------------------------------------------------------------
 *  Steam 那样的封面墙，靠的就是每款游戏一张好看的图。
 *  本模块提供四种来源，优先级由用户自选：
 *
 *    ① 从 exe 提取图标（默认，离线可用，square 图标居中贴到渐变底上）
 *    ② 用户手动指定图片（拖拽 / 文件选择）
 *    ③ 联网搜索：按名字去 Steam 查 AppID，再抓官方封面（搜不到就跳过，不打扰用户）
 *    ④ 都不行 → 前端用游戏名哈希生成渐变占位图（无需文件）
 *
 *  所有封面统一存到 userData/covers/<id>.jpg，用 file:// 给前端引用。
 *  图片处理用 Electron 自带的 nativeImage，不引入任何第三方图形库。
 * ============================================================
 */

const { nativeImage, app } = require('electron');
const fsp = require('fs/promises');
const path = require('path');

/** 封面最长边像素（够清晰又不会让磁盘爆掉） */
const MAX_SIDE = 900;
/** JPEG 质量 */
const JPEG_QUALITY = 92;

class CoverManager {
  /**
   * @param {import('./store').Store} store
   */
  constructor(store) {
    this.store = store;
    this.coverDir = store.coverDir;
    /** 批量任务的中止开关：界面上点「停止」时置 true，循环每轮检查一次 */
    this._cancel = false;
    /** appdetails 接口有频控，同一个 AppID 只问一次，结果缓存起来 */
    this._detailsCache = new Map();
  }

  /** 请求中止当前正在跑的批量任务 */
  cancel() { this._cancel = true; }

  /** 每批任务开始前把开关拨回去 */
  _resetCancel() { this._cancel = false; }

  /** 封面文件的绝对路径 */
  abs(rel) {
    if (!rel) return '';
    return path.isAbsolute(rel) ? rel : path.join(this.store.dataDir, rel);
  }

  /* ================================================================
   *  ① 从 exe 提取图标
   * ================================================================ */
  async extractIcon(game) {
    const target = game.exePath || game.installDir;
    if (!target) return { ok: false, error: '没有可执行文件可提取图标' };

    try {
      // size: 'large' → 通常 256×256，清晰度足够
      const icon = await app.getFileIcon(target, { size: 'large' });
      if (icon.isEmpty()) return { ok: false, error: '该文件没有图标资源' };

      const rel = await this._saveImage(icon, game.id, 'png');
      return { ok: true, coverPath: rel, coverKind: 'icon' };
    } catch (e) {
      return { ok: false, error: '提取图标失败：' + (e.message || e) };
    }
  }

  /* ================================================================
   *  ② 用户指定本地图片
   * ================================================================ */
  async setFromFile(game, filePath) {
    try {
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return { ok: false, error: '无法识别的图片格式（支持 PNG / JPG / WEBP / BMP）' };
      const rel = await this._saveImage(img, game.id, 'jpg');
      return { ok: true, coverPath: rel, coverKind: 'custom' };
    } catch (e) {
      return { ok: false, error: '设置封面失败：' + (e.message || e) };
    }
  }

  /** 从 base64 dataURL 设置封面（用于前端拖拽上传） */
  async setFromData(game, dataUrl) {
    try {
      const m = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp|bmp);base64,(.+)$/i);
      if (!m) return { ok: false, error: '图片数据格式不正确' };
      const buf = Buffer.from(m[2], 'base64');
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { ok: false, error: '无法解析图片数据' };
      const rel = await this._saveImage(img, game.id, 'jpg');
      return { ok: true, coverPath: rel, coverKind: 'custom' };
    } catch (e) {
      return { ok: false, error: '设置封面失败：' + (e.message || e) };
    }
  }

  /* ================================================================
   *  ③ Steam 名称搜索：把「没有 AppID 的游戏」查出一个 AppID
   * ----------------------------------------------------------------
   *  本地登记表 / 文件夹扫描出来的游戏是没有 Steam ID 的，
   *  但用户在 Steam 上大概率买过、有官方封面。所以这里按名字去 Steam 搜。
   *
   *  实测踩坑（很重要）：
   *    Steam 商店搜索接口对"带副标题的完整名字"很不友好 ——
   *    搜 "WorldBox - God Simulator" 返回 0 条，但搜 "WorldBox" 第一条就命中。
   *    所以这里会由长到短生成多个关键词，逐个试，命中就停。
   *  搜不到不算错误，直接跳过（用户的要求：搜不到就跳过）。
   * ================================================================ */

  /**
   * 按名称搜索 Steam AppID。
   * @param {{name:string, altNames?:string[]}} game
   * @param {{minScore?:number}} [opts] 最低匹配分，默认 MIN_MATCH_SCORE（由设置里的严格度决定）
   * @returns {Promise<string>} 找到返回 AppID 字符串，找不到返回空串
   */
  async searchSteamAppId(game, opts = {}) {
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : MIN_MATCH_SCORE;
    // 名字 + 别名（别名里通常存着 Steam 上的英文名，命中率更高）
    const names = [game.name, ...(game.altNames || [])].filter(Boolean);
    if (!names.length) return '';

    // ⚠ 每个来源名必须【单独】生成关键词，并且记住"这个词是从哪个名字截出来的"。
    //   不能把所有名字混在一起生成：那样中文名截出来的关键词会拿去跟英文名比对，
    //   两边永远对不上，结果是中文 / 日文游戏一款都搜不到。
    const pairs = [];
    for (const src of names) {
      for (const term of buildSearchTerms([src])) {
        if (!pairs.some((p) => p.term === term)) pairs.push({ term, src });
      }
      if (pairs.length >= MAX_TERMS) break;
    }

    for (const { term, src } of pairs.slice(0, MAX_TERMS)) {
      if (this._cancel) break;
      let items = await this._steamStoreSearch(term);
      if (!items.length) items = await this._steamSuggestSearch(term);
      const best = pickBestMatch(term, items, minScore);
      if (!best || best.score < minScore) continue;

      // 从长名字里【截出来】的短关键词信息量不够，不能单独采信 ——
      // 必须再用完整名字复核一遍。
      //   实测踩坑：本地一款叫 "zzz 不存在的游戏 …" 的测试条目，
      //   截到最后只剩 "zzz"，Steam 上恰好有一款游戏就叫 "zzzzz"，
      //   包含式相似度 0.84 直接过关，一张完全不相干的封面就贴上去了。
      //   加上这道复核：similarity(完整名, "zzzzz") = 0 → 挡掉。
      if (!termCoversSource(term, src) && similarity(src, best.name) < minScore) continue;

      return String(best.appid);
    }
    return '';
  }

  /** 通道 ①：商店搜索接口（JSON，最稳定） */
  async _steamStoreSearch(term) {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=schinese&cc=CN`;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const json = await res.json();
      return (json.items || [])
        .filter((it) => it && it.id && (!it.type || it.type === 'app'))
        .map((it) => ({ appid: String(it.id), name: String(it.name || '') }));
    } catch {
      return [];
    }
  }

  /** 通道 ②：商店输入提示接口（返回一段 HTML，正则抠出 appid 与名字） */
  async _steamSuggestSearch(term) {
    const url = `https://store.steampowered.com/search/suggest?term=${encodeURIComponent(term)}&f=games&cc=CN&l=schinese`;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const txt = await res.text();
      const out = [];
      // data-ds-appid="1206560" ... class="match_name">WorldBox - God Simulator<
      const re = /data-ds-appid="(\d+)"[\s\S]{0,800}?class="match_name">([^<]*)</g;
      let m;
      while ((m = re.exec(txt)) && out.length < 10) {
        // HTML 实体简单还原，避免 &amp; 影响比对
        out.push({ appid: m[1], name: m[2].replace(/&amp;/g, '&').trim() });
      }
      return out;
    } catch {
      return [];
    }
  }

  /* ================================================================
   *  ③-b 批量：自动从 Steam 补封面（"更多选项"里的功能）
   * ----------------------------------------------------------------
   *  规则：
   *    · 用户自己设过封面的游戏不动（尊重手动结果）
   *    · 没有 Steam ID 的先去搜，搜到就把 ID 记下来，下次不用再搜
   *    · 搜不到 / 图床没有图 → 跳过，不报错、不打断整批
   * ================================================================ */

  /**
   * @param {Array} games 要处理的游戏
   * @param {(p:{current:number,total:number,name:string,phase:string})=>void} onProgress
   */
  async steamAll(games, onProgress = () => {}) {
    const list = games || [];
    this._resetCancel();
    const fetched = [];
    const skipped = [];
    let searched = 0;

    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      onProgress({ current: i + 1, total: list.length, name: g.name, phase: '处理中' });

      // 用户自定义封面 → 跳过
      if (g.coverKind === 'custom' && g.coverPath) {
        skipped.push({ name: g.name, reason: '用户自定义封面' });
        continue;
      }

      let appid = g.steamAppId;
      if (!appid) {
        onProgress({ current: i + 1, total: list.length, name: g.name, phase: '搜索中' });
        appid = await this.searchSteamAppId(g);
        searched++;
        if (appid) {
          // 把查到的 AppID 写回库里，下次直接命中，不用再搜
          const rec = this.store.findGame(g.id);
          if (rec) { rec.steamAppId = appid; rec.updatedAt = Date.now(); }
        }
      }
      if (!appid) {
        skipped.push({ name: g.name, reason: 'Steam 上没搜到' });
        continue;
      }

      const r = await this.fetchSteam({ ...g, steamAppId: appid });
      if (r && r.ok) {
        this.store.updateGameCover(g.id, r);
        fetched.push({ name: g.name, appid });
      } else {
        skipped.push({ name: g.name, reason: 'Steam 图床没有可用封面' });
      }
    }

    await this.store.flush();
    return { ok: true, total: list.length, fetched: fetched.length, searched, skipped };
  }

  /* ================================================================
   *  ③-a 批量：给「没有封面的游戏」联网搜封面
   * ----------------------------------------------------------------
   *  和 steamAll() 的区别：这里只挑真正缺图的游戏出来处理，
   *  搜不到 / 图床没图一律静默跳过（用户的要求：搜索不到就算了），
   *  最后返回一份清单，界面上用它做汇总而不是弹出一堆报错。
   * ================================================================ */

  /**
   * @param {Array} games 候选游戏（调用方负责把隐藏/自定义封面先滤掉）
   * @param {{minScore?:number}} [opts]
   * @param {(p:{current:number,total:number,name:string,phase:string,note?:string})=>void} onProgress
   */
  async fillMissing(games, opts = {}, onProgress = () => {}) {
    const list = games || [];
    this._resetCancel();

    const fetched = [];      // 成功补上封面的
    const skipped = [];      // 各种原因没补上的（带 reason，界面要做汇总）
    let searched = 0;        // 其中有多少款是靠"按名字搜索"才拿到 AppID 的

    for (let i = 0; i < list.length; i++) {
      // 中止检查放在每轮开头：已经跑完的那几个封面照样留下，不回滚
      if (this._cancel) {
        onProgress({ current: i, total: list.length, name: '', phase: '已中止' });
        return { ok: true, cancelled: true, total: list.length, fetched: fetched.length, searched, skipped };
      }

      const g = list[i];
      onProgress({ current: i + 1, total: list.length, name: g.name, phase: '处理中' });

      // 最后一次复核：批量跑的过程中用户可能刚好手动改过封面
      const fresh = this.store.findGame(g.id);
      if (!fresh) { skipped.push({ name: g.name, reason: '游戏已从库中移除' }); continue; }
      if (fresh.coverKind === 'custom' && fresh.coverPath) {
        skipped.push({ name: g.name, reason: '用户自定义封面' });
        continue;
      }

      let appid = fresh.steamAppId;
      if (!appid) {
        onProgress({ current: i + 1, total: list.length, name: g.name, phase: '搜索中' });
        appid = await this.searchSteamAppId(fresh, opts);
        searched++;
        if (appid) {
          // 搜到就写回库里，下次不用再搜一遍
          fresh.steamAppId = appid;
          fresh.updatedAt = Date.now();
        }
      }
      if (!appid) {
        skipped.push({ name: g.name, reason: '没搜到' });
        continue;                                   // ← 「搜索不到就算了」就在这行
      }

      const r = await this.fetchSteam({ ...fresh, steamAppId: appid }, opts);
      if (r && r.ok) {
        this.store.updateGameCover(g.id, r);
        fetched.push({ name: g.name, appid });
        onProgress({ current: i + 1, total: list.length, name: g.name, phase: '已获取' });
      } else {
        skipped.push({ name: g.name, reason: '图床没有可用封面' });
      }
    }

    await this.store.flush();
    return { ok: true, cancelled: false, total: list.length, fetched: fetched.length, searched, skipped };
  }

  /* ================================================================
   *  ③-d 单款游戏联网搜封面（详情页「联网搜索封面」按钮用的）
   * ----------------------------------------------------------------
   *  和 fillMissing() 的区别：
   *    · 只处理一款，而且是用户主动点的，所以"搜不到"要明确回话，
   *      不能像批量那样静默跳过（用户点了按钮总得有个交代）
   *    · 库里没记 AppID 的（自己导的绿色版、文件夹扫出来的）也能用：
   *      先按名字去 Steam 搜，搜到就把 AppID 记回库里，下次不用再搜
   * ================================================================ */

  /**
   * @param {object} game
   * @param {{minScore?:number}} [opts]
   * @returns {Promise<{ok:boolean, error?:string, appid?:string, searched?:boolean}>}
   */
  async searchOne(game, opts = {}) {
    this._resetCancel();
    const fresh = this.store.findGame(game.id) || game;

    let appid = fresh.steamAppId;
    let searched = false;

    if (!appid) {
      searched = true;
      appid = await this.searchSteamAppId(fresh, opts);
      if (appid) {
        // 查到了就写回库里：下次「重新抓取封面」直接命中，不用再搜一遍
        fresh.steamAppId = appid;
        fresh.updatedAt = Date.now();
        this.store.saveSoon();
      }
    }

    if (!appid) {
      return {
        ok: false,
        searched,
        error: '网上没搜到这款游戏。可以改用「选择本地图片」手动指定封面。'
      };
    }

    const r = await this.fetchSteam({ ...fresh, steamAppId: appid }, opts);
    if (!r || !r.ok) {
      return {
        ok: false, appid, searched,
        error: `找到 Steam 条目了（AppID ${appid}），但图床没有可用封面`
      };
    }

    this.store.updateGameCover(game.id, r);
    await this.store.flush();
    return { ok: true, appid, searched, coverPath: r.coverPath, coverKind: r.coverKind, from: r.from };
  }

  /* ================================================================
   *  ③-c 从 Steam 官方 CDN 抓封面
   * ================================================================ */
  async fetchSteam(game, opts = {}) {
    const appid = game.steamAppId;
    if (!appid) return { ok: false, error: '这款游戏没有 Steam ID，无法自动抓图' };

    // 竖版封面优先（卡片是 2:3），横版 header 只在实在没有竖版时兜底
    const urls = [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`,
      `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/portrait.png`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`
    ];

    for (const url of urls) {
      const r = await this._download(url, game.id);
      if (r.ok) return r;
    }

    // 全都落空 → 再问一次官方接口，拿到真实图片地址。
    // 这条路径有频控（约 5 分钟 200 次），所以只在常规地址失败后才用，结果还带缓存。
    if (opts.deep !== false) {
      const detailUrls = await this._steamDetailImages(appid);
      for (const url of detailUrls) {
        const r = await this._download(url, game.id);
        if (r.ok) return r;
      }
    }

    return { ok: false, error: '联网获取封面失败（可能无网络或该游戏不在 Steam 图床）' };
  }

  /** 下载一张图并落成封面；任何异常都吞掉，由上层决定是否换下一个地址 */
  async _download(url, id) {
    try {
      // Electron / Node 18+ 自带全局 fetch
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
      if (!res.ok) return { ok: false };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) return { ok: false };   // 太小的基本是占位图/404 页
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { ok: false };
      const rel = await this._saveImage(img, id, 'jpg');
      return { ok: true, coverPath: rel, coverKind: 'steam', from: url };
    } catch {
      return { ok: false };
    }
  }

  /**
   * 问 Steam 官方接口拿这款游戏的真实图片地址。
   * 有些老游戏 / 独立游戏的竖版图不在常规路径上，只有这里能给对。
   * @returns {Promise<string[]>} 图片地址列表（拿不到返回空数组）
   */
  async _steamDetailImages(appid) {
    if (this._detailsCache.has(appid)) return this._detailsCache.get(appid);
    let out = [];
    try {
      const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&filters=basic`;
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const json = await res.json();
        const d = json && json[appid] && json[appid].success && json[appid].data;
        if (d) {
          out = [d.capsule_imagev5, d.capsule_image, d.header_image]
            .filter((u) => typeof u === 'string' && /^https?:/i.test(u));
        }
      }
    } catch { /* 接口抽风就算了 */ }
    this._detailsCache.set(appid, out);
    return out;
  }

  /** 批量补图：优先 Steam 官方图，其次 exe 图标 */
  async autoFill(games, onProgress = () => {}) {
    let done = 0, ok = 0;
    for (const g of games) {
      done++;
      onProgress({ current: done, total: games.length, name: g.name });
      if (g.coverKind === 'custom' && g.coverPath) continue; // 用户自己设的别覆盖
      let r = null;
      if (g.steamAppId) r = await this.fetchSteam(g);
      if (!r || !r.ok) r = await this.extractIcon(g);
      if (r && r.ok) {
        this.store.findGame(g.id) && this.store.updateGameCover(g.id, r);
        ok++;
      }
    }
    return { ok };
  }

  /* ================================================================
   *  ④ 重置封面
   * ================================================================ */
  async reset(game) {
    if (game.coverPath) {
      await fsp.unlink(this.abs(game.coverPath)).catch(() => {});
    }
    return { ok: true, coverPath: '', coverKind: 'none' };
  }

  /* ================================================================
   *  内部：把 nativeImage 压缩后落盘
   * ================================================================ */
  async _saveImage(img, id, format = 'jpg') {
    const size = img.getSize();
    let out = img;

    // 等比缩放到最长边 MAX_SIDE 以内，避免超大图拖慢界面
    const longest = Math.max(size.width, size.height);
    if (longest > MAX_SIDE && longest > 0) {
      const scale = MAX_SIDE / longest;
      out = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      });
    }

    // 文件名带上时间戳，突破浏览器对 file:// 的强缓存（换封面立刻生效）
    const fileName = `${id}_${Date.now()}.${format}`;
    const absPath = path.join(this.coverDir, fileName);
    const buf = format === 'png' ? out.toPNG() : out.toJPEG(JPEG_QUALITY);
    await fsp.writeFile(absPath, buf);

    // 顺手清掉该游戏以前的旧封面，防止目录无限膨胀
    await this._cleanOld(id, fileName);

    return path.posix.join('covers', fileName);
  }

  /** 删除某个游戏除 keepFile 之外的旧封面 */
  async _cleanOld(id, keepFile) {
    try {
      const files = await fsp.readdir(this.coverDir);
      for (const f of files) {
        if (f !== keepFile && f.startsWith(id + '_')) {
          await fsp.unlink(path.join(this.coverDir, f)).catch(() => {});
        }
      }
    } catch { /* 目录不存在就算了 */ }
  }
}

/* ==================================================================
 *  纯函数区：Steam 名称匹配
 *  （不依赖网络与 Electron，方便单元测试直接引用）
 * ================================================================== */

/** 名称相似度达到多少才认为"就是这款游戏"（低于此值宁可跳过，也不要贴错图） */
const MIN_MATCH_SCORE = 0.62;

/** 明显不是本体的条目（原声带、DLC、季票、支持者包…）识别 */
const NOISE_TITLE_RE = /(soundtrack|ost\b|original\s+sound|原声|dlc|季票|season\s*pass|bundle|捆绑|礼包|supporter|支持者|升级包|expansion|add-?on|art\s*book|artbook|demo|试玩|beta|测试版)/i;

/** 罗马数字词表（用于识别"第几代"） */
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/**
 * 全角 → 半角（日文/中文标题里经常混着全角数字与全角冒号，
 * 不归一化的话 "女神异闻录5" 和 "女神异闻录５" 会被当成两款游戏）。
 */
function toHalfWidth(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/**
 * 归一化名称：只保留字母、数字、汉字，其余变空格。
 * 这样 "Cities: Skylines II" 和 "Cities Skylines II" 才能对上。
 */
function normName(s) {
  return toHalfWidth(s)
    .replace(/&amp;/g, '&')
    .replace(/[™®©]/g, '')
    .replace(/[(（][^)）]*[)）]/g, ' ')   // 去掉括号注释（比如"（中文版）"）
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

/**
 * 抽出名字里的"代数"标记：II / 2 / III / 5 …
 * 用来避免把续作认成本体 —— 实测 "Hades II" 和 "Hades" 的包含式相似度高达 0.845，
 * 光看相似度会把《哈迪斯1》的封面贴到《哈迪斯2》上。
 * @returns {Set<string>} 归一化后的代数标记集合
 */
function numeralTokens(s) {
  const out = new Set();
  for (const tok of normName(s).split(' ').filter(Boolean)) {
    // ⚠ 阿拉伯数字和罗马数字必须落成【同一个记号】：
    //   早期版本把 "2" 存成 "2"、"II" 存成 "r2"，两者永远对不上，
    //   于是 Steam 上的 "Hades II" 去搜本地的 "Hades 2" 会被判成"代数不符"而漏匹配。
    //   现在统一成 rN（06 与 6 也归一），"Hades 2" 和 "Hades II" 就都是 r2 了。
    if (/^\d{1,4}$/.test(tok)) out.add('r' + Number(tok));
    else if (ROMAN[tok]) out.add('r' + ROMAN[tok]);
  }
  return out;
}

/**
 * 代数是否对不上。
 * 规则：查询里有的代数标记，候选里必须也有；
 *      查询没有代数、候选却有 → 也认为对不上（避免"Portal"被匹配到"Portal 2"）。
 */
function numeralMismatch(query, candidate) {
  const q = numeralTokens(query);
  const c = numeralTokens(candidate);
  for (const t of q) if (!c.has(t)) return true;
  if (!q.size && c.size) return true;
  return false;
}

/**
 * 名称相似度，0 ~ 1。
 * 规则简单但够用：完全相等 1.0；互相包含时按长度比例给 0.72~0.92；
 * 否则用词集合的 Jaccard 系数打折。
 */
function similarity(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const shortLen = Math.min(na.length, nb.length);
    const longLen = Math.max(na.length, nb.length);
    return 0.72 + 0.2 * (shortLen / longLen);
  }
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  if (!union) return 0;
  return (inter / union) * 0.7;
}

/**
 * 由长到短生成搜索关键词。
 * 这一步是命中率的关键：Steam 对带副标题的长名字经常返回 0 条。
 * @param {string[]} names 游戏名 + 别名
 * @returns {string[]} 最多 3 个关键词
 */
function buildSearchTerms(names) {
  const out = [];
  const push = (t) => {
    const v = String(t || '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—:|/]+|[\s\-–—:|/]+$/g, '')   // 去掉切分残留的首尾分隔符
      .trim();
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };

  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    // ① 原样（去掉括号注释）
    const noParen = toHalfWidth(name).replace(/[(（][^)）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();
    push(noParen || name);

    // ② 按副标题分隔符切开，取【第一段】。
    //    Steam 对 "主标题 - 副标题" 这种完整写法经常一条都搜不到，
    //    但只要搜主标题就能命中（"WorldBox - God Simulator" → 搜 "WorldBox" 才对）。
    //    这里刻意不用"最长的一段"：那样会挑出 "God Simulator"，反而搜出一堆别的游戏。
    const parts = (noParen || name).split(/[:：\-–—|/]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
    if (parts.length > 1) push(parts[0]);

    // ③ 前两个词（主标题本身还是太长时继续截短）
    const words = (noParen || name).split(/\s+/).filter(Boolean);
    if (words.length > 2) push(words.slice(0, 2).join(' '));

    // ④ 只剩第一个词兜底
    if (words.length > 1) push(words[0]);
  }
  return out.slice(0, 3);
}

/**
 * 这个关键词能不能代表这个来源名的"大部分"？
 * 用于判断要不要再用完整名字复核命中结果 ——
 * 从长名字里截出来的短词信息量不足，直接采信很容易贴错图。
 * @param {string} term 实际拿去搜的关键词
 * @param {string} src  这个词是从哪个名字截出来的
 * @returns {boolean} true = 已经足够长，不必再复核
 */
function termCoversSource(term, src, ratio = 0.6) {
  const nTerm = normName(term);
  const nSrc = normName(src);
  if (!nTerm || !nSrc) return false;
  return nTerm.length >= nSrc.length * ratio;
}

/**
 * 从搜索结果里挑最像"这款游戏本体"的一条。
 * @param {string} term 本次用的关键词
 * @param {Array<{appid:string,name:string}>} items
 */
function pickBestMatch(term, items, minScore = MIN_MATCH_SCORE) {
  let best = null;
  for (const it of items || []) {
    if (!it || !it.appid || !it.name) continue;
    let score = similarity(term, it.name);
    // 原声带 / DLC / 礼包之类的降权，避免把 Soundtrack 的图贴上去
    if (NOISE_TITLE_RE.test(it.name)) score -= 0.35;
    // 代数对不上（Hades 2 vs Hades / Portal vs Portal 2）→ 重罚，宁可不贴图也不能贴错
    if (numeralMismatch(term, it.name)) score -= 0.4;
    if (score > (best ? best.score : 0)) best = { appid: String(it.appid), name: it.name, score };
  }
  return best;
}

/**
 * 这款游戏是不是"缺封面"，值不值得联网去搜。
 * 纯函数，方便单元测试。
 * @param {object} g
 * @param {boolean} [includeIcon] true = 连已经提取的程序图标也一并升级成官方封面
 */
function needsCover(g, includeIcon = false) {
  if (!g || !g.name) return false;
  // 用户自己设过的封面拥有最高优先级，绝不覆盖
  if (g.coverKind === 'custom' && g.coverPath) return false;
  if (!g.coverPath) return true;                       // 完全没图 → 要搜
  return !!includeIcon && g.coverKind === 'icon';      // 只有图标 → 看用户要不要升级
}

/** 一次搜索最多试几个关键词（控制网络请求量，多了 Steam 会限流） */
const MAX_TERMS = 4;

/** 严格度 → 最低匹配分（设置面板里的三档严格度用这个表换算） */
const MATCH_LEVEL = {
  loose: 0.50,    // 宽松：命中率高，偶尔会贴错图
  normal: 0.62,   // 标准：默认
  strict: 0.80    // 严格：宁可搜不到也不贴错
};

module.exports = {
  CoverManager,
  // 以下导出只为单元测试与复用
  needsCover,
  termCoversSource,
  MATCH_LEVEL,
  normName,
  toHalfWidth,
  numeralTokens,
  numeralMismatch,
  similarity,
  buildSearchTerms,
  pickBestMatch,
  MIN_MATCH_SCORE
};
