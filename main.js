/**
 * ============================================================
 *  GameHub - 本地游戏集合启动器
 *  主进程入口  (main.js)
 * ------------------------------------------------------------
 *  职责：
 *    ① 创建无边框主窗口（自绘标题栏，做出 Steam 那种深色质感）
 *    ② 初始化四大模块：数据存储 / 游戏库 / 封面管理 / 启动器
 *    ③ 注册全部 IPC 通道，把能力安全地暴露给前端页面
 *    ④ 后台任务：体积计算队列、路径有效性巡检、自动上锁
 *
 *  启动参数：
 *    --selftest   自检模式：无界面跑一遍扫描流程并打印结果后退出
 * ============================================================
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

const { Store } = require('./src/main/store');
const { Library } = require('./src/main/library');
const { Launcher } = require('./src/main/launcher');
const { CoverManager, needsCover, MATCH_LEVEL } = require('./src/main/cover');
const scanner = require('./src/main/scanner');
const platforms = require('./src/main/platforms');
const { createEpicAuth, paintLoginResult } = require('./src/main/epicauth');
const { createMods, steamWorkshopWebUrl, steamWorkshopClientUrl, nexusSearchUrl } = require('./src/main/mods');
const uninstall = require('./src/main/uninstall');

/* ==================================================================
 *  全局单例
 * ================================================================== */
let win = null;
let store = null;
let library = null;
let launcher = null;
let cover = null;
let epicAuth = null;
let mods = null;

/** 扫描取消标志（一次只允许一个扫描任务） */
let scanCancelled = false;
let scanning = false;

/** 体积计算队列状态 */
const sizeQueue = { pending: [], running: false };

/** 是否为自检模式 */
const SELFTEST = process.argv.includes('--selftest');

/**
 * 截图模式（开发期用）：--shot=输出路径
 * 用真实的扫描结果把界面填充起来，然后把窗口画面存成 PNG，
 * 方便在不盯着屏幕的情况下检查界面渲染效果。
 */
const SHOT_ARG = process.argv.find((a) => a.startsWith('--shot'));
const SHOT = !!SHOT_ARG;
const SHOT_PATH = SHOT_ARG && SHOT_ARG.includes('=') ? SHOT_ARG.split('=')[1] : 'shot.png';
/* --only=<子串>：只跑名字里含这个子串的截图。
 * 37 张全跑要等好几分钟，改一张图就得全跑一遍太浪费。 */
const SHOT_ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
/* --epic-live：截图时带上真实的 Epic 登录凭证（拍真实账号数据用）。
 * 默认不带 —— 截图要的是确定性，不能随机器的登录状态而变。 */
const EPIC_LIVE = process.argv.includes('--epic-live');

/**
 * 探针模式（开发期用）：--probe=<要执行的 JS>
 * 在页面里跑一段脚本并把结果打印出来，用来量元素的真实尺寸、定位布局问题。
 * 例：electron . "--probe=JSON.stringify(document.querySelector('.rail-card').getBoundingClientRect())"
 */
const PROBE_ARG = process.argv.find((a) => a.startsWith('--probe='));
const PROBE = PROBE_ARG ? PROBE_ARG.slice('--probe='.length) : '';

/* ------------------------------------------------------------------
 *  渲染后端：软件渲染兜底
 *  ----------------------------------------------------------------
 *  背景：部分环境下显卡驱动没法初始化 Electron 的 GPU 合成进程，
 *  日志里会连着刷：
 *      "GPU process exited unexpectedly: exit_code=-1073741819"
 *  连崩几次后 Electron 判定 "GPU process isn't usable" 直接 FATAL 退出，
 *  用户看到的就是「双击闪退」或者「只剩一个黑窗口」。
 *
 *  ⚠ 实测要点：命令行开关 --disable-gpu 对这种情况是无效的（带了一样崩），
 *    必须在 app ready 之前调用 app.disableHardwareAcceleration() 才管用。
 *
 *  三种触发方式：
 *    ① 环境变量 GAMEHUB_FORCE_SOFTWARE=1 —— 手动强制
 *    ② 上次运行崩过（临时目录里留了标记）—— 自动记住，不用反复撞墙
 *    ③ 远程桌面 / 服务会话 —— 本来就没有可用 GPU
 *
 *  想强制开硬件加速（机器没问题、想要更高刷新率）：GAMEHUB_FORCE_GPU=1
 * ------------------------------------------------------------------ */
const GPU_FALLBACK_FLAG = path.join(require('os').tmpdir(), 'gamehub-software-render.flag');

/** 判定本次是否该走软件渲染 */
function needSoftwareRender() {
  if (process.env.GAMEHUB_FORCE_GPU === '1') return false;
  if (process.env.GAMEHUB_FORCE_SOFTWARE === '1') return true;
  try {
    if (fs.existsSync(GPU_FALLBACK_FLAG)) return true;
  } catch { /* 读不到标记就当没有 */ }
  const session = (process.env.SESSIONNAME || '').toUpperCase();
  if (session === 'RDP' || session === 'SERVICES') return true;
  return false;
}

/** 本次是否已经处于软件渲染 */
const SOFTWARE_RENDER = needSoftwareRender();

if (SOFTWARE_RENDER) {
  try { app.disableHardwareAcceleration(); } catch { /* 早于 ready，正常不该失败 */ }
  for (const sw of ['disable-gpu', 'disable-gpu-compositing', 'disable-gpu-sandbox', 'in-process-gpu']) {
    app.commandLine.appendSwitch(sw);
  }
} else {
  /* 自愈：GPU 进程异常退出时留个标记，下次启动自动走软件渲染。
   * 为什么不在当次就重启 —— Electron 在 GPU 连崩几次后会直接 FATAL 退出，
   * 留给我们的时间窗很短，稳妥的做法是记下来、下次别再撞同一堵墙。
   * 这也修好了「双击闪退一次，之后就正常了」这个很反直觉的现象。 */
  app.on('child-process-gone', (_e, details) => {
    if (!details || details.type !== 'GPU') return;
    try {
      fs.writeFileSync(GPU_FALLBACK_FLAG, String(Date.now()), 'utf8');
      console.warn(
        '[GameHub] GPU 进程异常退出（%s），已记录；下次启动会自动使用软件渲染。',
        details.reason || 'unknown'
      );
    } catch { /* 写不进去就算了，不该因为这个再抛错 */ }
  });
}

/* ------------------------------------------------------------------
 *  自检 / 截图 / 探针：一律跑在独立的数据目录里，绝不碰用户真实的游戏库
 *  ----------------------------------------------------------------
 *  ⚠ 探针这一条是补上的，之前漏了它 —— 探针于是直接开在用户真实的
 *    %APPDATA%/gamehub 上。测试用例里那个"批量删除"是真删库的，
 *    只是恰好被 store 的 800ms 防抖 + app.exit(0) 救了一命，没落盘。
 *    这种"靠运气不出事"的写法必须堵掉。
 *
 *  探针和自检/截图的需求不一样：它要验证的是真实数据下的界面，
 *  不能从空库开始（不然批量删除、成就角标这些根本测不出东西）。
 *  所以做法是：把真实数据【复制一份】到临时目录，探针跑在副本上，
 *  改了什么都是扔掉的。
 * ------------------------------------------------------------------ */
if (SELFTEST || SHOT || PROBE) {
  const os = require('os');
  const realDir = app.getPath('userData');   // 必须在 setPath 之前读，之后就取不到了
  const tmpDir = path.join(os.tmpdir(), SHOT ? 'gamehub-shot' : (SELFTEST ? 'gamehub-selftest' : 'gamehub-probe'));

  if (PROBE) {
    try {
      // 只搬真正影响界面的两样：游戏库 + 封面缓存。
      // Chromium 那堆 Cache/GPUCache 复制过去只会白白拖慢启动。
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const lib = path.join(realDir, 'library.json');
      if (fs.existsSync(lib)) fs.copyFileSync(lib, path.join(tmpDir, 'library.json'));
      const covers = path.join(realDir, 'covers');
      if (fs.existsSync(covers)) fs.cpSync(covers, path.join(tmpDir, 'covers'), { recursive: true });
    } catch (e) {
      // 搬不动就算了：宁可让探针跑在空库上，也不要它去动真实数据
      console.warn('[探针] 准备临时数据目录失败：', e.message);
    }
  }

  /* ---- 截图模式下想拍"真实 Epic 账号数据"时，才把登录凭证搬过来 ----
   *
   * 为什么不默认搬：绝大多数截图要的是**确定性** ——
   * 有没有登录态、账号里有什么，不能让它们随机器的状态而变，
   * 否则换台机器跑出来的图就对不上了。
   * 所以这件事必须显式开关（--epic-live），需要哪一张真实就开哪一次。
   *
   * ⚠ 两个文件都得搬，缺一不可：
   *   · epic-auth.json 是密文本身
   *   · Local State 里存着解它的 DPAPI 密钥（safeStorage 用的）
   *   只搬前者的话会解密失败，表现是"明明登录着却显示未登录"。
   *   这个坑我在写探针脚本时踩过一次，记在这里免得再踩。 */
  if (SHOT && EPIC_LIVE) {
    try {
      for (const f of ['epic-auth.json', 'Local State']) {
        const src = path.join(realDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
      }
      console.log('[截图] 已带入真实 Epic 登录凭证（--epic-live）');
    } catch (e) {
      console.warn('[截图] 带入 Epic 凭证失败：', e.message);
    }
  }

  app.setPath('userData', tmpDir);
}

/* ------------------------------------------------------------------
 *  硬件加速自动降级
 *  ----------------------------------------------------------------
 *  少数环境（虚拟机、远程桌面、老显卡、被安全策略拦截）里，
 *  Chromium 的 GPU 进程会反复崩溃并直接 FATAL 退出，整个程序打不开。
 *  这里用「启动标记」来判断上次是不是没走完启动流程：
 *    上次留下的 .starting 文件还在 → 说明上次是启动阶段挂掉的
 *    → 本次自动关闭硬件加速，先让程序能打开再说。
 *  正常退出时会把标记删掉，所以只会影响真正出问题的那台机器。
 * ------------------------------------------------------------------ */
const startingMarker = path.join(app.getPath('userData'), '.starting');

function detectPreviousCrash() {
  try {
    if (fs.existsSync(startingMarker)) {
      const age = Date.now() - Number(fs.readFileSync(startingMarker, 'utf8') || 0);
      // 只认 5 分钟以内的标记，太久之前的残留忽略掉
      return age >= 0 && age < 5 * 60 * 1000;
    }
  } catch { /* 读不到就当没崩过 */ }
  return false;
}

/**
 * 判断是否要关闭硬件加速。
 *
 * 坑点记录：Chromium 只会解析它认识的开关，而写在应用路径后面的
 * `--disable-gpu` 会被 Electron 当成「传给应用的参数」，
 * 不会出现在 process.argv 里 —— 所以光判断 process.argv 是不够的，
 * 必须同时问 app.commandLine.hasSwitch()，并保留一个环境变量后门。
 */
function wantDisableGpu() {
  try {
    if (app.commandLine.hasSwitch('disable-gpu')) return true;
  } catch { /* 老版本没有这个方法，忽略 */ }
  if (process.argv.includes('--disable-gpu')) return true;
  if (process.env.GAMEHUB_DISABLE_GPU === '1') return true;
  return false;
}

const gpuDisabled = wantDisableGpu() || (!SELFTEST && detectPreviousCrash());

if (gpuDisabled) {
  // 关闭硬件加速：界面改用 CPU 软件渲染（SwiftShader），任何机器都能跑起来。
  // 注意：千万不要加 --disable-software-rasterizer —— 那会把 CPU 回退也一起关掉，
  //      结果就是完全没有渲染器，程序直接崩掉。
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
} else {
  // 常规情况下也放宽一点 GPU 限制，减少花屏 / 黑屏概率
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

/* 截图 / 探针 / 自检都要在无人值守的环境里真正把画面渲染出来。
 * 某些受限环境（虚拟机 / 沙箱）里独立 GPU 进程起不来，这里改成进程内渲染绕开它。
 *
 * ⚠ 自检也必须在这一组里。踩过：给 `--selftest` 加 `--disable-gpu` 反而
 *   直接崩 —— GPU 进程 0xC0000005 连崩 6 次后 "GPU process isn't usable. Goodbye."，
 *   进程 exit=3、一个字的输出都拿不到，看着像自检本身挂了。
 *   根子就是自检当时没走进程内渲染，禁掉独立 GPU 进程后就没人能画窗口了。
 *   （截图/探针一直没事，正是因为它们一开始就在这一组。） */
if (SHOT || PROBE || SELFTEST) {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
}

/** 写启动标记（正常加载完成后会删掉） */
function markStarting() {
  try { fs.writeFileSync(startingMarker, String(Date.now())); } catch { /* 忽略 */ }
}
function clearStartingMark() {
  try { fs.unlinkSync(startingMarker); } catch { /* 忽略 */ }
}

/* ==================================================================
 *  一、窗口创建
 * ================================================================== */
function createWindow() {
  const bounds = (store && store.getSettings().windowBounds) || {};

  win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    frame: false,                       // 关闭系统标题栏，前端自绘
    backgroundColor: '#0e1420',
    title: 'GameHub',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,           // 安全：隔离页面与 Node 环境
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  // 截图模式必须关掉后台节流：
  //   窗口没被聚焦时，Chromium 会停掉重绘，capturePage() 于是拿到"上一帧"，
  //   结果每张截图都慢一拍（拍 17 号却看到 16 号的画面）。关掉节流就没这问题。
  if (SHOT) win.webContents.setBackgroundThrottling(false);

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    // 恢复窗口材质（能透出桌面的那个）。放在 show 之前应用，
    // 免得窗口先以不透明底闪一下再变透明。
    // ⚠ 不能只读 desktopMaterial 字段：auto 模式下还得看背景材质是什么，
    //   所以统一走 resolve 那套逻辑。
    const r = syncDesktopMaterial();
    if (!r.ok) console.warn('[GameHub] 恢复窗口材质失败：', r.error);
    if (!SELFTEST && !SHOT) win.show();
    // 截图模式需要窗口真正"可见"才能拿到画面，所以隐藏着显示（不置顶、不抢焦点）
    if (SHOT) win.showInactive();
  });

  // 页面真正加载出来 → 说明本次启动成功，清掉崩溃标记
  win.webContents.once('did-finish-load', () => clearStartingMark());

  // 自检模式下把前端的报错也打出来，方便排查
  if (SELFTEST) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[渲染进程${level === 3 ? '错误' : '警告'}] ${message} (${source}:${line})`);
    });
  }

  // 记住窗口大小与位置
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    store.setSettings({ windowBounds: b }).catch(() => {});
  };
  win.on('resize', debounce(saveBounds, 600));
  win.on('move', debounce(saveBounds, 600));

  win.on('closed', () => { win = null; });

  // 外部链接交给系统浏览器打开，不在应用内跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

/** 向渲染进程广播事件 */
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ==================================================================
 *  二、IPC：应用与窗口
 * ================================================================== */
function registerBaseIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    dataDir: app.getPath('userData'),
    exePath: app.getPath('exe')
  }));

  ipcMain.handle('win:minimize', () => { win && win.minimize(); });
  ipcMain.handle('win:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => {
    // 关闭前把数据落盘，避免丢时长统计
    if (store) store.flush().finally(() => win && win.close());
  });
  ipcMain.handle('win:devtools', () => { win && win.webContents.openDevTools({ mode: 'detach' }); });
}

/* ==================================================================
 *  三、IPC：设置
 * ================================================================== */
function registerSettingsIpc() {
  ipcMain.handle('settings:get', () => store.getSettings());

  ipcMain.handle('settings:set', async (_e, patch) => {
    const s = await store.setSettings(patch || {});
    // 主题跟随切换系统原生控件配色
    if (patch && patch.theme) nativeTheme.themeSource = patch.theme;
    // 窗口材质（透出桌面）改了要立刻生效，不然得重启才看得到。
    // ⚠ 这里不能只判断 desktopMaterial 字段：
    //   auto 模式下改的是 bg.*.material（比如从「纯色」切到「亚克力」），
    //   同样会改变窗口材质。所以任何一次设置保存都重算一遍。
    syncDesktopMaterial();
    return s;
  });
}

/* ==================================================================
 *  IPC：外观自定义（左右两栏背景 + 界面字体）
 * ================================================================== */

/**
 * 内置字体候选表。
 *
 * 为什么不依赖读注册表拿全量：
 *   ① 某些环境下 reg.exe 会被安全策略拦掉（实测确实会遇到）；
 *   ② 就算读到了，注册表里的名字也未必是 CSS 能直接用的名字。
 * 所以这里给一份覆盖面够广的精选表打底，用户想用别的字体
 * 直接在输入框里敲字体名就行 —— 列表只是"省得手打"的便利。
 *
 * 顺序按使用频率排：中文字体在前，英文与等宽在后。
 */
const FONT_PRESETS = [
  /* ---- 中文：Windows 自带 ---- */
  '微软雅黑', '微软雅黑 Light', '等线', '等线 Light',
  '宋体', '新宋体', '仿宋', '楷体', '黑体', '幼圆', '隶书',
  '华文细黑', '华文楷体', '华文中宋', '华文仿宋', '华文新魏', '华文行楷',
  '方正舒体', '方正姚体',
  /* ---- 中文：常见第三方 ---- */
  '思源黑体', '思源宋体', 'Source Han Sans SC', 'Source Han Serif SC',
  'HarmonyOS Sans SC', 'MiSans', '阿里巴巴普惠体', 'OPPO Sans',
  '更纱黑体 SC', 'Sarasa Gothic SC', '霞鹜文楷', 'LXGW WenKai',
  '得意黑', 'Noto Sans SC', 'Noto Serif SC',
  /* ---- 英文 ---- */
  'Segoe UI', 'Segoe UI Semibold', 'Arial', 'Arial Black', 'Calibri',
  'Cambria', 'Candara', 'Consolas', 'Corbel', 'Courier New', 'Georgia',
  'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
  /* ---- 等宽（写代码/看路径舒服） ---- */
  'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code',
  'Source Code Pro', 'IBM Plex Mono'
];

/** 把设置里存的背景图（相对 dataDir）转成渲染层能直接用的 file:// 地址 */
function bgSlotUrl(slotCfg) {
  if (!slotCfg || slotCfg.type !== 'image' || !slotCfg.image) return '';
  const abs = store.bgAbs(slotCfg.image);
  return fs.existsSync(abs) ? pathToFileUrl(abs) : '';
}

/**
 * 「玻璃系」材质：这几种的共同点是用户期待能透出桌面。
 * 只要左右任一一栏用了它们，窗口就该切到系统亚克力，让桌面透上来。
 *
 * 为什么必须联动：页面里的 backdrop-filter 只能模糊「页面内」的东西，
 * 无论把材质层调得多透，底下也只有深色的页面底色，
 * 永远看不到桌面。真正的"透"只能交给系统合成。
 */
const GLASSY_MATERIALS = ['frosted', 'acrylic', 'glass', 'liquid'];

/** 强制类取值：用户明确指定了就不要再被背景材质带着走 */
const EXPLICIT_MATERIALS = ['off', 'acrylic', 'mica', 'tabbed'];

function normalizeDesktopMaterial(v) {
  // 兼容老数据：早期版本用 'none' 表示"没开"，现在 'none' 的语义是"自动"，
  // 所以遇到 'none' 一律当成 auto，否则老用户开了玻璃材质也透不出桌面。
  if (v === 'none' || v === undefined || v === null || v === '') return 'auto';
  return EXPLICIT_MATERIALS.includes(v) ? v : 'auto';
}

/**
 * 把设置里的材质偏好换算成「窗口真正要用的材质」。
 *
 *   auto  → 任一栏是玻璃系材质就开 acrylic，否则关
 *   其它  → 用户说了算
 *
 * @param {object} settings
 * @returns {'off'|'acrylic'|'mica'|'tabbed'}
 */
function resolveDesktopMaterial(settings) {
  const pref = normalizeDesktopMaterial((settings || {}).desktopMaterial);
  if (pref !== 'auto') return pref;

  const bg = (settings || {}).bg || {};
  const glassy = ['sidebar', 'content'].some((k) => {
    const c = bg[k] || {};
    return c.type === 'material' && GLASSY_MATERIALS.includes(c.material);
  });
  return glassy ? 'acrylic' : 'off';
}

/** 当前系统支不支持窗口材质（决定界面要不要给选项） */
function desktopMaterialSupported() {
  const isWin = process.platform === 'win32';
  const build = Number((require('os').release() || '').split('.')[2] || 0);
  return {
    supported: isWin && build >= 22000,
    platform: process.platform,
    build,
    reason: !isWin ? '只有 Windows 支持'
      : build < 22000 ? `需要 Windows 11（当前 build ${build}）` : ''
  };
}

/**
 * 应用窗口的系统背景材质（Windows 11 的亚克力 / 云母）。
 *
 * 为什么必须走到这一层：
 *   页面里的 backdrop-filter 只能采样「页面内」已经画出来的东西，
 *   它永远看不到窗口外面 —— 所以想让窗口真的透出桌面，
 *   只能让 Windows 的 DWM 去合成，也就是 Electron 这个 API。
 *
 * @param {'off'|'acrylic'|'mica'|'tabbed'} mode
 * @returns {{ok:boolean, mode?:string, error?:string}}
 */
function applyDesktopMaterial(mode) {
  if (!win || win.isDestroyed()) return { ok: false, error: '窗口还没准备好' };
  if (process.platform !== 'win32') {
    return { ok: false, error: '透出桌面只支持 Windows' };
  }
  const build = Number((require('os').release() || '').split('.')[2] || 0);
  if (build < 22000) {
    return { ok: false, error: `需要 Windows 11（当前 build ${build}）` };
  }

  const m = ['acrylic', 'mica', 'tabbed'].includes(mode) ? mode : 'none';
  try {
    win.setBackgroundMaterial(m);
    // 材质要"有地方透出来"：窗口底色得放掉。
    // 关掉时恢复成原来的不透明底色，免得漏出桌面。
    win.setBackgroundColor(m === 'none' ? '#0e1420' : '#00000000');
    // 通知渲染层同步页面样式 —— 主进程才是权威，页面不自己猜
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('appearance:material', { mode: m });
    }
    return { ok: true, mode: m };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 按当前设置重新算一次并应用。
 * 只要「背景材质」或「透出桌面偏好」任意一个变了就得走它 ——
 * 因为 auto 模式下背景材质会反过来决定窗口材质。
 */
function syncDesktopMaterial() {
  return applyDesktopMaterial(resolveDesktopMaterial(store.getSettings()));
}

/** 读注册表里的已安装字体名（清洗成人类能读的名字） */
function readSystemFonts() {
  return new Promise((resolve) => {
    // reg.exe 可能被安全策略拦掉，execFile 理论上不会同步抛错，
    // 但不同 Electron / 系统组合下行为不完全一致，这里包一层保险
    try {
      execFile(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'],
        { windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve([]);
          const names = new Set();
          for (const raw of String(stdout).split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('HKEY')) continue;
            // 形如：  Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc
            const m = line.match(/^(.*?)\s{2,}REG_\w+\s{2,}/);
            if (!m) continue;
            let name = m[1].trim();
            // 去掉结尾的 (TrueType) / (OpenType) / (All res) 这类标注
            name = name.replace(
              /\s*\((TrueType|OpenType|All res|VGA res|Plotter|Type 1|Bitmap|TrueType Collection)[^)]*\)\s*$/i,
              ''
            ).trim();
            // "A & B" 表示同一字体注册了多个名字，都收进来
            for (const part of name.split('&')) {
              const v = part.trim();
              if (v.length >= 2 && /[\w\u4e00-\u9fa5]/.test(v)) names.add(v);
            }
          }
          resolve([...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
        }
      );
    } catch {
      resolve([]);
    }
  });
}

function registerAppearanceIpc() {
  /** 两个栏位当前背景图的 file:// 地址 */
  ipcMain.handle('appearance:urls', () => {
    const bg = store.getSettings().bg || {};
    return { sidebar: bgSlotUrl(bg.sidebar), content: bgSlotUrl(bg.content) };
  });

  /**
   * 给某一栏设置自定义背景图。
   * args: { slot: 'sidebar'|'content', path?: string }
   * 不传 path 就弹系统文件框。图片会复制进数据目录，
   * 所以原图后来被删掉、移走都不影响显示。
   */
  ipcMain.handle('appearance:setImage', async (_e, args = {}) => {
    const slot = args.slot === 'content' ? 'content' : 'sidebar';
    let src = args.path;

    if (!src) {
      const r = await dialog.showOpenDialog(win, {
        title: slot === 'sidebar' ? '选择左侧栏背景图' : '选择右侧内容区背景图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      src = r.filePaths[0];
    }
    if (!src || !fs.existsSync(src)) return { ok: false, error: '图片不存在或无法读取' };

    // 体积兜底：超过 30MB 的图当背景太夸张，多半是误选
    try {
      const st = fs.statSync(src);
      if (st.size > 30 * 1024 * 1024) {
        return {
          ok: false,
          error: `图片太大（${(st.size / 1048576).toFixed(1)} MB），请换一张小于 30 MB 的`
        };
      }
    } catch { /* 读不到大小就交给后面的复制去报错 */ }

    try {
      await fsp.mkdir(store.bgDir, { recursive: true }).catch(() => {});
      const ext = (path.extname(src) || '.png').toLowerCase();
      // 文件名带时间戳：换图后不会被浏览器缓存住旧图
      const rel = `bg/${slot}-${Date.now()}${ext}`;

      // 先删掉这一栏的旧图，免得越攒越多
      const old = (store.getSettings().bg || {})[slot];
      if (old && old.image) {
        await fsp.unlink(store.bgAbs(old.image)).catch(() => {});
      }

      await fsp.copyFile(src, store.bgAbs(rel));
      await store.setSettings({ bg: { [slot]: { image: rel, type: 'image' } } });

      return { ok: true, rel, url: pathToFileUrl(store.bgAbs(rel)) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  /** 清除某一栏的自定义背景图（磁盘上的副本一并删掉） */
  ipcMain.handle('appearance:clearImage', async (_e, args = {}) => {
    const slot = args.slot === 'content' ? 'content' : 'sidebar';
    const cfg = (store.getSettings().bg || {})[slot];
    if (cfg && cfg.image) {
      await fsp.unlink(store.bgAbs(cfg.image)).catch(() => {});
    }
    await store.setSettings({ bg: { [slot]: { image: '', type: 'default' } } });
    return { ok: true };
  });

  /**
   * 本机可用字体列表。
   * 先读注册表拿全量，失败就退回内置常用字体 ——
   * 绝不因为拿不到字体就让设置面板打不开。
   */
  ipcMain.handle('appearance:fonts', async () => {
    const fromReg = await readSystemFonts();
    const merged = [...new Set([...FONT_PRESETS, ...fromReg])];
    return { ok: true, fonts: merged };
  });

  /**
   * 设置窗口的系统背景材质（透出桌面）。
   *   auto    = 自动：任一栏用了玻璃系材质就透出桌面
   *   off     = 强制不透
   *   acrylic = 亚克力（透桌面 + 模糊）、mica = 云母（偏沉稳）、tabbed = 标签页材质
   *
   * ⚠ 这里存的是「用户偏好」，真正应用到窗口上的值可能不一样
   *   （auto 要按背景材质换算），所以统一交给 resolve 处理。
   */
  ipcMain.handle('appearance:desktopMaterial', async (_e, mode) => {
    const pref = normalizeDesktopMaterial(mode);
    await store.setSettings({ desktopMaterial: pref });
    return syncDesktopMaterial();
  });

  /** 当前系统支不支持这个能力（界面靠它决定要不要禁用选项） */
  ipcMain.handle('appearance:desktopMaterialSupport', () => desktopMaterialSupported());
}

/* ==================================================================
 *  IPC：卸载游戏
 * ================================================================== */

function registerUninstallIpc() {
  /** 卸载前的方案说明（确认弹窗要用：删什么、在哪、多大） */
  ipcMain.handle('game:uninstallInfo', async (_e, id) => {
    const game = library.store.findGame(id);
    if (!game) return { ok: false, error: '游戏不存在' };
    try {
      return await uninstall.describe(game);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * 执行卸载。
   * args: { id, mode }
   *   mode = 'platform' —— 交给 Steam / Epic 自己的卸载流程
   *   mode = 'software' —— 由 GameHub 卸载（自带卸载程序 / 目录进回收站）
   *   mode = 'remove'   —— 只移除库中记录，磁盘文件不动
   */
  ipcMain.handle('game:uninstall', async (_e, args = {}) => {
    const game = library.store.findGame(args.id);
    if (!game) return { ok: false, error: '游戏不存在' };

    const mode = args.mode || 'software';
    const r = await uninstall.run(game, mode);
    if (!r.ok) return r;

    // 什么时候顺手把库记录也清掉：
    //   remove    —— 用户就是要清记录，当然清
    //   trash     —— 目录已经进回收站了，记录留着就是死链
    //   uninstaller / platform —— 卸载向导或平台窗口还没走完，
    //                             这时候删记录会让用户"卸载失败也找不回条目"，
    //                             所以先留着，等用户确认卸完了再刷新
    const shouldRemove = r.mode === 'remove' || r.mode === 'trash';
    if (shouldRemove) {
      library.remove([game.id]);
      emit('library:changed', { reason: 'uninstall' });
    }

    return { ...r, removedFromLibrary: shouldRemove };
  });
}

/* ==================================================================
 *  四、IPC：游戏库
 * ================================================================== */
function registerLibraryIpc() {
  // 列表：附带每款游戏的「正在运行」状态与封面绝对路径（供前端 file:// 引用）
  ipcMain.handle('library:list', (_e, opts) => {
    const running = new Map(launcher.running().map((r) => [r.id, r]));
    const games = library.list(opts || {}).map((g) => decorate(g, running.get(g.id)));
    return {
      games,
      stats: library.stats(),
      categories: library.categories(),
      settings: store.getSettings()
    };
  });

  ipcMain.handle('library:add', (_e, game) => {
    const g = library.addOne(game);
    if (g) queueSizeCalc([g.id]);
    // 带 R18 标签的新游戏 → 自动进隐藏空间
    const r18 = library.syncR18(g ? [g.id] : []);
    emit('library:changed', { reason: 'add' });
    return g ? { ...decorate(g), r18 } : null;
  });

  ipcMain.handle('library:addMany', (_e, games) => {
    const r = library.addMany(games || []);
    queueSizeCalc(r.added.map((g) => g.id));
    const r18 = library.syncR18(r.added.map((g) => g.id));
    emit('library:changed', { reason: 'addMany' });
    return {
      added: r.added.length,
      skipped: r.skipped.length,
      games: r.added.map((g) => decorate(g)),
      r18
    };
  });

  ipcMain.handle('library:update', (_e, id, patch, opts) => {
    const g = library.update(id, patch || {});
    // 只有"分类真的被改了"才检查 R18：改个备注不该把游戏又悄悄藏回去
    const r18 = patch && patch.categories ? library.syncR18([id]) : { hidden: [], pending: [] };
    // silent：这次改动不影响任何统计 / 筛选 / 侧栏计数（比如通关状态），
    // 前端已经在本地把那一张卡刷好了。不发广播是为了不让它整页重绘
    // —— 一重绘，滚动位置弹回顶部、卡片入场动画重播，用户点个「通关」看到这个会很恼火。
    if (!(opts && opts.silent)) emit('library:changed', { reason: 'update', id });
    return g ? { ...decorate(g), r18 } : null;
  });

  ipcMain.handle('library:remove', (_e, ids) => {
    const n = library.remove(ids || []);
    emit('library:changed', { reason: 'remove' });
    return { removed: n };
  });

  ipcMain.handle('library:clear', () => {
    const n = library.clear();
    emit('library:changed', { reason: 'clear' });
    return { removed: n };
  });
}

/** 给游戏对象补充前端需要的计算字段 */
function decorate(g, runningInfo) {
  const out = { ...g };
  // 封面转成前端可直接用的 file:// 地址（带时间戳防缓存）
  if (g.coverPath) {
    out.coverUrl = pathToFileUrl(store.coverAbs(g.coverPath));
  } else {
    out.coverUrl = '';
  }
  out.running = !!runningInfo;
  out.runningSince = runningInfo ? runningInfo.startAt : 0;
  return out;
}

/** Windows 路径 → file:// URL（正确处理中文、空格、反斜杠） */
function pathToFileUrl(p) {
  if (!p) return '';
  let s = p.replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'file://' + encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/* ==================================================================
 *  五、IPC：启动与定位
 * ================================================================== */
function registerLaunchIpc() {
  ipcMain.handle('game:launch', async (_e, id) => {
    const r = await launcher.launch(id);
    return r;
  });

  // 强制结束游戏进程（会先结束计时统计再 taskkill）
  ipcMain.handle('game:stop', (_e, id) => launcher.stop(id));

  ipcMain.handle('game:openFolder', (_e, id) => {
    const g = store.findGame(id);
    if (!g) return { ok: false, error: '游戏不存在' };
    const target = g.exePath && fs.existsSync(g.exePath) ? g.exePath : g.installDir;
    if (!target) return { ok: false, error: '没有记录安装路径' };
    if (g.exePath && fs.existsSync(g.exePath)) shell.showItemInFolder(g.exePath);
    else shell.openPath(g.installDir);
    return { ok: true };
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:openUrl', (_e, u) => { if (/^https?:/i.test(u)) shell.openExternal(u); });

  // 体积计算：前端按需请求（例如详情页点"计算大小"）
  ipcMain.handle('game:calcSize', async (_e, ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    queueSizeCalc(list, true);
    return { queued: list.length };
  });
}

/* ==================================================================
 *  六、IPC：封面
 * ================================================================== */
function registerCoverIpc() {
  const withGame = (id, fn) => {
    const g = store.findGame(id);
    if (!g) return { ok: false, error: '游戏不存在' };
    return fn(g);
  };

  ipcMain.handle('cover:extract', async (_e, id) => withGame(id, async (g) => {
    const r = await cover.extractIcon(g);
    if (r.ok) { store.updateGameCover(id, r); emit('library:changed', { reason: 'cover', id }); }
    return r;
  }));

  ipcMain.handle('cover:setFromFile', async (_e, { id, filePath }) => withGame(id, async (g) => {
    const r = await cover.setFromFile(g, filePath);
    if (r.ok) { store.updateGameCover(id, r); emit('library:changed', { reason: 'cover', id }); }
    return r;
  }));

  ipcMain.handle('cover:setFromData', async (_e, { id, dataUrl }) => withGame(id, async (g) => {
    const r = await cover.setFromData(g, dataUrl);
    if (r.ok) { store.updateGameCover(id, r); emit('library:changed', { reason: 'cover', id }); }
    return r;
  }));

  ipcMain.handle('cover:fetchSteam', async (_e, id) => withGame(id, async (g) => {
    const r = await cover.fetchSteam(g);
    if (r.ok) { store.updateGameCover(id, r); emit('library:changed', { reason: 'cover', id }); }
    return r;
  }));

  ipcMain.handle('cover:reset', async (_e, id) => withGame(id, async (g) => {
    const r = await cover.reset(g);
    store.updateGameCover(id, r);
    emit('library:changed', { reason: 'cover', id });
    return r;
  }));

  /**
   * 「更多选项 → 自动从 Steam 获取封面」
   * 给库里所有还没有官方封面的游戏联网补图：
   *   · 没记 Steam ID 的，先按名字去 Steam 搜（搜不到直接跳过这款）
   *   · 用户自己设过封面的不动
   *   · 全程通过 cover:progress 推给界面显示进度
   */
  ipcMain.handle('cover:steamAll', async () => {
    // 只处理可见游戏：隐藏空间上锁时不该动隐藏的游戏
    const games = library.list({}).filter((g) => !(g.coverKind === 'custom' && g.coverPath));
    if (!games.length) return { ok: true, total: 0, fetched: 0, skipped: [] };

    const r = await cover.steamAll(games, (p) => {
      emit('cover:progress', {
        current: p.current,
        total: p.total,
        name: p.name,
        message: `从 Steam 获取封面 (${p.current}/${p.total})：${p.phase} ${p.name}`
      });
    });
    emit('library:changed', { reason: 'steamCovers' });
    return r;
  });

  /**
   * 详情页封面区的「联网搜索封面」。
   * 单款、用户主动点，所以失败要把原因说清楚，不能像批量那样静默跳过。
   */
  ipcMain.handle('cover:searchOne', async (_e, id) => {
    const g = store.findGame(id);
    if (!g) return { ok: false, error: '游戏不存在' };
    const s = store.getSettings();
    const minScore = MATCH_LEVEL[s.coverMatchLevel] || MATCH_LEVEL.normal;
    const r = await cover.searchOne(g, { minScore });
    if (r.ok) emit('library:changed', { reason: 'coverSearchOne', id });
    return r;
  });

  /**
   * 「设置 → 联网搜索封面」/「更多选项 → 联网搜索缺失封面」
   * ----------------------------------------------------------------
   * 只处理库里【没有封面】的游戏：
   *   · 按顺序尝试：先按名字去 Steam 搜 AppID，搜到就下载官方封面
   *   · 搜不到 / 图床没图 → 静默跳过（用户要求：搜索不到就算了）
   *   · includeIcon = true 时，连已经提取的程序图标也一并升级成官方封面
   * 全程通过 cover:progress 推进度给界面。
   */
  ipcMain.handle('cover:missing', async (_e, opts = {}) => {
    const io = opts || {};
    const s = store.getSettings();
    const minScore = MATCH_LEVEL[s.coverMatchLevel] || MATCH_LEVEL.normal;
    // 只看当前可见的游戏：隐藏空间上锁时不该动里面那些游戏的封面
    const games = library.list({}).filter((g) => needsCover(g, !!io.includeIcon));
    if (!games.length) return { ok: true, cancelled: false, total: 0, fetched: 0, searched: 0, skipped: [] };

    emit('cover:progress', {
      current: 0, total: games.length, name: '',
      message: `联网搜索封面（共 ${games.length} 款缺封面）…`
    });

    const r = await cover.fillMissing(games, { minScore }, (p) => {
      emit('cover:progress', {
        current: p.current,
        total: p.total,
        name: p.name,
        phase: p.phase,
        message: p.phase === '已中止'
          ? '已停止搜索封面'
          : `联网搜索封面 (${p.current}/${p.total})：${p.phase} ${p.name}`
      });
    });
    emit('library:changed', { reason: 'coverSearch' });
    return r;
  });

  /** 中止正在进行的批量封面搜索 */
  ipcMain.handle('cover:cancel', () => {
    cover.cancel();
    emit('cover:progress', { current: 0, total: 0, name: '', phase: '已中止', message: '正在停止…' });
    return { ok: true };
  });

  // 一键给所有缺封面的游戏补图（先试 Steam，再退化成 exe 图标）
  ipcMain.handle('cover:extractAll', async () => {
    const games = store.getGames().filter((g) => !g.coverPath && (g.exePath || g.steamAppId));
    let done = 0;
    for (const g of games) {
      done++;
      emit('scan:progress', { phase: 'cover', message: `提取封面 (${done}/${games.length})：${g.name}`, current: done, total: games.length });
      let r = null;
      if (g.steamAppId) r = await cover.fetchSteam(g);
      if (!r || !r.ok) r = await cover.extractIcon(g);
      if (r && r.ok) store.updateGameCover(g.id, r);
    }
    emit('library:changed', { reason: 'coverAll' });
    return { total: games.length, done };
  });
}

/* ==================================================================
 *  七、IPC：隐藏空间
 * ================================================================== */
function registerHiddenIpc() {
  ipcMain.handle('hidden:status', () => library.hiddenStatus());

  ipcMain.handle('hidden:setup', async (_e, { password, hint }) => {
    const r = await library.setupHidden(password, hint);
    emit('library:changed', { reason: 'hidden' });
    return r;
  });

  ipcMain.handle('hidden:unlock', (_e, password) => {
    const r = library.unlockHidden(password);
    if (r.ok) emit('library:changed', { reason: 'hidden-unlock' });
    return r;
  });

  ipcMain.handle('hidden:lock', () => {
    library.lockHidden(false);
    emit('library:changed', { reason: 'hidden-lock' });
    return { ok: true };
  });

  ipcMain.handle('hidden:changePassword', async (_e, { oldPwd, newPwd, hint }) => {
    return library.changeHiddenPassword(oldPwd, newPwd, hint);
  });

  ipcMain.handle('hidden:disable', async (_e, password) => {
    const r = await library.disableHidden(password);
    if (r.ok) emit('library:changed', { reason: 'hidden-disable' });
    return r;
  });

  // 批量隐藏 / 取消隐藏
  ipcMain.handle('hidden:setHidden', (_e, { ids, hidden }) => {
    const r = library.setHidden(ids, hidden);
    if (r.ok) emit('library:changed', { reason: 'hidden-set' });
    return r;
  });
}

/* ==================================================================
 *  七-b、IPC：游玩统计与自定义分类
 * ================================================================== */
function registerStatsIpc() {
  /**
   * 取某个周期的游玩统计。
   * period: week | month | quarter | year | all
   */
  ipcMain.handle('stats:get', (_e, period) => library.stats(period || 'month'));

  /** 新建自定义分类 */
  ipcMain.handle('category:add', async (_e, name) => {
    const r = await library.addCategory(name);
    if (r.ok) emit('library:changed', { reason: 'category-add' });
    return r;
  });

  /** 重命名分类（会把游戏身上的标签一起改掉） */
  ipcMain.handle('category:rename', async (_e, { oldName, newName }) => {
    const r = await library.renameCategory(oldName, newName);
    if (r.ok) emit('library:changed', { reason: 'category-rename' });
    return r;
  });

  /** 删除分类（从所有游戏身上摘掉这个标签） */
  ipcMain.handle('category:remove', async (_e, name) => {
    const r = await library.removeCategory(name);
    if (r.ok) emit('library:changed', { reason: 'category-remove' });
    return r;
  });
}

/* ==================================================================
 *  八、IPC：扫描
 * ================================================================== */
function registerScanIpc() {
  /** 把候选列表标记出"哪些已经在库里了" */
  function annotate(list) {
    const existIds = new Set(store.getGames().map((g) => g.id));
    const existDirs = new Set(
      store.getGames().filter((g) => g.installDir).map((g) => path.normalize(g.installDir).toLowerCase())
    );
    return list
      .filter((g) => g.name && (g.installDir || g.exePath)) // 没路径的收进来也没法启动，丢弃
      .map((g) => {
        const dir = g.installDir ? path.normalize(g.installDir).toLowerCase() : '';
        const already = existIds.has(g.id) || (dir && existDirs.has(dir));
        return { ...g, alreadyInLibrary: !!already };
      })
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || a.name.localeCompare(b.name, 'zh'));
  }

  ipcMain.handle('scan:auto', async (_e, opts = {}) => {
    if (scanning) return { ok: false, error: '已有扫描任务在进行中' };
    scanning = true;
    scanCancelled = false;

    const folders = opts.folders || store.getSettings().scanFolders || [];
    try {
      emit('scan:progress', { phase: 'start', message: '开始嗅探本机游戏 …' });
      const list = await scanner.sniffAll({
        folders,
        include: opts.include || { registry: true, steam: true, epic: true, folder: true },
        onProgress: (p) => emit('scan:progress', p),
        isCancelled: () => scanCancelled
      });
      const annotated = annotate(list);
      emit('scan:progress', { phase: 'end', message: `嗅探完成，共 ${annotated.length} 个候选` });
      emit('scan:done', { list: annotated, cancelled: scanCancelled });
      return { ok: true, list: annotated, cancelled: scanCancelled };
    } catch (e) {
      emit('scan:progress', { phase: 'error', message: '扫描出错：' + (e.message || e) });
      return { ok: false, error: e.message || String(e) };
    } finally {
      scanning = false;
    }
  });

  ipcMain.handle('scan:folder', async (_e, args = {}) => {
    if (scanning) return { ok: false, error: '已有扫描任务在进行中' };
    scanning = true;
    scanCancelled = false;
    try {
      const dirs = args.dirs && args.dirs.length ? args.dirs : [args.dir].filter(Boolean);
      const mode = args.mode || 'smart';
      let all = [];
      for (let i = 0; i < dirs.length; i++) {
        emit('scan:progress', { phase: 'folder', message: `(${i + 1}/${dirs.length}) 扫描目录：${dirs[i]}` });
        all = all.concat(await scanner.scanFolder(dirs[i], {
          mode,
          maxDepth: args.maxDepth || 3,
          onProgress: (p) => emit('scan:progress', p),
          isCancelled: () => scanCancelled
        }));
      }
      const deduped = scanner.dedupe(all);
      const annotated = annotate(deduped);
      emit('scan:done', { list: annotated, cancelled: scanCancelled });
      return { ok: true, list: annotated, cancelled: scanCancelled };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      scanning = false;
    }
  });

  ipcMain.handle('scan:cancel', () => {
    scanCancelled = true;
    return { ok: true };
  });

  /** 系统默认的游戏常见目录（用于给用户推荐） */
  ipcMain.handle('scan:defaultFolders', async () => {
    const candidates = [];
    const drives = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
    for (const d of drives) {
      for (const sub of ['\\Games', '\\Game', '\\游戏', '\\SteamLibrary', '\\Program Files\\Games', '\\Program Files (x86)\\Games', '\\Program Files\\Tencent', '\\Program Files\\WeGameApps']) {
        const p = path.join(d, sub);
        try {
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) candidates.push(p);
        } catch { /* 跳过无权限的盘 */ }
      }
    }
    return candidates;
  });
}

/* ==================================================================
 *  九、IPC：游戏平台（账号 + 游戏库抓取）
 * --------------------------------------------------------------------
 *  设计红线（改这块代码时不要破坏）：
 *    · 只读本机平台留下的文件，绝不写回；
 *    · 不碰任何密码 / 令牌；
 *    · 结果只留在 GameHub 自己的数据里，不上传。
 * ================================================================== */
function registerPlatformIpc() {
  /**
   * 只做检测：装没装 / 有没有本地数据。很快，开机就调。
   */
  ipcMain.handle('platform:list', async () => {
    return { ok: true, platforms: await platforms.listPlatforms() };
  });

  /**
   * 同步某个平台的账号 + 游戏库。
   * 本地封面/头像路径顺手转成前端能直接用的 file:// 地址。
   */
  ipcMain.handle('platform:sync', async (_e, args = {}) => {
    const r = await platforms.syncPlatform(args.id, {
      accountId: args.accountId,
      onProgress: (p) => emit('platform:progress', { id: args.id, ...p })
    });
    if (!r || !r.ok || !Array.isArray(r.games)) return r;

    // 顺手把 Steam 的时长并进游戏库：平台页同步完之后，「全部游戏」那边
    // 的时长/最近游玩也要跟着对，不然同一个账号两个页面显示两个数。
    // 只增不减（见 library.mergeSteamPlaytime 的注释），所以不会覆盖本地记录。
    if (args.id === 'steam') {
      const map = {};
      for (const g of r.games) {
        if (g && g.appId) map[String(g.appId)] = { playtimeMs: g.playtimeMs, lastPlayed: g.lastPlayed };
      }
      const m = library.mergeSteamPlaytime(map);
      if (m.changed) {
        r.mergedIntoLibrary = m.changed;
        emit('library:changed', { reason: 'steam-playtime' });
      }
    }

    r.games = r.games.map((g) => ({
      ...g,
      localCoverUrl: pathToFileUrl(g.localCover),
      localHeroUrl: pathToFileUrl(g.localHero),
      localLogoUrl: pathToFileUrl(g.localLogo)
    }));
    if (r.account && r.account.avatarHash && args.id === 'steam') {
      r.account.avatarUrl = platforms.steamAvatarUrl(r.account.avatarHash, 'medium');
      r.account.avatarUrlLarge = platforms.steamAvatarUrl(r.account.avatarHash, 'full');
    }
    return r;
  });

  /**
   * 拉起平台客户端干一件事：install / run / store / open。
   * 走的是平台自己注册的自定义协议（steam:// 之类），
   * 由系统把请求交给已安装的客户端 —— 我们不做任何下载或注入。
   */
  ipcMain.handle('platform:action', async (_e, args = {}) => {
    const { id, action, appId } = args;
    const meta = platforms.metaOf(id);
    if (!meta) return { ok: false, error: `未知平台：${id}` };

    let url = '';
    if (action === 'install') url = meta.installProtocol ? meta.installProtocol(appId) : '';
    else if (action === 'run') url = meta.runProtocol ? meta.runProtocol(appId) : '';
    else if (action === 'store') url = meta.storeProtocol ? meta.storeProtocol(appId) : '';
    else if (action === 'open') url = meta.protocol || '';
    if (!url) return { ok: false, error: `${meta.name} 不支持「${action}」` };

    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: e.message || String(e), url };
    }
  });

  /* ---------------- Epic 账号登录（B 路线） ---------------- */

  /**
   * 当前 Epic 登录状态。界面靠它决定显示「登录」还是「已登录」。
   */
  ipcMain.handle('epic:status', async () => {
    if (!epicAuth) return { loggedIn: false, available: false };
    return { ...epicAuth.status(), available: true };
  });

  /**
   * 弹一个 Epic 官方登录窗口让用户授权。
   *
   * 全程走 Epic 自己的页面：账号密码从头到尾不经过 GameHub，
   * 我们也拿不到 —— 换回来的只有一个只读用途的 token。
   */
  ipcMain.handle('epic:login', async () => {
    if (!epicAuth) return { ok: false, error: 'Epic 登录功能尚未初始化' };
    try {
      return await epicAuth.login(win);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * 退出登录：只删本机存的凭证。
   * Epic 客户端那边的会话不受影响 —— 那是 Epic 自己的事。
   */
  ipcMain.handle('epic:logout', async () => {
    if (!epicAuth) return { ok: false, error: 'Epic 登录功能尚未初始化' };
    return epicAuth.logout();
  });
}

/* ==================================================================
 *  十、IPC：MOD 管理
 * ================================================================== */
function registerModIpc() {
  /** 找游戏 + 统一错误包装 */
  const withGame = (id, fn) => {
    const g = store.findGame(id);
    if (!g) return { ok: false, error: '游戏不存在' };
    return fn(g);
  };

  /**
   * 列出某款游戏的全部 MOD。
   * online=false 时只看本地 + 缓存 —— 用于"先秒出列表，再联网补名字"。
   */
  ipcMain.handle('mod:list', async (_e, args = {}) => {
    if (!mods) return { ok: false, error: 'MOD 管理尚未初始化' };
    return withGame(args.id, (g) => mods.list(g, {
      online: args.online !== false,
      force: !!args.force,
      sortBy: args.sortBy || 'name',
      asc: args.asc !== false
    }));
  });

  /**
   * 启用 / 禁用。靠给目录或文件改名实现（可逆、可见，不丢数据）。
   */
  ipcMain.handle('mod:setEnabled', async (_e, args = {}) => {
    if (!mods) return { ok: false, error: 'MOD 管理尚未初始化' };
    const r = await mods.setEnabled({ path: args.path }, args.enabled !== false);
    if (r.ok) emit('library:changed', { reason: 'mod-toggled' });
    return r;
  });

  /**
   * 删除 —— **移入回收站，不是真删除**。
   *
   * 这个通道刻意不在主进程里再弹一次确认框：
   * 确认由界面负责（它能把 MOD 名字、大小、完整路径一次性摆清楚），
   * 主进程这边只保留"关键目录一律拒绝"这道硬闸。
   */
  ipcMain.handle('mod:remove', async (_e, args = {}) => {
    if (!mods) return { ok: false, error: 'MOD 管理尚未初始化' };
    const gameId = args.gameId || '';
    const r = await mods.remove({ path: args.path });
    // 手动加进来的那条记录也要一起摘掉，不然列表里会留一条点不动的幽灵
    if (r.ok && gameId && mods.isManual(gameId, args.path)) mods.forgetManual(gameId, args.path);
    if (r.ok) emit('library:changed', { reason: 'mod-removed' });
    return r;
  });

  /** 手动添加一个 MOD：非 Steam 游戏主要靠这条路 */
  ipcMain.handle('mod:addManual', async (_e, args = {}) => {
    if (!mods) return { ok: false, error: 'MOD 管理尚未初始化' };
    let p = args.path || '';
    if (!p) {
      // 没传路径就自己弹一个选择框：选文件夹（目录式 MOD）或选中 mod 文件
      const r = await dialog.showOpenDialog(win, {
        title: '选择要添加的 MOD（文件夹或文件）',
        properties: ['openFile', 'openDirectory'],
        defaultPath: args.installDir || undefined
      });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
      p = r.filePaths[0];
    }
    const r = await mods.addManual(args.id, p);
    if (r.ok) emit('library:changed', { reason: 'mod-added' });
    return r;
  });

  /** 只是不想在 GameHub 里看到它 —— 不碰磁盘文件 */
  ipcMain.handle('mod:forget', async (_e, args = {}) => {
    if (!mods) return { ok: false, error: 'MOD 管理尚未初始化' };
    const r = mods.forgetManual(args.id, args.path);
    if (r.ok) emit('library:changed', { reason: 'mod-forgotten' });
    return r;
  });

  /** 在资源管理器里定位 MOD 所在的目录 */
  ipcMain.handle('mod:reveal', async (_e, args = {}) => {
    const p = String(args.path || '');
    if (!p) return { ok: false, error: '没有路径' };
    try {
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && st.isDirectory()) { shell.openPath(p); return { ok: true }; }
      shell.showItemInFolder(p);      // 文件的话选中它，更直观
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * 「添加 MOD」按钮的落点。
   *
   * 主人定的规则：
   *   · Steam 游戏 → 点添加就跳到 Steam 创意工坊去订阅
   *   · 非 Steam 游戏 → 只能自己添加
   * 所以这里按有没有 steamAppId 分两条路。
   */
  ipcMain.handle('mod:openWorkshop', async (_e, args = {}) => {
    const appId = String(args.appId || '').trim();
    if (!appId) return { ok: false, error: '这款游戏没有 Steam AppID，去不了创意工坊' };
    const url = args.client ? steamWorkshopClientUrl(appId) : steamWorkshopWebUrl(appId);
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (e) {
      // steam:// 没装客户端时会抛错 —— 退回网页版，别让用户点了没反应
      if (args.client) {
        try {
          await shell.openExternal(steamWorkshopWebUrl(appId));
          return { ok: true, url: steamWorkshopWebUrl(appId), fellBack: true };
        } catch { /* 继续往外报错 */ }
      }
      return { ok: false, error: '打不开链接：' + (e.message || e) };
    }
  });

  /** N 网（Nexus Mods）的游戏搜索页 */
  ipcMain.handle('mod:openNexus', async (_e, args = {}) => {
    const name = String(args.name || '').trim();
    if (!name) return { ok: false, error: '没有游戏名，搜不了' };
    const url = nexusSearchUrl(name);
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: '打开 N 网失败：' + (e.message || e) };
    }
  });
}

/* ==================================================================
 *  十一、IPC：系统对话框
 * ================================================================== */
function registerDialogIpc() {
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要扫描的文件夹',
      properties: ['openDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFolders', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要扫描的文件夹（可多选）',
      properties: ['openDirectory', 'multiSelections']
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:pickExe', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择游戏主程序',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd', 'lnk'] }]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择封面图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickImages', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择封面图片（可多选，将按顺序分配给选中的游戏）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:message', async (_e, opts = {}) => {
    const r = await dialog.showMessageBox(win, {
      type: opts.type || 'info',
      title: opts.title || 'GameHub',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['好'],
      cancelId: opts.cancelId ?? 0,
      defaultId: opts.defaultId ?? 0,
      noLink: true
    });
    return r.response;
  });
}

/* ==================================================================
 *  九·b、后台任务：Steam 时长对齐
 * ================================================================== */
/**
 * 启动后在后台把 Steam 记的时长并进游戏库。
 *
 * 为什么开机就要做一次、而不能等用户点进「游戏平台」或某个游戏详情页：
 *   详情页的时长读的是库里的字段，而库里只有在"平台同步过"之后才是对的。
 *   不主动做的话，用户看到的就是「有的游戏有时长和成就、有的什么都没有」
 *   —— 差别不在于游戏本身，而在于"这次开机之后有没有碰过平台页"。
 *
 * 成本极低：只解析一个 localconfig.vdf（几十 KB～几百 KB），毫秒级。
 * Steam 没装 / 没登录 / 文件坏了，全部静默跳过，绝不弹错。
 */
let steamPlaytimeSyncing = false;
async function syncSteamPlaytimeInBackground() {
  if (steamPlaytimeSyncing) return;
  steamPlaytimeSyncing = true;
  try {
    const r = await platforms.steamPlaytimes();
    if (!r || !r.ok) return;
    const m = library.mergeSteamPlaytime(r.apps);
    // 只有真的变了才广播 —— 否则每次开机都白刷一次界面
    if (m.changed) emit('library:changed', { reason: 'steam-playtime' });
  } catch { /* 对齐失败不影响任何功能，下次开机再来 */ }
  finally { steamPlaytimeSyncing = false; }
}

/* ==================================================================
 *  十、后台任务：体积计算队列
 * ================================================================== */
/**
 * 把缺体积的游戏排进后台队列，逐个计算。
 * 之所以放后台，是因为递归统计一个 50GB 的游戏目录可能要好几秒，
 * 不能让界面卡住。算完一个就通过 size:updated 推给前端刷新。
 */
function queueSizeCalc(ids, force = false) {
  for (const id of ids || []) {
    const g = store.findGame(id);
    if (!g || !g.installDir) continue;
    if (!force && g.sizeBytes > 0) continue;
    if (g.hidden && !library._unlocked) continue; // 隐藏空间上锁时不去碰它们
    if (!sizeQueue.pending.includes(id)) sizeQueue.pending.push(id);
  }
  runSizeQueue();
}

async function runSizeQueue() {
  if (sizeQueue.running) return;
  sizeQueue.running = true;
  while (sizeQueue.pending.length) {
    const id = sizeQueue.pending.shift();
    try {
      const g = await library.computeSize(id);
      if (g) emit('size:updated', { id, sizeBytes: g.sizeBytes });
    } catch { /* 单个失败不影响整体 */ }
  }
  sizeQueue.running = false;
}

/* ==================================================================
 *  十一、启动流程
 * ================================================================== */
async function bootstrap() {
  const dataDir = app.getPath('userData');

  store = new Store(dataDir);
  await store.init();

  library = new Library(store);
  launcher = new Launcher(library, (payload) => {
    // 把启动器的状态转发给界面
    switch (payload.type) {
      case 'launch': emit('game:state', { action: 'launch', ...payload }); break;
      case 'exit': emit('game:state', { action: 'exit', ...payload }); break;
      case 'tick': emit('game:state', { action: 'tick', ...payload }); break;
      case 'launchError': emit('game:state', { action: 'error', ...payload }); break;
    }
  });
  cover = new CoverManager(store);

  // Epic 账号登录客户端。凭证落在 userData 里（能加密就加密）。
  // ⚠ 必须放在 app ready 之后：Electron 的 safeStorage 此时才可用。
  epicAuth = createEpicAuth({ dataDir, onLog: (m) => console.log('[Epic]', m) });
  platforms.setEpicAuth(() => epicAuth);

  // MOD 管理器：发现 / 启用 / 禁用 / 删除（进回收站）。
  // 手动添加的 MOD 记录和创意工坊元数据缓存都落在 userData 里。
  mods = createMods({ dataDir, onLog: (m) => console.log('[MOD]', m) });

  // 隐藏空间自动上锁 → 通知界面立刻隐藏内容
  library.onAutoLock(() => {
    emit('hidden:locked', {});
    emit('library:changed', { reason: 'hidden-autolock' });
  });

  // 老版本只存了累计时长、没有一局一局的流水，先迁移一次，统计页才不是空的
  const migrated = library.migrateLegacyPlaytime();
  if (migrated) console.log(`[统计] 已把 ${migrated} 款游戏的历史累计时长迁移为初始游玩记录`);

  nativeTheme.themeSource = store.getSettings().theme || 'dark';
}

app.whenReady().then(async () => {
  markStarting();
  await bootstrap();

  // 单实例：第二次启动时把已有窗口唤到前台
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  registerBaseIpc();
  registerSettingsIpc();
  registerLibraryIpc();
  registerLaunchIpc();
  registerCoverIpc();
  registerHiddenIpc();
  registerStatsIpc();
  registerScanIpc();
  registerPlatformIpc();
  registerModIpc();
  registerDialogIpc();
  registerAppearanceIpc();
  registerUninstallIpc();

  createWindow();

  if (SELFTEST) {
    runSelfTest();
  } else if (PROBE) {
    runProbe();
  } else if (SHOT) {
    runScreenshot();
  } else {
    // 启动后：先巡检一次路径有效性，再按设置决定要不要自动嗅探
    win.webContents.once('did-finish-load', async () => {
      // 自动降级到软件渲染时告知用户一声，免得以为是性能问题
      if (gpuDisabled && !process.argv.includes('--disable-gpu')) {
        emit('toast', {
          type: 'warn',
          message: '上次启动似乎因为显卡兼容问题中断，已自动切换到兼容模式（软件渲染）。'
        });
      }

      const missing = await library.checkMissing();
      if (missing.length) emit('library:changed', { reason: 'missing-check' });

      // 后台对一次 Steam 时长（毫秒级：只解析 localconfig.vdf）。
      // 不 await、不阻塞上面的巡检 —— 就算 Steam 没装/没登录也只是静默跳过。
      syncSteamPlaytimeInBackground();

      // 补算历史数据里没有体积的游戏
      queueSizeCalc(store.getGames().map((g) => g.id));

      if (store.getSettings().autoScanOnStart && store.getGames().length === 0) {
        emit('toast', { type: 'info', message: '首次启动，正在自动嗅探本机游戏 …' });
      }
    });
  }
});

/* 所有窗口关闭时退出（macOS 除外，符合平台习惯） */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 退出前把数据写盘（只拦一次，否则会陷入"永远退不掉"的死循环）
let flushedBeforeQuit = false;
app.on('before-quit', async (e) => {
  if (flushedBeforeQuit || !store) return;
  flushedBeforeQuit = true;
  e.preventDefault();
  try { await store.flush(); } catch { /* 写盘失败也要让程序退出 */ }
  app.quit();
});

/* ==================================================================
 *  十二、自检模式：无界面跑一遍核心流程，用于开发期验证
 * ================================================================== */
async function runSelfTest() {
  /* ⚠ 打包成 exe 之后是 GUI 程序，console.log 根本没有控制台可写 ——
   *   实测成品包跑 --selftest 一行输出都拿不到，于是"用成品包复验"这件事
   *   一直只能靠"能启动就万事大吉"这种糊弄过去。
   *   所以和探针的 PROBE_OUT 一样，给自检也留一个落盘开关：
   *   SELFTEST_OUT=<文件> 时把每一行都同时写进去。 */
  const outFile = process.env.SELFTEST_OUT || '';
  const lines = [];
  let nOk = 0;
  let nBad = 0;
  const log = (...a) => {
    const s = a.map((x) => (typeof x === 'string' ? x : (() => {
      try { return JSON.stringify(x); } catch { return String(x); }
    })())).join(' ');
    // 顺手数一下通过/失败：一场自检几十行，靠肉眼数 ✓ 很容易漏看一个 ✗
    if (s.includes('✗')) nBad += 1;
    else if (s.includes('✓')) nOk += 1;
    console.log('[自检]', ...a);
    lines.push(s);
  };
  const flush = () => {
    if (!outFile) return;
    try { fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8'); } catch { /* 写不了就算了 */ }
  };
  try {
    log('数据目录：', app.getPath('userData'));
    log('窗口已创建，等待页面加载 …');

    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    log('页面加载完成 ✓');

    // 检查前端是否成功挂载
    const mounted = await win.webContents.executeJavaScript(
      'document.querySelectorAll(".gh-sidebar, .sidebar").length > 0'
    ).catch(() => false);
    log('前端界面挂载：', mounted ? '✓' : '✗ 未找到侧边栏元素');

    const jsErrors = await win.webContents.executeJavaScript('window.__gamehubErrors || []').catch(() => []);
    log('前端捕获到的错误：', jsErrors.length ? jsErrors : '无 ✓');

    // 把每个视图都走一遍：光是"首页能挂载"说明不了什么，
    // 之前详情页和统计页都是在切过去之后才崩的，所以这里逐页渲染并收错。
    log('逐个视图渲染检查 …');
    const VIEWS = ['home', 'all', 'recent', 'favorite', 'stats', 'platform', 'hidden'];
    for (const v of VIEWS) {
      const before = (await win.webContents.executeJavaScript('window.__gamehubErrors || []').catch(() => [])).length;
      const r = await win.webContents.executeJavaScript(`(async () => {
        try {
          window.App.goto(${JSON.stringify(v)});
          // 平台页是异步拉数据的，多等一会儿
          await new Promise(res => setTimeout(res, ${v === 'platform' ? 2500 : 250}));
          return { ok: true, nodes: document.querySelector('#contentBody').childElementCount };
        } catch (e) { return { ok: false, error: e.message }; }
      })()`).catch((e) => ({ ok: false, error: e.message }));

      const after = await win.webContents.executeJavaScript('window.__gamehubErrors || []').catch(() => []);
      const newErrs = after.slice(before);
      if (!r.ok) log(`  ${v.padEnd(9)} ✗ 渲染抛错：${r.error}`);
      else if (newErrs.length) log(`  ${v.padEnd(9)} ✗ 新报错 ${newErrs.length} 条：${JSON.stringify(newErrs[0]).slice(0, 160)}`);
      else log(`  ${v.padEnd(9)} ✓ 内容节点 ${r.nodes}`);
    }

    // 详情页一致性检查：
    // 「全部游戏」和「平台总览」两个入口的详情页必须共用 js/detailkit.js 的同一套构件。
    // 之前两边各写了一套 DOM（.detail-* / .pfd-*），同一个游戏点开长得不一样，
    // 用户直接反馈"界面不统一"，所以这里把结构的类名抓出来做硬性比对。
    log('详情页构件检查 …');
    const shape = await win.webContents.executeJavaScript(`(async () => {
      window.App.goto('all');
      await new Promise(r => setTimeout(r, 300));
      let g = window.State.games[0];
      if (!g) {
        // 自检环境是从零开始的空库，临时塞一条假的，保证这条检查真的跑到
        // （不写盘，函数结束前会被清掉）。
        // 注意要带上时长 —— 没有时长、没有启动次数、又拿不到成就的游戏，
        // 标题旁那条统计行会被构件主动摘掉（这是对的），那样就量不到 statline 了。
        // clearState 也要带：这个对象是直接 push 进 State.games 的，绕过了
        // normalizeGame，少一个字段后面所有"卡片上该有的东西"都会跟着缺。
        g = {
          id: '__selftest__', name: '自检示例游戏', categories: ['模拟'],
          source: 'manual', totalPlayMs: 7200000, playCount: 3,
          clearState: 'uncleared', favorite: false, hidden: false
        };
        window.State.games.push(g);
      }
      window.Detail.open(g.id);
      await new Promise(r => setTimeout(r, 300));
      const layer = document.querySelector('#detailLayer');
      const q = (s) => Boolean(layer.querySelector(s));
      const r = {
        hero: q('.pfd-hero'), cover: q('.pfd-cover'), title: q('.pfd-title'),
        statline: q('.pfd-statline'), bar: q('.pfd-bar'), body: q('.pfd-body'),
        sec: q('.pfd-sec'), kv: q('.pfd-kv'), close: q('.detail-close'),
        secs: [...layer.querySelectorAll('.pfd-sec-title')].map(n => n.textContent)
      };
      window.Detail.close();
      return { ok: true, ...r };
    })()`).catch((e) => ({ ok: false, error: e.message }));

    if (!shape.ok) {
      log('  ✗ ', shape.error);
    } else {
      const miss = ['hero', 'cover', 'title', 'statline', 'bar', 'body', 'sec', 'kv', 'close']
        .filter((k) => !shape[k]);
      log('  区块：', shape.secs.join(' / '));
      log('  构件：', miss.length ? `✗ 缺少 ${miss.join(', ')}` : '✓ 齐全（hero/封面/统计行/操作条/可收起区块/键值网格）');
    }

    // 设置面板检查：
    // 第八轮把设置做成了多分区的自定义选项集合，并加了「联网搜索封面」这一块。
    // 这里要验证的是：① 面板能画出来不报错 ② 每个分区都在 ③ 改外观开关真的会写进设置
    // ④ 「立即联网搜索封面」按钮存在且没封面时会禁用 —— 光看 exist 是骗人的。
    log('设置面板检查 …');
    const setRes = await win.webContents.executeJavaScript(`(async () => {
      window.Modals.settings();
      await new Promise(r => setTimeout(r, 400));
      const body = document.querySelector('#modalLayer .modal-body');
      if (!body) return { ok: false, error: '设置面板没有画出来' };
      const titles = [...body.querySelectorAll('.detail-section-title')].map(t => t.textContent.trim());
      const want = ['外观与卡片', '封面与联网搜索', '游戏嗅探', '游戏平台', '游玩统计', '隐藏空间', '数据'];
      const missSec = want.filter(w => !titles.includes(w));

      // 翻开关 → 必须真的落进 State.settings
      const row = [...body.querySelectorAll('.switch-row')]
        .find(r => r.textContent.includes('卡片显示成就角标'));
      const before = window.State.settings.cardAchievements;
      row && row.click();
      await new Promise(r => setTimeout(r, 250));
      const after = window.State.settings.cardAchievements;

      // 「立即联网搜索封面」按钮 + 缺封面统计
      const runBtn = [...body.querySelectorAll('.btn')].find(b => b.textContent.includes('立即联网搜索封面'));
      const desc = [...body.querySelectorAll('.form-desc')].map(d => d.textContent.trim())
        .find(t => t.includes('缺封面') || t.includes('都有封面'));

      window.Modals.closeModal();
      // 关掉之后进度订阅必须已经退订，否则每次开设置都多留一个监听器
      return {
        ok: true,
        titles, missSec,
        switchFlipped: before !== after,
        hasRunBtn: !!runBtn,
        runDisabled: runBtn ? runBtn.disabled : null,
        desc: desc || ''
      };
    })()`).catch((e) => ({ ok: false, error: e.message }));

    if (!setRes.ok) log('  ✗ ', setRes.error);
    else {
      log('  分区：', setRes.titles.join(' / '));
      log('  缺少的分区：', setRes.missSec.length ? '✗ ' + setRes.missSec.join(', ') : '无 ✓');
      log('  开关真的写进设置：', setRes.switchFlipped ? '✓' : '✗ 点了没反应');
      log('  联网搜索按钮：', setRes.hasRunBtn ? `✓（当前 ${setRes.runDisabled ? '禁用：' + setRes.desc : '可点：' + setRes.desc}）` : '✗ 没找到按钮');
    }

    // 批量删除面板检查：
    // 删东西的功能最怕"列表没列全 / 页脚计数不同步"，所以这里看三点：
    // 条数对不对、缩略图有没有、空选时删除按钮是不是真的禁用。
    log('批量删除面板检查 …');
    const bres = await win.webContents.executeJavaScript(`(async () => {
      window.Modals.batchRemove();
      await new Promise(r => setTimeout(r, 500));
      const rows = document.querySelectorAll('#modalLayer .scan-item').length;
      const thumbs = document.querySelectorAll('#modalLayer .scan-thumb').length;
      const delBtn = document.querySelector('#modalLayer .modal-foot .btn-danger');
      let footBefore = document.querySelector('#modalLayer .modal-foot .scan-count').textContent;
      const first = document.querySelector('#modalLayer .scan-item');
      first && first.click();
      await new Promise(r => setTimeout(r, 300));
      const footAfter = document.querySelector('#modalLayer .modal-foot .scan-count').textContent;
      window.Modals.closeModal();
      return {
        ok: true, rows, thumbs,
        disabledWhenEmpty: delBtn ? delBtn.disabled : null,
        footBefore, footAfter,
        libSize: window.State.games.length
      };
    })()`).catch((e) => ({ ok: false, error: e.message }));

    if (!bres.ok) log('  ✗ ', bres.error);
    else {
      log(`  列表 ${bres.rows} 行 / 缩略图 ${bres.thumbs} 个（库里 ${bres.libSize} 款）`);
      log('  条数对得上：', bres.rows === bres.libSize ? '✓' : '✗');
      log('  空选时删除按钮禁用：', bres.disabledWhenEmpty ? '✓' : '✗');
      log('  页脚计数同步：', bres.footBefore !== bres.footAfter ? `✓ ${bres.footBefore} → ${bres.footAfter}` : `✗ 点了没变（${bres.footAfter}）`);
    }

    // 逐款自定义 · 页签上的「×」检查：
    // 第九轮加的入口，最怕两件事：① 点 × 只删了页签，picked 没同步 → 退回去又被勾上
    // ② 页脚 / 导入按钮 / 副标题三处数字不同步 → 用户以为还剩 5 款其实只剩 2 款。
    log('逐款自定义 · 页签×检查 …');
    const cres = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const txt = (n) => (n ? n.textContent.trim() : null);
      const clickByText = (sel, t) => {
        const b = [...document.querySelectorAll(sel)].find(x => x.textContent.includes(t));
        if (!b) throw new Error('找不到按钮：' + t);
        b.click();
      };
      const runId = String(Date.now()).slice(-6);
      const demo = ['甲-A', '乙-B', '丙-C', '丁-D'].map((name, i) => ({
        id: 'st-' + runId + '-' + i, name,
        installDir: 'F:\\\\st-' + runId + '\\\\' + name,
        exePath: 'F:\\\\st-' + runId + '\\\\' + name + '\\\\' + name + '.exe',
        source: 'folder', sourceLabel: '文件夹', confidence: 10,
        categories: [], alreadyInLibrary: false
      }));
      const tabs = () => [...document.querySelectorAll('.cz-tab')];
      const tabNames = () => tabs().map(t => txt(t.querySelector('.cz-tab-name')));

      window.Modals.scanResults(demo);
      await sleep(400);
      clickByText('.modal-foot .btn', '逐款自定义');
      await sleep(450);

      // ⚠ 数量必须在这里取：后面会把页签全删光，等收尾再数就只剩 0 了
      const tabCount0 = tabs().length;
      const xCount = tabs().filter(t => t.querySelector('.cz-tab-x')).length;
      const foot0 = txt(document.querySelector('.modal-foot .scan-count'));
      const btn0 = [...document.querySelectorAll('.modal-foot .btn')].map(txt).find(t => t.includes('全部导入'));
      const sub0 = txt(document.querySelector('.modal-sub'));

      // 删掉第 1 款（当前页），应停在原地并落到「乙-B」
      tabs()[0].querySelector('.cz-tab-x').click();
      await sleep(350);
      const foot1 = txt(document.querySelector('.modal-foot .scan-count'));
      const btn1 = [...document.querySelectorAll('.modal-foot .btn')].map(txt).find(t => t.includes('全部导入'));
      const sub1 = txt(document.querySelector('.modal-sub'));
      const nowName = document.querySelector('.cz-page .input').value;

      // 返回勾选列表：被删的那款不能再是勾选状态
      clickByText('.modal-foot .btn', '返回');
      await sleep(450);
      const checked = document.querySelectorAll('.scan-item.checked').length;

      // 把剩下的全删光 → 弹窗应该自己关掉
      clickByText('.modal-foot .btn', '逐款自定义');
      await sleep(450);
      const left = tabs().length;
      for (let k = 0; k < left; k++) {
        const x = tabs()[0] && tabs()[0].querySelector('.cz-tab-x');
        if (x) x.click();
        await sleep(280);
      }
      await sleep(350);
      const layer = document.querySelector('#modalLayer');
      window.Modals.closeModal();
      return {
        ok: true, tabCount: tabCount0, xCount,
        foot0, btn0, sub0, foot1, btn1, sub1, nowName,
        checkedAfterBack: checked, closedWhenEmpty: Boolean(layer && layer.hidden)
      };
    })()`).catch((e) => ({ ok: false, error: e.message }));

    if (!cres.ok) log('  ✗ ', cres.error);
    else {
      log(`  页签 ${cres.tabCount} 个，带 × 的 ${cres.xCount} 个`, cres.xCount === cres.tabCount ? '✓' : '✗ 有页签漏了 ×');
      log('  删一款后停在下一款：', cres.nowName === '乙-B' ? `✓ ${cres.nowName}` : `✗ 落在 ${cres.nowName}`);
      log('  三处数字同步：', (cres.foot0 !== cres.foot1 && cres.btn0 !== cres.btn1 && cres.sub0 !== cres.sub1)
        ? `✓ ${cres.foot0}/${cres.btn0} → ${cres.foot1}/${cres.btn1}` : `✗ ${cres.foot1}/${cres.btn1}`);
      log('  返回后勾选同步：', cres.checkedAfterBack === 3 ? '✓ 剩 3 款被勾' : `✗ 返回后勾了 ${cres.checkedAfterBack} 款`);
      log('  全删光自动关闭：', cres.closedWhenEmpty ? '✓' : '✗ 弹窗还开着');
    }

    // 卡片右上角「⋮ 通关状态」检查：
    // 这里最容易出错的不是"能不能点"，而是两件事：
    //   ① 默认值得是「未通关」（主人定的规则：所有游戏默认未通关，没有"未标记"档）
    //   ② 改一下状态不能触发整页重绘 —— 一重绘滚动位置就弹回顶部，
    //      连着标十款游戏会被弹十次。所以专门验一下网格节点还是原来那个。
    log('卡片「⋮ 通关状态」检查 …');
    const clres = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const txt = (n) => (n ? n.textContent.trim() : null);
      const $ = (s) => document.querySelector(s);
      const $$ = (s) => [...document.querySelectorAll(s)];

      window.Modals.closeModal();
      window.Detail.close();
      window.State.view = 'all';
      window.State.category = null;
      window.State.viewMode = 'grid';

      // ⚠ 自检库是从零开始的空库，屏幕上唯一那张卡是上面详情页检查临时塞的假对象
      //   （绕过 normalizeGame，写不回库）。要验"点了真的落库"就必须有一条真的游戏，
      //   所以这里走真实 IPC 加一条出来，验完删掉。路径留空 —— 这样不会触发
      //   体积计算和封面抓取，整套检查是离线、秒级的。
      const gid = '__st_clear__';
      await window.API.addOne({ id: gid, name: '通关状态自检', source: 'manual', categories: ['其他'] });
      await window.App.refresh();
      await sleep(400);

      const card = () => $('#contentBody .game-card[data-id="' + gid + '"]');
      const gameOf = () => window.State.games.find(g => String(g.id) === String(gid));
      if (!card()) return { ok: false, error: '新建的自检游戏没渲染出卡片' };

      const withMore = $$('#contentBody .game-card[data-id]').filter(c => c.querySelector('.card-more')).length;
      const withBadge = $$('#contentBody .game-card[data-id]').filter(c => c.querySelector('.card-clear')).length;
      const totalCards = $$('#contentBody .game-card[data-id]').length;
      const def = gameOf().clearState;
      const firstText = txt(card().querySelector('.card-clear'));
      const moreOnByDefault = card().querySelector('.card-more').classList.contains('is-set');

      // ⚠ 「未通关」角标的亚克力材质必须趁现在量 —— 下面一动手就把它改成了
      //   "多结局通关"，那时再取样式量的就是另一档角标，border 恒为 0，
      //   会得出"材质没生效"的假失败（踩过：自检打印 border=false）。
      const bcs = getComputedStyle(card().querySelector('.card-clear'));
      const acrylic = {
        alpha: /rgba\\(/.test(bcs.backgroundColor),
        blur: /blur/.test(bcs.backdropFilter || bcs.webkitBackdropFilter || ''),
        border: parseFloat(bcs.borderTopWidth) > 0
      };

      // 点开菜单
      card().querySelector('.card-more').click();
      await sleep(320);
      const menu = $('#ctxMenu');
      const opts = $$('#ctxMenu .ctx-clear').map(i => txt(i.querySelector('.ctx-clear-text')));
      const cur = txt($('#ctxMenu .ctx-clear.is-on .ctx-clear-text'));

      // 标成「多结局通关」：要落库、要换角标、不能整页重绘
      const gridBefore = $('#contentBody .game-grid');
      $$('#ctxMenu .ctx-clear')[1].click();
      await sleep(700);
      const after = gameOf().clearState;
      const badge = txt(card().querySelector('.card-clear'));
      const sameGrid = $('#contentBody .game-grid') === gridBefore;
      const moreOn = card().querySelector('.card-more').classList.contains('is-set');

      // ⚠⚠ 命中测试：el.click() 只做元素级派发、不做命中测试，
      //   会给出一片虚假的绿 —— 上次「⋮」被 .card-overlay（inset:0、opacity:0
      //   但仍能接事件）盖住，点了直接跳详情页，就是靠这条才抓得出来。
      const hit = (elm, sel) => {
        const r = elm.getBoundingClientRect();
        if (!r.width || !r.height) return { ok: false, why: '尺寸为 0' };
        const top = document.elementFromPoint(
          Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        if (!top) return { ok: false, why: '该点没有元素' };
        const ok = top === elm || (top.closest && top.closest(sel) === elm);
        return { ok, why: ok ? '' : '被「' + (top.className || top.tagName) + '」挡住' };
      };
      const moreHit = hit(card().querySelector('.card-more'), '.card-more');
      const playEl = card().querySelector('.mini-play');
      const playHit = playEl ? hit(playEl, '.mini-play') : { ok: null, why: '没开悬浮启动按钮' };

      // 详情页里的通关状态分段控件
      window.Detail.open(gid);
      await sleep(800);
      const segBtns = () => $$('#detailLayer .pfd-clear-seg .pcs-btn');
      const segCount = segBtns().length;
      const segLabels = segBtns().map(b => txt(b.querySelector('.pcs-text')));
      const segOn = txt($('#detailLayer .pfd-clear-seg .pcs-btn.is-on .pcs-text'));
      // 在详情页里点「通关」→ 要落库，卡片角标也要跟着变
      if (segBtns()[0]) segBtns()[0].click();
      await sleep(700);
      const segAfter = gameOf().clearState;
      const segCur = txt($('#detailLayer .pfd-clear-seg .pcs-btn.is-on .pcs-text'));
      window.Detail.close();
      await sleep(300);
      const syncBadge = txt(card().querySelector('.card-clear'));

      // 收尾：删掉这条自检游戏
      await window.API.remove([gid]);
      await window.App.refresh();
      await sleep(300);

      return { ok: true, totalCards, withMore, withBadge, def, firstText,
               moreOnByDefault, opts, cur, after, badge, sameGrid, moreOn,
               moreHit, playHit, acrylic,
               segCount, segLabels, segOn, segAfter, segCur, syncBadge };
    })()`).catch((e) => ({ ok: false, error: e.message }));

    if (!clres.ok) log('  ✗ ', clres.error);
    else {
      log(`  卡片刻 ${clres.totalCards} 张：带 ⋮ 的 ${clres.withMore}，带通关角标的 ${clres.withBadge}`,
        (clres.withMore === clres.totalCards && clres.withBadge === clres.totalCards) ? '✓' : '✗ 有卡片漏了');
      log('  默认通关状态：', clres.def === 'uncleared'
        ? `✓ ${clres.def}（角标「${clres.firstText}」，⋮ 默认不高亮=${!clres.moreOnByDefault}）`
        : `✗ ${clres.def}`);
      log('  菜单选项：', clres.opts.join(' / '), clres.opts.length === 3 ? '✓' : '✗');
      // ⚠ 这里比的是菜单上显示的中文标签，不是底层状态值 ——
      //   is-on 那一项是从 CLEAR_META 取 label 渲染的
      log('  打开时当前项：', clres.cur === '未通关' ? `✓ ${clres.cur}` : `✗ ${clres.cur}`);
      log('  标成多结局后：', `${clres.after} / 角标「${clres.badge}」/ ⋮ 高亮=${clres.moreOn}`,
        (clres.after === 'multi' && /多结局/.test(clres.badge || '') && clres.moreOn) ? '✓' : '✗');
      log('  改状态不整页重绘：', clres.sameGrid ? '✓' : '✗ 网格被换掉了（滚动位置会弹回顶部）');
      log('  ⋮ 命中测试（不被悬浮层吃掉）：',
        clres.moreHit.ok ? '✓' : '✗ ' + clres.moreHit.why);
      log('  悬浮层「▶ 启动」仍可点：',
        clres.playHit.ok === true ? '✓' : (clres.playHit.ok === null ? '— ' + clres.playHit.why : '✗ ' + clres.playHit.why));
      log('  未通关角标材质（半透明/背景模糊/亮色边框）：',
        (clres.acrylic.alpha && clres.acrylic.blur && clres.acrylic.border)
          ? `✓ 亚克力（${clres.acrylic.alpha}/${clres.acrylic.blur}/${clres.acrylic.border}）`
          : `✗ ${JSON.stringify(clres.acrylic)}`);
      log('  详情页分段控件：', clres.segCount === 3
        ? `✓ ${clres.segLabels.join(' / ')}（当前 ${clres.segOn}）`
        : `✗ 档位数 ${clres.segCount}：${JSON.stringify(clres.segLabels)}`);
      log('  详情页改档 →', `${clres.segAfter} / 高亮 ${clres.segCur} / 卡片 ${clres.syncBadge}`,
        (clres.segAfter === 'cleared' && clres.segCur === '通关' && /通关/.test(clres.syncBadge || ''))
          ? '✓' : '✗ 详情页改档没落到库或没同步到卡片');
    }

    /* 详情页「时长 / 成就」一致性检查：
     * 主人反馈"有的游戏有游玩时长和成就，有的两样都没有"。根因有两层：
     *   ① 库里的时长只统计"从 GameHub 启动"的局，Steam 上的时长从没并进来
     *      → 已在主进程 library.mergeSteamPlaytime 修（单元测试在 tools/logic-test.js）
     *   ② 统计行收尾时把"只有成就占位节点"的一行当成空的删掉了，
     *      于是"没从 GameHub 启动过"的游戏连成就都看不见
     *      → 这一条就是专门守住它的
     * 这里不依赖本机 Steam：把"查平台数据"临时换成假的就可以了。 */
    log('详情页「时长 / 成就」一致性检查 …');

    // 先在主进程把"Steam 时长并进库"这一步跑一遍（离线：喂假数据即可），
    // 再让界面去渲染 —— 这样一整条链路（合并 → 落库 → 详情页显示）都验到了。
    let mergeRes = null;
    {
      // 两款临时游戏：
      //   __st_ach__   → 有 Steam 时长（验"合并进来的时长显示得出来"）
      //   __st_plain__ → 什么数据都没有（验"什么都没有时统计行要收干净"）
      await library.addOne({ id: '__st_ach__', name: 'Steam 时长自检', source: 'steam', steamAppId: '__999999__' });
      await library.addOne({ id: '__st_plain__', name: '空白自检', source: 'steam', steamAppId: '__999998__' });
      mergeRes = library.mergeSteamPlaytime({
        __999999__: { playtimeMs: 7200000, lastPlayed: Date.now() - 3600000 }
      });
      const gg = store.findGame('__st_ach__');
      mergeRes.after = gg ? gg.totalPlayMs : null;
      mergeRes.fromSteam = gg ? !!gg.playtimeFromSteam : null;
      // 没有 Steam 记录的那款必须一动不动
      const gp = store.findGame('__st_plain__');
      mergeRes.plainMs = gp ? gp.totalPlayMs : null;
      await store.flush();
    }
    log('  合并 Steam 时长：', `库里 0 → ${mergeRes.after}（changed=${mergeRes.changed}）`,
      (mergeRes.after === 7200000 && mergeRes.fromSteam) ? '✓' : '✗ 没并进去');
    log('  Steam 没有记录的不受牵连：', `${mergeRes.plainMs}`,
      mergeRes.plainMs === 0 ? '✓ 还是 0' : '✗ 被莫名改了');

    const achres = await win.webContents.executeJavaScript(`(async () => {
      await window.App.refresh();
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const $ = (s) => document.querySelector(s);
      const $$ = (s) => [...document.querySelectorAll(s)];

      // 游戏已经在主进程那边建好了（见上面的合并检查），这里只管渲染
      const gid = '__st_ach__';       // 有 Steam 时长
      const gid2 = '__st_plain__';    // 一点数据都没有
      const realFind = window.PlatformView.findBySteamAppId;

      /** 把"查平台数据"临时换掉：只对这两款自检游戏生效，其它走真实现 */
      const fake = (achByAppId) => {
        window.PlatformView.findBySteamAppId = (appId) => {
          const id = String(appId);
          if (id in achByAppId) {
            return { appId: id, name: '自检', achievements: achByAppId[id], playtimeMs: 0, lastPlayed: 0 };
          }
          return realFind.call(window.PlatformView, appId);
        };
      };

      /** 打开详情页，把渲染结果原样抓出来 */
      const read = async (id) => {
        window.Detail.close();
        await sleep(200);
        window.Detail.open(id);
        await sleep(1100);
        const out = {
          chips: $$('#detailLayer .pfd-stat').map(n => n.textContent.trim()),
          lines: $$('#detailLayer .pfd-statline').length,
          // 行还在、里面却一个胶囊都没有 = 没收拾干净
          emptyLine: $$('#detailLayer .pfd-statline').some(l => !l.querySelector('.pfd-stat')),
          kv: {}
        };
        for (const cell of $$('#detailLayer .pfd-kv-cell')) {
          out.kv[cell.querySelector('.pfd-kv-k').textContent.trim()] =
            cell.querySelector('.pfd-kv-v').textContent.trim();
        }
        window.Detail.close();
        await sleep(150);
        return out;
      };

      // 两款都塞上成就：
      //   ① __st_ach__   有 Steam 时长 + 有成就 → 正常该有的样子
      //   ② __st_plain__ 没时长、没启动过、只有成就
      //      —— 这正是以前统计行被连锅端掉的场景（成就跟着整行一起消失）
      fake({ __999999__: { unlocked: 7, total: 20 }, __999998__: { unlocked: 3, total: 9 } });
      const withTime = await read(gid);
      const achOnly = await read(gid2);

      // ③ 完全没有成就数据 → 统计行必须整行收掉，不能留一条空白
      fake({});
      const nothing = await read(gid2);

      window.PlatformView.findBySteamAppId = realFind;
      await window.API.remove([gid, gid2]);
      await window.App.refresh();
      await sleep(300);

      return { withTime, achOnly, nothing };
    })()`).catch((e) => ({ error: e.message }));

    if (achres.error) {
      log('  ✗ ', achres.error);
    } else {
      const wt = achres.withTime || {};
      const ao = achres.achOnly || {};
      const no = achres.nothing || {};

      const hasAch1 = (wt.chips || []).some((c) => c.includes('成就'));
      const hasTime1 = (wt.chips || []).some((c) => c.includes('游玩时间'));
      log('  有时长 + 有成就：', JSON.stringify(wt.chips || []),
        (hasAch1 && hasTime1 && !wt.emptyLine) ? '✓ 两块都在' : '✗ 少了一块');
      log('  时长取自 Steam 记录：', `${wt.kv && wt.kv['游玩时长']} | 最近 ${wt.kv && wt.kv['最近游玩']}`,
        (wt.kv && wt.kv['游玩时长'] && wt.kv['游玩时长'] !== '未玩过') ? '✓' : '✗ 还是显示未玩过');

      // ⚠ 这一条就是主人反馈的那个 bug 的正身
      log('  没时长、只有成就：', JSON.stringify(ao.chips || []),
        ((ao.chips || []).some((c) => c.includes('成就')) && !ao.emptyLine)
          ? '✓ 成就没被连行删掉'
          : '✗ 成就那一行整个不见了（就是"有的有有的没有"）');

      log('  什么数据都没有时：', JSON.stringify(no.chips || []), `（统计行 ${no.lines} 条）`,
        (no.lines === 0 || !no.emptyLine) ? '✓ 没有留下空行' : '✗ 留了一条空的统计行');
    }

    // 封面判定规则（纯函数，直接查一遍）：
    // 「搜索不到就算了」的前提是别把已经有封面的游戏也捞进来瞎折腾。
    {
      // ⚠ 每条都要带 name：没有名字的条目本来就没法联网搜，规则里直接判 false
      const cases = [
        [{ name: 'A', coverPath: '', coverKind: 'none' }, true],              // 没图 → 该搜
        [{ name: 'B', coverPath: 'covers/a.jpg', coverKind: 'custom' }, false], // 自己上传的 → 绝不动
        [{ name: 'C', coverPath: 'covers/a.jpg', coverKind: 'icon' }, false],   // 只有图标 → 默认不动
        [{ name: 'D', coverPath: 'covers/a.jpg', coverKind: 'steam' }, false]   // 已有官方封面 → 不用搜
      ];
      const bad = cases.filter(([g, want]) => needsCover(g, false) !== want);
      // 开了「升级图标」后，只有图标的那条应该变成要搜
      const iconUpgraded = needsCover({ name: 'C', coverPath: 'covers/a.jpg', coverKind: 'icon' }, true);
      log('封面判定规则：', bad.length ? '✗ ' + JSON.stringify(bad[0][0]) : `✓ 4/4 通过（连同升级=${iconUpgraded}）`);
    }

    // 跑一次文件夹扫描（用自身目录当靶子，验证递归扫描逻辑不崩）
    log('测试扫描逻辑（对项目自身目录做一次嗅探）…');
    const t0 = Date.now();
    const list = await scanner.scanFolder(path.join(__dirname, 'src'), { mode: 'smart', maxDepth: 2 });
    log(`扫描返回 ${list.length} 条，用时 ${Date.now() - t0}ms`);

    /* ---------------- Epic：清单解析 + 登录态 ---------------- */
    log('Epic 本地安装清单解析 …');
    {
      const from = platforms._internals.epicGameFromManifest;
      const mainGame = from({
        AppName: 'SelfTestEpicGame', DisplayName: '自检用 Epic 游戏',
        InstallLocation: 'D:\\ST', LaunchExecutable: 'st.exe',
        AppCategories: ['games', 'applications'], bIsApplication: true
      });
      log('  主游戏解析：', mainGame
        ? `✓ ${mainGame.name} → ${mainGame.launchPath}`
        : '✗ 主游戏被误杀了（用户会"装了却看不见"）');

      // DLC / 引擎必须剔掉，否则平台库里全是噪声
      const dlc = from({ AppName: 'D', DisplayName: 'DLC', AppCategories: ['addons', 'games'] });
      const engine = from({ AppName: 'UE', DisplayName: 'Unreal Engine', AppCategories: ['applications'] });
      log('  噪声过滤：', (!dlc && !engine) ? '✓ DLC 与 Unreal 引擎都已剔除' : `✗ DLC=${!!dlc} 引擎=${!!engine}`);

      // 本机真实读一把（没装 Epic 游戏时就是 0 条，那也是正确结果）
      const real = await platforms._internals.epicInstalled();
      log('  本机实际读到：', `${real.length} 款已安装 Epic 游戏`);
    }

    // Epic 登录凭证的落盘 / 读取 / 清除（用临时目录，不碰真实凭证）
    log('Epic 登录凭证读写 …');
    {
      // ⚠ 就地 require：模块顶部那个 os 是在另一个块作用域里声明的，这里取不到
      const tmp = path.join(require('os').tmpdir(), 'gamehub-epic-selftest');
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 无所谓 */ }
      fs.mkdirSync(tmp, { recursive: true });

      const a = createEpicAuth({ dataDir: tmp });
      log('  初始状态：', a.status().loggedIn === false ? '✓ 未登录' : '✗ 竟然显示已登录');

      // 没有登录过就拉清单，必须明确失败而不是抛异常
      const bad = await a.fetchLibrary();
      log('  未登录拉清单：', bad.ok === false ? '✓ 明确拒绝' : '✗ 未登录竟然成功了');

      a.logout();
      const b = createEpicAuth({ dataDir: tmp });
      log('  退出后重读：', b.status().loggedIn === false ? '✓ 会话已清除' : '✗ 还能读到登录态');
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
    }

    /* ---------------- MOD 管理 ---------------- */
    /* 这一块只跑**离线**的部分（不发任何网络请求）：
     *   ① 本地 MOD 目录的发现 / 命名 / 体积
     *   ② 禁用 = 加后缀、启用 = 去后缀，且能往返
     *   ③ 无标签的本地 MOD 落在「本地 MOD」这个兜底桶里
     *   ④ 删除真的走回收站（这一条只有 Electron 里跑得起来 ——
     *      纯 Node 的集成测试只能验到"没有 shell 时明确报错"那一支）
     * 创意工坊那条链路（HTTP）交给 tools/mods-test.js 的假服务器去验，
     * 自检里不碰网，免得没网的时候自检整个变红、误导主人。 */
    log('MOD 管理检查 …');
    {
      const tmp = path.join(require('os').tmpdir(), 'gamehub-mod-selftest');
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 无所谓 */ }

      const gameDir = path.join(tmp, 'game');
      const modsDir = path.join(gameDir, 'mods');
      fs.mkdirSync(path.join(modsDir, 'AlphaMod'), { recursive: true });
      fs.mkdirSync(path.join(modsDir, 'BetaMod'), { recursive: true });
      // BetaMod 里放一个文件 —— 目录型的 MOD 也要能算出体积（踩过：一直是 0）
      fs.writeFileSync(path.join(modsDir, 'BetaMod', 'b.pak'), Buffer.alloc(2048));
      // 系统垃圾必须被忽略，不然用户看到一堆 Thumbs.db 会以为 GameHub 出错了
      fs.writeFileSync(path.join(modsDir, 'desktop.ini'), 'x');
      fs.writeFileSync(path.join(modsDir, '.DS_Store'), 'x');

      const m = createMods({ dataDir: path.join(tmp, 'data'), steamLibraries: [] });
      const g = { id: '__st_mod__', name: '自检 MOD 游戏', installDir: gameDir, steamAppId: '' };

      const L1 = await m.list(g, { online: false });
      const titles = L1.mods.map((x) => x.title).sort();
      log('  本地 MOD 发现：', JSON.stringify(titles),
        (L1.counts.total === 2 && titles.join(',') === 'AlphaMod,BetaMod')
          ? '✓ 找到 2 个、垃圾文件已剔除'
          : `✗ 找到 ${L1.counts.total} 个：${titles.join(',')}`);

      const beta = L1.mods.find((x) => x.title === 'BetaMod');
      log('  目录型 MOD 的体积：', `${beta ? beta.sizeBytes : '-'} 字节`,
        (beta && beta.sizeBytes >= 2048) ? '✓ 递归算出来了' : '✗ 是 0（用户会以为 MOD 是空的）');
      log('  兜底分组：', L1.groups.map((x) => `${x.tag}(${x.mods.length})`).join(' / '),
        L1.groups.some((x) => x.tag === '本地 MOD') ? '✓ 无标签的本地 MOD 归到「本地 MOD」' : '✗ 没有兜底桶');

      // 禁用 → 磁盘上要真改名，再 list 要认得出
      const off = await m.setEnabled(beta, false);
      const offOnDisk = fs.existsSync(beta.path + '.gamehub-disabled');
      const L2 = await m.list(g, { online: false });
      const beta2 = L2.mods.find((x) => x.title === 'BetaMod');
      log('  禁用：', `${off.ok} / 磁盘改名=${offOnDisk} / 列表里 enabled=${beta2 && beta2.enabled}`,
        (off.ok && offOnDisk && beta2 && beta2.enabled === false) ? '✓' : '✗');
      log('  禁用后仍显示原名：', beta2 ? beta2.title : '-',
        (beta2 && beta2.title === 'BetaMod') ? '✓（后缀不该露给用户看）' : '✗ 名字带了后缀');
      log('  计数：', JSON.stringify(L2.counts),
        (L2.counts.enabled === 1 && L2.counts.disabled === 1) ? '✓ 启 1 / 禁 1' : '✗ 对不上');

      // 启用 → 后缀去掉，回到原样
      const on = await m.setEnabled(beta2, true);
      const L3 = await m.list(g, { online: false });
      const beta3 = L3.mods.find((x) => x.title === 'BetaMod');
      log('  启用：', `${on.ok} / 后缀已去除=${!fs.existsSync(beta.path + '.gamehub-disabled')} / enabled=${beta3 && beta3.enabled}`,
        (on.ok && beta3 && beta3.enabled === true) ? '✓ 往返可逆' : '✗');

      // 删除：必须真的进回收站，且路径不在了
      const delPath = path.join(modsDir, 'AlphaMod');
      const del = await m.remove({ path: delPath });
      log('  删除（进回收站）：', `ok=${del.ok} trash=${!!del.trashed}`
        + ` 原路径还在=${fs.existsSync(delPath)}`
        + (del.callbackAborted ? ' [系统回调误报中断，已按磁盘实况判成功]' : ''),
        (del.ok && !fs.existsSync(delPath)) ? '✓ 已挪走（可在回收站找回）' : `✗ ${JSON.stringify(del)}`);

      // 安全闸：关键目录必须被拒（这是最后一道闸，不能靠上层自觉）
      const guard = await m.remove({ path: 'C:\\' });
      log('  安全闸（盘符根）：', guard.ok ? '✗ 竟然允许删 C:\\' : `✓ 已拒绝：${guard.error}`);

      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
    }

    // 验证隐藏空间密码逻辑
    const r1 = await library.setupHidden('test1234', '自检');
    const r2 = library.unlockHidden('wrong-password');
    const r3 = library.unlockHidden('test1234');
    log('隐藏空间：设置 =', r1.ok, '| 错误密码被拒 =', !r2.ok, '| 正确密码通过 =', r3.ok);
    await library.disableHidden('test1234');

    // 恢复出厂：自检不污染用户数据
    library.clear();
    await store.flush();
    log('自检完成 ✓');
    log(`—— 本轮：${nOk} 项通过 / ${nBad} 项失败 ——`);
  } catch (e) {
    console.error('[自检] 失败：', e);
    log('自检中途失败：' + (e && e.message ? e.message : e));
    log('  堆栈首行：' + String((e && e.stack) || '').split('\n')[1]);
    /* ⚠ 有一种失败**不是产品问题**，别每次都从头查一遍：
     *   沙箱会给 Node 注入一个 fs 代理（堆栈里能看到 node-brokered-fs-shim.cjs），
     *   它偶尔对写盘抛 EPERM，卡在哪一步不固定（实测常卡在最后"隐藏空间落盘"）。
     *   同一份代码原样重跑就能过 —— 我连跑四次是 2 过 2 挂。
     *   判据：堆栈里出现 node-brokered-fs-shim / 错误是 EPERM 且路径在 %TEMP% 下。
     *   主人在真机上跑不会碰见这个（真机没有这层代理）。
     *   上面的检查项都照常打了，所以即使撞上，结论依然读得出来。 */
    if (/brokered-fs-shim|EPERM/.test(String((e && e.stack) || '') + (e && e.message))) {
      log('  ↑ 堆栈里有 fs 代理（沙箱注入），这一条大概率是环境噪声，重跑一次看是否复现。');
    }
  } finally {
    flush();
    setTimeout(() => { app.exit(0); }, 300);
  }
}

/* ==================================================================
 *  十四、探针模式：在页面里跑一段脚本并把结果打出来
 * ================================================================== */
async function runProbe() {
  try {
    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    /* 探针通常需要真实数据，所以空库时先填充一次。
     * ⚠ 只在真的空库时才扫：探针数据目录是从真实库复制出来的，本来就是满的，
     *   再扫一遍纯属白等。更要紧的是 sniffAll 会拉起 reg.exe 读注册表，
     *   在受限环境里这个进程可能被安全策略拦下，连探针一起带走（实测过）。
     *   （那 20 秒的等待也是这么省下来的。） */
    if (store.getGames().length === 0) {
      const list = await scanner.sniffAll({
        include: { registry: true, steam: true, epic: true, folder: false },
        onProgress: () => {}, isCancelled: () => false
      });
      library.addMany(list);
    }

    /* ⚠⚠ 只给**没有 Steam 记录**的游戏塞测试时长。
     *   带 steamAppId 的那些，时长会在平台同步时从 Steam 真实数据并进来
     *   （library.mergeSteamPlaytime）。这里要是无脑改前几款，就会把刚并进来的
     *   真实时长又按 (i+1)*2 小时覆盖掉 —— 于是探针看到的永远是"库里比 Steam 小"，
     *   白白误导一整轮排查（真实踩过：Hades II 库里 2h / Steam 19h，查了半天
     *   以为是合并没生效，其实是这里在探针开跑前把它改回去了）。
     */
    const seedable = store.getGames().filter((x) => !x.steamAppId).slice(0, 4);
    seedable.forEach((x, i) => {
      x.lastPlayedAt = Date.now() - i * 60000;
      x.totalPlayMs = (i + 1) * 7200000;
    });
    await store.flush();
    await win.webContents.executeJavaScript('window.App.refresh()');
    await new Promise((r) => setTimeout(r, 2000));
    await win.webContents.executeJavaScript('window.App.goto("home")');
    await new Promise((r) => setTimeout(r, 1200));

    const result = await win.webContents.executeJavaScript(PROBE);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

    // 打包成 exe 后是 GUI 程序，stdout 不会挂到控制台上（探针结果是看不到的）。
    // 所以支持 PROBE_OUT=<文件> 把结果落盘，这样连成品包也能自动化验证。
    if (process.env.PROBE_OUT) {
      await require('fs/promises').writeFile(process.env.PROBE_OUT, text, 'utf8');
    }
    console.log('[探针结果]', text);
  } catch (e) {
    if (process.env.PROBE_OUT) {
      await require('fs/promises')
        .writeFile(process.env.PROBE_OUT, '探针执行失败：' + e.message, 'utf8')
        .catch(() => {});
    }
    console.error('[探针] 执行失败：', e.message);
  } finally {
    setTimeout(() => app.exit(0), 300);
  }
}

/** 简单防抖 */
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

/* ==================================================================
 *  十三、截图模式：填充真实数据 → 逐个界面截图
 * ================================================================== */
/**
 * 【仅截图模式使用】造一批分布在最近 90 天的游玩流水，
 * 好让"游玩统计"页面在演示截图里不是空的。
 * 真实使用中这些数据全部来自用户实际启动游戏，不存在造假。
 */
function seedDemoSessions(games) {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const list = [];
  // 用固定的伪随机，保证每次截图的数据一致、方便对比
  let seed = 20261003;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // 有统计意义的游戏多一些，靠后的游戏少一些
  for (let gi = 0; gi < Math.min(games.length, 12); gi++) {
    const g = games[gi];
    const weight = 1 - gi / Math.min(games.length, 12) * 0.75;   // 0.25 ~ 1
    for (let d = 0; d < 90; d++) {
      if (rnd() > weight * 0.42) continue;                       // 不是每天都玩
      const sessionsToday = rnd() < 0.25 ? 2 : 1;                 // 偶尔一天玩两次
      for (let k = 0; k < sessionsToday; k++) {
        const at = now - d * day + Math.floor(rnd() * 8 * 3600 * 1000);  // 当天随机时刻
        const ms = Math.round((0.4 + rnd() * 2.6) * 3600 * 1000);        // 0.4 ~ 3 小时
        list.push({ gameId: g.id, at, ms });
      }
    }
  }
  const n = store.addSessions(list);
  console.log(`[截图] 已生成 ${n} 条演示游玩流水，供统计页展示`);
}

async function runScreenshot() {
  const fsp = require('fs/promises');
  const log = (...a) => console.log('[截图]', ...a);
  try {
    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });

    // ① 用真实扫描结果填充游戏库
    log('正在嗅探本机游戏 …');
    const list = await scanner.sniffAll({
      include: { registry: true, steam: true, epic: true, folder: false },
      onProgress: () => {},
      isCancelled: () => false
    });
    log(`嗅探到 ${list.length} 款候选`);

    // 清掉上一次截图留下的数据，保证每次都是干净的
    library.clear();
    const r = library.addMany(list);
    log(`已导入 ${r.added.length} 款`);

    // ② 补封面：先试 Steam 官方竖版图，失败就退回 exe 图标
    const games = store.getGames();
    let done = 0;
    for (const g of games) {
      done++;
      let res = null;
      if (g.steamAppId) res = await cover.fetchSteam(g);
      if (!res || !res.ok) res = await cover.extractIcon(g);
      if (res && res.ok) store.updateGameCover(g.id, res);
      if (done % 5 === 0) log(`封面 ${done}/${games.length}`);
    }
    /* ⚠ 只给没有 Steam 记录的游戏造时长：带 steamAppId 的下面会用 Steam 真实数据
     *   （mergeSteamPlaytime）填上，这里再造一份只会让截图里的数字和 Steam 对不上
     *   —— 而"时长和 Steam 一致"正是这一轮要修的问题，截图必须能证明它。 */
    const withTime = games.filter((g) => !g.steamAppId).slice(0, 4);
    withTime.forEach((g, i) => {
      g.playCount = i + 2;
      g.totalPlayMs = (i + 1) * 3600 * 1000 * (2 + i);
      g.lastPlayedAt = Date.now() - i * 3600 * 1000;
    });

    // 把 Steam 的真实时长 / 最近游玩并进来，"继续游戏"里才是真数据。
    // 只读一个 localconfig.vdf，毫秒级；没装 Steam 就静默跳过。
    try {
      const sp = await platforms.steamPlaytimes();
      if (sp && sp.ok) {
        const m = library.mergeSteamPlaytime(sp.apps);
        log(`已从 Steam 对齐 ${m.changed} 款游戏的时长 / 最近游玩`);
      }
    } catch { /* 对不上就算了，不影响截图 */ }
    games[0] && (games[0].favorite = true);
    games[2] && (games[2].favorite = true);
    games[1] && (library.recordLaunch(games[1].id));

    // 统计页需要"一局一局"的流水才能画出周/月/季/年，
    // 截图模式的数据目录是临时的，所以这里造一批跨 90 天的演示数据。
    seedDemoSessions(games);
    await store.flush();

    // ③ 让前端重新加载数据
    const refreshRenderer = () => win.webContents.executeJavaScript('window.App.refresh()');
    await refreshRenderer();
    await new Promise((res) => setTimeout(res, 2500));

    // ④ 逐个界面截图
    // 辅助脚本：按文字找元素并点击（比按索引稳，界面调整了也不会点错）
    /**
     * 摆拍用：模拟"选了一个游戏总目录 F:\r24，程序穿透进去逐个识别"的结果。
     * 对应修掉的那个 bug —— 以前这里只会出来一条名字叫 "r24" 的记录。
     */
    const containerScanDemo = () => {
      const rows = [
        ["【PC硬盘】【官中】拔作岛", '拔作岛', 26.4],
        ['Mad Island', 'Mad Island', 18.9],
        ['Operation Lovecraft Fallen Doll Plan', 'Operation Lovecraft Fallen Doll Plan', 12.7],
        ["(public)Syahara's bad day_v0.32b", "Syahara's bad day", 8.3],
        ['hs2', 'hs2', 7.1],
        ['NinNinDays2', 'NinNinDays2', 5.2],
        ['Akari and the Abyss', 'Akari and the Abyss', 4.6],
        ['1room_v1.2.2', '1room', 3.8],
        ['【官中】拔作岛 番外', '拔作岛 番外', 2.4],
        ['censor demo 2.0.6', 'censor demo', 1.9]
      ];
      const day = new Date('2026-06-20T00:00:00').getTime();
      return rows.map(([folder, name, gb], i) => ({
        id: 'demo-r24-' + i,
        name,
        altNames: [],
        publisher: '',
        version: '',
        installDir: 'F:\\r24\\' + folder,
        exePath: 'F:\\r24\\' + folder + '\\' + name + '.exe',
        sizeBytes: Math.round(gb * 1024 * 1024 * 1024),
        installDate: day + i * 86400000,
        steamAppId: '',
        source: 'folder',
        sourceLabel: '文件夹',
        confidence: 10,
        reasons: ['与目录同名', '含引擎数据目录'],
        categories: [],
        alreadyInLibrary: false
      }));
    };

    /* （这里是 modsDemoData()，一份给截图 38/40 用的摆拍数据 —— 已删除。）
     *
     * 当初造它的理由：连不上 api.steampowered.com，工坊标签取不到，
     * 125 个真实条目会全落进「创意工坊 · 无标签」一个桶里，拍出来的图
     * 证明不了"按标签做二级分类"。
     *
     * 现在这个前提不成立了：根因是 Node 的 TLS 不补证书链
     * （UNABLE_TO_VERIFY_LEAF_SIGNATURE），改走 Electron net.fetch 之后
     * 工坊接口通了，真标签能拿到（实测 125/125）。演示数据反而成了
     * "错误信息的来源"——截图看着像真的，其实是编的。所以删掉，
     * 38 / 40 改成真实数据。别再往回加。 */

    // 找不到就【抛错】而不是静默 warn：
    // 之前是 warn，结果截图会悄悄拍成"没点中"的错误状态，却看不出来（R18 那次的教训）。
    const clickByText = (text, sel = '.modal-body .btn, .modal-body .chip') => `
      (() => {
        const b = [...document.querySelectorAll(${JSON.stringify(sel)})]
          .find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
        if (!b) throw new Error('找不到可点击元素：' + ${JSON.stringify(text)} + ' （选择器 ${sel}）');
        b.click();
        return true;
      })()`;

    /* 挑一个"真有创意工坊数据"的游戏来拍 MOD 区。
     *
     * 这几组 appId 是按本机实测排的（CS2 / Palworld / ONI / RimWorld 都有工坊条目）：
     *   · 730    CS2        21 条，4 个真实标签分组 + 无标签兜底桶
     *   · 1623730 Palworld   7 条，含「创意工坊 · 无标签」和「本地 MOD」两个兜底桶
     *   · 457140  ONI       16 条，Base Game / New Features / tweaks / ui
     *   · 294100  RimWorld 125 条，本机量最大（37 那张用的就是它）
     * 都没有就退回任意 Steam 游戏 —— 但绝不允许静默拍出一张空图，
     * 断言会让它直接报错（R18 那次的教训）。
     *
     * ⚠ 必须整段当一个**字符串**注入页面执行：这是在 Node 侧拼脚本，
     *   写成普通函数是没法传进渲染进程的。 */
    const PICK_MOD_GAME = `(() => {
      const games = window.State.games || [];
      for (const id of ['730', '1623730', '457140', '294100']) {
        const g = games.find(x => String(x.steamAppId) === id);
        if (g) return g;
      }
      return games.find(x => x.steamAppId) || games[0];
    })()`;

    /* 量"铺开"的几何（37 / 38 共用）。
     *
     * ⚠ 三个坑，都在这里绕开了：
     *   1. 卡片带入场动画（transform: translateY），动画没停时
     *      getBoundingClientRect().top 是偏的 —— 数出来的"每行几张"是假的。
     *      所以调用方必须先等够时间再量（下面等 1.4s）。
     *   2. "几列"这个数**离开视口宽度就没法解读**：同是 6 列，
     *      在 1568 宽的窗口是"铺满"，在 800 宽的窗口就是"溢出被裁"。
     *      所以视口宽必须一起报。
     *   3. 光看 grid-template-columns 不够 —— 那是声明值。要是 rail 自己比
     *      面板还宽，声明照样是 6 列，但你只看得见 4 张（被父级裁掉了）。
     *      所以还要比 rail 和面板的右边界。 */
    const MOD_GEO = `(() => {
      const rail = document.querySelector('.pfd-mod-rail');
      if (!rail) return null;
      const tracks = getComputedStyle(rail).gridTemplateColumns.split(' ').filter(s => s && s !== '0px');
      const rows = (r) => {
        if (!r) return [];
        const byTop = new Map();
        for (const c of r.querySelectorAll('.pfd-mod-card')) {
          const t = Math.round(c.getBoundingClientRect().top);
          byTop.set(t, (byTop.get(t) || 0) + 1);
        }
        return [...byTop.values()];
      };
      // 逐组报"每行几张"：只看第一组会骗人（CS2 的第一组只有 1 个条目）
      const perGroup = [...document.querySelectorAll('.pfd-mod-group')].map(gr => ({
        组: ((gr.querySelector('.pfd-mod-gname') || {}).textContent || '').trim(),
        表头: ((gr.querySelector('.pfd-mod-gcount') || {}).textContent || '').trim(),
        每行: rows(gr.querySelector('.pfd-mod-rail'))
      }));
      const panel = document.querySelector('#detailLayer .pfd-body') || document.querySelector('#detailLayer');
      const rr = rail.getBoundingClientRect();
      const pr = panel ? panel.getBoundingClientRect() : null;
      return {
        视口宽: window.innerWidth,
        列数: tracks.length,
        轨道宽: [...new Set(tracks.map(t => Math.round(parseFloat(t))))],
        逐组每行: perGroup,
        rail宽: Math.round(rr.width),
        横向滚动: rail.scrollWidth > rail.clientWidth + 1,
        越出面板: pr ? Math.round(rr.right - pr.right) : null
      };
    })()`;

    const shots = [
      { name: '01-首页', script: 'window.Modals.closeModal(); window.App.goto("home")' },
      // 卡片右下角的成就角标是异步补的（要等 Steam 快照），必须等出来再拍
      {
        name: '02-全部游戏',
        script: `(async () => {
          window.App.goto("all");
          for (let i = 0; i < 80 && !document.querySelector('.game-card .card-ach:not([hidden])'); i++) {
            await new Promise(r => setTimeout(r, 200));
          }
          await new Promise(r => setTimeout(r, 400));
          return document.querySelectorAll('.game-card .card-ach:not([hidden])').length;
        })()`
      },
      { name: '03-列表视图', script: 'window.State.viewMode="list"; window.App.renderContent()' },
      { name: '04-分类', script: 'window.State.viewMode="grid"; window.App.gotoCategory(window.State.categories[0] && window.State.categories[0].name)' },
      { name: '05-游戏详情', script: 'window.State.view="all"; window.App.renderContent(); window.Detail.open(window.State.games[0].id)' },
      { name: '06-扫描结果', script: 'window.Detail.close(); window.App.goto("all"); window.Modals.scanResults(window.State.games.slice(0,6).map(g=>({...g,alreadyInLibrary:false,confidence:8})))' },
      { name: '07-隐藏空间上锁', script: 'window.Modals.closeModal(); window.App.goto("hidden")' },
      { name: '08-设置', script: 'window.Modals.settings()' },
      // 新增：更多选项菜单（先滚回顶部，免得菜单被推出可视区）
      {
        name: '09-更多选项',
        script: 'window.Modals.closeModal(); window.App.goto("all"); document.querySelector("#contentBody").scrollTop=0; document.querySelector("#btnMore").click()'
      },
      // 新增：添加游戏的二级页面 —— 第一级（选方式）
      { name: '10-添加游戏方式', script: 'document.querySelector("#btnMore").click(); window.Modals.addGame()' },
      // 新增：第二级（自动添加：选文件夹）
      {
        name: '11-自动添加选目录',
        script: `window.Modals.addGameAuto(); (async () => { await new Promise(r => setTimeout(r, 300)); ${clickByText('常见位置')}; })()`
      },
      // 新增：第二级（手动添加表单）
      { name: '12-手动添加表单', script: `window.Modals.addGame(); ${clickByText('手动添加', '.chooser-card')}` },
      // 新增：分类建议列表（不点 R18，用来肉眼确认 R18 确实出现在可选列表里）
      {
        name: '13-分类建议列表',
        script: `window.Modals.closeModal(); window.App.goto("all");
          window.Modals.editGame(window.State.games[0].id)`
      },
      // 新增：勾上 R18 之后的样子（chip 变红 + 隐藏空间提示）
      {
        name: '14-R18已选中',
        script: `(async () => { await new Promise(r => setTimeout(r, 400)); ${clickByText('+R18', '.gr-tags .chip')}; })()`
      },
      // 新增：游玩统计（放最后，方便单独替换周期再补拍）
      { name: '15-游玩统计', script: 'window.Modals.closeModal(); window.Detail.close(); window.App.goto("stats")' },
      // 新增：穿透扫描的结果（"一个总目录里的一堆游戏"被逐个列出来）
      // 用固定数据摆拍，纯粹是为了展示"不会再出现父文件夹被当成游戏"这件事
      {
        name: '16-穿透扫描结果',
        script: `window.Modals.closeModal(); window.App.goto("all");
          window.Modals.scanResults(${JSON.stringify(containerScanDemo())})`
      },
      // 新增：逐款自定义 —— 每款游戏一个页签，各占一页表单，可以单独改
      {
        name: '16-逐款自定义',
        script: `(async () => {
          const btn = [...document.querySelectorAll('.modal-foot .btn')]
            .find(b => b.textContent.includes('逐款自定义'));
          if (!btn) throw new Error('找不到「下一步：逐款自定义」按钮');
          btn.click();
          await new Promise(r => setTimeout(r, 400));
          const tabs = [...document.querySelectorAll('.cz-tab')];
          if (tabs.length < 3) throw new Error('逐款自定义的页签没出来，只有 ' + tabs.length + ' 个');
          // 切到第 3 款，证明页签是真能翻的
          tabs[2].click();
          await new Promise(r => setTimeout(r, 350));
          return tabs.length;
        })()`
      },
      // 新增：游戏平台总览（真实读本机 Steam）
      // 检测 + 预热同步都要等，所以轮询到卡片出来为止，别拍成半空状态
      {
        name: '17-游戏平台总览',
        script: `(async () => {
          window.Modals.closeModal();
          window.App.goto("platform");
          for (let i = 0; i < 60 && !document.querySelector('.pf-card'); i++) {
            await new Promise(r => setTimeout(r, 200));
          }
          await new Promise(r => setTimeout(r, 1200));
          return document.querySelectorAll('.pf-card').length;
        })()`
      },
      // 新增：平台游戏库（等同步完成后再拍，未安装的游戏应该是黑白的）
      {
        name: '18-平台游戏库',
        script: `(async () => {
          for (let i = 0; i < 60 && !document.querySelector('.pf-card'); i++) {
            await new Promise(r => setTimeout(r, 200));
          }
          const steam = [...document.querySelectorAll('.pf-card')]
            .find(c => c.textContent.includes('Steam'));
          if (!steam) throw new Error('总览页没找到 Steam 卡片');
          steam.click();
          for (let i = 0; i < 80 && !document.querySelector('.pf-game'); i++) {
            await new Promise(r => setTimeout(r, 250));
          }
          document.querySelector('#contentBody').scrollTop = 0;
          return document.querySelectorAll('.pf-game').length;
        })()`
      },
      // 新增：平台游戏详情（标题旁显示时长与成就，区块可收起）
      {
        name: '19-平台游戏详情',
        script: `(async () => {
          // 挑一款"未安装 + 有时长 + 有成就"的，
          // 这样一张图里能同时看到：黑白封面、未安装角标、游玩时间、成就 12/200、下载按钮
          const games = [...document.querySelectorAll('.pf-game')];
          const pick = games.find(g => g.classList.contains('not-installed') && g.querySelector('.pf-ach'))
            || games.find(g => g.classList.contains('not-installed'))
            || games[0];
          if (!pick) throw new Error('平台库里没有游戏卡片');
          pick.click();
          await new Promise(r => setTimeout(r, 800));
          if (!document.querySelector('#platformDetailLayer .pfd-title')) {
            throw new Error('平台详情浮层没打开');
          }
          return document.querySelector('#platformDetailLayer .pfd-title').textContent;
        })()`
      },
      // 新增：卡片名字放不下时，悬停会横向滚出"游戏名 + 成就"。
      // 这个画面只能靠真实鼠标悬停触发，所以脚本返回坐标、由 after 钩子发 mouseMove 进去。
      {
        name: '20-卡片名字滚动',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          // 上一张拍的是平台详情浮层，它盖在 contentBody 上面，得先关掉
          const pf = document.querySelector('#platformDetailLayer');
          if (pf) { pf.hidden = true; pf.innerHTML = ''; }
          window.State.view = 'all';
          window.App.renderContent();
          for (let i = 0; i < 80 && !document.querySelector('.game-card .card-ach:not([hidden])'); i++) {
            await new Promise(r => setTimeout(r, 200));
          }
          await new Promise(r => setTimeout(r, 400));
          // 挑一张"名字长到要滚、而且有成就"的卡片；滚动距离最大的那张最直观
          const cands = [...document.querySelectorAll('.game-card[data-id]')]
            .filter(c => c.querySelector('.card-name.is-scroll') && c.querySelector('.card-ach:not([hidden])'))
            .sort((a, b) => parseFloat(b.querySelector('.card-name').style.getPropertyValue('--mq'))
                          - parseFloat(a.querySelector('.card-name').style.getPropertyValue('--mq')));
          const card = cands[0];
          if (!card) throw new Error('没找到需要滚动的卡片');
          const r = card.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
        after: async (w, point) => {
          if (!point || !point.x) return;
          w.webContents.focus();
          w.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
          // 等滚动动画真的走出去（关键帧 14% 时就到位了，最多 4.8s 一圈）
          await new Promise((r) => setTimeout(r, 1500));
        }
      },
      // 新增：设置面板里的「封面与联网搜索」分区（滚到那个位置再拍）
      {
        name: '21-设置-封面联网',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          window.App.goto('all');
          window.Modals.settings();
          await new Promise(r => setTimeout(r, 500));
          const body = document.querySelector('#modalLayer .modal-body');
          if (!body) throw new Error('设置面板没打开');
          const title = [...body.querySelectorAll('.detail-section-title')]
            .find(t => t.textContent.includes('封面与联网搜索'));
          if (!title) throw new Error('设置面板里没有「封面与联网搜索」分区');
          body.scrollTop = title.offsetTop - 6;
          await new Promise(r => setTimeout(r, 350));
          return document.querySelectorAll('#modalLayer .switch-row').length;
        })()`
      },
      // 新增：截图确认这些新开关不是摆设（滚 View 到封面那一段）
      {
        name: '22-设置-封面开关',
        script: `(async () => {
          const body = document.querySelector('#modalLayer .modal-body');
          if (!body) throw new Error('设置面板被关掉了');
          const rows = [...body.querySelectorAll('.switch-row')];
          const pick = rows.find(r => r.textContent.includes('联网自动补封面'))
                    || rows.find(r => r.textContent.includes('把程序图标也升级'));
          if (!pick) throw new Error('找不到封面联网相关的开关');
          body.scrollTop = pick.offsetTop - 80;
          await new Promise(r => setTimeout(r, 350));
          return rows.length;
        })()`
      },
      // 新增：详情页「封面」区 —— 重点看「🌐 联网搜索封面」这个按钮。
      // 特意挑一款"自己导进来、没有 AppID"的游戏（文件夹来源最典型）：
      // 这个按钮存在的意义就是它以前只会得到一句「这款游戏没有 Steam ID」。
      {
        name: '23-详情页封面联网',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          window.App.goto('all');
          await new Promise(r => setTimeout(r, 400));
          const games = window.State.games;
          const pick = games.find(g => !g.steamAppId) || games[0];
          if (!pick) throw new Error('游戏库是空的');
          window.Detail.open(pick.id);
          await new Promise(r => setTimeout(r, 700));
          const panel = document.querySelector('#detailLayer .detail-panel');
          const sec = [...document.querySelectorAll('#detailLayer .pfd-sec')]
            .find(s => { const t = s.querySelector('.pfd-sec-title'); return t && t.textContent === '封面'; });
          if (!sec) throw new Error('详情页里没有「封面」区块');
          const row = sec.querySelector('.pfd-row');
          if (!row || !row.textContent.includes('联网搜索封面')) {
            throw new Error('封面区没有「联网搜索封面」按钮');
          }
          panel.scrollTop = sec.offsetTop - 40;
          await new Promise(r => setTimeout(r, 450));
          return pick.name;
        })()`
      },
      // 新增：批量删除 —— 勾三款，看页脚计数和红色按钮有没有同步
      {
        name: '24-批量删除',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          window.App.goto('all');
          await new Promise(r => setTimeout(r, 400));
          window.Modals.batchRemove();
          await new Promise(r => setTimeout(r, 600));
          const rows = [...document.querySelectorAll('#modalLayer .scan-item')];
          if (rows.length < 3) throw new Error('批量删除列表没出来，只有 ' + rows.length + ' 行');
          // ⚠ 每点一行都会重绘列表，手里这几个节点会失效，
          //   但它们的 onclick 闭包还认得自己的游戏 id，勾中状态存在 Set 里不会丢。
          rows.slice(0, 3).forEach(r => r.click());
          await new Promise(r => setTimeout(r, 500));
          const foot = document.querySelector('#modalLayer .modal-foot');
          const delBtn = [...document.querySelectorAll('#modalLayer .modal-foot .btn-danger')][0];
          if (!delBtn) throw new Error('没有删除按钮');
          if (!delBtn.textContent.includes('删除选中的 3')) {
            throw new Error('删除按钮没同步数量：' + delBtn.textContent);
          }
          return { rows: rows.length, foot: foot ? foot.textContent.trim() : '' };
        })()`
      },
      // 新增：逐款自定义页顶部那排页签上的「×」——
      // 摆拍成"扫到一个装满游戏的文件夹，勾了 6 款进来"的样子，页签要足够多才看得出横向滚动。
      {
        name: '25-逐款自定义-页签×',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          window.App.goto('all');
          await new Promise(r => setTimeout(r, 350));

          const rows = [
            ["【PC硬盘】【官中】拔作岛", '拔作岛', 26.4],
            ['Mad Island', 'Mad Island', 18.9],
            ['Operation Lovecraft Fallen Doll Plan', 'Operation Lovecraft Fallen Doll Plan', 12.7],
            ["(public)Syahara's bad day_v0.32b", "Syahara's bad day", 8.3],
            ['hs2', 'hs2', 7.1],
            ['NinNinDays2', 'NinNinDays2', 5.2]
          ];
          const day = new Date('2026-06-20T00:00:00').getTime();
          const demo = rows.map(([folder, name, gb], i) => ({
            id: 'shot-cz-' + i, name,
            installDir: 'F:\\\\r24\\\\' + folder,
            exePath: 'F:\\\\r24\\\\' + folder + '\\\\' + name + '.exe',
            sizeBytes: Math.round(gb * 1024 * 1024 * 1024),
            installDate: day + i * 86400000,
            steamAppId: '', source: 'folder', sourceLabel: '文件夹',
            confidence: 10, categories: [], alreadyInLibrary: false
          }));

          window.Modals.scanResults(demo);
          await new Promise(r => setTimeout(r, 500));
          const next = [...document.querySelectorAll('.modal-foot .btn')]
            .find(b => b.textContent.includes('逐款自定义'));
          if (!next) throw new Error('勾选列表底部没有「逐款自定义」按钮');
          next.click();
          await new Promise(r => setTimeout(r, 550));

          const tabs = [...document.querySelectorAll('.cz-tab')];
          if (tabs.length !== 6) throw new Error('页签数不对：' + tabs.length);
          const withX = tabs.filter(t => t.querySelector('.cz-tab-x'));
          if (withX.length !== 6) throw new Error('有 ' + (6 - withX.length) + ' 个页签没有 ×');
          // 挑第 2 款把鼠标移上去，让那个 × 显示成 hover 的红色，截图才看得出它是可点的
          const target = tabs[1].querySelector('.cz-tab-x');
          const r = target.getBoundingClientRect();
          return {
            tabs: tabs.length, withX: withX.length,
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
          };
        })()`,
        // CSS :hover 是 JS 造不出来的（dispatchEvent 也骗不了浏览器），得真发一条 mouseMove
        after: async (w, res) => {
          if (!res || !res.x) return;
          w.webContents.sendInputEvent({ type: 'mouseMove', x: res.x, y: res.y });
          await new Promise((r) => setTimeout(r, 400));
        }
      },
      // 新增：卡片右上角「⋮ 更多选项」展开的样子。
      // 先把这一款标成「多结局通关」，这样一张图能同时说明三件事：
      // 左上角的金色角标、⋮ 的高亮、菜单里哪一项是当前值。
      {
        name: '26-卡片通关选项',
        script: `(async () => {
          const $q = (s) => document.querySelector(s);
          window.Modals.closeModal();
          window.Detail.close();
          if ($q('#ctxMenu')) $q('#ctxMenu').hidden = true;
          window.State.view = 'all';
          window.State.category = null;
          window.State.viewMode = 'grid';
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 800));

          const card = document.querySelector('#contentBody .game-card[data-id]');
          if (!card) throw new Error('没有卡片可点');
          const gid = card.dataset.id;

          // 先落一个"多结局通关"，让角标和菜单的当前值都是这一档
          await window.API.update(gid, { clearState: 'multi' }, { silent: true });
          const g = window.State.games.find(x => String(x.id) === String(gid));
          if (g) { g.clearState = 'multi'; window.Cards.refreshClear(g); }
          await new Promise(r => setTimeout(r, 300));

          const more = document.querySelector('#contentBody .game-card[data-id="' + gid + '"] .card-more');
          if (!more) throw new Error('卡片上没有 ⋮ 按钮');
          more.click();
          await new Promise(r => setTimeout(r, 450));

          const menu = document.querySelector('#ctxMenu');
          if (!menu || menu.hidden) throw new Error('更多选项菜单没打开');
          const opts = [...menu.querySelectorAll('.ctx-clear')].map(i => i.textContent.trim());
          if (opts.length !== 3) throw new Error('菜单选项数不对：' + opts.join('/'));
          return { gid, opts };
        })()`
      },
      // 新增：全成就卡片的炫彩流光。
      // ⚠ 摆拍说明：本机 Steam 数据里不一定有"刚好全成就"的游戏，
      //   所以这里临时把某款按全成就渲染（和 tools/probe-clear.js 里同一套做法），
      //   目的是保证这张截图一定拍得到光晕。真实判定逻辑在 --selftest 里验。
      {
        name: '27-全成就流光',
        script: `(async () => {
          const $q = (s) => document.querySelector(s);
          if ($q('#ctxMenu')) $q('#ctxMenu').hidden = true;
          window.Modals.closeModal();
          window.Detail.close();
          window.State.view = 'all';
          window.State.viewMode = 'grid';
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 700));

          const host = document.querySelector('#contentBody .game-grid');
          const list = window.State.visible();
          const cards = [...document.querySelectorAll('#contentBody .game-card[data-id]')];
          if (!cards.length) throw new Error('没有卡片');
          // 挑第 4 张：它在第一排中间，悬停时周围还有别的卡，
          // 正好能看出"光晕只属于这一张、也不会把邻居盖住"
          const pick = cards[Math.min(3, cards.length - 1)];
          const gid = pick.dataset.id;

          // ⚠ 打补丁前先把原函数收起来，拍完必须还原（见下面 cleanup）。
          //   以前这里"留着不还原"，是因为当时它是最后一张截图；
          //   后面又加了 28/29/30 之后，这个补丁就把那三张一起带坏了 ——
          //   现象是卡片上的成就角标全没了、详情页也查不到成就。
          window.__ghRealFindSteam = window.__ghRealFindSteam || window.PlatformView.findBySteamAppId;
          window.PlatformView.findBySteamAppId = (appId) => {
            const g = window.State.games.find(x => String(x.id) === String(gid));
            if (g && String(g.steamAppId) === String(appId)) return { achievements: { unlocked: 40, total: 40 } };
            return null;
          };
          // ⚠ 要 await：decorateAchievements 内部先同步补一遍，
          //   之后还会等 Steam 快照再补第二遍。抢在那之前截图，
          //   第二遍会用真实数据把 is-perfect 抹掉，光晕就没了。
          await window.Cards.decorateAchievements(host, list);
          await new Promise(r => setTimeout(r, 400));

          const card = document.querySelector('#contentBody .game-card[data-id="' + gid + '"]');
          if (!card || !card.classList.contains('is-perfect')) {
            throw new Error('这一款没有变成全成就卡片');
          }
          const r = card.getBoundingClientRect();
          return { gid, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) };
        })()`,
        // 光晕是 :hover 才出来的，必须发一条真鼠标移动进去
        after: async (w, res) => {
          if (!res || !res.x) return;
          w.webContents.sendInputEvent({ type: 'mouseMove', x: res.x, y: res.y });
          // 光晕有 0.3s 的淡入，等它走完再拍
          await new Promise((r) => setTimeout(r, 800));
        },
        // 拍完把"查平台数据"换回真实现，否则后面几张截图全看不到成就
        cleanup: `(() => {
          if (window.__ghRealFindSteam) {
            window.PlatformView.findBySteamAppId = window.__ghRealFindSteam;
            window.App.refresh();
          }
          return true;
        })()`
      },
      // 新增：详情页里的「通关状态」分段控件。
      // 用户原话："详情页里要不要也显示/修改通关状态也添加"。
      // 这里拍的是操作条：▶ 启动游戏 / 三档分段控件 / ☆ 收藏 …
      {
        name: '28-详情页通关状态',
        script: `(async () => {
          const $q = (s) => document.querySelector(s);
          if ($q('#ctxMenu')) $q('#ctxMenu').hidden = true;
          window.Modals.closeModal();
          window.Detail.close();
          window.State.view = 'all';
          window.State.viewMode = 'grid';
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 700));

          const card = document.querySelector('#contentBody .game-card[data-id]');
          if (!card) throw new Error('没有卡片');
          const gid = card.dataset.id;
          // 摆成"多结局通关"，这样截图里能看出高亮跟的是哪一档
          await window.API.update(gid, { clearState: 'multi' }, { silent: true });
          const g = window.State.games.find(x => String(x.id) === String(gid));
          if (g) g.clearState = 'multi';

          window.Detail.open(gid);
          await new Promise(r => setTimeout(r, 900));

          const btns = [...document.querySelectorAll('#detailLayer .pfd-clear-seg .pcs-btn')];
          if (btns.length !== 3) throw new Error('分段控件不是 3 档：' + btns.length);
          const on = document.querySelector('#detailLayer .pfd-clear-seg .pcs-btn.is-on .pcs-text');
          if (!on || on.textContent.trim() !== '多结局通关') {
            throw new Error('高亮档位不对：' + (on ? on.textContent : '没有高亮项'));
          }
          // 把鼠标移到"未通关"那颗上，截图能看出它是可以点的（有 hover 反馈）
          const r = btns[2].getBoundingClientRect();
          return {
            gid,
            labels: btns.map(b => b.querySelector('.pcs-text').textContent.trim()),
            on: on.textContent.trim(),
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
          };
        })()`,
        after: async (w, res) => {
          if (!res || !res.x) return;
          w.webContents.sendInputEvent({ type: 'mouseMove', x: res.x, y: res.y });
          await new Promise((r) => setTimeout(r, 400));
        }
      },
      // 新增：「未通关」角标的亚克力材质特写。
      // 整屏截图里角标只有几十像素高，材质根本看不出来，
      // 所以这一张只抓卡片那一小块（clip），顺便把鼠标移进卡片里
      // 让悬浮渐变压在角标下面 —— 亚克力的"透"正是靠底下的画面透上来才明显。
      {
        name: '29-未通关亚克力材质',
        script: `(async () => {
          const $q = (s) => document.querySelector(s);
          if ($q('#ctxMenu')) $q('#ctxMenu').hidden = true;
          window.Modals.closeModal();
          window.Detail.close();
          window.State.view = 'all';
          window.State.viewMode = 'grid';
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 800));

          const cards = [...document.querySelectorAll('#contentBody .game-card[data-id]')];
          if (!cards.length) throw new Error('没有卡片');
          // 挑第 2 张：左边还有邻居，背景不会是一片死黑，亚克力更好认
          const pick = cards[Math.min(1, cards.length - 1)];
          const gid = pick.dataset.id;
          // 前一张截图把它改成了"多结局"，这里强制回到未通关
          await window.API.update(gid, { clearState: 'uncleared' }, { silent: true });
          const g = window.State.games.find(x => String(x.id) === String(gid));
          if (g) { g.clearState = 'uncleared'; window.Cards.refreshClear(g); }
          await new Promise(r => setTimeout(r, 400));

          const badge = pick.querySelector('.card-clear');
          if (!badge || !badge.classList.contains('cc-uncleared')) {
            throw new Error('这张卡不是"未通关"角标');
          }
          const cs = getComputedStyle(badge);
          // 三条硬指标：半透明底 / 有 backdrop-filter / 有亮色细边框
          if (!/rgba\\(/.test(cs.backgroundColor)) throw new Error('底色不是半透明：' + cs.backgroundColor);
          if (!/blur/.test(cs.backdropFilter || cs.webkitBackdropFilter || '')) {
            throw new Error('没有 backdrop-filter 模糊：' + cs.backdropFilter);
          }
          const r = pick.getBoundingClientRect();
          return {
            gid,
            bg: cs.backgroundColor,
            bf: cs.backdropFilter || cs.webkitBackdropFilter,
            // 裁这一张卡，四周各留 6px；再夹到窗口内，越界会让 capturePage 拍出空白
            clip: {
              x: Math.max(0, Math.round(r.left) - 6),
              y: Math.max(0, Math.round(r.top) - 6),
              width: Math.min(Math.round(r.width) + 12, window.innerWidth),
              height: Math.min(Math.round(r.height) + 12, window.innerHeight)
            },
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.72)
          };
        })()`,
        after: async (w, res) => {
          if (!res || !res.x) return;
          // 鼠标进卡片 → 悬浮层渐显，角标底下就有内容可"透"
          w.webContents.sendInputEvent({ type: 'mouseMove', x: res.x, y: res.y });
          await new Promise((r) => setTimeout(r, 700));
        },
        clip: (res) => res && res.clip
      },
      // 新增：详情页的「时长 / 最近游玩 / 成就」和 Steam 完全一致。
      // 这一张是这轮修复的直接证据：以前这类游戏（没从 GameHub 启动过）
      // 详情页是「未玩过 / 从未」，连成就那一行都不会出现。
      {
        name: '30-时长与成就已对齐',
        script: `(async () => {
          const $q = (s) => document.querySelector(s);
          if ($q('#ctxMenu')) $q('#ctxMenu').hidden = true;
          window.Modals.closeModal();
          window.Detail.close();
          window.State.view = 'all';
          window.State.viewMode = 'grid';
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 700));

          // 先确保平台快照在手上
          await window.PlatformView.ensure('steam');
          await new Promise(r => setTimeout(r, 900));

          // 挑一款"Steam 有成就"的（成就那一行最容易漏）
          const pick = window.State.games.find((g) => {
            if (!g.steamAppId) return false;
            const pg = window.PlatformView.findBySteamAppId(g.steamAppId);
            return pg && pg.achievements && pg.achievements.total > 0 && pg.playtimeMs > 0;
          });
          if (!pick) throw new Error('库里没有"Steam 有成就"的游戏可拍');

          const pg = window.PlatformView.findBySteamAppId(pick.steamAppId);
          if ((pick.totalPlayMs || 0) < pg.playtimeMs) {
            throw new Error('库里时长还是比 Steam 小：' + pick.totalPlayMs + ' < ' + pg.playtimeMs);
          }

          window.Detail.open(pick.id);
          await new Promise(r => setTimeout(r, 1500));

          const chips = [...document.querySelectorAll('#detailLayer .pfd-stat')]
            .map(n => n.textContent.trim());
          if (!chips.some(c => c.includes('成就'))) {
            throw new Error('详情页没有成就胶囊：' + chips.join(' / '));
          }
          return { name: pick.name, appId: pick.steamAppId, chips };
        })()`,
        // 打开详情页就已经是目标画面了，不需要额外动作；留一个空 after 保证时序一致
        after: async () => { await new Promise((r) => setTimeout(r, 400)); }
      },
      // 新增：Epic 平台的「未登录」状态。
      // 这一页现在多了一个「登录账号」入口 —— 之前 Epic 只能显示"本地读不到账号名"，
      // 是一句死胡同一样的提示，现在它是可以往下走一步的。
      {
        name: '31-Epic平台页-登录入口',
        script: `(async () => {
          const $q = (s) => document.querySelector(s);
          if ($q('#ctxMenu')) $q('#ctxMenu').hidden = true;
          window.Modals.closeModal();
          window.Detail.close();
          // ⚠ 必须显式回总览：平台页会"记住上次停在哪个平台"，
          //   上一张截图进过 Steam 的库页，不回总览的话压根渲染不出平台卡片。
          window.State.view = 'platform';
          window.PlatformView.gotoOverview();
          await window.PlatformView.ensure('epic');
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 1100));

          // 点进 Epic 的二级页面
          const card = [...document.querySelectorAll('.pf-card')]
            .find(c => (c.textContent || '').includes('Epic Games'));
          if (!card) throw new Error('总览里找不到 Epic 卡片');
          card.click();
          await new Promise(r => setTimeout(r, 1200));

          const btn = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').includes('登录'));
          if (!btn) throw new Error('Epic 页面上没有出现登录按钮');
          return { button: btn.textContent.trim() };
        })()`
      },
      // 新增：Epic 登录后的样子（注入演示数据，因为真机没法替用户走一遍授权）。
      // 要点：账号里有 3 款，其中 2 款没下载 —— 那两张必须黑白显示且带「未安装」角标，
      // 这正是之前"用户只能看到自己装过的那些"缺失的部分。
      {
        name: '32-Epic平台页-登录后',
        script: `(async () => {
          const snap = await window.PlatformView.ensure('epic');
          if (!snap) throw new Error('Epic 快照不存在');
          window.__epicBackup = JSON.stringify(snap.games || []);

          snap.loggedIn = true;
          snap.account = { id: 'demo-account', name: 'Epic 玩家', accountName: 'epic_player' };
          snap.games = [
            { platformId:'epic', appId:'A', name:'已安装的游戏 A', installed:true,
              installDir:'D:\\\\Epic\\\\A', sizeBytes: 42e9, playtimeMs: 5400000,
              category:'动作', coverUrl:'', source:'both' },
            { platformId:'epic', appId:'B', name:'没下载的游戏 B', installed:false,
              playtimeMs: 0, category:'冒险', coverUrl:'', source:'api' },
            { platformId:'epic', appId:'C', name:'领了没下载的游戏 C', installed:false,
              playtimeMs: 0, category:'策略', coverUrl:'', source:'api' }
          ];
          snap.stats = { owned: 3, installed: 1, notInstalled: 2, totalPlayMs: 5400000,
                         achGames: 0, achUnlocked: 0, achTotal: 0 };
          snap.warnings = [];
          // 直接定锚到 Epic 的二级页，别指望上一张留下的 current
          window.State.view = 'platform';
          window.PlatformView.gotoPlatform('epic');
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 1200));

          const cards = [...document.querySelectorAll('.pf-game')];
          const notInstalled = [...document.querySelectorAll('.pf-game.not-installed')];
          if (cards.length !== 3) throw new Error('卡片数不对：' + cards.length);
          if (notInstalled.length !== 2) throw new Error('未安装卡片数不对：' + notInstalled.length);
          const acct = document.querySelector('.pf-acct-big-name');
          if (!acct) throw new Error('没有显示账号卡');
          return { cards: cards.length, notInstalled: notInstalled.length, account: acct.textContent.trim() };
        })()`,
        // ⚠ 这里必须还原：上面改的是 ensure() 缓存在同一个对象引用上的数据，
        //   不还原的话这一张之后的截图会被污染。
        cleanup: `(async () => {
          const snap = await window.PlatformView.ensure('epic');
          if (snap && window.__epicBackup) {
            snap.games = JSON.parse(window.__epicBackup);
            delete window.__epicBackup;
          }
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 400));
        })()`
      },
      // 新增：点「登录」之后主窗口上那层遮罩。
      // 弹出的 Epic 登录窗是**独立窗口**，很容易没被注意到 ——
      // 遮罩存在的意义就是把"下一步做什么"摆到眼前。
      {
        name: '33-Epic登录遮罩',
        script: `(async () => {
          window.State.view = 'platform';
          window.PlatformView.gotoPlatform('epic');
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 700));
          window.PlatformView.showLoginVeil();
          await new Promise(r => setTimeout(r, 400));
          const veil = document.getElementById('pfEpicVeil');
          if (!veil) throw new Error('登录遮罩没渲染出来');
          return { text: veil.textContent.slice(0, 40) };
        })()`,
        cleanup: `(() => { window.PlatformView.hideLoginVeil(); })()`
      },
      /* 新增：Epic 平台页 —— **真实账号数据**，不注入任何演示值。
       *
       * 为什么非要这一张：上面 32 号那张是注入的演示数据，只能证明"界面能画对"，
       * 证明不了"数据取得对"。而用户遇到的问题恰恰出在数据上 ——
       * 详情索引的键对不上，害得大批游戏退化成内部代号 "Live"、封面全空。
       * 这一张走完整的真实链路（真 token → 库服务 → 目录服务 → 折算），
       * 拍出来的就是用户现在应该看到的样子。 */
      {
        name: '36-Epic平台页-真实账号数据',
        script: `(async () => {
          // 强制重新拉一次，别吃缓存 —— 要的就是"现在这一刻"的真实结果
          const snap = await window.PlatformView.resync('epic');
          if (!snap) return { 跳过: '拿不到 Epic 快照' };
          if (!snap.loggedIn) {
            // 没带凭证（没加 --epic-live）时会走到这里。
            // 不抛错 —— 这是"这一张拍不了"，不是"功能坏了"，别混为一谈。
            return { 跳过: '本机未登录，加 --epic-live 才拍得到真实数据' };
          }

          window.State.view = 'platform';
          window.PlatformView.gotoPlatform('epic');
          window.App.renderContent();
          await new Promise(r => setTimeout(r, 2500));   // 等封面图从 CDN 下完

          const cards = [...document.querySelectorAll('.pf-game')];
          const names = cards.map(c => ((c.querySelector('.pf-game-name') || {}).textContent || '').trim());
          const live = names.filter(n => /^live$/i.test(n));
          // 名字里还有内部代号 = 修复没生效。直接抛错，别拿错的东西当证据。
          if (live.length) throw new Error('还有 ' + live.length + ' 款显示成 "Live"');
          const withImg = cards.filter(c => c.querySelector('img')).length;
          return { 卡片数: cards.length, 有封面: withImg, 前几个: names.slice(0, 4) };
        })()`
      },

      /* ---------------- MOD 管理（第十七轮） ----------------
       * 四张图分别对应主人提的几件事，**全部是真数据**：
       *   37 真实数据：本机 I:\Steam 里真的有 125 个 RimWorld 创意工坊条目，
       *      这张证明"扫描 + 铺开 + 启用禁用按钮"是真的在真数据上跑出来的。
       *   38 标签二级分类：用 CS2（730）—— 4 个真实标签分组 + 无标签兜底桶。
       *   39 非 Steam：自己添加 + N 网。
       *   40 删除确认：把完整路径铺出来那一步。
       *
       * ⚠ 38 / 40 原先用的是**演示数据**，因为当时连不上 api.steampowered.com
       *   拿不到真实标签（"连不上 Steam 创意工坊接口"那行警告就是这么来的）。
       *   后来查清是 Node 的 TLS 不补证书链、改成走 Electron net.fetch 之后
       *   工坊接口通了，演示数据就彻底没用了 —— 已经删掉，别再往回加。 */
      {
        name: '37-MOD管理-创意工坊真实数据',
        script: `(async () => {
          window.Modals.closeModal();
          const g = (window.State.games || []).find(x => String(x.steamAppId) === '294100')
            || (window.State.games || []).find(x => x.steamAppId);
          if (!g) throw new Error('库里没有带 Steam 的游戏，拍不了 MOD 区');
          window.Detail.close();
          await new Promise(r => setTimeout(r, 250));
          window.Detail.open(g.id);
          for (let i = 0; i < 120 && !document.querySelector('.pfd-mod-card'); i++) {
            await new Promise(r => setTimeout(r, 250));
          }
          const rail = document.querySelector('.pfd-mod-rail');
          if (!rail) throw new Error('MOD 横列没渲染出来');
          const body = document.querySelector('#detailLayer .pfd-body') || document.querySelector('#detailLayer');
          if (body) body.scrollTop = 0;
          // 1.4s：入场动画（0.16s）+ 卡片错峰进场，必须等它们全停再量几何
          await new Promise(r => setTimeout(r, 1400));
          const n = document.querySelectorAll('.pfd-mod-card').length;
          if (!n) throw new Error('一个 MOD 卡片都没有 —— 是不是没扫到 I:\\\\Steam 的创意工坊目录');

          /* 顺手量一下"是不是真的铺开了"。主人明确要的是"铺开、不要一条横着的"，
           * 所以这几条要一直守着。 */
          const geo = ${MOD_GEO};
          const cols = geo ? geo.列数 : 0;
          if (rail.scrollWidth > rail.clientWidth + 1) throw new Error('还在横向滚动（不是铺开的）');
          if (cols < 2) throw new Error('只有 ' + cols + ' 列，没铺开');
          if (geo && geo.越出面板 > 1) throw new Error('网格越出了面板右边缘 ' + geo.越出面板 + 'px（被裁掉了）');

          /* 主人截图里那行「连不上 Steam 创意工坊接口（fetch failed / unable to verify
           * the first certificate）」必须彻底消失。它就是工坊接口没通的症状，
           * 所以这里当回归哨兵守着 —— 一旦又冒出来，说明 net.fetch 那条路又断了。 */
          const note = document.querySelector('.pfd-mod-note');
          if (note && /连不上|创意工坊接口/.test(note.textContent || '')) {
            throw new Error('仍在提示连不上创意工坊接口：' + note.textContent);
          }

          const real = [...document.querySelectorAll('.pfd-mod-name')]
            .filter(el => el.textContent && !/^创意工坊项目 /.test(el.textContent)).length;

          return { 游戏: g.name, 卡片数: n,
                   分组数: document.querySelectorAll('.pfd-mod-group').length,
                   真实名字: real, 过滤条数: document.querySelectorAll('.pfd-mod-tag').length,
                   几何: geo,
                   计数: (document.querySelector('.pfd-mod-count') || {}).textContent };
        })()`
      },
      {
        /* 真实数据：用 CS2（730）—— 21 个工坊条目、4 个真实标签分组
         * （Classic / Cs2 / Custom / 无标签兜底桶）。
         * 断言卡在"必须存在真标签分组"上：如果全是兜底桶，这张图就证明不了
         * "按标签二级分类"，跟当初那份演示数据犯的是同一个错。 */
        name: '38-MOD管理-标签二级分类',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          await new Promise(r => setTimeout(r, 250));
          window.ModView._state().gameId = '';      // 骗过"换游戏才重置"的判断
          window.ModView._state().data = null;
          const g = ${PICK_MOD_GAME};
          if (!g) throw new Error('库里没有游戏，拍不了 MOD 区');
          window.Detail.open(g.id);
          for (let i = 0; i < 120 && !document.querySelector('.pfd-mod-card'); i++) {
            await new Promise(r => setTimeout(r, 250));
          }
          const body = document.querySelector('#detailLayer .pfd-body') || document.querySelector('#detailLayer');
          if (body) body.scrollTop = 0;
          await new Promise(r => setTimeout(r, 1400));

          const geo = ${MOD_GEO};
          if (geo && geo.越出面板 > 1) throw new Error('网格越出了面板右边缘 ' + geo.越出面板 + 'px（被裁掉了）');

          const groups = [...document.querySelectorAll('.pfd-mod-group')];
          if (groups.length < 2) throw new Error('分组只画了 ' + groups.length + ' 行，标签二级分类没生效');

          const heads = groups.map(el => ((el.querySelector('.pfd-mod-gname') || {}).textContent || '').trim());
          const real = heads.filter(h => h && !/无标签|本地 MOD/.test(h));
          if (!real.length) throw new Error('没有真实标签分组（全是兜底桶）：' + heads.join(' | '));

          const note = document.querySelector('.pfd-mod-note');
          if (note && /连不上|创意工坊接口/.test(note.textContent || '')) {
            throw new Error('仍在提示连不上创意工坊接口：' + note.textContent);
          }

          return { 游戏: g.name, 分组行数: groups.length, 真标签分组: real, 全部分组: heads,
                   卡片数: document.querySelectorAll('.pfd-mod-card').length,
                   几何: geo,
                   筛选条: [...document.querySelectorAll('.pfd-mod-tag')].map(b => b.textContent.trim()) };
        })()`
      },
      {
        name: '39-MOD管理-非Steam游戏',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          await new Promise(r => setTimeout(r, 200));
          // 库里全是 Steam 游戏，临时建一条"不在 Steam 上"的来看非 Steam 分支。
          // 路径留空 → 不触发体积计算和封面抓取，秒出。
          const gid = '__shot_mod_nosteam__';
          await window.API.addOne({ id: gid, name: '非 Steam 示例游戏', source: 'manual', categories: ['模拟'] });
          await window.App.refresh();
          await new Promise(r => setTimeout(r, 500));
          window.ModView._state().gameId = '';
          window.ModView._state().data = null;
          window.Detail.open(gid);
          for (let i = 0; i < 60 && !document.querySelector('.pfd-mod-empty'); i++) {
            await new Promise(r => setTimeout(r, 200));
          }
          await new Promise(r => setTimeout(r, 500));
          const empty = document.querySelector('.pfd-mod-empty-t');
          if (!empty) throw new Error('非 Steam 的空状态没出来');
          const btns = [...document.querySelectorAll('.pfd-mod-bar .btn')].map(b => b.textContent.trim());
          if (btns.some(b => b.includes('创意工坊'))) throw new Error('非 Steam 游戏不该出现创意工坊按钮');
          return { 空状态: empty.textContent, 按钮: btns };
        })()`,
        cleanup: `(async () => {
          try { window.Detail.close(); } catch (e) {}
          try { await window.API.remove(['__shot_mod_nosteam__']); } catch (e) {}
          try { await window.App.refresh(); } catch (e) {}
        })()`
      },
      {
        /* 真实数据：点真卡片上的「删除」，把确认弹窗（含完整路径）拍出来。
         * ⚠ 只到"弹确认框"这一步就停，绝不点最终的那个"确认删除" ——
         *   确认框本身不碰磁盘，点了确认才会真把文件扔回收站。 */
        name: '40-MOD删除确认',
        script: `(async () => {
          window.Modals.closeModal();
          window.Detail.close();
          await new Promise(r => setTimeout(r, 250));
          window.ModView._state().gameId = '';
          window.ModView._state().data = null;
          const g = ${PICK_MOD_GAME};
          if (!g) throw new Error('库里没有游戏，拍不了 MOD 区');
          window.Detail.open(g.id);
          for (let i = 0; i < 120 && !document.querySelector('.pfd-mod-card'); i++) {
            await new Promise(r => setTimeout(r, 250));
          }
          // 点第一张卡上的「删除」（真实按钮路径，不是直接调函数）
          const del = document.querySelector('.pfd-mod-card .pfd-mod-acts .btn.danger');
          if (!del) throw new Error('卡片上没有删除按钮');
          del.click();
          for (let i = 0; i < 40 && !document.querySelector('.mod-del-name'); i++) {
            await new Promise(r => setTimeout(r, 200));
          }
          if (!document.querySelector('.mod-del-name')) throw new Error('删除确认弹窗没出来');
          await new Promise(r => setTimeout(r, 400));
          return { 游戏: g.name, 待删条目: (document.querySelector('.mod-del-name') || {}).textContent };
        })()`,
        // 只关弹窗 —— 全程没有真的删任何东西，不需要还原
        cleanup: `(() => { try { window.Modals.closeModal(); } catch (e) {} })()`
      },
    ];

    // ⚠ 这里不能简单写 path.dirname(SHOT_PATH)：
    //   传 --shot=preview 时 dirname('preview') 是 '.'，截图会全部散落到项目根目录。
    //   规则：带扩展名（如 out/a.png）才当文件路径取目录；否则整体当目录名。
    const outDir = path.extname(SHOT_PATH) ? path.dirname(SHOT_PATH) : SHOT_PATH;
    await fsp.mkdir(outDir, { recursive: true });

    for (const s of shots) {
      // --only=<子串>：只跑匹配的那几张，省得为一张图等全套
      if (SHOT_ONLY && !s.name.includes(SHOT_ONLY)) continue;
      let res = null;
      try {
        res = await win.webContents.executeJavaScript(s.script);
      } catch (e) {
        log(`执行 ${s.name} 的界面脚本失败：`, e.message);
      }
      /* 把脚本的返回值打出来。
       * 以前这里是丢掉的 —— 于是"脚本到底看没看见该看见的东西"全靠肉眼看图，
       * 而图里少一块的原因可能是没渲染出来、也可能是被裁掉了，分不清。
       * 脚本返回的那几个数字（条数/分组数/几何）才是能直接断言的证据。 */
      if (res !== null && res !== undefined) {
        log(`  ${s.name} → ${typeof res === 'string' ? res : JSON.stringify(res)}`);
      }
      // 有些画面必须真实鼠标悬停才会出现（CSS :hover 是 JS 造不出来的），
      // 所以留一个 after 钩子：界面脚本返回坐标，主进程往里发一条 mouseMove。
      if (s.after) {
        try { await s.after(win, res); }
        catch (e) { log(`执行 ${s.name} 的收尾动作失败：`, e.message); }
      }
      await new Promise((res) => setTimeout(res, 1400));
      // 抓图之前强制走两帧：确保脚本造成的界面变化已经真的被合成上屏，
      // 否则 capturePage() 可能抢在重绘之前，拍到旧画面。
      await win.webContents.executeJavaScript(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))'
      ).catch(() => {});
      win.moveTop();
      // 有些细节（比如角标材质）整屏看不清，可以让脚本返回一个区域只抓那一块。
      // ⚠ 坐标是设备像素，本机缩放 100% 时和 CSS 像素一致；
      //   若在高 DPI 屏上跑，这里会偏，需要乘 devicePixelRatio。
      const clip = s.clip ? s.clip(res) : null;
      const img = clip ? await win.webContents.capturePage(clip) : await win.webContents.capturePage();
      const file = path.join(outDir, `${s.name}.png`);
      await fsp.writeFile(file, img.toPNG());
      log(`已保存 ${file}`);

      /* 收尾钩子：有些截图为了摆姿势会临时改掉页面里的函数
       * （比如"查平台数据"换成假的，好让某张卡一定是全成就）。
       * 这类改动必须在拍完后还原 —— 否则会污染后面所有截图，
       * 而且症状很隐蔽：卡片上的成就角标突然全没了，看着像功能坏了。
       * 踩过一次：第 27 张的补丁没撤，害得 28/29/30 三张全是错的。 */
      if (s.cleanup) {
        try { await win.webContents.executeJavaScript(s.cleanup); }
        catch (e) { log(`执行 ${s.name} 的收尾还原失败：`, e.message); }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    /* ---------------- 额外：Epic 登录窗口本身 ----------------
     * 这两张拍的不是主窗口，而是那个弹出来的登录窗 ——
     * 用户第一次就是在这里撞上一整屏裸 JSON 的，
     * 所以要留下"它已经被换成人话"的直接证据。
     *
     * 做法：先真的把用户当时看到的那段 JSON 铺上去，再调 paintLoginResult 覆盖它。
     * 两步都是真实路径（连样本都用的实测原文），不是摆拍。 */
    for (const [name, ok] of [
      ['34-Epic登录窗口-登录成功', true],
      ['35-Epic登录窗口-还没登录', false]
    ]) {
      if (SHOT_ONLY && !name.includes(SHOT_ONLY)) continue;
      const w = new BrowserWindow({
        width: 900, height: 600, show: false,
        backgroundColor: '#0b1016',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      try {
        const sample = JSON.stringify({
          warning: 'Do not share this code with any 3rd party service. It allows full access to your Epic account.',
          redirectUrl: 'https://localhost/launcher/authorized',
          authorizationCode: ok ? 'demo-code-not-real' : null,
          exchangeCode: null,
          sid: null
        }, null, 2);

        const escaped = sample.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          '<pre style="margin:0;padding:24px;background:#fff;color:#000;'
          + 'font:13px/1.6 monospace;white-space:pre-wrap;">' + escaped + '</pre>'));

        await paintLoginResult(
          w, ok,
          ok ? '登录成功' : '还没有登录 Epic 账号',
          ok ? '正在用授权码换取访问令牌，稍等片刻…'
             : '上面那串是 Epic 返回的原始数据，不是登录页。请点下面的按钮回到登录页，完成登录后窗口会自动关闭。',
          ok ? '' : 'https://www.epicgames.com/id/login'
        );

        await new Promise((r) => setTimeout(r, 400));
        const img = await w.webContents.capturePage();
        await fsp.writeFile(path.join(outDir, `${name}.png`), img.toPNG());
        log(`已保存 ${path.join(outDir, `${name}.png`)}`);
      } catch (e) {
        log(`拍 ${name} 失败：`, e.message);
      } finally {
        try { w.destroy(); } catch { /* 关不掉不强求 */ }
      }
    }

    // 顺便导出一份扫描结果的 JSON，方便核对数据
    await fsp.writeFile(
      path.join(outDir, 'scan-result.json'),
      JSON.stringify(store.getGames().map((g) => ({
        name: g.name, altNames: g.altNames, source: g.source, categories: g.categories,
        installDate: g.installDate, sizeBytes: g.sizeBytes, installDir: g.installDir,
        coverKind: g.coverKind, exePath: g.exePath
      })), null, 2),
      'utf8'
    );

    log('全部截图完成 ✓');
  } catch (e) {
    console.error('[截图] 失败：', e);
  } finally {
    setTimeout(() => app.exit(0), 500);
  }
}
