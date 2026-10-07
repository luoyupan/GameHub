# GameHub · 本地游戏集合启动器

把散落在 Steam / Epic / 注册表 / 自定义目录里的游戏，汇成一个统一的 Steam 风格封面墙。

**完全离线优先** —— 断网时扫描、启动、分类、统计全部正常，联网只用于封面增强。

---

## 功能

### 游戏库
- **多源嗅探**：Steam（VDF 解析）/ Epic / 注册表卸载项 / 自定义目录递归，带误报过滤
- **25 个自动分类**：加权关键词匹配，中英文双语；手动改过的分类会被锁定不被覆盖
- **封面四级来源**：exe 内嵌图标 → 手动指定 → Steam 联网搜索 → 主题色占位
- **封面墙 / 列表 / 首页宽卡**三种展现，卡片大小四档可调
- **进程守护计时**：从 GameHub 启动的游戏会自动记录游玩时长与次数
- **游玩统计**：本周 / 本月 / 本季 / 今年 / 全部，按类型与游戏拆分

### 外观自定义
- **左右两栏独立背景**：各自可用自己的图片（透明度 / 模糊 / 压暗可调），或四种材质
  - 磨砂玻璃 · 亚克力 · 玻璃 · **液态玻璃**（有体积感的四层光）
- **透出桌面**：选玻璃系材质时窗口自动切换 Windows 11 系统材质，**真的能看到桌面**
  - 想一直透可固定「亚克力 / 云母」，想完全不透选「不透」
- **字体完全自定义**：字体族（内置 60+ 预设 + 可手输）+ 基础字号 11~20px，全局生效

### 平台集成
- **平台总览**：逐个平台检测「装没装 / 登没登录」，点进去看它的库
- **Epic 登录**：可读取已购游戏全清单（**含领了但没下载的**）与官方封面
- **MOD 管理**：Steam 创意工坊 + 本地 MOD，支持启用 / 禁用 / 删除

### 数据与隐私
- **隐藏空间**：scrypt 加密，未解锁时界面拿不到任何条目内容，闲置自动上锁
- **卸载游戏**：Steam / Epic 走各自平台卸载；本地游戏找自带卸载器，否则移入回收站
- **只读承诺**：读取平台数据时严格只读，从不写回；绝不读取或保存任何密码 / 令牌

---

## 快速开始

```bash
npm install     # 安装依赖
npm start       # 开发运行
npm test        # 跑测试（23 + 145 + 26 项）
npm run dist    # 打出便携版 exe
```

产物：`dist/GameHub-1.0.0-便携版.exe`（单文件，双击即用）

### 环境要求

- Windows 10/11（**透出桌面功能需要 Windows 11，build 22000+**）
- Node.js 22+（仅开发需要）

---

## 开发

```bash
# 自检：无界面跑一遍扫描流程
electron . --selftest

# 探针：在页面里跑一段脚本并打印结果
electron . "--probe=JSON.stringify(document.querySelector('.content').getBoundingClientRect())"

# 界面回归（需先带 --remote-debugging-port 启动应用）
electron . --remote-debugging-port=9700
node tools/appearance-probe.js 9700        # 47 项
node tools/verify-material-link.js 9700    # 材质 ↔ 透出桌面 联动 9 场景
```

完整架构、模块说明、数据模型与踩坑记录见 **[docs/技术文档.md](docs/技术文档.md)**。

---

## 项目结构

```
main.js / preload.js          主进程入口与 API 白名单
src/main/                     业务模块（store / scanner / cover / launcher …）
src/renderer/                 前端（零框架，原生 HTML/CSS/JS）
tools/                        正式测试与验证脚本
tools/dev/                    一次性调试探针（不进仓库）
docs/                         技术文档与更新日志
```

---

## 关于 Epic 客户端凭据

源码里的 `CLIENT_ID` / `CLIENT_SECRET` 是 Epic **启动器本体**的公开客户端标识（开源社区 Heroic / Legendary 等普遍这样用），**不是任何人的账号密码**，也不含任何用户数据。

不需要改代码即可覆盖：

```bash
GAMEHUB_EPIC_CLIENT_ID=xxx GAMEHUB_EPIC_CLIENT_SECRET=yyy npm start
```

用户的登录 token 存在 `userData/epic-auth.json`，用 Electron `safeStorage` 加密（Windows 上走 DPAPI，密钥绑当前用户账户）。

---

## 已知限制

- **透出桌面**依赖 Windows 11 的 DWM 合成，Windows 10 及以下静默忽略
- **Epic 没有**开放面向第三方的玩家数据 API —— 能拿账号信息与已购清单，拿不到累计时长与成就
- 部分显卡驱动下 Electron 的 GPU 进程会崩溃，程序会自动降级到软件渲染（见技术文档 15.1）

---

## 许可

[MIT](LICENSE)
