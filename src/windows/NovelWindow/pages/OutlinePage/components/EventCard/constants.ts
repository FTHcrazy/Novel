/**
 * 实体类型 → 色槽 / 中文名（outline 工作台共用）
 *
 * 单独成文件而不是从 EventCard 导出：组件文件只导出组件，才能保住
 * react-refresh 的边界（否则每次改常量都会整块热更新失效）。
 * 色槽复用既有 accent，不自造色相（AGENTS §6.1.4）。
 */
import type { OutlineEntityDTO } from "@/shared/types/electron";

export const ENTITY_TYPE_COLOR: Record<OutlineEntityDTO["type"], [string, string]> = {
  char: ["var(--app-accent-blue)", "var(--app-accent-blue-weak)"],
  force: ["var(--app-accent-rose)", "var(--app-accent-rose-weak)"],
  item: ["var(--app-accent-amber)", "var(--app-accent-amber-weak)"],
  place: ["var(--app-accent-teal)", "var(--app-accent-teal-weak)"],
  clue: ["var(--app-accent-purple)", "var(--app-accent-purple-weak)"],
};

export const ENTITY_TYPE_LABEL: Record<OutlineEntityDTO["type"], string> = {
  char: "角色",
  force: "势力",
  item: "物品",
  place: "地点",
  clue: "线索",
};
