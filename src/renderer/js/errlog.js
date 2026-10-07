/**
 * ============================================================
 *  GameHub - 前端错误收集  (js/errlog.js)
 * ------------------------------------------------------------
 *  必须在所有其它脚本之前加载。
 *  把页面里发生的 JS 报错与未处理的 Promise 异常收集起来，
 *  自检模式（--selftest）会读取这个数组来判断界面是否正常工作。
 *
 *  注：之所以单独成文件而不是写在 HTML 的 <script> 里，
 *      是因为页面的 CSP 禁止内联脚本（安全加固）。
 * ============================================================
 */
window.__gamehubErrors = [];

window.addEventListener('error', (e) => {
  window.__gamehubErrors.push(
    String(e.message || 'unknown') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)
  );
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  window.__gamehubErrors.push('Promise: ' + String((reason && reason.message) || reason));
});
