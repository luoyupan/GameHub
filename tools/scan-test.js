/**
 * 扫描模块的命令行自测脚本（纯 Node，不需要启动 Electron）
 * 用法： node tools/scan-test.js [要扫描的文件夹]
 */
const scanner = require('../src/main/scanner');

(async () => {
  const t0 = Date.now();
  const folder = process.argv[2];

  const opts = {
    folders: folder ? [{ path: folder, mode: 'smart' }] : [],
    include: { registry: true, steam: true, epic: true, folder: !!folder },
    onProgress: (p) => process.stdout.write(`\r[${p.phase}] ${p.message}`.padEnd(90)),
    isCancelled: () => false
  };

  const list = await scanner.sniffAll(opts);
  console.log('\n');
  console.log(`共发现候选：${list.length} 个，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('-'.repeat(100));

  for (const g of list.slice(0, 60)) {
    const size = g.sizeBytes ? (g.sizeBytes / 1073741824).toFixed(2) + ' GB' : '  --  ';
    const date = g.installDate ? new Date(g.installDate).toISOString().slice(0, 10) : '  --  ';
    console.log(
      `${String(g.confidence).padStart(2)}分 | ${g.sourceLabel.padEnd(4)} | ${size.padStart(9)} | ${date} | ${g.name.slice(0, 34).padEnd(34)} | ${g.categories.join('/')}`
    );
  }
  console.log('-'.repeat(100));
  const sources = {};
  for (const g of list) sources[g.sourceLabel] = (sources[g.sourceLabel] || 0) + 1;
  console.log('来源统计：', sources);
})();
