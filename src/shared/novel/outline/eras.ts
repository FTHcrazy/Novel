/**
 * 时代带（era）自适应算法（outline-plan-spec v7.1 §8.5，FR-15/15a/15b）
 *
 * 三件套（v8.0 定案，全部槽位变更路径都必须跑——守卫 7/8）：
 * 1. **normalizeEras**：成员归属（区间内=成员、覆盖外就近并入）→
 *    有成员段范围=成员 bbox、空段保留手动范围（拉伸空段=划领地）
 * 2. **resolveEraOverlaps**：邻段让位——被编辑段新范围生效后，相邻段保跨度
 *    整体平移（后续段右移、前面段左移），重叠级联传播，越出 0 贴边
 * 3. **compactEras**：空洞收拢——按左右序逐段平移到紧贴前一段（首段锚定
 *    原位置、只消空洞不改跨度与次序）；**手动路径也收拢**（v8.0：不留空档）
 *
 * 占位段（UI 态、未落库）由渲染层播种，参与同一套几何、不可删除。
 */
import type { ChainEvent } from "./chain";

export interface EraRange {
  id: string;
  name: string;
  fromSlot: number;
  toSlot: number;
}

/** 就近并入的距离（事件中心到区间边缘的槽距）；无段可并入时不动 */
function nearestEraIndex(eras: readonly EraRange[], slot: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  eras.forEach((era, index) => {
    const distance =
      slot < era.fromSlot ? era.fromSlot - slot : slot > era.toSlot ? slot - era.toSlot : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * ① 全量自适应：成员归属 → bbox 重算 → 邻段让位 → 空洞收拢。
 * 输入不动，返回新区间数组（顺序保持输入序）；无变化时返回的区间与输入相等。
 */
export function normalizeEras(
  eras: readonly EraRange[],
  events: readonly ChainEvent[],
): EraRange[] {
  if (eras.length === 0) return [...eras];
  // 成员归属：区间内 = 成员；覆盖外事件就近并入（含全部段都没覆盖的事件）
  const members: number[][] = eras.map(() => []);
  const covered = (slot: number): boolean =>
    eras.some((era) => slot >= era.fromSlot && slot <= era.toSlot);
  for (const event of events) {
    if (event.laneId === null) continue; // 待归类不参与时代带成员统计（§三）
    const inside = eras.findIndex(
      (era) => event.slot >= era.fromSlot && event.slot <= era.toSlot,
    );
    if (inside >= 0) {
      members[inside].push(event.slot);
      continue;
    }
    if (covered(event.slot)) continue;
    const nearest = nearestEraIndex(eras, event.slot);
    if (nearest >= 0) members[nearest].push(event.slot);
  }

  // bbox 重算：有成员段 = 成员 bbox；空段保留手动范围（作者领地，RK-32）
  const working = eras.map((era, index) => {
    const slots = members[index];
    if (slots.length === 0) return { ...era };
    return {
      ...era,
      fromSlot: Math.min(...slots),
      toSlot: Math.max(...slots),
    };
  });

  // 邻段让位：按起始槽号升序逐段落位——与前一段重叠的段保跨度右移
  // （与 resolveEraOverlaps 同一语义的顺序打包形态；bbox 计算保证彼此重叠
  // 只可能来自成员并入，不会出现前段起点反而更大的乱序）
  const ordered = [...working].sort((a, b) => a.fromSlot - b.fromSlot);
  const packed: EraRange[] = [];
  for (const era of ordered) {
    const last = packed[packed.length - 1];
    if (last && era.fromSlot <= last.toSlot) {
      const span = era.toSlot - era.fromSlot;
      const from = last.toSlot + 1;
      packed.push({ ...era, fromSlot: from, toSlot: from + span });
    } else {
      packed.push({ ...era });
    }
  }

  // 空洞收拢：手动路径也收拢（v8.0）
  return compactEras(packed);
}

/**
 * ② 邻段让位：把 id 对应段设为新范围，其余段保跨度平移让位。
 *
 * 规则（v7.8/v7.9）：按起始槽号升序处理——被编辑段右侧的段若与新范围重叠，
 * 平移到 edited.to+1 起步（保跨度）；左侧的段若被压，平移到 edited.from 落
 * 在它们右侧（保跨度）。平移越出 0 时贴边 clamp 并在 clamped 里报告
 * （UI toast「已顶到最左格」）。
 */
export function resolveEraOverlaps(
  eras: readonly EraRange[],
  id: string,
  fromSlot: number,
  toSlot: number,
): { eras: EraRange[]; clamped: boolean } {
  const target = eras.find((era) => era.id === id);
  if (!target) return { eras: [...eras], clamped: false };
  let edited: EraRange = { ...target, fromSlot, toSlot };
  let clamped = false;
  if (edited.fromSlot < 0) {
    edited = { ...edited, fromSlot: 0, toSlot: Math.max(0, edited.toSlot) };
    clamped = true;
  }

  const others = eras.filter((era) => era.id !== id);

  // 右侧段：起点 ≥ edited 原起点者向右让位（保跨度、级联传播）
  const right = others
    .filter((era) => era.fromSlot >= target.fromSlot)
    .sort((a, b) => a.fromSlot - b.fromSlot);
  const left = others
    .filter((era) => era.fromSlot < target.fromSlot)
    .sort((a, b) => b.fromSlot - a.fromSlot);

  const result = new Map<string, EraRange>();
  let cursor = edited.toSlot + 1;
  for (const era of right) {
    const eraSpan = era.toSlot - era.fromSlot;
    const from = Math.max(era.fromSlot, cursor);
    if (from !== era.fromSlot) {
      result.set(era.id, { ...era, fromSlot: from, toSlot: from + eraSpan });
      cursor = from + eraSpan + 1;
    } else {
      cursor = era.toSlot + 1;
    }
  }

  // 左侧段：被 edited 压到时向左让位（保跨度），越出 0 贴边 clamp
  let leftEdge = edited.fromSlot - 1;
  for (const era of left) {
    const eraSpan = era.toSlot - era.fromSlot;
    if (era.toSlot >= edited.fromSlot) {
      let from = leftEdge - eraSpan;
      if (from < 0) {
        from = 0;
        clamped = true;
      }
      result.set(era.id, { ...era, fromSlot: from, toSlot: from + eraSpan });
      leftEdge = from - 1;
    }
  }

  return {
    eras: eras.map((era) => result.get(era.id) ?? (era.id === id ? edited : era)),
    clamped,
  };
}

/**
 * ③ 空洞收拢：按起始槽号升序，逐段平移到紧贴前一段（首段锚定原位置）。
 * 只消空洞，不改各段跨度与先后次序（v7.9）。
 */
export function compactEras(eras: readonly EraRange[]): EraRange[] {
  const ordered = [...eras].sort((a, b) => a.fromSlot - b.fromSlot);
  const byId = new Map<string, EraRange>();
  let anchor: number | null = null;
  for (const era of ordered) {
    const span = era.toSlot - era.fromSlot;
    if (anchor === null) {
      // 首段锚定原位置（其前的空档是画布头留白，不是段间空洞）
      anchor = era.toSlot;
      byId.set(era.id, { ...era });
      continue;
    }
    // 紧贴前一段：from = anchor + 1（更靠左不可能——升序 + resolve 防重叠）
    // 显式标注断开推断环：anchor 的收窄类型经由 nextFrom → targetFrom 回到自身
    const targetFrom: number = anchor + 1;
    const nextFrom: number = era.fromSlot > targetFrom ? targetFrom : era.fromSlot;
    byId.set(era.id, { ...era, fromSlot: nextFrom, toSlot: nextFrom + span });
    anchor = nextFrom + span;
  }
  return eras.map((era) => byId.get(era.id) ?? era);
}

/** 区间内事件计数（「N 事件」小字；待归类不计入） */
export function countEraMembers(era: EraRange, events: readonly ChainEvent[]): number {
  return events.filter(
    (event) => event.laneId !== null && event.slot >= era.fromSlot && event.slot <= era.toSlot,
  ).length;
}

/**
 * ④ 手动改某段的跨度（「改长度」）：编辑段新范围生效 → 邻段保跨度让位 →
 * 段间空洞收拢；**段动，段内的卡跟着动**（只挪框不挪卡，画布上就会出现
 * 「框在左、卡在右」；这正是整理规则要消灭的那类错位）。
 *
 * 两条约束：
 * 1. 作者设的长度不能把本段的事件甩到框外——下界取成员 bbox（expanded 报告给 UI）；
 * 2. 被让位 / 收拢的段按自己的位移平移成员事件与落在段内的区域框。
 */
export function resizeEra(
  eras: readonly EraRange[],
  events: readonly ChainEvent[],
  zones: readonly { id: string; fromSlot: number; toSlot: number }[],
  id: string,
  fromSlot: number,
  toSlot: number,
): {
  eras: EraRange[];
  moves: Map<string, number>;
  zoneShifts: Map<string, { fromSlot: number; toSlot: number }>;
  clamped: boolean;
  expanded: boolean;
} {
  const target = eras.find((era) => era.id === id);
  const empty = {
    eras: [...eras],
    moves: new Map<string, number>(),
    zoneShifts: new Map<string, { fromSlot: number; toSlot: number }>(),
    clamped: false,
    expanded: false,
  };
  if (!target) return empty;

  // 归属按「改动前」的区间记：段被推动时，卡知道自己原来跟着哪一段
  const eraOf = new Map<string, string>();
  for (const event of events) {
    if (event.laneId === null) continue;
    const host = eras.find(
      (era) => event.slot >= era.fromSlot && event.slot <= era.toSlot,
    );
    if (host) eraOf.set(event.id, host.id);
  }

  const memberSlots = events
    .filter((event) => eraOf.get(event.id) === id)
    .map((event) => event.slot);
  let from = fromSlot;
  let to = toSlot;
  let expanded = false;
  if (memberSlots.length > 0) {
    const min = Math.min(...memberSlots);
    const max = Math.max(...memberSlots);
    if (from > min || to < max) expanded = true;
    from = Math.min(from, min);
    to = Math.max(to, max);
  }

  const resolved = resolveEraOverlaps(eras, id, from, to);

  // 贴紧（空洞收拢）：逐段落位，记下每段的位移
  const ordered = [...resolved.eras].sort((a, b) => a.fromSlot - b.fromSlot);
  const placed = new Map<string, EraRange>();
  let anchor: number | null = null;
  for (const era of ordered) {
    const span = era.toSlot - era.fromSlot;
    const nextFrom: number = anchor === null ? era.fromSlot : anchor + 1;
    placed.set(era.id, { ...era, fromSlot: nextFrom, toSlot: nextFrom + span });
    anchor = nextFrom + span;
  }

  const moves = new Map<string, number>();
  for (const event of events) {
    const hostId = eraOf.get(event.id);
    if (!hostId) continue;
    const before = eras.find((era) => era.id === hostId);
    const after = placed.get(hostId);
    if (!before || !after) continue;
    const shift = after.fromSlot - before.fromSlot;
    if (shift !== 0) moves.set(event.id, event.slot + shift);
  }

  // 区域框：跟着它起点所在的段一起走
  const zoneShifts = new Map<string, { fromSlot: number; toSlot: number }>();
  for (const zone of zones) {
    const host = eras.find(
      (era) => zone.fromSlot >= era.fromSlot && zone.fromSlot <= era.toSlot,
    );
    if (!host) continue;
    const after = placed.get(host.id);
    if (!after) continue;
    const shift = after.fromSlot - host.fromSlot;
    if (shift !== 0) {
      zoneShifts.set(zone.id, {
        fromSlot: zone.fromSlot + shift,
        toSlot: zone.toSlot + shift,
      });
    }
  }

  return {
    eras: eras.map((era) => placed.get(era.id) ?? era),
    moves,
    zoneShifts,
    clamped: resolved.clamped,
    expanded,
  };
}
