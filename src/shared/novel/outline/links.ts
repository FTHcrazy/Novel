/**
 * 大纲画布连线几何（v9 原型 paintLinks / chainArrow 同源移植）。
 *
 * 两件事都按设计稿，不自造近似：
 * ① 浮卡牵线：端点落在**圆角轮廓**上（浮卡是胶囊、事件卡 12 圆角），控制点
 *    沿两端外法向外伸，斜向连接自然是 S 弯；踩到别的卡时整条曲线沿连线法向
 *    平移，由小到大试到不挡为止（设计稿 v9.2 / v9.4）。
 * ② 推进链：主轴向进出边 + 外伸控制点；跨格但错位大、间距窄时改画圆角肘
 *    （纯贝塞尔会鼓出夸张 S 弯）；有别的卡挡路时从中点分两段绕行（v7.6）。
 *
 * 组件只负责把卡片几何喂进来、把返回的 d / end / tan 画成 path + 三角箭头。
 */

export type Box = { left: number; top: number; right: number; bottom: number };
export type Point = { x: number; y: number };
/** 轮廓落点 + 朝外法向（单位向量） */
export type EdgeHit = Point & { nx: number; ny: number };

export const centerX = (box: Box): number => (box.left + box.right) / 2;
export const centerY = (box: Box): number => (box.top + box.bottom) / 2;
export const boxWidth = (box: Box): number => box.right - box.left;
export const boxHeight = (box: Box): number => box.bottom - box.top;

export function boxFromRect(rect: { x: number; y: number; w: number; h: number }): Box {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
  };
}

/** 矩形相交检测（连线避让用，设计稿 rectsHit） */
export function rectsHit(
  boxes: readonly Box[],
  left: number,
  right: number,
  top: number,
  bottom: number,
): Box[] {
  return boxes.filter(
    (box) => box.left < right && box.right > left && box.top < bottom && box.bottom > top,
  );
}

/**
 * 圆角轮廓上的落点（设计稿 rayEdgeRound）：沿中心 → 目标方向二分，
 * 返回轮廓上的点与朝外法向。按矩形算的点在斜向时落在圆角外面，线头会和
 * 卡边留出几像素缝隙——浮卡是胶囊（r = h/2）、事件卡圆角 12px，必须走轮廓。
 */
export function roundEdge(box: Box, toward: Point, radius: number): EdgeHit {
  const cx = centerX(box);
  const cy = centerY(box);
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy, nx: 0, ny: 0 };

  const hw = boxWidth(box) / 2;
  const hh = boxHeight(box) / 2;
  const r = Math.max(0, Math.min(radius, Math.min(hw, hh)));

  // 先按直角矩形求交点（哪个轴先到边界）
  const kx = dx === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(dx);
  const ky = dy === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(dy);
  const k = Math.min(kx, ky);
  let px = dx * k;
  let py = dy * k;

  // 交点落在圆角区 → 改求与角圆的交点（矩形角比圆角外，直接取交点会离线头几像素）
  if (Math.abs(px) > hw - r && Math.abs(py) > hh - r && r > 0) {
    const ox = Math.sign(px) * (hw - r);
    const oy = Math.sign(py) * (hh - r);
    const a = dx * dx + dy * dy;
    const b = dx * ox + dy * oy;
    const c = ox * ox + oy * oy - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (b + Math.sqrt(disc)) / a;
      px = dx * t;
      py = dy * t;
      const vx = px - ox;
      const vy = py - oy;
      const len = Math.hypot(vx, vy) || 1;
      return { x: cx + px, y: cy + py, nx: vx / len, ny: vy / len };
    }
  }

  let nx = 0;
  let ny = 0;
  if (Math.abs(px) > hw - r) nx = Math.sign(px) || 1;
  else if (Math.abs(py) > hh - r) ny = Math.sign(py) || 1;
  else if (Math.abs(dx) >= Math.abs(dy)) nx = Math.sign(px) || 1;
  else ny = Math.sign(py) || 1;
  return { x: cx + px, y: cy + py, nx, ny };
}

/** 三次贝塞尔上的点（避让采样用） */
function cubicAt(s: Point, c1: Point, c2: Point, t: Point, u: number): Point {
  const m = 1 - u;
  return {
    x: m * m * m * s.x + 3 * m * m * u * c1.x + 3 * m * u * u * c2.x + u * u * u * t.x,
    y: m * m * m * s.y + 3 * m * m * u * c1.y + 3 * m * u * u * c2.y + u * u * u * t.y,
  };
}

/**
 * 浮卡牵线（设计稿 v9.4）：端点沿各自外法向先外伸一截，再弯向对方 → 斜向
 * 连接自然是 S 弯；若整条曲线压到别的卡，则沿连线法向整体平移（端点不动），
 * 偏移量从小到大试，够用就停。
 *
 * 返回 path 的 d（调用方画 1.2px 实线，颜色取实体类型色、opacity .42）。
 */
export function freeLinkPath(
  card: Box,
  host: Box,
  obstacles: readonly Box[],
  cardRadius = 999,
  hostRadius = 12,
): string {
  const s = roundEdge(card, { x: centerX(host), y: centerY(host) }, cardRadius);
  const t = roundEdge(host, { x: centerX(card), y: centerY(card) }, hostRadius);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const qx = -dy / len;
  const qy = dx / len;
  const ext = Math.max(26, Math.min(len * 0.55, 96));

  const controls = (lat: number): [Point, Point] => [
    { x: s.x + s.nx * ext + qx * lat, y: s.y + s.ny * ext + qy * lat },
    { x: t.x + t.nx * ext + qx * lat, y: t.y + t.ny * ext + qy * lat },
  ];
  const blocked = (c1: Point, c2: Point): number => {
    let hits = 0;
    for (let i = 1; i < 20; i += 1) {
      const p = cubicAt(s, c1, c2, t, i / 20);
      if (rectsHit(obstacles, p.x - 3, p.x + 3, p.y - 3, p.y + 3).length > 0) hits += 1;
    }
    return hits;
  };

  let best = Infinity;
  let c1: Point = controls(0)[0];
  let c2: Point = controls(0)[1];
  for (const lat of [0, 18, -18, 36, -36, 56, -56, 80, -80]) {
    const [a, b] = controls(lat);
    const hits = blocked(a, b);
    if (hits < best) {
      best = hits;
      c1 = a;
      c2 = b;
    }
    if (hits === 0) break;
  }
  return `M${s.x} ${s.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${t.x} ${t.y}`;
}

export type ChainLink = {
  d: string;
  /** 起点（用于断口定位：取路径两端中点） */
  start: Point;
  /** 箭头尖端（正好落在目标卡边） */
  end: Point;
  /** 末端切线单位方向 */
  tan: Point;
  /** 同格短直线（箭头用 8px 小头） */
  short: boolean;
};

/**
 * 推进链一段（设计稿 chainArrow）：相邻两卡之间。
 * - 同格堆叠：短直线（全尺寸贝塞尔在几十像素间距里会鼓出夸张 S 弯）；
 * - 跨格但横向错位大、竖向间距窄：圆角直角肘；
 * - 中间没有别的卡：单条贝塞尔；
 * - 有卡挡路：按上下 / 左右挑挡路更少的一侧，经中点分两段弧绕行。
 */
export function chainLinkPath(
  a: Box,
  b: Box,
  dir: "h" | "v",
  obstacles: readonly Box[],
  sameCell = false,
): ChainLink {
  const isH = dir === "h";
  if (sameCell) {
    const s = isH ? { x: centerX(a), y: a.bottom } : { x: a.right, y: centerY(a) };
    const t = isH ? { x: centerX(b), y: b.top } : { x: b.left, y: centerY(b) };
    return {
      d: `M${s.x} ${s.y} L${t.x} ${t.y}`,
      start: s,
      end: t,
      tan: isH ? { x: 0, y: 1 } : { x: 1, y: 0 },
      short: true,
    };
  }

  const right = centerX(b) >= centerX(a);
  const down = centerY(b) >= centerY(a);
  const s = isH
    ? { x: right ? a.right : a.left, y: centerY(a) }
    : { x: centerX(a), y: down ? a.bottom : a.top };
  const t = isH
    ? { x: right ? b.left : b.right, y: centerY(b) }
    : { x: centerX(b), y: down ? b.top : b.bottom };
  const ax = isH ? (t.x >= s.x ? 1 : -1) : 0;
  const ay = isH ? 0 : t.y >= s.y ? 1 : -1;
  const span = Math.max(Math.abs(t.x - s.x), Math.abs(t.y - s.y));
  const ext = Math.max(28, Math.min(span * 0.55, 130));
  const px = ax * ext;
  const py = ay * ext;

  const PAD = 14;
  const cLeft = Math.min(s.x, t.x) - (isH ? 0 : PAD);
  const cRight = Math.max(s.x, t.x) + (isH ? 0 : PAD);
  const cTop = Math.min(s.y, t.y) - (isH ? PAD : 0);
  const cBottom = Math.max(s.y, t.y) + (isH ? PAD : 0);
  const hits = rectsHit(obstacles, cLeft, cRight, cTop, cBottom);

  const vdx = t.x - s.x;
  const vdy = t.y - s.y;
  const tan: Point = { x: ax, y: ay };

  if (!isH && Math.abs(vdx) > 24 && Math.abs(vdy) < 64) {
    // 纵向：错位大、间距窄 → 圆角直角肘
    const dirY = down ? 1 : -1;
    const dirX = Math.sign(vdx) || 1;
    const sy = down ? a.bottom : a.top;
    const ty = down ? b.top : b.bottom;
    const sx = Math.max(a.left + 6, Math.min(centerX(b), a.right - 6));
    const midY = (sy + ty) / 2;
    const r = Math.max(2, Math.min(6, Math.abs(vdx) / 3, Math.abs(ty - sy) / 4));
    return {
      d:
        `M${sx} ${sy}` +
        ` L${sx} ${midY - dirY * r}` +
        ` Q${sx} ${midY} ${sx + dirX * r} ${midY}` +
        ` L${t.x - dirX * r} ${midY}` +
        ` Q${t.x} ${midY} ${t.x} ${midY + dirY * r}` +
        ` L${t.x} ${ty}`,
      start: { x: sx, y: sy },
      end: { x: t.x, y: ty },
      tan: { x: 0, y: dirY },
      short: false,
    };
  }

  if (isH && Math.abs(vdy) > 24 && Math.abs(vdx) < 64) {
    // 横向：竖向错位大、水平间距窄 → 圆角直角肘
    const dirX = right ? 1 : -1;
    const dirY = Math.sign(vdy) || 1;
    const sx = right ? a.right : a.left;
    const tx = right ? b.left : b.right;
    const sy = Math.max(a.top + 6, Math.min(centerY(b), a.bottom - 6));
    const midX = (sx + tx) / 2;
    const r = Math.max(2, Math.min(6, Math.abs(vdy) / 3, Math.abs(tx - sx) / 4));
    return {
      d:
        `M${sx} ${sy}` +
        ` L${midX - dirX * r} ${sy}` +
        ` Q${midX} ${sy} ${midX} ${sy + dirY * r}` +
        ` L${midX} ${t.y - dirY * r}` +
        ` Q${midX} ${t.y} ${midX + dirX * r} ${t.y}` +
        ` L${tx} ${t.y}`,
      start: { x: sx, y: sy },
      end: { x: tx, y: t.y },
      tan: { x: dirX, y: 0 },
      short: false,
    };
  }

  if (hits.length === 0) {
    return {
      d: `M${s.x} ${s.y} C ${s.x + px} ${s.y}, ${t.x - px} ${t.y}, ${t.x} ${t.y}`,
      start: s,
      end: t,
      tan,
      short: false,
    };
  }

  // 绕行：经中点分两段弧，横向挑上/下、纵向挑左/右
  let mx: number;
  let my: number;
  if (isH) {
    const yUp = Math.min(a.top, b.top) - 30;
    const yDown = Math.max(a.bottom, b.bottom) + 30;
    my =
      rectsHit(obstacles, cLeft, cRight, yUp - 16, yUp + 16).length <=
      rectsHit(obstacles, cLeft, cRight, yDown - 16, yDown + 16).length
        ? yUp
        : yDown;
    mx = (s.x + t.x) / 2;
  } else {
    const xLeft = Math.min(a.left, b.left) - 30;
    const xRight = Math.max(a.right, b.right) + 30;
    mx =
      rectsHit(obstacles, xLeft - 16, xLeft + 16, cTop, cBottom).length <=
      rectsHit(obstacles, xRight - 16, xRight + 16, cTop, cBottom).length
        ? xLeft
        : xRight;
    my = (s.y + t.y) / 2;
  }

  const d = isH
    ? `M${s.x} ${s.y}` +
      ` C ${s.x + px * 0.6} ${s.y}, ${mx - px * 0.7} ${my}, ${mx} ${my}` +
      ` C ${mx + px * 0.7} ${my}, ${t.x - px * 0.6} ${t.y}, ${t.x} ${t.y}`
    : `M${s.x} ${s.y}` +
      ` C ${s.x} ${s.y + py * 0.6}, ${mx} ${my - py * 0.7}, ${mx} ${my}` +
      ` C ${mx} ${my + py * 0.7}, ${t.x} ${t.y - py * 0.6}, ${t.x} ${t.y}`;
  return { d, start: s, end: t, tan, short: false };
}
