/**
 * ============================================================
 *  GameHub - 前端通用工具  (js/util.js)
 * ------------------------------------------------------------
 *  纯函数工具箱：DOM 快捷方法、格式化、颜色哈希、防抖。
 *  全局挂到 window.U 上供其它脚本使用。
 * ============================================================
 */
(function () {
  'use strict';

  /** 单元素选择 */
  const $ = (sel, root = document) => root.querySelector(sel);
  /** 多元素选择，返回真数组 */
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /**
   * 创建元素
   * @param {string} tag
   * @param {object} [attrs] 属性；class/text/html/dataset/style/on* 事件
   * @param {Array|string} [children]
   */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    const list = Array.isArray(children) ? children : children ? [children] : [];
    for (const c of list) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  /** HTML 转义（所有插入 innerHTML 的用户数据都必须过一遍） */
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------------- 格式化 ---------------- */

  /** 字节数 → 可读体积，例如 51.3 GB */
  function fmtBytes(b) {
    if (!b || b <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = Number(b);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    const digits = i >= 3 ? (n >= 100 ? 0 : 1) : i === 0 ? 0 : 1;
    return n.toFixed(digits) + ' ' + units[i];
  }

  /** 时间戳 → 2026-10-03 */
  function fmtDate(ts) {
    if (!ts) return '未知';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '未知';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 时间戳 → 2026-10-03 14:22 */
  function fmtDateTime(ts) {
    if (!ts) return '未知';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '未知';
    return `${fmtDate(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** 毫秒 → 3 小时 12 分 / 12 分钟 / 45 秒 */
  function fmtDuration(ms) {
    if (!ms || ms < 1000) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h >= 1) return `${h} 小时 ${m} 分`;
    if (m >= 1) return `${m} 分钟`;
    return `${s} 秒`;
  }

  /** 相对时间：刚刚 / 3 分钟前 / 昨天 / 5 天前 / 2026-01-02 */
  function fmtRelative(ts) {
    if (!ts) return '从未';
    const diff = Date.now() - Number(ts);
    if (diff < 0) return fmtDate(ts);
    const min = diff / 60000;
    if (min < 1) return '刚刚';
    if (min < 60) return `${Math.floor(min)} 分钟前`;
    const hr = min / 60;
    if (hr < 24) return `${Math.floor(hr)} 小时前`;
    const day = hr / 24;
    if (day < 2) return '昨天';
    if (day < 30) return `${Math.floor(day)} 天前`;
    return fmtDate(ts);
  }

  /* ---------------- 颜色 ---------------- */

  /**
   * 一组精心挑选的渐变色对。
   * 用作「没有封面图时的占位背景」，比随机 HSL 好看得多，
   * 也比统一灰色更有辨识度 —— 每款游戏的配色是稳定的（由名字哈希决定）。
   */
  const GRADIENTS = [
    ['#1e3a8a', '#0e7490'], ['#4c1d95', '#7c2d8a'], ['#7f1d1d', '#b45309'],
    ['#134e4a', '#0f766e'], ['#1e40af', '#6d28d9'], ['#831843', '#a21caf'],
    ['#0c4a6e', '#155e75'], ['#3f2d12', '#8a6d1f'], ['#1f2937', '#4b5563'],
    ['#312e81', '#0891b2'], ['#5b21b6', '#be185d'], ['#065f46', '#3f6212'],
    ['#7c2d12', '#9a3412'], ['#0f172a', '#334155'], ['#701a75', '#c026d3'],
    ['#164e63', '#2dd4bf']
  ];

  /** 字符串 → 稳定的 32 位哈希（FNV-1a 变体） */
  function hashStr(s) {
    let h = 2166136261;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** 由名字取一对渐变色 */
  function gradientOf(name) {
    return GRADIENTS[hashStr(name) % GRADIENTS.length];
  }

  /** 取名字的首字（中文取第一个字，英文取首字母） */
  function initialOf(name) {
    const s = String(name || '?').trim();
    const m = s.match(/[\u4e00-\u9fa5]/);
    if (m) return m[0];
    return (s[0] || '?').toUpperCase();
  }

  /** 把渐变色写成 CSS 变量，挂到元素 style 上 */
  function applyGradient(node, name) {
    const [a, b] = gradientOf(name);
    node.style.setProperty('--g1', a);
    node.style.setProperty('--g2', b);
    return node;
  }

  /* ---------------- 杂项 ---------------- */

  /** 防抖 */
  function debounce(fn, ms = 220) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
  }

  /** 延迟 */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 来源 → 显示信息 */
  const SOURCE_META = {
    steam: { label: 'Steam', cls: 'badge-steam', icon: '' },
    registry: { label: '注册表', cls: 'badge-registry', icon: '' },
    folder: { label: '文件夹', cls: 'badge-folder', icon: '' },
    epic: { label: 'Epic', cls: 'badge-epic', icon: '' },
    manual: { label: '手动', cls: 'badge-source', icon: '' }
  };
  function sourceMeta(src) {
    return SOURCE_META[src] || { label: src || '未知', cls: 'badge-source', icon: '' };
  }

  /** 截断长路径（保留头尾，中间省略），便于在卡片里显示 */
  function shortPath(p, max = 46) {
    const s = String(p || '');
    if (s.length <= max) return s;
    const head = Math.ceil((max - 3) * 0.6);
    const tail = Math.floor((max - 3) * 0.4);
    return s.slice(0, head) + '…' + s.slice(-tail);
  }

  /** 判断是否是「图标型」封面（方形图标，需要居中而不是铺满） */
  function isIconCover(game) {
    return game.coverKind === 'icon';
  }

  window.U = {
    $, $$, el, esc,
    fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtRelative,
    hashStr, gradientOf, initialOf, applyGradient,
    debounce, sleep, sourceMeta, shortPath, isIconCover,
    GRADIENTS
  };
})();
