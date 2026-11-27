/**
 * 时间轴画布（v9 原型横向/纵向双布局还原，§8）
 *
 * 几何真相全部来自 @/shared/novel/outline（hit.ts 常量 + highlightRect），
 * 渲染层不自带第二套数字（§15 守卫）。唯一的运行期输入是**实测卡高**：
 * `.ol-ev` 的 min-height 150 只是下限，实际卡高由内容撑出，行高 / 同槽堆叠
 * 间距 / 纵向槽行距都随它派生（写死 150 会让卡底戳出泳道行、堆叠卡互相压住）。
 * 拖拽走 store.hitTest / updateDragTarget / finishDrag——命中与落格高亮同源；
 * 松手在走廊外吸回原格。
 *
 * 时间线带（era）：compactedEras 渲染、双击改名、拖边改范围（拖动只做预览、
 * 松手一次 patchEra → 邻段让位 + 空洞收拢）、右键前后新增 / 删除；占位段不可删。
 * 区域（zone）：band 描边 + 标签页；标签双击改名、✕ 删除。
 * 浮卡：casts.cardX/cardY 有值即画浮卡 + 虚线牵回宿主事件，拖动改坐标。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Input, InputNumber, Modal } from "antd";
import {
  chainNumbers,
  chainOf,
  chainLinkPath,
  freeLinkPath,
  boxFromRect,
  highlightRect,
  matchLabel,
  outlineSearchHits,
  STEP,
  ROW_H,
  ROW_GAP,
  ROW_TOP,
  STACK_GAP,
  buildLaneBands,
  laneRowHeight,
  stackCardTop,
  GUTTER,
  EV_W,
  V_COL_W,
  V_COL_GAP,
  type ChainEvent,
  type ChainLink,
  type Box,
} from "@/shared/novel/outline";
import {
  PLACEHOLDER_ERA_ID,
  compactedEras,
  maxSlotOf,
  useOutlineStore,
} from "../../store/useOutlineStore";
import { beginCardDrag } from "../../dragGesture";
import type {
  OutlineCastDTO,
  OutlineEntityDTO,
  OutlineEraDTO,
  OutlineEventDTO,
  OutlineLaneDTO,
  OutlineZoneDTO,
} from "@/shared/types/electron";
import EventCard from "../EventCard";
import { ENTITY_TYPE_COLOR } from "../EventCard/constants";
import "./index.scss";

const asChain = (event: OutlineEventDTO): ChainEvent => ({
  id: event.id,
  laneId: event.laneId,
  slot: event.slot,
  sort: event.sort,
  breakBefore: event.breakBefore,
});

// 横向行带：行内上留白（区域 / 时代标签位）+ 卡 + 下留白；行高随堆叠深度变化
const LANES_TOP = 56; // 时间线带 44 + 12 间隙
const STRIP_H = 44;
const V_SLOTS_TOP = 92; // 纵向：列头 36 + 区域标签留白 56
/** 纵向行槽内距（设计稿 .v-slot padding-top:12）：卡片不贴行槽上沿 */
const V_SLOT_PAD = 12;
// 首帧兜底卡高：真实的 .ol-ev 高度由内容（两行摘要 + 出场区）撑出，min-height
// 150 只是下限。几何一旦按 150 写死，同槽第二张卡就会压住第一张、卡底也会戳出
// 行框——渲染后用实测值校正（见 measureCardHeight）。
const CARD_H_FALLBACK = 172;

const ZONE_COLOR: Record<string, string> = {
  teal: "var(--app-accent-teal)",
  rose: "var(--app-accent-rose)",
  blue: "var(--app-accent-blue)",
  purple: "var(--app-accent-purple)",
  amber: "var(--app-accent-amber)",
  green: "var(--app-accent-green)",
  orange: "var(--app-accent-orange)",
};

function zoneColor(zone: OutlineZoneDTO): string {
  return ZONE_COLOR[zone.colorSlot] ?? "var(--app-accent-teal)";
}

/**
 * 泳道色槽（设计稿 LANE_SLOTS）：数据里没有颜色字段，按排序后的序号取强调色。
 * 同一条泳道在横向标头、纵向列头、色点、轨道细线上用同一个 --lc，保证一致。
 */
const LANE_SLOTS = [
  "blue",
  "rose",
  "amber",
  "teal",
  "purple",
  "green",
  "orange",
] as const;
const laneColorOf = (index: number): string =>
  `var(--app-accent-${LANE_SLOTS[index % LANE_SLOTS.length]})`;

/** 就地改名小输入框（双击浮出，Enter/失焦提交） */
function InlineInput({
  initial,
  maxLength,
  width,
  onCommit,
}: {
  initial: string;
  maxLength: number;
  width: number;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Input
      size="small"
      autoFocus
      value={value}
      maxLength={maxLength}
      style={{ width }}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPressEnter={() => onCommit(value.trim())}
      onBlur={() => onCommit(value.trim())}
    />
  );
}

/** 右键菜单项（设计稿 .cmenu：分隔线 / 普通项 / danger 项） */
type MenuEntry =
  | { key: string; label: string; danger?: boolean; run: () => void }
  | { sep: true };

/** 关闭浮层的通用手势：点外部 / Esc（延迟一帧，避免触发它的同一次 mousedown 立刻关掉） */
function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const timer = window.setTimeout(
      () => document.addEventListener("mousedown", onDown),
      0,
    );
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
}

/**
 * 画布右键菜单（设计稿 v6.3 `.cmenu` 同源）：
 * fixed 跟随光标、越界内收 8px、点空白 / Esc 关闭；挂在 react 树里而不是 body，
 * 但定位用视口坐标，所以不受画布滚动影响。
 */
function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);
  useDismiss(ref, onClose);
  return (
    <div ref={ref} className="ol-cmenu" style={pos} role="menu">
      {items.map((item, index) =>
        "sep" in item ? (
          <div key={`sep-${index}`} className="ol-cmenu__sep" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`ol-cmenu__item${item.danger ? " is-danger" : ""}`}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

const ZONE_SHAPES: { value: OutlineZoneDTO["shape"]; label: string }[] = [
  { value: "brace", label: "括号" },
  { value: "box", label: "方框" },
  { value: "pill", label: "胶囊" },
];

const ZONE_SLOTS = [
  "teal",
  "rose",
  "blue",
  "amber",
  "purple",
  "green",
  "orange",
] as const;

/**
 * 区域样式浮层（设计稿 `.zmenu` 同源）：挂在区域标签下方，
 * 形状 / 线条 / 填充 / 颜色 即时生效且菜单保持打开，删除走同一入口（可撤销）。
 */
function ZoneStyleMenu({
  x,
  y,
  zone,
  onClose,
}: {
  x: number;
  y: number;
  zone: OutlineZoneDTO;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const patchZone = useOutlineStore((s) => s.patchZone);
  const deleteZone = useOutlineStore((s) => s.deleteZone);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);
  useDismiss(ref, onClose);
  return (
    <div
      ref={ref}
      className="ol-zmenu"
      style={pos}
      role="dialog"
      aria-label="区域样式"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ol-zmenu__row">
        <b>形状</b>
        {ZONE_SHAPES.map((shape) => (
          <button
            key={shape.value}
            type="button"
            className={`ol-zmenu__opt${
              (zone.shape || "brace") === shape.value ? " is-on" : ""
            }`}
            onClick={() => void patchZone(zone.id, { shape: shape.value })}
          >
            {shape.label}
          </button>
        ))}
      </div>
      <div className="ol-zmenu__row">
        <b>线条</b>
        <button
          type="button"
          className={`ol-zmenu__opt${zone.solid ? "" : " is-on"}`}
          onClick={() => void patchZone(zone.id, { solid: false })}
        >
          虚线
        </button>
        <button
          type="button"
          className={`ol-zmenu__opt${zone.solid ? " is-on" : ""}`}
          onClick={() => void patchZone(zone.id, { solid: true })}
        >
          实线
        </button>
      </div>
      <div className="ol-zmenu__row">
        <b>填充</b>
        <button
          type="button"
          className={`ol-zmenu__opt${zone.filled ? "" : " is-on"}`}
          onClick={() => void patchZone(zone.id, { filled: false })}
        >
          无
        </button>
        <button
          type="button"
          className={`ol-zmenu__opt${zone.filled ? " is-on" : ""}`}
          onClick={() => void patchZone(zone.id, { filled: true })}
        >
          淡底
        </button>
      </div>
      <div className="ol-zmenu__row">
        <b>颜色</b>
        {ZONE_SLOTS.map((slot) => (
          <span
            key={slot}
            role="button"
            tabIndex={0}
            aria-label={`颜色 ${slot}`}
            className={`ol-zmenu__sw${zone.colorSlot === slot ? " is-on" : ""}`}
            style={{ background: `var(--app-accent-${slot})` }}
            onClick={() => void patchZone(zone.id, { colorSlot: slot })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void patchZone(zone.id, { colorSlot: slot });
              }
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="ol-zmenu__del"
        onClick={() => {
          onClose();
          void deleteZone(zone.id);
        }}
      >
        删除区域
      </button>
    </div>
  );
}

export default function OutlineAxis() {
  const dir = useOutlineStore((s) => s.dir);
  const lanes = useOutlineStore((s) => s.lanes);
  const events = useOutlineStore((s) => s.events);
  const entities = useOutlineStore((s) => s.entities);
  const casts = useOutlineStore((s) => s.casts);
  const zones = useOutlineStore((s) => s.zones);
  const eras = useOutlineStore((s) => s.eras);
  const chapterRefs = useOutlineStore((s) => s.chapterRefs);
  const query = useOutlineStore((s) => s.query);
  const selEventId = useOutlineStore((s) => s.selEventId);
  const zoneArm = useOutlineStore((s) => s.zoneArm);
  const drag = useOutlineStore((s) => s.drag);

  const selectEvent = useOutlineStore((s) => s.selectEvent);
  const selectEntity = useOutlineStore((s) => s.selectEntity);
  const patchEvent = useOutlineStore((s) => s.patchEvent);
  const moveCast = useOutlineStore((s) => s.moveCast);
  const createZoneFromPair = useOutlineStore((s) => s.createZoneFromPair);
  const removeCast = useOutlineStore((s) => s.removeCast);
  const addCast = useOutlineStore((s) => s.addCast);
  const renameLane = useOutlineStore((s) => s.renameLane);
  const deleteLane = useOutlineStore((s) => s.deleteLane);
  const patchZone = useOutlineStore((s) => s.patchZone);
  const deleteZone = useOutlineStore((s) => s.deleteZone);
  const addEraNextTo = useOutlineStore((s) => s.addEraNextTo);
  const addEraAt = useOutlineStore((s) => s.addEraAt);
  const patchEra = useOutlineStore((s) => s.patchEra);
  const deleteEra = useOutlineStore((s) => s.deleteEra);
  const setCastPosition = useOutlineStore((s) => s.setCastPosition);
  const addEventAfter = useOutlineStore((s) => s.addEventAfter);
  const addTrayEvent = useOutlineStore((s) => s.addTrayEvent);
  const addLane = useOutlineStore((s) => s.addLane);
  const tidy = useOutlineStore((s) => s.tidy);

  const canvasRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  /** 抓取偏移（指针相对卡片左上角）：整卡跟手时保持按下点不动，而不是跳到指针下方 */
  const grabRef = useRef({ x: 14, y: 12 });
  /** chip 拖拽幽灵（fixed，跟手；用 ref 改位置，避免每帧 React 渲染整块画布） */
  const castGhostRef = useRef<HTMLDivElement>(null);
  const [editingLane, setEditingLane] = useState<string | null>(null);
  const [editingEra, setEditingEra] = useState<string | null>(null);
  const [editingZone, setEditingZone] = useState<string | null>(null);
  /** era 拖边预览（拖动只改本地，松手一次提交） */
  const [eraPreview, setEraPreview] = useState<{
    id: string;
    from: number;
    to: number;
  } | null>(null);
  /** 松手提交用：updater 里做副作用会被 StrictMode 调两次（重复 pushUndo + 落库） */
  const eraPreviewRef = useRef<{ id: string; from: number; to: number } | null>(
    null,
  );
  /** chip / 浮卡拖拽会话（拖出成浮卡 / 拖到别的卡收纳） */
  const [castDrag, setCastDrag] = useState<{
    eventId: string;
    entityId: string;
    dropOn: string | null;
    /** 手势来源：chip 拖出时源 chip 淡出；浮卡拖动时卡内 chip 不动 */
    kind: "chip" | "float";
  } | null>(null);
  /** chip 拖拽幽灵的实体与首帧位置（有值才渲染 fixed 卡片） */
  const [castGhost, setCastGhost] = useState<{
    entityId: string;
    color: string;
    x: number;
    y: number;
  } | null>(null);
  /** 「改长度…」弹框：只改跨度，起点不动（长度 ≥ 1 格） */
  const [eraEdit, setEraEdit] = useState<{
    id: string;
    from: number;
    len: number;
  } | null>(null);  /** 右键菜单（.cmenu）与区域样式浮层（.zmenu） */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuEntry[];
  } | null>(null);
  const [zoneMenu, setZoneMenu] = useState<{
    x: number;
    y: number;
    zoneId: string;
  } | null>(null);

  /** 卡片实测高度（首帧用兜底值，挂载后按真实 DOM 校正） */
  const [cardH, setCardH] = useState(CARD_H_FALLBACK);

  /**
   * 量一次真实卡高：`.ol-ev` 的 min-height 150 只是下限，标题行 / 时间行的
   * 行高会把它撑到 ~170。横向行高、同槽堆叠间距、纵向槽行距全部由卡高派生，
   * 写死 150 就会「卡底戳出泳道行 + 第二张卡压住第一张」。
   * 主题切换 / 窗口缩放改变行高时，ResizeObserver 会再校正一次。
   */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const measure = (): void => {
      let max = 0;
      canvas
        .querySelectorAll<HTMLElement>(".ol-cellcard .ol-ev")
        .forEach((el) => {
          max = Math.max(max, el.offsetHeight);
        });
      if (max > 0)
        setCardH((prev) => (Math.abs(prev - max) > 0.5 ? max : prev));
    };
    measure();
    const observer = new ResizeObserver(measure);
    canvas
      .querySelectorAll<HTMLElement>(".ol-cellcard .ol-ev")
      .forEach((el) => {
        observer.observe(el);
      });
    return () => observer.disconnect();
  }, [dir, events, casts, lanes]);

  /** 纵向槽行距：不小于常量下限，且随实测卡高 + 呼吸位走 */
  const rowPitch = Math.max(ROW_H, cardH + ROW_GAP);

  const sortedLanes = useMemo(
    () => [...lanes].sort((a, b) => a.sort - b.sort),
    [lanes],
  );
  const laneIndex = useMemo(
    () => new Map(sortedLanes.map((lane, index) => [lane.id, index])),
    [sortedLanes],
  );
  const compacted = useMemo(() => compactedEras(eras), [eras]);
  const maxSlot = maxSlotOf(events);
  // 画布列数要同时容纳「事件最大槽」与「时间段最大格」：右键在末尾新增时间段时
  // 段体会比事件更靠右，只按事件算会被缎带的 clip-path 裁掉。
  const slotCount = Math.max(
    maxSlot + 1,
    ...compacted.map((era) => era.toSlot + 1),
    3,
  );

  /** 链派生只做一次：layout / 序号 / 连线 / 泳道计数共用（此前每条线都重算一遍 events.map） */
  const chainMap = useMemo(() => {
    const chains = events.map(asChain);
    const map = new Map<string, ChainEvent[]>();
    for (const lane of sortedLanes) map.set(lane.id, chainOf(chains, lane.id));
    return map;
  }, [sortedLanes, events]);

  /**
   * 横向泳道行带：行高 = 上留白 + 本行最大堆叠层数 × 卡高 + 层间距 + 下留白。
   * 行带是渲染（行框 / 卡位 / zone / 连线）、命中、落格高亮的唯一几何来源，
   * 不再假设「所有行一样高、每行只放一张卡」。
   */
  const laneBands = useMemo(() => {
    // 每条泳道同槽最多几张卡 = 该行要竖向展开的层数
    const depths = sortedLanes.map((lane) => {
      const depthBySlot = new Map<number, number>();
      for (const item of chainMap.get(lane.id) ?? []) {
        depthBySlot.set(item.slot, (depthBySlot.get(item.slot) ?? 0) + 1);
      }
      return Math.max(1, ...depthBySlot.values());
    });
    return buildLaneBands(depths, cardH, LANES_TOP);
  }, [sortedLanes, chainMap, cardH]);

  /** 行带兜底（泳道索引尚未同步时也不把卡画到画布外） */
  const fallbackBand = useMemo(
    () => ({ top: LANES_TOP, height: laneRowHeight(1, cardH) }),
    [cardH],
  );

  /** 搜索命中（标题/正文/别名 + 泳道/区域/时代带名）；null = 无搜索 */
  const searchHits = useMemo(
    () =>
      outlineSearchHits({ events, entities, casts, lanes, zones, eras }, query),
    [events, entities, casts, lanes, zones, eras, query],
  );

  /** 事件 → 卡片几何（横/纵统一）：{laneIdx, slot, stackIdx} */
  const layout = useMemo(() => {
    const map = new Map<
      string,
      { laneIdx: number; slot: number; stackIdx: number }
    >();
    for (const lane of sortedLanes) {
      const chain = chainMap.get(lane.id) ?? [];
      const perSlot = new Map<number, number>();
      for (const item of chain) {
        const stackIdx = perSlot.get(item.slot) ?? 0;
        perSlot.set(item.slot, stackIdx + 1);
        map.set(item.id, {
          laneIdx: laneIndex.get(lane.id) ?? 0,
          slot: item.slot,
          stackIdx,
        });
      }
    }
    return map;
  }, [sortedLanes, chainMap, laneIndex]);

  const chainNo = useMemo(() => {
    const merged = new Map<string, number>();
    for (const lane of sortedLanes) {
      for (const [id, no] of chainNumbers(chainMap.get(lane.id) ?? [])) {
        merged.set(id, no);
      }
    }
    return merged;
  }, [sortedLanes, chainMap]);

  /**
   * 卡片矩形（横/纵统一坐标系）：连线端点落点、浮卡牵线避让、推进链绕行
   * 都消费这一份几何，不在渲染时各算一套坐标。
   */
  const cardBoxes = useMemo(() => {
    const map = new Map<string, Box>();
    for (const [id, geo] of layout) {
      const x =
        dir === "h"
          ? GUTTER + geo.slot * STEP + (STEP - EV_W) / 2
          : geo.laneIdx * (V_COL_W + V_COL_GAP) + geo.stackIdx * (EV_W + 8);
      const y =
        dir === "h"
          ? stackCardTop(
              (laneBands[geo.laneIdx] ?? fallbackBand).top,
              geo.stackIdx,
              cardH,
            )
          : V_SLOTS_TOP + geo.slot * rowPitch + V_SLOT_PAD;
      map.set(id, boxFromRect({ x, y, w: EV_W, h: cardH }));
    }
    return map;
  }, [layout, dir, laneBands, fallbackBand, cardH, rowPitch]);

  /* ── 拖拽：window 级 pointer 跟随 ──
     旧实现把监听挂在 .ol-axis 上、且用「画布相对坐标」定位 fixed 的 ghost：
     ① 从托盘拖出时指针在 axis 外，move/up 都收不到 → ghost 不跟随；
     ② 点托盘卡片的 pointerup 落在 axis 外 → drag 不清除 → ghost 残留左下角。
     统一改 window 监听 + 视口坐标（fixed 元素唯一正确的坐标系）。 */
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;

    // ghost 初始位置 = pointerdown 的视口坐标（只设一次，之后由 pointermove 直接改 DOM，
    // 不走 React 渲染，避免 target 更新时把它们重置回起点）。
    // 整卡跟手：按「指针相对卡左上角」的偏移定位，卡片不会在手指下跳动（设计稿
    // .ev-wrap.moving 是整卡 fixed 跟随，不是从指针处冒出一张新卡）。
    const dragState = useOutlineStore.getState().drag;
    const origin = dragState?.origin;
    if (ghostRef.current && origin && dragState) {
      const cardEl = document.querySelector<HTMLElement>(
        `[data-event-id="${dragState.eventId}"]`,
      );
      const rect = cardEl?.getBoundingClientRect();
      grabRef.current =
        rect && rect.width > 0
          ? { x: origin.x - rect.left, y: origin.y - rect.top }
          : { x: 14, y: 12 };
      ghostRef.current.style.left = `${origin.x - grabRef.current.x}px`;
      ghostRef.current.style.top = `${origin.y - grabRef.current.y}px`;
    }

    const onMove = (e: PointerEvent): void => {
      const state = useOutlineStore.getState();
      if (!state.drag) return;
      if (ghostRef.current) {
        ghostRef.current.style.left = `${e.clientX - grabRef.current.x}px`;
        ghostRef.current.style.top = `${e.clientY - grabRef.current.y}px`;
      }
      const under = e.target as HTMLElement | null;
      if (under?.closest?.(".ol-tray")) return; // 托盘的 enter/leave 自己管 toTray
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const inCanvas =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      const target = inCanvas
        ? dir === "h"
          ? state.hitTest(
              e.clientX - rect.left,
              e.clientY - rect.top,
              0,
              laneBands,
            )
          : state.hitTest(
              e.clientX - rect.left,
              e.clientY - rect.top,
              V_SLOTS_TOP,
              [],
              rowPitch,
            )
        : null;
      // 目标没变就不重复写 store（拖拽期间避免每帧无谓重渲染）
      const prev = state.drag.target;
      if (
        prev?.laneId !== target?.laneId ||
        prev?.slot !== target?.slot ||
        (prev === null) !== (target === null)
      ) {
        state.updateDragTarget(target);
      }
    };
    const onUp = (): void => {
      const state = useOutlineStore.getState();
      if (state.drag) void state.finishDrag(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, dir, laneBands, rowPitch]);

  /* ── chip 拖拽：拖到别的卡改挂，拖到空白成浮卡（FR-22 / FR-23） ──
     早期 chip 上没有任何拖动逻辑（浮卡能力不可达），moveCast 也没有调用点。 */
  const beginCastDrag = (cast: OutlineCastDTO, e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    const entity = entities.find((item) => item.id === cast.entityId);
    const color = entity
      ? ENTITY_TYPE_COLOR[entity.type][0]
      : "var(--app-text-muted)";
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    /** 指针下方的事件卡（含源卡：拖回源卡＝放回原位，不做任何改动） */
    const targetUnder = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const card = el?.closest("[data-event-id]") as HTMLElement | null;
      return card?.dataset.eventId ?? null;
    };
    const onMove = (move: PointerEvent): void => {
      if (move.buttons === 0) {
        cleanup();
        setCastDrag(null);
        setCastGhost(null);
        return;
      }
      if (!started) {
        if (
          Math.abs(move.clientX - startX) < 4 &&
          Math.abs(move.clientY - startY) < 4
        ) {
          return;
        }
        started = true;
        // 设计稿：拖出即生成一张跟手的浮卡幽灵（--fc = 实体类型色）
        setCastGhost({
          entityId: cast.entityId,
          color,
          x: move.clientX,
          y: move.clientY,
        });
      }
      if (castGhostRef.current) {
        castGhostRef.current.style.left = `${move.clientX - 16}px`;
        castGhostRef.current.style.top = `${move.clientY - 15}px`;
      }
      const under = targetUnder(move.clientX, move.clientY);
      // 源卡不高亮（拖回原处不算落点）
      const dropOn = under && under !== cast.eventId ? under : null;
      setCastDrag((prev) =>
        prev && prev.dropOn === dropOn
          ? prev
          : {
              eventId: cast.eventId,
              entityId: cast.entityId,
              dropOn,
              kind: "chip",
            },
      );
    };
    const onUp = (up: PointerEvent): void => {
      cleanup();
      setCastDrag(null);
      setCastGhost(null);
      if (!started) return; // 只是点了一下：交给 onClick 做汇总
      const under = targetUnder(up.clientX, up.clientY);
      if (under === cast.eventId) return; // 拖回原卡＝放回原位
      if (under) {
        void moveCast(cast.eventId, cast.entityId, under);
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = up.clientX - rect.left - 30;
      const y = up.clientY - rect.top - 14;
      if (x < 0 || y < 0) return; // 拖出画布 = 取消，归属不变
      void setCastPosition(cast.eventId, cast.entityId, x, y);
    };
    const onCancel = (): void => {
      cleanup();
      setCastDrag(null);
      setCastGhost(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  /* ── 右键菜单（设计稿 openEvMenu / openEraMenu / openLaneMenu / 空白菜单） ── */
  const openEventMenu = (
    event: OutlineEventDTO,
    x: number,
    y: number,
  ): void => {
    const chain = event.laneId ? (chainMap.get(event.laneId) ?? []) : [];
    const at = chain.findIndex((item) => item.id === event.id);
    const items: MenuEntry[] = [
      {
        key: "after",
        label: "＋ 在此事件后新增",
        run: () => void addEventAfter(event.id),
      },
    ];
    // 链内非首段才有「断开 / 接回」（首段前面没有连线）
    if (at > 0) {
      items.push({
        key: "break",
        label: event.breakBefore
          ? "＋ 接回与上一段的连线"
          : "✂ 断开与上一段的连线",
        run: () =>
          void patchEvent(event.id, { breakBefore: !event.breakBefore }),
      });
    }
    items.push({ sep: true });
    items.push({
      key: "del",
      label: "✕ 删除此事件",
      danger: true,
      // 设计稿 removeEvent：直接删 + toast（不弹二次确认），Ctrl+Z 可整段找回
      run: () => void useOutlineStore.getState().deleteEvent(event.id),
    });
    setMenu({ x, y, items });
  };

  /* ── 卡片渲染（横/纵共用） ── */
  const renderCard = (event: OutlineEventDTO): React.ReactNode => {
    const geo = layout.get(event.id);
    if (!geo) return null;
    const own = casts.filter((cast) => cast.eventId === event.id);
    const isDragging = drag?.eventId === event.id;
    const dimmed = searchHits !== null && !searchHits.has(event.id);
    const laneChain = event.laneId ? (chainMap.get(event.laneId) ?? []) : [];
    const posinset = laneChain.findIndex((item) => item.id === event.id) + 1;
    return (
      <div
        key={event.id}
        className={`ol-cellcard${isDragging ? " is-dragging" : ""}`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openEventMenu(event, e.clientX, e.clientY);
        }}
        style={
          dir === "h"
            ? {
                left: GUTTER + geo.slot * STEP + (STEP - EV_W) / 2,
                top: stackCardTop(
                  (laneBands[geo.laneIdx] ?? fallbackBand).top,
                  geo.stackIdx,
                  cardH,
                ),
              }
            : {
                left:
                  geo.laneIdx * (V_COL_W + V_COL_GAP) +
                  geo.stackIdx * (EV_W + 8),
                top: V_SLOTS_TOP + geo.slot * rowPitch + V_SLOT_PAD,
              }
        }
      >
        <EventCard
          event={event}
          chainNumber={chainNo.get(event.id) ?? 1}
          casts={own}
          entities={entities}
          selected={selEventId === event.id}
          chapterCount={chapterRefs[event.id] ?? 0}
          zoneArmTarget={zoneArm === event.id}
          dimmed={dimmed}
          floatingCastIds={own
            .filter((cast) => cast.cardX !== null && cast.cardY !== null)
            .map((cast) => cast.entityId)}
          setsize={laneChain.length}
          posinset={posinset > 0 ? posinset : undefined}
          draggingEntityId={
            castDrag?.eventId === event.id && castDrag.kind === "chip"
              ? castDrag.entityId
              : null
          }
          castDropTarget={castDrag?.dropOn === event.id}
          onPointerDown={(e) => beginCardDrag(event.id, e)}
          onClick={() => {
            if (zoneArm && zoneArm !== event.id) {
              void createZoneFromPair(zoneArm, event.id);
              return;
            }
            selectEvent(event.id);
          }}
          onRemoveCast={(entityId) => void removeCast(event.id, entityId)}
          onAddCast={(entityId) => void addCast(event.id, entityId)}
          onCastPointerDown={(entityId, e) => {
            const cast = own.find((item) => item.entityId === entityId);
            if (cast) beginCastDrag(cast, e);
          }}
          onCastClick={(entityId) => {
            selectEvent(event.id);
            selectEntity(entityId);
          }}
        />
      </div>
    );
  };

  /* ── 推进链箭头 + 断口标记（横向） ──
     路径/线型严格按设计稿：主色 2px 曲线 + 6px 淡 glow + 实心三角箭头；
     同格走短直线、跨格错位大走圆角肘、有卡挡路从中点绕行（links.ts）。
     断口落在路径两端中点，双击可重接（§8.3/FR-12）。 */
  const links = useMemo(() => {
    const items: ChainLink[] = [];
    const breaks: { eventId: string; x: number; y: number }[] = [];
    if (dir !== "h") return { items, breaks };
    const all = [...cardBoxes.values()];
    for (const lane of sortedLanes) {
      const chain = chainMap.get(lane.id) ?? [];
      for (let i = 0; i < chain.length - 1; i += 1) {
        const from = chain[i];
        const to = chain[i + 1];
        const a = cardBoxes.get(from.id);
        const b = cardBoxes.get(to.id);
        if (!a || !b) continue;
        const obstacles = all.filter((box) => box !== a && box !== b);
        const link = chainLinkPath(a, b, "h", obstacles, from.slot === to.slot);
        if (to.breakBefore) {
          breaks.push({
            eventId: to.id,
            x: (link.start.x + link.end.x) / 2,
            y: (link.start.y + link.end.y) / 2,
          });
        } else {
          items.push(link);
        }
      }
    }
    return { items, breaks };
  }, [dir, sortedLanes, chainMap, cardBoxes]);

  /* ── era：拖边改范围（拖动预览、松手一次提交） ──
     era 入参取自 compactedEras（已收拢），基准必须跟渲染同一坐标系，否则存在
     空洞时按下位置与视觉位置不一致、松手会跳。 */
  const eraResize = (
    era: OutlineEraDTO,
    edge: "l" | "r" | "t" | "b",
    e: React.PointerEvent,
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseFrom = era.fromSlot;
    const baseTo = era.toSlot;
    /** 吸附格边界：只有真的移动过半格才认（与设计稿 Math.round 同口径） */
    let moved = false;
    const onMove = (move: PointerEvent): void => {
      const step = edge === "l" || edge === "r" ? STEP : rowPitch;
      const delta =
        edge === "l" || edge === "r"
          ? Math.round((move.clientX - startX) / step)
          : Math.round((move.clientY - startY) / step);
      if (delta !== 0) moved = true;
      let from = baseFrom;
      let to = baseTo;
      if (edge === "l") from = Math.max(0, Math.min(baseFrom + delta, baseTo));
      if (edge === "r") to = Math.max(baseTo + delta, baseFrom);
      if (edge === "t") from = Math.max(0, Math.min(baseFrom + delta, baseTo));
      if (edge === "b") to = Math.max(baseTo + delta, baseFrom);
      const next = { id: era.id, from, to };
      eraPreviewRef.current = next;
      setEraPreview(next);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const preview = eraPreviewRef.current;
      eraPreviewRef.current = null;
      setEraPreview(null);
      // 没移动＝误触：不写库、不进撤销栈
      if (!moved || !preview || preview.id !== era.id) return;
      // 副作用不能放在 setState updater 里（StrictMode 会调两次 → 双份撤销 + 双份落库）
      void patchEra(era.id, { fromSlot: preview.from, toSlot: preview.to });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 时间段右键（设计稿 openEraMenu）：改名 / 改长度 / 前后新增 / 删除（占位段无删除） */
  const openEraMenu = (era: OutlineEraDTO, x: number, y: number): void => {
    const items: MenuEntry[] = [
      { key: "rename", label: "✎ 改名", run: () => setEditingEra(era.id) },
      {
        key: "length",
        label: "⤢ 改长度…",
        run: () =>
          setEraEdit({
            id: era.id,
            from: era.fromSlot,
            len: Math.max(1, era.toSlot - era.fromSlot + 1),
          }),
      },
      { sep: true },
      {
        key: "before",
        label: "＋ 前方新增时间段",
        run: () => {
          void addEraNextTo(era.id, true).then((id) => {
            if (id) setEditingEra(id);
          });
        },
      },
      {
        key: "after",
        label: "＋ 后方新增时间段",
        run: () => {
          void addEraNextTo(era.id, false).then((id) => {
            if (id) setEditingEra(id);
          });
        },
      },
    ];
    if (era.id !== PLACEHOLDER_ERA_ID) {
      items.push({ sep: true });
      items.push({
        key: "del",
        label: "✕ 删除时间段",
        danger: true,
        run: () => void deleteEra(era.id),
      });
    }
    setMenu({ x, y, items });
  };

  const eraCount = (era: OutlineEraDTO): number =>
    events.filter(
      (event) =>
        event.laneId !== null &&
        event.slot >= era.fromSlot &&
        event.slot <= era.toSlot,
    ).length;

  /** 预览优先：拖边中的段用本地预览范围渲染 */
  const eraRangeOf = (era: OutlineEraDTO): { from: number; to: number } => {
    if (eraPreview?.id === era.id)
      return { from: eraPreview.from, to: eraPreview.to };
    return { from: era.fromSlot, to: era.toSlot };
  };

  const renderEraStrip = (): React.ReactNode => (
    <div className="ol-strip" style={{ left: GUTTER, width: slotCount * STEP }}>
      {compacted.map((era) => {
        const isPh = era.id === PLACEHOLDER_ERA_ID;
        const { from, to } = eraRangeOf(era);
        const count = eraCount(era);
        const resizing = eraPreview?.id === era.id;
        return (
          <div
            key={era.id}
            className={`ol-era${isPh ? " is-ph" : ""}${resizing ? " is-resizing" : ""}`}
            style={{ left: from * STEP, width: (to - from + 1) * STEP }}
            title={`第 ${from + 1}-${to + 1} 格 · ${count} 个事件`}
            role="group"
            aria-label={`时间段 ${era.name || "未命名时间段"}，第 ${from + 1} 到 ${to + 1} 格`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openEraMenu(era, e.clientX, e.clientY);
            }}
          >
            {editingEra === era.id ? (
              <InlineInput
                initial={era.name}
                maxLength={20}
                width={120}
                onCommit={(value) => {
                  setEditingEra(null);
                  if (value) void patchEra(era.id, { name: value });
                }}
              />
            ) : (
              <b onDoubleClick={() => setEditingEra(era.id)}>
                {era.name ||
                  (isPh ? "未命名时间段（双击改名）" : "未命名时间段")}
              </b>
            )}
            <i>
              {isPh && count === 0
                ? "拖右缘调范围 · 右键增段"
                : `${count} 事件`}
            </i>
            <span
              className="ol-era__edge is-l"
              onPointerDown={(e) => eraResize(era, "l", e)}
            />
            <span
              className="ol-era__edge is-r"
              onPointerDown={(e) => eraResize(era, "r", e)}
            />
          </div>
        );
      })}
    </div>
  );

  const renderEraRail = (railHeight: number): React.ReactNode => (
    <div className="ol-vrail" style={{ minHeight: railHeight }}>
      <div className="ol-vrail__head">时间线 · {compacted.length} 段</div>
      {compacted.map((era) => {
        const isPh = era.id === PLACEHOLDER_ERA_ID;
        const { from, to } = eraRangeOf(era);
        const count = eraCount(era);
        const resizing = eraPreview?.id === era.id;
        return (
          <div
            key={era.id}
            className={`ol-era is-v${isPh ? " is-ph" : ""}${resizing ? " is-resizing" : ""}`}
            style={{
              top: V_SLOTS_TOP + from * rowPitch,
              height: (to - from + 1) * rowPitch,
            }}
            title={`第 ${from + 1}-${to + 1} 格 · ${count} 个事件`}
            role="group"
            aria-label={`时间段 ${era.name || "未命名时间段"}，第 ${from + 1} 到 ${to + 1} 格`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openEraMenu(era, e.clientX, e.clientY);
            }}
          >
            {editingEra === era.id ? (
              <InlineInput
                initial={era.name}
                maxLength={20}
                width={90}
                onCommit={(value) => {
                  setEditingEra(null);
                  if (value) void patchEra(era.id, { name: value });
                }}
              />
            ) : (
              <b onDoubleClick={() => setEditingEra(era.id)}>
                {era.name || (isPh ? "未命名时间段" : "未命名时间段")}
              </b>
            )}
            <i>
              {isPh && count === 0
                ? "拖下缘调范围 · 右键增段"
                : `${count} 事件`}
            </i>
            <span
              className="ol-era__edge is-t"
              onPointerDown={(e) => eraResize(era, "t", e)}
            />
            <span
              className="ol-era__edge is-b"
              onPointerDown={(e) => eraResize(era, "b", e)}
            />
          </div>
        );
      })}
    </div>
  );

  /* ── 区域 band ── */
  const renderZone = (zone: OutlineZoneDTO): React.ReactNode => {
    const li = laneIndex.get(zone.laneId);
    if (li === undefined) return null;
    const color = zoneColor(zone);
    const shape = `is-${zone.shape}${zone.solid ? " is-solid" : ""}${zone.filled ? " is-filled" : ""}`;
    // 同槽堆叠时要包住全部卡：按区间内最大堆叠序号收包（此前高度恒为单卡）
    const members = events.filter(
      (event) =>
        event.laneId === zone.laneId &&
        event.slot >= zone.fromSlot &&
        event.slot <= zone.toSlot,
    );
    // 空区不渲染（设计稿 v7.1）：区间内没有任何事件时数据保留、框不画，
    // 否则把 from/to 里的空格也框出来，看起来像「轨道行上凭空多了块区域」
    if (members.length === 0) return null;
    const firstSlot = Math.min(...members.map((event) => event.slot));
    const lastSlot = Math.max(...members.map((event) => event.slot));
    const stackMax = members.reduce(
      (max, event) => Math.max(max, layout.get(event.id)?.stackIdx ?? 0),
      0,
    );
    const label =
      editingZone === zone.id ? (
        <InlineInput
          initial={zone.name}
          maxLength={20}
          width={110}
          onCommit={(value) => {
            setEditingZone(null);
            if (value) void patchZone(zone.id, { name: value });
          }}
        />
      ) : (
        <>
          <span className="ol-band__name">{zone.name || "未命名区域"}</span>
          <span
            className="ol-band__x"
            role="button"
            tabIndex={0}
            aria-label="删除区域"
            onClick={(e) => {
              e.stopPropagation();
              void deleteZone(zone.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              void deleteZone(zone.id);
            }}
          >
            ✕
          </span>
        </>
      );
    const labelProps = {
      className: "ol-band__label",
      onDoubleClick: () => setEditingZone(zone.id),
      // 设计稿：区域标签右键＝样式浮层（形状 / 线条 / 填充 / 颜色 / 删除）
      onContextMenu: (e: React.MouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setZoneMenu({ x: rect.left, y: rect.bottom + 6, zoneId: zone.id });
      },
      style: { "--zc": color } as React.CSSProperties,
    };
    if (dir === "h") {
      return (
        <div
          key={zone.id}
          className={`ol-band ${shape}`}
          style={
            {
              // 收包实际成员（含空格时区间不外扩）：左右各内收 5px
              left: GUTTER + firstSlot * STEP + 5,
              width: (lastSlot - firstSlot + 1) * STEP - 10,
              // 顶部从行内留白里起（设计稿 band top:52）：比卡顶高 6px，
              // 标签贴在框顶上方，不压轨道标题 / 时代带
              top: (laneBands[li] ?? fallbackBand).top + ROW_TOP - 6,
              height: (stackMax + 1) * cardH + stackMax * STACK_GAP + 12,
              "--zc": color,
            } as React.CSSProperties
          }
        >
          <span {...labelProps}>{label}</span>
        </div>
      );
    }
    // 宽度按区间内「单槽最多卡数」收包（不是成员总数）：多槽区域的每列都要包住
    const perSlot = new Map<number, number>();
    for (const event of members) {
      perSlot.set(event.slot, (perSlot.get(event.slot) ?? 0) + 1);
    }
    const maxN = Math.max(...perSlot.values());
    const bandWidth = Math.min(V_COL_W, maxN * EV_W + (maxN - 1) * 8 + 16);
    // 右侧可用空间不足 110px 时标签收回框内，避免压住邻列
    const innerLabel = V_COL_W + V_COL_GAP / 2 - bandWidth < 110;
    return (
      <div
        key={zone.id}
        className={`ol-band is-vt ${shape}`}
        style={
          {
            left: li * (V_COL_W + V_COL_GAP) - 8,
            width: bandWidth,
            top: V_SLOTS_TOP + firstSlot * rowPitch + 5,
            // 底边贴最后一张卡的下缘 + 8px（设计稿按实际卡堆收包，不用槽高近似）
            height: (lastSlot - firstSlot) * rowPitch + V_SLOT_PAD + cardH + 8,
            "--zc": color,
          } as React.CSSProperties
        }
      >
        <span
          {...labelProps}
          className={`ol-band__label${innerLabel ? " is-inner" : ""}`}
        >
          {label}
        </span>
      </div>
    );
  };

  /* ── 泳道标头 ── */
  const openLaneMenu = (lane: OutlineLaneDTO, x: number, y: number): void => {
    const last = lanes.length <= 1;
    setMenu({
      x,
      y,
      items: [
        { key: "rename", label: "✎ 改名", run: () => setEditingLane(lane.id) },
        { sep: true },
        {
          key: "del",
          label: last ? "✕ 删除时间线（至少保留一条）" : "✕ 删除时间线",
          danger: true,
          run: () => void deleteLane(lane.id),
        },
      ],
    });
  };

  const renderLaneHead = (
    lane: OutlineLaneDTO,
    compact: boolean,
    color: string,
  ): React.ReactNode => {
    const dim = !matchLabel(lane.name, query);
    const count = (chainMap.get(lane.id) ?? []).length;
    return (
      <div
        className={`ol-lanehead${dim ? " is-dim" : ""}${compact ? " is-compact" : ""}`}
        style={{ "--lc": color } as React.CSSProperties}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openLaneMenu(lane, e.clientX, e.clientY);
        }}
      >
        {editingLane === lane.id ? (
          <InlineInput
            initial={lane.name}
            maxLength={20}
            width={80}
            onCommit={(value) => {
              setEditingLane(null);
              void renameLane(lane.id, value);
            }}
          />
        ) : (
          <b onDoubleClick={() => setEditingLane(lane.id)}>
            {/* 泳道色点（设计稿 .lane-dot）：颜色按泳道序号取强调色槽，
                纵向列头的 2px 轨道色线也读同一个 --lc */}
            <span className="ol-lanehead__dot" />
            {lane.name || "未命名时间线"}
          </b>
        )}
        <span className="ol-lanehead__cnt">{count} 事件</span>
      </div>
    );
  };

  const vColsHeight = V_SLOTS_TOP + slotCount * rowPitch + 64;
  const lastBand = laneBands[laneBands.length - 1];
  const hCanvasHeight =
    (lastBand ? lastBand.top + lastBand.height : LANES_TOP) + 64;

  /* 拖拽落格高亮（与命中同源：highlightRect） */
  const highlight = (() => {
    if (!drag?.target) return null;
    const laneIdx = laneIndex.get(drag.target.laneId) ?? 0;
    const band = laneBands[laneIdx] ?? fallbackBand;
    return dir === "h"
      ? highlightRect(drag.target, "h", laneIdx, 0, band)
      : highlightRect(drag.target, "v", laneIdx, V_SLOTS_TOP, band, rowPitch);
  })();

  /* 浮卡（cardX/cardY 都有值才画） */
  const floatCasts = casts.filter(
    (cast): cast is OutlineCastDTO & { cardX: number; cardY: number } =>
      cast.cardX !== null && cast.cardY !== null,
  );

  /** 画布右键（设计稿 v6.5 分支）：时间条空白＝按列新增时间段；其余空白＝新增事件 / 时间线 / 整理 */
  const openCanvasMenu = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "[data-event-id],.ol-era,.ol-band__label,.ol-lanehead,.ol-cmenu,.ol-zmenu",
      )
    ) {
      return; // 卡 / 时间段 / 区域标签 / 泳道标头各自处理
    }
    if (target.closest(".ol-fcard")) {
      e.preventDefault(); // 浮卡没有右键菜单，但也别弹系统菜单
      return;
    }
    e.preventDefault();
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (dir === "h" && target.closest(".ol-strip") && rect) {
      // 换算扣除 GUTTER 偏移：点击列 = 新段起始格（默认 2 格）
      const col = Math.max(
        0,
        Math.floor((e.clientX - rect.left - GUTTER) / STEP),
      );
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            key: "era",
            label: "＋ 新增时间段",
            run: () => {
              void addEraAt(col).then((id) => {
                if (id) setEditingEra(id);
              });
            },
          },
        ],
      });
      return;
    }
    const items: MenuEntry[] = [
      {
        key: "ev",
        label: "＋ 新增事件（进待归类）",
        run: () => void addTrayEvent(),
      },
      { key: "lane", label: "＋ 新增时间线", run: () => void addLane() },
    ];
    if (dir === "v") {
      items.push({
        key: "era",
        label: "＋ 新增时间段",
        run: () => {
          void addEraAt(0).then((id) => {
            if (id) setEditingEra(id);
          });
        },
      });
    }
    items.push({ sep: true });
    items.push({ key: "tidy", label: "✳ 一键整理", run: () => tidy() });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="ol-axis" onContextMenu={openCanvasMenu}>
      {dir === "h" ? (
        <div
          className="ol-hcanvas"
          ref={canvasRef}
          role="list"
          aria-label="时间轴事件"
          style={{
            width: GUTTER + slotCount * STEP + 80,
            minHeight: hCanvasHeight,
          }}
        >
          <div
            className="ol-strip__head"
            style={{ width: 92, height: STRIP_H }}
          >
            时间线 · {compacted.length} 段
          </div>
          {renderEraStrip()}
          {sortedLanes.map((lane, laneIdx) => {
            const band = laneBands[laneIdx] ?? fallbackBand;
            return (
              <div
                key={lane.id}
                className="ol-lanerow"
                style={{
                  top: band.top,
                  height: band.height,
                }}
              >
                {renderLaneHead(lane, false, laneColorOf(laneIdx))}
              </div>
            );
          })}
          {[...zones].sort((a, b) => a.sort - b.sort).map(renderZone)}
          {events.filter((event) => event.laneId !== null).map(renderCard)}
          {highlight && (
            <div
              className="ol-cellhl"
              style={{
                left: highlight.x,
                top: highlight.y,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          )}
          <svg className="ol-links" width="100%" height="100%">
            {/* glow：主色 6px、12% 透明，压在主线下面（设计稿 arrow 同款） */}
            {links.items.map((item, index) => (
              <path key={`g${index}`} d={item.d} className="ol-links__glow" />
            ))}
            {links.items.map((item, index) => (
              <path key={`l${index}`} d={item.d} className="ol-links__path" />
            ))}
            {links.items.map((item, index) => {
              const len = item.short ? 8 : 11;
              const half = item.short ? 4 : 5;
              const bx = item.end.x - item.tan.x * len;
              const by = item.end.y - item.tan.y * len;
              const points = [
                `${item.end.x},${item.end.y}`,
                `${bx - item.tan.y * half},${by + item.tan.x * half}`,
                `${bx + item.tan.y * half},${by - item.tan.x * half}`,
              ].join(" ");
              return (
                <polygon
                  key={`a${index}`}
                  points={points}
                  className="ol-links__head"
                />
              );
            })}
          </svg>
          {/* 断口：双击接回（旧实现只是不画线，作者看不到断在哪） */}
          {links.breaks.map((item) => (
            <button
              key={item.eventId}
              type="button"
              className="ol-break"
              style={{ left: item.x - 9, top: item.y - 9 }}
              title="推进链在此断开 · 双击接回"
              aria-label="推进链断口，双击接回"
              onClick={() => selectEvent(item.eventId)}
              onDoubleClick={() =>
                void patchEvent(item.eventId, { breakBefore: false })
              }
            >
              ✂
            </button>
          ))}
          <FloatLayer
            casts={floatCasts}
            entities={entities}
            boxes={cardBoxes}
            onMove={(eventId, entityId, x, y) =>
              void setCastPosition(eventId, entityId, x, y)
            }
            onDropTarget={(eventId, entityId, dropOn) =>
              setCastDrag(
                dropOn ? { eventId, entityId, dropOn, kind: "float" } : null,
              )
            }
            onDrop={(eventId, entityId, toEventId) => {
              if (toEventId === eventId) {
                // 拖回宿主卡＝收回卡内（设计稿：浮卡拖到事件卡上就是收纳）
                void setCastPosition(eventId, entityId, -1, -1);
                return;
              }
              void moveCast(eventId, entityId, toEventId);
            }}
          />
        </div>
      ) : (
        <div className="ol-vwrap">
          {renderEraRail(vColsHeight)}
          <div
            className="ol-vcols"
            ref={canvasRef}
            role="list"
            aria-label="时间轴事件"
            style={{
              width: sortedLanes.length * (V_COL_W + V_COL_GAP),
              minHeight: vColsHeight,
            }}
          >
            {sortedLanes.map((lane, laneIdx) => (
              <div
                key={lane.id}
                className="ol-vcol"
                style={{
                  left: laneIdx * (V_COL_W + V_COL_GAP),
                  width: V_COL_W,
                }}
              >
                {/* 设计稿纵向顺序：列头 36 → 区域标签留白 56 → 首槽（92） */}
                <div className="ol-vcol__head">
                  {renderLaneHead(lane, true, laneColorOf(laneIdx))}
                </div>
                <div className="ol-vcol__sp" />
              </div>
            ))}
            {[...zones].sort((a, b) => a.sort - b.sort).map(renderZone)}
            {events.filter((event) => event.laneId !== null).map(renderCard)}
            {highlight && (
              <div
                className="ol-cellhl"
                style={{
                  left: highlight.x,
                  top: highlight.y,
                  width: highlight.width,
                  height: highlight.height,
                }}
              />
            )}
            <FloatLayer
              casts={floatCasts}
              entities={entities}
              boxes={cardBoxes}
              onMove={(eventId, entityId, x, y) =>
                void setCastPosition(eventId, entityId, x, y)
              }
              onDropTarget={(eventId, entityId, dropOn) =>
                setCastDrag(
                  dropOn ? { eventId, entityId, dropOn, kind: "float" } : null,
                )
              }
              onDrop={(eventId, entityId, toEventId) => {
                if (toEventId === eventId) {
                  void setCastPosition(eventId, entityId, -1, -1);
                  return;
                }
                void moveCast(eventId, entityId, toEventId);
              }}
            />
          </div>
        </div>
      )}

      {drag &&
        (() => {
          const dragEvent = events.find((event) => event.id === drag.eventId);
          if (!dragEvent) return null;
          const ownCasts = casts.filter(
            (cast) => cast.eventId === drag.eventId,
          );
          const laneChain = dragEvent.laneId
            ? (chainMap.get(dragEvent.laneId) ?? [])
            : [];
          const posinset =
            laneChain.findIndex((item) => item.id === dragEvent.id) + 1;
          // 整卡跟手（设计稿 .ev-wrap.moving）：复用卡片本体，视觉与原位完全一致，
          // 不另造一个简化幽灵——尺寸/内容/chip 折行都自然对齐
          return (
            <div className="ol-dragghost" ref={ghostRef} aria-hidden>
              <EventCard
                event={dragEvent}
                chainNumber={chainNo.get(dragEvent.id) ?? 1}
                casts={ownCasts}
                entities={entities}
                selected={selEventId === dragEvent.id}
                chapterCount={chapterRefs[dragEvent.id] ?? 0}
                floatingCastIds={ownCasts
                  .filter((cast) => cast.cardX !== null && cast.cardY !== null)
                  .map((cast) => cast.entityId)}
                setsize={laneChain.length}
                posinset={posinset > 0 ? posinset : undefined}
                onRemoveCast={() => undefined}
                onAddCast={() => undefined}
              />
            </div>
          );
        })()}

      {events.length === 0 && (
        <div className="ol-axis__empty">
          <b>画布还是空的</b>
          {/* 新草稿自带「主线」：有轨道行时就别再让用户「先建一条时间线」，
              直接告诉他卡片能落到哪里（托盘拖入 / N 追加链尾）。 */}
          {lanes.length === 0
            ? "先建一条时间线，再按 N 新建第一个事件"
            : "从左侧托盘把卡片拖到轨道行，或按 N 新建第一个事件"}
        </div>
      )}

      {/* 搜索空态（§8.9）：命中集合为空时明确告知，而不是整屏压暗 */}
      {events.length > 0 && searchHits !== null && searchHits.size === 0 && (
        <div className="ol-axis__empty">
          <b>没找到「{query.trim()}」</b>
          搜索范围含标题、摘要、时间文本、角色名与别名、时间线 / 区域 / 时间段名
        </div>
      )}

      {/* 改长度：右键时间段 → ⤢ 改长度…（§13）：起点不动，只改跨几格 */}
      <Modal
        title="改时间段长度"
        open={eraEdit !== null}
        okText="保存"
        cancelText="取消"
        onCancel={() => setEraEdit(null)}
        onOk={() => {
          if (!eraEdit) return;
          const len = Math.max(1, Math.round(eraEdit.len));
          void patchEra(eraEdit.id, {
            fromSlot: eraEdit.from,
            toSlot: eraEdit.from + len - 1,
          });
          setEraEdit(null);
        }}
      >
        {eraEdit && (
          <div className="ol-erarange">
            <div className="ol-erarange__row">
              <span>第</span>
              <InputNumber
                min={1}
                value={eraEdit.from + 1}
                onChange={(value) =>
                  setEraEdit({ ...eraEdit, from: Math.max(0, (value ?? 1) - 1) })
                }
              />
              <span>格起，共</span>
              <InputNumber
                min={1}
                value={eraEdit.len}
                onChange={(value) =>
                  setEraEdit({ ...eraEdit, len: Math.max(1, value ?? 1) })
                }
              />
              <span>格</span>
            </div>
            {(() => {
              // 段内的卡不能被框甩出去：给出该段实际需要的最短长度
              const slots = events
                .filter(
                  (event) =>
                    event.laneId !== null &&
                    event.slot >= eraEdit.from &&
                    event.slot <= eraEdit.from + Math.max(1, eraEdit.len) - 1,
                )
                .map((event) => event.slot);
              if (slots.length === 0) return null;
              const span = Math.max(...slots) - eraEdit.from + 1;
              if (span <= Math.max(1, eraEdit.len)) return null;
              return (
                <div className="ol-erarange__hint">
                  这段里已有卡片，最短 {span} 格（框不会把自己的事件甩到外面）
                </div>
              );
            })()}
          </div>
        )}
      </Modal>

      {/* chip 拖拽幽灵：跟手的一枚浮卡（设计稿 .fcard.dragging） */}
      {castGhost && (
        <div
          ref={castGhostRef}
          className="ol-fcard is-ghost"
          style={{ left: castGhost.x - 16, top: castGhost.y - 15 }}
        >
          <span
            className="ol-fcard__av"
            style={{ background: castGhost.color }}
          >
            {
              [
                ...(entities.find((item) => item.id === castGhost.entityId)
                  ?.name ?? "?"),
              ][0]
            }
          </span>
          <span className="ol-fcard__nm">
            {entities.find((item) => item.id === castGhost.entityId)?.name ??
              "?"}
          </span>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {zoneMenu &&
        (() => {
          const zone = zones.find((item) => item.id === zoneMenu.zoneId);
          if (!zone) return null;
          return (
            <ZoneStyleMenu
              x={zoneMenu.x}
              y={zoneMenu.y}
              zone={zone}
              onClose={() => setZoneMenu(null)}
            />
          );
        })()}
    </div>
  );
}

/** 浮卡层：cardX/cardY 有值即画浮卡 + 实线牵回宿主事件（设计稿 v9.4） */
function FloatLayer({
  casts,
  entities,
  boxes,
  onMove,
  onDropTarget,
  onDrop,
}: {
  casts: (OutlineCastDTO & { cardX: number; cardY: number })[];
  entities: OutlineEntityDTO[];
  /** 事件卡矩形（与画布渲染同源）：牵线端点、避让都按它算 */
  boxes: Map<string, Box>;
  onMove: (eventId: string, entityId: string, x: number, y: number) => void;
  /** 拖动经过事件卡：回传落点（父层据此高亮目标卡、让源 chip 淡出） */
  onDropTarget: (
    eventId: string,
    entityId: string,
    dropOn: string | null,
  ) => void;
  /** 松手落在事件卡上＝收纳；toEventId 等于宿主时父层收回卡内 */
  onDrop: (eventId: string, entityId: string, toEventId: string) => void;
}) {
  /** 拖动只改本地预览，松手一次落库（此前每帧 pointermove 都在写 IPC） */
  const [preview, setPreview] = useState<{
    key: string;
    x: number;
    y: number;
  } | null>(null);
  /** 正在拖的浮卡（设计稿 .fcard.dragging：抬起阴影 + pointer-events:none） */
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  /** 浮卡实测尺寸：宽度随名字变，牵线端点要落在胶囊轮廓上（不能用估算宽） */
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>(
    {},
  );
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  useLayoutEffect(() => {
    const measure = (): void => {
      const next: Record<string, { w: number; h: number }> = {};
      cardRefs.current.forEach((el, key) => {
        next[key] = { w: el.offsetWidth, h: el.offsetHeight };
      });
      setSizes((prev) => {
        const keys = Object.keys(next);
        const same =
          keys.length === Object.keys(prev).length &&
          keys.every(
            (key) =>
              prev[key]?.w === next[key].w && prev[key]?.h === next[key].h,
          );
        return same ? prev : next;
      });
    };
    measure();
    // hover 展开 ↩ / × 会把卡片撑宽，牵线端点要跟着重新落到轮廓上；
    // 观察不到时（jsdom）退回一次性测量，不影响逻辑。
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    cardRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // 只在浮卡集合 / 实体名变化时重建观察：拖动改的是坐标，量高会强制每帧 layout
  }, [casts.length, entities]);

  if (casts.length === 0) return null;
  const keyOf = (cast: OutlineCastDTO): string =>
    `${cast.eventId}-${cast.entityId}`;
  const posOf = (
    cast: OutlineCastDTO & { cardX: number; cardY: number },
  ): { x: number; y: number } =>
    preview && preview.key === keyOf(cast)
      ? preview
      : { x: cast.cardX, y: cast.cardY };
  const drag = (
    cast: OutlineCastDTO & { cardX: number; cardY: number },
    e: React.PointerEvent,
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = cast.cardX;
    const baseY = cast.cardY;
    let moved = false;
    let last = { x: baseX, y: baseY };
    /** 指针下方的事件卡（浮卡自身 pointer-events:none，不会挡住命中） */
    let dropOn: string | null = null;
    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const finish = (commit: boolean): void => {
      cleanup();
      setPreview(null);
      setDraggingKey(null);
      onDropTarget(cast.eventId, cast.entityId, null);
      if (!commit || !moved) return;
      if (dropOn) {
        onDrop(cast.eventId, cast.entityId, dropOn);
        return;
      }
      onMove(cast.eventId, cast.entityId, last.x, last.y);
    };
    const onMoveEvt = (move: PointerEvent): void => {
      if (move.buttons === 0) {
        finish(false);
        return;
      }
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (!moved) setDraggingKey(keyOf(cast));
      moved = true;
      last = { x: baseX + dx, y: baseY + dy };
      setPreview({ key: keyOf(cast), ...last });
      const under = document.elementFromPoint(
        move.clientX,
        move.clientY,
      ) as HTMLElement | null;
      const cardEl = under?.closest("[data-event-id]") as HTMLElement | null;
      const next = cardEl?.dataset.eventId ?? null;
      if (next !== dropOn) {
        dropOn = next;
        onDropTarget(cast.eventId, cast.entityId, dropOn);
      }
    };
    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    window.addEventListener("pointermove", onMoveEvt);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };
  const allBoxes = [...boxes.values()];
  return (
    <div className="ol-free">
      <svg className="ol-free__links" width="100%" height="100%">
        {casts.map((cast) => {
          const host = boxes.get(cast.eventId);
          if (!host) return null;
          const pos = posOf(cast);
          const size = sizes[keyOf(cast)] ?? { w: 96, h: 28 };
          const card: Box = {
            left: pos.x,
            top: pos.y,
            right: pos.x + size.w,
            bottom: pos.y + size.h,
          };
          // 牵线颜色跟主题走（--app-outline-link 四套主题各自派生），
          // 角色类型色只留在浮卡左缘的 3px 身份条上（设计稿 --fc）
          return (
            <path
              key={keyOf(cast)}
              d={freeLinkPath(
                card,
                host,
                allBoxes.filter((box) => box !== host),
                size.h / 2,
                12,
              )}
              className="ol-free__line"
            />
          );
        })}
      </svg>
      {casts.map((cast) => {
        const entity = entities.find((item) => item.id === cast.entityId);
        const pos = posOf(cast);
        const key = keyOf(cast);
        const color = entity
          ? ENTITY_TYPE_COLOR[entity.type][0]
          : "var(--app-outline-link)";
        return (
          <div
            key={key}
            ref={(el) => {
              if (el) cardRefs.current.set(key, el);
              else cardRefs.current.delete(key);
            }}
            className={`ol-fcard${draggingKey === key ? " is-dragging" : ""}`}
            style={
              { left: pos.x, top: pos.y, "--fc": color } as React.CSSProperties
            }
            title={`${entity?.name ?? "?"}｜拖到别的事件卡上＝改成那一场出场`}
            onPointerDown={(e) => drag(cast, e)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // 双击看汇总（设计稿 selectChar）：右栏切到该角色
              useOutlineStore.getState().selectEvent(cast.eventId);
              useOutlineStore.getState().selectEntity(cast.entityId);
            }}
          >
            <span className="ol-fcard__av" style={{ background: color }}>
              {[...(entity?.name ?? "?")][0]}
            </span>
            <span className="ol-fcard__nm">{entity?.name ?? "?"}</span>
            <button
              type="button"
              className="ol-fcard__btn"
              title="收回事件卡内"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onMove(cast.eventId, cast.entityId, -1, -1);
              }}
            >
              ↩
            </button>
            <button
              type="button"
              className="ol-fcard__btn is-del"
              title="移除这处出场"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void useOutlineStore
                  .getState()
                  .removeCast(cast.eventId, cast.entityId);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
