/**
 * 真·截屏工具（开发期用）：把整个屏幕拍下来，存成 PNG。
 *
 * 为什么需要它：
 *   CDP 的 Page.captureScreenshot 只能拍「自己这个窗口的页面」，
 *   而"透出桌面"这件事的最终效果必须由 DWM 合成 ——
 *   它发生在窗口之外，页面截图根本拍不到，而且开着亚克力时抓表面还会卡住。
 *   所以只能把整块屏幕拍下来，才能看到窗口里到底有没有桌面。
 *
 * 用法（用 electron 直接跑这个文件，不是 node）：
 *   ./node_modules/electron/dist/electron.exe tools/screen-shot.js preview/桌面.png
 */
'use strict';

const { app, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join('preview', 'screen.png');

app.disableHardwareAcceleration();   // 本机 GPU 进程会崩，走软件渲染

app.whenReady().then(async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2560, height: 1440 }
    });
    if (!sources.length) throw new Error('没拿到任何屏幕源');

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    for (let i = 0; i < sources.length; i++) {
      const png = sources[i].thumbnail.toPNG();
      const p = sources.length > 1 ? OUT.replace(/\.png$/, `-${i}.png`) : OUT;
      fs.writeFileSync(p, png);
      console.log(`已保存 ${p}  (${sources[i].name})`);
    }
    process.exit(0);
  } catch (e) {
    console.error('截屏失败:', e.message);
    process.exit(1);
  }
});
