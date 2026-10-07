/**
 * ============================================================
 *  GameHub - 弹窗系统  (js/modals.js)
 * ------------------------------------------------------------
 *  统一管理所有对话框：
 *    openModal()          通用弹窗容器
 *    scanResults()        扫描结果勾选导入（核心功能）
 *    settings()           设置面板
 *    addGame()            手动添加游戏
 *    editGame()           编辑游戏信息
 *    hiddenSetup()        隐藏空间：设置密码 / 解锁 / 管理
 *    confirmRemove()      移除确认
 * ============================================================
 */
(function () {
  'use strict';

  const U = window.U;
  const { el, fmtBytes, fmtDate, esc } = U;
  const API = window.API;

  let layer = null;
  let escHandler = null;
  let stack = [];
  /**
   * 弹窗级别的清理钩子。
   * 有些面板（比如设置里的「封面搜索」）会订阅主进程事件来画进度条，
   * 弹窗一关这些订阅就必须撤掉 —— 否则每次打开设置都会多留一个监听器，
   * 而且回调会往已经被遗弃的 DOM 节点上写数据。
   */
  let cleanups = [];

  function addCleanup(fn) { cleanups.push(fn); }
  function runCleanups() {
    for (const fn of cleanups) { try { fn(); } catch { /* 清理失败不影响关窗 */ } }
    cleanups = [];
  }

  /* ================================================================
   *  通用容器
   * ================================================================ */
  function openModal(opts = {}) {
    if (!layer) layer = U.$('#modalLayer');

    // 换一个新弹窗之前，先把上一个弹窗遗留的东西收拾干净
    runCleanups();

    const body = el('div', { class: 'modal-body' });
    const foot = el('div', { class: 'modal-foot' });

    const modal = el('div', { class: 'modal ' + (opts.size ? 'modal-' + opts.size : '') }, [
      el('div', { class: 'modal-head' }, [
        el('div', {}, [
          el('div', { class: 'modal-title', text: opts.title || '' }),
          opts.sub ? el('div', { class: 'modal-sub', text: opts.sub }) : null
        ]),
        el('button', { class: 'modal-close', text: '×', title: '关闭', onclick: closeModal })
      ]),
      body,
      foot
    ]);

    layer.innerHTML = '';
    layer.appendChild(modal);
    layer.hidden = false;

    if (opts.renderBody) opts.renderBody(body);
    if (opts.renderFoot) opts.renderFoot(foot);

    escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', escHandler);

    return { body, foot, modal };
  }

  function closeModal() {
    if (!layer) layer = U.$('#modalLayer');
    runCleanups();
    layer.hidden = true;
    layer.innerHTML = '';
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    stack = [];
  }

  /* ---------------- 表单小件 ---------------- */
  function formRow(label, control, desc) {
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'form-label', text: label }),
      control,
      desc ? el('div', { class: 'form-desc', text: desc }) : null
    ]);
  }

  function switchRow(title, desc, on, onChange) {
    const sw = el('div', { class: 'switch' + (on ? ' on' : '') });
    const row = el('div', {
      class: 'switch-row',
      style: { cursor: 'pointer' },
      onclick: () => {
        const next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        onChange(next);
      }
    }, [
      el('div', { class: 'switch-info' }, [
        el('div', { class: 'switch-title', text: title }),
        desc ? el('div', { class: 'switch-desc', text: desc }) : null
      ]),
      sw
    ]);
    return row;
  }

  /** 预设常用分类（含 R18） */
  const PRESET_CATEGORIES = [
    '动作', '射击', '角色扮演', '冒险', '策略', '模拟', '竞速', '体育', '恐怖',
    '独立', '休闲', '沙盒', '生存', '解谜', '多人联机', '单机', 'R18', '其他'
  ];

  /** R18 标签的统一判定（大小写不敏感） */
  function isR18Tag(name) {
    return String(name || '').trim().toUpperCase() === 'R18';
  }

  /**
   * 可编辑的分类标签组（一款游戏可以同时属于多个分类）。
   *   · 已选分类显示成 chip，点一下就移除
   *   · 输入框可以敲任意新分类名（自定义分类）
   *   · 下面是"库内已有分类 + 预设分类"，点一下就加，方便复用
   *   · 选中 R18 时给出明确提示：保存后会自动进隐藏空间
   * @returns {{node:HTMLElement, getValue:()=>string[], hasR18:()=>boolean}}
   */
  function categoryEditor(initial) {
    const values = new Set((initial || []).filter(Boolean));
    const wrap = el('div', { class: 'gr-tags', style: { gap: '6px', flexWrap: 'wrap', marginBottom: '8px' } });
    const hint = el('div', { class: 'form-desc r18-hint', hidden: true });

    const input = el('input', {
      class: 'input',
      style: { flex: '1 1 auto', maxWidth: '170px' },
      placeholder: '输入分类后回车',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value.trim();
          if (v) { values.add(v); input.value = ''; paint(); }
        }
      }
    });

    function hasR18() {
      return [...values].some(isR18Tag);
    }

    function paint() {
      wrap.innerHTML = '';
      for (const v of values) {
        wrap.appendChild(el('span', {
          class: 'chip chip-removable' + (isR18Tag(v) ? ' chip-r18' : ''),
          text: v + ' ×',
          title: isR18Tag(v) ? 'R18：保存后会自动放进隐藏空间（点击移除）' : '点击移除',
          onclick: () => { values.delete(v); paint(); }
        }));
      }
      wrap.appendChild(input);

      // R18 提示：把"会进隐藏空间"这件事说在前面，别让用户以为游戏丢了
      const enabled = window.State.hidden && window.State.hidden.enabled;
      hint.hidden = !hasR18();
      if (hasR18()) {
        hint.textContent = enabled
          ? '已选择 R18：保存后这款游戏会自动放进隐藏空间，在「隐藏空间」里输密码才能看到。'
          : '已选择 R18：需要先启用隐藏空间才能自动隐藏。保存时会引导你设置一个密码。';
      }
      paintSuggestions();
    }

    /** 可选分类：库内已有分类 + 预设 */
    const suggestBox = el('div', { class: 'gr-tags', style: { gap: '5px', flexWrap: 'wrap' } });
    function paintSuggestions() {
      suggestBox.innerHTML = '';
      const existing = (window.State.categories || []).map((c) => c.name);
      const raw = [...new Set([...existing, ...PRESET_CATEGORIES])]
        .filter((p) => p && !values.has(p));

      // 这里不要再截断数量了：早期版本写过 .slice(0, 16)，
      // 而 R18 在预设里排在倒数第二，结果被一刀切掉 —— 界面上永远看不到 R18，
      // "打了 R18 标签就自动进隐藏空间"这个功能等于没有入口。
      // 现在的策略是：R18 作为特殊标签永远置顶，其余全部照常列出（可换行，不做数量限制）。
      const r18 = raw.filter(isR18Tag);
      const rest = raw.filter((p) => !isR18Tag(p));
      const pool = [...r18, ...rest];

      if (!pool.length) {
        suggestBox.appendChild(el('span', { class: 'form-desc', text: '所有分类都已经选上了' }));
        return;
      }
      pool.forEach((p) => {
        suggestBox.appendChild(el('span', {
          class: 'chip' + (isR18Tag(p) ? ' chip-r18-suggest' : ''),
          style: { cursor: 'pointer', opacity: '0.7' },
          text: '+' + p,
          title: isR18Tag(p) ? 'R18：加入后会自动进隐藏空间' : '点击加入这个分类',
          onclick: () => { values.add(p); paint(); }
        }));
      });
    }

    paint();

    return {
      node: el('div', {}, [
        wrap,
        hint,
        el('div', { class: 'suggest-label', text: '点击添加分类（也可以直接输入新分类名）：' }),
        suggestBox
      ]),
      getValue: () => [...values],
      hasR18
    };
  }

  /* ================================================================
   *  ① 扫描结果选择器
   * ================================================================ */
  /**
   * 扫描结果勾选器（也是"自动添加"的确认步骤）。
   * @param {Array} list 候选列表
   * @param {{title?:string, sub?:string, back?:Function}} [opts]
   *        back = 传入后会多一个「← 返回」按钮，用来退回上一步
   */
  function scanResults(list, opts = {}) {
    if (!list || !list.length) {
      window.App.toast('没有发现新的游戏候选', 'warn');
      return;
    }

    // 默认勾选：高置信度 且 不在库中。
    // 但从"逐款自定义"退回这一步时要还原上次勾选的那批，不能打回默认值。
    const selected = new Set();
    if (opts.preselect && opts.preselect.length) {
      for (const g of list) if (!g.alreadyInLibrary && opts.preselect.includes(g.id)) selected.add(g.id);
    } else {
      for (const g of list) {
        if (!g.alreadyInLibrary && (g.confidence || 0) >= 5) selected.add(g.id);
      }
    }

    const host = { body: null, foot: null };
    const modalRef = openModal({
      title: opts.title || '扫描结果',
      sub: opts.sub || `共发现 ${list.length} 个候选，已为你预勾选 ${selected.size} 个。确认后导入游戏库。`,
      size: 'lg',
      renderBody: (b) => { host.body = b; paint(); },
      renderFoot: (f) => { host.foot = f; paintFoot(); }
    });

    function paint() {
      const b = host.body;
      if (!b) return;
      b.innerHTML = '';

      /* --- 工具条 --- */
      const countEl = el('span', { class: 'scan-count' });
      const updateCount = () => {
        countEl.innerHTML = `已选 <strong>${selected.size}</strong> / ${list.length}`;
      };

      const toolbar = el('div', { class: 'scan-toolbar' }, [
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '☑ 全选可导入',
          onclick: () => {
            for (const g of list) if (!g.alreadyInLibrary) selected.add(g.id);
            paint();
          }
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '★ 仅高置信度',
          onclick: () => {
            selected.clear();
            for (const g of list) if (!g.alreadyInLibrary && (g.confidence || 0) >= 7) selected.add(g.id);
            paint();
          }
        }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '☐ 清空', onclick: () => { selected.clear(); paint(); } }),
        el('span', { class: 'sep' }),
        countEl
      ]);
      b.appendChild(toolbar);
      updateCount();

      /* --- 分组渲染 --- */
      const groups = [
        { title: '强烈推荐（很确定是游戏）', items: list.filter((g) => (g.confidence || 0) >= 7) },
        { title: '可能相关（请自行确认）', items: list.filter((g) => (g.confidence || 0) < 7) }
      ];

      for (const grp of groups) {
        if (!grp.items.length) continue;
        b.appendChild(el('div', { class: 'scan-group-title', text: `${grp.title} · ${grp.items.length}` }));

        const wrap = el('div', { class: 'scan-list' });
        for (const g of grp.items) {
          const checked = selected.has(g.id);
          const disabled = !!g.alreadyInLibrary;

          const item = el('div', {
            class: 'scan-item' + (checked ? ' checked' : '') + (disabled ? ' disabled' : ''),
            onclick: () => {
              if (disabled) return;
              if (selected.has(g.id)) selected.delete(g.id); else selected.add(g.id);
              paint();
            }
          }, [
            el('div', { class: 'scan-check', text: '✓' }),
            el('div', { class: 'scan-info' }, [
              el('div', { class: 'scan-name' }, [
                g.name,
                disabled ? el('span', { class: 'chip', text: '已在库中' }) : null,
                (g.confidence || 0) >= 7 ? el('span', { class: 'chip', text: '高置信' }) : null
              ].filter(Boolean)),
              el('div', { class: 'scan-path', text: g.installDir || g.exePath || '（无路径）', title: g.installDir || g.exePath || '' })
            ]),
            el('div', { class: 'scan-side' }, [
              el('span', { class: 'badge ' + U.sourceMeta(g.source).cls, text: g.sourceLabel || U.sourceMeta(g.source).label }),
              el('span', { text: g.sizeBytes ? fmtBytes(g.sizeBytes) : '—' }),
              el('span', { text: g.installDate ? fmtDate(g.installDate) : '日期未知' })
            ])
          ]);
          wrap.appendChild(item);
        }
        b.appendChild(wrap);
      }
    }

    function paintFoot() {
      const f = host.foot;
      if (!f) return;
      f.innerHTML = '';
      // 从"自动添加"进来的话，多一个返回上一步的按钮
      if (opts.back) {
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '← 返回', title: '回到文件夹选择', onclick: opts.back }));
      }
      // 注意措辞：这一步只是勾选，点下一步才逐款确认，别写成"将导入"让人以为点了就入库
      f.appendChild(el('span', {
        class: 'scan-count',
        text: `已勾选 ${selected.size} 款 · 下一步可逐款修改`
      }));
      f.appendChild(el('span', { class: 'spacer' }));
      f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
      // 不再直接入库 —— 先跳到"逐款自定义"，让每一款都有自己的一页可以改
      f.appendChild(el('button', {
        class: 'btn btn-primary',
        text: '下一步：逐款自定义 →',
        title: '下一屏里每一款游戏各占一页，可以改名称 / 主程序 / 安装目录 / 分类',
        onclick: () => {
          const picked = list.filter((g) => selected.has(g.id));
          if (!picked.length) { window.App.toast('还没有勾选任何游戏', 'warn'); return; }
          customizeGames(picked, {
            // 返回时把刚才勾的那些带回去，别让用户重新勾一遍
            back: () => scanResults(list, { ...opts, preselect: picked.map((g) => g.id) })
          });
        }
      }));
    }
  }

  /* ================================================================
   *  ①-b 逐款自定义（勾选之后、真正入库之前的最后一屏）
   * ------------------------------------------------------------
   *  点「下一步：逐款自定义」进到这里：顶部一排页签，**每款游戏一个**，
   *  下面就是「手动添加」那张表单，但每一项都已经用扫描结果预填好了 ——
   *  名称、主程序、安装目录、分类都可以单独改。
   *
   *  改的是"草稿"，切页签不会丢；所有页都确认完再统一入库。
   * ================================================================ */
  function customizeGames(picked, opts = {}) {
    if (!picked || !picked.length) return;

    /** 每款一份草稿：表单改的是它，原始扫描结果留着做"还原"和"改没改过"的比对 */
    const drafts = picked.map((g) => ({
      src: g,
      name: g.name || '',
      exePath: g.exePath || '',
      installDir: g.installDir || '',
      categories: [...(g.categories || [])]
    }));

    let active = 0;
    const tabsBox = el('div', { class: 'cz-tabs' });
    const pageBox = el('div', { class: 'cz-page' });
    /** 切页签/入库前把当前页输入框里的值写回草稿（每次 paintPage 都会换一个新的） */
    let commitCurrent = () => {};
    /** 刷新左下角"共几款 / 已改几款"（页脚比正文后渲染，所以用变量桥一下） */
    let refreshFootCount = () => {};
    /** 刷新右下角「全部导入 (N)」上的数字（同上，页脚只渲染一次） */
    let refreshImportBtn = () => {};
    /** 刷新弹窗标题下那行"共 N 款"说明 */
    let refreshSub = () => {};

    openModal({
      title: '自动添加 · 逐款自定义',
      sub: subText(),
      size: 'lg',
      renderBody: (b) => {
        b.appendChild(tabsBox);
        b.appendChild(pageBox);
        paintTabs();
        paintPage();
      },
      renderFoot: (f) => {
        const countEl = el('span', { class: 'scan-count' });

        refreshFootCount = () => {
          const changed = drafts.filter(isDirty).length;
          countEl.innerHTML = `共 <strong>${drafts.length}</strong> 款`
            + (changed ? ` · 已修改 <strong>${changed}</strong> 款` : '');
        };

        f.appendChild(el('button', {
          class: 'btn btn-ghost', text: '← 返回',
          title: '回到勾选列表',
          onclick: () => { commitCurrent(); if (opts.back) opts.back(); }
        }));
        f.appendChild(countEl);
        refreshFootCount();
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));

        const importBtn = el('button', {
          class: 'btn btn-primary', text: `全部导入 (${drafts.length})`,
          onclick: async () => {
            commitCurrent();
            // 名称和路径总得有一个，不然后面没法启动
            const bad = drafts.findIndex((d) => !d.name.trim() && !d.exePath && !d.installDir);
            if (bad >= 0) {
              window.App.toast('有一款游戏既没有名称也没有路径，请先补上', 'warn');
              goTo(bad);
              return;
            }
            await importGames(drafts.map(toGame));
          }
        });
        refreshImportBtn = () => { importBtn.textContent = `全部导入 (${drafts.length})`; };
        f.appendChild(importBtn);

        refreshSub = () => {
          const sub = layer ? layer.querySelector('.modal-sub') : null;
          if (sub) sub.textContent = subText();
        };
        refreshSub();
      }
    });

    /** 弹窗标题下那句说明，数量会随着"取消某一款"变化 */
    function subText() {
      return `导入前先逐款确认，共 ${drafts.length} 款 · 可以改名称、主程序、安装目录和分类`;
    }

    /* ---------------- 草稿工具 ---------------- */

    /** 和扫描结果比，用户有没有动过这一款 */
    function isDirty(d) {
      const s = d.src;
      return d.name !== (s.name || '')
        || d.exePath !== (s.exePath || '')
        || d.installDir !== (s.installDir || '')
        || d.categories.join('\u0001') !== [...(s.categories || [])].join('\u0001');
    }

    /** 草稿 → 入库用的游戏对象 */
    function toGame(d) {
      return {
        ...d.src,
        name: d.name.trim() || d.src.name || '未命名游戏',
        exePath: d.exePath || '',
        installDir: d.installDir || '',
        // 分类被清空时不传，交给主进程按名称自动识别
        categories: d.categories.length ? d.categories : undefined
      };
    }

    function resetDraft(d) {
      d.name = d.src.name || '';
      d.exePath = d.src.exePath || '';
      d.installDir = d.src.installDir || '';
      d.categories = [...(d.src.categories || [])];
    }

    function goTo(i) {
      if (i === active || i < 0 || i >= drafts.length) return;
      commitCurrent();
      active = i;
      paintTabs();
      paintPage();
      refreshFootCount();
    }

    /**
     * 把某一款从"待导入"里取消掉（页签右上角那个 ×）。
     * ----------------------------------------------------------------
     *  这是用户进到最后一屏才后悔的出口，所以三件事必须一起做干净：
     *    ① drafts 和 picked 都要去掉 —— picked 是"返回勾选列表"时用来还原勾选的，
     *       只删 drafts 的话退回去会发现它又被勾上了（opts.back 里现取 picked）
     *    ② 页码要跟着挪：删的是前面那一款，当前页得往前一格才能停在原来那款上；
     *       删的就是当前页，则停在原地（自然落到后面那款），删最后一页就回退一格
     *    ③ 页脚计数 / 「全部导入 (N)」/ 标题下的"共 N 款"三处数字都要刷
     */
    function removeAt(i) {
      if (i < 0 || i >= drafts.length) return;
      const gone = drafts[i];
      const label = gone.name || gone.src.name || `第 ${i + 1} 款`;

      // 先把当前页输入框里的内容写回草稿（和切页签时一个道理），
      // 否则"改过但还没失焦"的那一款会在重绘后丢掉改动
      commitCurrent();

      drafts.splice(i, 1);
      // picked 和 drafts 是一一对应的，同步删掉，返回勾选列表时才是对的
      if (picked[i] && picked[i].id === gone.src.id) picked.splice(i, 1);
      else {
        const at = picked.findIndex((g) => g.id === gone.src.id);
        if (at >= 0) picked.splice(at, 1);
      }

      // 全取消光了 → 直接收工，没什么可导入的了
      if (!drafts.length) {
        closeModal();
        window.App.toast('已取消全部游戏，什么都没导入', 'info', 5000);
        return;
      }

      if (i < active) active -= 1;
      else if (i === active) active = Math.min(active, drafts.length - 1);

      // 旧页面那套"写回草稿"的闭包已经指向被删掉的对象了，先作废，等 paintPage 换新的
      commitCurrent = () => {};
      paintTabs();
      paintPage();
      refreshFootCount();
      refreshImportBtn();
      refreshSub();
      window.App.toast(`已取消导入「${label}」`, 'info', 4500);
    }

    /* ---------------- 顶部页签 ---------------- */
    function paintTabs() {
      tabsBox.innerHTML = '';
      drafts.forEach((d, i) => {
        const label = d.name || d.src.name || `第 ${i + 1} 款`;
        const tab = el('button', {
          class: 'cz-tab' + (i === active ? ' active' : '') + (isDirty(d) ? ' dirty' : ''),
          title: label + (d.installDir ? '\n' + d.installDir : ''),
          onclick: () => goTo(i)
        }, [
          el('span', { class: 'cz-tab-name', text: label }),
          el('span', { class: 'cz-tab-dot', title: '这一款改过了' }),
          el('span', {
            class: 'cz-tab-x',
            text: '×',
            title: `不导入「${label}」`,
            // ⚠ 必须阻止冒泡：这颗 × 是嵌在页签按钮里的，
            //   不拦的话点一下会先切到这一页、再把它删掉，视觉上像闪了一下。
            onclick: (e) => { e.stopPropagation(); removeAt(i); }
          })
        ]);
        tabsBox.appendChild(tab);
      });
      // 页签多了要能横向滚，切页时把当前那个滚进可视区
      const act = tabsBox.children[active];
      if (act && act.scrollIntoView) {
        try { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* 老版本不支持就算了 */ }
      }
    }

    /** 只更新"当前页签"的标题和改动标记，不用整个重画（重画会打断输入焦点） */
    function refreshActiveTab() {
      const d = drafts[active];
      const tab = tabsBox.children[active];
      if (!tab) return;
      const nameEl = tab.querySelector('.cz-tab-name');
      if (nameEl) nameEl.textContent = d.name || d.src.name || `第 ${active + 1} 款`;
      tab.classList.toggle('dirty', isDirty(d));
      refreshFootCount();
    }

    /* ---------------- 每一款的表单 ---------------- */
    function paintPage() {
      pageBox.innerHTML = '';
      const d = drafts[active];

      /* --- 只读的扫描信息 --- */
      pageBox.appendChild(el('div', { class: 'cz-meta' }, [
        el('span', { class: 'cz-index', text: `第 ${active + 1} / ${drafts.length} 款` }),
        el('span', { class: 'badge ' + U.sourceMeta(d.src.source).cls, text: d.src.sourceLabel || U.sourceMeta(d.src.source).label }),
        el('span', { text: d.src.sizeBytes ? fmtBytes(d.src.sizeBytes) : '体积未知' }),
        el('span', { text: d.src.installDate ? fmtDate(d.src.installDate) : '日期未知' }),
        el('span', { class: 'chip', text: (d.src.confidence || 0) >= 7 ? '高置信' : '请自行确认' }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '↺ 还原为扫描结果',
          title: '把这一款改回扫描刚发现时的样子',
          onclick: () => { resetDraft(d); paintTabs(); paintPage(); }
        })
      ]));

      /* --- 可编辑的表单（和「手动添加」一致） --- */
      const nameInput = el('input', { class: 'input', value: d.name, placeholder: '例如：艾尔登法环' });
      const exeInput = el('input', { class: 'input mono', value: d.exePath, placeholder: '未选择（可以留空，之后在详情里补）' });
      const dirInput = el('input', { class: 'input mono', value: d.installDir, placeholder: '未选择' });
      const catEditor = categoryEditor(d.categories);

      // 输入时立刻写回草稿，页签上的"改过了"小圆点才能实时亮起来
      const onEdit = () => { commitCurrent(); refreshActiveTab(); };
      nameInput.addEventListener('input', onEdit);

      commitCurrent = () => {
        d.name = nameInput.value.trim();
        d.exePath = exeInput.value;
        d.installDir = dirInput.value;
        d.categories = catEditor.getValue();
      };

      pageBox.appendChild(formRow('游戏名称', nameInput, '留空的话会用主程序所在的文件夹名。'));
      pageBox.appendChild(formRow('主程序 (.exe)', el('div', { class: 'form-inline' }, [
        exeInput,
        el('button', {
          class: 'btn btn-ghost', text: '选择…',
          onclick: async () => {
            const p = await API.pickExe();
            if (!p || p.ok === false) return;
            d.exePath = p;
            exeInput.value = p;
            // 选了主程序就顺手把安装目录也填上，省得再点一次
            if (!dirInput.value) {
              d.installDir = p.replace(/[\\/][^\\/]+$/, '');
              dirInput.value = d.installDir;
            }
            if (!nameInput.value) {
              const base = String(d.installDir).split(/[\\/]/).filter(Boolean).pop() || '';
              d.name = base.replace(/[_]+/g, ' ').trim();
              nameInput.value = d.name;
            }
            refreshActiveTab();
          }
        })
      ]), '也可以选择 launcher.bat 之类的启动脚本。'));
      pageBox.appendChild(formRow('安装目录', el('div', { class: 'form-inline' }, [
        dirInput,
        el('button', {
          class: 'btn btn-ghost', text: '选择…',
          onclick: async () => {
            const p = await API.pickFolder();
            if (!p || p.ok === false) return;
            d.installDir = p;
            dirInput.value = p;
            refreshActiveTab();
          }
        })
      ])));
      pageBox.appendChild(formRow('分类', catEditor.node, '留空会自动按名称识别。'));
      pageBox.appendChild(el('div', { class: 'form-desc', text: '提示：全部确认完之后点右下角的「全部导入」一次性入库；导入后还可以在游戏详情页里换封面、补发行商和版本。' }));

      // 页签栏跟着当前这一款的名字/改动状态刷新
      refreshActiveTab();
    }
  }

  /**
   * 真正入库 —— 扫描勾选和逐款自定义两条路都走这里，保证行为一致。
   * @param {Array} list 要入库的游戏对象
   */
  async function importGames(list) {
    const r = await API.addMany(list);
    if (!(r && r.ok !== false)) {
      window.App.toast((r && r.error) || '导入失败', 'error');
      return false;
    }
    closeModal();
    await window.App.refresh();
    window.App.toast(`成功导入 ${r.added} 款游戏${r.skipped ? `，跳过 ${r.skipped} 个重复项` : ''}`, 'success');
    // R18 → 主进程已尝试自动隐藏，这里给出反馈（没启用隐藏空间就引导去设置）
    handleR18Feedback(r.r18);
    // 导入后自动补封面：设置开了「联网自动补封面」就先联网搜一轮官方封面，
    // 剩下仍然没图的再退化成 exe 图标。两步都可能被用户中途取消 / 网络不通，
    // 所以每一步都单独 try，别让封面这种小事把"游戏已经导进来了"的反馈吞掉。
    const hasNoCover = window.State.games.filter((x) => !x.coverUrl);
    if (hasNoCover.length) {
      if ((window.State.settings || {}).autoSearchCoverOnline !== false) {
        try { await window.App.runSearchMissingCovers({ silent: true }); } catch { /* 联网失败就走图标兜底 */ }
      }
      const still = window.State.games.filter((x) => !x.coverUrl);
      if (still.length) {
        await API.coverExtractAll();
        await window.App.refresh();
      }
    }
    return true;
  }

  /* ================================================================
   *  ② 设置面板
   * ----------------------------------------------------------------
   *  分区：外观与卡片 → 封面联网搜索 → 游戏嗅探 → 游戏平台 → 统计
   *        → 隐藏空间 → 数据
   *
   *  约定：每一项都必须真的读得到自己的值、改完立刻生效，
   *        不允许出现"能点但不影响任何地方"的摆设开关。
   * ================================================================ */
  async function settings() {
    const s = { ...window.State.settings };
    const folders = [...(s.scanFolders || [])];

    const ref = openModal({
      title: '设置',
      sub: '外观、嗅探、封面联网搜索，都可以按你的习惯调',
      size: 'md',
      renderBody: (b) => paintBody(b),
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '关闭', onclick: closeModal }));
      }
    });

    async function save(patch) {
      Object.assign(s, patch);
      await API.settingsSet(patch);
      window.State.settings = { ...window.State.settings, ...patch };
    }

    /** 读布尔偏好（老数据没有这个字段时按 def 走） */
    function pref(key, def = true) {
      if (s[key] === undefined || s[key] === null) return def;
      return !!s[key];
    }

    /**
     * 改一组"会重绘界面"的偏好，并同步顶栏控件。
     * 顶栏那几个按钮的 active 状态是 app.js 管的，这里改完必须手动对齐，
     * 否则设置里选了列表视图、回去一看顶栏还亮着封面墙。
     */
    async function saveView(patch) {
      await save(patch);
      if (patch.viewMode) {
        window.State.viewMode = patch.viewMode;
        U.$$('#viewToggle .vt-btn').forEach((x) => x.classList.toggle('active', x.dataset.mode === patch.viewMode));
      }
      if (patch.cardSize) {
        window.State.cardSize = patch.cardSize;
        U.$$('#sizeToggle .sz-btn').forEach((x) => x.classList.toggle('active', x.dataset.size === patch.cardSize));
      }
      if (patch.sortBy) window.State.sort = `${patch.sortBy}:${patch.sortAsc ? 'asc' : 'desc'}`;
      window.App.renderContent();
    }

    /** 分段选择器：value → label，当前值用 on 判断 */
    function segRow(label, options, isActive, onPick, desc) {
      return formRow(label, el('div', { class: 'seg' }, options.map((o) =>
        el('button', {
          class: 'seg-btn' + (isActive(o.value) ? ' active' : ''),
          text: o.label,
          onclick: () => onPick(o.value)
        })
      )), desc);
    }

    /** 数字兜底：不是有限数就用默认值 */
    function numOr(v, def) {
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    }

    /**
     * 滑块行。
     * 拖动过程（input）只做实时预览，松手（change）才写盘 ——
     * 否则一路拖下去会往磁盘写几十次设置。
     * @param {string} label
     * @param {number} value 当前值
     * @param {number} min
     * @param {number} max
     * @param {number} step
     * @param {(v:number)=>string} fmt 数值显示格式
     * @param {(v:number, commit:boolean)=>void} onInput
     * @param {string} [hint] 制下方的说明文字
     */
    function rangeRow(label, value, min, max, step, fmt, onInput, hint) {
      const valEl = el('span', { class: 'rv', text: fmt(value) });
      const input = el('input', {
        class: 'gh-range',
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value)
      });
      const fire = (commit) => {
        const v = Number(input.value);
        valEl.textContent = fmt(v);
        onInput(v, commit);
      };
      input.addEventListener('input', () => fire(false));
      input.addEventListener('change', () => fire(true));
      return el('div', { class: 'range-row' }, [
        el('div', { class: 'range-head' }, [
          el('span', { class: 'rl', text: label }),
          valEl
        ]),
        input,
        hint ? el('div', { class: 'range-hint', text: hint }) : null
      ]);
    }

    // 注意：这里必须是 async —— 下面要 await 取数据目录等信息
    async function paintBody(b) {
      b.innerHTML = '';

      /* ========================================================
       *  外观与卡片
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '外观与卡片' }));

      b.appendChild(segRow('主题',
        [{ value: 'dark', label: '深色（Steam 风）' }, { value: 'light', label: '浅色' }],
        (v) => (s.theme || 'dark') === v,
        (v) => { save({ theme: v }); window.App.setTheme(v); paintBody(b); }
      ));

      b.appendChild(segRow('默认视图',
        [{ value: 'grid', label: '封面墙' }, { value: 'list', label: '列表' }],
        (v) => (s.viewMode || 'grid') === v,
        (v) => { saveView({ viewMode: v }); paintBody(b); }
      ));

      b.appendChild(segRow('封面尺寸',
        [{ value: 'small', label: '小' }, { value: 'medium', label: '中' },
         { value: 'large', label: '大' }, { value: 'huge', label: '超大' }],
        (v) => (s.cardSize || 'medium') === v,
        (v) => { saveView({ cardSize: v }); paintBody(b); },
        '决定游戏卡片在封面墙里的大小，列表视图不受影响。'
      ));

      b.appendChild(switchRow(
        '卡片显示成就角标',
        '在卡片右下角显示 🏆 已完成/总数。数据来自本机 Steam 缓存的成就数据，不联网、不上传；拿不到数据就不显示，不会画 0/0。',
        pref('cardAchievements'),
        (v) => { save({ cardAchievements: v }); window.App.renderContent(); }
      ));

      b.appendChild(switchRow(
        '空间不够时滚动显示完整名字',
        '右下角放不下成就角标时，鼠标悬停卡片会把「完整游戏名 + 成就数」横向滚出来。关掉的话成就角标改为常驻显示。',
        pref('cardNameMarquee'),
        (v) => { save({ cardNameMarquee: v }); window.App.renderContent(); }
      ));

      b.appendChild(switchRow(
        '悬停时显示「▶ 启动」按钮',
        '鼠标移到封面上会浮出一个启动按钮；关掉就只能双击 / 右键启动了。',
        pref('cardHoverPlay'),
        (v) => { save({ cardHoverPlay: v }); window.App.renderContent(); }
      ));

      /* ========================================================
       *  背景与材质（左侧栏 / 右侧内容区 分别设置）
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '背景与材质', style: { marginTop: '22px' } }));

      /* ---- 透出桌面：这一项是窗口级的，不属于某一栏，所以单独摆在最前 ---- */
      const dmSupport = await API.desktopMaterialSupport();
      const dmOk = !!(dmSupport && dmSupport.supported);

      b.appendChild(segRow('透出桌面（窗口材质）',
        [
          { value: 'auto', label: '自动' },
          { value: 'off', label: '不透' },
          { value: 'acrylic', label: '亚克力' },
          { value: 'mica', label: '云母' }
        ],
        (v) => (s.desktopMaterial || 'auto') === v,
        async (v) => {
          if (!dmOk) {
            window.App.toast((dmSupport && dmSupport.reason) || '当前系统不支持', 'warn', 5000);
            return;
          }
          const r = await API.setDesktopMaterial(v);
          if (r && r.ok === false) {
            window.App.toast(r.error || '设置窗口材质失败', 'error');
            return;
          }
          s.desktopMaterial = v;
          // 主进程算完会把最终值推回来（自动模式下它可能和 v 不一样），
          // 这里先按本地规则刷一次，让界面立刻有反馈
          window.Bg.applyDesktop(window.Bg.resolveDesktop(s));
          paintBody(b);   // 重画一遍，让选中态对上
        },
        dmOk
          ? '让窗口改用 Windows 11 的系统材质，真的透出桌面。' +
            '「自动」（推荐）：左右任一一栏选了磨砂 / 亚克力 / 玻璃 / 液态玻璃，' +
            '窗口就自动透出桌面；换成图片或纯色底就自动收回。' +
            '想一直透就固定选亚克力（模糊重）或云母（偏沉稳），想完全不透选「不透」。' +
            '注意：页面里的模糊只看得到页面内的东西，必须由系统合成才透得出桌面，' +
            '所以这一项只有 Windows 11 支持。'
          : `当前系统不支持：${(dmSupport && dmSupport.reason) || '未知原因'}`
      ));

      // 两栏的配置项完全一样，用标签切换着编辑，免得设置面板拉得老长
      const bgSlot = { cur: 'sidebar' };
      // 老数据可能没有 bg 字段，先补齐结构
      if (!s.bg) s.bg = {};
      for (const k of ['sidebar', 'content']) {
        if (!s.bg[k]) s.bg[k] = {};
      }

      /**
       * 保存背景设置。
       * ⚠ 这里不能直接用 save()：它对本地的 s 是浅合并，
       *   save({bg:{sidebar:{...}}}) 会把整个 s.bg 换成只有 sidebar 的对象，
       *   另一栏的配置就丢了。所以按栏位深合并后再存。
       */
      async function saveBg(slot, patch) {
        s.bg[slot] = { ...s.bg[slot], ...patch };
        await API.settingsSet({ bg: { [slot]: patch } });
        window.State.settings = { ...window.State.settings, bg: s.bg };
        // 换了「材质」或「类型」可能改变"要不要透出桌面"
        // （自动模式下玻璃系材质会让窗口透出来）。
        // 主进程会推最终值过来，这里先按本地规则刷一次，让界面立刻跟上。
        if (patch && (patch.type !== undefined || patch.material !== undefined)) {
          window.Bg.applyDesktop(window.Bg.resolveDesktop(s));
        }
      }

      /** 只把某一栏的背景刷到界面上（调滑块时实时预览用） */
      function previewSlot(slot) {
        if (window.Bg) window.Bg.applySlot(slot, s.bg[slot]);
      }

      const bgHost = el('div', {});
      b.appendChild(bgHost);

      function paintBg() {
        bgHost.innerHTML = '';
        const slot = bgSlot.cur;
        const cfg = s.bg[slot];

        bgHost.appendChild(segRow('要设置哪一栏',
          [{ value: 'sidebar', label: '左侧栏' }, { value: 'content', label: '右侧内容区' }],
          (v) => bgSlot.cur === v,
          (v) => { bgSlot.cur = v; paintBg(); },
          '两栏互不影响 —— 可以一个放图片、另一个用材质。'
        ));

        bgHost.appendChild(segRow('背景类型',
          [
            { value: 'default', label: '跟随主题' },
            { value: 'image', label: '自定义图片' },
            { value: 'material', label: '材质质感' }
          ],
          (v) => (cfg.type || 'default') === v,
          async (v) => {
            await saveBg(slot, { type: v });
            previewSlot(slot);
            paintBg();
          }
        ));

        /* ---------------- 图片模式 ---------------- */
        if (cfg.type === 'image') {
          const cur = (window.Bg && window.Bg.getUrls()[slot]) || '';

          bgHost.appendChild(el('div', {
            class: 'bg-preview' + (cur ? '' : ' is-empty'),
            style: cur ? { backgroundImage: `url("${cur}")` } : {}
          }, cur ? [] : ['还没有选择图片']));

          bgHost.appendChild(el('div', { class: 'bg-preview-actions' }, [
            el('button', {
              class: 'btn btn-primary btn-sm',
              text: cur ? '换一张图片' : '选择图片',
              onclick: async () => {
                const r = await API.appearanceSetImage({ slot });
                if (r && r.ok) {
                  if (window.Bg) window.Bg.setUrl(slot, r.url);
                  s.bg[slot].image = r.rel;
                  previewSlot(slot);
                  window.App.toast('背景图已更新', 'success');
                  paintBg();
                } else if (r && !r.canceled) {
                  window.App.toast((r && r.error) || '设置背景图失败', 'error');
                }
              }
            }),
            cur ? el('button', {
              class: 'btn btn-ghost btn-sm',
              text: '清除图片',
              onclick: async () => {
                await API.appearanceClearImage({ slot });
                if (window.Bg) window.Bg.setUrl(slot, '');
                s.bg[slot].image = '';
                s.bg[slot].type = 'default';
                previewSlot(slot);
                paintBg();
              }
            }) : null
          ]));

          bgHost.appendChild(rangeRow('图片不透明度', numOr(cfg.opacity, 0.55), 0.05, 1, 0.05,
            (v) => Math.round(v * 100) + '%',
            (v, commit) => {
              s.bg[slot].opacity = v;
              previewSlot(slot);
              if (commit) saveBg(slot, { opacity: v });
            },
            '调低一点，图片往后退，界面文字更好读。'
          ));

          bgHost.appendChild(rangeRow('模糊程度', numOr(cfg.blur, 0), 0, 30, 1,
            (v) => (v ? v + ' px' : '不模糊'),
            (v, commit) => {
              s.bg[slot].blur = v;
              previewSlot(slot);
              if (commit) saveBg(slot, { blur: v });
            },
            '轻微模糊能柔化画面，也避免图片里的细节抢注意力。'
          ));

          bgHost.appendChild(rangeRow('压暗程度', numOr(cfg.dim, 0.35), 0, 0.85, 0.05,
            (v) => Math.round(v * 100) + '%',
            (v, commit) => {
              s.bg[slot].dim = v;
              previewSlot(slot);
              if (commit) saveBg(slot, { dim: v });
            },
            '在图片上盖一层半透明遮罩，保证任何图片下文字都看得清。'
          ));

          bgHost.appendChild(segRow('图片填充方式',
            [
              { value: 'cover', label: '铺满' },
              { value: 'contain', label: '完整显示' },
              { value: 'tile', label: '平铺' },
              { value: 'center', label: '原始大小' }
            ],
            (v) => (cfg.fit || 'cover') === v,
            async (v) => {
              await saveBg(slot, { fit: v });
              previewSlot(slot);
              paintBg();
            },
            '铺满会裁掉多余部分；完整显示会留出空白；平铺适合无缝纹理图。'
          ));
        }

        /* ---------------- 材质模式 ---------------- */
        if (cfg.type === 'material') {
          bgHost.appendChild(segRow('材质类型',
            [
              { value: 'frosted', label: '磨砂玻璃' },
              { value: 'acrylic', label: '亚克力' },
              { value: 'glass', label: '玻璃' },
              { value: 'liquid', label: '液态玻璃' }
            ],
            (v) => (cfg.material || 'frosted') === v,
            async (v) => {
              await saveBg(slot, { material: v });
              previewSlot(slot);
              paintBg();
            },
            '磨砂最厚重、亚克力通透带颗粒感、玻璃清透有厚度、' +
            '液态玻璃靠高光和体积感撑起来（像一滴凝固的液体）。' +
            '启用材质后窗口会铺一层氛围光，材质透过去才有层次。'
          ));
        }
      }

      paintBg();

      /* ========================================================
       *  字体
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '字体', style: { marginTop: '22px' } }));

      const fontSel = el('select', { class: 'input' },
        [el('option', { value: '', text: '默认（跟随系统）' })]);
      const fontInput = el('input', {
        class: 'input',
        type: 'text',
        placeholder: '或直接输入字体名',
        value: s.fontFamily || ''
      });

      // 字体列表由主进程读注册表拿到；拿不到就只剩「默认」一项，不影响使用
      (async () => {
        const r = await API.appearanceFonts();
        const list = (r && r.ok !== false && Array.isArray(r.fonts)) ? r.fonts : [];
        for (const f of list) {
          fontSel.appendChild(el('option', { value: f, text: f }));
        }
        // 当前字体不在列表里（手输的），补一项进去，免得下拉显示空白
        if (s.fontFamily && !list.includes(s.fontFamily)) {
          fontSel.appendChild(el('option', { value: s.fontFamily, text: s.fontFamily + '（自定义）' }));
        }
        fontSel.value = s.fontFamily || '';
      })();

      const fontPreview = el('div', { class: 'font-preview' }, [
        el('div', { class: 'fp-big', text: '游戏库 GameHub' }),
        el('div', { class: 'fp-sub', text: '这是当前字体与字号的实际效果。' })
      ]);

      function paintFontPreview() {
        const clean = String(s.fontFamily || '').replace(/["']/g, '').trim();
        fontPreview.style.fontFamily = clean
          ? (/[,\s]/.test(clean) ? `"${clean}"` : clean) + ', "Microsoft YaHei UI", system-ui, sans-serif'
          : '';
        fontPreview.style.fontSize = numOr(s.fontSize, 13.5) + 'px';
      }

      async function commitFont(v) {
        s.fontFamily = v;
        fontSel.value = listHasFont(v) ? v : '';
        fontInput.value = v;
        if (window.Bg) window.Bg.applyFont(s);
        paintFontPreview();
        await save({ fontFamily: v });
      }

      /** 下拉里有没有这个字体（决定要不要把它回填到 select） */
      function listHasFont(v) {
        return [...fontSel.options].some((o) => o.value === v);
      }

      fontSel.addEventListener('change', () => commitFont(fontSel.value));
      fontInput.addEventListener('change', () => commitFont(fontInput.value.trim()));

      b.appendChild(formRow('界面字体',
        el('div', { class: 'font-picker' }, [fontSel, fontInput]),
        '下拉里是本机已安装的字体。也可以直接输入字体名（比如 思源黑体、HarmonyOS Sans SC）。留空用默认字体。'
      ));

      b.appendChild(rangeRow('界面字号', numOr(s.fontSize, 13.5), 11, 16, 0.5,
        (v) => v + ' px',
        (v, commit) => {
          s.fontSize = v;
          if (window.Bg) window.Bg.applyFont(s);
          paintFontPreview();
          if (commit) save({ fontSize: v });
        },
        '文字和它周围的内边距会一起协调变化。觉得界面拥挤就调小一点。'
      ));

      b.appendChild(fontPreview);
      paintFontPreview();

      /* ========================================================
       *  封面与联网搜索
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '封面与联网搜索', style: { marginTop: '22px' } }));

      b.appendChild(switchRow(
        '联网自动补封面',
        '打开 GameHub、或导入新游戏之后，自动给「没有封面」的游戏联网搜索封面。搜不到的会静默跳过，不会报错打扰你。',
        pref('autoSearchCoverOnline'),
        (v) => save({ autoSearchCoverOnline: v })
      ));

      b.appendChild(switchRow(
        '把程序图标也升级成官方封面',
        '补封面时，连「只有 exe 图标」的游戏也一并换成官方竖版封面。关掉的话只处理一张图都没有的游戏。',
        pref('coverUpgradeIcon', false),
        (v) => { save({ coverUpgradeIcon: v }); paintCoverStats(); }
      ));

      b.appendChild(segRow('名称匹配严格度',
        [{ value: 'loose', label: '宽松' }, { value: 'normal', label: '标准' }, { value: 'strict', label: '严格' }],
        (v) => (s.coverMatchLevel || 'normal') === v,
        (v) => { save({ coverMatchLevel: v }); paintBody(b); },
        '联网搜索时按名字对不上就跳过。宽松命中率高但偶尔会贴错图，严格宁可搜不到也不贴错。'
      ));

      /* ---- 缺封面统计 + 立即执行的按钮 + 进度条 ---- */
      const coverStats = el('div', { class: 'form-desc' });
      const cpText = el('div', { class: 'cp-text' });
      const cpFill = el('div', { class: 'cp-fill' });
      const cpBar = el('div', { class: 'cp-bar', hidden: true }, [cpFill]);
      const runBtn = el('button', {
        class: 'btn btn-primary',
        text: '🌐 立即联网搜索封面',
        onclick: () => doSearchMissing(b)
      });
      // 点「停止」只负责通知主进程中止；按钮状态由 doSearchMissing 拿到
      // 结果之后统一切 —— 这里要是抢着把超时界面恢复，用户会在任务还没真的停下时
      // 再点一次「立即搜索」，结果只会撞上"已有任务在进行中"。
      const stopBtn = el('button', {
        class: 'btn btn-ghost',
        text: '停止',
        hidden: true,
        onclick: async () => { await API.coverCancel(); cpText.textContent = '正在停止…（已拿到的封面会保留）'; }
      });

      function countMissing() {
        const upgrade = pref('coverUpgradeIcon', false);
        return window.State.games.filter((g) => {
          if (g.coverKind === 'custom' && g.coverPath) return false;
          if (!g.coverPath) return true;
          return upgrade && g.coverKind === 'icon';
        }).length;
      }

      function paintCoverStats() {
        const n = countMissing();
        coverStats.textContent = n
          ? `当前有 ${n} 款游戏缺封面${pref('coverUpgradeIcon', false) ? '（含只有程序图标的）' : ''}。搜索来源：Steam 官方图床，需要联网。`
          : '所有游戏都有封面了，暂时不需要联网搜索。';
        runBtn.disabled = !n;
      }

      /** 切换封面任务面板的「进行中 / 空闲」状态 */
      function setCoverRunning(running, text) {
        runBtn.hidden = running;
        stopBtn.hidden = !running;
        cpBar.hidden = !running;
        coverStats.hidden = running;
        if (!running) { cpFill.style.width = '0%'; paintCoverStats(); }
        // 空串也要写进去 —— 否则上一次任务遗留的进度文案会一直挂在面板上
        cpText.textContent = text || '';
      }

      // 订阅封面搜索进度：设置面板一关就自动退订
      // ⚠ 用 cpText 判活：分段的 seg 按钮一点就会 paintBody 重画整块，
      //   那时手里的 cp* 节点已被丢弃，往它们身上写数据是白写还可能报错。
      const offCover = window.GameHub.on('cover:progress', (p) => {
        if (!p || !cpText.isConnected) return;
        if (p.total && p.current) cpFill.style.width = Math.min(100, Math.round((p.current / p.total) * 100)) + '%';
        cpText.textContent = p.message || `搜索中：${p.name || ''}`;
      });
      addCleanup(offCover);

      paintCoverStats();

      /**
       * 点「立即联网搜索封面」：
       * 直接复用 app.js 里那个批处理方法（更多选项里也是它），只是这里
       * 要在切换按钮状态，好让用户看得见进度、也能中途停掉。
       */
      async function doSearchMissing(box) {
        setCoverRunning(true, `正在联网搜索封面…`);
        cpFill.style.width = '0%';
        try {
          const r = await window.App.runSearchMissingCovers({ includeIcon: pref('coverUpgradeIcon', false) });
          if (r === null) setCoverRunning(false, '');
          else if (r.cancelled) setCoverRunning(false, '已停止搜索。');
          else setCoverRunning(false, r.fetched ? `完成：补上了 ${r.fetched} 款封面。` : '结束：这些游戏都没搜到封面，已全部跳过。');
        } catch (e) {
          setCoverRunning(false, '搜索出错：' + ((e && e.message) || e));
        }
      }

      b.appendChild(formRow('缺封面的游戏', el('div', {}, [
        coverStats,
        cpBar,
        cpText,
        el('div', { class: 'form-inline', style: { marginTop: '10px' } }, [runBtn, stopBtn])
      ]), '只会挑选没有封面的游戏去搜；已经自己上传过封面的游戏永远不会被覆盖。'));

      b.appendChild(el('div', { class: 'form-inline' }, [
        el('button', {
            class: 'btn btn-ghost btn-sm', text: '批量提取程序图标（离线兜底）',
            onclick: async () => {
              closeModal();
              await window.App.runExtractIcons();
              await window.App.refresh();
            }
        })
      ]));

      /* ========================================================
       *  游戏嗅探
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '游戏嗅探', style: { marginTop: '22px' } }));

      b.appendChild(switchRow(
        '启动时自动扫描',
        '打开 GameHub 时自动嗅探注册表、Steam、Epic 里已安装的游戏。',
        !!s.autoScanOnStart,
        (v) => save({ autoScanOnStart: v })
      ));

      b.appendChild(switchRow(
        '导入时自动抓 Steam 官方封面',
        '添加新游戏时联网下载 Steam 商城竖版封面图（需要网络，离线时自动退回程序图标）。',
        !!s.autoFetchSteamCover,
        (v) => save({ autoFetchSteamCover: v })
      ));

      // 附加扫描目录
      const folderList = el('div', { class: 'scan-list', style: { marginTop: '10px' } });
      const paintFolders = () => {
        folderList.innerHTML = '';
        if (!folders.length) {
          folderList.appendChild(el('div', { class: 'form-desc', text: '还没有添加额外目录。默认只扫描系统已安装的游戏；如果你把游戏放在 D:\\Games 之类的自定义目录，加进来就能一起扫到。' }));
        }
        folders.forEach((f, i) => {
          folderList.appendChild(el('div', { class: 'scan-item' }, [
            el('div', { class: 'scan-info' }, [
              el('div', { class: 'scan-name', text: f.path }),
              el('div', { class: 'scan-path', text: f.mode === 'subfolder' ? '模式：每个子文件夹 = 一个游戏' : '模式：智能嗅探（递归识别）' })
            ]),
            el('button', {
              class: 'btn btn-ghost btn-sm', text: '移除',
              onclick: () => { folders.splice(i, 1); save({ scanFolders: folders }); paintFolders(); window.App.refreshSidebar(); }
            })
          ]));
        });
      };
      paintFolders();

      b.appendChild(formRow('附加扫描目录（可选）', el('div', {}, [
        el('div', { class: 'form-inline' }, [
          el('button', {
            class: 'btn btn-ghost',
            text: '＋ 添加目录（智能嗅探）',
            onclick: async () => {
              const p = await API.pickFolder();
              if (!p || p.ok === false) return;
              if (folders.some((x) => x.path === p)) { window.App.toast('该目录已存在', 'warn'); return; }
              folders.push({ path: p, mode: 'smart' });
              await save({ scanFolders: folders });
              paintFolders();
            }
          }),
          el('button', {
            class: 'btn btn-ghost',
            text: '＋ 添加目录（每个子文件夹一个游戏）',
            onclick: async () => {
              const p = await API.pickFolder();
              if (!p || p.ok === false) return;
              folders.push({ path: p, mode: 'subfolder' });
              await save({ scanFolders: folders });
              paintFolders();
            }
          })
        ]),
        folderList
      ]), '「每个子文件夹一个游戏」适合 D:\\Games\\ 下面每个文件夹就是一款游戏的结构，扫描更快更准。'));

      /* ========================================================
       *  游戏平台
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '游戏平台', style: { marginTop: '22px' } }));

      b.appendChild(switchRow(
        '打开总览时自动同步',
        '进入「平台总览」就自动读取已登录平台的账号信息与拥有列表（全部在本机读取，不上传任何数据）。关掉就只能手动点每张卡上的「同步」。',
        pref('platformAutoSync'),
        (v) => save({ platformAutoSync: v })
      ));

      /* ========================================================
       *  游玩统计
       * ======================================================== */
      b.appendChild(el('div', { class: 'detail-section-title', text: '游玩统计', style: { marginTop: '22px' } }));

      b.appendChild(segRow('默认统计周期',
        [{ value: 'week', label: '一星期' }, { value: 'month', label: '一个月' },
         { value: 'quarter', label: '一季度' }, { value: 'year', label: '一年' }],
        (v) => (s.statsPeriod || 'month') === v,
        (v) => { save({ statsPeriod: v }); paintBody(b); },
        '下次打开「游玩统计」默认展示的周期，进入后仍然可以随时切换。'
      ));

      /* ---- 隐藏空间 ---- */
      b.appendChild(el('div', { class: 'detail-section-title', text: '隐藏空间', style: { marginTop: '22px' } }));

      const h = window.State.hidden;
      if (!h.enabled) {
        b.appendChild(el('div', { class: 'form-desc', text: '还没启用。启用后可以给游戏打上「隐藏」标记，只有输入密码才能看到它们 —— 适合藏起不想被别人看到的游戏。' }));
        b.appendChild(el('div', { style: { marginTop: '10px' } }, [
          el('button', { class: 'btn btn-primary', text: '🔒 启用隐藏空间', onclick: () => { closeModal(); hiddenSetup(); } })
        ]));
      } else {
        b.appendChild(el('div', { class: 'form-desc', text: `隐藏空间正在生效中。当前有 ${h.hiddenCount || 0} 款游戏被隐藏，闲置 ${h.autoLockMinutes || 0} 分钟会自动上锁。` }));

        b.appendChild(formRow('闲置自动上锁', el('select', {
          class: 'input',
          onchange: async (e) => {
            const v = Number(e.target.value);
            await API.settingsSet({ hidden: { autoLockMinutes: v } });
            window.App.toast(v ? `将在闲置 ${v} 分钟后自动上锁` : '已关闭自动上锁', 'success');
          }
        }, [0, 1, 3, 5, 10, 30, 60].map((m) =>
          el('option', { value: m, text: m === 0 ? '不自动上锁' : `${m} 分钟`, selected: (h.autoLockMinutes || 0) === m })
        )), '上锁后隐藏的游戏会立刻从界面上消失，需要重新输入密码才能看到。'));

        b.appendChild(el('div', { class: 'form-inline' }, [
          el('button', {
            class: 'btn btn-ghost', text: '修改密码',
            onclick: () => { closeModal(); changePassword(); }
          }),
          el('button', {
            class: 'btn btn-danger', text: '关闭隐藏空间',
            onclick: async () => {
              const pwd = await promptPassword('关闭隐藏空间', '关闭后所有隐藏的游戏会重新显示出来（数据不会丢失）。请输入密码确认：');
              if (pwd === null) return;
              const r = await API.hiddenDisable(pwd);
              if (r && r.ok) {
                window.App.toast('隐藏空间已关闭', 'success');
                await window.App.refresh();
                closeModal();
              } else {
                window.App.toast((r && r.error) || '密码不正确', 'error');
              }
            }
          })
        ]));
      }

      /* ---- 数据 ---- */
      b.appendChild(el('div', { class: 'detail-section-title', text: '数据', style: { marginTop: '22px' } }));
      const info = await API.info();
      b.appendChild(el('div', { class: 'info-grid' }, [
        el('div', { class: 'info-cell' }, [
          el('div', { class: 'info-label', text: '数据目录' }),
          el('div', { class: 'info-value path', text: (info && info.dataDir) || '—' })
        ]),
        el('div', { class: 'info-cell' }, [
          el('div', { class: 'info-label', text: '版本' }),
          el('div', { class: 'info-value', text: `GameHub ${(info && info.version) || '1.0.0'} · Electron ${(info && info.electron) || ''}` })
        ])
      ]));
      b.appendChild(el('div', { class: 'form-inline', style: { marginTop: '10px' } }, [
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '打开数据目录',
          onclick: () => API.openPath(info && info.dataDir)
        }),
        el('button', {
          class: 'btn btn-danger btn-sm', text: '清空游戏库（保留设置）',
          onclick: async () => {
            const idx = await API.message({
              type: 'warning', title: '确认清空',
              message: '确定要清空整个游戏库吗？',
              detail: '只会删除 GameHub 里的记录，不会动磁盘上的任何游戏文件。',
              buttons: ['取消', '确认清空'], defaultId: 1, cancelId: 0
            });
            if (idx !== 1) return;
            await API.clear();
            await window.App.refresh();
            closeModal();
            window.App.toast('游戏库已清空', 'success');
          }
        })
      ]));
    }
  }

  /* ================================================================
   *  ③ 添加游戏（二级页面）
   * ----------------------------------------------------------------
   *  第一级：选添加方式 —— 手动 / 自动
   *  第二级：各自的具体界面，左下角有「← 返回」可以退回第一级
   * ================================================================ */

  /** 第一级：选择添加方式 */
  function addGame() {
    openModal({
      title: '添加游戏',
      sub: '选一种方式把游戏加进库中',
      size: 'md',
      renderBody: (b) => {
        b.appendChild(el('div', { class: 'chooser' }, [
          chooserCard({
            icon: '✎',
            title: '手动添加',
            desc: '自己指定主程序和安装目录，适合绿色版、单文件版、或者扫描没认出来的游戏。',
            points: ['可以自定义名称、分类', '支持 launcher.bat 之类的启动脚本'],
            onclick: () => addGameManual()
          }),
          chooserCard({
            icon: '🔍',
            title: '自动添加',
            primary: true,
            desc: '选定一个或多个文件夹，自动把里面的游戏搜出来，再由你勾选要添加哪些。',
            points: ['自动识别安装目录与主程序', '搜完先给你确认，不会不问自取'],
            onclick: () => addGameAuto()
          })
        ]));
      },
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
      }
    });
  }

  /** 二级页面上用的大卡片 */
  function chooserCard({ icon, title, desc, points, primary, onclick }) {
    return el('button', {
      class: 'chooser-card' + (primary ? ' primary' : ''),
      onclick
    }, [
      el('div', { class: 'cc-icon', text: icon }),
      el('div', { class: 'cc-body' }, [
        el('div', { class: 'cc-title' }, [
          title,
          el('span', { class: 'cc-go', text: '→' })
        ]),
        el('div', { class: 'cc-desc', text: desc }),
        el('ul', { class: 'cc-points' }, (points || []).map((p) => el('li', { text: p })))
      ])
    ]);
  }

  /* ================================================================
   *  ③-a 手动添加（原来的表单，加了返回键）
   * ================================================================ */
  function addGameManual() {
    let exePath = '';
    let installDir = '';
    let name = '';

    const nameInput = el('input', { class: 'input', placeholder: '例如：艾尔登法环' });
    const exeInput = el('input', { class: 'input mono', placeholder: '未选择（可以留空，之后在详情里补）' });
    const dirInput = el('input', { class: 'input mono', placeholder: '未选择' });
    const catEditor = categoryEditor([]);

    openModal({
      title: '手动添加',
      sub: '添加游戏 › 手动添加 · 选择游戏主程序即可，其余信息会自动识别',
      renderBody: (b) => {
        b.appendChild(formRow('游戏名称', nameInput, '留空的话会用主程序所在的文件夹名。'));
        b.appendChild(formRow('主程序 (.exe)', el('div', { class: 'form-inline' }, [
          exeInput,
          el('button', {
            class: 'btn btn-ghost', text: '选择…',
            onclick: async () => {
              const p = await API.pickExe();
              if (!p || p.ok === false) return;
              exePath = p;
              exeInput.value = p;
              installDir = p.replace(/[\\/][^\\/]+$/, '');
              dirInput.value = installDir;
              if (!nameInput.value) {
                // 用目录名做默认名称，并顺手美化一下
                const base = installDir.split(/[\\/]/).filter(Boolean).pop() || '';
                nameInput.value = base.replace(/[_]+/g, ' ').trim();
              }
            }
          })
        ]), '也可以选择 launcher.bat 之类的启动脚本。'));
        b.appendChild(formRow('安装目录', el('div', { class: 'form-inline' }, [
          dirInput,
          el('button', {
            class: 'btn btn-ghost', text: '选择…',
            onclick: async () => {
              const p = await API.pickFolder();
              if (!p || p.ok === false) return;
              installDir = p;
              dirInput.value = p;
            }
          })
        ])));
        b.appendChild(formRow('分类', catEditor.node, '留空会自动按名称识别。'));
        b.appendChild(el('div', { class: 'form-desc', text: '提示：添加后可以在游戏详情页里换封面、补充发行商、版本等信息。' }));
      },
      renderFoot: (f) => {
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '← 返回', title: '回到添加方式选择', onclick: () => addGame() }));
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', {
          class: 'btn btn-primary', text: '添加到游戏库',
          onclick: async () => {
            const finalName = nameInput.value.trim() ||
              (installDir ? installDir.split(/[\\/]/).filter(Boolean).pop() : '') || '未命名游戏';
            if (!exePath && !installDir) { window.App.toast('至少要选择主程序或安装目录', 'warn'); return; }
            const cats = catEditor.getValue();
            const r = await API.addOne({
              id: 'manual_' + Math.random().toString(36).slice(2, 10),
              name: finalName,
              exePath,
              installDir,
              source: 'manual',
              sourceLabel: '手动',
              confidence: 10,
              categories: cats.length ? cats : undefined
            });
            if (r && r.ok !== false) {
              closeModal();
              await window.App.refresh();
              window.App.toast('已添加到游戏库', 'success');
              // R18 → 主进程已尝试自动隐藏，这里给出反馈（没启用隐藏空间就引导去设置）
              handleR18Feedback(r.r18);
              // 自动尝试提取图标当封面
              const added = r.id ? window.State.games.find((x) => x.id === r.id)
                : window.State.games.find((x) => x.name === finalName && !x.coverUrl);
              if (added && !added.coverUrl) { await API.coverExtract(added.id); await window.App.refresh(); }
            } else {
              window.App.toast((r && r.error) || '添加失败', 'error');
            }
          }
        }));
      }
    });
  }

  /* ================================================================
   *  ③-b 自动添加：选文件夹 → 扫描 → 勾选确认
   * ================================================================ */
  function addGameAuto() {
    /** 待扫描的目录（支持多个） */
    let dirs = [];
    let busy = false;

    const listBox = el('div', { class: 'folder-list' });
    const tipBox = el('div', { class: 'form-desc' });

    const ref = openModal({
      title: '自动添加',
      sub: '添加游戏 › 自动添加 · 选好文件夹后开始扫描，扫描结果由你确认',
      size: 'lg',
      renderBody: (b) => {
        b.appendChild(el('div', { class: 'form-row' }, [
          el('label', { class: 'form-label', text: '要扫描的文件夹' }),
          listBox,
          el('div', { class: 'form-inline', style: { marginTop: '10px' } }, [
            el('button', {
              class: 'btn btn-ghost', text: '＋ 添加文件夹',
              onclick: async () => {
                const picked = await API.pickFolders();
                if (!picked || picked.ok === false || !picked.length) return;
                for (const p of picked) if (!dirs.includes(p)) dirs.push(p);
                paintList();
              }
            }),
            el('button', {
              class: 'btn btn-ghost', text: '＋ 单个文件夹',
              onclick: async () => {
                const p = await API.pickFolder();
                if (!p || p.ok === false) return;
                if (!dirs.includes(p)) dirs.push(p);
                paintList();
              }
            }),
            el('button', {
              class: 'btn btn-ghost', text: '💡 用常见位置填充',
              onclick: async () => {
                const d = await API.defaultFolders();
                const list = Array.isArray(d) ? d : (d && d.folders) || [];
                let n = 0;
                for (const p of list) { if (!dirs.includes(p)) { dirs.push(p); n++; } }
                paintList();
                window.App.toast(n ? `已加入 ${n} 个常见游戏目录` : '没有找到可用的常见目录', n ? 'success' : 'warn');
              }
            })
          ])
        ]));
        b.appendChild(el('div', {
          class: 'form-desc',
          text: '提示：扫描会穿透文件夹一层层往里找，直到认出每一款游戏为止。'
              + '所以你可以直接选一个总目录（比如把几十个游戏堆在一起的 D:\\Games），'
              + '里面的每个游戏都会被单独列出来，不会把总目录本身当成一款游戏。'
        }));
        b.appendChild(el('div', { class: 'form-desc', text: '扫描只会"找出来"，不会自动入库。扫描完成后会列出全部结果，你勾选哪些就只加哪些。' }));
        b.appendChild(tipBox);
        paintList();
      },
      renderFoot: (f) => {
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '← 返回', title: '回到添加方式选择', onclick: () => addGame() }));
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', {
          class: 'btn btn-primary', text: '开始扫描',
          onclick: async () => {
            if (busy) return;
            if (!dirs.length) { window.App.toast('请先添加至少一个文件夹', 'warn'); return; }
            busy = true;
            tipBox.textContent = '正在扫描，请稍候…（目录越大越慢）';
            tipBox.classList.add('busy');
            await window.App.runScan({
              dirs,
              mode: 'smart',
              // 扫完直接把候选交给"确认导入"这一步
              onList: (list) => {
                busy = false;
                tipBox.classList.remove('busy');
                if (!list.length) {
                  tipBox.textContent = '这几个目录里没有发现新的游戏。可以换一个更上层的目录（比如整个游戏盘）再试。';
                  return;
                }
                tipBox.textContent = `发现 ${list.length} 个候选，请在下一步里勾选要导入的游戏。`;
                scanResults(list, {
                  title: '自动添加 · 确认导入',
                  sub: `从你选的文件夹里找到 ${list.length} 个候选，勾选要加入游戏库的条目`,
                  back: () => addGameAuto()
                });
              }
            });
            busy = false;
          }
        }));
      }
    });

    /** 画目录列表 */
    function paintList() {
      listBox.innerHTML = '';
      if (!dirs.length) {
        listBox.appendChild(el('div', { class: 'folder-empty', text: '还没有选择文件夹' }));
        return;
      }
      dirs.forEach((d, i) => {
        listBox.appendChild(el('div', { class: 'folder-item' }, [
          el('span', { class: 'fi-icon', text: '📁' }),
          el('span', { class: 'fi-path', text: d, title: d }),
          el('button', {
            class: 'fi-del', text: '×', title: '移除这个文件夹',
            onclick: () => { dirs.splice(i, 1); paintList(); }
          })
        ]));
      });
    }

    return ref;
  }

  /**
   * 统一处理"R18 自动隐藏"的结果反馈。
   * @param {{hidden:string[], pending:string[]}} r18 主进程返回的结果
   */
  function handleR18Feedback(r18) {
    if (!r18) return;
    if (r18.hidden && r18.hidden.length) {
      window.App.toast(`「${r18.hidden.join('、')}」标了 R18，已自动放进隐藏空间`, 'success', 6500);
    }
    if (r18.pending && r18.pending.length) {
      window.App.toast('标了 R18，但还没启用隐藏空间。设置一个密码后就会自动隐藏。', 'warn', 7000);
      // 稍等一下再弹设置窗口，避免和刚关掉的弹窗打架
      setTimeout(() => hiddenSpace(), 420);
    }
  }

  /* ================================================================
   *  ④ 编辑游戏
   * ================================================================ */
  function editGame(id) {
    const g = window.State.games.find((x) => x.id === id);
    if (!g) return;

    const nameInput = el('input', { class: 'input', value: g.name || '' });
    const exeInput = el('input', { class: 'input mono', value: g.exePath || '', placeholder: '主程序路径' });
    const dirInput = el('input', { class: 'input mono', value: g.installDir || '', placeholder: '安装目录' });
    const pubInput = el('input', { class: 'input', value: g.publisher || '', placeholder: '发行商 / 开发商' });
    const verInput = el('input', { class: 'input', value: g.version || '', placeholder: '版本号' });
    const argInput = el('input', { class: 'input mono', value: g.launchArgs || '', placeholder: '启动参数（可选），例如 -windowed' });
    const dateInput = el('input', {
      class: 'input', type: 'date',
      value: g.installDate ? new Date(g.installDate).toISOString().slice(0, 10) : ''
    });
    const catEditor = categoryEditor(g.categories);

    openModal({
      title: '编辑游戏信息',
      sub: g.name,
      renderBody: (b) => {
        b.appendChild(formRow('游戏名称', nameInput));
        b.appendChild(formRow('主程序', el('div', { class: 'form-inline' }, [
          exeInput,
          el('button', {
            class: 'btn btn-ghost', text: '选择…',
            onclick: async () => {
              const p = await API.pickExe();
              if (!p || p.ok === false) return;
              exeInput.value = p;
              if (!dirInput.value) dirInput.value = p.replace(/[\\/][^\\/]+$/, '');
            }
          })
        ])));
        b.appendChild(formRow('安装目录', el('div', { class: 'form-inline' }, [
          dirInput,
          el('button', {
            class: 'btn btn-ghost', text: '选择…',
            onclick: async () => {
              const p = await API.pickFolder();
              if (!p || p.ok === false) return;
              dirInput.value = p;
            }
          })
        ])));
        b.appendChild(formRow('分类', catEditor.node, '一款游戏可以同时属于多个分类（用「＋」添加）。勾选 R18 会自动把它放进隐藏空间。'));
        b.appendChild(el('div', { class: 'form-inline' }, [
          el('div', { style: { flex: '1 1 0', minWidth: '0' } }, [formRow('发行商', pubInput)]),
          el('div', { style: { flex: '1 1 0', minWidth: '0' } }, [formRow('版本', verInput)])
        ]));
        b.appendChild(el('div', { class: 'form-inline' }, [
          el('div', { style: { flex: '1 1 0', minWidth: '0' } }, [formRow('安装日期', dateInput)]),
          el('div', { style: { flex: '1 1 0', minWidth: '0' } }, [formRow('启动参数', argInput)])
        ]));
      },
      renderFoot: (f) => {
        f.appendChild(el('button', { class: 'btn btn-danger', text: '移除该游戏', onclick: () => confirmRemove([g.id], g.name) }));
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', {
          class: 'btn btn-primary', text: '保存',
          onclick: async () => {
            const cats = catEditor.getValue();
            const patch = {
              name: nameInput.value.trim() || g.name,
              exePath: exeInput.value.trim(),
              installDir: dirInput.value.trim(),
              publisher: pubInput.value.trim(),
              version: verInput.value.trim(),
              launchArgs: argInput.value.trim(),
              categories: cats.length ? cats : ['其他'],
              installDate: dateInput.value ? new Date(dateInput.value).getTime() : g.installDate
            };
            const r = await API.update(g.id, patch);
            if (r && r.ok !== false) {
              closeModal();
              await window.App.refresh();
              window.Detail.refreshIfOpen();
              // 勾了 R18 → 可能刚被自动收进隐藏空间，给个明确反馈
              const r18 = r.r18;
              if (r18 && r18.hidden && r18.hidden.length) {
                window.App.toast('已保存，并因 R18 标签自动放进隐藏空间', 'success', 6000);
              } else if (r18 && r18.pending && r18.pending.length) {
                window.App.toast('已保存。标了 R18 但隐藏空间还没启用，设置密码后会自动隐藏。', 'warn', 7000);
                setTimeout(() => hiddenSpace(), 420);
              } else {
                window.App.toast('已保存', 'success');
              }
            } else {
              window.App.toast((r && r.error) || '保存失败', 'error');
            }
          }
        }));
      }
    });
  }

  /* ================================================================
   *  ⑤ 隐藏空间
   * ================================================================ */

  /** 入口：根据当前状态决定展示哪个界面 */
  async function hiddenSpace() {
    const h = await API.hiddenStatus();
    if (!h || h.ok === false) return;
    if (!h.enabled) return setupPassword();
    if (!h.unlocked) return unlockScreen(h);
    return manageScreen(h);
  }

  /** 首次启用：设置密码 */
  function setupPassword() {
    const pwd1 = el('input', { class: 'input lock-input', type: 'password', placeholder: '设置密码（至少 3 位）' });
    const pwd2 = el('input', { class: 'input lock-input', type: 'password', placeholder: '再输一次确认' });
    const hint = el('input', { class: 'input', placeholder: '密码提示（可选，会显示在解锁界面）' });
    const msg = el('div', { class: 'lock-hint' });

    openModal({
      title: '启用隐藏空间',
      size: 'sm',
      renderBody: (b) => {
        b.appendChild(el('div', { class: 'lock-screen', style: { minHeight: 'auto', paddingTop: '6px' } }, [
          el('div', { class: 'lock-icon', text: '🔒' }),
          el('div', { class: 'lock-title', text: '设置一个密码' }),
          el('div', { class: 'lock-desc', text: '启用后，你可以把不想被别人看到的游戏标记为「隐藏」。它们不会出现在全部游戏、分类和搜索结果里，只有在这里输入密码才能看到。' }),
          el('div', { class: 'lock-form' }, [pwd1, pwd2, hint, msg]),
          el('div', { class: 'lock-badges' }, [
            el('span', { class: 'badge badge-source', text: '密码只保存在本机' }),
            el('span', { class: 'badge badge-source', text: 'scrypt 加密存储' }),
            el('span', { class: 'badge badge-source', text: '闲置自动上锁' })
          ])
        ]));
      },
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', {
          class: 'btn btn-primary', text: '启用',
          onclick: async () => {
            if (pwd1.value.length < 3) { msg.textContent = '密码至少 3 位'; msg.classList.add('error'); return; }
            if (pwd1.value !== pwd2.value) { msg.textContent = '两次输入的密码不一致'; msg.classList.add('error'); return; }
            const r = await API.hiddenSetup(pwd1.value, hint.value);
            if (r && r.ok) {
              closeModal();
              await window.App.refresh();
              window.App.toast('隐藏空间已启用（当前已解锁）', 'success');
            } else {
              msg.textContent = (r && r.error) || '设置失败';
              msg.classList.add('error');
            }
          }
        }));
      }
    });
  }

  /** 解锁界面 */
  function unlockScreen(h) {
    const pwd = el('input', { class: 'input lock-input', type: 'password', placeholder: '请输入密码' });
    const msg = el('div', { class: 'lock-hint' });
    const cnt = h.hiddenCount || 0;

    const tryUnlock = async () => {
      const r = await API.hiddenUnlock(pwd.value);
      if (r && r.ok) {
        closeModal();
        await window.App.refresh();
        window.App.goto('hidden');
        window.App.toast('已解锁隐藏空间', 'success');
      } else {
        msg.textContent = (r && r.error) || '密码不正确';
        msg.classList.add('error');
        pwd.select();
      }
    };

    pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

    openModal({
      title: '隐藏空间',
      size: 'sm',
      renderBody: (b) => {
        b.appendChild(el('div', { class: 'lock-screen', style: { minHeight: 'auto', paddingTop: '6px' } }, [
          el('div', { class: 'lock-icon', text: '🔐' }),
          el('div', { class: 'lock-title', text: '这个空间已上锁' }),
          el('div', { class: 'lock-desc', text: h.hasHint && h.hint ? `密码提示：${h.hint}` : '输入密码后即可查看被隐藏的游戏。' }),
          el('div', { class: 'lock-form' }, [pwd, msg])
        ]));
        setTimeout(() => pwd.focus(), 60);
      },
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer', text: '' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', { class: 'btn btn-primary', text: '解锁', onclick: tryUnlock }));
      }
    });
  }

  /** 已解锁：管理界面 */
  function manageScreen(h) {
    openModal({
      title: '隐藏空间 · 已解锁',
      size: 'sm',
      renderBody: (b) => {
        b.appendChild(el('div', { class: 'lock-screen', style: { minHeight: 'auto', paddingTop: '6px' } }, [
          el('div', { class: 'lock-icon', text: '🔓', style: { borderColor: 'var(--ok)' } }),
          el('div', { class: 'lock-title', text: '隐藏空间是打开的' }),
          el('div', { class: 'lock-desc', text: '现在可以正常查看和管理隐藏的游戏。别忘了离开前点「立即上锁」。' }),
          el('div', { class: 'lock-form' }, [
            el('button', {
              class: 'btn btn-primary btn-lg', text: '进入隐藏空间',
              onclick: async () => { closeModal(); await window.App.refresh(); window.App.goto('hidden'); }
            }),
            el('button', {
              class: 'btn btn-ghost', text: '🔒 立即上锁',
              onclick: async () => {
                await API.hiddenLock();
                closeModal();
                await window.App.refresh();
                window.App.toast('已上锁', 'success');
              }
            })
          ])
        ]));
      },
      renderFoot: (f) => {
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '修改密码', onclick: () => { closeModal(); changePassword(); } }));
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '关闭', onclick: closeModal }));
      }
    });
  }

  /** 修改密码 */
  function changePassword() {
    const o = el('input', { class: 'input', type: 'password', placeholder: '原密码' });
    const n1 = el('input', { class: 'input', type: 'password', placeholder: '新密码（至少 3 位）' });
    const n2 = el('input', { class: 'input', type: 'password', placeholder: '再输一次新密码' });
    const hint = el('input', { class: 'input', placeholder: '新密码提示（可选）' });
    const msg = el('div', { class: 'lock-hint' });

    openModal({
      title: '修改隐藏空间密码',
      size: 'sm',
      renderBody: (b) => {
        b.appendChild(formRow('原密码', o));
        b.appendChild(formRow('新密码', el('div', {}, [n1, el('div', { style: { height: '8px' } }), n2])));
        b.appendChild(formRow('密码提示', hint));
        b.appendChild(msg);
      },
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', {
          class: 'btn btn-primary', text: '保存新密码',
          onclick: async () => {
            if (n1.value.length < 3) { msg.textContent = '新密码至少 3 位'; msg.classList.add('error'); return; }
            if (n1.value !== n2.value) { msg.textContent = '两次输入的新密码不一致'; msg.classList.add('error'); return; }
            const r = await API.hiddenChangePwd(o.value, n1.value, hint.value);
            if (r && r.ok) { closeModal(); window.App.toast('密码已修改', 'success'); }
            else { msg.textContent = (r && r.error) || '修改失败'; msg.classList.add('error'); }
          }
        }));
      }
    });
  }

  /** 简单的密码输入对话框（返回密码字符串，取消返回 null） */
  function promptPassword(title, desc) {
    return new Promise((resolve) => {
      const pwd = el('input', { class: 'input', type: 'password', placeholder: '密码' });
      const msg = el('div', { class: 'lock-hint' });
      let done = false;
      openModal({
        title,
        size: 'sm',
        renderBody: (b) => {
          b.appendChild(el('div', { class: 'form-desc', text: desc }));
          b.appendChild(el('div', { style: { height: '12px' } }));
          b.appendChild(pwd);
          b.appendChild(msg);
          setTimeout(() => pwd.focus(), 60);
        },
        renderFoot: (f) => {
          f.appendChild(el('span', { class: 'spacer' }));
          f.appendChild(el('button', {
            class: 'btn btn-ghost', text: '取消',
            onclick: () => { done = true; closeModal(); resolve(null); }
          }));
          f.appendChild(el('button', {
            class: 'btn btn-primary', text: '确定',
            onclick: () => { done = true; resolve(pwd.value); closeModal(); }
          }));
        }
      });
      pwd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { done = true; resolve(pwd.value); closeModal(); }
      });
    });
  }

  /* ================================================================
   *  ⑥ 移除确认
   * ================================================================ */
  async function confirmRemove(ids, name) {
    const idx = await API.message({
      type: 'warning',
      title: '移除游戏',
      message: ids.length > 1 ? `确定要从游戏库移除这 ${ids.length} 款游戏吗？` : `确定要移除「${name}」吗？`,
      detail: '只会删除 GameHub 库里的记录，磁盘上的游戏文件不会被删除。',
      buttons: ['取消', '移除'],
      defaultId: 1,
      cancelId: 0
    });
    if (idx !== 1) return;
    const r = await API.remove(ids);
    if (r && r.ok !== false) {
      closeModal();
      await window.App.refresh();
      window.App.toast(`已移除 ${r.removed} 款游戏`, 'success');
    }
  }

  /* ================================================================
   *  ⑥-b 批量删除已录入的游戏
   * ----------------------------------------------------------------
   *  入口：更多选项 → 「🗑 批量删除游戏」。
   *  和单款移除（右键 / 详情页）的区别是可以一次勾一大片，
   *  所以这里必须给足"后悔药"：
   *    · 带封面缩略图，同系列的两款不会认错
   *    · 能按来源 / 分类 / 关键词先筛再勾，几百款也不用一条条找
   *    · 删除前二次确认，并把前几款的名字念出来，让人看清勾了什么
   *    · 只会删 GameHub 库里的记录，磁盘上的游戏文件一个都不动
   * ================================================================ */
  function batchRemove() {
    // 按名字排序：删除是"找东西"而不是"看新东西"，按名字排比按加入时间好找
    const all = (window.State.games || [])
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    if (!all.length) { window.App.toast('游戏库里还没有游戏，没什么可删的', 'warn'); return; }

    const selected = new Set();
    let q = '';
    let src = 'all';
    let cat = '';

    const cats = Array.from(new Set(all.flatMap((g) => g.categories || [])))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    const host = { body: null, foot: null };
    openModal({
      title: '批量删除游戏',
      sub: '勾选要从库中移除的游戏。只会删掉 GameHub 里的记录，磁盘上的游戏文件一个都不会动。',
      size: 'lg',
      renderBody: (b) => { host.body = b; paint(); },
      renderFoot: (f) => { host.foot = f; paintFoot(); }
    });

    /** 当前筛选条件下可见的那些游戏 */
    function visible() {
      const needle = q.trim().toLowerCase();
      return all.filter((g) => {
        if (src !== 'all' && g.source !== src) return false;
        if (cat && !(g.categories || []).includes(cat)) return false;
        if (!needle) return true;
        return (
          String(g.name || '').toLowerCase().includes(needle) ||
          String(g.publisher || '').toLowerCase().includes(needle) ||
          String(g.installDir || '').toLowerCase().includes(needle) ||
          (g.altNames || []).some((n) => String(n).toLowerCase().includes(needle))
        );
      });
    }

    function paint() {
      const b = host.body;
      if (!b) return;
      const view = visible();
      b.innerHTML = '';

      /* ---- 工具条：筛选 + 批量勾选 ---- */
      const countEl = el('span', { class: 'scan-count' });
      const updateCount = () => {
        const picked = selected.size;
        countEl.innerHTML = `已选 <strong>${picked}</strong> 款 · 当前列出 ${view.length} / ${all.length}`;
      };

      const searchInput = el('input', {
        class: 'input',
        type: 'text',
        placeholder: '搜索游戏名 / 发行商 / 路径…',
        value: q,
        style: { maxWidth: '210px' },
        oninput: (e) => { q = e.target.value; repaint(); }
      });

      const srcSel = el('select', {
        class: 'input',
        style: { maxWidth: '120px' },
        onchange: (e) => { src = e.target.value; repaint(); }
      }, [['all', '全部来源'], ['steam', 'Steam'], ['registry', '注册表'], ['folder', '文件夹'],
           ['epic', 'Epic'], ['manual', '手动添加']]
        .map(([v, label]) => el('option', { value: v, text: label, selected: src === v })));

      const catSel = el('select', {
        class: 'input',
        style: { maxWidth: '140px' },
        onchange: (e) => { cat = e.target.value; repaint(); }
      }, [el('option', { value: '', text: '全部分类', selected: !cat })]
        .concat(cats.map((c) => el('option', { value: c, text: c, selected: cat === c }))));

      b.appendChild(el('div', { class: 'scan-toolbar' }, [
        searchInput, srcSel, catSel,
        el('span', { class: 'sep' }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '☑ 全选列出的',
          onclick: () => { for (const g of view) selected.add(g.id); repaint(); }
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '⇄ 反选',
          onclick: () => {
            for (const g of view) {
              if (selected.has(g.id)) selected.delete(g.id); else selected.add(g.id);
            }
            repaint();
          }
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm', text: '☐ 清空',
          onclick: () => { selected.clear(); repaint(); }
        }),
        el('span', { class: 'sep' }),
        countEl
      ]));

      /* ---- 列表 ---- */
      if (!view.length) {
        b.appendChild(el('div', { class: 'form-desc', text: '当前筛选条件下没有游戏。换个关键词或分类试试。' }));
        updateCount();
        return;
      }

      const wrap = el('div', { class: 'scan-list' });
      for (const g of view) {
        const checked = selected.has(g.id);
        const sm = U.sourceMeta(g.source);

        const thumb = el('div', { class: 'scan-thumb' });
        U.applyGradient(thumb, g.name);
        if (g.coverUrl) {
          const img = el('img', { src: g.coverUrl, alt: '', class: U.isIconCover(g) ? 'as-icon' : '' });
          img.addEventListener('error', () => img.remove());
          thumb.appendChild(img);
        } else {
          thumb.appendChild(el('span', { text: U.initialOf(g.name) }));
        }

        const chips = [];
        for (const c of (g.categories || []).slice(0, 3)) chips.push(el('span', { class: 'chip', text: c }));
        if (g.hidden) chips.push(el('span', { class: 'chip', text: '🔒 已隐藏' }));
        if (g.missing) chips.push(el('span', { class: 'chip', text: '⚠ 路径失效' }));
        if (g.favorite) chips.push(el('span', { class: 'chip', text: '★ 收藏' }));

        wrap.appendChild(el('div', {
          class: 'scan-item' + (checked ? ' checked' : ''),
          onclick: () => {
            if (selected.has(g.id)) selected.delete(g.id); else selected.add(g.id);
            repaint();
          }
        }, [
          el('div', { class: 'scan-check', text: '✓' }),
          thumb,
          el('div', { class: 'scan-info' }, [
            el('div', { class: 'scan-name' }, [g.name].concat(chips)),
            el('div', { class: 'scan-path', text: g.installDir || g.exePath || '（没有记录路径）', title: g.installDir || g.exePath || '' })
          ]),
          el('div', { class: 'scan-side' }, [
            el('span', { class: 'badge ' + sm.cls, text: sm.label }),
            el('span', { text: g.sizeBytes ? fmtBytes(g.sizeBytes) : '—' }),
            el('span', { text: g.totalPlayMs > 60000 ? '已玩 ' + U.fmtDuration(g.totalPlayMs) : (g.installDate ? fmtDate(g.installDate) : '日期未知') })
          ])
        ]));
      }
      b.appendChild(wrap);
      updateCount();
    }

    function paintFoot() {
      const f = host.foot;
      if (!f) return;
      f.innerHTML = '';
      f.appendChild(el('span', { class: 'scan-count', text: `已勾选 ${selected.size} 款` }));
      f.appendChild(el('span', { class: 'spacer' }));
      f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
      f.appendChild(el('button', {
        class: 'btn btn-danger',
        text: selected.size ? `🗑 删除选中的 ${selected.size} 款` : '🗑 删除选中的游戏',
        disabled: !selected.size,
        onclick: () => doRemove()
      }));
    }

    /**
     * 重绘。⚠ 页脚必须一起刷：
     * renderFoot 在 openModal 里只跑一次，光调 paint() 的话
     * "已勾选 N 款"和那个删除按钮会永远停在打开弹窗那一刻的样子。
     */
    function repaint() { paint(); if (host.foot) paintFoot(); }

    async function doRemove() {
      const ids = Array.from(selected);
      if (!ids.length) return;
      const names = all.filter((g) => selected.has(g.id)).map((g) => g.name);
      const preview = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 款` : '');

      const idx = await API.message({
        type: 'warning',
        title: '批量删除游戏',
        message: `确定要从游戏库移除这 ${ids.length} 款游戏吗？`,
        detail: `即将移除：${preview}\n\n只会删除 GameHub 库里的记录（含它的游玩流水和封面缓存），磁盘上的游戏文件不会被删除。`,
        buttons: ['取消', '删除'],
        defaultId: 1,
        cancelId: 0
      });
      if (idx !== 1) return;

      const r = await API.remove(ids);
      if (r && r.ok !== false) {
        closeModal();
        await window.App.refresh();
        window.Detail.refreshIfOpen();
        window.App.toast(`已移除 ${r.removed} 款游戏（磁盘文件未动）`, 'success', 6000);
      } else {
        window.App.toast((r && r.error) || '删除失败', 'error');
      }
    }
  }

  /* ================================================================
   *  ⑦ 自定义分类：新建 / 重命名 / 删除
   * ================================================================ */

  /**
   * 新建或重命名分类的小弹窗。
   * @param {{mode:'add'|'rename', name?:string}} opts
   */
  function promptCategory(opts = {}) {
    const isRename = opts.mode === 'rename';
    const input = el('input', {
      class: 'input',
      value: isRename ? (opts.name || '') : '',
      placeholder: '例如：周末联机 / 通关了 / 未通关'
    });
    const msg = el('div', { class: 'lock-hint' });

    const submit = async () => {
      const v = input.value.trim();
      if (!v) { msg.textContent = '请先输入分类名'; msg.classList.add('error'); input.focus(); return; }

      const r = isRename
        ? await API.categoryRename(opts.name, v)
        : await API.categoryAdd(v);

      if (r && r.ok !== false) {
        closeModal();
        await window.App.refresh();
        window.App.toast(isRename ? `分类已重命名为「${v}」` : `已新建分类「${v}」`, 'success');
      } else {
        msg.textContent = (r && r.error) || '操作失败';
        msg.classList.add('error');
        input.select();
      }
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    openModal({
      title: isRename ? '重命名分类' : '新建分类',
      sub: isRename
        ? `把「${opts.name}」以及归在它下面的游戏一起改名`
        : '新建后可以把任意游戏归到这个分类下，一款游戏也可以属于多个分类',
      size: 'sm',
      renderBody: (b) => {
        b.appendChild(formRow('分类名称', input, '最多 16 个字，可以和已有分类不同名。'));
        b.appendChild(msg);
      },
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', { class: 'btn btn-primary', text: isRename ? '保存' : '新建', onclick: submit }));
      }
    });
    setTimeout(() => input.focus(), 80);
  }

  /** 删除分类前的确认 */
  async function confirmRemoveCategory(name, count) {
    const idx = await API.message({
      type: 'warning',
      title: '删除分类',
      message: `确定要删除分类「${name}」吗？`,
      detail: count > 0
        ? `有 ${count} 款游戏归在这个分类下，它们会失去这个分类（如果没有别的分类，会归到「其他」）。游戏本身不会被删除。`
        : '这个分类下暂时没有游戏。',
      buttons: ['取消', '删除'],
      defaultId: 1,
      cancelId: 0
    });
    if (idx !== 1) return;
    const r = await API.categoryRemove(name);
    if (r && r.ok !== false) {
      await window.App.refresh();
      // 如果正停在这个分类页上，得退出去，不然会看到一个空页面
      if (window.State.view === 'category' && window.State.category === name) window.App.goto('all');
      window.App.toast(`分类「${name}」已删除`, 'success');
    } else {
      window.App.toast((r && r.error) || '删除失败', 'error');
    }
  }

  /* ================================================================
   *  ⑨ 卸载游戏
   * ----------------------------------------------------------------
   *  三类游戏的卸载通道完全不同，所以这里不替用户做决定：
   *  先把「删什么、在哪、多大、由谁来删」摊开给人看，选完再动手。
   *
   *  之所以不直接删目录：
   *   Steam / Epic 的游戏自己删会让平台的库状态变成"文件缺失"，
   *   下次启动还会提示校验完整性 —— 必须走平台自己的卸载流程。
   * ================================================================ */
  async function uninstallGame(id) {
    const info = await API.uninstallInfo(id);
    if (!info || info.ok === false) {
      window.App.toast((info && info.error) || '读取卸载信息失败', 'error');
      return;
    }

    /* ---- 组装可选方式（按这款游戏的实际情况给） ---- */
    const opts = [];

    if (info.platform === 'steam') {
      opts.push({
        mode: 'platform',
        title: '交给 Steam 卸载',
        desc: '走 Steam 官方的卸载流程，Steam 会弹出它自己的确认窗口。推荐用这个 —— 库状态、云存档都能一并处理干净。'
      });
    } else if (info.platform === 'epic') {
      opts.push({
        mode: 'platform',
        title: '交给 Epic 启动器卸载',
        desc: '唤起 Epic Games 启动器来完成卸载。如果它没反应（有些版本不认这个指令），可以改用下面的方式。'
      });
    }

    if (info.dirExists && !info.blocked) {
      // 平台游戏如果绕开平台直接删文件，平台那边会以为还装着，
      // 下次启动可能提示"文件缺失 / 需要校验完整性"，得说清楚
      const syncWarn = info.platform
        ? `　注意：这样做 ${info.sourceLabel} 那边不会同步，之后可能提示「文件缺失」。建议优先用上面的方式。`
        : '';

      if (info.uninstaller) {
        opts.push({
          mode: 'software',
          title: '运行游戏自带的卸载程序',
          desc: `已找到：${info.uninstaller}。会把它启动起来，你跟着向导走完即可 —— 这样能顺带清掉注册表和开始菜单里的残留。` + syncWarn
        });
      } else {
        opts.push({
          mode: 'software',
          title: '把安装目录移入回收站',
          desc: '这款游戏没有自带卸载程序，会把整个安装目录移到系统回收站。万一删错，还可以从回收站还原。' + syncWarn
        });
      }
    }

    opts.push({
      mode: 'remove',
      title: '只从游戏库移除',
      desc: '磁盘上的文件一个都不动，只是让这款游戏不再出现在 GameHub 里。'
    });

    let picked = opts[0].mode;

    openModal({
      title: '卸载游戏',
      sub: info.name,
      size: 'md',
      renderBody: (b) => {
        /* ---- 信息区：删什么、在哪、多大 ---- */
        const rows = [
          ['来源', info.sourceLabel || '—'],
          ['安装目录', info.installDir || '（未记录）'],
          ['占用空间', info.sizeBytes
            ? fmtBytes(info.sizeBytes) + (info.sizeTruncated ? ' 以上' : '')
            : '未知']
        ];
        if (info.uninstaller) rows.push(['卸载程序', info.uninstaller]);

        b.appendChild(el('div', { class: 'un-box' }, rows.map(([k, v]) =>
          el('div', { class: 'un-row' }, [
            el('span', { class: 'un-key', text: k }),
            el('span', { class: 'un-val', text: v })
          ])
        )));

        /* ---- 方式选择 ---- */
        const list = el('div', { class: 'un-opts' });
        for (const o of opts) {
          const node = el('div', {
            class: 'un-opt' + (o.mode === picked ? ' on' : ''),
            onclick: () => {
              picked = o.mode;
              for (const c of list.children) c.classList.toggle('on', c.dataset.mode === picked);
            }
          }, [
            el('span', { class: 'un-opt-radio' }),
            el('div', { class: 'un-opt-body' }, [
              el('div', { class: 'un-opt-title', text: o.title + (o.recommend ? '（推荐）' : '') }),
              el('div', { class: 'un-opt-desc', text: o.desc })
            ])
          ]);
          node.dataset.mode = o.mode;
          list.appendChild(node);
        }
        b.appendChild(list);

        /* ---- 提醒 ---- */
        const warns = (info.warnings || []).slice();
        if (info.blocked) warns.push(info.blocked);
        if (warns.length) {
          b.appendChild(el('div', { class: 'un-warn', text: warns.join('　') }));
        }
      },
      renderFoot: (f) => {
        f.appendChild(el('span', { class: 'spacer' }));
        f.appendChild(el('button', { class: 'btn btn-ghost', text: '取消', onclick: closeModal }));
        f.appendChild(el('button', {
          class: 'btn btn-danger',
          text: '确认卸载',
          onclick: async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = '处理中…';

            const r = await API.uninstall({ id, mode: picked });
            closeModal();

            if (r && r.ok) {
              window.App.toast(r.detail || '已完成卸载', 'success', 6000);
              // 记录还留在库里的情况（平台卸载 / 卸载向导还没走完），
              // 提醒用户卸载完刷新一下，避免库里挂着一条死记录
              if (!r.removedFromLibrary) {
                setTimeout(() => {
                  window.App.toast('卸载完成后，重新扫描一次就能同步游戏库状态。', 'info', 7000);
                }, 1400);
              }
              if (window.App.refresh) window.App.refresh();
            } else {
              window.App.toast((r && r.error) || '卸载失败', 'error', 7000);
            }
          }
        }));
      }
    });
  }

  window.Modals = {
    openModal, closeModal, formRow, switchRow, categoryEditor,
    scanResults, settings, addGame, addGameManual, addGameAuto, editGame,
    hiddenSpace, setupPassword, unlockScreen, changePassword, promptPassword,
    promptCategory, confirmRemoveCategory,
    confirmRemove, batchRemove,
    /** 卸载游戏：走平台流程还是本地清理，由用户在弹窗里选 */
    uninstallGame
  };
})();
