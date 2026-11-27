/**
 * 角色选择浮层（设计稿 openCharPicker / .pop）：搜索框 + 实体列表。
 * 事件卡上的「＋」与右栏「＋ 添加」共用同一个浮层，避免两套长得不一样的选人界面。
 *
 * 行内右侧提示与设计稿一致：已在（本事件已有）/ N 处（别处出场数）/ 新（从未出场）。
 */
import { useMemo, useState } from "react";
import { Input, Popover } from "antd";
import type { OutlineCastDTO, OutlineEntityDTO } from "@/shared/types/electron";
import { ENTITY_TYPE_COLOR } from "../EventCard/constants";
import "./index.scss";

/** 实体头像（设计稿 .av）：圆底 + 首字，颜色取实体类型强调色 */
export function EntityAvatar({
  entity,
  size = 14,
}: {
  entity?: OutlineEntityDTO;
  size?: number;
}) {
  const color = entity ? ENTITY_TYPE_COLOR[entity.type][0] : "var(--app-text-muted)";
  return (
    <span
      className="ol-av"
      style={{ width: size, height: size, background: color }}
      aria-hidden
    >
      {entity ? ([...entity.name][0] ?? "?") : "?"}
    </span>
  );
}

export default function CastPicker({
  entities,
  casts,
  countOf,
  onPick,
  placement = "bottomRight",
  children,
}: {
  entities: OutlineEntityDTO[];
  /** 当前事件已有的出场（右侧提示「已在」） */
  casts: OutlineCastDTO[];
  /** 实体总出场数（右侧提示「N 处」） */
  countOf?: (entityId: string) => number;
  onPick: (entityId: string) => void;
  placement?: "bottomRight" | "bottomLeft";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");

  const had = useMemo(() => new Set(casts.map((cast) => cast.entityId)), [casts]);

  const list = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return entities.filter(
      (entity) =>
        !q ||
        entity.name.toLowerCase().includes(q) ||
        entity.aliases.toLowerCase().includes(q),
    );
  }, [entities, needle]);

  const hintOf = (entityId: string): string => {
    if (had.has(entityId)) return "已在";
    const count = countOf?.(entityId) ?? 0;
    return count > 0 ? `${count} 处` : "新";
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setNeedle("");
      }}
      trigger={["click"]}
      placement={placement}
      content={
        <div className="ol-pop">
          <Input
            className="ol-pop__input"
            placeholder="搜索或选择角色 / 实体"
            value={needle}
            allowClear
            onChange={(e) => setNeedle(e.target.value)}
          />
          <div className="ol-pop__list">
            {list.length === 0 && (
              <div className="ol-pop__empty">没有可添加的实体（先在右侧栏新建）</div>
            )}
            {list.map((entity) => (
              <button
                key={entity.id}
                type="button"
                className={`ol-pop__item${had.has(entity.id) ? " is-had" : ""}`}
                onClick={() => {
                  if (had.has(entity.id)) return;
                  onPick(entity.id);
                  setOpen(false);
                  setNeedle("");
                }}
              >
                <EntityAvatar entity={entity} size={18} />
                <span className="ol-pop__nm">{entity.name}</span>
                <span className="ol-pop__had">{hintOf(entity.id)}</span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      {children}
    </Popover>
  );
}
