import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Input, InputNumber, Popover, Select } from "antd";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { createNovelId } from "@/shared/services/novel-shared";
import { downloadText } from "../../services/pack-export";
import type { PackPanelApi } from "../../hooks/usePackPanel";
import { ledgerOf } from "../../hooks/usePackData";
import { PACK_BAND_WIDTHS, QTY_MAX } from "../../pack-config";
import type { LedgerResource, LedgerSection } from "../../pack-ledger";
import {
  applyLedgerAdjust,
  applyLedgerAudit,
  applyLedgerTemplate,
  buildInitLog,
  buildLedgerExport,
  buildLedgerExportWithLogs,
  buildLedgerField,
  buildLedgerResource,
  hasDuplicateLedgerName,
  isLedgerFull,
  LEDGER_RESOURCE_MAX,
  LEDGER_TEMPLATES,
  removeLedgerResource,
  reorderLedgerResources,
  sortLedgerFields,
  sortLedgerResources,
  voidLastLedgerLog,
} from "../../pack-ledger";
import LedgerRow from "../LedgerRow";
import LedgerTemplatePopover from "../LedgerTemplatePopover";
import NoteFields from "../NoteFields";
import PackModeSwitch from "../PackModeSwitch";
import "./index.scss";

/**
 * 盘点台账（spec：docs/spec/pack-quickcard-spec.md v1.3）—— 行囊的**默认形态**。
 *
 * 打开即记账：一张资源表（资源名 + 当前值），行尾 − / ＋ 快捷加减，余额即时
 * 更新并写流水；「盘点」对账防吃书；数值模块整体收进「进阶」面板（FR-06）。
 *
 * 领域规则全在 `pack-ledger.ts` 纯函数里，本组件只做编排与渲染；
 * 数据经 `api.mutateQuickcard` 落文档（随整文档走草稿 / 保存 / 关闭守卫）。
 */

const GUIDE_STEPS = [
  { key: "adjust", text: "资源行 ＋ / −：随手记账，余额即时更新" },
  { key: "audit", text: "「盘点」：写到中期对一次账，防止吃书" },
  { key: "advanced", text: "「进阶」：属性 / 装备等数值工具收在这里" },
] as const;

/** 台账编辑结果的统一合并：流水 / 资源变更 + 备注字段原样保留 */
function withMutation(section: LedgerSection, mutation: { resources: LedgerResource[]; logs: typeof section.logs } | null): LedgerSection | null {
  if (!mutation) return null;
  return { ...section, resources: mutation.resources, logs: mutation.logs };
}

export interface QuickLedgerProps {
  api: PackPanelApi;
  chapterId: string;
  /** 形态切换（FR-06 / FR-11）：宿主统一切 prefs + 联动条幅宽度 */
  onSwitchMode: (mode: "quickcard" | "advanced") => void;
}

export default function QuickLedger({ api, chapterId, onSwitchMode }: QuickLedgerProps) {
  const doc = api.doc;
  const section = ledgerOf(doc);
  const resources = useMemo(() => sortLedgerResources(section.resources), [section.resources]);
  const fields = useMemo(() => sortLedgerFields(section.fields), [section.fields]);
  const characterName = doc?.character.displayName || doc?.character.name || "主角";

  // ── 视图状态 ──
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  // 新建资源
  const [draftName, setDraftName] = useState("");
  const [draftKind, setDraftKind] = useState<"counter" | "progress">("counter");
  const [draftCap, setDraftCap] = useState<number | null>(null);
  // 流水章节列（chapterId → 「第 N 章 · 标题」）：novel-chapters-meta 批量解析并缓存
  const [chapterNames, setChapterNames] = useState<Record<string, string>>({});
  // 拖拽（@dnd-kit sortable）：仅把手可发起（LedgerRow 内自注册），4px 阈值防误拖
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const flash = (resourceId: string) => {
    setFlashId(resourceId);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashId(null), 500);
  };

  /** 记账成功 Toast（spec 11.5：数字变了要被看见） */
  const toastAdjusted = (resource: LedgerResource, delta: number, kind: "adjust" | "audit") => {
    api.showToast(
      `${kind === "audit" ? "已盘点" : "已记"}：${resource.name} ${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US")}`,
    );
  };

  // ── 台账动作（领域规则在 pack-ledger，这里只编排） ──

  const handleAdjust = (resource: LedgerResource, delta: number, note: string) => {
    api.mutateQuickcard((current) => {
      const next = withMutation(
        current,
        applyLedgerAdjust(current, resource.id, delta, {
          id: createNovelId("pql"),
          ts: Date.now(),
          chapterId: chapterId || undefined,
          note: note || undefined,
        }),
      );
      return next;
    });
    flash(resource.id);
    toastAdjusted(resource, delta, "adjust");
  };

  const handleAudit = (resource: LedgerResource, actual: number, note: string) => {
    if (actual === resource.count) {
      api.showToast("账实一致", "info");
      return;
    }
    api.mutateQuickcard((current) =>
      withMutation(
        current,
        applyLedgerAudit(current, resource.id, actual, {
          id: createNovelId("pql"),
          ts: Date.now(),
          chapterId: chapterId || undefined,
          note: note || undefined,
        }),
      ),
    );
    flash(resource.id);
    toastAdjusted(resource, actual - resource.count, "audit");
  };

  const handleUndo = (resource: LedgerResource) => {
    api.mutateQuickcard((current) =>
      withMutation(current, voidLastLedgerLog(current, resource.id)),
    );
    api.showToast(`已撤销 ${resource.name} 最后一笔`, "info");
  };

  const handleRename = (resource: LedgerResource, name: string) => {
    api.mutateQuickcard((current) => ({
      ...current,
      resources: current.resources.map((row) =>
        row.id === resource.id ? { ...row, name: name.trim().slice(0, 20) } : row,
      ),
    }));
    if (hasDuplicateLedgerName(resources, name, resource.id)) {
      api.showToast("已有同名资源（按条目区分，不影响记账）", "info");
    }
  };

  const handleSetCap = (resource: LedgerResource, cap: number | null) => {
    api.mutateQuickcard((current) => ({
      ...current,
      resources: current.resources.map((row) =>
        row.id === resource.id
          ? { ...row, cap: resource.kind === "progress" && cap !== null && cap > 0 ? cap : undefined }
          : row,
      ),
    }));
  };

  const handleDelete = (resource: LedgerResource) => {
    api.mutateQuickcard((current) =>
      withMutation(current, removeLedgerResource(current, resource.id)) ?? current,
    );
    if (expandedId === resource.id) setExpandedId(null);
    api.showToast(`已删除 ${resource.name}（含全部流水）`, "info");
  };

  const handleMove = (resource: LedgerResource, direction: -1 | 1) => {
    const index = resources.findIndex((row) => row.id === resource.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= resources.length) return;
    api.mutateQuickcard((current) => ({
      ...current,
      resources: reorderLedgerResources(
        sortLedgerResources(current.resources),
        index,
        target,
      ),
    }));
  };

  const handleAdd = () => {
    const name = draftName.trim();
    if (!name) return;
    if (isLedgerFull(resources)) {
      api.showToast(`资源已达上限 ${LEDGER_RESOURCE_MAX} 条`, "info");
      return;
    }
    api.mutateQuickcard((current) => {
      const id = createNovelId("pqr");
      const sortOrder =
        current.resources.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 1;
      const resource = buildLedgerResource(id, name, draftKind, sortOrder, draftCap ?? undefined);
      return {
        ...current,
        resources: [...current.resources, resource],
        logs: [...current.logs, buildInitLog(createNovelId("pql"), id, Date.now(), chapterId || undefined)],
      };
    });
    setDraftName("");
    setDraftKind("counter");
    setDraftCap(null);
    setAddOpen(false);
    if (hasDuplicateLedgerName(resources, name)) {
      api.showToast("已有同名资源（按条目区分，不影响记账）", "info");
    } else {
      api.showToast(`已添加 ${name}`);
    }
  };

  const handleTemplatePick = (templateKey: string) => {
    const template = LEDGER_TEMPLATES.find((item) => item.key === templateKey);
    if (!template) return;
    api.mutateQuickcard((current) =>
      withMutation(
        current,
        applyLedgerTemplate(current, template, () => createNovelId("pqr"), Date.now(), chapterId || undefined),
      ),
    );
    if (template.resources.length > 0) {
      api.showToast(`已按「${template.label}」追加资源（同名跳过）`);
    } else {
      api.showToast("空白台账：直接添加资源开始记账", "info");
    }
  };

  // ── 备注字段 ──

  const handleAddField = () => {
    api.mutateQuickcard((current) => ({
      ...current,
      fields: [
        ...current.fields,
        buildLedgerField(createNovelId("pqf"), "新备忘", current.fields.length + 1),
      ],
    }));
  };

  const handleRenameField = (id: string, name: string) => {
    api.mutateQuickcard((current) => ({
      ...current,
      fields: current.fields.map((row) =>
        row.id === id ? { ...row, name: name.slice(0, 20) } : row,
      ),
    }));
  };

  const handleValueField = (id: string, value: string) => {
    api.mutateQuickcard((current) => ({
      ...current,
      fields: current.fields.map((row) => (row.id === id ? { ...row, value } : row)),
    }));
  };

  const handleDeleteField = (id: string) => {
    api.mutateQuickcard((current) => ({
      ...current,
      fields: current.fields.filter((row) => row.id !== id),
    }));
  };

  // ── 导出（FR-10，复用文本落盘通道） ──

  const exportLedger = async (withLogs: boolean) => {
    if (!doc) return;
    const text = withLogs
      ? buildLedgerExportWithLogs(section, characterName)
      : buildLedgerExport(section, characterName);
    const path = await downloadText(
      `行囊-${characterName}-${withLogs ? "台账+流水" : "台账"}.txt`,
      text,
    );
    if (path) api.showToast(`已导出：${path}`);
    else api.showToast("已取消导出", "info");
  };

  // ── 手动拖宽记忆（FR-11：拖过就以手动值为准，联动让位） ──

  useEffect(() => {
    let timer: number | null = null;
    const onResize = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const width = window.innerWidth;
        if (width >= PACK_BAND_WIDTHS.min && width <= PACK_BAND_WIDTHS.max) {
          if (width !== (api.prefs.ledgerBandWidth ?? PACK_BAND_WIDTHS.ledger)) {
            api.patchPrefs({ ledgerBandWidth: width });
          }
        }
      }, 400);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api]);

  // ── 流水章节名解析：日志里出现新章节 id 就批量拉一次元数据（已解析的跳过） ──

  useEffect(() => {
    const ids = [
      ...new Set(
        section.logs
          .map((log) => log.chapterId)
          .filter((id): id is string => Boolean(id)),
      ),
    ].filter((id) => !(id in chapterNames));
    if (ids.length === 0) return;
    let cancelled = false;
    void window.electronAPI?.novel.chaptersMeta(ids).then((meta) => {
      if (cancelled || !meta) return;
      setChapterNames((previous) => ({
        ...previous,
        ...Object.fromEntries(
          Object.entries(meta).map(([id, item]) => [id, `第${item.number}章 ${item.title}`]),
        ),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [section.logs, chapterNames]);

  // ── 拖拽排序（spec 11.3 → @dnd-kit sortable，与 SettingCenter 同一惯例）──

  // PointerSensor 带 4px distance 约束：行内点击不会误触发拖拽；
  // KeyboardSensor + sortableKeyboardCoordinates 让把手键盘可达（Space 拿起、箭头移动）。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => setDragActiveId(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    setDragActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = resources.findIndex((row) => row.id === active.id);
    const to = resources.findIndex((row) => row.id === over.id);
    if (from < 0 || to < 0) return;
    api.mutateQuickcard((current) => ({
      ...current,
      resources: reorderLedgerResources(sortLedgerResources(current.resources), from, to),
    }));
  };

  const handleDragCancel = () => setDragActiveId(null);

  /** 「添加资源」浮层内容：空态入口与行尾入口共用同一份（受控 addOpen） */
  const addContent = (
    <div className="lq-add">
      <p className="lq-add__title">添加资源</p>
      <Input
        className="lq-add__name"
        value={draftName}
        maxLength={20}
        placeholder="资源名，如「灵石」"
        onChange={(event) => setDraftName(event.target.value)}
        onPressEnter={handleAdd}
      />
      <div className="lq-add__row">
        <Select
          className="lq-add__kind"
          value={draftKind}
          onChange={(next) => setDraftKind(next)}
          options={[
            { value: "counter", label: "余额型" },
            { value: "progress", label: "进度型（带可选上限）" },
          ]}
        />
        {draftKind === "progress" ? (
          <InputNumber
            className="lq-add__cap"
            value={draftCap}
            onChange={(next) => setDraftCap(next)}
            precision={0}
            min={1}
            max={QTY_MAX}
            placeholder="上限（可空）"
          />
        ) : null}
      </div>
      <Button block type="primary" onClick={handleAdd} disabled={!draftName.trim()}>
        添加
      </Button>
    </div>
  );

  const guideDone = api.prefs.ledgerGuideDone === true;
  const [guideIndex, setGuideIndex] = useState<number>(guideDone ? -1 : 0);
  const empty = resources.length === 0;

  return (
    <div className="lq" aria-label="盘点台账">
      {/* 头部操作区：形态切换 + 模板 + 导出（spec 11.2） */}
      <div className="lq__headbar">
        <PackModeSwitch mode="quickcard" onChange={onSwitchMode} />
        <span className="lq__spacer" />
        <LedgerTemplatePopover
          open={templateOpen}
          onOpenChange={setTemplateOpen}
          existingCount={resources.length}
          onPick={handleTemplatePick}
        >
          <Button size="small" className="lq__tplbtn">
            ＋ 模板
          </Button>
        </LedgerTemplatePopover>
        <Dropdown
          trigger={["click"]}
          classNames={{ root: "lq-dropdown" }}
          menu={{
            items: [
              { key: "ledger", label: "导出台账" },
              { key: "logs", label: "导出台账+流水" },
            ],
            onClick: ({ key }) => void exportLedger(key === "logs"),
          }}
        >
          <Button size="small" className="lq__morebtn">
            ⋯
          </Button>
        </Dropdown>
      </div>

      {/* 卡片头：主角名 + 绑定角标（沿用现有绑定与改名事件） */}
      <div className="lq__cardhead">
        <span className="lq__avatar">{characterName.slice(0, 1)}</span>
        <span className="lq__who">{characterName}</span>
        <span className="lq__bind">
          {doc?.character.entityId ? "已绑定主角" : "未绑定主角"}
        </span>
        <span className="lq__spacer" />
        {api.dirty > 0 ? (
          <Button size="small" type="primary" className="lq__savebtn" onClick={() => void api.save("手动保存")}>
            保存 {api.dirty > 0 ? `(${api.dirty})` : ""}
          </Button>
        ) : null}
      </div>

      {/* 空态（FR-02）：引导选模板或直接添加 */}
      {empty ? (
        <div className="lq__empty">
          <p className="lq__empty-title">主角有多少家当，一表盘点</p>
          <p className="lq__empty-desc">系统点数、灵石、物品数量……随手加减，账实一致，防吃书</p>
          <div className="lq__empty-actions">
            <Button onClick={() => setTemplateOpen(true)}>选资源模板</Button>
            {/* 空态与行尾共用受控 Popover：此前空态按钮只 setState 无锚点，点击无反应 */}
            <Popover
              trigger="click"
              placement="top"
              arrow={false}
              open={addOpen}
              onOpenChange={setAddOpen}
              classNames={{ root: "lq-pop" }}
              content={addContent}
            >
              <Button type="primary">＋ 添加资源</Button>
            </Popover>
          </div>
        </div>
      ) : (
        <>
          {/* 首次引导（FR-08，≤3 步，跳过不再出现） */}
          {guideIndex >= 0 && guideIndex < GUIDE_STEPS.length ? (
            <div className="lq__guide">
              <p className="lq__guide-step">第 {guideIndex + 1} 步 / 共 {GUIDE_STEPS.length} 步</p>
              <p className="lq__guide-text">{GUIDE_STEPS[guideIndex].text}</p>
              <div className="lq__guide-actions">
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    if (guideIndex + 1 >= GUIDE_STEPS.length) {
                      api.patchPrefs({ ledgerGuideDone: true });
                      setGuideIndex(-1);
                    } else {
                      setGuideIndex(guideIndex + 1);
                    }
                  }}
                >
                  {guideIndex + 1 >= GUIDE_STEPS.length ? "完成" : "下一步"}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    api.patchPrefs({ ledgerGuideDone: true });
                    setGuideIndex(-1);
                  }}
                >
                  跳过
                </Button>
              </div>
            </div>
          ) : null}

          {/* 拖拽排序（spec 11.3）：restrictToVerticalAxis 锁死竖向，横向拖不出列 */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext
              items={resources.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="lq__rows">
                {resources.map((resource) => (
                  <LedgerRow
                    key={resource.id}
                    resource={resource}
                    logs={section.logs}
                    currentChapterId={chapterId}
                    expanded={expandedId === resource.id}
                    onToggleExpand={() => setExpandedId((previous) => (previous === resource.id ? null : resource.id))}
                    onAdjust={(delta, note) => handleAdjust(resource, delta, note)}
                    onAudit={(actual, note) => handleAudit(resource, actual, note)}
                    onUndo={() => handleUndo(resource)}
                    onRename={(name) => handleRename(resource, name)}
                    onSetCap={(cap) => handleSetCap(resource, cap)}
                    onDelete={() => handleDelete(resource)}
                    onMove={(direction) => handleMove(resource, direction)}
                    dragActive={dragActiveId === resource.id}
                    flash={flashId === resource.id}
                    chapterNames={chapterNames}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <div className="lq__addrow">
            <Popover
              trigger="click"
              placement="bottomLeft"
              arrow={false}
              open={addOpen}
              onOpenChange={setAddOpen}
              classNames={{ root: "lq-pop" }}
              content={addContent}
            >
              <Button type="dashed" block className="lq__addbtn" disabled={isLedgerFull(resources)}>
                ＋ 添加资源{isLedgerFull(resources) ? `（已达上限 ${LEDGER_RESOURCE_MAX}）` : ""}
              </Button>
            </Popover>
          </div>
        </>
      )}

      {/* 备注与规则备忘（FR-05）：可选折叠区，默认收起 */}
      {section.fields.length > 0 || !empty ? (
        <div className="lq__notescollapse">
          <Button
            type="text"
            block
            className="lq__notestoggle"
            onClick={() => setNotesOpen((previous) => !previous)}
          >
            {notesOpen ? "▾" : "▸"} 备注与规则备忘{fields.length > 0 ? ` (${fields.length})` : ""}
          </Button>
          {notesOpen ? (
            <NoteFields
              fields={fields}
              canAdd={fields.length < 50}
              onAdd={handleAddField}
              onRename={handleRenameField}
              onValue={handleValueField}
              onDelete={handleDeleteField}
            />
          ) : null}
        </div>
      ) : null}

      {/* 章节上下文（零新增 IPC）：复用行囊窗口已有 chapterId */}
      <div className="lq__chapterfoot">
        <span className="lq__chapterdot" />
        {chapterId ? "记账将关联当前章节" : "未关联章节（流水章节列为「—」）"}
      </div>
    </div>
  );
}
