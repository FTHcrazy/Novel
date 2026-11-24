/**
 * 要素类型 chip
 *
 * 分类信息由**左侧色带**（`meta.color`）承担，不再渲染单字前缀——前缀对
 * 自建类型一律是「其」，完全没有信息量，反而把自定义类型的 chip 挤得
 * 认不出名字（真机反馈「前缀完全是废话」）。
 *
 * 形态严格按 §6.1.2：纯展示用 antd `Tag`；可点筛选用 antd `Button` +
 * `aria-pressed`（一个按钮承载，不嵌按钮）。
 */
import type { CSSProperties, ReactNode } from "react";
import { Button, Tag } from "antd";
import type { EntityTypeMeta } from "@/shared/novel/entity-type-meta";
import "./index.scss";

export interface EntityTypeChipProps {
  /** 由 `useEntityTypeMeta().metaOf(type)` 提供，禁止调用方硬编码前缀 */
  meta: EntityTypeMeta;
  /** 前缀后的内容：类型名 / 实体名 / 计数 */
  children?: ReactNode;
  /**
   * 传了即为「可点筛选」形态：antd Button + aria-pressed；
   * 不传则为纯展示 Tag。
   */
  onClick?: () => void;
  /** 可点筛选时的选中态 */
  pressed?: boolean;
  className?: string;
  title?: string;
}

export default function EntityTypeChip({
  meta,
  children,
  onClick,
  pressed = false,
  className = "",
  title,
}: EntityTypeChipProps) {
  const content = <span className="nv-type-chip__label">{children ?? meta.label}</span>;
  // 颜色只落在左边框色带上：正文走主题变量，分类靠色带辨识。
  // 同时以自定义属性把类型色交给外层：右栏筛选 chip 的选中态要用同一个色相上色
  // （浅底 + 同色描边），否则得让调用方再写一遍内联样式、两份颜色必然漂移。
  const bandStyle = {
    borderLeftColor: meta.color,
    "--nv-chip-color": meta.color,
  } as CSSProperties;

  if (onClick) {
    return (
      <Button
        className={`nv-type-chip nv-type-chip--action${pressed ? " is-on" : ""} ${className}`.trim()}
        style={bandStyle}
        aria-pressed={pressed}
        title={title}
        onClick={onClick}
      >
        {content}
      </Button>
    );
  }

  return (
    <Tag
      className={`nv-type-chip nv-type-chip--static ${className}`.trim()}
      style={bandStyle}
      title={title}
    >
      {content}
    </Tag>
  );
}
