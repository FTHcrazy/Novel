/**
 * 出场 chip 折叠估算 + 搜索匹配（outline-plan-spec v7.1 §8.1/§8.9）
 *
 * 折叠是**估算**而非测量：chip 行宽在渲染前就要算出「放得下几枚」，估算
 * 公式与 CSS 尺寸同源（头像 18 + 名字 12/字 + 边距 + 常驻 ✕ 15），换行
 * 判断才稳定（v6.9 ③ 的教训：✕ 常驻尺寸恒定，行宽零位移）。
 */

/** 单枚 chip 的估算宽度（px，与 .cast 的 CSS 同源） */
export function estimateChipWidth(name: string, closeVisible = true): number {
  const avatar = 18; // 圆头像直径 + 间隙
  const text = [...name].length * 12; // CJK ≈ 12px/字（font-size 12）
  const padding = 9; // 左右内边距
  const close = closeVisible ? 15 : 0; // 常驻 ✕（进卡浮现占位）
  return avatar + text + padding + close;
}

export interface ChipFoldResult {
  /** 放得下的名字（按输入顺序保留） */
  visible: string[];
  /** 折叠数量（「+N」） */
  hiddenCount: number;
}

/**
 * 超宽折叠（FR §8.1）：给一行可用宽度，尽量多放 chip，剩余折叠为「+N」。
 * 「+N」摘要徽章本身占宽，估算时预留。
 */
export function foldChips(
  names: readonly string[],
  maxWidth: number,
  closeVisible = true,
): ChipFoldResult {
  const plusBadgeWidth = 30;
  const visible: string[] = [];
  let used = 0;
  for (let index = 0; index < names.length; index += 1) {
    const width = estimateChipWidth(names[index], closeVisible);
    const isLast = index === names.length - 1;
    const reserved = isLast ? 0 : plusBadgeWidth;
    if (used + width + (visible.length > 0 ? reserved : 0) > maxWidth && visible.length > 0) {
      return { visible, hiddenCount: names.length - visible.length };
    }
    if (visible.length === 0 && width > maxWidth) {
      // 第一枚就放不下：至少显示它（截断交给 CSS），不算折叠
      visible.push(names[index]);
      return { visible, hiddenCount: names.length - 1 };
    }
    used += width;
    visible.push(names[index]);
  }
  return { visible, hiddenCount: 0 };
}

// ── 搜索匹配（§8.9：只高亮不隐藏） ──

/** 可被搜索的纯位置视图（渲染层按 id 补齐其余字段） */
export interface SearchableEvent {
  id: string;
  title: string;
  body: string;
  whenText: string;
  /** 出场实体名 + 别名（已展平） */
  castNames: readonly string[];
}

/** 事件是否命中：标题 / 正文 / 时间文本 / 出场名与别名，大小写不敏感 */
export function matchEvent(event: SearchableEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (
    event.title.toLowerCase().includes(needle) ||
    event.body.toLowerCase().includes(needle) ||
    event.whenText.toLowerCase().includes(needle)
  ) {
    return true;
  }
  return event.castNames.some((name) => name.toLowerCase().includes(needle));
}

/** 泳道 / 区域 / 时代带名称命中（搜索范围含结构名，§8.9） */
export function matchLabel(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return label.toLowerCase().includes(needle);
}
