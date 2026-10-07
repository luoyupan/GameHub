/**
 * ============================================================
 *  GameHub - 游戏卸载模块  (src/main/uninstall.js)
 * ------------------------------------------------------------
 *  三类游戏的卸载方式完全不同，所以这里分开处理：
 *
 *    ① Steam 游戏 —— 交给 Steam 自己卸（steam://uninstall/<appid>）。
 *       理由：Steam 有自己的库状态、清单、云存档。我们直接把目录删掉，
 *       Steam 那边会变成"文件缺失"的坏状态，下次还会提示你校验完整性。
 *
 *    ② Epic 游戏 —— 走 Epic 启动器协议。
 *       注意：Epic 的 AppName 没有存在游戏对象里（扫描时只用它算了 id），
 *       所以要现去清单里按安装目录反查回来。
 *
 *    ③ 本地 / 手动添加 / 注册表来源的游戏 —— 平台不管，只能 GameHub 来卸：
 *       先找游戏自带的卸载程序（unins000.exe / Uninstall.exe 之类）跑起来；
 *       找不到就整个目录移入回收站（进回收站，不是永久删除）。
 *
 *  安全红线（这几条不能松）：
 *    · 永远不碰系统目录（Windows / Program Files 根 / 用户目录根 / 盘符根）
 *    · 删除一律走回收站，给用户留后悔的机会
 *    · 每次卸载前把「删什么、在哪、多大」如实报给用户确认
 * ============================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { shell } = require('electron');

/** 常见的卸载程序文件名（小写比对） */
const UNINSTALLER_NAMES = [
  'unins000.exe', 'unins001.exe', 'unins002.exe',
  'uninstall.exe', 'uninst.exe', 'uninstaller.exe',
  '卸载.exe', 'uninst.exe'
];

/**
 * 绝对不能删的目录（规范化后比对）。
 * 这些都是"删了整个系统就出大事"的位置。
 */
const FORBIDDEN_DIRS = [
  'c:\\', 'd:\\', 'e:\\', 'f:\\', 'g:\\', 'h:\\',
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
  'c:\\programdata', 'c:\\users',
  'c:\\windows\\system32', 'c:\\windows\\syswow64',
  'c:\\users\\public'
];

/**
 * 判断某个目录是否在禁删名单里
 * @param {string} dir
 * @returns {boolean}
 */
function isForbiddenDir(dir) {
  if (!dir) return true;
  const norm = path.resolve(dir).toLowerCase().replace(/[\\/]+$/, '');
  if (!norm || norm === path.parse(norm).root.toLowerCase().replace(/[\\/]+$/, '')) return true;
  for (const f of FORBIDDEN_DIRS) {
    const target = f.replace(/[\\/]+$/, '').toLowerCase();
    if (norm === target) return true;
  }
  // 系统目录的子路径也一并拦掉（比如 C:\Windows\System32\xxx）
  const lower = norm + '\\';
  for (const sysRoot of ['c:\\windows\\', 'c:\\program files\\windowsapps\\']) {
    if (lower.startsWith(sysRoot)) return true;
  }
  return false;
}

/**
 * 在安装目录里找游戏自带的卸载程序。
 * 只查根目录和一层常见子目录（卸载器不会藏太深）。
 * @param {string} dir
 * @returns {string} 卸载程序完整路径，找不到返回空串
 */
function findUninstaller(dir) {
  if (!dir || !fs.existsSync(dir)) return '';
  const candidates = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      candidates.push(path.join(dir, name));
    }
  } catch {
    return '';
  }
  // 先在根目录找
  for (const p of candidates) {
    const base = path.basename(p).toLowerCase();
    if (UNINSTALLER_NAMES.includes(base) && isFile(p)) return p;
  }
  // 再往下一层看看（有些游戏把卸载器放在子目录里）
  for (const p of candidates) {
    if (!isDir(p)) continue;
    // 跳过明显是游戏资源的目录，省点时间
    if (/^(data|content|assets|engine|binaries|saves?)$/i.test(path.basename(p))) continue;
    try {
      for (const name of fs.readdirSync(p)) {
        if (UNINSTALLER_NAMES.includes(name.toLowerCase())) {
          const full = path.join(p, name);
          if (isFile(full)) return full;
        }
      }
    } catch { /* 没权限就跳过 */ }
  }
  return '';
}

/**
 * 在注册表里找这个目录对应的卸载命令。
 * 有些游戏（尤其是走安装包装的）只在注册表里留 UninstallString，
 * 目录里反倒没有 uninstall.exe。
 * @param {string} dir
 * @returns {Promise<string>} 卸载程序路径，找不到返回空串
 */
function findUninstallerFromRegistry(dir) {
  return new Promise((resolve) => {
    if (!dir) return resolve('');
    const roots = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ];
    let pending = roots.length;
    const hits = [];
    for (const root of roots) {
      execFileSafe(
        'reg',
        ['query', root, '/s', '/f', dir, '/d'],
        (out) => {
          // 在输出里找 InstallLocation / UninstallString 附近的 exe
          const m = String(out || '').match(/UninstallString\s+REG_\w+\s+(.+\.exe)/i);
          if (m) hits.push(m[1].trim().replace(/^"|"$/g, ''));
          if (--pending === 0) resolve(hits[0] || '');
        }
      );
    }
  });
}

/** 查 Epic 清单，按安装目录反查 AppName（卸载协议需要它） */
async function findEpicAppName(installDir) {
  if (!installDir) return '';
  const pd = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const dirs = [
    path.join(pd, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
    path.join(process.env.LOCALAPPDATA || '', 'EpicGamesLauncher', 'Saved', 'Manifests')
  ];
  const target = path.resolve(installDir).toLowerCase();
  for (const d of dirs) {
    let files = [];
    try { files = await fsp.readdir(d); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.item'))) {
      try {
        const json = JSON.parse(await fsp.readFile(path.join(d, f), 'utf8')) || {};
        if (json.InstallLocation && path.resolve(json.InstallLocation).toLowerCase() === target) {
          return json.AppName || '';
        }
      } catch { /* 单个清单坏了不影响其它 */ }
    }
  }
  return '';
}

/**
 * 估算目录体积（有上限保护，避免在大目录上卡太久）。
 * @param {string} dir
 * @param {{maxFiles?:number, maxMs?:number}} [opts]
 * @returns {Promise<{bytes:number, truncated:boolean}>}
 */
async function dirSize(dir, opts = {}) {
  const maxFiles = opts.maxFiles || 40000;
  const maxMs = opts.maxMs || 4000;
  const start = Date.now();
  let bytes = 0;
  let count = 0;
  let truncated = false;

  const stack = [dir];
  while (stack.length) {
    if (count >= maxFiles || Date.now() - start > maxMs) { truncated = true; break; }
    const cur = stack.pop();
    let items = [];
    try { items = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const full = path.join(cur, it.name);
      if (it.isDirectory()) {
        stack.push(full);
      } else if (it.isFile()) {
        try { bytes += (await fsp.stat(full)).size; } catch { /* 跳过读不到的 */ }
        count++;
        if (count >= maxFiles) { truncated = true; break; }
      }
    }
  }
  return { bytes, truncated };
}

/**
 * 给出一款游戏的卸载方案（供界面上的确认弹窗展示）。
 * @param {object} game
 * @returns {Promise<object>}
 */
async function describe(game) {
  const info = {
    ok: true,
    id: game.id,
    name: game.name,
    source: game.source || '',
    sourceLabel: game.sourceLabel || game.source || '',
    installDir: game.installDir || '',
    dirExists: false,
    sizeBytes: game.sizeBytes || 0,
    sizeTruncated: false,
    platform: '',          // 'steam' | 'epic' —— 可交给平台卸载
    platformId: '',
    uninstaller: '',       // 游戏自带的卸载程序
    canTrash: false,       // 能否把目录移入回收站
    blocked: '',           // 不允许由 GameHub 卸载的原因
    warnings: []
  };

  // 平台上能卸的，优先走平台
  if (game.source === 'steam' && game.steamAppId) {
    info.platform = 'steam';
    info.platformId = String(game.steamAppId);
    info.warnings.push('将由 Steam 完成卸载，Steam 会弹出自己的确认窗口。');
  } else if (game.source === 'epic') {
    const appName = await findEpicAppName(game.installDir);
    if (appName) {
      info.platform = 'epic';
      info.platformId = appName;
      info.warnings.push('将由 Epic Games 启动器完成卸载。');
    } else {
      info.warnings.push('没能在 Epic 清单里找到这款游戏，只能由 GameHub 代为清理。');
    }
  }

  // 目录情况
  const dir = game.installDir || '';
  if (dir && isDir(dir)) {
    info.dirExists = true;
    const { bytes, truncated } = await dirSize(dir);
    // 扫描出来的体积一般是准的，这里实测更可信，但别把已有的信息覆盖成 0
    if (bytes > 0) info.sizeBytes = bytes;
    info.sizeTruncated = truncated;

    if (isForbiddenDir(dir)) {
      info.blocked = '这个目录属于系统位置，GameHub 拒绝删除。';
    } else {
      info.canTrash = true;
      const un = findUninstaller(dir) || (await findUninstallerFromRegistry(dir));
      if (un) info.uninstaller = un;
    }
  } else if (dir) {
    info.warnings.push('安装目录已经不存在了，可能之前被手动删过。');
  } else {
    info.warnings.push('这款游戏没有记录安装目录，卸载只会移除库里的条目。');
  }

  return info;
}

/**
 * 执行卸载。
 * @param {object} game
 * @param {'platform'|'software'|'remove'} mode
 * @returns {Promise<{ok:boolean, mode?:string, error?:string, detail?:string}>}
 */
async function run(game, mode) {
  const info = await describe(game);

  /* ---- 只从库里移除记录，不碰磁盘 ---- */
  if (mode === 'remove') {
    return { ok: true, mode: 'remove', detail: '已从游戏库移除，磁盘文件保持不动。' };
  }

  /* ---- 走平台自己的卸载 ---- */
  if (mode === 'platform') {
    if (!info.platform) {
      return { ok: false, error: '这款游戏没有可用的平台卸载通道' };
    }
    let url = '';
    if (info.platform === 'steam') {
      // Steam 收到这个协议会弹自己的卸载确认框
      url = `steam://uninstall/${info.platformId}`;
    } else if (info.platform === 'epic') {
      url = `com.epicgames.launcher://apps/${encodeURIComponent(info.platformId)}?action=uninstall`;
    }
    try {
      await shell.openExternal(url);
      return {
        ok: true,
        mode: 'platform',
        detail: info.platform === 'steam'
          ? '已请求 Steam 卸载，请在弹出的 Steam 窗口中确认。'
          : '已请求 Epic 启动器卸载，请在弹出的窗口中确认。'
      };
    } catch (e) {
      return { ok: false, error: `调用 ${info.sourceLabel} 失败：${e.message || e}` };
    }
  }

  /* ---- 由 GameHub 自己卸 ---- */
  if (mode === 'software') {
    if (info.blocked) return { ok: false, error: info.blocked };
    if (!info.dirExists) {
      return { ok: true, mode: 'remove', detail: '安装目录不存在，已直接移除库中条目。' };
    }

    // ① 有自带卸载程序 —— 优先用它，能顺带清理注册表和开始菜单
    if (info.uninstaller) {
      try {
        await runDetached(info.uninstaller, path.dirname(info.uninstaller));
        return {
          ok: true,
          mode: 'uninstaller',
          detail: '已启动游戏自带的卸载程序，请按向导完成卸载。卸载完可以在 GameHub 里刷新一下。'
        };
      } catch (e) {
        // 卸载程序跑不起来就退到回收站方案，不直接失败
        console.warn('[uninstall] 自带卸载程序启动失败，改用回收站：', e.message);
      }
    }

    // ② 没有卸载程序 —— 整个目录进回收站（可找回）
    try {
      await shell.trashItem(info.installDir);
      return {
        ok: true,
        mode: 'trash',
        detail: '安装目录已移入系统回收站。如果误删，可以从回收站还原。'
      };
    } catch (e) {
      return { ok: false, error: `移入回收站失败：${e.message || e}。可以手动删除该目录。` };
    }
  }

  return { ok: false, error: `未知的卸载方式：${mode}` };
}

/* ------------------------------------------------------------------
 *  小工具
 * ------------------------------------------------------------------ */

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** execFile 的 Promise 包装：只关心 stdout，出错给空串 */
function execFileSafe(cmd, args, cb) {
  try {
    require('child_process').execFile(
      cmd, args,
      { windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => cb(err ? '' : stdout)
    );
  } catch {
    cb('');
  }
}

/** 分离式启动一个程序（卸载向导要独立存在于 GameHub 之外） */
function runDetached(exe, cwd) {
  return new Promise((resolve, reject) => {
    try {
      const child = require('child_process').spawn(exe, [], {
        cwd: cwd || path.dirname(exe),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.on('error', reject);
      child.unref();
      // 不等它退出 —— 卸载向导要用户自己点完
      setTimeout(() => resolve(true), 400);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { describe, run, findUninstaller, isForbiddenDir, dirSize };
