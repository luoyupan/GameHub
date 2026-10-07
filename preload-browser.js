/**
 * ============================================================
 *  GameHub - 内置浏览器窗口专用的 preload  (preload-browser.js)
 * ------------------------------------------------------------
 *  ⚠ 这是给「不可信网页」用的，跟主界面的 preload.js **完全分开**。
 *
 *  为什么要分开：
 *    主界面那个 preload 暴露了几十个通道（读写游戏库、删文件、启动游戏……）。
 *    浏览器窗口里跑的是 N 网这种外部站点，如果共用同一个 preload，
 *    等于把那些能力摆在任何一个网页面前 —— 这是不能接受的。
 *
 *  所以这里只给浏览器窗口**真正需要的**那几个动作，多了不给：
 *    · 收一下初始地址与下载落点
 *    · 最小化 / 最大化 / 关闭
 *    · 用系统浏览器打开外链
 *    · 收下载进度
 *
 *  网页本身拿不到 ipcRenderer，也拿不到任何 Node 能力。
 * ============================================================
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('GHBrowser', {
  /** 主进程推来的初始信息（地址 / 标题 / 下载落点） */
  onInit: (cb) => {
    const h = (_e, info) => cb(info || {});
    ipcRenderer.on('browser:init', h);
    return () => ipcRenderer.removeListener('browser:init', h);
  },

  /** 下载落点变化时推送 */
  onDownloadTarget: (cb) => {
    const h = (_e, t) => cb(t || {});
    ipcRenderer.on('browser:download-target', h);
    return () => ipcRenderer.removeListener('browser:download-target', h);
  },

  /** 下载进度 */
  onDownload: (cb) => {
    const h = (_e, d) => cb(d || {});
    ipcRenderer.on('browser:download', h);
    return () => ipcRenderer.removeListener('browser:download', h);
  },

  /* ---- 窗口控制：只给这三个，别的（比如执行脚本）一律不暴露 ---- */
  minimize: () => ipcRenderer.invoke('browser:minimize'),
  maximize: () => ipcRenderer.invoke('browser:maximize'),
  close: () => ipcRenderer.invoke('browser:close'),

  /** 用系统浏览器打开（比如要登录外链、或者想去原站看） */
  openExternal: (url) => ipcRenderer.invoke('browser:openExternal', url)
});
