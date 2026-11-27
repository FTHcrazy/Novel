/**
 * 一键整理 = 时间线压缩（outline-plan-spec v7.1 §8.10，FR-24）
 *
 * 语义（v9.7 修订）：每条泳道的链上事件（**含同槽堆叠**）按链序展开成连续槽——
 * 每卡一格、堆叠拆散、不改链上先后次序（slot 映射单调不减）、不删任何出场。
 * 堆叠是临时草稿态，展开是定稿态。
 *
 * **时代段是压缩的硬边界**（用户反馈）：一段事件的压缩空间到它所属时代段为止，
 * 绝不跨段回缩。两张卡分属两个时代段、中间又有空档时，后段的事件留在自己段里，
 * 由前段收窄（成员 bbox）消掉空档那一端——而不是把后段事件拽进前段。
 * 段收窄后若与前段之间出现空洞，各段按左右序贴紧，**段内事件跟着段一起平移**
 * （否则带走位、段不动，画布上出现「框在左、卡在右」的错位）。
 *
 * zone/era 区间随成员重映射（§8.4）：移动前按旧区间记成员 id，移动后按成员
 * 新槽号 min/max 写回——整理前后框住的永远是同一组事件；空区间不动
 * （作者还没框东西，没有「跟着走」的语义）。
 *
 * 幂等：链已连续、无堆叠、各段已贴紧时，第二次整理零移动（moves 为空 Map）。
 */
import type { ChainEvent } from "./chain";
import { chainOf, compareChain } from "./chain";
import type { EraRange } from "./eras";

/** 时代带区间类型与 eras.ts 同源（id/name/from/to），避免第二套几何 */
export type { EraRange };

/** 区域：一条泳道内的槽号区间（渲染层完整 DTO 的位置子集） */
export interface ZoneRange {
  id: string;
  laneId: string;
  fromSlot: number;
  toSlot: number;
}

export interface TidyResult {
  /** eventId → 新槽号（只有发生移动的事件才会出现在 Map 里） */
  moves: Map<string, number>;
  /** zoneId → [fromSlot, toSlot]（只有区间真的变了才出现） */
  zoneRemaps: Map<string, { fromSlot: number; toSlot: number }>;
  /** eraId → [fromSlot, toSlot]（同上） */
  eraRemaps: Map<string, { fromSlot: number; toSlot: number }>;
}

/** 整理前记录成员：zone 按旧区间 + 同线取成员（era 的成员由归属表直接算） */
function zoneMembersOf(
  events: readonly ChainEvent[],
  zones: readonly ZoneRange[],
): Map<string, Set<string>> {
  const zoneMembers = new Map<string, Set<string>>();
  for (const zone of zones) {
    const members = new Set<string>();
    for (const event of events) {
      if (event.laneId === zone.laneId && event.slot >= zone.fromSlot && event.slot <= zone.toSlot) {
        members.add(event.id);
      }
    }
    zoneMembers.set(zone.id, members);
  }
  return zoneMembers;
}

/** 成员新槽号的 bbox 写回；没有成员的区间保持原值不动 */
function remapRange(
  memberSlots: number[],
  original: { fromSlot: number; toSlot: number },
): { fromSlot: number; toSlot: number } {
  if (memberSlots.length === 0) return original;
  return { fromSlot: Math.min(...memberSlots), toSlot: Math.max(...memberSlots) };
}

/**
 * 事件 → 时代段序号（与 normalizeEras 同一归属规则：区间内属于该段，
 * 覆盖外就近并入——否则段会为了「收留」它而拉伸，压缩时又对不上号）。
 */
function eraIndexOf(eras: readonly EraRange[], slot: number): number {
  if (eras.length === 0) return -1;
  const inside = eras.findIndex((era) => slot >= era.fromSlot && slot <= era.toSlot);
  if (inside >= 0) return inside;
  let best = 0;
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
 * 一键整理（时间线压缩）。纯函数：输入整盘事件 + 区间，输出「要写什么」，
 * 不直接改输入（调用方把 moves 应用到自己的状态机再落库）。
 */
export function tidyTimeline(
  events: readonly ChainEvent[],
  laneIds: readonly string[],
  zones: readonly ZoneRange[],
  eras: readonly EraRange[],
): TidyResult {
  const zoneMembers = zoneMembersOf(events, zones);

  const slotOf = new Map<string, number>();
  /** 事件 → 所属时代段（-1 = 不在任何段：没有时代段，或待归类事件） */
  const eraOf = new Map<string, number>();
  for (const event of events) {
    slotOf.set(event.id, event.slot);
    if (event.laneId !== null) eraOf.set(event.id, eraIndexOf(eras, event.slot));
  }

  // ① 逐链、逐段压缩：同一段内按链序展开成连续槽，段与段之间不互相借位
  const moves = new Map<string, number>();
  for (const laneId of laneIds) {
    const chain = chainOf(events, laneId);
    if (chain.length === 0) continue;
    let blockEra: number | null = null;
    let base = 0;
    let offset = 0;
    /** 上一段的结束槽：新段起点不得回退（否则链序被打乱） */
    let ceiling: number | null = null;
    chain.forEach((event) => {
      const era = eraOf.get(event.id) ?? -1;
      if (era !== blockEra) {
        blockEra = era;
        base = ceiling === null ? event.slot : Math.max(event.slot, ceiling + 1);
        offset = 0;
      }
      const target = base + offset;
      offset += 1;
      ceiling = target;
      if (target !== event.slot) moves.set(event.id, target);
      slotOf.set(event.id, target);
    });
  }

  // ② 每段按成员 bbox 收窄（空段保留手动范围：作者还没框东西）
  const members: number[][] = eras.map(() => []);
  for (const [eventId, eraIdx] of eraOf) {
    if (eraIdx < 0) continue;
    const slot = slotOf.get(eventId);
    if (slot !== undefined) members[eraIdx].push(slot);
  }
  const narrowed = eras.map((era, index) =>
    members[index].length === 0
      ? { fromSlot: era.fromSlot, toSlot: era.toSlot }
      : { fromSlot: Math.min(...members[index]), toSlot: Math.max(...members[index]) },
  );

  // ③ 段按左右序贴紧（消掉段间空洞），段内事件跟着一起平移
  const order = narrowed
    .map((range, index) => ({ index, ...range }))
    .sort((a, b) => a.fromSlot - b.fromSlot);
  const delta = new Map<number, number>();
  let anchor: number | null = null;
  for (const item of order) {
    const span = item.toSlot - item.fromSlot;
    if (anchor === null) {
      delta.set(item.index, 0);
      anchor = item.toSlot;
      continue;
    }
    const from = Math.max(0, anchor + 1);
    delta.set(item.index, from - item.fromSlot);
    anchor = from + span;
  }
  for (const [eventId, eraIdx] of eraOf) {
    const shift = delta.get(eraIdx) ?? 0;
    if (shift === 0) continue;
    const slot = (slotOf.get(eventId) ?? 0) + shift;
    slotOf.set(eventId, slot);
    moves.set(eventId, slot);
  }

  // ④ zone 区间按成员新槽号重映射（自动伸展 / 收缩）
  const zoneRemaps = new Map<string, { fromSlot: number; toSlot: number }>();
  for (const zone of zones) {
    const slots = [...(zoneMembers.get(zone.id) ?? [])]
      .map((id) => slotOf.get(id) ?? -1)
      .filter((slot) => slot >= 0);
    const next = remapRange(slots, { fromSlot: zone.fromSlot, toSlot: zone.toSlot });
    if (next.fromSlot !== zone.fromSlot || next.toSlot !== zone.toSlot) {
      zoneRemaps.set(zone.id, next);
    }
  }

  // ⑤ era 区间：收窄 + 贴紧后的终值（与渲染层 compactedEras 同源，写回后不再漂）
  const eraRemaps = new Map<string, { fromSlot: number; toSlot: number }>();
  eras.forEach((era, index) => {
    const shift = delta.get(index) ?? 0;
    const next = {
      fromSlot: narrowed[index].fromSlot + shift,
      toSlot: narrowed[index].toSlot + shift,
    };
    if (next.fromSlot !== era.fromSlot || next.toSlot !== era.toSlot) {
      eraRemaps.set(era.id, next);
    }
  });

  return { moves, zoneRemaps, eraRemaps };
}

/**
 * 幂等判定：moves 为空即「链已连续、无堆叠可拆」——第二次整理零写入
 * （§17 守卫 9 的判定来源）。
 */
export function tidyIsNoop(result: TidyResult): boolean {
  return result.moves.size === 0;
}

/**
 * 链序单调不减校验（守卫 9）：展开后每个链的槽号必须严格递增 1 且顺序
 * 与原链序一致。用于单测对拍，运行时不调。
 */
export function assertChainOrderKept(
  before: readonly ChainEvent[],
  after: readonly ChainEvent[],
  laneId: string,
): boolean {
  const orderBefore = chainOf(before, laneId).map((event) => event.id);
  const orderAfter = chainOf(after, laneId).map((event) => event.id);
  if (orderBefore.join(",") !== orderAfter.join(",")) return false;
  const chain = chainOf(after, laneId);
  for (let index = 1; index < chain.length; index += 1) {
    if (chain[index].slot !== chain[index - 1].slot + 1) return false;
  }
  return true;
}

/** 应用移动后的纯视图（不改输入数组；测试与乐观更新共用） */
export function applySlotMoves(
  events: readonly ChainEvent[],
  moves: ReadonlyMap<string, number>,
): ChainEvent[] {
  return events
    .map((event) =>
      moves.has(event.id) ? { ...event, slot: moves.get(event.id) as number } : event,
    )
    .sort(compareChain);
}
