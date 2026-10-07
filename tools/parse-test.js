/**
 * 解析逻辑单元测试（不碰系统，纯字符串处理）
 * 用法： node tools/parse-test.js
 */
const assert = require('assert');
const path = require('path');
const scanner = require('../src/main/scanner');
const classify = require('../src/main/classify');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

console.log('\n[1] VDF 解析（Steam 配置格式）');
t('解析 libraryfolders.vdf', () => {
  const txt = `
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"apps"
		{
			"730"		"35000000000"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
	}
}`;
  const obj = scanner.parseVdf(txt);
  const lf = obj.libraryfolders;
  assert.strictEqual(lf['0'].path, 'C:\\Program Files (x86)\\Steam');
  assert.strictEqual(lf['1'].path, 'D:\\SteamLibrary');
  assert.strictEqual(lf['0'].apps['730'], '35000000000');
});

t('解析 appmanifest acf', () => {
  const txt = `
"AppState"
{
	"appid"		"1245620"
	"name"		"ELDEN RING"
	"installdir"		"ELDEN RING"
	"LastUpdated"		"1734567890"
	"SizeOnDisk"		"51380224000"
	"StateFlags"		"4"
}`;
  const s = scanner.parseVdf(txt).AppState;
  assert.strictEqual(s.name, 'ELDEN RING');
  assert.strictEqual(s.appid, '1245620');
  assert.strictEqual(Number(s.StateFlags), 4);
});

console.log('\n[2] .reg 文件解析（注册表导出格式）');
t('解析 REG_SZ / dword / 转义', () => {
  const txt = `Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 730]
"DisplayName"="Counter-Strike 2"
"InstallLocation"="D:\\\\SteamLibrary\\\\steamapps\\\\common\\\\Counter-Strike Global Offensive"
"Publisher"="Valve Corporation"
"DisplayVersion"="1.0"
"EstimatedSize"=dword:0820a1c0
"InstallDate"="20240315"
"Steam AppId"="730"

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++]
"DisplayName"="Notepad++ (64-bit x64)"
"Publisher"="Notepad++ Team"
"InstallLocation"="C:\\\\Program Files\\\\Notepad++"
"EstimatedSize"=dword:00003000
`;
  const list = scanner.parseRegFile(txt);
  assert.strictEqual(list.length, 2);
  const cs = list[0].values;
  assert.strictEqual(cs.DisplayName, 'Counter-Strike 2');
  assert.strictEqual(cs.InstallLocation, 'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive');
  assert.strictEqual(cs.EstimatedSize, 0x0820a1c0);
  assert.strictEqual(cs['Steam AppId'], '730');
  assert.strictEqual(cs.InstallDate, '20240315');
});

t('hex(2) 扩展字符串能解码成中文路径', () => {
  // "D:\游戏\xxx" 的 UTF-16LE 十六进制
  const str = 'D:\\游戏\\ABC';
  const hex = Buffer.from(str, 'utf16le').toString('hex').replace(/(..)/g, '$1,');
  const txt = `Windows Registry Editor Version 5.00\r\n\r\n[HKLM\\X]\r\n"InstallLocation"=hex(2):${hex}00,00,00,00\r\n`;
  const list = scanner.parseRegFile(txt);
  assert.strictEqual(list[0].values.InstallLocation, str);
});

console.log('\n[3] 分类识别');
t('黑神话：悟空 → 动作', () => assert.ok(classify.classify('黑神话悟空').includes('动作')));
t('Counter-Strike 2 → 射击', () => assert.ok(classify.classify('Counter-Strike 2').includes('射击')));
t('Stardew Valley → 模拟', () => assert.ok(classify.classify('Stardew Valley').includes('模拟')));
t('FIFA 24 → 体育', () => assert.ok(classify.classify('FIFA 24').includes('体育')));
t('Need for Speed → 竞速', () => assert.ok(classify.classify('Need for Speed Heat').includes('竞速')));
t('Minecraft → 沙盒', () => assert.ok(classify.classify('Minecraft').includes('沙盒')));
t('文明6 → 策略', () => assert.ok(classify.classify('文明6').includes('策略')));
t('无关键词 → 其他', () => assert.deepStrictEqual(classify.classify('Zxqwvbn'), ['其他']));
t('短词不会误伤（study 里不该出现塔防）', () => {
  assert.ok(!classify.classify('Study App').includes('塔防'));
});

console.log('\n[4] 注册表项"像不像游戏"打分');
t('Steam 游戏得高分', () => {
  const s = classify.scoreRegistryEntry({
    name: 'ELDEN RING', publisher: 'FromSoftware',
    installLocation: 'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING',
    sizeKB: 50000000, steamAppId: '1245620'
  });
  assert.ok(s.score >= 8, `score=${s.score}`);
});
t('Visual C++ 运行库被排除', () => {
  const entry = {
    name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
    publisher: 'Microsoft Corporation',
    installLocation: 'C:\\Program Files\\Microsoft Visual Studio\\...',
    sizeKB: 25000,
    exePath: '', steamAppId: ''
  };
  assert.ok(!classify.isGameCandidate(entry));
  assert.ok(classify.scoreRegistryEntry(entry).score < 2);
});
t('小型工具软件被排除', () => {
  const s = classify.scoreRegistryEntry({
    name: 'Notepad++ (64-bit x64)', publisher: 'Notepad++ Team',
    installLocation: 'C:\\Program Files\\Notepad++', sizeKB: 12000
  });
  assert.ok(s.score < 2, `score=${s.score}`);
});

console.log('\n[5] 主程序挑选启发式');
t('与目录同名的大 exe 胜出', () => {
  const r = classify.pickMainExe([
    { path: 'D:\\G\\EldenRing\\EldenRing.exe', name: 'EldenRing.exe', size: 220 * 1048576, depth: 1 },
    { path: 'D:\\G\\EldenRing\\unins000.exe', name: 'unins000.exe', size: 1.2 * 1048576, depth: 1 },
    { path: 'D:\\G\\EldenRing\\redist\\vc_redist.x64.exe', name: 'vc_redist.x64.exe', size: 24 * 1048576, depth: 2 }
  ], 'EldenRing');
  assert.strictEqual(path.basename(r.exe.path), 'EldenRing.exe');
});
t('排除崩溃处理器', () => {
  const r = classify.pickMainExe([
    { path: 'a\\Game.exe', name: 'Game.exe', size: 80 * 1048576, depth: 0 },
    { path: 'a\\UnityCrashHandler64.exe', name: 'UnityCrashHandler64.exe', size: 1 * 1048576, depth: 0 }
  ], 'MyGame');
  assert.strictEqual(r.exe.name, 'Game.exe');
});

console.log('\n[6] 目录名美化');
t('去掉版本号与后缀', () => {
  assert.strictEqual(scanner.prettyName('ELDEN_RING_v1.10'), 'ELDEN RING');
  assert.strictEqual(scanner.prettyName('MyGame_中文版'), 'MyGame');
  assert.strictEqual(scanner.prettyName('Half-Life'), 'Half-Life');
  assert.strictEqual(scanner.prettyName('Stardew Valley 1.6'), 'Stardew Valley');
});

console.log('\n[7] 去重合并');
t('Steam 与注册表重复项合并为一条', () => {
  const r = scanner.dedupe([
    { name: 'ELDEN RING', installDir: 'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING', confidence: 10, sizeBytes: 51380224000, steamAppId: '1245620', sourceLabel: 'Steam', installDate: 1734567890000, exePath: '' },
    { name: 'ELDEN RING', installDir: 'D:\\SteamLibrary\\steamapps\\common\\ELDEN RING', confidence: 4, sizeBytes: 0, steamAppId: '', sourceLabel: '注册表', installDate: 0, exePath: 'D:\\x\\eldenring.exe' }
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].sourceLabel, 'Steam');
  assert.strictEqual(r[0].exePath, 'D:\\x\\eldenring.exe', '缺失的 exePath 应被补齐');
});

t('同名游戏的中文名优先，英文名收进 altNames', () => {
  const r = scanner.dedupe([
    { name: 'Persona 5 Royal', installDir: 'I:\\steam\\steamapps\\common\\P5R', confidence: 10, sourceLabel: 'Steam' },
    { name: '女神异闻录5皇家版', installDir: 'I:\\steam\\steamapps\\common\\P5R', confidence: 4, sourceLabel: '注册表' }
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, '女神异闻录5皇家版', '应显示中文名');
  assert.ok((r[0].altNames || []).includes('Persona 5 Royal'), '英文名应保留为别名供搜索');
});

console.log('\n[8] 非游戏条目识别');
t('Steam 上的工具类条目被点名清理', () => {
  assert.ok(classify.isKnownNonGameTitle('Steamworks Common Redistributables'));
  assert.ok(classify.isKnownNonGameTitle('Wallpaper Engine'));
  assert.ok(classify.isKnownNonGameTitle('OBS Studio'));
  assert.ok(classify.isKnownNonGameTitle('Lossless Scaling'));
});
t('正常的游戏名不会被误伤', () => {
  assert.ok(!classify.isKnownNonGameTitle('ELDEN RING'));
  assert.ok(!classify.isKnownNonGameTitle('Wallpaper Engine Simulator 2026'));
  assert.ok(!classify.isKnownNonGameTitle('Cities: Skylines II'));
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
