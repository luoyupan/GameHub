/**
 * ============================================================
 *  GameHub - 游戏启动与进程守护模块  (src/main/launcher.js)
 * ------------------------------------------------------------
 *  负责：
 *    · 启动游戏（直接跑 exe / 走 steam:// 协议 / 走自定义启动参数）
 *    · 【进程守护计时】—— 游戏开着的时候每秒计时，关掉后把时长写回游戏库
 *    · 启动失败时给出人话错误提示（文件不存在 / 权限不足 / 需要管理员）
 *
 *  为什么要"守护计时"：
 *    有些游戏启动后会立刻把控制权交给另一个进程（反作弊、启动器套启动器），
 *    单纯监听子进程 exit 会瞬间就报"已退出"。
 *    所以这里采用「子进程事件 + tasklist 轮询」双保险：
 *    子进程退出后，还要用 tasklist 确认游戏进程真的不在列表里，才算本次会话结束。
 * ============================================================
 */

const { spawn, execFile } = require('child_process');
const { shell } = require('electron');
const path = require('path');
const fs = require('fs');
const scanner = require('./scanner');

/** 轮询间隔（毫秒） */
const POLL_MS = 5000;
/** 连续多少次查不到进程才判定为"已退出"（防止启动瞬间的检测空窗） */
const MISS_THRESHOLD = 2;

class Launcher {
  /**
   * @param {import('./library').Library} library
   * @param {(payload:object)=>void} emit 向渲染进程广播状态的函数
   */
  constructor(library, emit = () => {}) {
    this.library = library;
    this.emit = emit;
    this.sessions = new Map();   // gameId -> session
    this._timer = null;
  }

  /* ================================================================
   *  启动
   * ================================================================ */

  /**
   * 启动一款游戏。
   * @param {string} id 游戏 ID
   * @returns {Promise<{ok:boolean, error?:string, mode?:string}>}
   */
  async launch(id) {
    const game = this.library.store.findGame(id);
    if (!game) return { ok: false, error: '游戏不存在' };

    // 已经开着就别重复启动
    if (this.sessions.has(id)) {
      return { ok: false, error: '这款游戏已经在运行了' };
    }

    let exe = game.exePath;
    // ① 没记录主程序 / 主程序已被移动 → 现场在安装目录里重新找一次
    if (!exe || !fs.existsSync(exe)) {
      if (game.installDir && fs.existsSync(game.installDir)) {
        const found = await scanner.pickExeInDir(game.installDir, 2);
        if (found) {
          exe = found.path;
          this.library.update(id, { exePath: exe, missing: false });
        }
      }
    }

    // ② Steam 游戏优先走 steam:// 协议（能用 Steam 的云存档 / 好友 / 时长统计）
    if (game.steamAppId && !exe) {
      return this._launchViaSteam(game);
    }
    // ③ 有 Steam ID 但用户手动改了 exePath → 尊重用户，直接跑 exe
    // ④ 真正启动
    if (!exe) {
      return { ok: false, error: '找不到可执行文件，请右键 → 编辑信息 手动指定主程序路径' };
    }
    if (!fs.existsSync(exe)) {
      this.library.update(id, { missing: true });
      return { ok: false, error: `主程序不存在：${exe}` };
    }

    try {
      const args = splitArgs(game.launchArgs);
      const child = spawn(exe, args, {
        cwd: path.dirname(exe),
        detached: false,
        stdio: 'ignore',
        windowsHide: false
      });

      // 极少数环境（如被安全策略拦截）会在 spawn 阶段同步抛错
      child.on('error', (err) => {
        this.emit({ type: 'launchError', id, error: friendlyError(err, exe) });
      });

      this._startSession(game, child);
      return { ok: true, mode: 'exe', exe };
    } catch (err) {
      return { ok: false, error: friendlyError(err, exe) };
    }
  }

  /** 通过 steam:// 协议启动 */
  async _launchViaSteam(game) {
    try {
      await shell.openExternal(`steam://rungameid/${game.steamAppId}`);
      this._startSession(game, null);
      return { ok: true, mode: 'steam' };
    } catch (err) {
      return { ok: false, error: '调用 Steam 失败，请确认 Steam 已安装并登录' };
    }
  }

  /* ================================================================
   *  进程守护计时
   * ================================================================ */

  /** 开启一次会话计时 */
  _startSession(game, child) {
    const procName = game.exePath ? path.basename(game.exePath).toLowerCase() : '';
    const session = {
      id: game.id,
      name: game.name,
      procName,
      startAt: Date.now(),
      child,
      missCount: 0,
      confirmedRunning: false
    };
    this.sessions.set(game.id, session);

    this.library.recordLaunch(game.id);
    this.emit({ type: 'launch', id: game.id, name: game.name, startAt: session.startAt, mode: procName ? 'exe' : 'steam' });
    this._ensureTimer();

    // 子进程直接退出 → 交给轮询做最终确认（不直接结束会话）
    if (child) {
      child.on('exit', () => {
        session.child = null;
        session.missCount = 0;
      });
    }
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), POLL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /** 每 5 秒检查一次所有活跃会话 */
  async _tick() {
    if (!this.sessions.size) {
      clearInterval(this._timer);
      this._timer = null;
      return;
    }
    for (const session of [...this.sessions.values()]) {
      const alive = await this._isProcessAlive(session);
      if (alive) {
        session.confirmedRunning = true;
        session.missCount = 0;
        // 向前端推送实时时长（每 5 秒一次，用于界面上的"正在游戏 12 分钟"）
        this.emit({
          type: 'tick',
          id: session.id,
          elapsedMs: Date.now() - session.startAt
        });
      } else {
        session.missCount++;
        // 还没确认启动过就消失 → 可能启动失败了，多给两次机会
        const limit = session.confirmedRunning ? MISS_THRESHOLD : MISS_THRESHOLD + 2;
        if (session.missCount >= limit) {
          this._endSession(session);
        }
      }
    }
  }

  /** 用 tasklist 判断游戏进程是否还活着 */
  _isProcessAlive(session) {
    return new Promise((resolve) => {
      if (!session.procName) return resolve(false);
      try {
        execFile(
          'tasklist',
          ['/FI', `IMAGENAME eq ${session.procName}`, '/FO', 'CSV', '/NH'],
          { windowsHide: true, timeout: 8000 },
          (err, stdout) => {
            if (err || !stdout) return resolve(false);
            resolve(String(stdout).toLowerCase().includes(session.procName));
          }
        );
      } catch {
        resolve(false);
      }
    });
  }

  /** 结束会话：写入游玩时长 */
  _endSession(session) {
    this.sessions.delete(session.id);
    const ms = Date.now() - session.startAt;
    const endAt = Date.now();
    const g = this.library.recordSession(session.id, ms, endAt);
    this.emit({
      type: 'exit',
      id: session.id,
      name: session.name,
      durationMs: ms,
      totalPlayMs: g ? g.totalPlayMs : 0
    });
  }

  /** 手动结束某个会话（界面上的"结束游戏"按钮） */
  stop(id) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: '没有正在运行的会话' };
    if (s.procName) {
      try { execFile('taskkill', ['/IM', s.procName, '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
    }
    this._endSession(s);
    return { ok: true };
  }

  /** 当前正在运行的游戏（用于界面显示"运行中"徽章） */
  running() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      startAt: s.startAt,
      elapsedMs: Date.now() - s.startAt
    }));
  }
}

/* ------------------------------------------------------------------
 *  小工具
 * ------------------------------------------------------------------ */

/** 把启动参数字符串切割成数组，支持引号包裹 */
function splitArgs(str) {
  if (!str || !String(str).trim()) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str)))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** 把系统错误翻译成人能看懂的中文提示 */
function friendlyError(err, exe) {
  const code = err && err.code;
  if (code === 'ENOENT') return `找不到文件：${exe}`;
  if (code === 'EACCES' || code === 'EPERM') return '权限不足，尝试右键以管理员身份运行 GameHub 再启动';
  if (code === 'UNKNOWN') return '系统拒绝启动该程序（可能被杀软拦截）';
  return `启动失败：${(err && err.message) || '未知错误'}`;
}

module.exports = { Launcher, splitArgs };
