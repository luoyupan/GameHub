# 更新日志

本项目所有版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.2.0] - 2026-10-07

### 结论：Cloudflare 人机验证 —— 复制 cf_clearance 也过不去，功能搁置

主人实测把 `cf_clearance` 粘进 🛡 面板后依然被拦 —— 符合预期的风险：
那张通行证绑定的不只是 IP，还有完整浏览器指纹。内嵌浏览器与真实 Chrome
在指纹层面差异太多，单搬一个 cookie 骗不过 Cloudflare。

**现状**：内嵌浏览器浏览 N 网可以（1.1.4 的 Client Hints 修正让它不再被
额外刁难），但人机验证过不去。MOD 下载的替代链路见下面的「快速导入」。
此问题留待以后有更好的方案再解（详见技术文档 13.8）。

### 新增：⬇ 快速导入 MOD

MOD 管理工具行新增「⬇ 快速导入」：弹一个对话框，**把下载好的 mod 拖进去就行** ——
- zip 压缩包自动解压（自动识别"包了一层目录"的结构）
- 文件夹原样搬进该游戏的 MOD 目录（目录按 MOD 规则引擎自动判定）
- 单文件 mod（.pak 之类）直接复制
- 7z / RAR 明确告知暂不支持，绝不静默失败
- 同名自动加后缀，绝不覆盖；不支持拖拽时可用文件选择框多选
- 拿拖入路径走 `webUtils.getPathForFile`（Electron ≥32 的 File 已没有 .path）

### 新增：🧮 对齐工具（打包 + MOD 码）

MOD 管理工具行新增「🧮 对齐」，弹窗里三件事：

1. **📦 快速打包** —— 把这款游戏的全部 mod（含创意工坊的）压成一个 zip，
   保存位置自选；zip 打包器是零依赖手写的（`main/zipwrite.js`），
   有「打包 → 解压 → 逐字节比对」的往返测试
2. **🔢 MOD 码** —— 按 mod 名称+数量生成 `GHMOD1-<数量>-<crc>-<…>` 短码，
   发给朋友；生成是**确定性的**（同一份清单任何机器生成同一个码），
   带自校验（复制漏尾巴/被改动直接报码无效）
3. **📥 对比** —— 粘别人的 MOD 码，立刻列出「❌ 你缺少的」「➕ 你多出的」，
   对比时忽略大小写 / 全角括号 / 多余空格

### 测试

- 新增 `tools/modport-test.js` 12 项：zip 往返、拖入规划、码往返/篡改/对比
- `npm test` 全量 287 项全绿

---

## [1.1.6] - 2026-10-07

### 修复：验证通行证支持纯值粘贴

DevTools 的「Cookie Value」框复制出来的只有值、没有 `cf_clearance=` 前缀 ——
旧解析会报"没解析出可用的 Cookie"。现在纯值直接当作 cf_clearance 处理。

---

## [1.1.5] - 2026-10-07

### 修复：「点 N 网"直接打开浏览器了"」—— 浮层误触发

主人的原话：点 N 网找找变成直接打开浏览器，不是之前嵌在 MOD 面板里的样子。

**根因（探针 `tools/dev/probe-nexus.js` 真机复现确认）**：内嵌链路本身没坏 ——
点「N 网」面板照样嵌在 MOD 区块里。坏在 v1.1.3 的一个过度敏感的交互：
**按住浏览器工具条的空白处也会把面板浮出去**。点工具条按钮时指尖稍微
偏到按钮之间的缝隙，面板就"嗖"地浮出成一个独立浏览器窗口的样子 ——
看起来就是"直接打开浏览器了"。

**修复**：内嵌态下点/拖工具条空白**不再浮出**；想变大请拖右下角 **◢** 抓手
（或双击抓手 / 点 ⤢ 铺满）。浮层态下拖工具条空白仍可移动位置。

已用探针验证：点 N 网 → 内嵌正常；对工具条空白派发 pointerdown → 仍是内嵌态。

### 测试

- npm test 274 项全绿

---

## [1.1.4] - 2026-10-07

### 修复：Cloudflare 人机验证过不去（附一条确定的出路）

现象：N 网点开就卡在「请稍候… / Just a moment…」，转圈不放行。

**根因（用 `tools/dev/cf-probe.js` 实测出来的，不是猜的）**：我们为了躲
Cloudflare 对 Electron UA 的发难，把 UA 清洗成了普通 Chrome；但 Electron 发出的
Client Hints 还是自己的 ——

```
navigator.userAgentData.brands = [ {Not?A_Brand,99}, {Chromium,130} ]   ← 没有 Google Chrome
sec-ch-ua: "Not?A_Brand";v="99", "Chromium";v="130"
User-Agent: ... Chrome/130.0.6723.191 ...                                ← 却自称 Chrome
```

「自称 Chrome 但 brands 里没有 Google Chrome」正是 Cloudflare 判定
「伪装浏览器 / 自动化」的强特征。

**做了两层修正**（版本号统一取 `process.versions.chrome`，避免 UA 与 CH 各说各话）：

1. 请求头层：`session.webRequest.onBeforeSendHeaders` 补齐 `sec-ch-ua` 系列
2. 页面 JS 层：走 CDP `Page.addScriptToEvaluateOnNewDocument` 在**主世界**覆盖
   `navigator.userAgentData`（preload 是隔离世界，改不到页面的 navigator）

**但实测仍过不去** —— 等 60 秒依旧停在验证页、cookie 为空。Cloudflare 对
Electron 的识别不止 Client Hints 一项，靠伪装很难彻底解决。所以补了一条
**确定的出路**：

- 工具条新增 **🛡** 按钮；撞上验证页时**自动展开**引导
- 按引导在系统浏览器里过验证 → F12 复制 `cf_clearance` → 粘回输入框 →
  写入内嵌 session 并刷新，之后下载接管 / MOD 自动落位照常可用
- 支持粘单条 `cf_clearance=xxx`，也支持整串 Cookie（控制属性会自动剔除）

### 测试

- 新增 `tools/dev/cf-probe.js`：真机读一遍浏览器指纹（WebGL / UA / userAgentData /
  webdriver / plugins），并判定是否被 challenge —— 以后再遇到"过不去"不用靠猜
- `npm test` 274 项全绿（浏览器服务契约测试 17 → 20：Client Hints 头自洽、
  setCookie 解析与拒绝各 1~2 项）

---

## [1.1.3] - 2026-10-07

### 变更：内嵌浏览器可自由拖动变大

MOD 管理里的 N 网面板之前固定 520px 高，看论坛列表、对比 MOD 页面都很憋屈。现在：

- **右下角抓手（◢）按住往外拖** —— 面板直接浮出文档流变成浮层，
  自由缩放大小、拖工具条空白处还能移动位置，想拖多大拖多大
- **双击抓手 / 工具条 ⤢ 按钮** —— 一键铺满整个软件窗口；再点 ⇲ 收回内嵌
- 浮出后原位置留一条「🌐 浏览器已浮出 · 点此收回」占位，不会找不到面板

实现上的两个关键约束（都写进了代码注释）：

1. **绝不 reparent** —— webview 被移出 DOM 就销毁重载，浮层化只改
   同一个节点的 `position:fixed` + 内联几何；祖先链没有 transform/filter，
   fixed 的包含块就是视口。
2. **拖拽要盖罩** —— webview 是独立进程、鼠标事件不冒泡，拖拽经过网页
   会丢 pointermove；拖拽期间给 stage 盖一层透明罩（`.bh-dragging`）。

### 附带

- 导航栏标签页形态不提供浮层（本身就占满内容区），`floatable:false` 关掉

### 测试

- npm test 271 项全绿（改动仅渲染层，主进程契约不受影响）

---

## [1.1.2] - 2026-10-07

### 变更：N 网浏览器嵌进 MOD 管理面板

导航栏标签页还是"跳出去了"，太突兀 —— 现在点 MOD 管理里的「🌐 N 网」，
浏览器**直接在区块里就地展开**（占据 MOD 列表的位置），点「收起 N 网」恢复列表。

- 面板内嵌在详情弹窗内部，侧栏与弹窗结构完全不动
- 工具条内嵌：后退 / 前进 / 刷新 / 地址栏 / 外部打开 +「MOD 将下载到」徽标
- 下载进度条显示在面板顶部；落点与解压结果仍由主进程 toast
- 换游戏自动收起；排序 / 刷新导致的重绘会自动恢复上次浏览的地址

### 修复：N 网白屏（三个叠加的根因）

1. **主窗口没开 `webviewTag`** —— `<webview>` 标签整个是死的，
   露出面板的白色底，看起来就是"网页打不开"。**这是白屏的主因。**
2. **`src` 在 webview 挂进 DOM 之前设置** —— 初始导航被丢弃，停在 about:blank。
   现在严格"先挂载、后导航"。
3. **`nodeintegration="false"` 属性会打开 Node 集成** ——
   布尔属性只看存在与否，不看值；这是一个安全洞，已删除（默认即关闭）。

### 加固

- UA 清洗：去掉 `Electron/x.y` 尾巴伪装成普通 Chrome（N 网这类 Cloudflare 站点对 Electron UA 不友好）
- 加载失败 / 渲染进程崩溃 → 显示**错误页 + 重试按钮 + 用系统浏览器打开**，绝不白屏装死
- 内嵌模式下 `mod:browse` 也在浏览器服务里登记标签，下载归属不断链；
  收起面板时同步关掉标签

### 测试

- 真机验证 9/9（含 UA 清洗确认：请求头已无 Electron 标识）
- npm test 271 项全绿；selftest 55 项全绿

---

## [1.1.1] - 2026-10-07

### 变更：内置浏览器改为导航栏标签页

v1.1.0 的内置浏览器是独立弹窗，实际用下来不合适 ——
**浏览器不再弹窗，直接集合进主界面顶部导航栏**：

- 点「N 网找找」在「游戏库 / 游戏平台」旁边插入一个「🌐 标题 ✕」标签
- 浏览器页面盖在内容区上，侧栏保持可见；点侧栏或「游戏库」即收回，标签保留
- 支持同时开多个标签，切换不丢页面状态
- 工具条内嵌在内容区顶部：后退 / 前进 / 刷新 / 地址栏 / 外部打开 +「MOD 将下载到」徽标 + 下载进度条

### 修复

- **下载归属反查失效**：`WebContents` 的 id 是**属性 `wc.id`**，
  没有 `getId()` 方法 —— 原代码调 `getId()` 抛 TypeError 被吞掉，
  下载拿不到归属（会被当成"认不出游戏"退化成询问）。
- **主页面 CSP 拦截远程页面**：`default-src 'self'` 会挡住 webview，
  补 `frame-src https: http:`。
- 主窗口 webPreferences 显式开启 `webviewTag`。

### 移除

- 独立弹窗形态相关文件：`preload-browser.js`、`src/renderer/browser.html`、
  旧 `js/browser.js`（工具条逻辑并入 `js/browserview.js`）

### 测试

- 浏览器服务契约测试重写为标签页形态 **17 项**（归属反查 / 下载落点 / 事件分发）
- 真机验证 9/9：标签 → guest 登记 → 下载接管 → 归属 tabId → 落点 → 自动解压
- 回归：npm test 271 项全绿，selftest 55 项全绿

---

## [1.1.0] - 2026-10-07

### 新增：内置浏览器 + MOD 下载接管

点「N 网找找」不再丢给系统浏览器，而是在**软件内**开一个浏览器窗口，
下载被 GameHub 接管，直接落到这款游戏的 MOD 目录并按需自动解压。

- **内置浏览器窗口**：自绘工具条（后退 / 前进 / 刷新 / 地址栏 / 外部打开）+ 下载进度条
- **常驻「MOD 将下载到」提示**：点下载之前就能确认目录对不对
- **MOD 下载目录设置**：三种模式
  - 自动进游戏 MOD 目录（默认）
  - 固定文件夹
  - 每次问我
- **下载完自动解压**：支持 zip；7z / rar 提示就地手动解压
- **每款游戏可手动指定 MOD 目录**：MOD 页面新增「📂 指定 MOD 目录」按钮，
  设置里可查看与取消已指定的
- **规则引擎覆盖约 70 款游戏**（Steam AppID 精确匹配 + 名称关键词 + 目录探测兜底）

#### MOD 目录规则（联网查证）

放错目录**不会报错，只会静默失效**，所以这些反直觉的规则是本功能的重点：

| 游戏 | 目录 | 易错点 |
|---|---|---|
| 老滚 5 / 辐射 4 / 湮灭 | `Data` | **不是** `Mods` |
| 巫师 3 | `mods/mod<名字>` | 文件夹名必须以 `mod` 开头 |
| 赛博朋克 2077 | `archive/pc/mod` | |
| 艾尔登法环 | `Game/mod` | |
| 黑神话悟空 / 幻兽帕鲁 | `b1/Content/Paks/~mods` · `Pal/Content/Paks/~mods` | |
| 怪猎 | `nativePC` | |
| 博德之门 3 | `%LOCALAPPDATA%\Larian Studios\Baldur's Gate 3\Mods` | 不在游戏目录 |
| 我的世界 | `%APPDATA%\.minecraft\mods` | 同上 |
| 骑马与砍杀 2 | `Modules` | 不是 `Mods` |
| 无人深空 / 英灵神殿 / 城市天际线 | `GAMEDATA/PCBANKS/MODS` · `BepInEx/plugins` · `Files/Mods` | |
| 欧洲卡车 2 | `mod`（**单数**） | 在「文档」下 |

**认不出时不硬猜**，退化成弹窗让用户选一次。

### 架构：预留的扩展接口

浏览器服务把「开窗口」和「用浏览器」分开，上层只依赖：
`open(url, { context })` · `sendTo(id, channel, payload)` · `onReady(id)` ·
`onDownload(info)`（支持 Promise）· `onEvent(ev)` · `navigate / close / list / downloadList / cancelDownload`

以后要改成「内嵌标签页」形态，只需把 `BrowserWindow` 换成 `WebContentsView`，
上层一行都不用动。

### 安全

- 浏览器窗口用**独立 preload**（`preload-browser.js`），不是主界面那个
- `nodeIntegration: false` + `contextIsolation: true`
- 独立 session 分区 `persist:gamehub-browser`
- 只放行 http(s)；`nxm://` 交给系统；网页开新窗口一律收敛成同窗口跳转
- 解压有 Zip Slip 防护

### 修复（本功能开发过程中）

- **`<webview>` 未指定 `partition`** → 跑在默认 session 上，
  `will-download` 永远收不到，表现为「下载了但没接管」。已固定为
  `persist:gamehub-browser`
- **`webviewTag` 未启用** → 壳页面里的 `<webview>` 不生效
- **下载来自 guest webContents**，与宿主 `webContents` 不相等，
  进度事件路由全部失配 → 改为在 `did-attach-webview` 时登记 guest
- **上层没配 `onDownload` 时被当成取消** → 下载会无声消失，改为退回默认行为
- **打包清单漏了 `preload-browser.js`** → 打出的 exe 里浏览器窗口没有 preload

### 测试

- 新增 `tools/modpaths-test.js` **44 项**（规则引擎）
- 新增 `tools/unzip-test.js` **16 项**（含 4 项 Zip Slip 安全用例）
- 新增 `tools/browser-test.js` **27 项**（浏览器契约，注入假 electron）
- 真机验证 10/10：窗口 → webview → 下载接管 → 落点 → 自动解压
- 回归：parse 23 / logic 145 / mods 26 / selftest 55 全绿

---

## [1.0.0] - 2026-10-07

首个完整版本。含游戏库、外观自定义、平台集成、卸载、隐藏空间、MOD 管理与统计。

### 新增

#### 外观自定义
- 左侧栏与右侧内容区**各自独立**的背景设置
  - 图片背景：透明度 / 模糊 / 压暗 / 填充方式（cover / contain / tile / center）可调
  - 四种材质：磨砂玻璃 · 亚克力 · 玻璃 · **液态玻璃**
  - 图片会复制进数据目录，原图删了也不影响显示
- **透出桌面（系统窗口材质）**
  - 选玻璃系材质时窗口自动切换 Windows 11 系统材质，真的能看到桌面
  - 四档：自动（默认）/ 不透 / 亚克力 / 云母
  - 仅 Windows 11（build 22000+）支持
- **字体完全自定义**
  - 字体族：内置 60+ 预设 + 支持手输任意本机字体名
  - 基础字号 11~20px，全局 182 处正文级字号跟随缩放

#### 卸载游戏
- Steam → 交给 Steam 自己卸（`steam://uninstall/<appid>`）
- Epic → `com.epicgames.launcher://apps/<AppName>?action=uninstall`
- 本地 / 手动添加 → 找自带卸载器，找不到则把目录移入回收站
- 详情页与右键菜单均可进入，弹窗里让用户自己选方式并列出目录与体积

### 修复

- **背景图只铺了顶部 220px**
  `layout.css` 的 `.content::before` 原本写死 `height: 220px`（顶部柔光用），
  `appearance.css` 后加载但没声明 `height`，导致背景图只在顶部铺了 220px。
  修复：显式写 `height: auto`，实测 220px → 1132px（全高）。

- **「⋮ 更多选项」下拉菜单被游戏卡片盖住**
  根因是外观改造时给 `.content > *` 统一写了 `z-index: 1`，
  使顶栏与卡片区落到同一层级，DOM 靠后的卡片区盖住了菜单。
  修复：改为让背景用**负** z-index 沉下去，内容层完全不碰层级
  （配合 `isolation: isolate`）。已加 `elementFromPoint` 防回归检查。

- **切到材质后氛围光不出现**
  原来只在 `applyAll` 里算 `has-material`，但设置面板改材质走 `applySlot`（实时预览）。
  修复：改为 `syncAmbientFromDom()` 直接读 DOM 上的类，最不会漏。

- **GPU 进程崩溃导致黑屏**
  部分显卡驱动下 Electron 的 GPU 合成进程会 FATAL 退出
  （`exit_code=-1073741819` → `GPU process isn't usable. Goodbye.`），
  且崩溃发生在 `app.whenReady()` 之前，JS 层来不及补救。
  修复：默认软件渲染 + 三层兜底（环境变量强制 / RDP 会话降级 / 崩溃写标记下次自动降级）。

### 变更

- 材质不透明度整体上調，解决「像个透明窟窿」的观感问题：

  | 材质 | 改前 | 改后 |
  |---|---|---|
  | 磨砂玻璃 | 0.50 | 0.86 |
  | 亚克力 | 0.42 | 0.78 |
  | 玻璃 | 0.32 | 0.66 |

  同时每种材质叠加纵向高光层 + 内嵌高光边。
- 压暗遮罩从匀色改为**纵向渐变**（顶部护标题、中部留出图、底部护状态栏）
- 图片默认值：opacity 0.55 → 0.45、dim 0.35 → 0.50
- `desktopMaterial` 语义调整：新增 `auto` / `off`，旧的 `'none'` 兼容为 `auto`

### 测试

- `parse-test` 23 项 / `logic-test` 145 项 / `mods-test` 26 项 —— 全绿
- `appearance-probe.js` 界面回归 **47 项**（含四材质逐个检查、弹出层层级、无 JS 报错）
- 新增三个透出桌面验证脚本（联动 9 场景 / 主进程三模式 / 像素级证据）

---

## 更早

- 平台嗅探（Steam / Epic / 注册表 / 自定义目录）与误报过滤
- 25 个自动分类
- 封面四级来源
- 隐藏空间（scrypt 加密）
- MOD 管理（Steam 工坊 + 本地）
- 游玩统计（5 种周期）
- 详情抽屉、右键菜单、多选批量操作
