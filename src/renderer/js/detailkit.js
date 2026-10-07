/**
 * ============================================================
 *  GameHub - 详情页共用构件  (js/detailkit.js)
 * ------------------------------------------------------------
 *  为什么要有这个文件：
 *    之前「全部游戏」的详情页（detail.js）和「平台总览」的详情页
 *    （platformview.js）各自手写了一套 DOM 和类名（.detail-* / .pfd-*），
 *    结果同一个游戏在两个入口点开长得完全不一样 —— 用户直接反馈
 *    "界面不统一"。
 *
 *    所以把详情页拆成一组共用构件，两个入口都必须走这里：
 *      skeleton()  骨架：Hero 大图 + 竖版封面 + 标题 + 统计行 + 标签
 *      bar()       操作条（独立一条，不裸贴在面板上）
 *      section()   可收起的卡片区块
 *      kv()        键值网格
 *      arts()      图片预览行
 *      achBar()    成就进度条
 *
 *    所有类名统一用 pfd-* 前缀（pfd 不是缩写，就是"详情页"）。
 *    ⚠ 改样式时要连 css/components.css 里的 .pfd-* 一起改，两边共用。
 * ============================================================
 */
(function () {
  'use strict';

  const { el, applyGradient, initialOf } = window.U;

  /**
   * 区块收起状态（key → 收起）。
   * 记在模块内存里，两个详情页共用：用户收起「详细信息」后，
   * 不管从哪个入口进来看都是收起的，不会出现"这边收那边开"的割裂感。
   */
  const collapsed = new Set();

  /* ================================================================
   *  统计行（标题旁的时长 / 启动次数 / 成就）
   * ================================================================ */

  /**
   * 一个统计胶囊。
   * @param {object} st
   * @param {string} st.value  主数值，如 "158 小时 27 分"、"11/53"
   * @param {string} [st.key]  小字说明，如 "游玩时间"、"成就"
   * @param {'ach'|'warn'|''} [st.tone] 配色：ach=金色（成就）、warn=红色（异常）
   */
  function stat(st) {
    const kids = [];
    if (st.value) kids.push(el('b', { text: String(st.value) }));
    if (st.key) kids.push(el('span', { class: 'k', text: st.key }));
    return el('div', {
      class: 'pfd-stat' + (st.tone ? ' ' + st.tone : ''),
      // 鼠标停在胶囊上能看这句补充说明（比如"这个时长是哪来的"）
      title: st.title || null
    }, kids);
  }

  /**
   * 一条统计行。传进来的空项会被跳过 —— 没有数据就不渲染，
   * 绝不能拿一个 0 出来糊弄人（比如没成就的游戏不能显示 0/0）。
   * @param {Array} list 元素可以是 stat 描述对象，也可以是已建好的节点
   */
  function stats(list) {
    const line = el('div', { class: 'pfd-statline' });
    for (const s of (list || [])) {
      if (!s) continue;
      line.appendChild(s instanceof Node ? s : stat(s));
    }
    return line;
  }

  /**
   * 收尾用：整行一个**真**元素都没有就把它摘掉，别留一条空白。
   * 成就是异步补的，补不到的时候就靠这个收拾残局。
   *
   * ⚠⚠ 占位节点（.pfd-ach-slot）**本身**不算内容，但它**里面补进去的东西**要算。
   *   这里少一个判断会让"只有成就、没有本地时长"的游戏整行凭空消失：
   *   那一行里只有占位节点 → 占位节点被过滤掉 → 判定为空 → 整行 remove()，
   *   刚刚塞进占位节点里的成就跟着一起没了。
   *   症状就是主人反馈的「有的游戏有成就、有的没有」——
   *   差别只在于"这款游戏有没有被 GameHub 启动过"，跟成就本身毫无关系。
   */
  function pruneEmpty(line) {
    if (!line || !line.isConnected) return line;
    const real = Array.from(line.children).filter((c) => {
      if (!c.classList.contains('pfd-ach-slot')) return true;
      return c.children.length > 0;   // 占位节点里补进东西了，就算真内容
    });
    if (!real.length) line.remove();
    return line;
  }

  /** 成就占位节点：本身不占地方（display: contents），异步拿到数据后往里塞 */
  function slot() {
    return el('span', { class: 'pfd-ach-slot' });
  }

  /* ================================================================
   *  标签行
   * ================================================================ */

  /**
   * @param {Array<{text:string,title?:string,onclick?:Function}>} list
   */
  function tags(list) {
    const arr = (list || []).filter(Boolean);
    if (!arr.length) return null;
    return el('div', { class: 'pfd-tags' },
      arr.map((t) => el('span', {
        class: 'pfd-tag',
        text: t.text,
        title: t.title || '',
        onclick: t.onclick || null
      }))
    );
  }

  /* ================================================================
   *  骨架：Hero + 关闭按钮 + 操作条 + 正文区
   * ================================================================ */

  /**
   * 生成整个详情页的骨架。
   *
   * @param {object} o
   * @param {string} o.title      标题（游戏名）
   * @param {string} [o.coverUrl] 竖版封面
   * @param {boolean} [o.coverIcon] 封面是程序图标（要居中留白，不裁切）
   * @param {string} [o.heroUrl]  横版大图（有就用它当 Hero 背景，没有就退化成封面模糊放大）
   * @param {Array}  [o.stats]    统计胶囊列表
   * @param {Array}  [o.tags]     标签列表
   * @param {Function} [o.onClose] 关闭回调（会同时生成右上角 × 按钮）
   * @returns {{panel:HTMLElement, hero:HTMLElement, bar:HTMLElement, body:HTMLElement, statline:HTMLElement}}
   */
  function skeleton(o) {
    const panel = el('div', { class: 'detail-panel', onclick: (e) => e.stopPropagation() });

    /* ---------- Hero ---------- */
    const hero = el('div', { class: 'pfd-hero' });
    applyGradient(hero, o.title);           // 没有图时兜底成渐变色，不能是一块死黑

    const bgSrc = o.heroUrl || o.coverUrl || '';
    // 背景节点始终建出来，哪怕暂时没图 —— 游戏库那边要异步去平台快照里
    // 取横版大图，到时候直接往这个节点上贴，不用重渲染整个 Hero。
    const bgNode = el('div', {
      // 只有竖版封面可用时才加大模糊，横版大图本来就适合铺满
      class: 'pfd-hero-bg' + (o.heroUrl || !bgSrc ? '' : ' is-blurred'),
      style: bgSrc ? { backgroundImage: `url("${bgSrc}")` } : {}
    });
    hero.appendChild(bgNode);
    hero.appendChild(el('div', { class: 'pfd-hero-veil' }));

    /* 竖版封面 */
    const coverBox = el('div', { class: 'pfd-cover' });
    applyGradient(coverBox, o.title);
    if (o.coverUrl) {
      const img = el('img', { src: o.coverUrl, alt: '', class: o.coverIcon ? 'as-icon' : '' });
      // 图挂了（缓存被清 / 文件被删）就删掉，露出底下的渐变+首字母
      img.addEventListener('error', () => img.remove());
      coverBox.appendChild(img);
    } else {
      coverBox.appendChild(el('div', { class: 'pf-ph', text: initialOf(o.title) }));
    }

    const statline = stats(o.stats);

    hero.appendChild(el('div', { class: 'pfd-hero-inner' }, [
      coverBox,
      el('div', { class: 'pfd-head' }, [
        el('div', { class: 'pfd-title', text: o.title }),
        statline,
        tags(o.tags)
      ].filter(Boolean))
    ]));
    panel.appendChild(hero);

    if (o.onClose) {
      panel.appendChild(el('button', {
        class: 'detail-close', text: '×', title: '关闭 (Esc)', onclick: o.onClose
      }));
    }

    /* ---------- 操作条 ---------- */
    const bar = el('div', { class: 'pfd-bar' });
    panel.appendChild(bar);

    /* ---------- 正文区 ---------- */
    const body = el('div', { class: 'pfd-body' });
    panel.appendChild(body);

    /**
     * 后补/替换 Hero 背景图。
     * @param {string} url
     * @param {boolean} [blur] 传 true 表示这是竖版封面，要加大模糊
     */
    function setHeroBg(url, blur) {
      if (!url || !bgNode.isConnected) return;
      bgNode.style.backgroundImage = `url("${url}")`;
      bgNode.classList.toggle('is-blurred', !!blur);
    }

    return { panel, hero, bar, body, statline, coverBox, setHeroBg };
  }

  /**
   * 往操作条里塞按钮。null / false 会被跳过，方便按条件拼装。
   * @param {HTMLElement} bar
   * @param {Array<Node|null>} items
   */
  function fillBar(bar, items) {
    for (const it of (items || [])) {
      if (!it) continue;
      bar.appendChild(it);
    }
    return bar;
  }

  /** 操作条右侧的说明文字 */
  function barMeta(text) {
    return el('span', { class: 'bar-meta', text });
  }

  /** 操作条里的弹性空隙，把后面的东西推到最右 */
  function spacer() {
    return el('span', { class: 'spacer' });
  }

  /* ================================================================
   *  可收起的区块
   * ================================================================ */

  /**
   * @param {string} key       唯一 key，用来记住收起状态（两个详情页共用）
   * @param {string} title     区块标题
   * @param {Node}   content   正文
   * @param {string} [note]    标题右侧的灰色小字补充
   */
  function section(key, title, content, note) {
    const isCollapsed = collapsed.has(key);
    const sec = el('div', { class: 'pfd-sec' + (isCollapsed ? ' collapsed' : '') });

    const btn = el('button', { class: 'pfd-sec-toggle', text: isCollapsed ? '展开' : '收起' });
    const head = el('div', { class: 'pfd-sec-head' }, [
      el('span', { class: 'pfd-chev', text: '▼' }),
      el('div', { class: 'pfd-sec-title', text: title }),
      note ? el('span', { class: 'pfd-sec-note', text: note }) : null,
      btn
    ].filter(Boolean));

    head.onclick = () => {
      const now = !collapsed.has(key);
      if (now) collapsed.add(key); else collapsed.delete(key);
      sec.classList.toggle('collapsed', now);
      btn.textContent = now ? '展开' : '收起';
    };

    sec.appendChild(head);
    sec.appendChild(el('div', { class: 'pfd-sec-body' }, [content]));
    return sec;
  }

  /* ================================================================
   *  键值网格
   * ================================================================ */

  /**
   * @param {Array<[string, string, ('dim'|'path'|true|false)?, string?]>} cells
   *        每项 [标签, 值, 样式, 悬停说明]；样式 true=次要(dim)、'path'=等宽路径。
   *        第 4 项传了就用它当 title（比默认的"把值本身再显示一遍"有用得多，
   *        比如游玩时长那一格要说明"这个数字是 GameHub 记的还是 Steam 记的"）。
   */
  function kv(cells) {
    return el('div', { class: 'pfd-kv' },
      (cells || []).map(([k, v, cls, hint]) => el('div', { class: 'pfd-kv-cell' }, [
        el('div', { class: 'pfd-kv-k', text: k }),
        el('div', {
          class: 'pfd-kv-v' + (cls === true ? ' dim' : cls === 'path' ? ' path' : ''),
          text: v,
          title: hint || String(v)
        })
      ]))
    );
  }

  /* ================================================================
   *  图片预览行（竖版封面 / 横版大图 / 标志）
   * ================================================================ */

  /**
   * @param {Array<{label:string,url?:string,width?:number}>} items
   */
  function arts(items) {
    const wrap = el('div', { class: 'pfd-arts' });
    for (const it of (items || [])) {
      const box = el('div', { class: 'pfd-art-item' }, [
        el('div', { class: 'pfd-art-label', text: it.label })
      ]);
      const imgBox = el('div', {
        class: 'pfd-art-box',
        style: { width: (it.width || 140) + 'px' }
      });
      if (it.url) {
        const img = el('img', { src: it.url, alt: '' });
        img.addEventListener('error', () => {
          imgBox.innerHTML = '';
          imgBox.appendChild(el('div', { class: 'pf-ph', style: { height: '80px' }, text: '无' }));
        });
        imgBox.appendChild(img);
      } else {
        imgBox.appendChild(el('div', { class: 'pf-ph', style: { height: '80px' }, text: '无' }));
      }
      box.appendChild(imgBox);
      wrap.appendChild(box);
    }
    return wrap;
  }

  /* ================================================================
   *  成就进度
   * ================================================================ */

  /**
   * @param {{unlocked:number,total:number}} a
   * @param {string} [note] 底部灰色说明
   */
  function achBar(a, note) {
    const pct = a.total ? Math.round((a.unlocked / a.total) * 100) : 0;
    return el('div', {}, [
      el('div', { class: 'pfd-ach-head' }, [
        el('span', { text: `${a.unlocked} / ${a.total}` }),
        el('span', { class: 'pfd-ach-pct', text: `已完成 ${pct}%` })
      ]),
      el('div', { class: 'pfd-ach-bar' }, [
        el('div', { class: 'pfd-ach-fill', style: { width: Math.max(pct, 2) + '%' } })
      ]),
      note ? el('div', { class: 'pfd-ach-note', text: note }) : null
    ].filter(Boolean));
  }

  window.DetailKit = {
    stat, stats, pruneEmpty, slot,
    tags,
    skeleton, fillBar, barMeta, spacer,
    section,
    kv,
    arts,
    achBar,
    /** 给调试/自测用：当前有哪些区块是收起的 */
    collapsedKeys: () => Array.from(collapsed)
  };
})();
