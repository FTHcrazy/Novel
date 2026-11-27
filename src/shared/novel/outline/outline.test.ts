import { describe, expect, it } from "vitest";
import {
  chainOf,
  chainNumbers,
  compareChain,
  looseEvents,
  type ChainEvent,
} from "./chain";
import {
  applySlotMoves,
  assertChainOrderKept,
  tidyIsNoop,
  tidyTimeline,
  type EraRange,
  type ZoneRange,
} from "./tidy";
import { compactEras, countEraMembers, normalizeEras, resolveEraOverlaps } from "./eras";
import {
  GUTTER,
  EV_W,
  ROW_BOTTOM,
  ROW_TOP,
  STACK_GAP,
  buildLaneBands,
  hitHorizontal,
  hitVertical,
  highlightRect,
  laneRowHeight,
  rectEdgePoint,
  stackCardTop,
  STEP,
  V_HIT_W,
} from "./hit";
import { estimateChipWidth, foldChips, matchEvent, matchLabel } from "./chips";
import { outlineSearchHits } from "./search";

const ev = (id: string, laneId: string | null, slot: number, sort = 0, breakBefore = false): ChainEvent => ({
  id,
  laneId,
  slot,
  sort,
  breakBefore,
});

describe("chain：顺序真相 = (slot, sort)", () => {
  it("compareChain 槽号主序、同槽 sort 副序", () => {
    const events = [ev("c", "a", 1), ev("a", "a", 0, 1), ev("b", "a", 0, 0)];
    expect(events.sort(compareChain).map((event) => event.id)).toEqual(["b", "a", "c"]);
  });

  it("chainOf 只含该线事件；looseEvents 只含待归类", () => {
    const events = [ev("a", "main", 0), ev("b", null, 0), ev("c", "sub", 2)];
    expect(chainOf(events, "main").map((event) => event.id)).toEqual(["a"]);
    expect(looseEvents(events).map((event) => event.id)).toEqual(["b"]);
  });

  it("chainNumbers：断点后重新计数（FR-12），链首 breakBefore 忽略", () => {
    const chain = [
      ev("a", "main", 0, 0, true), // 链首 breakBefore 无意义
      ev("b", "main", 1),
      ev("c", "main", 2, 0, true), // 断点：c 重新从 1 计
      ev("d", "main", 3),
    ];
    const numbers = chainNumbers(chain);
    expect([...numbers.values()]).toEqual([1, 2, 1, 2]);
  });
});

describe("tidy：一键整理 = 时间线压缩（FR-24）", () => {
  it("堆叠展开成连续槽 + 空洞消除（TC-24）", () => {
    // 槽 {0, 2, 2堆叠, 5} → {0,1,2,3}
    const events = [
      ev("a", "main", 0),
      ev("b", "main", 2),
      ev("c", "main", 2, 1),
      ev("d", "main", 5),
    ];
    const result = tidyTimeline(events, ["main"], [], []);
    expect(result.moves.get("b")).toBe(1);
    // c 的目标槽恰好还是 2（b 顶进来把堆叠拆开但 c 槽号不变）→ 零移动
    expect(result.moves.has("c")).toBe(false);
    expect(result.moves.get("d")).toBe(3);
    expect(result.moves.has("a")).toBe(false); // base 卡不动
  });

  it("zone 区间随成员重映射（TC-14：[2,3] 框住 b,c → 整理后 [1,2]）", () => {
    const events = [
      ev("a", "main", 0),
      ev("b", "main", 2),
      ev("c", "main", 3),
      ev("d", "main", 5),
    ];
    const zones: ZoneRange[] = [{ id: "z1", laneId: "main", fromSlot: 2, toSlot: 3 }];
    const result = tidyTimeline(events, ["main"], zones, []);
    expect(result.zoneRemaps.get("z1")).toEqual({ fromSlot: 1, toSlot: 2 });
  });

  it("era 区间随成员重映射；空区间保跨度（只跟着贴紧，不被成员吃掉）", () => {
    const events = [ev("a", "main", 0), ev("loose", null, 9)];
    const eras: EraRange[] = [
      { id: "e1", name: "", fromSlot: 0, toSlot: 1 }, // 有成员 a（0）→ 收窄到单格
      { id: "e2", name: "", fromSlot: 6, toSlot: 7 }, // 空段：2 格跨度原样保留
    ];
    const result = tidyTimeline(events, ["main"], [], eras);
    expect(result.eraRemaps.get("e1")).toEqual({ fromSlot: 0, toSlot: 0 });
    // 空段没有成员可收窄，跨度仍是 2 格，只是贴到前段后面
    expect(result.eraRemaps.get("e2")).toEqual({ fromSlot: 1, toSlot: 2 });
  });

  it("跨段有空洞：后段事件不回缩进前段，前段收窄、两段贴紧后事件随段平移", () => {
    // 主线段两段之间空着 1-4 格：a 在段一（0），b 在段二（5）
    const events = [ev("a", "main", 0), ev("b", "main", 5)];
    const eras: EraRange[] = [
      { id: "e1", name: "", fromSlot: 0, toSlot: 2 },
      { id: "e2", name: "", fromSlot: 5, toSlot: 6 },
    ];
    const result = tidyTimeline(events, ["main"], [], eras);
    // 段一收窄成 0-0（消掉空格端），段二按成员收窄成 1-1，b 跟着段二落在 1
    expect(result.eraRemaps.get("e1")).toEqual({ fromSlot: 0, toSlot: 0 });
    expect(result.eraRemaps.get("e2")).toEqual({ fromSlot: 1, toSlot: 1 });
    expect(result.moves.get("b")).toBe(1);
    // b 仍属于段二（1-1），没有被并进段一（0-0）
    expect(result.moves.has("a")).toBe(false);
  });

  it("同段内仍有堆叠时正常展开（分块不碍压缩）", () => {
    const events = [ev("a", "main", 0), ev("b", "main", 0, 1), ev("c", "main", 2)];
    const eras: EraRange[] = [{ id: "e1", name: "", fromSlot: 0, toSlot: 2 }];
    const result = tidyTimeline(events, ["main"], [], eras);
    expect(result.moves.get("b")).toBe(1);
    expect(result.moves.has("c")).toBe(false); // c 的目标槽恰好还是 2
  });

  it("幂等：链已连续、无堆叠 → 第二次零移动", () => {
    const events = [ev("a", "main", 0), ev("b", "main", 1), ev("c", "main", 2)];
    const first = tidyTimeline(events, ["main"], [], []);
    expect(tidyIsNoop(first)).toBe(true);
  });

  it("不改链序（slot 映射单调不减，守卫 9）", () => {
    const events = [
      ev("c", "main", 4),
      ev("a", "main", 0),
      ev("b", "main", 2, 1),
      ev("b2", "main", 2, 0),
    ];
    const result = tidyTimeline(events, ["main"], [], []);
    const after = applySlotMoves(events, result.moves);
    expect(assertChainOrderKept(events, after, "main")).toBe(true);
  });

  it("待归类事件不动（整理只压各泳道链）", () => {
    const events = [ev("loose", null, 9), ev("a", "main", 5), ev("b", "main", 5, 1)];
    const result = tidyTimeline(events, ["main"], [], []);
    expect(result.moves.has("loose")).toBe(false);
    // base = 5：a 不动，堆叠的 b 展开到 6
    expect(result.moves.get("b")).toBe(6);
  });
});

describe("eras：时代带自适应（FR-15）", () => {
  it("resolveEraOverlaps：被编辑段伸展压到邻段 → 邻段保跨度右移让位", () => {
    const eras: EraRange[] = [
      { id: "e1", name: "一", fromSlot: 0, toSlot: 1 },
      { id: "e2", name: "二", fromSlot: 2, toSlot: 3 },
    ];
    // e1 拉到 [0,2] → e2 让位到 [3,4]
    const result = resolveEraOverlaps(eras, "e1", 0, 2);
    const e2 = result.eras.find((era) => era.id === "e2");
    expect(e2?.fromSlot).toBe(3);
    expect(e2?.toSlot).toBe(4);
    expect(result.clamped).toBe(false);
  });

  it("resolveEraOverlaps：左侧段被压 → 左移让位；越出 0 贴边 clamp 报告", () => {
    const eras: EraRange[] = [
      { id: "e1", name: "一", fromSlot: 0, toSlot: 1 },
      { id: "e2", name: "二", fromSlot: 2, toSlot: 3 },
      { id: "e3", name: "三", fromSlot: 4, toSlot: 5 },
    ];
    // e3 拉到 [1,1] → e2 左移让位（[-1,0]→clamp[0,1]），e1 被顶
    const result = resolveEraOverlaps(eras, "e3", 1, 1);
    expect(result.clamped).toBe(true);
    const e2 = result.eras.find((era) => era.id === "e2");
    expect(e2?.fromSlot).toBe(0);
  });

  it("compactEras：空洞收拢，首段锚定、跨度与次序不变（TC-15）", () => {
    const eras: EraRange[] = [
      { id: "e1", name: "一", fromSlot: 0, toSlot: 1 },
      { id: "e2", name: "二", fromSlot: 5, toSlot: 6 },
      { id: "e3", name: "三", fromSlot: 9, toSlot: 11 },
    ];
    const result = compactEras(eras);
    expect(result.find((era) => era.id === "e1")).toMatchObject({ fromSlot: 0, toSlot: 1 });
    expect(result.find((era) => era.id === "e2")).toMatchObject({ fromSlot: 2, toSlot: 3 });
    expect(result.find((era) => era.id === "e3")).toMatchObject({ fromSlot: 4, toSlot: 6 });
  });

  it("normalizeEras：成员 bbox 自适应 + 覆盖外事件就近并入 + 让位 + 收拢", () => {
    const eras: EraRange[] = [
      { id: "e1", name: "一", fromSlot: 0, toSlot: 1 },
      { id: "e2", name: "二", fromSlot: 2, toSlot: 2 },
    ];
    const events = [
      ev("a", "main", 0),
      ev("b", "main", 1),
      ev("c", "main", 3), // e2 覆盖外 → 就近并入 e2 → e2 变 [3,3]
      ev("loose", null, 9), // 待归类不计入
    ];
    const result = normalizeEras(eras, events);
    expect(result.find((era) => era.id === "e1")).toMatchObject({ fromSlot: 0, toSlot: 1 });
    // c 就近并入 e2 → [3,3]，随后空洞收拢把 e2 拉到紧贴 e1 的槽 2
    expect(result.find((era) => era.id === "e2")).toMatchObject({ fromSlot: 2, toSlot: 2 });
    expect(countEraMembers({ id: "e1", name: "", fromSlot: 0, toSlot: 1 }, events)).toBe(2);
  });

  it("normalizeEras：空段保留手动范围（拉伸空段 = 划领地，RK-32）", () => {
    const eras: EraRange[] = [{ id: "e1", name: "空段", fromSlot: 4, toSlot: 9 }];
    const events = [ev("far", "main", 20)];
    const result = normalizeEras(eras, events);
    // far 就近并入 e1 → e1 伸展为 [4,20]（成员只有 far，bbox = min(4? no…))
    // 语义核对：空段本无成员，far 并入后 e1 有成员 → bbox = [4..20] 与手动范围合并取成员（far@20）
    expect(result.find((era) => era.id === "e1")?.toSlot).toBe(20);
  });
});

describe("hit：命中走廊与高亮同源（FR-03）", () => {
  const lanes = ["main", "sub"];

  it("纵向：走廊内命中、右侧留白不命中（防隔列过户，v7.5）", () => {
    const colW = 420 + 48;
    expect(hitVertical(50, 200, lanes, 40)).toEqual({ laneId: "main", slot: 0 });
    // y < slotsTop → 第 0 格（列头上方落格 = 插顶）
    expect(hitVertical(50, 10, lanes, 40)).toEqual({ laneId: "main", slot: 0 });
    // y = 40 + 176*2 → slot 2
    expect(hitVertical(50, 40 + 176 * 2 + 1, lanes, 40)).toEqual({ laneId: "main", slot: 2 });
    // 第二列在走廊内
    expect(hitVertical(colW + 100, 200, lanes, 40)).toEqual({ laneId: "sub", slot: 0 });
    // 第二列走廊外（> 300px）→ null
    expect(hitVertical(colW + 350, 200, lanes, 40)).toBeNull();
    // 超出泳道范围 → null
    expect(hitVertical(colW * 2 + 10, 200, lanes, 40)).toBeNull();
    expect(V_HIT_W).toBe(300);
  });

  it("横向：GUTTER 左不命中；行带外不命中；槽号按 STEP 换算", () => {
    const bands = [
      { top: 8, height: 200 },
      { top: 208, height: 260 },
    ];
    expect(hitHorizontal(50, 100, lanes, bands)).toBeNull(); // 标头列
    expect(hitHorizontal(GUTTER + 10, -50, lanes, bands)).toBeNull(); // 行带上方
    expect(hitHorizontal(GUTTER + 10, 8 + 200, lanes, bands)).toEqual({
      laneId: "sub",
      slot: 0,
    }); // 行带下边界归下一行
    expect(hitHorizontal(GUTTER + STEP * 2 + 30, 8 + 210, lanes, bands)).toEqual({
      laneId: "sub",
      slot: 2,
    });
    expect(hitHorizontal(GUTTER + 10, 208 + 260, lanes, bands)).toBeNull(); // 最后一行下方
  });

  it("横向行高随同槽堆叠深度展开（第二张卡不压第一张、卡底不戳出行框）", () => {
    const cardH = 172;
    const single = laneRowHeight(1, cardH);
    const stacked = laneRowHeight(2, cardH);
    expect(stacked - single).toBe(cardH + STACK_GAP);
    // 第二张卡的上边缘 = 第一张下边缘 + 层间距
    expect(stackCardTop(0, 1, cardH) - (stackCardTop(0, 0, cardH) + cardH)).toBe(STACK_GAP);
    // 卡底始终落在行带内
    expect(stackCardTop(0, 1, cardH) + cardH).toBeLessThanOrEqual(stacked);
    expect(stackCardTop(0, 0, cardH)).toBeGreaterThan(0);
  });

  it("行带按堆叠深度依次排开：不重叠、不留缝", () => {
    const cardH = 172;
    const bands = buildLaneBands([1, 2, 3], cardH, 56);
    expect(bands[0].top).toBe(56);
    expect(bands[0].height).toBe(laneRowHeight(1, cardH));
    expect(bands[1].top).toBe(bands[0].top + bands[0].height); // 行与行首尾相接
    expect(bands[2].top).toBe(bands[1].top + bands[1].height);
    // 每行的最后一张卡都落在行带内（含底留白）
    for (let i = 0; i < bands.length; i += 1) {
      const depth = [1, 2, 3][i];
      expect(stackCardTop(bands[i].top, depth - 1, cardH) + cardH).toBeLessThanOrEqual(
        bands[i].top + bands[i].height,
      );
    }
  });

  it("高亮矩形与命中同源（同一函数族产出几何）", () => {
    const target = hitVertical(100, 40 + 176, lanes, 40);
    expect(target).not.toBeNull();
    const band = { top: 40, height: 176 };
    const rect = highlightRect(target as NonNullable<typeof target>, "v", 0, 40, band, 176);
    expect(rect).toEqual({ x: 0, y: 40 + 176, width: 300, height: 176 });
    const bands = [
      { top: 8, height: 200 },
      { top: 208, height: 260 },
    ];
    const hTarget = hitHorizontal(GUTTER + 10, 8 + 210, lanes, bands);
    const hRect = highlightRect(
      hTarget as NonNullable<typeof hTarget>,
      "h",
      1,
      0,
      bands[1],
      260,
    );
    // 横向高亮 = 卡片列（设计稿 .cell-hl）：从卡顶起、不覆盖泳道标头
    expect(hRect).toEqual({
      x: GUTTER + (STEP - EV_W) / 2,
      y: 208 + ROW_TOP,
      width: EV_W,
      height: 260 - ROW_TOP - ROW_BOTTOM + 4,
    });
  });

  it("浮卡引线止于卡边框（不横穿卡面）", () => {
    const card = { x: 100, y: 100, w: 208, h: 172 };
    // 浮卡在卡右下：交点落在下边（y = 底边），x 沿中心→浮卡方向内收
    const edge = rectEdgePoint(card, { x: 400, y: 400 });
    expect(edge.y).toBe(272);
    expect(edge.x).toBeCloseTo(204 + 196 * (86 / 214), 1);
    expect(edge.x).toBeGreaterThan(204);
    expect(rectEdgePoint(card, { x: 400, y: 400 }, 2).y).toBeGreaterThan(272);
    // 浮卡在正下方：垂直线止于底边中点，横坐标不变
    expect(rectEdgePoint(card, { x: 204, y: 400 })).toEqual({ x: 204, y: 272 });
    // 浮卡在卡正左方：止于左边中点
    expect(rectEdgePoint(card, { x: -200, y: 186 })).toEqual({ x: 100, y: 186 });
    // 退化输入（toward = 中心）不返回 NaN
    expect(rectEdgePoint(card, { x: 204, y: 186 })).toEqual({ x: 204, y: 186 });
  });
});

describe("chips：折叠估算与搜索（FR-05/§8.9）", () => {
  it("estimateChipWidth 与名字长度线性", () => {
    expect(estimateChipWidth("沈砚")).toBeGreaterThan(estimateChipWidth("沈"));
    expect(estimateChipWidth("沈", false)).toBe(estimateChipWidth("沈") - 15);
  });

  it("foldChips 超宽折叠为「+N」；第一枚就放不下至少显示它", () => {
    const names = ["沈砚", "阿箬", "师父", "哑仆"];
    const result = foldChips(names, 120);
    expect(result.visible.length).toBeLessThan(names.length);
    expect(result.visible.length + result.hiddenCount).toBe(names.length);
    const single = foldChips(["一个特别特别特别长的名字"], 40);
    expect(single.visible).toEqual(["一个特别特别特别长的名字"]);
    expect(single.hiddenCount).toBe(0);
  });

  it("matchEvent：标题 / 正文 / 时间 / 出场名命中；空串恒真", () => {
    const event = {
      id: "e1",
      title: "碑前立誓",
      body: "他答应师父，第七个名字永远不刻。",
      whenText: "倒灌当日 拂晓",
      castNames: ["沈砚", "阿箬"],
    };
    expect(matchEvent(event, "立誓")).toBe(true);
    expect(matchEvent(event, "师父")).toBe(true);
    expect(matchEvent(event, "拂晓")).toBe(true);
    expect(matchEvent(event, "阿箬")).toBe(true);
    expect(matchEvent(event, "不存在")).toBe(false);
    expect(matchEvent(event, "")).toBe(true);
  });

  it("matchLabel：泳道 / 区域 / 时代带名命中", () => {
    expect(matchLabel("第七次倒灌前夜", "倒灌")).toBe(true);
    expect(matchLabel("主线", "支线")).toBe(false);
    expect(matchLabel("主线", "")).toBe(true);
  });
});

describe("outlineSearchHits：事件 + 别名 + 结构名", () => {
  const events = [
    { id: "e1", title: "碑前立誓", body: "", whenText: "", laneId: "l1", slot: 0 },
    { id: "e2", title: "夜渡", body: "", whenText: "", laneId: "l1", slot: 1 },
    { id: "e3", title: "收官", body: "", whenText: "", laneId: "l2", slot: 4 },
  ];
  const entities = [{ id: "n1", name: "沈砚", aliases: "小九，九爷" }];
  const casts = [{ eventId: "e1", entityId: "n1" }];
  const lanes = [
    { id: "l1", name: "主线" },
    { id: "l2", name: "支线" },
  ];
  const zones = [
    { id: "z1", laneId: "l1", name: "初遇", note: "", fromSlot: 1, toSlot: 1 },
  ];
  const eras = [{ id: "era1", name: "倒灌前夜", fromSlot: 4, toSlot: 4 }];
  const scope = { events, entities, casts, lanes, zones, eras };

  it("无搜索词返回 null（不压暗任何卡）", () => {
    expect(outlineSearchHits(scope, "  ")).toBeNull();
  });

  it("别名参与匹配", () => {
    expect([...(outlineSearchHits(scope, "九爷") ?? [])]).toEqual(["e1"]);
  });

  it("泳道名命中 → 该线事件全部命中", () => {
    const hits = outlineSearchHits(scope, "主线") ?? new Set();
    expect(hits.has("e1")).toBe(true);
    expect(hits.has("e2")).toBe(true);
    expect(hits.has("e3")).toBe(false);
  });

  it("区域名 / 时代带名命中覆盖范围内的事件", () => {
    expect((outlineSearchHits(scope, "初遇") ?? new Set()).has("e2")).toBe(true);
    expect((outlineSearchHits(scope, "倒灌") ?? new Set()).has("e3")).toBe(true);
  });

  it("完全没有命中时返回空集合（渲染层据此显示空态）", () => {
    expect((outlineSearchHits(scope, "不存在的词") ?? new Set()).size).toBe(0);
  });
});
