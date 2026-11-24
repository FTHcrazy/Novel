import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Input, InputNumber, Modal, Popover } from "antd";
import type { InputRef } from "antd";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LedgerLog, LedgerResource } from "../../pack-ledger";
import {
  hasRevokableLog,
  isOverCap,
  ledgerProgressPercent,
  listLedgerLogs,
} from "../../pack-ledger";
import LedgerAdjustPopover from "../LedgerAdjustPopover";
import LedgerLogList from "../LedgerLogList";
import "./index.scss";

/**
 * 资源行（spec 11.2 / 11.4 六态：静止 / 悬停 / 展开流水 / 记账 / 改名 / 删除确认）
 *
 * - 记账唯一入口是行尾 − / ＋（只定默认方向）；点余额数字等效盘点核对；
 * - 拖拽仅把手可发起：useSortable 自注册，listeners 只挂在把手上（@dnd-kit，
 *   QuickLedger 的 DndContext restrictToVerticalAxis 锁竖向）；
 * - 键盘替代：行内任一控件聚焦时 Alt+↑/↓ 上移 / 下移（spec 11.3）；
 * - 删除走 Modal.confirm，文案明示「资源与其全部流水一并删除」。
 *
 * 自带造型的控件全部由 antd Button 承载（拿到键盘 / 焦点环 / 禁用语义），
 * 外观经 `widget.cpk-widget` 清零后重绘 —— 与 PackModuleShell 同一纪律。
 */
export interface LedgerRowProps {
  resource: LedgerResource;
  logs: LedgerLog[];
  currentChapterId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onAdjust: (delta: number, note: string) => void;
  onAudit: (actual: number, note: string) => void;
  onUndo: () => void;
  onRename: (name: string) => void;
  onSetCap: (cap: number | null) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  /** 本行正处于拖拽中（来自宿主 DndContext 的 active id） */
  dragActive: boolean;
  /** 记账成功高亮闪烁（120ms --app-t-fast，数字变了要被看见） */
  flash: boolean;
  /** chapterId → 展示名（「第 N 章 · 标题」），宿主解析后转发给流水列表 */
  chapterNames?: Record<string, string>;
}

export default function LedgerRow({
  resource,
  logs,
  currentChapterId,
  expanded,
  onToggleExpand,
  onAdjust,
  onAudit,
  onUndo,
  onRename,
  onSetCap,
  onDelete,
  onMove,
  dragActive,
  flash,
  chapterNames,
}: LedgerRowProps) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustDirection, setAdjustDirection] = useState<1 | -1>(1);
  const [auditOpen, setAuditOpen] = useState(false);
  /** 展开流水区的「盘点」按钮独立开合：与余额点的盘点 Popover 互不带动 */
  const [slotAuditOpen, setSlotAuditOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(resource.name);
  const [capOpen, setCapOpen] = useState(false);
  const [draftCap, setDraftCap] = useState<number | null>(resource.cap ?? null);
  const nameInputRef = useRef<InputRef | null>(null);

  useEffect(() => {
    if (renaming) {
      setDraftName(resource.name);
      // 等输入框挂载后全选现名（spec 11.4：改名进入即全选）
      window.setTimeout(() => nameInputRef.current?.select(), 0);
    }
  }, [renaming, resource.name]);

  /** 键盘可达兜底（spec 11.3）：行内任一控件聚焦时 Alt+↑/↓ 移动本行 */
  const handleRowKeyDown = (event: React.KeyboardEvent) => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove(1);
    }
  };

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== resource.name) onRename(trimmed);
    setRenaming(false);
  };

  const confirmDelete = () => {
    Modal.confirm({
      title: `删除「${resource.name}」？`,
      content: "该资源与其全部流水将一并删除，不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: onDelete,
    });
  };

  const menu = {
    items: [
      { key: "rename", label: "改名" },
      ...(resource.kind === "progress" ? [{ key: "cap", label: "设置上限" }] : []),
      { key: "up", label: "上移（Alt+↑）" },
      { key: "down", label: "下移（Alt+↓）" },
      { type: "divider" as const },
      { key: "delete", label: "删除", danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === "rename") setRenaming(true);
      if (key === "cap") setCapOpen(true);
      if (key === "up") onMove(-1);
      if (key === "down") onMove(1);
      if (key === "delete") confirmDelete();
    },
  };

  const progress = ledgerProgressPercent(resource);
  const over = isOverCap(resource);
  // sortable 注册：整行为可排序节点，listeners 只挂把手（资源名 / 数量区不触发拖拽）
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: resource.id });
  const countText =
    resource.kind === "progress" && typeof resource.cap === "number"
      ? `${resource.count.toLocaleString("en-US")} / ${resource.cap.toLocaleString("en-US")}`
      : resource.count.toLocaleString("en-US");

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`lq-row${isDragging || dragActive ? " lq-row--dragging" : ""}${expanded ? " lq-row--expanded" : ""}${flash ? " lq-row--flash" : ""}`}
    >
      <div className="lq-row__main" onKeyDown={handleRowKeyDown}>
        <Button
          type="text"
          ref={setActivatorNodeRef}
          className="lq-row__grip"
          title="拖动排序"
          aria-label={`拖动排序：${resource.name}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </Button>
        {renaming ? (
          <Input
            ref={nameInputRef}
            className="lq-row__rename"
            value={draftName}
            maxLength={20}
            onChange={(event) => setDraftName(event.target.value)}
            onPressEnter={commitRename}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <Button type="text" className="lq-row__name" onClick={onToggleExpand} title={expanded ? "收起流水" : "展开流水"}>
            <span className="lq-row__name-text">{resource.name}</span>
            {resource.unit ? <span className="lq-row__unit">（{resource.unit}）</span> : null}
            {resource.kind === "progress" ? (
              <span className="lq-row__badge" title="进度型资源：带可选上限">
                进度
              </span>
            ) : null}
          </Button>
        )}
        <span className="lq-row__spacer" />
        <LedgerAdjustPopover
          resource={resource}
          mode="audit"
          direction={1}
          open={auditOpen}
          onOpenChange={setAuditOpen}
          onConfirm={onAudit}
        >
          <Button
            type="text"
            className={`lq-row__count${resource.count < 0 ? " lq-row__count--neg" : ""}${over ? " lq-row__count--over" : ""}`}
            title="点按直接输入实际数（盘点核对）"
          >
            {countText}
          </Button>
        </LedgerAdjustPopover>
        <LedgerAdjustPopover
          resource={resource}
          mode="adjust"
          direction={-1}
          open={adjustOpen && adjustDirection === -1}
          onOpenChange={(next) => {
            setAdjustDirection(-1);
            setAdjustOpen(next);
          }}
          onConfirm={onAdjust}
        >
          <Button
            type="text"
            className="lq-row__op"
            aria-label={`减少 ${resource.name}`}
            onClick={() => {
              setAdjustDirection(-1);
              setAdjustOpen(true);
            }}
          >
            −
          </Button>
        </LedgerAdjustPopover>
        <LedgerAdjustPopover
          resource={resource}
          mode="adjust"
          direction={1}
          open={adjustOpen && adjustDirection === 1}
          onOpenChange={(next) => {
            setAdjustDirection(1);
            setAdjustOpen(next);
          }}
          onConfirm={onAdjust}
        >
          <Button
            type="text"
            className="lq-row__op"
            aria-label={`增加 ${resource.name}`}
            onClick={() => {
              setAdjustDirection(1);
              setAdjustOpen(true);
            }}
          >
            ＋
          </Button>
        </LedgerAdjustPopover>
        <Popover
          trigger="click"
          placement="bottomRight"
          arrow={false}
          open={capOpen}
          onOpenChange={setCapOpen}
          classNames={{ root: "lq-pop" }}
          content={
            <div className="lq-cap">
              <p className="lq-cap__title">设置上限 · {resource.name}</p>
              <div className="lq-cap__row">
                <InputNumber
                  className="lq-cap__input"
                  value={draftCap}
                  onChange={(next) => setDraftCap(next)}
                  precision={0}
                  min={1}
                  placeholder="留空＝无上限"
                />
              </div>
              <div className="lq-cap__actions">
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    onSetCap(draftCap);
                    setCapOpen(false);
                  }}
                >
                  确认
                </Button>
              </div>
            </div>
          }
        >
          <span className="lq-row__anchor" />
        </Popover>
        <Dropdown menu={menu} trigger={["click"]} classNames={{ root: "lq-dropdown" }}>
          <Button type="text" className="lq-row__more" aria-label={`${resource.name} 更多操作`}>
            ⋯
          </Button>
        </Dropdown>
      </div>
      {resource.kind === "progress" && progress !== null ? (
        <div className="lq-row__progtrack" aria-hidden>
          <div
            className={`lq-row__progfill${over ? " lq-row__progfill--over" : ""}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
      {expanded ? (
        <LedgerLogList
          logs={listLedgerLogs(resource.id, logs)}
          currentChapterId={currentChapterId}
          chapterNames={chapterNames}
          canUndo={hasRevokableLog(resource.id, logs)}
          onUndo={onUndo}
          auditSlot={
            <LedgerAdjustPopover
              resource={resource}
              mode="audit"
              direction={1}
              open={slotAuditOpen}
              onOpenChange={setSlotAuditOpen}
              onConfirm={onAudit}
            >
              <Button size="small" className="lq-logs__audit">
                盘点
              </Button>
            </LedgerAdjustPopover>
          }
        />
      ) : null}
    </div>
  );
}
