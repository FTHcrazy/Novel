/**
 * 事件卡（v9 原型 .ev 同源还原，§8.1）：
 * 序号方块 + 标题 / 固定两行摘要 / 时间·出场数 / 出场 chip（超宽折叠 +N）
 * + 常驻占位的 ✕（hover 浮现，行宽零位移）+「＋」加出场钮（Popover 选实体）。
 * 拖拽与点击都由父容器接手（onPointerDown / onClick 透传）。
 */
import { useMemo } from "react";
import { PlusOutlined } from "@ant-design/icons";
import type { OutlineCastDTO, OutlineEntityDTO, OutlineEventDTO } from "@/shared/types/electron";
import { foldChips } from "@/shared/novel/outline";
import CastPicker, { EntityAvatar } from "../CastPicker";
import "./index.scss";

const CHIP_ROW_WIDTH = 158; // 卡内宽（208 - 2×12 内距 - 26 右缘加号位）

export default function EventCard({
  event,
  chainNumber,
  casts,
  entities,
  selected,
  zoneArmTarget,
  chapterCount,
  onPointerDown,
  onClick,
  onRemoveCast,
  onAddCast,
  onCastPointerDown,
  onCastClick,
  draggingEntityId,
  castDropTarget,
  dimmed,
  setsize,
  posinset,
  floatingCastIds,
}: {
  event: OutlineEventDTO;
  chainNumber: number;
  casts: OutlineCastDTO[];
  entities: OutlineEntityDTO[];
  selected: boolean;
  /** 已拍入章节数（chapterRefs 计数，>0 才显示徽标） */
  chapterCount?: number;
  zoneArmTarget?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  onRemoveCast: (entityId: string) => void;
  onAddCast: (entityId: string) => void;
  /** chip 按下：拖出成浮卡 / 拖到别的卡改挂（父容器接管手势） */
  onCastPointerDown?: (entityId: string, e: React.PointerEvent) => void;
  /** 点 chip = 右栏角色汇总（FR-10） */
  onCastClick?: (entityId: string) => void;
  /** 正在被拖的 chip（淡出 32%） */
  draggingEntityId?: string | null;
  /** 当前是改挂落点（主色外环） */
  castDropTarget?: boolean;
  /** 搜索未命中（只压暗不隐藏，§8.9） */
  dimmed?: boolean;
  /** 同线事件总数 / 当前位次（无障碍：aria-setsize / posinset） */
  setsize?: number;
  posinset?: number;
  /** 已拖出成浮卡的角色：卡内不再重复展示（出场总数仍含它们） */
  floatingCastIds?: readonly string[];
}) {
  const byId = useMemo(
    () => new Map(entities.map((entity) => [entity.id, entity])),
    [entities],
  );

  /** 已拉出成浮卡的角色 → 卡内 chip 不再展示（否则同一角色在卡上和画布上各出现一次） */
  const floating = useMemo(
    () => new Set(floatingCastIds ?? []),
    [floatingCastIds],
  );

  /** cast 序（按 sort）→ {entityId, name}；chip 折叠按估算宽截断 */
  const chipList = useMemo(
    () =>
      [...casts]
        .filter((cast) => !floating.has(cast.entityId))
        .sort((a, b) => a.sort - b.sort)
        .map((cast) => ({
          entityId: cast.entityId,
          name: byId.get(cast.entityId)?.name ?? "?",
        })),
    [casts, byId, floating],
  );
  const fold = foldChips(
    chipList.map((item) => item.name),
    CHIP_ROW_WIDTH,
  );
  const visible = chipList.slice(0, fold.visible.length);

  /** 搜索（§8.9 只高亮不隐藏）：命中集合由父层统一算，卡内不再自判 */
  const dim = dimmed === true;

  return (
    <div
      className={[
        "ol-ev",
        selected ? "is-sel" : "",
        dim ? "is-dim" : "",
        zoneArmTarget ? "is-arm" : "",
        castDropTarget ? "is-castdrop" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={onPointerDown}
      onClick={onClick}
      data-event-id={event.id}
      role="listitem"
      tabIndex={0}
      aria-selected={selected}
      aria-setsize={setsize}
      aria-posinset={posinset}
      aria-label={`第 ${event.slot + 1} 格、第 ${chainNumber} 段、${event.title || "未命名事件"}、${casts.length} 个出场`}
    >
      <div className="ol-ev__top">
        <span className="ol-ev__idx">{chainNumber}</span>
        <span className="ol-ev__t">{event.title || "未命名事件"}</span>
      </div>
      <div className={`ol-ev__d${event.body ? "" : " is-empty"}`}>
        {event.body || "还没有摘要…"}
      </div>
      <div className="ol-ev__when">
        <span>{event.whenText || "时间未定"}</span>
        <span className="ol-ev__dot" />
        <span>{casts.length} 出场</span>
        {!!chapterCount && chapterCount > 0 && (
          <span className="ol-ev__chap">已拍 {chapterCount} 章</span>
        )}
      </div>
      <div className="ol-ev__casts">
        {visible.map((item) => {
          const entity = byId.get(item.entityId);
          return (
            <span
              className={`ol-cast${draggingEntityId === item.entityId ? " is-dragging" : ""}`}
              key={item.entityId}
              title={`${item.name}（拖到别的卡可改挂，拖到空白成浮卡）`}
              onPointerDown={(e) => {
                // chip 的手势不能冒泡成「拖整张卡」
                e.stopPropagation();
                if ((e.target as HTMLElement).closest(".ol-cast__x")) return;
                onCastPointerDown?.(item.entityId, e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                onCastClick?.(item.entityId);
              }}
            >
              <EntityAvatar entity={entity} />
              <span className="ol-cast__nm">{item.name}</span>
              <span
                className="ol-cast__x"
                role="button"
                tabIndex={0}
                aria-label={`移除 ${item.name} 出场`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveCast(item.entityId);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  onRemoveCast(item.entityId);
                }}
              >
                ✕
              </span>
            </span>
          );
        })}
        {fold.hiddenCount > 0 && <span className="ol-cast__more">+{fold.hiddenCount}</span>}
        <CastPicker entities={entities} casts={casts} onPick={onAddCast}>
          <span
            className="ol-ev__cast-add"
            role="button"
            tabIndex={0}
            aria-label="添加出场"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as HTMLElement).click();
            }}
          >
            <PlusOutlined />
          </span>
        </CastPicker>
      </div>
    </div>
  );
}
