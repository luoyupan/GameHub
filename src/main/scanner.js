/**
 * ============================================================
 *  GameHub - 游戏嗅探扫描模块  (src/main/scanner.js)
 * ------------------------------------------------------------
 *  纯 Node 模块（不依赖 Electron），负责从本机各处"嗅探"游戏：
 *
 *   ① scanRegistry()  读注册表卸载项   —— 覆盖 90% 的已安装游戏，带安装日期
 *   ② scanSteam()     解析 Steam 库     —— libraryfolders.vdf + appmanifest_*.acf
 *   ③ scanEpic()      解析 Epic 清单    —— ProgramData 下的 .item JSON
 *   ④ scanFolder()    递归扫描文件夹    —— 用户指定目录的智能嗅探
 *   ⑤ sniffAll()      统一入口，汇总去重
 *
 *  设计原则：所有耗时操作都支持"取消"与"进度回调"，
 *           扫描过程绝不阻塞主进程，结果交给用户勾选确认。
 * ============================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');
const classify = require('./classify');

/* ==================================================================
 *  0. 通用小工具
 * ================================================================== */

/**
 * Promise 化的 execFile，自动隐藏黑窗口。
 * 注意：某些安全策略 / 系统精简环境下，execFile 可能在"同步阶段"就抛错
 *      （例如 spawn EPERM），因此这里必须整体包一层 try/catch，
 *      保证扫描流程永远不会因为一个外部命令不可用而整个崩掉。
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout ? String(stdout) : '', stderr: stderr ? String(stderr) : '' });
      });
    } catch (e) {
      resolve({ err: e, stdout: '', stderr: String(e && e.message) });
    }
  });
}

/** 判断路径是否存在 */
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** 安全 stat，出错返回 null */
async function safeStat(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

/**
 * 推算安装日期。
 * 注册表的 InstallDate / Steam 的 LastUpdated 都不一定可靠，
 * 而「安装目录的创建时间」通常就是这款游戏出现在这块磁盘上的时间，
 * 所以优先用它，取不到再退回给定的时间戳。
 * @param {fs.Stats|null} st 安装目录的 stat
 * @param {number} fallback 备用时间戳
 */
function resolveInstallDate(st, fallback = 0) {
  if (st) {
    const t = st.birthtimeMs || st.ctimeMs || 0;
    // 过滤掉明显不合理的值（1970 年的 0、或者未来时间）
    if (t > 315532800000 && t < Date.now() + 86400000) return t;
  }
  return fallback || 0;
}

/** 生成一个稳定的唯一 ID（同一路径永远得到同一个 ID，便于去重合并） */
function stableId(str) {
  return crypto.createHash('md5').update(String(str).toLowerCase()).digest('hex').slice(0, 16);
}

/** 把可能带引号 / 带逗号参数的路径清理成纯路径 */
function cleanPath(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // 形如 "C:\Game\a.exe" ,0  或  C:\Game\a.exe /arg
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end > 0) s = s.slice(1, end);
  } else {
    s = s.split(',')[0];
    // 去掉可执行文件后面的启动参数
    const m = s.match(/^(.+?\.(exe|bat|cmd|lnk))\s/i);
    if (m) s = m[1];
  }
  return s.trim();
}

/* ==================================================================
 *  1. 注册表扫描
 * ================================================================== */

/**
 * 用 `reg export` 把整个卸载项分支导出成 .reg 文件再解析。
 * 相比逐个 `reg query`，一次调用就能拿到成千上万条记录，速度极快。
 */
async function exportRegKey(rootKey, outFile) {
  const { err } = await run('reg', ['export', rootKey, outFile, '/y']);
  if (err) return null;
  const buf = await fsp.readFile(outFile).catch(() => null);
  if (!buf) return null;
  // Windows 的 reg export 默认输出 UTF-16LE，带 BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** 解析 .reg 文本 → [{ key, values }] */
function parseRegFile(text) {
  if (!text) return [];
  const rawLines = text.split(/\r?\n/);
  // 处理 .reg 的续行（行尾反斜杠）
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    while (line.endsWith('\\') && i + 1 < rawLines.length) {
      line = line.slice(0, -1) + rawLines[++i].trim();
    }
    lines.push(line.trim());
  }

  const out = [];
  let cur = null;
  for (const line of lines) {
    if (!line || line.startsWith(';') || /^Windows Registry Editor/i.test(line)) continue;
    if (line.startsWith('[')) {
      cur = { key: line.replace(/^\[/, '').replace(/\]$/, ''), values: {} };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$/);
    if (!m) continue;
    const name = unescapeReg(m[1]);
    const raw = m[2].trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      cur.values[name] = unescapeReg(raw.slice(1, -1));
    } else if (/^dword:/i.test(raw)) {
      cur.values[name] = parseInt(raw.slice(6), 16);
    } else if (/^hex(\([0-9a-f]\))?:/i.test(raw)) {
      // hex(2) = REG_EXPAND_SZ，按 UTF-16LE 解回来
      const hexStr = raw.replace(/^hex(\([0-9a-f]\))?:/i, '').replace(/\\/g, '').replace(/[^0-9a-f]/gi, '');
      try {
        const b = Buffer.from(hexStr, 'hex');
        const s = b.toString('utf16le').replace(/\u0000+$/, '').replace(/\u0000/g, '');
        if (s) cur.values[name] = s;
      } catch { /* 忽略解码失败 */ }
    }
  }
  return out;
}

/** .reg 字符串反转义： \\ → \ ，\" → " */
function unescapeReg(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === '\\') { out += '\\'; i++; continue; }
      if (n === '"') { out += '"'; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

/** 把 "20240115" 这种注册表日期解析成时间戳 */
function parseRegDate(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) {
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 注册表扫描的「备用通道」：用 PowerShell 读。
 *
 * 什么时候会用到：
 *   有些安全软件 / 企业策略会禁用 reg.exe，导致主通道一条都读不到。
 *   这时改用 PowerShell 的 Get-ItemProperty 再试一次，能救回绝大部分场景。
 *
 * 安全性：整个函数包在 try/catch 里，任何异常都只返回空数组，
 *        绝不会影响主流程，最差也就是"跟主通道一样啥也没扫到"。
 */
async function scanRegistryViaPowerShell(onProgress = () => {}) {
  onProgress({ phase: 'registry', message: '备用通道：使用 PowerShell 读取注册表 …' });

  // 脚本要点：
  //  1. 三个分支都读（64 位 / 32 位 / 当前用户）
  //  2. 输出强制 UTF-8，避免中文游戏名乱码
  //  3. 用 ConvertTo-Json 一次性吐出来，Node 侧直接 JSON.parse
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$out = @()
foreach ($r in $roots) {
  if (Test-Path $r) {
    Get-ChildItem $r -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($p -ne $null -and $p.DisplayName) {
        $out += [pscustomobject]@{
          name            = [string]$p.DisplayName
          publisher       = [string]$p.Publisher
          version         = [string]$p.DisplayVersion
          installLocation = [string]$p.InstallLocation
          displayIcon     = [string]$p.DisplayIcon
          sizeKB          = [int]($p.EstimatedSize)
          installDate     = [string]$p.InstallDate
          steamAppId      = [string]$p.'Steam AppId'
        }
      }
    }
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
`;

  let stdout = '';
  try {
    const r = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout || '';
  } catch {
    return [];
  }

  const text = stdout.trim();
  if (!text) return [];

  let arr = [];
  try {
    const parsed = JSON.parse(text);
    arr = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }

  const results = [];
  for (const item of arr) {
    try {
      const name = String(item.name || '').trim();
      if (!name) continue;
      let installLocation = cleanPath(item.installLocation || '');
      const iconRaw = cleanPath(item.displayIcon || '');
      let exePath = iconRaw && /\.exe$/i.test(iconRaw) ? iconRaw : '';
      if (!installLocation && exePath) installLocation = path.dirname(exePath);

      const entry = {
        name,
        publisher: String(item.publisher || '').trim(),
        version: String(item.version || '').trim(),
        installLocation,
        exePath,
        sizeKB: Number(item.sizeKB || 0) || 0,
        installDate: parseRegDate(item.installDate || ''),
        steamAppId: item.steamAppId || '',
        regKey: 'powershell'
      };

      const { score, reasons } = classify.scoreRegistryEntry(entry);
      if (score < classify.CANDIDATE_THRESHOLD) continue;

      results.push({
        id: stableId(installLocation || name),
        name: entry.name,
        publisher: entry.publisher,
        version: entry.version,
        installDir: installLocation,
        exePath,
        sizeBytes: entry.sizeKB > 0 ? entry.sizeKB * 1024 : 0,
        // 注册表没有 InstallDate 时，用安装目录的创建时间补上
        installDate: resolveInstallDate(await safeStat(installLocation), entry.installDate),
        steamAppId: entry.steamAppId ? String(entry.steamAppId) : '',
        source: 'registry',
        sourceLabel: '注册表',
        confidence: score,
        reasons: [...reasons, '备用通道读取'],
        categories: classify.classify(`${entry.name} ${installLocation}`)
      });
    } catch { /* 单条数据有问题就跳过 */ }
  }
  return results;
}

/**
 * 扫描注册表：三个分支 × 每个 hive，找出所有"像游戏"的已安装程序。
 * @param {(o:object)=>void} onProgress
 * @param {() => boolean} isCancelled
 */
async function scanRegistry(onProgress = () => {}, isCancelled = () => false) {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];

  const tmpDir = os.tmpdir();
  const results = [];

  for (const root of roots) {
    if (isCancelled()) break;
    onProgress({ phase: 'registry', message: `读取注册表：${root.split('\\').pop()} …` });
    const outFile = path.join(tmpDir, `gamehub_reg_${Date.now()}_${Math.random().toString(36).slice(2)}.reg`);
    const text = await exportRegKey(root, outFile);
    await fsp.unlink(outFile).catch(() => {});
    if (!text) continue;

    const entries = parseRegFile(text);
    for (const e of entries) {
      if (isCancelled()) break;
      const v = e.values;
      const name = v.DisplayName || v.QuietDisplayName;
      if (!name) continue;

      let installLocation = cleanPath(v.InstallLocation || '');
      const displayIconRaw = cleanPath(v.DisplayIcon || '');
      let exePath = displayIconRaw && /\.exe$/i.test(displayIconRaw) ? displayIconRaw : '';

      // 没有安装路径时，用 DisplayIcon 反推目录
      if (!installLocation && exePath) installLocation = path.dirname(exePath);

      const entry = {
        name: String(name).trim(),
        publisher: String(v.Publisher || '').trim(),
        version: String(v.DisplayVersion || '').trim(),
        installLocation,
        exePath,
        sizeKB: Number(v.EstimatedSize || 0) || 0,
        installDate: parseRegDate(v.InstallDate),
        steamAppId: v['Steam AppId'] || v['Steam AppID'] || '',
        uninstall: String(v.UninstallString || '').trim(),
        regKey: e.key
      };

      const { score, reasons } = classify.scoreRegistryEntry(entry);
      if (score < classify.CANDIDATE_THRESHOLD) continue; // 分数不够 → 大概率不是游戏

      results.push({
        id: stableId(installLocation || name),
        name: entry.name,
        publisher: entry.publisher,
        version: entry.version,
        installDir: installLocation,
        exePath,
        sizeBytes: entry.sizeKB > 0 ? entry.sizeKB * 1024 : 0,
        // 注册表没有 InstallDate 时，用安装目录的创建时间补上
        installDate: resolveInstallDate(await safeStat(installLocation), entry.installDate),
        steamAppId: entry.steamAppId ? String(entry.steamAppId) : '',
        source: 'registry',
        sourceLabel: '注册表',
        confidence: score,
        reasons,
        categories: classify.classify(`${entry.name} ${entry.installLocation}`)
      });
    }
  }

  // 主通道一条都没读到 → 大概率是 reg.exe 被安全策略拦了，走备用通道再试一次
  if (!results.length && !isCancelled()) {
    try {
      const fallback = await scanRegistryViaPowerShell(onProgress);
      if (fallback.length) {
        onProgress({ phase: 'registry', message: `备用通道补回 ${fallback.length} 条记录` });
        results.push(...fallback);
      }
    } catch { /* 备用通道失败就算了，不影响整体扫描 */ }
  }

  return results;
}

/* ==================================================================
 *  2. Steam 库扫描
 * ================================================================== */

/** 极简 VDF 解析器（Steam 的配置全是这种格式） */
function parseVdf(text) {
  let i = 0;
  const n = text.length;
  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };
  const readStr = () => {
    if (text[i] !== '"') return null;
    i++;
    let s = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) { i++; s += text[i]; } else s += text[i];
      i++;
    }
    i++;
    return s;
  };
  const parseObj = () => {
    const obj = {};
    while (i < n) {
      skipWs();
      if (text[i] === '}') { i++; break; }
      if (text[i] === '"') {
        const key = readStr();
        skipWs();
        if (text[i] === '{') { i++; obj[key] = parseObj(); }
        else { obj[key] = readStr(); }
      } else i++;
    }
    return obj;
  };
  skipWs();
  if (text[i] === '"') {
    const rootKey = readStr();
    skipWs();
    if (text[i] === '{') { i++; return { [rootKey]: parseObj() }; }
  }
  i = 0;
  return parseObj();
}

/** 找出所有 Steam 库目录（steamapps 所在路径） */
async function findSteamLibraries(onProgress = () => {}, extraLibraries = []) {
  const libs = new Set();

  // ① 从注册表拿 Steam 安装位置
  const { stdout } = await run('reg', ['query', 'HKCU\\SOFTWARE\\Valve\\Steam', '/v', 'InstallPath']);
  const m = stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i);
  const candidates = [];
  if (m) candidates.push(m[1].trim());

  // ② 遍历所有盘符找常见的 Steam 库目录
  //    （早先这里只写死了 C~H 盘，结果 I:\steam 这种自定义位置的库会被整个漏掉，
  //      所以改成把 26 个盘符都探一遍 —— 只是几个 fs.access 调用，开销可以忽略）
  const driveLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const tails = [
    '\\Program Files (x86)\\Steam',
    '\\Program Files\\Steam',
    '\\Steam',
    '\\SteamLibrary',
    '\\steam',
    '\\Games\\Steam',
    '\\Games\\SteamLibrary',
    '\\Program Files (x86)\\SteamLibrary'
  ];
  for (const d of driveLetters) {
    for (const t of tails) {
      candidates.push(`${d}:${t}`);
    }
  }

  for (const c of candidates) {
    if (!c) continue;
    try {
      if (await exists(path.join(c, 'steamapps'))) libs.add(path.normalize(c).replace(/[\\/]+$/, ''));
    } catch { /* 盘符不存在、无权限，跳过 */ }
  }

  // ③ 由上游传入的线索（从注册表里扫到的 steamapps 路径反推出来的库根目录）
  //    这条最关键：装在 I:\steam 这种非常规位置的库，靠前面的固定路径是猜不到的
  for (const c of extraLibraries || []) {
    if (!c) continue;
    try {
      if (await exists(path.join(c, 'steamapps'))) libs.add(path.normalize(c).replace(/[\\/]+$/, ''));
    } catch { /* 忽略 */ }
  }

  // ④ 读 libraryfolders.vdf 里登记的其它磁盘库
  for (const base of [...libs]) {
    const vdfPath = path.join(base, 'steamapps', 'libraryfolders.vdf');
    const confPath = path.join(base, 'config', 'libraryfolders.vdf');
    for (const p of [vdfPath, confPath]) {
      if (!(await exists(p))) continue;
      const txt = await fsp.readFile(p, 'utf8').catch(() => '');
      if (!txt) continue;
      const obj = parseVdf(txt);
      const lf = obj.libraryfolders || obj.LibraryFolders || {};
      for (const key of Object.keys(lf)) {
        const v = lf[key];
        const p2 = typeof v === 'string' ? v : v && v.path;
        if (p2 && await exists(path.join(p2, 'steamapps'))) libs.add(path.normalize(p2));
      }
    }
  }

  onProgress({ phase: 'steam', message: `发现 ${libs.size} 个 Steam 库` });
  return [...libs];
}

/**
 * 从一批游戏记录里反推 Steam 库根目录。
 * 只要路径里出现 ...\steamapps\... ，它前面那段就是库根目录。
 * @param {Array} games
 * @returns {string[]}
 */
function extractSteamLibraries(games) {
  const libs = new Set();
  for (const g of games || []) {
    const p = g.installDir || g.exePath || '';
    const m = String(p).match(/^(.*?)[\\/]steamapps([\\/]|$)/i);
    if (m && m[1]) libs.add(path.normalize(m[1]));
  }
  return [...libs];
}

/** 扫描 Steam：解析每个库里的 appmanifest_*.acf */
async function scanSteam(onProgress = () => {}, isCancelled = () => false, extraLibraries = []) {
  const libs = await findSteamLibraries(onProgress, extraLibraries);
  const results = [];

  for (const lib of libs) {
    if (isCancelled()) break;
    const sa = path.join(lib, 'steamapps');
    let files = [];
    try { files = await fsp.readdir(sa); } catch { continue; }
    const manifests = files.filter((f) => /^appmanifest_\d+\.acf$/i.test(f));

    for (const mf of manifests) {
      if (isCancelled()) break;
      const txt = await fsp.readFile(path.join(sa, mf), 'utf8').catch(() => '');
      if (!txt) continue;
      const obj = parseVdf(txt).AppState || {};
      const appid = String(obj.appid || '');
      const name = obj.name || '';
      const installdir = obj.installdir || '';
      if (!appid || !name || !installdir) continue;
      // 只收"状态为已安装"(StateFlags 4) 的
      if (obj.StateFlags && Number(obj.StateFlags) !== 4) continue;

      const gameDir = path.join(sa, 'common', installdir);
      if (!(await exists(gameDir))) continue;

      // 过滤掉「在 Steam 上架但不是游戏」的条目（运行库 / 壁纸工具 / 性能测试等）
      if (classify.isKnownNonGameTitle(name)) continue;

      const exe = await pickExeInDir(gameDir, 2);
      const st = await safeStat(gameDir);

      results.push({
        id: stableId(appid),
        name,
        publisher: 'Steam',
        version: '',
        installDir: gameDir,
        exePath: exe ? exe.path : '',
        sizeBytes: Number(obj.SizeOnDisk || 0),
        // 安装日期：优先用游戏目录的创建时间（更接近"我是什么时候装的"），
        // 拿不到再退回 acf 里的 LastUpdated（那是"最后更新时间"）。
        installDate: resolveInstallDate(st, Number(obj.LastUpdated || 0) * 1000),
        lastUpdated: Number(obj.LastUpdated || 0) * 1000,
        steamAppId: appid,
        source: 'steam',
        sourceLabel: 'Steam',
        confidence: 10,
        reasons: ['Steam 库清单'],
        categories: classify.classify(`${name} ${installdir}`),
        // Steam 库的标准封面地址（联网时可用来自动补图）
        steamCoverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`
      });
    }
  }
  return results;
}

/* ==================================================================
 *  3. Epic 清单扫描
 * ================================================================== */

async function scanEpic(onProgress = () => {}, isCancelled = () => false) {
  const results = [];
  const manifestDirs = [
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
    'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat'
  ];

  onProgress({ phase: 'epic', message: '检查 Epic 游戏库 …' });

  for (const dir of manifestDirs) {
    if (isCancelled()) break;
    const st = await safeStat(dir);
    if (!st) continue;

    if (st.isFile()) {
      // LauncherInstalled.dat：一个大 JSON，包含所有 Epic 游戏
      const json = JSON.parse(await fsp.readFile(dir, 'utf8').catch(() => '{}')) || {};
      for (const item of json.InstallationList || []) {
        const loc = item.InstallLocation;
        if (!loc) continue;
        const name = item.AppName || path.basename(loc);
        const exe = await pickExeInDir(loc, 2);
        results.push({
          id: stableId(item.AppName || loc),
          name: name.replace(/-[A-Za-z0-9]{20,}$/, '').replace(/_/g, ' '),
          publisher: 'Epic Games',
          version: item.AppVersion || '',
          installDir: loc,
          exePath: exe ? exe.path : '',
          sizeBytes: 0,
          installDate: 0,
          steamAppId: '',
          source: 'epic',
          sourceLabel: 'Epic',
          confidence: 9,
          reasons: ['Epic 清单'],
          categories: classify.classify(name)
        });
      }
      continue;
    }

    // 目录：每个 .item 是一个 json
    let files = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.item'))) {
      if (isCancelled()) break;
      const json = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8').catch(() => '{}')) || {};
      const loc = json.InstallLocation;
      if (!loc) continue;
      const name = json.DisplayName || json.AppName || path.basename(loc);
      const exe = await pickExeInDir(loc, 2);
      results.push({
        id: stableId(json.AppName || loc),
        name,
        publisher: 'Epic Games',
        version: json.AppVersion || '',
        installDir: loc,
        exePath: exe ? exe.path : '',
        sizeBytes: Number(json.InstallSize || 0),
        installDate: json.InstallDate ? Date.parse(json.InstallDate) || 0 : 0,
        steamAppId: '',
        source: 'epic',
        sourceLabel: 'Epic',
        confidence: 9,
        reasons: ['Epic 清单'],
        categories: classify.classify(name)
      });
    }
  }
  return results;
}

/* ==================================================================
 *  4. 文件夹扫描
 * ================================================================== */

/**
 * 【技术目录名】—— 这些目录是"某个游戏身上的零件"，本身不可能是独立的一款游戏。
 *
 * 为什么需要这个名单：
 *   `SomeGame\Binaries\Win64\SomeGame-Win64-Shipping.exe` 这种结构里，
 *   `Win64` 目录里的 exe 有 180MB、名字里还带着 `SomeGame`，
 *   按"体积大 + 名字相近"两把尺子量，`Win64` 会被误判成一款游戏。
 *   但它显然只是上层《SomeGame》的零件。
 */
const TECH_DIR_RE = /^(bin|binaries|bin32|bin64|win32|win64|x86|x64|system|system32|syswow64|engine|core|data|content|assets|resources|media|movies|video|audio|sound|music|fonts|shaders|lib|libs|library|modules|plugins|runtime|jre|java|python|node|dotnet|tools?|utils?|helper|support|redist|_commonredist|directx|vcredist|sdk|src|source|docs?|manual|readme|launcher|crashpad|logs?|saves?|config|settings|profiles?|temp|tmp|cache|game_?data|unityplayer)$/i;

/**
 * 判定"子目录里的一个 exe 算不算像样的主程序"的体积门槛。
 * 取 2MB：既能把真正的游戏主程序算进来，又能把 `helper.exe` / `updater.exe`
 * 这种几百 KB 的小工具排除掉，避免它们把父目录误判成"合集"。
 */
const MIN_SUB_EXE = 2 * 1048576;

/**
 * 【合集目录检测】的核心信号。
 *
 * 一款游戏的 exe 只会集中在**一个**子目录里（`Game\bin\Game.exe`），或者干脆直接
 * 放在根目录（`Game\Game.exe`）。而"一堆游戏躺在一个文件夹里"的典型长相是
 * **主程序分散在 2 个以上不同的一级子目录**里 —— 这正是用户 F:\r24 那种情形。
 *
 * @param {Array<{path:string,size:number}>} exes collectExes 的结果
 * @param {string} dir 当前目录
 * @returns {{strong:{key:string,name:string,size:number}[], strongCount:number,
 *            rootMax:number, maxChild:number}}
 *          strong      有"像样主程序"的一级子目录（按体积降序）
 *          rootMax     直接放在本目录下的最大 exe（>0 说明"自己也有东西"）
 */
function mainExeChildGroups(exes, dir) {
  const byChild = new Map();   // 一级子目录名(小写) → { name, size }
  let rootMax = 0;

  for (const e of exes) {
    const rel = path.relative(dir, e.path);
    const seg = rel.split(path.sep).filter(Boolean);
    if (seg.length < 2) {
      // 直接躺在本目录里 → 属于"自己的内容"
      if (e.size > rootMax) rootMax = e.size;
      continue;
    }
    const name = seg[0];
    const key = name.toLowerCase();
    const cur = byChild.get(key);
    if (!cur) byChild.set(key, { name, size: e.size });
    else if (e.size > cur.size) cur.size = e.size;
  }

  const strong = [...byChild.entries()]
    .filter(([, v]) => v.size >= MIN_SUB_EXE)
    .map(([key, v]) => ({ key, name: v.name, size: v.size }))
    .sort((a, b) => b.size - a.size);

  return {
    strong,
    strongCount: strong.length,
    rootMax,
    maxChild: strong.length ? strong[0].size : 0
  };
}

/**
 * 一个（一级）子目录自己像不像"一款游戏"。
 * 只在"当前目录只有一个子目录"这种暧昧情况下才调用，开销很小（只往下看一层）。
 */
async function childLooksLikeGame(subDir, isCancelled = () => false) {
  if (TECH_DIR_RE.test(path.basename(subDir))) return false;
  const exes = await collectExes(subDir, 1, isCancelled);
  if (!exes.length) return false;
  const pick = classify.pickMainExe(exes, path.basename(subDir));
  return pick.score >= classify.CANDIDATE_THRESHOLD;
}

/** 扫描时要跳过的目录名（系统 / 缓存 / 开发目录） */
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'winsxs', 'node_modules',
  '__pycache__', '.git', '.svn', '.idea', '.vscode', 'temp', 'tmp',
  'package cache', 'installer', 'crashdumps', 'logs', 'shadercache', 'userdata',
  'steamapps', 'appdata', 'programdata', 'recovery', 'perflogs', 'msocache',
  'onedrivetemp', 'assembly', 'driverstore', 'servicing', 'driver', 'drivers',
  'vcredist', 'directx', 'redist', 'redistributable', 'support', 'docs', 'documentation'
]);

/** 递归收集目录下所有 exe（含大小、相对层级、是否在根） */
async function collectExes(dir, maxDepth, isCancelled = () => false) {
  const out = [];
  async function walk(cur, depth) {
    if (isCancelled()) return;
    let items = [];
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(cur, it.name);
      if (it.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (SKIP_DIRS.has(it.name.toLowerCase())) continue;
        await walk(full, depth + 1);
      } else if (/\.exe$/i.test(it.name)) {
        const st = await safeStat(full);
        if (st) out.push({ path: full, name: it.name, size: st.size, mtime: st.mtimeMs, depth });
      }
    }
  }
  await walk(dir, 0);
  return out;
}

/** 只扫一层目录，收集 exe（用于 subfolder 模式，速度快） */
async function collectExesShallow(dir, maxDepth, isCancelled) {
  return collectExes(dir, maxDepth, isCancelled);
}

/**
 * 快速称重：有上限地估算目录体积，用于判断"这个目录像不像一个装了游戏的目录"。
 * 最多遍历 maxEntries 个文件 / 最多 maxMs 毫秒，超了就直接当"很大"处理。
 */
async function quickDirWeight(dir, maxEntries = 2500, maxMs = 350) {
  const t0 = Date.now();
  let bytes = 0;
  let count = 0;
  let truncated = false;
  let bigFile = 0;

  async function walk(cur, depth) {
    if (count >= maxEntries || Date.now() - t0 > maxMs) { truncated = true; return; }
    let items = [];
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (count >= maxEntries || Date.now() - t0 > maxMs) { truncated = true; return; }
      const full = path.join(cur, it.name);
      if (it.isDirectory()) {
        if (depth >= 4) continue;
        if (SKIP_DIRS.has(it.name.toLowerCase())) continue;
        await walk(full, depth + 1);
      } else {
        const st = await safeStat(full);
        if (st) { bytes += st.size; count++; if (st.size > bigFile) bigFile = st.size; }
      }
    }
  }
  await walk(dir, 0);
  return { bytes, count, truncated, bigFile };
}

/**
 * 判断一个目录是不是"游戏根目录"。
 * @returns {Promise<{isGame:boolean, exe:object|null, score:number, reasons:string[]}>}
 */
async function evaluateGameDir(dir, isCancelled = () => false) {
  const folderName = path.basename(dir);

  /* ---------- 前置否定：技术目录永远是"零件"，不是一款游戏 ---------- */
  if (TECH_DIR_RE.test(folderName)) {
    return { isGame: false, exe: null, score: -99, reasons: ['技术目录（属于外层游戏）'] };
  }

  const exes = await collectExes(dir, 2, isCancelled);
  if (!exes.length) return { isGame: false, exe: null, score: -99, reasons: ['无 exe'] };

  const grp = mainExeChildGroups(exes, dir);

  /* ==================================================================
   *  ★ 合集目录检测（修 "F:\r24 被当成一款游戏" 的根因）
   *
   *  老版本的致命缺陷：打分时把【子孙的体积和 exe】也算进了"这个目录像不像游戏"，
   *  于是只要子目录里塞着几个大游戏，父文件夹自己就会被判成游戏并吃掉它们
   *  （表现为：20 个游戏只扫出 1 条，名字还是父文件夹名）。
   *
   *  现在先问一句"这个目录【自己】是不是一款游戏"：
   *   · 主程序散落在 2 个以上子目录里 → 这是"一堆游戏的家"，不是游戏 → 继续下钻
   *   · 自己根目录没东西、唯一的子目录本身就是一款完整游戏 → 也是"家" → 继续下钻
   * ================================================================== */
  if (grp.strongCount >= 2) {
    return {
      isGame: false, exe: null, score: -99, container: true, childCount: grp.strongCount,
      reasons: [`子目录里有 ${grp.strongCount} 个独立程序，判定为合集目录`]
    };
  }

  if (grp.strongCount === 1 && grp.rootMax < MIN_SUB_EXE) {
    const only = grp.strong[0];
    if (await childLooksLikeGame(path.join(dir, only.name), isCancelled)) {
      return {
        isGame: false, exe: null, score: -99, container: true, childCount: 1,
        reasons: [`下层「${only.name}」本身就是一款游戏，判定为合集目录`]
      };
    }
  }

  const pick = classify.pickMainExe(exes, folderName);
  let score = pick.score;
  const reasons = [...pick.reasons];

  // 只有在"自己就是游戏根"时才奖励体积。
  // 合集目录在上面已经 return 了，所以这里不会再被"子孙很大"刷分。
  // 另外：主程序埋得很深（>2 层）时，体积分不能算，否则又把子目录的重量算到自己头上。
  if (pick.exe && pick.exe.depth > 2) score -= 2;

  // 引擎指纹：见到这些基本就是游戏
  const names = new Set(exes.map((e) => e.name.toLowerCase()));
  const subDirs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const subNames = subDirs.filter((d) => d.isDirectory()).map((d) => d.name.toLowerCase());
  if (subNames.some((d) => /(_data|engine|binaries|content|paks)$/.test(d))) { score += 3; reasons.push('含引擎数据目录'); }
  if (names.has('unityplayer.dll')) { score += 2; reasons.push('Unity 游戏'); }
  if (subNames.some((d) => d === 'paks' || d === 'content')) { score += 1; }

  // 体积权重（快速估算，避免全盘遍历卡死）
  const w = await quickDirWeight(dir);
  const mb = w.bytes / 1048576;
  if (mb > 3000) { score += 5; reasons.push('体积 > 3GB'); }
  else if (mb > 800) { score += 4; reasons.push('体积 > 800MB'); }
  else if (mb > 200) { score += 2; reasons.push('体积 > 200MB'); }
  else if (mb > 60) { score += 1; }
  else if (mb < 10 && !w.truncated) { score -= 3; reasons.push('体积过小'); }
  if (w.bigFile > 100 * 1048576) { score += 2; reasons.push('含超大资源文件'); }

  return { isGame: score >= 6, exe: pick.exe, score, reasons, weight: w };
}

/** 在目录里挑一个最像主程序的 exe（简化版，用于 Steam/Epic 反查） */
async function pickExeInDir(dir, maxDepth = 2) {
  const exes = await collectExes(dir, maxDepth);
  if (!exes.length) return null;
  const pick = classify.pickMainExe(exes, path.basename(dir));
  return pick.exe || exes[0];
}

/** 递归计算目录真实体积（用于后台补全"安装大小"） */
async function dirSize(dir, onTick) {
  let total = 0;
  let files = 0;
  async function walk(cur, depth) {
    if (depth > 12) return;
    let items = [];
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(cur, it.name);
      if (it.isDirectory()) {
        if (it.name === '$RECYCLE.BIN') continue;
        await walk(full, depth + 1);
      } else if (it.isFile()) {
        const st = await safeStat(full);
        if (st) { total += st.size; files++; if (onTick && files % 500 === 0) onTick(total); }
      }
    }
  }
  await walk(dir, 0);
  return { bytes: total, files };
}

/**
 * 文件夹扫描主函数。
 * @param {string} root 要扫描的根目录
 * @param {object} opts
 *   mode          'smart' 智能嗅探 | 'subfolder' 每个一级子目录视为一个游戏
 *   maxDepth      智能模式下的递归深度（默认 3）
 *   onProgress    进度回调
 *   isCancelled   取消判断函数
 */
async function scanFolder(root, opts = {}) {
  const {
    mode = 'smart',
    maxDepth = 3,
    onProgress = () => {},
    isCancelled = () => false
  } = opts;

  const results = [];
  if (!(await exists(root))) return results;

  /* ---------- 模式 A：每个一级子目录 = 一个游戏（适合 D:\Games\xxx 这种结构） ---------- */
  if (mode === 'subfolder') {
    let dirs = [];
    try { dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch { return results; }
    let idx = 0;
    for (const d of dirs) {
      if (isCancelled()) break;
      idx++;
      const full = path.join(root, d.name);
      if (SKIP_DIRS.has(d.name.toLowerCase())) continue;
      onProgress({ phase: 'folder', message: `扫描 (${idx}/${dirs.length})：${d.name}`, current: idx, total: dirs.length });

      const exes = await collectExes(full, maxDepth, isCancelled);
      if (!exes.length) continue;
      const pick = classify.pickMainExe(exes, d.name);
      const st = await safeStat(full);
      const w = await quickDirWeight(full);

      results.push({
        id: stableId(full),
        name: prettyName(d.name),
        publisher: '',
        version: '',
        installDir: full,
        exePath: pick.exe ? pick.exe.path : '',
        sizeBytes: w.truncated ? 0 : w.bytes,
        installDate: st ? st.birthtimeMs || st.ctimeMs : 0,
        steamAppId: '',
        source: 'folder',
        sourceLabel: '文件夹',
        confidence: pick.score >= 6 ? 8 : 5,
        reasons: pick.reasons,
        categories: classify.classify(d.name)
      });
    }
    return results;
  }

  /* ---------- 模式 B：智能嗅探（递归，遇到"像游戏"的目录就收下并停止下钻） ---------- */
  const queue = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    if (isCancelled()) break;
    const { dir, depth } = queue.shift();
    visited++;
    if (visited % 5 === 0) {
      onProgress({ phase: 'folder', message: `正在嗅探：${path.basename(dir) || dir}`, current: visited });
    }

    const ev = await evaluateGameDir(dir, isCancelled);
    if (ev.isGame) {
      const st = await safeStat(dir);
      results.push({
        id: stableId(dir),
        name: prettyName(path.basename(dir)),
        publisher: '',
        version: '',
        installDir: dir,
        exePath: ev.exe ? ev.exe.path : '',
        sizeBytes: ev.weight && !ev.weight.truncated ? ev.weight.bytes : 0,
        installDate: st ? st.birthtimeMs || st.ctimeMs : 0,
        steamAppId: '',
        source: 'folder',
        sourceLabel: '文件夹',
        confidence: Math.min(10, Math.round(ev.score)),
        reasons: ev.reasons,
        categories: classify.classify(path.basename(dir))
      });
      continue; // 已识别为游戏，不再深入子目录，避免重复收录
    }

    // 判成"合集目录"时给个明确反馈，让用户知道程序正在往里钻，
    // 而不是以为"怎么就扫出来 1 个/压根没反应"
    if (ev.container && depth < maxDepth) {
      onProgress({
        phase: 'folder',
        message: `「${path.basename(dir)}」下面有 ${ev.childCount} 个独立程序，正在逐个识别 …`
      });
    }

    if (depth >= maxDepth) continue;
    let subs = [];
    try { subs = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch { continue; }
    // 子目录按名字排一下，让扫描进度看起来是稳定的顺序（否则每次跑顺序都不一样）
    subs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const s of subs) {
      if (SKIP_DIRS.has(s.name.toLowerCase())) continue;
      if (s.name.startsWith('.')) continue;
      queue.push({ dir: path.join(dir, s.name), depth: depth + 1 });
    }
  }
  return results;
}

/**
 * 把 "MyGame_v1.0.2-beta" 这种目录名美化成可读名称。
 *
 * ⚠ 这里最容易犯的错是"削过头"：
 *   游戏名结尾带数字是很常见的（NinNinDays2 / hs2 / Warcraft3 / Portal 2），
 *   如果无脑把结尾数字当版本号削掉，`NinNinDays2` 会变成 `NinNinDays`，
 *   而且这类错误一旦入库就很难被发现（名字看着还挺正常）。
 *
 *   所以规则是：**只有带 `v` 前缀、或带小数点、或带明确版本后缀的，才算版本号**。
 */
function prettyName(raw) {
  const original = String(raw || '').trim();
  let s = original.replace(/[_]+/g, ' ').trim();

  // ① 去掉开头的文件夹标签（很多资源站/搬运的目录会带这些）
  //    "[PC硬盘]【官中】拔作岛" → "拔作岛"   "(public)Syahara's bad day" → "Syahara's bad day"
  //    只在"括号组正好在开头、且剥完之后还剩至少 2 个字"时才剥，避免把整名都吃掉
  let peeled = s;
  for (let i = 0; i < 4; i++) {
    const next = peeled.replace(/^\s*(?:\[[^\]]{0,40}\]|【[^】]{0,40}】|\([^)]{0,40}\)|（[^）]{0,40}）)\s*/, '');
    if (next === peeled) break;
    if (next.length < 2) break;     // 剥到没东西了就停手
    peeled = next;
  }
  s = peeled;

  // ② 去掉结尾的版本号。三选一才认：
  //    · 带 v 前缀：Game_v1.0.2 / Game v2 / Game_v1
  //    · 带小数点：Game_1.6 / Game 2.0.1     ← 光有空格加数字不算（"Portal 2" 是游戏名！）
  //    后面可以再跟 beta/alpha/demo/patch/update/fix/rip
  //    末尾允许再挂一个单字母（搬运目录很常见："..._v0.32b"）
  s = s.replace(
    /(?:[-_ ]+v\d+(?:\.\d+)*|[-_ ]+\d+\.\d+(?:\.\d+)*)[a-z]?(?:[-_ ]?(?:beta|alpha|demo|patch|update|fix|rip))*$/i,
    ''
  ).trim();

  // ③ 去掉结尾的**中文**版本修饰词（这几类中文后缀不会有歧义）。
  //    ⚠ 刻意不在这里削 beta / alpha / demo：
  //      "censor demo 2.0.6" 这种目录，削掉 demo 会把游戏名本身削没（变成 "censor"）。
  //      英文修饰词只在②里"紧跟在版本号后面"时才削，那样才安全
  //      （"MyGame_v1.0.2-beta" → "MyGame"）。
  s = s.replace(
    /[-_ ]+(正式版|破解版|中文版|汉化版|免安装版|绿色版|重制版|重置版|豪华版|完整版|典藏版|学习版|官中版?)([-_ ]+(正式版|破解版|中文版|汉化版|免安装版|绿色版))*$/i,
    ''
  ).trim();

  // ④ 结果太短说明削过头了（原本就叫 "1" 之类），回退原值
  if (s.length < 2) s = original;
  return s;
}

/* ==================================================================
 *  5. 统一入口
 * ================================================================== */

/**
 * 一键嗅探：注册表 + Steam + Epic（+ 可选的自定义文件夹）
 * @param {object} opts
 *   folders   [{path, mode}] 用户额外指定要扫的目录
 *   include   过滤：{registry, steam, epic, folder} 各来源是否启用
 *   onProgress 进度回调
 *   isCancelled 取消判断
 * @returns {Promise<Array>} 去重后的候选游戏列表
 */
async function sniffAll(opts = {}) {
  const {
    folders = [],
    include = { registry: true, steam: true, epic: true, folder: true },
    onProgress = () => {},
    isCancelled = () => false
  } = opts;

  let all = [];
  let registryHits = [];

  if (include.registry) {
    onProgress({ phase: 'registry', message: '扫描系统注册表 …' });
    registryHits = await scanRegistry(onProgress, isCancelled);
    all = all.concat(registryHits);
  }
  if (include.steam && !isCancelled()) {
    onProgress({ phase: 'steam', message: '扫描 Steam 游戏库 …' });
    // 关键：把注册表里扫到的 steamapps 路径反推成库根目录传给 Steam 扫描，
    // 这样装在 I:\steam 这种非默认位置的库也能被找到，同时能补上 Steam 的安装/更新时间。
    const steamLibsFromRegistry = extractSteamLibraries(registryHits);
    all = all.concat(await scanSteam(onProgress, isCancelled, steamLibsFromRegistry));
  }
  if (include.epic && !isCancelled()) {
    onProgress({ phase: 'epic', message: '扫描 Epic 游戏库 …' });
    all = all.concat(await scanEpic(onProgress, isCancelled));
  }
  if (include.folder && folders.length) {
    for (const f of folders) {
      if (isCancelled()) break;
      const p = typeof f === 'string' ? f : f.path;
      const mode = (typeof f === 'object' && f.mode) || 'smart';
      onProgress({ phase: 'folder', message: `扫描目录：${p}` });
      all = all.concat(await scanFolder(p, { mode, onProgress, isCancelled }));
    }
  }

  onProgress({ phase: 'done', message: '正在整理结果 …' });
  return dedupe(all);
}

/**
 * 去重：同一款游戏可能被注册表 / Steam / 文件夹同时扫到。
 * 规则：按 exePath、installDir、名称 三个维度归并，保留信息最全（confidence 最高）的那条。
 */
function dedupe(list) {
  const byDir = new Map();
  const byName = new Map();
  const out = [];

  // 先按置信度从高到低排，保证合并时留下的总是最优记录
  const sorted = [...list].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  for (const g of sorted) {
    const dirKey = g.installDir ? path.normalize(g.installDir).toLowerCase() : '';
    const nameKey = classify.normalizeName(g.name);
    if (!nameKey && !dirKey) continue;

    const hitDir = dirKey ? byDir.get(dirKey) : null;
    const hitName = nameKey ? byName.get(nameKey) : null;
    if (hitDir || hitName) {
      // 已存在 → 把缺失的信息补进去，不重复收录
      const target = hitDir || hitName;
      target.sizeBytes = target.sizeBytes || g.sizeBytes;
      target.installDate = target.installDate || g.installDate;
      target.exePath = target.exePath || g.exePath;
      target.steamAppId = target.steamAppId || g.steamAppId;
      target.publisher = target.publisher || g.publisher;
      target.version = target.version || g.version;
      target.steamCoverUrl = target.steamCoverUrl || g.steamCoverUrl;

      // 名称处理：中文用户更希望看到中文名。
      // 比如注册表里是「女神异闻录5皇家版」、Steam 里是「Persona 5 Royal」，
      // 那就用中文名当显示名，英文名收进 altNames 里仍然可以被搜到。
      if (g.name && g.name !== target.name) {
        const nameHasCJK = (s) => /[\u4e00-\u9fa5]/.test(s || '');
        if (nameHasCJK(g.name) && !nameHasCJK(target.name)) {
          target.altNames = uniqList([...(target.altNames || []), target.name]);
          target.name = g.name;
        } else {
          target.altNames = uniqList([...(target.altNames || []), g.name]);
        }
      }
      continue;
    }

    if (dirKey) byDir.set(dirKey, g);
    if (nameKey) byName.set(nameKey, g);
    out.push(g);
  }
  return out;
}

/** 数组去重（保留首次出现的顺序） */
function uniqList(arr) {
  return [...new Set(arr.filter(Boolean))];
}

module.exports = {
  sniffAll,
  scanRegistry,
  scanRegistryViaPowerShell,
  scanSteam,
  scanEpic,
  scanFolder,
  evaluateGameDir,
  // 以下导出用于单元测试（判断"合集目录"是这次修 bug 的核心，必须能单独测）
  isTechDirName: (name) => TECH_DIR_RE.test(String(name || '')),
  mainExeChildGroups,
  childLooksLikeGame,
  collectExes,
  pickExeInDir,
  dirSize,
  quickDirWeight,
  prettyName,
  parseVdf,
  parseRegFile,
  stableId,
  findSteamLibraries,
  extractSteamLibraries,
  dedupe
};
