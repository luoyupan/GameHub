/**
 * 全流程嗅探测试
 * 目的：① 确认扫描流程在受限环境下也不会抛异常
 *      ② 打印真实扫描结果，人工核对识别准确度
 */
const path = require('path');
const scanner = require(path.join(__dirname, '..', 'src', 'main', 'scanner'));

(async () => {
  const t0 = Date.now();
  const r = await scanner.sniffAll({
    include: { registry: true, steam: true, epic: true, folder: false },
    onProgress: (p) => process.stdout.write(`\r[${p.phase}] ${p.message}`.padEnd(78)),
    isCancelled: () => false
  });
  console.log('\n');
  console.log(`扫描未抛异常 ✓  候选数: ${r.length}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log('得分 | 来源   | 体积       | 安装日期   | 名称 / 分类');
  console.log('-'.repeat(106));
  for (const g of r) {
    const size = g.sizeBytes ? (g.sizeBytes / 1073741824).toFixed(2) + ' GB' : '   --   ';
    const date = g.installDate ? new Date(g.installDate).toISOString().slice(0, 10) : '  未知  ';
    console.log(
      `${String(g.confidence).padStart(3)}  | ${String(g.sourceLabel).padEnd(5)} | ${size.padStart(9)} | ${date} | ` +
      `${g.name.slice(0, 36).padEnd(36)} | ${g.categories.join('/')}`
    );
  }
  console.log('-'.repeat(106));
})().catch((e) => {
  console.error('扫描抛异常 ✗', e);
  process.exit(1);
});
