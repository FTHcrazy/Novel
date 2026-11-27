/**
 * 大纲工作台纯函数层（outline-plan-spec v7.1 §17 B3）
 *
 * 布局与算法的全部「真相」都在这里：链派生、一键整理、时代带自适应、
 * 拖拽命中走廊、chip 折叠、搜索匹配。约束：
 * - 无 IO、无 IPC、无 DOM —— 全部可单测（vitest 直接跑）
 * - 顺序只读 (laneId, slot, sort)，禁止任何坐标语义（§6 守卫 2）
 * - 渲染组件只消费这里的输出，不自带第二套几何
 */

/** 链内事件的纯位置视图（渲染层数据按 id 归并补充其余字段） */
export interface ChainEvent {
  id: string;
  laneId: string | null;
  slot: number;
  sort: number;
  /** 与前一个事件的推进箭头断开（链首该字段无意义，渲染忽略） */
  breakBefore: boolean;
}

/** 顺序真相：(slot 升序, sort 升序) 的稳定排序（同输入同输出，不依赖数组序） */
export function compareChain(a: ChainEvent, b: ChainEvent): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.sort !== b.sort) return a.sort - b.sort;
  return 0;
}

/** 某泳道的链（不含待归类）；链内按 (slot, sort) 排序 */
export function chainOf(events: readonly ChainEvent[], laneId: string): ChainEvent[] {
  return events
    .filter((event) => event.laneId === laneId)
    .sort(compareChain);
}

/** 待归类事件（laneId = null）：托盘队列，保持数组序 */
export function looseEvents(events: readonly ChainEvent[]): ChainEvent[] {
  return events.filter((event) => event.laneId === null);
}

/**
 * 链内序号：从最近一个「断点」之后重新计数（FR-12）。
 * 链首事件 breakBefore 无意义、忽略；同槽堆叠卡共用槽号、按 sort 编次序。
 */
export function chainNumbers(chain: readonly ChainEvent[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let index = 0;
  chain.forEach((event, position) => {
    if (position > 0 && event.breakBefore) index = 0;
    numbers.set(event.id, index + 1);
    index += 1;
  });
  return numbers;
}
