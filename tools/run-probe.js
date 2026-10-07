/**
 * 通用探针运行器（tools/run-probe.js）
 * ------------------------------------------------------------
 * 用法：node tools/run-probe.js <探针脚本文件> [结果落盘文件] [--packaged]
 *   例：node tools/run-probe.js tools/probe-mods-geom.js tmp-probe-mods.json
 *       node tools/run-probe.js tools/probe-mod-spread.js tmp-x.json --packaged
 *
 * 加 --packaged 就用 dist\win-unpacked\GameHub.exe 跑（验证打出来的东西），
 * 和 tools/probe-clear-run.js 的行为一致。
 *
 * 为什么不直接在命令行里 `--probe="$(cat xxx.js)"`：
 *   实测那么传会把脚本内容搞坏（渲染端报 "Script failed to execute"），
 *   换个文件就好。反正 spawnSync 传数组不会经过 shell，最省心。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const probeFile = process.argv[2];
if (!probeFile) {
  console.error('用法：node tools/run-probe.js <探针脚本文件> [结果落盘文件] [--packaged]');
  process.exit(1);
}
const outFile = process.argv[3] || path.join(root, 'tmp-probe.json');

// 用哪个 Electron：加 --packaged 就挑 win-unpacked 里的成品，否则用源码模式
const packaged = path.join(root, 'dist', 'win-unpacked', 'GameHub.exe');
const usePackaged = process.argv.includes('--packaged') && fs.existsSync(packaged);
const exe = usePackaged ? packaged : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const args = usePackaged ? [] : ['.'];
if (process.argv.includes('--packaged') && !usePackaged) {
  console.log('⚠ 没找到 ' + packaged + '，退回源码模式（先 npm run dist-dir）');
}

const probe = fs.readFileSync(path.isAbsolute(probeFile) ? probeFile : path.join(root, probeFile), 'utf8');

// ⚠ 环境里预设了 ELECTRON_RUN_AS_NODE，不清掉的话 Electron 会当成普通 Node 跑，窗口都开不出来
const env = { ...process.env, PROBE_OUT: outFile };
delete env.ELECTRON_RUN_AS_NODE;

/* ⚠⚠ `stdio` 必须是 'ignore'，不能让它走默认的 'pipe'。
 *   实测：默认管道下 spawnSync 直接返回 EBUSY，一个字节都拿不到，
 *   看起来像"脚本写错了"。原因大概是沙箱对子进程管道有拦截。
 *   代价是看不到子进程的 console —— 但探针本来就把结果写文件（PROBE_OUT），
 *   所以无所谓。tools/probe-clear-run.js 一直这么写，所以它没踩过。 */
const r = spawnSync(exe, args.concat(['--probe=' + probe]), {
  cwd: root, env, stdio: 'ignore'
});
if (r.error) console.log('✗ 起不来：' + r.error.message);

console.log('--- 探针结果（' + outFile + '）---');
try {
  console.log(fs.readFileSync(outFile, 'utf8'));
} catch (e) {
  console.log('（没读到结果文件：' + e.message + '）');
}
