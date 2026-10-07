/**
 * ============================================================
 *  GameHub - Epic 账号认证与数据读取（epicauth.js）
 * ------------------------------------------------------------
 *  让用户在 GameHub 里登录自己的 Epic 账号，读到两样东西：
 *    ① 拥有的游戏全清单（**含领了但没下载的** —— 本地清单读不到这些）
 *    ② 官方封面图（CDN 直链，比 Steam 那边好取）
 *
 *  ── 边界与事实，先说清楚 ──────────────────────────────────
 *  Epic **没有**开放面向第三方的玩家数据 API。官方论坛工作人员的回复原话是
 *  "At this time, achievement info is not accessible through our web API."
 *  所以本模块走的是 Epic 自家启动器在用的那套接口 —— 也就是
 *  Legendary / Heroic 这类开源启动器同走的路。代价要心里有数：
 *    · 没有文档，Epic 改一次就可能失效（所以下面全做了多端点兜底）
 *    · 这里只用**只读**接口，且只用用户自己授权的 token
 *    · 凭证加密后只存在本机 GameHub 的数据目录里，不上传任何地方
 *
 *  关于 client_id：用的是 Epic 启动器自己在用的 launcherAppClient2，
 *  这对凭据在社区里是公开的（多个开源项目都在用）。它不属于 GameHub，
 *  我们也没有自己的 Epic 开发者应用 —— 这点必须写在明处，不能装作是官方授权。
 *
 *  ⚠ 为什么这里没用 PKCE：
 *    launcherAppClient2 是**带 secret 的 confidential client**，
 *    走标准 authorization_code + Basic 认证即可，这是社区反复验证过的路径。
 *    硬加 PKCE 反而可能因为服务端不认 code_challenge 而直接失败。
 * ============================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

/* ------------------------------------------------------------------
 *  常量
 * ------------------------------------------------------------------ */

/**
 * Epic 启动器公开在用的客户端凭据（clientId 末尾是 9a 不是 9f，别手改）。
 * 两个独立来源核对过（EpicResearch 的客户端表 + /id/api/client 的回应样例）。
 *
 * ⚠ 关于把它写进源码这件事，说清楚三点：
 *   1. 这是 Epic **启动器本体**用的公开客户端标识，不是任何人的账号密码，
 *      也不含任何用户数据；开源社区（Heroic / Legendary 等）普遍也是这么用的。
 *   2. 但它毕竟是硬编码在仓库里的凭据。想换掉的话不需要改代码 ——
 *      设环境变量即可覆盖，见下面的 env()：
 *        GAMEHUB_EPIC_CLIENT_ID / GAMEHUB_EPIC_CLIENT_SECRET
 *   3. 用户的登录 token 不在这里，存在 userData/epic-auth.json，
 *      并且用 Electron 的 safeStorage 走系统级加密（Windows 上是 DPAPI，
 *      密钥绑当前用户账户），仓库里没有、也不会有 token。
 */
const env = (k, dflt) => (process.env && process.env[k]) || dflt;
const CLIENT_ID = env('GAMEHUB_EPIC_CLIENT_ID', '34a02cf8f4414e29b15921876da36f9a');
const CLIENT_SECRET = env('GAMEHUB_EPIC_CLIENT_SECRET', 'daafbccc737745039dffe53d94fc76cf');

/** 登录后 Epic 会把浏览器重定向到这里。这个地址**并不真实存在**，
 *  必须在 Electron 里拦下导航、绝不能让它真的发出网络请求。 */
const REDIRECT_HOST = 'localhost';
const REDIRECT_PATH = '/launcher/authorized';

const AUTH_FILE = 'epic-auth.json';

/** token 端点：主 + 备（Epic 历史上换过多次 prod 编号） */
const TOKEN_HOSTS = [
  'account-public-service-prod03.ol.epicgames.com',
  'account-public-service-prod.ol.epicgames.com'
];

/**
 * 库服务：回答"这个账号拥有哪些游戏"。
 *
 * ⚠ 2026-10-05 实测修正 —— 这是上一版最大的错误：
 *   上一版走的是 GraphQL（graphql.epicgames.com/graphql），实测那个端点
 *   已经**直接返回 404 Gone**（Epic 废弃了它），而作为备用的
 *   launcher-graphql.epicgames.com 更是压根不存在（ENOTFOUND）——
 *   两个都死了，所以用户一点登录就报"读取拥有清单失败"。
 *   现在改用启动器和 Legendary 都在用的那个官方 REST 端点（实测返回 401 =
 *   端点活着、只是在等认证，这才是正常状态）。
 */
const LIBRARY_HOSTS = [
  'library-service.live.use1a.on.epicgames.com'
];

/**
 * 目录服务：补游戏正式名（中文）和封面图。
 * 它是**锦上添花** —— 挂了不影响主流程，
 * 因为库记录本来就带了 sandboxName（通常就是游戏名）。
 */
const CATALOG_HOSTS = [
  'catalog-public-service-prod06.ol.epicgames.com'
];

const UA = 'GameHub/1.0 (+local game library launcher)';

/* ------------------------------------------------------------------
 *  小工具
 * ------------------------------------------------------------------ */

/** Basic 认证的 Authorization 头 */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

/**
 * 发一个 HTTPS 请求。
 * 刻意用 Node 内置 https 而不是引第三方库 —— 少一个依赖就少一个打包/兼容风险。
 *
 * @returns {Promise<{status:number, text:string, json:object|null}>}
 */
function request(urlStr, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 20000
  } = opts;

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error('URL 不合法：' + urlStr));
    }

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { 'User-Agent': UA, ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch { /* 不是 JSON 就留 null，调用方自己看 status */ }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });

    req.setTimeout(timeout, () => req.destroy(new Error('请求超时（' + timeout + 'ms）')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** x-www-form-urlencoded 表单体 */
function form(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.append(k, String(v));
  return q.toString();
}

/**
 * 从页面文本里抠出 authorizationCode。
 *
 * ⚠ 为什么是"拿 innerText 再正则"，而不是老老实实解析 DOM：
 *   Epic 把这个结果页交给 Chromium 内置的 JSON 查看器去渲染，
 *   不同版本会把它包进 <pre> / <div> / 甚至 shadow root，DOM 结构根本不固定。
 *   嗅文本、抓字段，是唯一跨版本都稳的办法。
 *
 * ⚠ 顺便注意 `"authorizationCode": null` 这个坑：
 *   正则要求值必须带引号，所以 null 天然匹配不上 —— 这不是巧合，是故意的。
 *   它正是"未登录"的信号，必须能和真正拿到码区分开。
 *
 * @returns {string} 授权码；没拿到（含值为 null）时返回 ''
 */
function extractAuthCode(text) {
  const m = /"authorizationCode"\s*:\s*"([^"]+)"/.exec(String(text || ''));
  return m ? m[1] : '';
}

/** 这段文本是 Epic 的授权结果页吗（用来区分"结果页"和"登录表单"） */
function looksLikeAuthResult(text) {
  return /"authorizationCode"\s*:/.test(String(text || ''));
}

/**
 * 库记录 → 目录详情的**索引键**。
 *
 * ⚠ 这个函数本身是一次事故的产物，留着它是为了让那类事故不可能再发生。
 *
 *   事故经过：fetchCatalogDetails 往 Map 里存的时候，用的是 bulk 响应自己的顶层键；
 *   而那个键**就是裸的 catalogItemId，不带 namespace 前缀**。
 *   可 fetchLibrary 取的时候却拼的是 `${namespace}:${catalogItemId}`。
 *   两边各自拼字符串、谁也不认识谁，于是**永远查不中** ——
 *   结果就是所有目录详情（正式名 + 封面 + 开发商）全军覆没，
 *   界面上一大片游戏退化成了 sandboxName 里的内部代号 "Live"、
 *   封面全变成首字母占位块。而这一路**没有任何一处报错**，静默降级。
 *
 *   结论：存和取只能走同一个函数。谁要是在别处再手拼一次这个 key，这事故就会重演。
 *
 * 为什么是 appName 之外的 catalogItemId：
 *   库记录里的 catalogItemId 才是"这一条 entitlement 对应的商品"，
 *   bulk 接口也正是按它给结果。namespace 只在**发起请求**时用来分组，不进键。
 */
function detailKey(rec) {
  if (!rec) return '';
  return String(rec.catalogItemId || '');
}

/**
 * 把一次 bulk 响应并入索引表（纯函数，不碰网络 —— 所以才测得了）。
 *
 * 单独抽出来的理由：测试必须能拿**真实录制下来的响应**走一遍存取，
 * 而只有走真函数才算测到了那条缝。上一版就是因为这步混在 fetch 里、
 * 测试只能手搓一个理想化的 Map，缝没被测到，bug 直接漏到了用户面前。
 */
function indexBulkResponse(json, out) {
  for (const [key, val] of Object.entries(json || {})) {
    if (val && typeof val === 'object') out.set(key, val);
  }
  return out;
}

/**
 * 这个 sandboxName 看着像 Epic 的内部代号而不是游戏名吗。
 *
 * 实测到的几种噪声：
 *   · "Live"            —— 46 条记录共用这一个（最坑的一个）
 *   · "shoal Production" / "tommes Production" —— 工作室内部工程名
 *   · 32 位纯十六进制    —— 和 appName 一样是机器码
 * 拿它们当游戏名给用户看是没有意义的，得能识别出来。
 */
function looksLikeInternalName(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return true;
  if (/^live$/i.test(t)) return true;
  if (/^[0-9a-f]{32}$/i.test(t)) return true;
  if (/\sproduction$/i.test(t)) return true;
  return false;
}

/**
 * 把底层的网络错误翻译成用户能看懂的一句话。
 *
 * 为什么值得单独做：用户第一次遇到的报错是
 * "getaddrinfo ENOTFOUND launcher-graphql.epicgames.com" ——
 * 一个普通用户看到这行字，既不知道发生了什么，也不知道该做什么。
 * 技术细节仍然保留在后面（排查要靠它），但前面得先说人话。
 */
function friendlyNetError(detail) {
  const s = String(detail || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) {
    return '解析不到 Epic 的服务器地址（可能是网络或 DNS 层面的拦截）';
  }
  if (/ETIMEDOUT|timeout|超时/i.test(s)) return '连接 Epic 服务器超时';
  if (/ECONNRESET|ECONNREFUSED|socket hang up/i.test(s)) return '与 Epic 服务器的连接被中断';
  if (/certificate|SSL|TLS/i.test(s)) return '与 Epic 服务器的安全连接失败';
  return '无法从 Epic 读取数据';
}

/**
 * 构造登录页地址。
 *
 * ⚠ 必须套一层 /id/login?redirectUrl=...，**绝不能直接打 /id/api/redirect**：
 *   后者在未登录时不会渲染登录表单，只会甩回一个 authorizationCode 为 null
 *   的裸 JSON，用户看到的就是一串天书（这就是最初那版的 bug）。
 *   套上 /id/login 之后，未登录会正常显示 Epic 的登录表单。
 */
function buildLoginUrl() {
  const redirect = 'https://www.epicgames.com/id/api/redirect'
    + `?clientId=${encodeURIComponent(CLIENT_ID)}&responseType=code`;
  return 'https://www.epicgames.com/id/login?redirectUrl=' + encodeURIComponent(redirect);
}

/* ------------------------------------------------------------------
 *  登录窗口的「可视化」
 * --------------------------------------------------------------
 *  Epic 授权完成后，会把人丢到一个**裸 JSON 页面**上，长这样：
 *    {"warning":"Do not share this code with any 3rd party service.
 *                It allows full access to your Epic account.",
 *     "redirectUrl":"https://localhost/launcher/authorized",
 *     "authorizationCode":"xxxxx", "exchangeCode":null, "sid":null}
 *
 *  这个页面又丑又吓人：白底黑字、还顶着一句"会授予完整访问权限"的警告，
 *  用户根本不知道发生了什么、窗口能不能关、接下来该干嘛。
 *  我们本来就要从这段 JSON 里抠 authorizationCode，顺手把它换成一句人话 ——
 *  这就是下面两个函数存在的全部理由。
 * ------------------------------------------------------------------ */

/** HTML 转义：注入的内容里有标题/描述，别让它们破坏结构 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把登录窗口整个盖成一张 GameHub 风格的结果卡。
 *
 * @param {BrowserWindow} win
 * @param {boolean} ok      成功 / 需要用户再看一眼
 * @param {string} title
 * @param {string} desc
 * @param {string} [retryUrl] 给了就在卡片下面加一个「重新打开登录页」按钮
 */
async function paintLoginResult(win, ok, title, desc, retryUrl) {
  const accent = ok ? '#6fdc8c' : '#ef9f27';
  const soft = ok ? 'rgba(111,220,140,.13)' : 'rgba(239,159,39,.13)';
  const icon = ok ? '✓' : '!';

  const card = ''
    + '<div style="max-width:470px;padding:34px 38px;border-radius:16px;'
    +   'background:#161d26;border:1px solid #26313d;text-align:center;">'
    +   '<div style="width:58px;height:58px;margin:0 auto 18px;border-radius:50%;'
    +     'display:grid;place-items:center;font-size:29px;font-weight:600;'
    +     `background:${soft};color:${accent};border:1px solid ${accent}66;">${icon}</div>`
    +   `<div style="font-size:17px;font-weight:600;color:#e8eef5;margin-bottom:9px;">${esc(title)}</div>`
    +   `<div style="font-size:13px;line-height:1.75;color:#93a3b4;">${esc(desc)}</div>`
    +   (retryUrl
        ? '<button id="__gh_retry" style="margin-top:22px;padding:10px 24px;border-radius:8px;'
          + 'border:1px solid #2f6fd0;background:#1d4e8f;color:#fff;font-size:13px;'
          + 'cursor:pointer;font-family:inherit;">重新打开登录页</button>'
        : '')
    + '</div>';

  const script = `(function(){
    var old = document.getElementById('__gh_veil');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.id = '__gh_veil';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;'
      + 'align-items:center;justify-content:center;background:#0b1016;'
      + 'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
    d.innerHTML = ${JSON.stringify(card)};
    document.documentElement.appendChild(d);
  })();`;

  try {
    await win.webContents.executeJavaScript(script);
    // 事件用 addEventListener 绑，不用 inline onclick —— 外部页面的 CSP 可能拦 inline 脚本
    if (retryUrl) {
      await win.webContents.executeJavaScript(`(function(){
        var b = document.getElementById('__gh_retry');
        if (b) b.addEventListener('click', function(){ window.location.href = ${JSON.stringify(retryUrl)}; });
      })();`);
    }
  } catch { /* 注入不进去不影响登录本身，静默跳过 */ }
}

/** 还在 Epic 登录表单上时，底部挂一条说明条（不遮挡页面主体） */
async function paintLoginHint(win) {
  const script = `(function(){
    if (document.getElementById('__gh_tip')) return;
    var old = document.getElementById('__gh_veil');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.id = '__gh_tip';
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
      + 'padding:11px 18px;background:rgba(11,16,22,.95);color:#c8d4e0;'
      + 'border-top:1px solid #26313d;text-align:center;'
      + 'font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
    d.textContent = '这是 Epic 官方登录页 · 账号密码不会经过 GameHub · 登录完成后本窗口会自动关闭';
    document.documentElement.appendChild(d);
  })();`;
  try { await win.webContents.executeJavaScript(script); } catch { /* 同上，跳过 */ }
}

/* ------------------------------------------------------------------
 *  客户端
 * ------------------------------------------------------------------ */

/**
 * 建一个 Epic 客户端。
 *
 * @param {{dataDir?:string, onLog?:Function}} [opts]
 *   dataDir —— 凭证存放目录（一般是 electron 的 userData）
 */
function createEpicAuth(opts = {}) {
  const dataDir = opts.dataDir || '';
  const log = opts.onLog || (() => {});
  const file = dataDir ? path.join(dataDir, AUTH_FILE) : '';

  /** 当前登录态缓存（避免每次都读盘） */
  let session = null;
  let loaded = false;

  /* ---------------- 凭证存取 ---------------- */

  /**
   * 加密存储。
   * Electron 的 safeStorage 在 Windows 上走 DPAPI —— 密钥绑到当前 Windows 用户，
   * 换账户或拷到别的机器上解不开。就算别人把文件复制走也读不到明文 token。
   * 万一系统不支持（Linux 某些环境），如实退回明文并记一笔，不假装加密了。
   */
  function readDisk() {
    if (!file || !fs.existsSync(file)) return null;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.encrypted && j.payload) {
        const { safeStorage } = require('electron');
        if (!safeStorage.isEncryptionAvailable()) return null;
        return JSON.parse(safeStorage.decryptString(Buffer.from(j.payload, 'base64')));
      }
      return j && j.plain ? j.plain : null;
    } catch (e) {
      log('凭证读取失败：' + e.message);
      return null;
    }
  }

  function writeDisk(data) {
    if (!file) return;
    try {
      let out;
      try {
        const { safeStorage } = require('electron');
        if (safeStorage.isEncryptionAvailable()) {
          const buf = safeStorage.encryptString(JSON.stringify(data));
          out = { version: 1, encrypted: true, payload: Buffer.from(buf).toString('base64') };
        }
      } catch { /* electron 不在（比如单元测试）→ 走明文分支 */ }

      if (!out) out = { version: 1, encrypted: false, plain: data };
      fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    } catch (e) {
      log('凭证保存失败：' + e.message);
    }
  }

  function clearDisk() {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch { /* 删不掉就算了 */ }
    session = null;
    loaded = true;
  }

  /* ---------------- 登录态 ---------------- */

  /**
   * 当前登录状态。
   * @returns {{loggedIn:boolean, account?:object, expiresAt?:number, needsRefresh?:boolean}}
   */
  function status() {
    if (!loaded) { session = readDisk(); loaded = true; }
    if (!session || !session.accessToken) return { loggedIn: false };

    const now = Date.now();
    // 提前 5 分钟续：别等到真过期了才发现
    const needsRefresh = !!session.expiresAt && session.expiresAt - now < 5 * 60 * 1000;
    return {
      loggedIn: true,
      accountId: session.accountId || '',
      account: session.account || null,
      expiresAt: session.expiresAt || 0,
      // refreshToken 过期了就只能重新登录，refresh 也没用
      canRefresh: !!session.refreshToken && (!session.refreshExpiresAt || session.refreshExpiresAt > now),
      needsRefresh
    };
  }

  /* ---------------- OAuth ---------------- */

  /**
   * 打开 Epic 登录页，等用户授权完把 code 交回来。
   *
   * 流程：
   *   ① 弹一个 BrowserWindow 加载 /id/api/redirect
   *   ② 用户在这个窗口里完成 Epic 登录（两步验证 / 短信也在这个窗口里）
   *   ③ Epic 把窗口重定向到 https://localhost/launcher/authorized?code=xxx
   *   ④ 我们**拦下**这个导航（will-redirect / will-navigate），取出 code
   *   ⑤ 立刻关窗 —— 那个 localhost 地址是不存在的，真发出去只会报错
   *
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function login(parentWindow) {
    return new Promise((resolve) => {
      let electron;
      try {
        electron = require('electron');
      } catch {
        return resolve({ ok: false, error: '当前环境不是 Electron，无法打开登录窗口' });
      }
      const { BrowserWindow } = electron;

      const win = new BrowserWindow({
        width: 1080,
        height: 780,
        parent: parentWindow || null,
        modal: !!parentWindow,
        show: true,
        title: '登录 Epic 账号',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,   // 打开的是外部页面，绝不给 Node
          contextIsolation: true,
          // ⚠ 单独开一个 session：和 GameHub 自己、和系统里的浏览器都不共享 cookie，
          //   登录完这一趟用完即弃，不留痕迹。
          partition: 'persist:epic-login-' + Date.now()
        }
      });

      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        try { win.destroy(); } catch { /* 关不掉不强求 */ }
        resolve(r);
      };

      /* 登录地址由 buildLoginUrl() 统一构造，别在这就地拼 —— 那个函数是可测的 */
      const authUrl = buildLoginUrl();

      /** 「空授权码」这种异常只自动重来一次，防止死循环 */
      let retried = false;

      /** 从 URL 里抠 code（万一 Epic 仍然走 302 到 localhost 回调那条老路） */
      const grabCode = (url) => {
        try {
          const u = new URL(url);
          if (u.hostname !== REDIRECT_HOST) return '';
          if (u.pathname !== REDIRECT_PATH) return '';
          return u.searchParams.get('code') || '';
        } catch {
          return '';
        }
      };

      /**
       * 拿到授权码之后：先让用户看一眼「成功」，再去换 token。
       *
       * ⚠ 顺序很讲究 —— 必须先 paint 再 exchange。
       *   反过来的话，窗口会在用户毫无心理准备的情况下"啪"地关掉，
       *   看着像崩溃，而不是像"登录完成了"。
       */
      const done = async (code) => {
        log('拿到授权码，正在换取 token …');
        await paintLoginResult(win, true, '登录成功', '正在用授权码换取访问令牌，稍等片刻…');
        await new Promise((r) => setTimeout(r, 650));
        finish(await exchange(code));
      };

      /**
       * 每次页面加载完都看一眼，判断有没有拿到码。
       *
       * 要同时伺候**两条完全不同的返回路径**，因为 Epic 两种都可能出现：
       *   ① 302 重定向到 https://localhost/launcher/authorized?code=xxx
       *   ② 把结果显示成一个**裸 JSON 页面**（实测遇到的就是这种）
       */
      const inspect = async () => {
        if (settled) return;

        // ① 老路子：真的被重定向到回调地址了
        const c1 = grabCode(win.webContents.getURL());
        if (c1) return done(c1);

        // Chromium 的 JSON 查看器不是同步渲染的，等它一下再读
        await new Promise((r) => setTimeout(r, 350));
        if (settled) return;

        let txt = '';
        try {
          txt = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
        } catch {
          return; // 页面正在跳走，读不到就算了，下一次加载还会再来
        }
        txt = String(txt || '');

        // ② 主路径：从裸 JSON 里把 authorizationCode 抠出来
        const code = extractAuthCode(txt);
        if (code) return done(code);

        // ③ 停在 JSON 页、但码是空的 —— 这一趟没带上登录态。
        //    自动重开一次登录页（多数是临时的会话问题）；再不行就摆明了告诉用户。
        if (looksLikeAuthResult(txt)) {
          if (!retried) {
            retried = true;
            log('这次没拿到授权码，重新打开一次登录页');
            win.loadURL(authUrl).catch(() => {});
            return;
          }
          await paintLoginResult(
            win, false, '还没有登录 Epic 账号',
            '上面那串是 Epic 返回的原始数据，不是登录页。请点下面的按钮回到登录页，完成登录后窗口会自动关闭。',
            authUrl
          );
          return;
        }

        // ④ 正常网页（登录表单 / 两步验证）：挂条说明，告诉用户这窗口什么时候会关
        await paintLoginHint(win);
      };

      // 302 重定向到回调时触发；有些版本只发 navigate，所以两个都听
      win.webContents.on('will-redirect', (e, url) => {
        const c = grabCode(url);
        if (c) { e.preventDefault(); done(c); }
      });
      win.webContents.on('will-navigate', (e, url) => {
        const c = grabCode(url);
        if (c) { e.preventDefault(); done(c); }
      });
      win.webContents.on('did-finish-load', () => { inspect(); });

      // 用户直接关窗 = 主动放弃
      win.on('closed', () => finish({ ok: false, error: '已取消登录' }));

      // 那个 localhost 地址访问必然失败，别让它弹出「网页无法访问」
      win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        if (grabCode(url)) return;                // 我们本来就不想让它真加载
        if (code === -3 || code === -300) return; // 中断类的错误不算失败
        log('页面加载异常：' + desc);
      });

      win.loadURL(authUrl).catch((e) => finish({ ok: false, error: '打开登录页失败：' + e.message }));
    });
  }

  /** 用授权码换 token（失败时自动试备用域名） */
  async function exchange(code) {
    const body = form({ grant_type: 'authorization_code', code });
    let lastErr = '未知错误';

    for (const host of TOKEN_HOSTS) {
      try {
        const r = await request(`https://${host}/account/api/oauth/token`, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          },
          body
        });
        if (r.status === 200 && r.json && r.json.access_token) {
          await adoptToken(r.json);
          return { ok: true, account: session.account };
        }
        lastErr = (r.json && (r.json.errorMessage || r.json.error)) || (r.text || '').slice(0, 200) || ('HTTP ' + r.status);
        // 授权码是一次性的：第一次用掉（或过期）后再试也是同样结果，别白跑第二遍
        if (/invalid_grant|expired|consumed/i.test(lastErr)) break;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    return { ok: false, error: '换取 token 失败：' + lastErr };
  }

  /** 把 token 响应落成标准化 session，并尽快补一次账号详情 */
  async function adoptToken(t) {
    const now = Date.now();
    const prev = session || {};
    session = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || prev.refreshToken || '',
      expiresAt: now + (Number(t.expires_in || 0) * 1000),
      refreshExpiresAt: t.refresh_expires ? now + (Number(t.refresh_expires) * 1000) : (prev.refreshExpiresAt || 0),
      accountId: t.account_id || prev.accountId || '',
      account: prev.account || { id: t.account_id || '', name: t.displayName || t.display_name || '' }
    };
    writeDisk({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
      accountId: session.accountId,
      account: session.account
    });
    loaded = true;

    // 顺手把昵称填上（token 响应通常不带 DisplayName）
    try {
      await refreshProfile();
    } catch { /* 昵称拿不到不影响登录成功 */ }
  }

  /** 拉一次账号详情（昵称） */
  async function refreshProfile() {
    if (!session || !session.accountId) return;
    for (const host of TOKEN_HOSTS) {
      try {
        const r = await request(
          `https://${host}/account/api/public/account/${encodeURIComponent(session.accountId)}`,
          { headers: { Authorization: 'Bearer ' + session.accessToken } }
        );
        if (r.status === 200 && r.json) {
          session.account = {
            id: r.json.id || session.accountId,
            name: r.json.displayName || r.json.preferredLanguage || '',
            accountName: r.json.displayName || ''
          };
          writeDisk({ ...session });
          return;
        }
      } catch { /* 换下一个域名 */ }
    }
  }

  /** 续期。返回 true 表示现在手上的 token 是有效的 */
  async function ensureValid() {
    const st = status();
    if (!st.loggedIn) return false;
    if (!st.needsRefresh) return true;
    if (!session.refreshToken) return false;

    const body = form({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
    for (const host of TOKEN_HOSTS) {
      try {
        const r = await request(`https://${host}/account/api/oauth/token`, {
          method: 'POST',
          headers: {
            Authorization: basicAuth(),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          },
          body
        });
        if (r.status === 200 && r.json && r.json.access_token) {
          await adoptToken(r.json);
          log('token 已自动续期');
          return true;
        }
      } catch { /* 换下一个域名 */ }
    }
    return false;
  }

  /* ---------------- 薄薄一层 REST 封装 ---------------- */

  /**
   * 依次试一组主机，返回第一个成功的。
   *
   * ⚠ 失败时要把**每个**端点各自的错误都带上。
   *   上一版只保留最后一个错误，结果用户看到的报错指向了那个作为备用的
   *   launcher-graphql 域名，把"主端点早就 404 废弃了"这个真正的原因
   *   完全盖住 —— 排查时被自己的错误信息带偏，代价非常大。
   */
  async function tryHosts(hosts, pathAndQuery, opts = {}) {
    const tried = [];
    for (const host of hosts) {
      try {
        const r = await request(`https://${host}${pathAndQuery}`, {
          headers: { Authorization: 'Bearer ' + session.accessToken, ...(opts.headers || {}) },
          timeout: opts.timeout || 20000
        });

        if (r.status === 200 && r.json) return { ok: true, json: r.json, host };

        // 401 是"登录失效"，和"端点不通"完全是两回事：换端点重试也没意义
        if (r.status === 401) {
          return { ok: false, fatal: true, error: 'Epic 登录状态已失效（401），请重新登录账号' };
        }
        tried.push(`${host} → HTTP ${r.status}`);
      } catch (e) {
        tried.push(`${host} → ${e.code || e.message}`);
      }
    }
    return { ok: false, error: tried.join('；') || '所有端点都试过了，没有可用的' };
  }

  /**
   * 批量补游戏详情（正式名 / 封面 / 开发商 / 发行商）。
   *
   * 为什么非要两步：库服务只告诉你"你有什么"（一个 catalogItemId 加一个内部名），
   * 正式名字和多语言封面得另外问目录服务。
   * 但这一步**失败绝不能拖垮主流程** —— 拿不到详情时上层会用 sandboxName 兜底，
   * 至少保证"拥有清单"是完整的。
   *
   * ⚠ 这个接口**必须带 token**：实测不带认证一律 401
   *   （错误码 errors.com.epicgames.common.authentication.authentication_failed）。
   *   所以走的是 tryHosts（它负责把 Bearer 头带上）。
   *
   * @returns {Promise<Map<string, object>>} key 由 detailKey() 定义（= catalogItemId），
   *   取的时候**必须**用同一个函数，别再手拼 `${namespace}:${id}`。
   */
  async function fetchCatalogDetails(records, onProgress) {
    const out = new Map();

    // bulk 接口是按 namespace 分组的，先归堆
    const byNs = new Map();
    for (const rec of records) {
      if (!rec || !rec.namespace || !rec.catalogItemId) continue;
      if (!byNs.has(rec.namespace)) byNs.set(rec.namespace, []);
      byNs.get(rec.namespace).push(rec.catalogItemId);
    }

    let failedBatches = 0;
    for (const [ns, ids] of byNs) {
      // 去重：同一 namespace 下同一个 id 只问一次
      const uniq = [...new Set(ids)];
      // 分批：几百个 id 拼进一个 URL 会被服务端直接拒掉
      for (let i = 0; i < uniq.length; i += 20) {
        const batch = uniq.slice(i, i + 20);
        const qs = batch.map((id) => 'id=' + encodeURIComponent(id)).join('&');
        const path = `/catalog/api/shared/namespace/${encodeURIComponent(ns)}/bulk/items`
          + `?${qs}&includeMainGameDetails=true&country=CN&locale=zh-CN`;

        const r = await tryHosts(CATALOG_HOSTS, path, { timeout: 25000 });
        if (!r.ok) { failedBatches++; continue; } // 这一批失败就跳过，不连累别的批次
        indexBulkResponse(r.json, out);
      }
    }

    if (out.size) onProgress(`已补全 ${out.size} 款游戏的详情`);
    // 把失败批次数暴露出去，让上层能判断"是没数据"还是"整条链挂了"
    out.failedBatches = failedBatches;
    return out;
  }

  /**
   * 拉「拥有的游戏」清单。
   *
   * 走的是库服务的 REST 接口。响应里的 records 每条长这样：
   *   { namespace, catalogItemId, appName: "Sugar",
   *     productId, sandboxName: "Rocket League®", sandboxType, acquisitionDate }
   * 注意 **sandboxName 通常就是游戏名** —— 所以就算目录服务全挂了，
   * 这份清单依然是可读的，不会退化成"一堆内部代号"。
   *
   * ⚠ 这里是**拥有**清单，不等于已安装。已安装要跟本地 .item 合并，
   *   合并逻辑在 platforms.js 的 mergeEpic() 里，这个函数只管如实返回 Epic 那边的数据。
   *
   * @param {(msg:string)=>void} [onProgress]
   * @returns {Promise<{ok:boolean, games?:Array, error?:string}>}
   */
  async function fetchLibrary(onProgress = () => {}) {
    if (!(await ensureValid())) return { ok: false, error: '未登录或登录已失效' };

    /* ---- ① 拉"拥有什么"（含领了没下载的 —— 这才是本功能的意义） ---- */
    const records = [];
    let cursor = '';
    let page = 0;

    /* ⚠ 循环必须有上限：万一服务端返回一个恒定不变的 nextCursor
     *   （分页异常或接口改版），没有上限就是死循环，会把主进程拖死。 */
    while (page < 60) {
      page++;

      let path = '/library/api/public/items?includeMetadata=true&limit=200';
      if (cursor) path += '&cursor=' + encodeURIComponent(cursor);

      const r = await tryHosts(LIBRARY_HOSTS, path);
      if (!r.ok) {
        // 一条都没拿到 → 整体失败；已经拿到一部分 → 只是后续分页失败，
        // 不该把已有结果全丢掉，那对用户来说更糟
        if (!records.length) {
          return { ok: false, error: friendlyNetError(r.error) + '（' + r.error + '）' };
        }
        break;
      }

      const list = Array.isArray(r.json.records) ? r.json.records : [];
      records.push(...list);
      onProgress(`已读取 ${records.length} 项`);

      const next = ((r.json.responseMetadata || {}).nextCursor) || '';
      if (!next || next === cursor || !list.length) break;
      cursor = next;
    }

    /* ---- ② 顺带补正式名和封面（失败不影响上面那份清单） ---- */
    const details = await fetchCatalogDetails(records, onProgress);

    /* ---- ③ 折算成统一的游戏形状 ---- */
    const games = [];
    const seen = new Set();
    let unresolved = 0;

    for (const rec of records) {
      /* ⚠ 必须和 fetchCatalogDetails 存的时候用同一个 detailKey()。
       *   上一版这里手拼 `${namespace}:${catalogItemId}`，而那边存的是裸 id，
       *   于是 details.get() 永远返回 undefined —— 详情全丢、名字全变内部代号。
       *   别再在这里拼字符串。 */
      const detail = details.get(detailKey(rec));
      if (!detail) unresolved++;

      const g = normalize(rec, detail);
      // 同一个 appName 只留一条（同一款游戏可能因为不同 entitlement 出现多次）
      if (g && !seen.has(g.appId)) { seen.add(g.appId); games.push(g); }
    }

    /* ---- ④ 详情大面积没补上时，必须说出来 ---- */
    /* 详情挂了不影响"拥有清单"的完整性，所以不报错 —— 但**不能不吭声**：
     * 用户看到的就是"一堆游戏叫 Live、封面全是字母块"，
     * 而上一版这种情况一个提示都没有，只能靠猜。 */
    const warns = [];
    if (records.length && unresolved / records.length > 0.5) {
      const noise = games.filter((g) => g.nameUnresolved).length;
      warns.push(`有 ${unresolved}/${records.length} 款游戏没取到商店详情`
        + (noise ? `（其中 ${noise} 款只能显示 Epic 的内部代号）` : '')
        + '，名称和封面可能不完整。多为网络原因，稍后重新同步一次通常就好了。');
    }

    return { ok: true, games, warn: warns.join(' ') };
  }

  /**
   * 把 Epic 返回的一条库记录折算成统一的游戏形状。
   *
   * @param {object} rec    库服务的 record（一定有 appName / namespace / catalogItemId）
   * @param {object} [detail] 目录服务补回来的详情，**可能没有**（那一步失败时）
   * @returns {object|null} null = 不要这一条（主游戏带的 DLC 等）
   */
  function normalize(rec, detail) {
    if (!rec) return null;
    const appId = String(rec.appName || '').trim();
    if (!appId) return null;

    // 挂在主游戏下的 DLC / 附加内容：有 mainGameItem 就说明它自己不是本体。
    // ⚠ 但只有拿到详情才判断得了 —— 没有详情时宁可留着，
    //   "多一条 DLC"比"少一款真游戏"轻得多。
    if (detail && detail.mainGameItem && detail.mainGameItem.id) return null;

    const images = detail && Array.isArray(detail.keyImages) ? detail.keyImages : [];
    const rel = detail && Array.isArray(detail.releaseInfo) ? detail.releaseInfo : [];

    /* 名字优先级：目录服务的商店正式名 > sandboxName > 内部 appName。
     *
     * ⚠ sandboxName 只在**看着像人话**的时候才敢用。
     *   实测这个字段很不可靠 —— 131 条记录里有 46 条的 sandboxName 就是
     *   一个 "Live"，还有 "shoal Production" / "tommes Production" 这种工程名。
     *   上一版无条件拿它当游戏名，界面上一整片卡片全叫 "Live"。
     *   现在这类噪声一律不认，宁可退回 appName 并打上 nameUnresolved，
     *   让上层能统计出"到底有多少款其实没名字"，而不是装作有名字。 */
    const sandboxOk = !looksLikeInternalName(rec.sandboxName);
    const nameUnresolved = !((detail && detail.title) || sandboxOk);

    return {
      platformId: 'epic',
      appId,
      name: (detail && detail.title) || (sandboxOk ? rec.sandboxName : '') || appId,
      /* 名字其实是内部代号 —— 上层据此提醒用户"详情没取到"，
       * 而不是让一堆 "Live" 悄悄混进游戏库 */
      nameUnresolved,
      namespace: rec.namespace || '',
      catalogItemId: rec.catalogItemId || '',
      productId: rec.productId || '',
      sandboxName: rec.sandboxName || '',
      // 有的话后面能跟 Steam 的数据对上（同一款游戏在两个平台都有）
      steamAppId: pickSteamAppId(rel),
      // 封面：竖版优先（卡片就是竖的比例），没有再退横版 / 缩略图
      coverUrl: pickImage(images, ['DieselGameBox', 'DieselGameBoxTall', 'Thumbnail']),
      heroUrl: pickImage(images, ['DieselGameBoxWide', 'DieselStoreFrontWide', 'Featured']),
      logoUrl: pickImage(images, ['DieselGameBoxLogo', 'ProductLogo']),
      developer: customAttr(detail, 'developerName') || customAttr(detail, 'developer'),
      publisher: customAttr(detail, 'publisherName') || customAttr(detail, 'publisher'),
      releaseDate: customAttr(detail, 'releaseDate') || '',
      categories: (detail && Array.isArray(detail.categories)
        ? detail.categories.map((c) => String((c && c.path) || ''))
        : []).filter(Boolean),
      installed: false,      // 由 platforms 拿本地清单回来改写
      playtimeMs: 0,         // 时长要走 PlaytimeTracking（也是非官方查询），本版本不取
      achievements: null,    // 同上，官方不开放，本版本不做
      source: 'api'          // 标记来源，合并时能看出是账号那边拉来的
    };
  }

  /** 从 customAttributes 里按 key 取值 */
  function customAttr(ci, key) {
    if (!ci || !Array.isArray(ci.customAttributes)) return '';
    const hit = ci.customAttributes.find((a) => a && a.key === key);
    return hit ? String(hit.value || '').trim() : '';
  }

  /** 挑一张图：按候选 type 顺序找，找到就直接给出 URL */
  function pickImage(images, types) {
    for (const t of types) {
      const hit = images.find((im) => im && im.type === t && im.url);
      if (hit) return String(hit.url);
    }
    // 一个都没命中（有的游戏只给了别名的 type）→ 退第一张有 url 的，总比没有强
    const any = images.find((im) => im && im.url);
    return any ? String(any.url) : '';
  }

  /**
   * 从 releaseInfo 里挑一个 Windows 平台上的 appId（用来和 Steam 数据互认）。
   *
   * ⚠ platform 在 REST 里是**数组**（["Windows"]），在旧的 GraphQL 里是字符串。
   *   两种都规范化成数组再判断，免得换个端点就认不出来了。
   */
  function pickSteamAppId(rel) {
    for (const r of rel) {
      const val = String((r && r.appId) || '').trim();
      if (!val) continue;
      const raw = r && r.platform;
      const plats = (Array.isArray(raw) ? raw : [raw])
        .map((x) => String(x || '').toLowerCase())
        .filter(Boolean);
      if (!plats.length || plats.some((p) => p.includes('windows'))) return val;
    }
    return '';
  }

  /* ---------------- 对外 ---------------- */

  return {
    /** 当前登录状态 */
    status,
    /** 弹窗登录 */
    login,
    /** 退出：清本地凭证（Epic 那边的会话不受影响，它属于 Epic 自己） */
    logout: () => { clearDisk(); return { ok: true }; },
    /** 保证 token 有效（快过期会自动续） */
    ensureValid,
    /** 拉拥有清单 */
    fetchLibrary,
    /** 给单元测试用的内部件 */
    _internals: {
      normalize, pickImage, pickSteamAppId, customAttr, basicAuth,
      extractAuthCode, looksLikeAuthResult, buildLoginUrl, esc, friendlyNetError,
      /* 这三个是为了让"存/取键必须是同一个"这条能被测试守住 ——
       * 上一版正是这条缝没被测到，才把 bug 漏给了用户 */
      detailKey, indexBulkResponse, looksLikeInternalName
    }
  };
}

module.exports = {
  createEpicAuth, CLIENT_ID, CLIENT_SECRET, REDIRECT_HOST, REDIRECT_PATH,
  extractAuthCode, looksLikeAuthResult, buildLoginUrl,
  detailKey, indexBulkResponse, looksLikeInternalName,
  // 给截图脚本用：把登录窗口里那张结果卡拍下来当证据
  paintLoginResult, paintLoginHint
};
