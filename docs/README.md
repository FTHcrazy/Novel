# 项目文档索引

> 本目录只放**活规范**（`docs/spec/`）。代码规范主体在仓库根 `AGENTS.md`，
> 版本变更在 `CHANGELOG.md`，历史版本在 `changeLogHistory/`。
>
> 需求稿、审查稿与已闭环过程稿在 **1.0.0 定版时整体移除**：结论已沉淀进代码、
> `AGENTS.md` 与 `CHANGELOG.md`，同一事实不再两处维护。确需新立过程稿时，
> 按文末「存储规则」建篇并登记到下表，不要直接堆在 `docs/` 根下。

---

## 目录职责

| 目录 | 放什么 | 生命周期 |
|------|--------|----------|
| `docs/spec/` | **活规范**：长期有效、被代码或 `AGENTS.md` 直接引用、改版需同步守卫测试的技术规则 | 长期维护，只改版不删除 |
| `docs/README.md` | 文档索引（唯一导航入口） | 新增 / 删除文档时同步 |

仓库根只允许四份文档：`AGENTS.md`（规范）、`README.md`（安装与排障）、
`CHANGELOG.md`（版本变更）、以及本索引所在的 `docs/README.md`。
**禁止在根目录新增零散说明文件。**

---

## 当前文档清单（7 篇）

### docs/spec/ — 活规范

| 文档 | 结论一句话 | 被谁引用 |
|------|-----------|---------|
| [graphic-theming-spec.md](spec/graphic-theming-spec.md) | 图形素材主题化只有两条正道：`currentColor` 或语义 token；禁止钉死色值、禁止一主题一份资源 | `AGENTS.md` §6.1.4 |
| [map-db-spec.md](spec/map-db-spec.md) | 地图用独立 `map.db`（与 novel 平级）：`doc_json` 整存 + `rev` 乐观锁 + 防抖 800ms 自动保存 + 关窗 flush；`work_id` 可空、先建图后绑定、删作品不级联删图 | `electron/map/map-db.ts`、`map-handlers.ts`、`map-db-guard.test.ts`、MapWindow |
| [map-interaction-spec.md](spec/map-interaction-spec.md) | 地图编辑器交互与快捷键的**权威口径**：放置态 / 选中态 / 右键 / `Ctrl+C·X·V·D` / 方向键与 WASD / `Esc` 分层 / 撤销粒度七类；每行带守卫落点，无守卫的 14 条登记在 §8。**`Ctrl+D` 是复制一份不是删除** | `pages/MapEditorPage/index.tsx`、`hooks/useMapEditor.ts`、`store/useMapDocStore.ts`、`components/ElementPanel/` |
| [map-export-spec.md](spec/map-export-spec.md) | 导出规格：`exportMapPng` 与 DPR 解耦（`resolution: 1`，倍率在 `world.scale`）；三档 1024/2048/4096、默认 2048、单块上限 8192；只有 PNG（SVG / PDF 明确不做 + 解锁条件）；默认名 `地图-<档位>.png`；失败行为与视口复原时序 | `pages/MapEditorPage/export.ts`、`index.tsx`、`persistence/useMapPersistence.ts` |
| [map-perf-spec.md](spec/map-perf-spec.md) | 地图三项性能基线的**口径**（只定口径、不实测）：通过线分两层 —— 产品线（生成器 `dense` ≈190 元素，阻塞发布）与压力线（合成 2000+ 元素，只记趋势）；**通过线取 1s / ≥55fps**，`60fps` 只作理想线；2000+ 元素帧率取 `Ticker.deltaMS` 的 P50 判、P95 归因 | 各 spec 与 `AGENTS.md` §6.6（测试范围与守卫落点） |
| [outline-plan-spec.md](spec/outline-plan-spec.md) | 大纲产品方案 v5.1（草案，refactor 版）：大纲独立成域零绑定（灵感脉络画布）——书纲 / 分类 / 时间线 / 节点 / 连线 / 区域六表，与章节域互不引用；**连线三层**（父子结构 / 剧情推进主色粗箭头 / 关联虚线带标签）；**区域**可自划年代背景分区并写说明；树形 tidy 布局零重叠 + 动态锚点路由；画布框架定 `@xyflow/react` + `elkjs`；大纲视图同源，左栏四维度导航，位置与顺序解耦；右侧大纲板改名「伏笔埋设」功能全保留 | 实施时的 `novel-db.ts`、`handlers/novel/` 大纲 handler、`shared/novel/outline/` 布局纯函数、NovelPage `OutlineBoard`/`OutlineSidebar`/`OutlineTree`/`OutlineZone`、SupportPanel「伏笔埋设」改名 |
| [pack-quickcard-spec.md](spec/pack-quickcard-spec.md) | 行囊双形态改造（草案）：盘点台账默认态（资源条目+记账流水+盘点核对、资源模板、拖拽排序）+ 现有 10 模块收进进阶面板；窗口条幅化（禁最大化/全屏，小 400 / 中 720 两档，上限工作区一半），断点重校 760/600 | 实施时的 `CharacterPack`、`createPackWindow`、`pack-layout` / `pack-config` 守卫 |

---

## 存储规则速查

1. **一篇一个主题，命名 `<主题>-spec.md`**。本目录只收「违反即缺陷」的规则；
   过程稿（需求 / 预研 / 排期 / 审查 / 验收）不进本目录 —— 结论并入 `AGENTS.md`
   或 `CHANGELOG.md`，不留第二份要维护的正文。
2. **每篇头部三行必填**，缺任何一项都无法判断它是否过时：

```md
> 状态：草案 / 定稿 / 已实施（闭环版本 X.Y.Z）
> 输入：上游依据（代码路径或 `AGENTS.md` 章节；无则写「无」）
> 基线：对应代码版本或提交哈希
```

3. **改版不改名**：规则修订直接改正文并更新「基线」；只有整篇被新方案推翻时，
   才新建一篇并在同一次改动里删掉旧的（不留「两份都像有效」的状态）。
4. **移动 / 删除必须同一次改完引用**：`AGENTS.md`、`README.md`、`src/**` 注释、
   `*.yaml` 注释都算引用面，**不许留悬空路径**：

```bash
# --exclude-dir 必须用（别用 | grep -v node_modules：那是按行过滤，扫不干净）
grep -rn "docs/[A-Za-z0-9._/-]*\.md" \
  --include="*.md" --include="*.ts" --include="*.tsx" --include="*.yaml" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=dist-electron --exclude-dir=release --exclude-dir=changeLogHistory . | grep "docs/"
```

5. **索引双向**：新增 / 删除文档必须改本文件的上表；`docs/` 下每篇文档都要在索引里，
   索引里每条链接都要真实存在。由 `electron/docs-index-guard.test.ts` 断言。
6. **`CHANGELOG.md` / `changeLogHistory/` 里的 `docs/...` 路径是历史记录**，
   对应文件可能已删除。查历史时以「当时确实存在」理解，不要据此判定文档缺失；
   现存的文档一律以本索引为准。
