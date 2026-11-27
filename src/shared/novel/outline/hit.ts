/**
 * 拖拽命中走廊判定（outline-plan-spec v7.1 §8.8，FR-03）
 *
 * **与落格高亮同源**是硬约束（§15：命中判定与高亮同帧同源，守卫禁止两套
 * 几何）——渲染层的高亮 overlay 与松手落格都调这里的同一对函数。
 *
 * 纵向走廊收窄是 v7.5 修「隔列过户」的定案：纵向列宽 420px 而可见内容仅
 * ~216px，命中走廊 = 列左缘 + V_HIT_W(300px)，走廊外不命中——松手吸回
 * 原格，绝不过户邻列。列头上方落格视为第 0 格（插顶一次到位）。
 *
 * 横向行带不再用「统一行距 × 行号」换算：同槽堆叠卡是**纵向排**的，行高必然
 * 随该行的堆叠深度变化（写死行距时卡底会戳出泳道行、第二张卡压住第一张）。
 * 渲染层把每行的实际 {top,height} 算好后传进来，命中 / 高亮 / 渲染共用同一份。
 */

/** 布局常量（与原型 design/outline-timeline-prototype.html v7.x 同值） */
export const EV_W = 208; // 卡片宽
export const GAP = 44; // 卡片间距
export const STEP = EV_W + GAP; // 横向槽步距 252
export const ROW_H = 176; // 纵向槽行距下限（实际取 max(ROW_H, 卡高 + ROW_GAP)）
export const ROW_GAP = 24; // 纵向相邻槽之间给卡的呼吸位
export const GUTTER = 108; // 内容区左缘（标头列 92 + 16 余量）
export const V_COL_W = 420; // 纵向列宽
export const V_COL_GAP = 48; // 纵向列间距
export const V_HIT_W = 300; // 纵向命中走廊宽（防隔列过户）

/** 横向行带的内距：上留白（区域 / 时代标签位）+ 下留白 + 同槽堆叠间距 */
export const ROW_TOP = 58;
/** 行底留白：设计稿 .lane margin-bottom 24——卡底到下一行标头留出呼吸位 */
export const ROW_BOTTOM = 24;
export const STACK_GAP = 12;

/**
 * 横向泳道行高：按本行**最大堆叠层数**展开。
 * 堆叠卡是纵向排的，行高写死「只放一张卡」时，第二张卡会压住第一张、卡底也会
 * 戳出泳道行框——行高必须与堆叠深度和实测卡高同源。
 */
export function laneRowHeight(depth: number, cardH: number): number {
  const layers = Math.max(1, depth);
  return ROW_TOP + layers * cardH + (layers - 1) * STACK_GAP + ROW_BOTTOM;
}

/** 横向：第 stackIdx 张堆叠卡的行内 top（行带顶 + 上留白 + 层距） */
export function stackCardTop(laneTop: number, stackIdx: number, cardH: number): number {
  return laneTop + ROW_TOP + stackIdx * (cardH + STACK_GAP);
}

/**
 * 横向行带：按每条泳道的最大堆叠层数自上而下排开（行高见 laneRowHeight）。
 * 渲染（行框 / 卡位 / zone / 连线）、命中、落格高亮共用这一份几何。
 */
export function buildLaneBands(
  depths: readonly number[],
  cardH: number,
  startTop = 0,
): LaneBand[] {
  const bands: LaneBand[] = [];
  let cursor = startTop;
  for (const depth of depths) {
    const height = laneRowHeight(depth, cardH);
    bands.push({ top: cursor, height });
    cursor += height;
  }
  return bands;
}

export type AxisDirection = "h" | "v";

export interface DropTarget {
  laneId: string;
  slot: number;
}

/** 横向泳道行带（画布内容坐标系）；高度由该行的最大堆叠深度决定 */
export interface LaneBand {
  top: number;
  height: number;
}

/**
 * 命中判定（横向）：指针在画布**内容坐标系**内的 (x, y) → 目标格。
 * - 行（泳道）按 y 落在哪个行带判定，行序与渲染顺序一致；
 * - 槽按 x 换算：x < GUTTER（标头列）不命中；负槽号 clamp 到第 0 格；
 * - 落在所有行带之外（上下留白）不命中，松手吸回原格。
 */
export function hitHorizontal(
  x: number,
  y: number,
  laneIds: readonly string[],
  bands: readonly LaneBand[],
): DropTarget | null {
  if (laneIds.length === 0 || bands.length === 0) return null;
  if (x < GUTTER) return null;
  const rowIndex = bands.findIndex((band) => y >= band.top && y < band.top + band.height);
  if (rowIndex < 0 || rowIndex >= laneIds.length) return null;
  const slot = Math.max(0, Math.floor((x - GUTTER) / STEP));
  return { laneId: laneIds[rowIndex], slot };
}

/**
 * 命中判定（纵向）：列左缘 + V_HIT_W 走廊；走廊外返回 null。
 * slotsTop = 列内槽区顶；y < slotsTop 视为第 0 格（列头上方落格 = 插顶）。
 * rowPitch 随实测卡高传入（默认取常量下限），与渲染同源。
 */
export function hitVertical(
  x: number,
  y: number,
  laneIds: readonly string[],
  slotsTop: number,
  rowPitch: number = ROW_H,
): DropTarget | null {
  const pitch = V_COL_W + V_COL_GAP;
  const laneIndex = Math.floor(x / pitch);
  if (laneIndex < 0 || laneIndex >= laneIds.length) return null;
  if (x - laneIndex * pitch > V_HIT_W) return null; // 走廊外：右侧留白不命中
  const pitchY = rowPitch > 0 ? rowPitch : ROW_H;
  const slot = y < slotsTop ? 0 : Math.max(0, Math.floor((y - slotsTop) / pitchY));
  return { laneId: laneIds[laneIndex], slot };
}

/**
 * 高亮矩形（与命中同源）：拖拽经过时渲染的格高亮 overlay 几何。
 * 纵向 = 走廊同宽（所见即所落，v7.5 ②）；
 * 横向 = 卡片列（设计稿 .cell-hl：top 58 / bottom 8）——高亮只框「将要落位的
 * 卡片列」，不能从行带顶部起，否则会盖住泳道标头那一行（v9 之前的偏差）。
 */
export function highlightRect(
  target: DropTarget,
  dir: AxisDirection,
  laneIndex: number,
  slotsTop: number,
  band: LaneBand,
  rowPitch: number = ROW_H,
): { x: number; y: number; width: number; height: number } {
  if (dir === "v") {
    const pitchY = rowPitch > 0 ? rowPitch : ROW_H;
    return {
      x: laneIndex * (V_COL_W + V_COL_GAP),
      y: slotsTop + target.slot * pitchY,
      width: V_HIT_W,
      height: pitchY,
    };
  }
  // 与卡片同宽并水平居中（卡左 = GUTTER + slot*STEP + (STEP-EV_W)/2）；
  // 底边贴卡堆底 + 4px（扣掉行底留白），不随行距变化拉长
  return {
    x: GUTTER + target.slot * STEP + (STEP - EV_W) / 2,
    y: band.top + ROW_TOP,
    width: EV_W,
    height: Math.max(0, band.height - ROW_TOP - ROW_BOTTOM + 4),
  };
}

/** 画布矩形（卡片 / 浮卡同一套几何语言） */
export type RectBox = { x: number; y: number; w: number; h: number };

/**
 * 引线终点：从矩形中心朝 toward 方向，求与矩形边框的交点。
 *
 * 浮卡虚线此前直接连宿主卡中心 → 线段横穿卡面（压在摘要和 chip 上）。
 * pad > 0 时沿同一方向再外推，让虚线止在边框外侧而不是压着描边。
 */
export function rectEdgePoint(
  rect: RectBox,
  toward: { x: number; y: number },
  pad = 0,
): { x: number; y: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : rect.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : rect.h / 2 / Math.abs(dy),
  );
  const edgeX = cx + dx * scale;
  const edgeY = cy + dy * scale;
  if (pad === 0) return { x: edgeX, y: edgeY };
  const len = Math.hypot(dx, dy) || 1;
  return { x: edgeX + (dx / len) * pad, y: edgeY + (dy / len) * pad };
}
