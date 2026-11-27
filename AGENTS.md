# Novel 项目架构设计与开发规范

本文档描述 Novel 项目的架构设计、模块划分、依赖关系与开发规范，供所有开发者（含 AI 会话）遵循。

本项目是小说创作桌面应用（起始版本 1.0.0），由单一业务独立成库而来：**只有一个构建形态**，NovelWindow 即主窗口；
多版本 / 窗口变体机制已整体移除，不要再按「某版本才有某窗口」的思路写代码。

> ⚠️ 开工前先确认 §6.7 的「架构重构开关」：novel 的存储与前端结构是否允许从零重构，由其中 `novelArch` 决定（默认 `compat`＝必须兼容）。

## 0. 铁律速查

违反任意一条即视为缺陷，详细的「为什么」在各节：

| # | 铁律 | 节 |
|---|---|---|
| 1 | 一个独立窗口 = `src/windows/XxxWindow/` 一个目录，**窗口之间禁止互相导入** | §2.2.0 |
| 2 | 窗口清单唯一事实源 `electron/window-entries.ts`；主窗口恒为 NovelWindow | §2.2.0 |
| 3 | `main.ts` 只做窗口 / 托盘 / 协议 / 窗口级 IPC，**业务 IPC 一律进 `handlers/<域>/`** | §2.1 |
| 4 | 四本库各走各的通道：宿主 `auth.db`+`user.db` / `novel.db` / `map.db` / `ai.db`，**不许跨库写** | §2.1、§6.5 |
| 5 | 业务样式只写 `var(--app-*)`，**禁止硬编码色值**（含 TSX 内联样式） | §6.1.1 |
| 6 | **UI 一律用组件库**；覆盖外观只改组件级 CSS 变量，不写 `:hover` 属性规则 | §6.1.2 |
| 7 | 子组件样式就近放组件目录 `index.scss`，严禁上移到父级 | §6.1 |
| 8 | `font-size` ≥12px、禁小数、尽量偶数 | §6.1 |
| 9 | 提示词只有 `src/shared/ai/context/prompt/` 一个产地，业务组件禁手拼 system | §2.2.2.1 |
| 10 | 测试文件与被测源码**同级**，禁建 `tests/` / `guards/` 平行目录 | §6.6 |
| 11 | 默认只跑改动面，**不许顺手全量**；命中 B 类越界才 `pnpm test` | §6.6 |
| 12 | CHANGELOG 只写「新增 / 修改 / 删除」三类，单行、≤80 字 | §8.6 |
| 13 | 新增用户可见功能必须同步帮助手册，否则 `guide-doc.test.ts` 红 | §8.9 |
| 14 | 浮层要避开 34px 拖动带（`-webkit-app-region: drag`），并补进 no-drag 组与守卫 | §6.1.2 |
| 15 | **状态库只用 Zustand**：跨组件共享、或业务复杂到多 `effect` 依赖产生闭包陷阱时**优先建 store**；但**一个功能模块一个独立 store，禁止大而全 store** | §2.2.1.1、§6.2 |
| 16 | 窗口 / 特性裁剪只有一个入口：`src/shared/feature-registry.ts` 注册表；**禁止**再引入版本号 / 形态名式裁剪 | §6.9 |

---

## 1. 全局架构概览

Electron 双进程：渲染进程（React）↔ IPC ↔ 主进程（Node），主进程独占系统资源与数据持久化。

### 1.1 分层

```text
渲染进程
├─ Windows      一个子目录 = 一个独立窗口（Novel 主窗 + Login / Settings / Pack /
│               GlobalSetting / Relation / Map 六个子窗）
├─ Pages        仅 NovelWindow：Bookshelf / Novel / RecycleBin（视图状态切换，无路由）
├─ Hooks        页面业务编排（useXxxPage / useXxxData / useXxxEditorState / useXxxViewState）
├─ Services     语义化数据访问（封装 IPC，不内联 SQL、不 import React）
├─ Shared       跨窗口共享：components / services / novel / ai / theme / styles / shortcuts / types
└─ IPC Bridge   window.electronAPI（preload contextBridge 白名单）

主进程
├─ main.ts      窗口生命周期、托盘、协议、窗口级 IPC
├─ window-entries.ts  窗口入口清单（唯一事实源）
├─ core/        宿主库 db.ts、logger、user-paths、app-protocol-cache、httpSession、window/
├─ handlers/    语义化 IPC：novel / map / ai / system
└─ 各域库       novel/novel-db.ts、map/map-db.ts、ai/ai-db.ts
```

### 1.2 核心原则

1. **进程隔离**：渲染进程不碰文件系统与网络凭据，一切经主进程通道。
2. **用户数据隔离**：每个账号一套 SQLite，落在 `user-data/{email-hash}/`。
3. **窗口隔离**：窗口自带 HTML / 入口 TSX / 私有页面，跨窗口能力只能经 `shared/` 或 IPC。
4. **模块自治**：页面拥有自己的组件、样式与业务逻辑，禁止跨页面耦合。
5. **样式就近**：子组件样式与组件文件同级。

---

## 2. 模块边界与职责

### 2.1 主进程（`electron/`）

**按业务域分目录，禁止把源码平铺在 `electron/` 根下**：

| 目录 | 放什么 | 约束 |
|---|---|---|
| 根 | `main.ts` / `preload.ts` / `window-entries.ts` | **只留这三个**：vite `entry` 与 `package.json` 的 `main` 绑死在这里，移动即断启动 |
| `core/` | `db.ts`（宿主库连接）、`logger.ts` / `log-format.ts`、`user-paths.ts`、`app-protocol-cache.ts`、`httpSession.ts` | 不含任何单一业务域的表与规则 |
| `core/window/` | `windowManager.ts` / `window-pending.ts` / `window-send-options.ts` / `close-guard.ts` | 不含业务 IPC |
| `novel/` | `novel-db.ts` / `novel-template.ts` / `novel-safety-utils.ts` / `novel-links-events.ts` | 不 import 其它域的库 |
| `map/` | `map-db.ts` / `map-utils.ts` | 不 import 其它域的库 |
| `ai/` | `ai-db.ts` / `ai-stream-token.ts` | 模型调用实现放 `handlers/ai/` |
| `handlers/<域>/` | IPC handler，分 `novel/` `map/` `ai/` `system/` 四组 | 业务纯函数提到对应域目录，便于单测 |
| 测试 | **与被断言源码同级**（`*-guard.test.ts` 也算）：断言 handler 就放该 handler 目录，断言 `main.ts` / `preload.ts` / 仓库配置就放根 | 禁止建 `guards/` / `tests/` 平行目录 |

**模块职责**：

| 模块 | 职责 | 边界 |
|---|---|---|
| **main.ts** | 窗口生命周期、IPC 注册入口、托盘、启动流程 | 只处理窗口与系统级操作，不含业务逻辑 |
| **window-entries.ts** | 窗口入口清单（入口 key / HTML 相对路径 / 打包清单 / 主窗口） | vite 构建期与主进程运行期共用；新增窗口只改这里 |
| **handlers/** | 按域注册的语义化 handler（`novel/` 9 个、`map/` 1 个、`ai/` 2 个、`system/` 4 个；`novel-setting-shared.ts` 为复用件非注册入口），持有预定义 SQL | 一个文件一个模块；SQL 只出现在 handlers 与各域库 |
| **preload.ts** | `contextBridge` 暴露白名单 API | 只转发，不实现业务 |
| **core/db.ts** | 宿主库初始化（authDb → `auth.db`，userDb → `user.db`）、通用 CRUD、用户库生命周期广播 | **只建 `user` 与 `config` 两张表**，不建 `novel_*` / `map_*` / `ai_*` |
| **novel/novel-db.ts** | `novel.db` 初始化与 CRUD（`novel_*` / `novel_pack_*` / `novel_config` / `novel_usage_log`），挂 `registerUserDbLifecycle()` | 单向依赖 `core/db.ts`；novel handler 只从这里取写通道 |
| **map/map-db.ts** | `map.db` 初始化与 CRUD（`map_docs` / `map_revisions` / `map_assets` / `map_config`）+ `getMapAssetsDir()` | 与 novel.db 平级、互不 import；`map-handlers` 只从这里取通道 |
| **map/map-utils.ts** | 地图存档纯函数（标题归一 / rev 冲突 / 快照节奏 / 视口解析 / 缩略图） | 无 IO，可在 vitest 直接跑 |
| **core/window/windowManager.ts** | 窗口池：注册 / 注销 / 广播 / 定点发送 | 只管 BrowserWindow，不感知业务 |
| **novel/novel-links-events.ts** | `novel_links` 变更的**唯一广播出口**（`broadcastLinksChanged` + `workIdOfEntity`） | 只填 delta、不写库；事件名只在这里出现一次 |
| **handlers/novel/novel-export-handlers.ts** | 导出 PNG 两条通道：`relation-window-export`（`capturePage` 取景）+ `novel-export-binary`（弹框按字节落盘） | 二进制落盘**绝不复用** `novel-export-file`（那是 `writeFile(...,"utf8")`，写 PNG 会图坏且零报错） |

**边界规则**：

- 业务 IPC（user / novel / map / ai）一律抽到 `handlers/`，禁止在 `main.ts` 内联业务或 SQL。
- `core/db.ts` 不 import `main.ts`；它维护当前用户邮箱（`getCurrentUserEmail()`），业务 handler 经它定位用户目录。
- **四本库平级**：各域 handler 只能从自己的 db 模块取写通道，禁止借 `core/db.ts` 的 `dbRun` 写业务表；`core/db.ts` 只用 lifecycle 回调通知其余库切换 / 关闭，不反向 import（否则循环依赖）。由 `novel-db-split.test.ts`、`map-db-guard.test.ts` 守卫。
- `preload.ts` 只读取 `core/db.ts` 与 `main.ts` 暴露的通道。

### 2.2 渲染进程（`src/`）

#### 2.2.0 窗口层（`windows/`）

```text
src/windows/XxxWindow/
├── index.html      # 窗口入口（vite rollupOptions.input 登记）
├── main.tsx        # 入口：Provider + 窗口级 IPC 桥接
├── App.tsx         # 窗口根组件
└── (私有资源：pages/、index.scss 等)
```

| 窗口 | 职责 |
|---|---|
| **NovelWindow**（主窗口） | 书架 + 编辑器 + 设定中心 + 工具箱。登录后唤起、关闭进托盘；数据在 `novel_*`，崩溃恢复由会话标记驱动 |
| **LoginWindow** | 登录 / 欢迎窗口 |
| **SettingsWindow** | 全局设置（左分类导航 + 右内容页，固定 900×680，分区：外观 / AI 配置 / 快捷键 / 个人资料 / 账号 / 诊断），即关即销、单实例；页面清单唯一事实源是 `settings-pages.tsx` 的 `buildPages()` |
| **PackWindow** | 行囊独立窗口，承载 `shared/components/CharacterPack`；上下文经 `pack-window-context` / `novel-work-changed` 投递 |
| **GlobalSettingWindow** | 全局设定中心，复用 `shared/components/SettingCenter`（`source="global"`）；数据全在主进程 |
| **RelationWindow** | 人物关系网络（池子 + 力导向画布 + 详情卡）；画布记忆存 `novel_config` 单键，写关系走 `novel-graph-commit` 单事务并广播 `novel-links-changed` |
| **MapWindow** | 地图编辑器；**关窗前先 flush 存档**（主进程拦 `close` → 取快照 → `map-doc-flush` → 回执 → 1.5s 兜底）；数据在 `map.db`，`work_id` 可空 |

**窗口入口清单**：唯一事实源 `electron/window-entries.ts`（`RENDERER_ENTRY_PATHS` / `WINDOW_ENTRIES` / `PRIMARY_WINDOW_ENTRY`），vite `rollupOptions.input` 与主进程装载共用。**只有一个构建形态**，所有登记窗口默认都参与打包；唯一例外是 `map`（地图窗口）可经构建期开关 `NOVEL_WITH_MAP=0` 整条裁掉，见 §6.9。

**窗口边界**：

- 窗口之间**禁止互相导入**（如 LoginWindow 不得 import NovelWindow 的任何内容）。
- 新增窗口：建 `src/windows/XxxWindow/` → 在 `window-entries.ts` 登记路径并加入 `WINDOW_ENTRIES` → `main.ts` 加创建函数 → 补 `window-load-guard.test.ts` 的 `WINDOWS` 清单。
- 窗口级推送一律经 `windowManager.sendTo` 投递，渲染层不自建跨窗口通道。

#### 2.2.1 共享层（`shared/`）

**只放两个及以上窗口 / 页面复用的代码**，单使用方留在自己的目录。

| 模块 | 职责 |
|---|---|
| `components/` | 跨窗口 UI：WindowHeader（含 `leading` 插槽）、ThemeSwitcher、SettingCenter、CharacterPack、AiCandidateList、AiConsentDialog、GuideTooltip、ErrorBoundary、SvgIcon |
| `services/` | 数据访问（`novel-shared.ts`） |
| `novel/` | 小说域纯函数与常量：实体模型 / 关系图 / 设定映射 / 字数统计 / 编号 / 帮助手册（`guide-*.ts`） |
| `ai/` | AI 能力层（client / context / prompt），见 §2.2.2.1 |
| `types/` | `electron.d.ts`（`window.electronAPI`） |
| `styles/` | `themes.scss`（四套主题 `--app-*`）、`variables.scss`（SCSS 变量与 mixins，颜色变量已废弃）、`window-shell.scss`、`widget.scss`、`motion.scss`、`scrollbars.scss` |
| `theme/` | ThemeProvider（已含 antd ConfigProvider）、主题清单与存储、`useTheme` |
| `shortcuts/` | 键位注册表与解析（`registry.ts` / `keys.ts` / `keys-core.ts` / `store.ts`） |

#### 2.2.1.1 组件分层

- **全局组件**进 `src/shared/components/`；**页面私有组件**进该页 `components/`。
- **组件必须是目录**：目录内 `index.tsx` + `index.scss`，入口文件里 `import "./index.scss"`；禁止 `Component.tsx + Component.scss` 的散文件写法。
- **逻辑归位**：状态转换、表单处理、数据拉取、事件编排、缓存读写放 `hooks/` / `services/` / `store/`，组件只留最小渲染职责。
- **状态库只用 Zustand**：**跨组件共享**、或业务复杂到**多个 `effect` 依赖互相驱动产生闭包陷阱**时，优先收进 store（判据见 §6.2）；但**每个功能模块独立建 store**，禁止大而全 store —— 见 §6.2「store 划分」。

#### 2.2.2 数据服务层（`services/`）

| 模块 | 职责 | 数据来源 | 使用方 |
|---|---|---|---|
| `novel-shared.ts` | 小说域跨窗口最小依赖集（ID 生成 / 埋点 / 行囊绑定实体） | novel IPC | CharacterPack（NovelWindow + PackWindow） |

- Service 封装 IPC 并提供语义化 API（如 `addWork()`）；不含 UI 逻辑、不 import React。
- 页面经 Service 访问数据，**不直接调 `window.electronAPI.db`**。

#### 2.2.2.1 AI 服务层（`shared/ai/`）

| 文件 | 职责 |
|---|---|
| `ai-client.ts` | 唯一调用入口：`getAiConfig` / `saveAiConfig` / `testAiConnection` / `aiGenerate` / `aiGenerateStructured`；结构化解析在本层完成 |
| `context/collector.ts` | 纯函数采集 `BookSnapshot → AiBookContext`；`matchEntitiesInText` 反向命中人物卡；`buildChapterScopePayload` 按 L3 授权范围决定**实际发送哪段正文** |
| `context/prompt/` | **提示词唯一产地**：`sections.ts` 公共段落 + 各功能模板 + `registry.ts`（`PROMPT_BUILDERS` / `PROMPT_VERSIONS` / `AI_INTENT_LABELS` / `buildPromptSpec`） |
| `context/output-spec.ts` | 输出契约：`OutputFormat`（text / json-array）+ 格式指令 + 三层解析兜底 |
| `ai-types.ts` | 渲染层可见的 IPC 类型契约（与 `ai-handlers.ts` 的 DTO 一对一） |
| `ai-errors.ts` | 错误码 → 文案映射 + 「配置类错误」归类 |

**新增 AI 功能 = 新增一个 `context/prompt/xxx.ts` 模板 + 登记 4 处**（漏改都是编译错误，不靠记性）：
`PROMPT_BUILDERS`、`PROMPT_VERSIONS`（`Record<PromptIntent, string>`）、`AI_INTENT_LABELS`（同上）、`collector.ts` 的 `LIMITS`（`Record<PromptIntent, CollectLimits>`，**不要写成 `as const` 字面量**）。

- **意图联合类型只有一个产地**（`PromptIntentMap` 的键）。`collector.ts` 直接 `import type { PromptIntent }`，不要新开第二个联合类型 —— 两个必然漂移，表现为「某意图的采集上限静默取到 undefined」。
- **服务层、`ai-client`、主进程 `ai-handlers` 一行不改**；要改说明抽象漏了，先修抽象。

**L3 授权范围必须真的约束发送内容**（`scope` 不是埋点字段）：

1. `buildChapterScopePayload` 是**唯一**的「范围 → 发送正文」构造点；弹窗字数估算、实际请求、`ai_event.scope` 三处同源。
2. 「选中段落」没有选区时**拒绝发送**并明说，绝不退回整章（退回即超发）。
3. 范围要进 prompt（`SummaryIntent.scope` / `contextText`），否则模型会照常写「本章」并补出没看到的情节。
4. 守卫：`useNovelPage-consent-scope-guard.test.ts`。

**自由文本必须先过 `alignParagraphBreaks(text, original)`** 再回填：模型爱在段间插空行，多出来的空行只能由作者手删。禁止 `result.data.text.trim()` 直接回填，也禁止业务层自写一套正则收敛空行。

**铁律**：

- 功能面板只 import `shared/ai/`，不直接碰 `window.electronAPI.ai`。
- AI 服务层**不 import novel 任何模块**：上下文由调用方以纯字符串传入。
- AI 服务层**不碰 Key、不发 HTTP、不读 ai.db**：网络请求永远在主进程 `ai-handlers`（对 §8.7「主进程不代理 HTTP」的刻意豁免：凭据安全 + 端点无法枚举 + 长时流式）。
- **编辑器不感知 AI**：`EditorPane` 只暴露中性命令式 API（`insertText` / `appendText` / `replaceAll` / `replaceRange`），AI 编排留在编辑器之外的入口与 `useNovelPage`，内核里不得出现「润色 / 起名」等字样。

#### 2.2.3 页面模块（`windows/NovelWindow/pages/`）

无 react-router：视图切换由 `useEntityJumpStore` 的 `view` + `shelfScreen` 驱动，编辑器常驻保活。

| 页面 | 核心组件 | 业务逻辑 | 数据源 |
|---|---|---|---|
| **BookshelfPage** | `index.tsx` | hooks（书架数据 / 写作统计 / 灵感归属） | novel IPC |
| **NovelPage** | `NovelPage.tsx` | `useNovelData` + `useNovelPage` | novel IPC（章节正文按需取） |
| **RecycleBinPage** | `index.tsx` | hooks（列表 / 恢复 / 彻底删除） | novel IPC（trash-*） |

- 页面之间**无直接依赖**，经窗口根视图状态切换。
- 页面私有子组件**禁止**被其他页面导入；跨页面复用才提到 `shared/components/`。

---

## 3. 依赖关系与数据流向

**依赖单向**：Pages → Services → IPC → Main，禁止反向。**平级禁止**：`BookshelfPage` 不 import `NovelPage` 内部组件。

```text
保存正文：EditorPane ──debounce 800ms──▶ useNovelData ──▶ novel.saveChapter
        ──▶ novel-chapter-save ──▶ novel-handlers ──▶ novel-db ──▶ novel.db
        ◀── 更新本地快照与字数

关系提交（跨窗口）：RelationWindow ──▶ novel.graphCommit ──▶ novel-graph-handlers（单事务）
        ──▶ broadcastLinksChanged ──▶ 'novel-links-changed'（排除发送者）
        ──▶ NovelWindow 只合并 delta，不重拉全量

导出 PNG：RelationCanvas（先适应画布 + flush 坐标）──▶ windowAPI.sendTo / captureWindow
        ──▶ relation-window-export（capturePage）──▶ 回传字节
        ──▶ novel-export-binary（弹保存框，writeFile 不带 encoding）
```

---

## 4. 目录结构

```text
Novel/
├── electron/                     # 主进程（按域分目录，见 §2.1）
│   ├── main.ts / preload.ts / window-entries.ts
│   ├── core/  db.ts · logger.ts · log-format.ts · user-paths.ts
│   │          app-protocol-cache.ts · httpSession.ts · window/
│   ├── novel/  novel-db.ts · novel-template.ts · novel-safety-utils.ts · novel-links-events.ts
│   ├── map/    map-db.ts · map-utils.ts
│   ├── ai/     ai-db.ts · ai-stream-token.ts
│   └── handlers/  novel/ · map/ · ai/ · system/
├── src/
│   ├── windows/  NovelWindow（主窗）/ LoginWindow / SettingsWindow /
│   │             PackWindow / GlobalSettingWindow / RelationWindow / MapWindow
│   └── shared/   components · services · novel · ai · theme · styles · shortcuts · types
├── docs/
│   ├── README.md                 # 文档索引（唯一导航入口）
│   └── spec/                     # 活规范（见 §5.1）
├── changeLogHistory/             # CHANGELOG 历史归档（起始 1.0.0，当前无归档）
├── vite.config.ts                # input 由 window-entries.ts 生成；主进程 external 列 Node 运行时模块
└── package.json / tsconfig*.json
```

### 4.1 页面模块内部结构

逻辑 >100 行的页面：

```text
pages/XxxPage/
├── XxxPage.tsx        # 主组件（UI 渲染）
├── index.scss         # 页面级布局样式
├── xxx-utils.ts       # (可选) 纯函数
├── services/          # (可选) 页面专属数据服务（封装 IPC）
├── hooks/useXxxPage.ts
├── components/SubA/{index.tsx,index.scss}
└── store/useXxxStore.ts   # 需要状态共享时
```

---

## 5. 文档规范

### 5.1 文档存储规范（强制）

**本仓库只保留「活规范」一级**：`docs/spec/` 放长期有效、被代码或本文档直接引用、违反即缺陷的技术规则。

- 需求稿 / 预研 / 排期 / 审查 / 验收这类过程稿**不进仓库**：结论并入 `AGENTS.md`（规则）或 `CHANGELOG.md`（变更）；同一事实不留两处。
- **注释里的「需求稿 §x」「评审 Gx」只是溯源标签**：过程稿已不进仓库，这些编号没有现存文档对应，**不算悬空引用**，不需要（也不允许）为它们补建文档或改写成路径。
- 仓库根只允许四份文档：`AGENTS.md`、`README.md`（安装与排障）、`CHANGELOG.md`、`docs/README.md`（索引）。**禁止在根目录新增零散说明文件**。
- 命名：`<主题>-spec.md`，一篇一个主题。
- **每篇头部三行必填**（缺任一都无法判断是否过时）：

```md
> 状态：草案 / 定稿 / 已实施（闭环版本 X.Y.Z）
> 输入：上游依据（代码路径或 AGENTS 章节；无则写「无」）
> 基线：对应代码版本或提交哈希
```

- **改版不改名**：规则修订直接改正文并更新「基线」；整篇被推翻才新建一篇，并在同一次改动里删掉旧的。
- **移动 / 删除必须同一次改完引用**（`AGENTS.md`、`README.md`、`src/**` 注释、`*.yaml` 都算引用面），命令与判定见 `docs/README.md`；`CHANGELOG.md` / `changeLogHistory/` 里的历史路径**故意不改**。
- **索引双向**：`docs/README.md` 是唯一导航入口，新增 / 删除文档必须同步；由 `electron/docs-index-guard.test.ts` 断言（索引双向 / 头部三行 / 命名 / 无悬空 / 篇数与本文一致）。

```text
docs/                                  # 合计 8 篇 md（`docs-index-guard.test.ts` 断言此数）
├── README.md                          # 索引（唯一导航入口）
└── spec/                              # 活规范 7 篇（违反即缺陷；只改版，不删除）
    ├── graphic-theming-spec.md        # 图形素材主题化
    ├── map-db-spec.md                 # 地图数据层（改 map.db 前必读）
    ├── map-interaction-spec.md        # 地图交互与快捷键（键位 / 选中态唯一口径）
    ├── map-export-spec.md             # 地图导出
    ├── map-perf-spec.md               # 地图性能口径（产品线 / 压力线两层判据）
    ├── outline-plan-spec.md           # 大纲产品方案（草案 v6.1 refactor 版：独立走向层零绑定；事件时间轴-只有事件、**顺序只由 lane+sort 决定而位置可自由摆放**（事件卡与角色卡都能拖到画布任意处，SVG 现场画箭头保证恒为一条链）；角色非节点=事件卡内出场 chip、同一实体可多处出场且副本零连线、chip 可拖出成浮卡并用虚线牵引、拖到别的事件即改关联、一键整理清偏移+收浮卡（不动 sort）；脉络在右栏汇总；区域=事件区间派生的边界描边(XMind Boundary 式)；大纲列表同源，右页改名伏笔埋设）
    └── pack-quickcard-spec.md         # 行囊双形态改造（草案：盘点台账 / 条幅窗 / 断点重校）
```

---

## 6. 开发规范

### 6.0 TypeScript

**强类型优先，禁止 `any`**：

- 禁 `any`（含 `as any`、参数 / 返回值 `any`）；不确定的数据用 `unknown` + 类型守卫，或定义 `interface` / `type`。
- 公开导出的函数、hook、服务方法必须写明参数与返回类型。
- 避免 `ts-ignore` / `@ts-nocheck`；兼容第三方类型优先写声明文件，而不是 `any`。
- API 响应、IPC 参数、数据库返回值等外部输入**先校验再进业务**。

```typescript
// ❌ const list = records as any;
// ✅
function normalizeChapter(item: Partial<ChapterRow> | null): ChapterRow | null {
  if (!item) return null;
  return { id: item.id ?? "", title: item.title ?? "", status: item.status ?? "draft" };
}
```

### 6.1 样式

**样式就近**：子组件样式写在自己的 `index.scss`，严禁上移到父组件。

**命名**：BEM 或组件前缀，二选一并保持一致。

```scss
// BEM
.nv-chapter-node { }
.nv-chapter-node__count { }
// 前缀
.cpk-panel { }
.cpk-panel__header { }
```

**共享样式 `@use` 一律相对路径**，层级按**目录深度**算（少一层 `../` 的后果不是样式不生效，而是**整个窗口白屏** —— vite 弹 `[sass] Can't find stylesheet to import` 遮罩）：

| 文件位置 | 到 `shared/styles/widget` |
|---|---|
| `src/windows/<W>/components/<C>/index.scss` | `../../../../shared/styles/widget` |
| `src/windows/<W>/pages/<P>/components/<C>/index.scss` | `../../../../../../shared/styles/widget` |

> `tsc` / `eslint` 都不看 `.scss`，由 `src/shared/styles/scss-imports.test.ts` 静态兜住（解析相对 `@use` + 校验 `index.scss` 被同目录 `index.tsx` 引入）。新增组件目录后**务必跑一次**这份守卫。

**定高 flex 容器里的卡片必须 `flex: none`**：父级是 `height: 100%` / `flex: 1` 的 column 时，子项默认 `flex-shrink: 1`，内容一高就按比例压扁所有子项而不是滚动；子项若还带 `overflow: hidden`，最小尺寸会从 `min-height: auto` 变成 `0`，压缩没有下限 —— 表现为「卡片只剩一截、字被拦腰裁断」，**零报错**。jsdom 量不出布局，守卫见 `settings-layout-guard.test.ts`。

**同一窗口内跨分区复用的控件造型放窗口级 `styles/`**：别在每个分区各写一份（第四次改圆角时必定漏一处）。参考 `SettingsWindow/styles/settings-controls.scss` + `SettingsActionBar`，分区只挂类名；清零点 mixin 与控件变量仍须写在同一个 `.xxx.ant-btn` 选择器里（见 §6.1.2）。

**字体三条硬约束**（`.scss` / `.css` / TSX 内联样式一律适用）：

1. **≥12px**：需要更小字号（角标 / 次要说明 / 超密面板）改为 12px 起步，用颜色 / 字重 / 间距表达层级。
2. **禁小数**：不许 `12.5px` / `10.5px`，一律取整。
3. **尽量偶数**：12 / 14 / 16 / 18…；奇数 13 / 15 仅在确有视觉诉求时用，并在注释说明理由。

> 存量里仍有 11px / 10px / `*.5px`：不必一次性全量清理，但**同一模块内不得保留违规值**。

### 6.1.1 主题与换肤

**业务样式只写 `var(--app-*)`，禁止硬编码色值。** 四套主题共用一组变量（`shared/styles/themes.scss`），由 `<html data-theme>` 切换：`aurora`（默认）/ `cream` / `mint` / `midnight`（暗色，antd 走 `darkAlgorithm`）。

**接入要求**（所有窗口一致）：

1. 入口 `import "@/shared/styles/themes.scss"`，并在 `createRoot` **之前**调 `initThemeFromStorage()`（否则暗色首帧白闪）。
2. 用 `ThemeProvider` 包裹 App（内部已含 `ConfigProvider`，**不要再各包一层**）。
3. 读 / 切主题用 `useTheme()`，不要在组件里直接读 `data-theme`。

**新增主题同步 4 处**（漏一处换肤即局部掉色）：`themes.scss` 新增 `[data-theme]` 变量块（集合须与默认主题完全一致）→ `shared/theme/themes.ts` 的 `ThemeId` + `THEME_LIST`（含 antd 具体色值）→ `ThemeProvider`（暗色看 `meta.isDark`，无需改码）→ 跑 `themes.test.ts`。

> antd 的 `token` 必须传**具体色值**，不能传 `var(--app-*)` —— 它要基于色值做派生运算。

**TSX 内联样式同样禁硬编码**：`style={{ color: "var(--app-success)" }}` ✅，`"#52c41a"` ❌。

**切换入口唯一**：设置窗口「外观」分区（经标题栏设置入口到达）。`WindowHeader`、登录窗口等标题栏位置**不再放切换器**。

**允许保留的硬编码**（不要顺手优化）：`WindowHeader` 关闭按钮 `#e81123` / `#c50f1f`（Windows 标题栏惯例）；编辑器正文 `pre` 深色底（代码可读性优先）。

### 6.1.2 UI 组件库优先（强制）

**组件库（Ant Design）已提供能力的控件一律用组件库组件，业务代码禁止原生表单控件。** 这不是偏好：原生控件不跟随 `darkAlgorithm`（暗色变浅斑块），也没有键盘可达性、焦点环、禁用与 `aria` 语义，弹层与空态要自己造，每个状态还得手写一套 `hover` —— 换肤时必漏。

| 场景 | 必须使用 | 禁止 |
|---|---|---|
| 下拉选择（单 / 多选、带禁用） | `Select` | `<select>` + `<option>` |
| 文本 / 多行文本 | `Input` / `Input.TextArea` | `<input>` / `<textarea>` |
| 数值输入（步进 / 范围 / 前后缀） | `InputNumber` | `<input type="number">` |
| 任意按钮（含图标按钮、整行可点、卡片入口） | `Button` | `<button>` |
| 日期 / 时间 | `DatePicker` / `TimePicker` | `<input type="date">` |
| 弹窗 / 抽屉 / 确认 | `Modal` / `Drawer` / `Popconfirm` | 手写 `position: fixed` 遮罩 |
| 浮层提示 | `Tooltip` / `Popover` | 自建浮层 |
| 开关 / 复选 / 单选组 | `Switch` / `Checkbox` / `Radio.Group` | 原生 checkbox + 自绘圆点 |
| 分段 / 标签页 | `Segmented` / `Tabs` | 手写按钮组 |
| 折叠 | `Collapse`，或 `grid-template-rows: 0fr/1fr`（见 §6.4） | 条件渲染打断动画 |

**例外仅四种**：① 码字区 / CodeMirror（深度定制的光标、输入法与滚动）；② 镜像高亮层（输入层与高亮层需逐像素对齐）；③ 需要精确控制滚动同步的行内自适应 `textarea`；④ 「超长虚拟化列表行」（见下）。

#### 超长虚拟化列表行例外

**仅用于「行数达数千、且已虚拟化只挂载可视区」的列表行**（章节树、大纲章节视图、结果列表）。必须**同时**满足：

1. **行数确达千级**：几十行的列表不适用。
2. **已虚拟化**：行在滚动中反复 mount / unmount（每个 antd `Button` + `Tooltip` + `Popconfirm` 都带自己的 Context / Portal / 状态机）。
3. **行内控件仍受可访问性约束**：必须用语义化标签承载，键盘可达、有 `aria-*`；「不能用 `<div>` 冒充按钮」**不放开**，`<button>` 内嵌 `<button>` 照旧禁止。
4. **重浮层下沉到列表容器**：`Popconfirm` / `Tooltip` / `Modal` 这类带 Portal 与状态机的浮层，只能由容器渲染**唯一一个**（行只上报「目标 id + 锚点」）。行内的点击 / 双击 / 拖拽不强制事件委托（React 合成事件本就在根节点委托）。

**虚拟化容器必须有确定高度**（唯一硬技术约束）：`Virtuoso` 的行是绝对定位、不参与父级尺寸计算，容器只给 `max-height` 会塌成 0 —— 行在 DOM 里但渲染在 0 高盒子里，**看不见、不报错、测试也查不到**（出场列表就因此整块消失过）。尺寸只能来自显式 `height`，或 `flex: 1` + `min-height: 0`（父级必须是方向正确的确定高度容器）。守卫：`novel-ui-kit.test.ts`。

**代价与补偿**：外观在列表自己的 `index.scss` 用 `var(--app-*)` 全量声明（**这是唯一允许写 `:hover` / `:focus-visible` / `[aria-pressed]` 的地方**）；浮层提到容器层；focus 环自己写（`var(--app-primary)`）；列表自持滚动后外层要给 `overflow: hidden`，否则内外双滚动条抢滚轮。

参考实现：`ChapterTree`（容器事件委托 + 共享浮层）、`ChapterTreeItem` / `VolumeNode`（语义化行）、`OutlinePanel`（树压平 + 可变行高）、`EntityDetail` 出场列表（按行数算内联高度）。存量不要求一次全量重构，但**同一模块内不得混用**。

#### 覆盖组件库外观

1. **只改组件级 CSS 变量，不写状态属性选择器**。主题开了 `cssVar: { prefix: "ant" }` + `hashed: false`，antd 为每个组件生成私有变量、所有状态规则都读它们。antd 状态规则特异性是 (0,4,0)（如 `.ant-btn-color-default.ant-btn-variant-outlined:not(:disabled):hover`），自写 `.my-panel__cancel:hover` 只有 (0,2,0)，**永远压不过**；改变量是稳的，写属性是脆的。
2. **变量名以实际产物为准**：是 kebab-case 的 `--ant-button-*` / `--ant-input-*` / `--ant-select-*` / `--ant-switch-*`，不要照抄文档里的 camelCase token 名；拿不准用 `extractStyle` 打真实 CSS 核对。
3. **自带完整造型的控件**：仍用 `Button` 承载（拿到波纹 / 键盘 / 禁用语义 / focus 环），用 `@include widget.cpk-widget` 清零后重绘。**必须是 mixin、不能是公共类**：清零与控件变量要写在**同一个选择器**里靠源码顺序决定胜负；写成两个类会靠文件先后，而组件样式先于公共样式打包 —— 顺序正好反了，**静默失效**。
4. **`<button>` 里不许嵌 `<button>`**（HTML 不允许，浏览器拆坏 DOM，React 不报错）。「整行可点 + 行尾删除」要改成：行容器承载外观，里面放两个并列真按钮。
5. **图标走 `icon` 还是 children，间距规则不同**：用 `icon` 时 antd 包 `.ant-btn-icon`；当 children 传时间距由 `--ant-button-icon-gap` 决定，此时**不要再在 JSX 里留空格**（间距翻倍）。
6. **标签页 / 弹层的 DOM 名以当前 antd 版本为准**：v6 的 Modal 卡片是 **`.ant-modal-container`**（背景 / 圆角 / 阴影 / 内边距都在它身上），照 v5 写 `.ant-modal-content` 一条都不命中且不报错。限高 / 内部滚动前先看 `@rc-component/dialog` 的真实结构（`.ant-modal > .ant-modal-container > header / body / footer`），守卫见 `ImportTemplateModal/index.test.tsx`。
7. **弹层挂在 body 的 portal 上**：`Select` / `Tooltip` / `Popover` / `DatePicker` 的弹层样式必须写在组件根选择器之外，用 `classNames={{ popup: { root: "..." } }}` 挂类（`popupClassName` 在 antd 6.6+ 已废弃）。
8. **antd 6 的 Select 边框 / 背景画在根 `.ant-select` 上**（`.ant-select-selector` 已移除），覆盖只能改根的 `--ant-select-*` 变量；给内层 `.ant-select-content` 加 `border` 会出现双边框。
9. **浮层必须避开 34px 拖动带**：`-webkit-app-region: drag` 是 Windows 系统命中测试（`HTCAPTION`），与 z-index / 绘制层级**无关** —— 浮层画在它上面照样点不动。新增 portal 浮层要补进 `WindowHeader/index.scss` 的 no-drag 组 **+ `drag-region.test.ts` 的 `PORTAL_OVERLAYS`**；抽屉 / 弹层还要按 `--app-window-header-height` 把根节点下移，别盖住窗口控制按钮。
10. 组件库组件同样遵守 §6.1.1：覆盖样式一律 `var(--app-*)`。

参考实现：`CharacterPack/styles/pack-common.scss`（密度原语）、`pack-widget.scss`（清零点 mixin）、`pack-ui-kit.test.ts`（禁原生控件 + 自带造型必须以 `.ant-btn` 承载）。

#### 可伸缩容器内的栅格：禁止写死列数

右栏支撑面板宽度用户可拖（280–460px），里面**任何栅格都不能写 `repeat(2, 1fr)`** —— 窄宽度下每格被压到内容最小宽度以下，而外层是 `overflow-x: hidden`，溢出部分被**静默裁掉**（表现只是「按钮少了一半」）。

```scss
display: grid;
/* 显式下限挡住内容反向撑列；1fr 等价 minmax(auto, 1fr)，auto 会取内容最小尺寸 */
grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
```

下限口径：≥ 卡片内最刚性那一行（一排 5 颗 24px 图标 + gap ≈ 124px，加左右内边距 19px 与边框 2px → 145px）。再给该行补 `flex-wrap: wrap` + 子项 `flex: none` 作兜底：宁可折行，不要横向溢出。

### 6.1.3 动效与立体感

定位锚点：柔和 · 轻量 · 卡片式 · 桌面 · 写作工具。**立体感 = 明度分层 + 细边框 + 轻阴影的「轻盈抬升」；动效 = ≤260ms 克制 + 按下即反馈。**

**两条红线**：① 暗色（midnight）靠**明度 + 描边**，不靠阴影（黑底阴影打不出来）；hover 不用微弱透明度（人眼难察觉），改「浅灰背景 + 柔和高亮」。② 动效只为确认交互：**编辑正文区是零动效区**（只留焦点态 + 光标）。

**阴影 5 档**（`themes.scss` 每套主题各写色值，按色相 tint，禁单一纯黑）：`--app-shadow-ambient`（静止卡片）/ `-card`（内容面）/ `-raised`（hover 抬升，配 `translateY(-2px)`）/ `-pop`（浮层 / 抽屉 / 右键菜单）/ `-window`（窗口外壳 inset）。静止态就要有层次，**不要把阴影只留给 `:hover`**；窗口外壳 `.window-shell` 因透明窗口裁边只能用 inset。

**动效 token**（`:root` 块，不随主题变）：`--app-t-instant` 80ms（按下 / 焦点环）、`--app-t-fast` 120ms（颜色 / 描边 / 图标）、`--app-t-normal` 180ms（hover 抬升 / 卡片 / 选中）、`--app-t-slow` 260ms（抽屉 / 入场上限）；缓动 `--app-ease-standard` / `-emphasized`（强调入场）/ `-spring`（抽屉、拖拽释放，仅拖拽允许轻微回弹）。

- 散落的 100/140/150/160/200/220/240/320ms 一律归入三档，裸 `ease` / `cubic-bezier` 归入 `--app-ease-*`。
- 组合动效走 `shared/styles/motion.scss` 的 mixin，不在组件里手拼 `transition`。
- **按下即反馈**：`scale(0.97)` 用 `--app-t-instant`，反馈在按下而非释放。
- enter / exit 非对称：进场从容（260ms），退场更快。

**性能与可访问性**：只动 `transform / opacity`（禁 transition `width / height / margin`）；阴影动画用「预置层 + 只切透明度」；`will-change` 只给抽屉滑入、卡片抬升这类高频元素；resize / 重渲染场景避免 `@keyframes`（会被钉在 0 帧），优先可中断的 transition；全局支持 `prefers-reduced-motion: reduce`（收口在 `motion.scss`）。

**mixin**：`transition-fast|normal|slow`、`transition-token`、`hover-lift`、`press-feedback`、`rise-in`、`reduced-motion`。

### 6.1.4 图形素材主题化（含 Lottie）

完整规则见 `docs/spec/graphic-theming-spec.md`。一句话：**要么跟文字色走（`currentColor`），要么引用语义 token（`var(--app-*)`）；禁止钉死色值，禁止一主题复制一份资源。**

| 等级 | 适用 | 规则 |
|---|---|---|
| **L1** 纯文字色 | 单色线形图标、分割线、图标默认态 | `fill/stroke = currentColor` |
| **L2** 语义 token | 多色图标 / 徽标里的主色、状态色 | 只引用既有 `--app-*`，**禁止自造「图形专用」色值** |
| **L3** 插画级多色 | 空态插画、引导图、复杂 Lottie | **只分「浅 / 暗」两套**（浅色三主题共用浅套），不做四套 |

Lottie：首选「哨兵色占位 → 运行时替换为 `--app-*` 并监听 `data-theme`」；次选浅 / 暗两套；**禁止** `hue-rotate` 换肤、四套复制、新引入无语义色值；统一走 wrapper（`ThemeLottie` / `ThemedGraphic`）；图标微动效优先 CSS / framer-motion，**不为几个小动效引入 lottie-web（~300KB）**；离屏即 `pause/destroy`，装饰性动效加 `aria-hidden`，`reduced-motion` 降级为静态首帧。

### 6.2 状态管理

**逻辑抽取**：组件只负责渲染、事件触发与 UI 状态显示；数据处理、状态转换、异步请求、缓存交互、事件编排进 `hooks/` / `services/` / `store/`。**该进 store 就优先 Zustand**（判据见下），别把页面写成「巨型容器」。

**store 划分（硬约束）**：**一个功能模块一个独立 store**，按业务域建（搜索 / 悬浮 / 外观 / 编辑器 / 书架 / 地图文档 / 窗口级跳转…）。**禁止大而全 store** —— 把不相干的域塞进同一个 store，等于让任一字段变更广播给全部订阅者（退化成全局重渲染），模块边界也随之消失。跨模块协作走「各自 store + 事件」或组件层编排，**不靠合并 store 解决**。新增 store 前先在本节末尾登记。

**该建模块级 store 的信号**（命中任一就不要再提升 props）：

1. 子组件状态挂在 `useEffect` 上，依赖含父层传入的**回调**（回调身份随数据变化 → effect 反复重跑 → 加载态闪现 / 请求重复）。
2. 父层任何一次重渲染都会清空子组件本应保留的结果。
3. 面板条件渲染卸载后，切回来希望保留上次输入与结果。

**业务状态该收进 store 的信号**：

1. **跨组件闭包风险**：多个 `effect` / `useCallback` / `ref` 靠彼此身份与依赖互相驱动，回调里读到的是「挂载那一刻」的旧值，要靠 ref 镜像才能读最新值。
2. **判定依赖「当下」的全局 state**：落点由 `view` / 当前选中项 / 句柄是否就绪等多个全局量共同决定，组件闭包抓的是快照，判定必须用 `store.getState()` 的真实值。
3. **同一业务反复报 bug、多轮没修干净**：症状往往不是逻辑错，而是散落的 ref + 多个 effect 之间的时序竞态 —— **别再打补丁**，把状态机收进 store。

> 反例：关系图「在主窗口打开资料卡」原本散在 `editorBridgeRef` + `pendingJump` + `deferredJumpRef` + `lastJumpRef` 里，靠三个 effect 互相触发，连修四轮仍复现「先切书再弹窗 / 只唤起不切书 / 返回书架却切书」；收口成 `useEntityJumpStore` 后判定统一走 `get()`、监听只注册一次、`backToShelf` 同步作废挂起项，三症状一次消失。

**收口原则**：状态机逻辑（判定 / 去重 / 作废 / 重试）纯函数化进 store，组件只订阅 + 派发；IPC / 事件监听**只注册一次**，handler 里只 `handoff(payload)`；store 不 import hooks / service，靠组件挂载时「注册 runner」拿到数据层函数，**注册动作不得触发请求**。

已落地 store（均一模块一 store，无跨域共享的巨型 store）：`useSearchStore`、`useHoverStore`、`useAppearanceStore`、`useNovelEditorStore`（NovelPage）；`useShelfStore`（Bookshelf）；`useMapDocStore`（MapWindow）；`useEntityJumpStore`（窗口级）。

### 6.2.1 页面状态与组件职责

复杂页面统一「页面组合 + 分层 Hook + 私有组件」。

**Hook 分层**：

- `useXxxData`：数据加载、CRUD、转换与领域派生；不管弹窗 / 输入框 / 筛选 / 布局。
- `useXxxEditorState`：输入草稿、编辑对象、表单状态、临时选择、弹窗开关；数据层动作由参数注入，不直接访问 IPC。
- `useXxxViewState`：搜索筛选、排序视图、分区折叠、选中项、滚动定位、加载动画等展示态。
- `useXxxPage`：复杂页面的组合层，只把上面三者组合给页面，不重新聚合状态；简单页面可以不建。

**页面与组件职责**：

- `XxxPage.tsx` 组合 Hook 与页面组件，禁止实现列表项菜单、递归渲染、复杂表单流程或弹窗细节。
- 列表项交互归 `XxxListItem`（含递归子项）；工具栏归 `XxxToolbar`（输入法守卫必须由真正持有输入框的组件调用）；分区容器归 `XxxSection`（空态 + 列表容器，行用最小 props 注入）。
- 独立弹窗只负责自身 UI；**不要**新增只做 props 转发的 `XxxModals` 包装组件。
- 页面私有组件放页面 `components/`；跨页面复用才提 `shared/components/`。

**状态归属**：

- 数据态归 `useXxxData`，草稿 / 表单归 `useXxxEditorState`，筛选 / 折叠 / 滚动 / 动画归 `useXxxViewState`。
- 状态在**直接使用它的组件**里消费，别父组件集中读取后再多层 props 透传；父组件只保留真正跨组件共享、参与页面级编排或决定布局的状态。
- 组件需要多个 Hook 时先在自身内部组合；只有要被兄弟共享才提升到最近共同父组件。
- 子组件只收最小 props，**禁止**读其他页面组件的状态、直接调 `window.electronAPI` / 文件系统 / 外部 HTTP。
- 展示规则、长度限制、领域常量放页面配置或工具文件，不散落在 JSX 分支里；长文本统一配置化截断 + Tooltip 展示原文，编辑态用完整原文。

**落地示例**：NovelPage —— `useNovelData` / `useNovelEditorState` / `useNovelPage` 三层，`ChapterTree` 管树与拖拽、`EditorPane` 只管码字、`SupportPanel` 管大纲 / 要素 / 灵感 / 检索，标题截断配置在 `novel-config.ts`。MapWindow —— `store/` 存快照与文档状态，`useMapEditorState` 持草稿与弹窗，`useMapViewState` 管 LOD 与视口，`useMapEditor` 是组合层；`MapCanvas/index.tsx` 保持单体（41 个 effect 的场景图 ref 由初始化 effect 的清理段跨组共享，渲染栈守卫以它为唯一实现），拆分须先同步重构守卫与 ref 所有权；边界与行数上限由 `map-layer-guard.test.ts` 守卫。

### 6.3 IPC

**新增通道三步**：① `electron/handlers/<域>/xxx-handlers.ts` 里 `registerXxxHandlers()` 内 `ipcMain.handle()`（`main.ts` 只调注册函数）；② `preload.ts` 暴露到 `window.electronAPI`；③ `src/shared/types/electron.d.ts` 更新类型。

**命名**：`模块-操作`，如 `novel-work-add` / `novel-pack-load` / `map-doc-save`。

### 6.3.1 本地日志

| 场景 | 用什么 |
|---|---|
| 主进程 / handler | `log(level, window, module, message, meta)`（`core/logger.ts`） |
| 窗口生命周期 | `windowLogger(窗口名)`（创建 / 关闭 / 装载失败已内置） |
| 渲染层 | `rendererLog.info/warn/error(module, msg, meta)`（`shared/log/renderer-logger.ts`） |
| 渲染期异常 | `ErrorBoundary`（已装在各窗口入口） |
| IPC | 不手写 —— `preload` 的 `trackedInvoke` 已统一记失败与慢调用 |
| AI 调用 | `ai-handlers` 已内置：`ai_log` 表 + `DEBUG` 级日志（模块名 `ai`） |

- **只有一个日志文件**：一律并入所属窗口当天的 `YYYY-MM-DD.log`，靠模块列区分来源（`[ipc]` / `[ai]` / 业务名）。新增类型加模块名，不开新文件。
- **绕过 level 阈值只有一个出口：`logAlways`**（4 参起步）。IPC 与 AI 调用按 DEBUG 用 `logAlways` 写入、不受 `settings.level` 过滤（IPC 另受「记录 IPC」开关控制，AI 恒记）—— 否则默认 `info` 下它们整批消失，而那正是「调不通 / 模型乱答」的唯一线索。普通业务日志一律走 `log()`。守卫：`electron/ai/ai-log-guard.test.ts`。
- **目录按「窗口 + 用户」隔离**：`<userData>/logs/<窗口名>/`，窗口名由 `BrowserWindow.fromWebContents` + `windowManager.getNameOf` **反查**，渲染层**不许自报**；用户隔离复用 `getUserDataDir(email)`，未登录落 `logs/_anonymous/`。
- **登出不触发 userDb lifecycle**（`auth-logout` 只删 authDb 用户行），切匿名目录由它显式 `resetLogRoot("logout")`；登录会触发**两次** `onSwitched`（`user-login` + `login-confirm`），所以写入侧根目录**每次现算**、不缓存。
- **一行一条**：正文换行转义成字面 `\n`，格式由 `formatLogLine` 统一产出；**不用 `appendFileSync`**，一律 `createWriteStream({ flags: "a" })`。
- **`registerLogHandlers()` 里不读用户配置**（它注册在 `switchUserDb` 之前，此时用户库还没开）；配置走 `loadLogSettings()`，由 `main.ts` 切库后调。
- **量控制**：默认 `info`；IPC 只记失败 + 耗时 > 300ms（`SLOW_IPC_MS`）；AI 的 prompt / output 各留 600 字预览，禁止整段落盘。
- 进程级 `uncaughtException` / `unhandledRejection` **只记录不退出** —— 直接退出会丢用户未保存的正文。

### 6.3.2 快捷键

**单一事实源 `src/shared/shortcuts/registry.ts`**（渲染层与主进程共用）。新增一条只改注册表 + 在 `HANDLER_BY_ID` 挂处理函数。

- 键位写平台中立形式 `Mod+Shift+B`（Mod = Ctrl / Cmd）；展示走 `formatShortcut`，落 Electron 走 `toAccelerator`。
- **匹配按 `specificity` 降序**，不依赖对象书写顺序 —— `Ctrl+S` 先命中会吃掉 `Ctrl+Shift+S`。
- **主进程只能引 `keys-core.ts`**（无 DOM 纯函数），禁止引 `keys.ts` / `store.ts`。守卫：`shortcut-guard.test.ts`。
- **应用级（global）白名单只放开「唤起窗口」类**（`globalEligible: true`）；`Ctrl+S` 设成系统级就是全局劫持。
- **注册 / 注销走增量**（`globalShortcut.unregister(accelerator)`），**绝不 `unregisterAll()`**（会误伤 dev 的 F12）。
- **录制态必须 capture + `preventDefault` / `stopPropagation`**，否则录 `Ctrl+S` 会顺手存稿、录 `Esc` 会被关浮层吃掉。

### 6.4 布局动画

**平滑过渡用 CSS transition，不要条件渲染**：始终渲染容器、用类名切 `--collapsed`，让 width / opacity 走 transition；条件渲染会把动画直接打断。

```tsx
// ❌ {!collapsed && <Sidebar />}
// ✅ <div className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}><Sidebar /></div>
```

### 6.5 数据库迁移

**表结构变更必须增量迁移**（`electron/novel/novel-db.ts` 等各域建表函数内）：

```typescript
db.exec(`CREATE TABLE IF NOT EXISTS novel_chapters (
  id TEXT PRIMARY KEY, work_id TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT ''
)`);
const columns = db.prepare("PRAGMA table_info(novel_chapters)").all() as Array<{ name: string }>;
if (!columns.some((col) => col.name === "sort")) {
  db.exec("ALTER TABLE novel_chapters ADD COLUMN sort INTEGER DEFAULT 0");
}
```

> 唯一例外：§6.7 开关为 `refactor` 时的 **novel 窗口**表结构。其余（含 `compat` 与宿主库）无例外。

### 6.6 单元测试

**改功能前后必须跑该功能的单测**。技术栈 `vitest` + `@testing-library/react` + `jsdom`（`vitest.config.ts` / `vitest.setup.ts`）。

**强制要求**：

1. **改前先跑基线**：修 bug 或重构前确认当前绿；没有测试先补测试再动手。
2. **默认只跑改动面，禁止顺手全量**：改完只跑被改模块（单文件或单目录）。**只有**命中下面 B 类越界、或到了交付前那一轮，才 `pnpm test`。理由不是省时间而是**没有信号** —— 全量是 315 文件 / 4200+ 用例、二十分钟量级，封闭改动不可能让其余 300 个文件变红。
3. **测试与被测源码同级**：命名 `*.test.ts` / `*.test.tsx`。读源码断言的守卫同样遵守：断言 handler 就放该 handler 目录，断言 `main.ts` / `preload.ts` / 打包配置 / 文档索引就放 `electron/` 根。**禁止** `tests/` / `guards/` 平行目录。
4. **纯函数必须有单测**：`xxx-utils.ts`、`shared/services/` 里的时间换算 / 解析 / 格式化 / 转义是覆盖下限。
5. **可测性优先**：新逻辑尽量设计为不依赖 `window.electronAPI` / DOM 的纯函数，IPC 与文件访问留在 hooks / handlers。
6. **只断言行为**：断言输入输出与副作用语义，不断言「调了哪个私有函数」。

**范围判据一句话：这次改动能不能越过模块 / 进程 / 全局状态的边界？越不过就是封闭改动。**

#### A. 封闭改动 → 只跑下表，**不跑全量**

| 改了什么 | 跑什么 |
|---|---|
| 某窗口内部的纯函数 / 组件 / 样式 / 生成器 | 该窗口目录（`vitest run src/windows/MapWindow`） |
| 单个文件的实现细节 | 单文件 |
| `handlers/<域>/*.ts` 的业务逻辑 / SQL / 校验（**通道名、入参、返回值都没变**） | 该 handler 目录 + 同目录守卫 |
| `electron/{core,novel,map,ai}/*.ts` 的纯函数、库内部逻辑（**不动连接生命周期与导出签名**） | 该目录 |
| `src/shared/**` 中只被单一窗口引用的模块 | shared 用例 + **引用方**目录（`grep` 找 import） |
| 主题变量、CHANGELOG 分流规则、扫描型守卫本身 | 对应守卫（`themes.test.ts` / `changelog-*-guard.test.ts` / `docs-index-guard.test.ts`） |

#### B. 越界改动 → **必须全量** `pnpm test`

| 越界类型 | 命中条件（任一即是） |
|---|---|
| **IPC 契约** | 通道名增删改；入参 / 返回值形状；`preload.ts` 暴露面；`electron.d.ts`；`main.ts` 的 `registerXxxHandlers` 注册段 |
| **主进程入口结构** | `main.ts` 的窗口创建 / 生命周期 / 协议 / 托盘；`preload.ts` 的 contextBridge 结构 |
| **全局状态** | `core/logger.ts` 单例与等级；`windowManager.ts`；各域库连接生命周期（`registerUserDbLifecycle` / 切用户 / 退出）；`window-entries.ts` 清单 |
| **跨窗口共享** | `src/shared/**` 被两个以上窗口引用；`shared/components/`；`shared/styles/**` 主题与 token |
| **构建 / 打包** | `vite.config.ts`、`package.json` 依赖、`external`、`files` |
| **交付闸门** | 发版、版本号变更、交付前那一轮 |

> 落地方式：`git diff --stat` 逐个问「还有谁读它」。只改一条 SQL 排序 → 跑 `electron/handlers/novel`；只改 MapWindow 聚落算法 → 跑 `src/windows/MapWindow`。

```bash
pnpm exec vitest run src/windows/MapWindow      # 按窗口目录（日常默认）
pnpm exec vitest run electron/handlers/novel    # 按主进程业务域
pnpm exec vitest run <path/to/x.test.ts>        # 单文件
pnpm test                                       # 全量（仅 B 类越界 / 交付前）
```

> ⚠️ 用 `pnpm exec vitest` 而不是 `npx vitest`：后者可能解析到另一份实例，表现为「收集到 0 个用例」或 `initSuite` 报 `reading 'config'`。**整仓扫描型守卫并行时会假超时（5000ms 默认值），单跑即可复核。**

### 6.7 架构重构模式开关（novel）

一个**开发期政策开关**，表示「本阶段是否允许对小说窗口的存储与前端结构做从零重构」。它约束人与 AI 的设计方式，**不参与代码运行**：任何运行时代码不得读取它，不得为它写环境变量分支 / `define` 注入 / 运行时探测 / UI 提示 —— 它必须版本化、对所有协作者可见，所以唯一事实源就是下面这段声明。

```json
{ "novelArch": "refactor" }
```

> 改这个值 = 切换状态，**改完必须提交**，否则下一次会话看到的是旧状态。
> 历史：1.33.0（novel 存储重设）、1.36.0（小说设定重构）、1.39.0（行囊负重下线）三次在 `refactor` 下完成，均已改回 `compat`。下次要放弃兼容承诺，须**重新改成 `refactor` 并提交**。

| 维度 | `compat`（默认） | `refactor`（窗口期） |
|---|---|---|
| 表结构 | 走 §6.5 增量迁移，新列可空或带默认值 | 可直接重设 schema（拆表 / 改列 / 换主键 / 合并），不写迁移 |
| 旧数据 | 必须可读、不得丢 | 允许丢弃；不写迁移脚本、不做旧库读取 |
| 兼容层 | 按需写 | **禁止**：不写双读双写、不做运行时结构探测 |
| 前端结构 | 不做破坏性重构 | 可整体重分层（组件 / hook / service 边界与目录重组） |
| 登记 | CHANGELOG 常规条目 | 必须明示「旧数据不兼容」并说明如何重建 |
| 交付 | —— | 必须把开关改回 `compat` 后仍完整可运行 |

**作用范围**：novel 窗口全部业务 —— 存储侧 `electron/novel/novel-db.ts` 与 `handlers/novel/*`；前端侧 `src/windows/NovelWindow/**`（含行囊 `CharacterPack`）。**不含**宿主库 `core/db.ts`、地图域、`src/shared` 通用基座（这些一律按 `compat`）。

**开关为 `refactor` 时**：① 直接按目标结构从零设计，不沿用「在旧结构上补一层」；② 不问「怎么兼容旧数据」，也不夹带迁移脚本；③ 不写适配层；④ 改完改回 `compat` 并验证在 `compat` 下完整可运行（开关只授权过程，不许留「只有开着开关才成立」的分支）；⑤ CHANGELOG 明示破坏性影响；⑥ 范围超出 novel 就停下，拆成两次改动。

默认 `compat` 的理由：开关的全部价值来自「默认态安全」。默认 `refactor` 等于没有开关，下一个改动的人不会意识到自己在放弃兼容承诺。长期挂着 `refactor` 等于长期没有迁移规范。

### 6.8 打包与依赖归位

**判断 `dependencies` / `devDependencies` 的唯一标准是「主进程运行时是否 `require` 它」。** 渲染层依赖即使被 import 也是 `devDependencies` —— Vite 会打进 `dist`，写进 `dependencies` 只会让 electron-builder 把整棵树再塞进 asar 一遍（曾因此让 asar 胖 5 倍）。当前 production `dependencies` 只允许：`better-sqlite3` / `docx` / `jszip` / `mammoth`。

1. **新的主进程 Node 依赖必须同时出现在两处**：`vite.config.ts` 的 electron `external` 与 `package.json` 的 `dependencies`。只加 external → 打包后 `Cannot find module`；只声明不加 external → 体积翻倍甚至因 pnpm 非扁平结构构建失败。
2. **原生模块的 `asarUnpack` 精确到 `.node`**，禁止 `node_modules/**/*.node` 整包外置（会触发 smartUnpack 把整个包含 `deps/sqlite3.c` 一起外置）。**改任何打包配置后必须跑 `pnpm analyze:asar` 并把分区数据贴进 CHANGELOG 留痕。**
3. locale 裁减走 `build.electronLanguages: ["zh-CN", "en-US"]`，`after-pack.js` 的清理只作兜底。

| 项 | 位置 | 作用 |
|---|---|---|
| 体积审计 | `scripts/analyze-asar.mjs`（`pnpm analyze:asar`） | 读 asar header 输出分区与按包排序，`--json` 便于前后对比 |
| 打包守卫 | `electron/packaging-guard.test.ts` | dependencies 只 4 个、external ⊆ dependencies、`build.files` 排除项、`asarUnpack` 精细度、version major ≥ 1 |
| 事后清理 | `scripts/after-pack.js` | 删 Chromium 物料（`LICENSES.chromium.html` / `dxcompiler.dll` / swiftshader / `d3dcompiler_47.dll`），**保留** `LICENSE` 与 `dxil.dll`（GPU 回退依赖） |

### 6.9 构建期特性开关（地图窗口裁剪）

现状：地图窗口（架空地图 / MapWindow）尚未达到交付预期，允许打包时整条裁掉。
源码、表结构、`map.db` 一律**保留**（不做破坏性删除），只是不参与本次产物。

开关只有一处产地：`src/shared/feature-registry.ts` 的 `FEATURE_REGISTRY`（可扩展注册表）。
每个开关声明自己的环境变量（约定 `NOVEL_WITH_<UPPER_SNAKE>`，值 `0` / `false` / `off` / `no` 视为关闭）、
默认值与「关掉会消失什么」；被裁的窗口入口也在这里用 `cropsWindowEntry` 声明。

| 位置 | 作用 |
|---|---|
| `src/shared/feature-registry.ts` | **唯一事实源**：开关表 + `resolveFeatureFlags(env)` 求值 + 类型推导。纯数据，无 React / Node API |
| `vite.config.ts` | 按注册表求值 → `define __NOVEL_FEATURES__`（主进程 / preload / 渲染层三份产物同值）→ 按 `cropsWindowEntry` 从 `rollupOptions.input` 剔除窗口 HTML |
| `electron/feature-flags.ts` | 主进程读取层：只解引用 `__NOVEL_FEATURES__`，导出 `FEATURES` / `FEATURE_MAP_WINDOW` |
| `src/shared/features.ts` | 渲染层读取层：同款解引用，供工具箱入口卡与帮助手册使用 |

**新增一个开关只改注册表一行**（键名 = `FEATURES.<key>`、`env`、`defaultValue`、`summary`，按需 `cropsWindowEntry`），
两个读取层文件与两份构建配置都不用动 —— `src/shared/feature-registry.test.ts` 会拦「读取层里又写了一份开关判断」。

- 关闭时**不产出** `dist` 里的 MapWindow HTML / chunk，也**不注册** map IPC（因此不会新建一个空 `map.db`）；已有用户数据不删不读。
- 打包：`pnpm electron:build:nomap`（等价 `NOVEL_WITH_MAP=0`）；快速验证用 `pnpm electron:build:dir:nomap`；一次关多个 = 同时设多个环境变量。
- 开关值是**编译期字面量**：改开关必须重新构建。业务代码只读 `FEATURES` / `FEATURE_MAP_WINDOW`，**禁止**在代码里写 `process.env` 运行时分支。
- 恢复上线 = 去掉环境变量即可。**不要**为此再引一套版本 / 形态名机制（见 §2.1「根目录只留三个文件」与本文档开头「只有一个构建形态」）。
- 守卫：`src/shared/feature-registry.test.ts`（注册表形状 / 求值语义 / 读取层不越权）、`electron/map/map-db-guard.test.ts`（注册段仍是启动段注册、且与 `map-window-open` 共用同一个开关）。

---

## 7. 技术债务

| 优先级 | 问题 | 改进方向 |
|---|---|---|
| 中 | 接口定义仍散落在各文件 | 收敛到 `src/shared/types/` |
| 低 | hooks 与组件交互的渲染测试覆盖不足 | 用 `@testing-library/react` 补关键 hook |

---

## 8. 新增功能检查清单

### 8.1 新增独立窗口

- [ ] 建 `src/windows/XxxWindow/`（`index.html` + `main.tsx` + `App.tsx`）
- [ ] `electron/window-entries.ts` 的 `RENDERER_ENTRY_PATHS` / `WINDOW_ENTRIES` 登记（vite input 由此生成）
- [ ] `electron/main.ts` 加创建函数，并补 `window-load-guard.test.ts` 的 `WINDOWS` 清单
- [ ] 入口引入 `themes.scss` + `createRoot` 前调 `initThemeFromStorage()`，用 `ThemeProvider` 包裹 App
- [ ] 窗口私有页面 / 组件留在窗口目录内；样式走 `var(--app-*)`

### 8.2 新增页面（NovelWindow）

- [ ] 建 `pages/NewPage/`（`NewPage.tsx` + `index.scss`）
- [ ] 在 `NovelWindow/App.tsx` 的视图状态机登记（无路由）
- [ ] 在入口（书架顶栏 / 工具箱）加导航项
- [ ] 逻辑 >100 行时抽 `hooks/useNewPage.ts`（分层见 §6.2.1）

### 8.3 新增子组件

- [ ] 组件写成目录：`SubComponent/index.tsx` + `index.scss`，入口 `import "./index.scss"`，父级样式里删掉它的规则
- [ ] UI 一律组件库组件（§6.1.2）；覆盖外观只改变量、不写 `:hover`；自带造型用 `@include widget.cpk-widget` 且与变量同选择器
- [ ] 同一模块内存量原生控件顺手一并替换（不得混用）

### 8.4 新增数据表

- [ ] novel 的表先看 §6.7 开关：`refactor` 可重设、`compat` 必须增量迁移
- [ ] 在建表函数里加表：novel → `electron/novel/novel-db.ts`、map → `map/map-db.ts`、ai → `ai/ai-db.ts`（**不要**写进 `core/db.ts`）
- [ ] 写增量迁移（检查列是否存在）
- [ ] 在 Service 层封装通道（渲染层不内联 SQL），定义 TS 接口

### 8.5 新增 IPC 通道

- [ ] `handlers/<域>/xxx-handlers.ts` 导出 `registerXxxHandlers()`，`main.ts` 的 `whenReady` 调用
- [ ] `preload.ts` 暴露 + `electron.d.ts` 更新 + Service 层封装
- [ ] 引新主进程依赖时，`external` 与 `dependencies` 两处同改（§6.8）

### 8.6 更新日志规范

**必须维护**：功能上线、修复、兼容调整或配置改动，必须同步更新 `CHANGELOG.md`。

- **版本格式**：标题 `## [X.Y.Z] - YYYY-MM-DD`；有架构调整 / 新增页面模块或数据层升次版本号，小功能与修复只升修订号；`CHANGELOG.md` 与 `package.json` 的 `version` 必须同步。未更新日志视为未完成交付。
- **体积上限（强制）**：主文件不得超过 800 行，超限立刻分流到 `changeLogHistory/`。

#### 条目规范（强制）

1. **只记三类**：每个版本块只允许 `### 新增` / `### 修改` / `### 删除`。修复、调优、行为变更归「修改」；撤销功能、删除入口归「删除」。不写 `Fixed` / `Tests` / `Docs` / `验证` / `踩坑` / `实测` 等其它小节。
2. **只写「做了什么」**：每条一行，说明功能本身。不写「为什么」「怎么查」「查到什么」—— 用户对话、需求背景、取证出处、根因分析、实测数据、测试条数、待办与下一步一律不进 CHANGELOG（它们属于源码注释与文档）。
3. **条目形态**：`- ` 开头、单行、**不超过 80 字**；禁止引用块、表格、嵌套子项与续行。
4. **历史豁免**：`changeLogHistory/` 只读，分流时逐字搬运。
5. **守卫**：`electron/changelog-content-guard.test.ts` 校验章节与条目形态；`electron/changelog-archive-guard.test.ts` 校验体积、边界、指针与索引。改日志后两条都要跑。

```md
# Changelog

## [1.0.2] - 2026-09-15

### 修改
- 修复正文保存防抖在窗口关闭时丢失最后一次改动的问题。
```

#### 体积分流（强制）

**按行数判定，不按版本数**（单条版本记录动辄五六百行）。`CHANGELOG.md` 超 **800 行**即分流：

1. 主文件只保留最新次版本（必要时再加前一个），装到「再加一个就超 800」为止；**最新版本无论多长都留在主文件**。
2. 更早的按 **`major.minor`** 切到 `changeLogHistory/CHANGELOG-<major>.<minor>.md`，文件内保持版本倒序；补丁号跟着次版本走。
3. **纯搬运**：不改条目、不合并版本、不调日期、不删章节，逐字一致；每个归档文件顶部只补一段「已归档 + 去哪查」。
4. **索引同步**：`changeLogHistory/README.md` 表格按次版本倒序，新增时在**表格顶部**补一行（覆盖区间 = 该文件首末版本号）。
5. **主文件留指针**：顶部引用块写明「哪个版本之前已归档、当前归档到哪、索引在哪」。
6. **工具**：`node scripts/split-changelog.mjs` 完成第 2/3/5 条（幂等，行数未超只打印「无需分流」）；**它不写索引**，第 4 条手工补。

**检查点（强制）**：改完 `CHANGELOG.md` 就跑，全绿才算这批交付完成：

```bash
node scripts/split-changelog.mjs
node node_modules/vitest/vitest.mjs run electron/changelog-archive-guard.test.ts
node node_modules/vitest/vitest.mjs run electron/changelog-content-guard.test.ts
```

守卫钉的是**能被违反**的事实：主文件与每份归档 ≤ 800 行；脚本 `MAX_LINES` / 主文件指针文案 / 守卫常量三处一致；同一版本不重复出现；归档文件名必须是 `CHANGELOG-<major>.<minor>.md`。

### 8.7 环境搭建与依赖管理

- **包管理器**：`packageManager` 声明 pnpm@11.25.0，但**必须同时兼容 pnpm 9**。两者读配置的位置不同，这是本仓最容易反复踩的坑：

| 配置 | pnpm 9 | pnpm ≥10.26 / 11 |
|---|---|---|
| 构建脚本白名单 | 只认 `.npmrc` 的 `only-built-dependencies[]=包名` | 认 `pnpm-workspace.yaml` 的 `allowBuilds` |
| `nodeLinker` | 只认 `.npmrc` 的 `node-linker=hoisted` | `pnpm-workspace.yaml` 的 `nodeLinker` |
| `package.json` 的 `pnpm` 字段 | 读过（已废弃） | 完全不读 |
| `pnpm-workspace.yaml` 的 pnpm 设置 | 完全忽略（无报错） | 正常 |

  → 当前落地：`.npmrc` 供 pnpm 9、`pnpm-workspace.yaml` 供 10/11。**新增带 postinstall 的依赖时两处都要补。**
- ⚠️ **`better-sqlite3` 必须显式「禁止」构建**：它 ≥13 没有 install 脚本，但保留了 `binding.gyp`，而「有 `binding.gyp` 且无 `install`」默认会执行 `node-gyp rebuild` → 无 VS C++ 的机器上 `gyp ERR! find VS` 带崩整个 install。正确写法：`allowBuilds` 里 **`better-sqlite3: false`**，且**不要**出现在 `.npmrc` 的 `only-built-dependencies[]`。它只需要包内 `prebuilds/win32-x64.node`（Node-API，与 Electron ABI 无关），所以**升 Electron 不需要重编译**。
- **镜像**：`.npmrc` 已随仓库提交（registry / `electron_mirror` / `electron_builder_binaries_mirror` 指向 npmmirror）；仍超时可临时导出 `ELECTRON_MIRROR`。
- **标准安装**：`pnpm install` → `pnpm dev`。**必须用 pnpm 11 安装**（`pnpm -v` 确认）：pnpm 9 不认 `allowBuilds`，会把 `better-sqlite3: false` 当空气。
- **`pnpm dev` 卡住不动的真正原因**：Electron ≥41 的 `package.json` 已无 postinstall，二进制安装被推迟到**首次 `require('electron')`** —— 没有 `path.txt` 就在同步调用栈里 spawnSync 下载 ~140MB，默认直连 github、**无超时无进度**，看起来就是卡死。`.npmrc` 的 `electron_mirror` 只在包管理器执行安装脚本时才转成环境变量，手动 / 内部 spawn 时一个都没有。
  - **根治（勿删）**：`scripts/ensure-electron.mjs` 自己读 `.npmrc` 并**显式注入 `ELECTRON_MIRROR`**，加超时上限后补装；它挂在 `dev` / `electron:dev` / `postinstall` 最前面（已装好时毫秒级返回）。`scripts/start-electron.js` 另有 fail-fast，二进制缺失时拒绝掉进无超时下载。
  - **不要在 `ELECTRON_RUN_AS_NODE=1` 的环境里跑 dev**：该变量会让 `electron.exe` 退化成普通 Node，`require('electron')` 返回可执行文件路径字符串，主进程崩在 `reading 'app'`。start-electron 已显式剔除，**不要删掉这层清理**。
  - **二进制「看着齐全」却秒退零输出** = 解压不完整（win32 zip 有 75 个条目，中断后常只剩 19 个根文件，缺 `locales/*.pak` 或 `resources/default_app.asar`）。`install.js` 开头 `if (isInstalled()) exit(0)`，`path.txt` 已写好就永不自愈。诊断用 `pnpm dev:doctor`，修复靠 `ensure-electron.mjs`（识别残缺形态后自动清空 dist 重解压）。**安装过程不要中断。**
- **布局固定 `node-linker: hoisted`（勿回退）**：Windows 上 pnpm 默认的 symlinked 布局会稳定复现「包目录被创建但内容为空」（全新安装就出现约 200 个空目录），进而随机 `Cannot find module`。代价是允许幽灵依赖 —— **新增依赖务必写进 `package.json`**。判断当前布局：`node_modules/.pnpm` 存在 = symlinked。
- **链接半损坏时的处置**（当前 hoisted 布局不会出现，仅切回 symlinked 时适用）：`pnpm check:deps`（只体检，CI 用）→ `pnpm fix:deps`（重建断裂链接、清理 `.ignored` 空壳）→ 仍报错就删 `node_modules` 重装 + `pnpm ensure:electron`。**升级 pnpm 大版本后必须删 `node_modules` 重装**，`pnpm add` 不要并发或中断。
- **HTTP 契约：网络请求一律在渲染进程发起，主进程不代理任何 HTTP。** 用 `src/shared/http/` 的客户端（超时 / 重试 / 中断 / 错误归一 / 剥壳），按业务取作用域实例 `getScopedHttpClient(...)`，页面卸载用 `useHttpClient()` / `abortScope()` 中断在途请求。主进程只做**一次性**会话配置（`core/httpSession.ts`：注入 CORS 响应头 + `http-session-set-cookie` 写 session jar），**不要**新增逐请求转发的 IPC 通道。`Cookie` 是 forbidden header，走 `ensureSessionCookie()` + `credentials: "include"`。业务里禁止裸调 `fetch`。
  - **AI 业务的刻意豁免**：AI 请求仍在主进程发起（Key 不下放渲染层、端点用户自填无法在会话层放行 CORS、长时流式需统一管理连接）。豁免的只是「谁发 HTTP」；错误归一、不新增普通转发通道这些照旧。

### 8.8 新增 / 删除文档

- [ ] 只放「活规范」进 `docs/spec/`；过程稿的结论并入 `AGENTS.md` 或 `CHANGELOG.md`，不新增正文
- [ ] 命名 `<主题>-spec.md`，头部补齐「状态 / 输入 / 基线」三行
- [ ] 同步 `docs/README.md` 索引（新增一行 / 删除删行 / 移动改路径）
- [ ] 同一次改动内改完所有 `docs/` 引用（命令见 `docs/README.md`），不留悬空路径

### 8.9 新增用户可见功能（帮助手册同步，强制）

帮助中心（F1）是**功能的唯一用户侧索引**：功能做了但手册查不到 = 用户不知道它存在。这条不靠自觉 —— `guide-doc.test.ts` 遍历 `AI_INTENT_LABELS`，要求每个意图在「AI 创作助手」分区有命中词条，缺一条就红。

- [ ] 在 `src/shared/novel/guide-doc.ts` 对应分区补词条：`term` 用**用户会搜的说法**，`desc` 写清「点哪里 + 会发生什么」
- [ ] 新增 AI 功能：确认 `AI_INTENT_LABELS` 有该意图，词条需包含标签原文
- [ ] 有高频困惑（为什么灰 / 会不会上传 / 会不会重复扣费）再补 `faq`
- [ ] `term` 全局唯一（重复会污染检索与列表 key）
- [ ] 新增窗口 / 页面的常驻入口：先看该窗口是否已挂 `HelpCenter`，没挂先挂上
- [ ] 改了入口位置或文案，**同步改词条** —— 手册写错比不写更糟

---

## 9. 附录

### 9.1 技术栈

| 技术 | 版本 |
|---|---|
| React | ^19.2.6 |
| TypeScript | ~6.0.2 |
| Vite | ^8.0.12 |
| Electron | ^44.9.0 |
| Ant Design | ^6.6.2 |
| better-sqlite3 | ^13.0.3（Node-API，无需按 ABI 重编译） |
| electron-builder | ^26.17.0 |
| pnpm | 11.25.0（`packageManager` 锁定；`allowBuilds` 是 11.x 字段） |
| react-virtuoso | ^4.18.13 |
| pixi.js | ^8.22.0 |

### 9.2 关键文件索引

| 文件 | 路径 | 作用 |
|---|---|---|
| 主进程入口 | `electron/main.ts` | 窗口管理、IPC 注册 |
| 窗口清单 | `electron/window-entries.ts` | 入口路径 / 打包清单 / 主窗口归属，与 vite input 对应 |
| 宿主库 | `electron/core/db.ts` | `auth.db` / `user.db` 双连接 + 用户库生命周期广播 |
| 小说库 | `electron/novel/novel-db.ts` | `novel.db`：小说与行囊全部表 |
| 地图库 | `electron/map/map-db.ts` | `map.db`：存档 / 历史版本 / 资源索引 / 配置 |
| AI 库 | `electron/ai/ai-db.ts` | `ai.db`：配置 / 会话 / 埋点 |
| 会话配置 | `electron/core/httpSession.ts` | 主进程 session 级 CORS / Cookie 注入 |
| API 暴露 | `electron/preload.ts` | contextBridge 白名单 |
| 视图状态机 | `src/windows/NovelWindow/App.tsx` | 书架 / 编辑器 / 回收站切换（无路由） |
| 全局类型 | `src/shared/types/electron.d.ts` | `window.electronAPI` 接口 |
| 主题变量 | `src/shared/styles/themes.scss` | 四套主题的 `--app-*` |
| 主题模块 | `src/shared/theme/` | 主题清单、存储、Provider、`useTheme` |
| 提示词产地 | `src/shared/ai/context/prompt/` | 段落 / 模板 / 注册表 |

---

**文档版本**: 4.0
**最后更新**: 2026-11-23
**维护者**: Novel 开发团队
