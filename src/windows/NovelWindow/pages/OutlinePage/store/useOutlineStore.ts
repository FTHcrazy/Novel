/**
 * 大纲工作台状态（outline-plan-spec v7.1 §17 B4，独立 Zustand store）
 *
 * 一功能模块一 store（AGENTS §6.2）：六表数据 + 撤销栈 + 选中态 + 拖拽会话
 * 全在这里收口——拖拽落格、era 自适应、一键整理都是「多个 effect 互相驱动」
 * 的高发区，散在组件里必然复现闭包陷阱（判据见 §6.2）。
 *
 * 撤销栈（§8.11）：深度快照、上限 50 步、满丢最旧；恢复 = 内存整体还原 +
 * `bulkSave` 单事务落库（不存在「撤销了一半」）。
 */
import { create } from "zustand";
import { message as staticMessage, Modal as staticModal } from "antd";
import type { ModalFuncProps } from "antd";
import type {
  OutlineCastDTO,
  OutlineEraDTO,
  OutlineEntityDTO,
  OutlineEventDTO,
  OutlineLaneDTO,
  OutlineProjectDTO,
  OutlineProjectListResult,
  OutlineZoneDTO,
} from "@/shared/types/electron";
import {
  compactEras,
  hitHorizontal,
  hitVertical,
  looseEvents,
  normalizeEras,
  resizeEra,
  resolveEraOverlaps,
  tidyTimeline,
  type ChainEvent,
  type DropTarget,
  type EraRange,
  type LaneBand,
} from "@/shared/novel/outline";
import {
  bulkSaveOutline,
  createOutlineDraft,
  deleteOutlineEntity,
  deleteOutlineEra,
  deleteOutlineEvent,
  deleteOutlineLane,
  deleteOutlineZone,
  fetchOutlineBundle,
  fetchOutlineProjects,
  moveOutlineCast,
  removeOutlineCast,
  renameOutlineProject,
  saveOutlineEra,
  saveOutlineEntity,
  saveOutlineEvent,
  saveOutlineLane,
  saveOutlineZone,
  setOutlineCast,
  trashOutlineProject,
  bindOutlineWork,
} from "../../NovelPage/services/outline-service";

export type OutlineMode = "axis" | "list";
export type OutlineDir = "h" | "v";

const UNDO_LIMIT = 50;

// ── 反馈桥（antd v6：静态 message/Modal 消费不了上下文主题，控制台警告）
// store 不在组件树里拿不到 App.useApp()：OutlinePage 挂载时把实例桥进来，
// 未挂载（理论不可达）时退回静态 API，保证任何路径都有反馈出口。
type OutlineFeedback = {
  message: Pick<typeof staticMessage, "success" | "error" | "warning" | "info">;
  modal: (config: ModalFuncProps) => { destroy: () => void; update: (config: ModalFuncProps) => void };
};

let outlineFeedback: OutlineFeedback | null = null;

/** OutlinePage 挂载期注入 App 实例，卸载时传 null 解绑 */
export function bindOutlineFeedback(next: OutlineFeedback | null): void {
  outlineFeedback = next;
}

function fb(): OutlineFeedback {
  if (outlineFeedback) return outlineFeedback;
  return {
    message: staticMessage,
    modal: (config) => staticModal.confirm(config),
  };
}

/**
 * 落库失败统一提示（§11.3-1）。
 *
 * 所有写路径都是「乐观更新 + 后台落库」，返回 false 表示主进程拒绝或事务
 * 失败（库被锁、磁盘满、项目已被别处删除）。此前一律忽略返回值，界面显示
 * 已保存、重启即丢。这里串行提示并做 2s 节流：一次批量操作连爆多条不刷屏，
 * 但绝不静默。
 */
let saveFailAt = 0;

function reportSaveFailure(): void {
  const now = Date.now();
  if (now - saveFailAt < 2000) return;
  saveFailAt = now;
  void fb().message.error("保存失败：改动只在当前窗口生效，请检查磁盘空间后重试");
}

/** 写路径统一出口：返回 false 即提示 */
async function commit(pending: Promise<boolean>): Promise<boolean> {
  const ok = await pending;
  if (!ok) reportSaveFailure();
  return ok;
}

/** 撤销快照：六表相关数据 + 选中态（§8.11） */
interface OutlineSnapshot {
  lanes: OutlineLaneDTO[];
  events: OutlineEventDTO[];
  entities: OutlineEntityDTO[];
  casts: OutlineCastDTO[];
  zones: OutlineZoneDTO[];
  eras: OutlineEraDTO[];
  selEventId: string | null;
}

interface DragSession {
  eventId: string;
  /** 起始位置（取消时吸回） */
  from: { laneId: string | null; slot: number };
  /** 当前命中（null = 走廊外，松手吸回；toTray = 悬在托盘上，松手转待归类） */
  target: DropTarget | null;
  /** 指针悬在待归类托盘上（FR-03：入链卡拖进托盘 = 转待归类） */
  toTray: boolean;
  /** 按下时的视口坐标：fixed 定位的拖拽 ghost 用它做初始位置（坐标系不能混用） */
  origin: { x: number; y: number };
}

interface OutlineState {
  // ── 数据 ──
  project: OutlineProjectDTO | null;
  lanes: OutlineLaneDTO[];
  events: OutlineEventDTO[];
  entities: OutlineEntityDTO[];
  casts: OutlineCastDTO[];
  zones: OutlineZoneDTO[];
  eras: OutlineEraDTO[];
  chapterRefs: Record<string, number>;
  loading: boolean;

  // ── UI 状态 ──
  mode: OutlineMode;
  dir: OutlineDir;
  query: string;
  selEventId: string | null;
  selEntityId: string | null;
  /** 「包一个区域」待选态：起点事件 id（FR-14a） */
  zoneArm: string | null;
  drag: DragSession | null;
  undoStack: OutlineSnapshot[];
  /** Enter 聚焦正文：自增即请求右栏聚焦（跨组件信号，不做全局 DOM 查询） */
  bodyFocusToken: number;

  // ── 装载与项目生命周期 ──
  load: (projectId: string) => Promise<void>;
  openDraft: (projectId?: string) => Promise<void>;
  newDraft: () => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  /** 按 id 改名：弹框打开期间切换大纲也不会写错项目 */
  renameProjectOf: (projectId: string, name: string) => Promise<void>;
  trashProject: (projectId: string) => Promise<boolean>;
  bindWork: (name: string, genre: string | null) => Promise<boolean>;

  // ── 视图状态 ──
  setMode: (mode: OutlineMode) => void;
  setDir: (dir: OutlineDir) => void;
  setQuery: (query: string) => void;
  selectEvent: (id: string | null) => void;
  selectEntity: (id: string | null) => void;
  armZone: (eventId: string | null) => void;

  // ── 泳道 ──
  addLane: () => Promise<void>;
  renameLane: (laneId: string, name: string) => Promise<void>;
  deleteLane: (laneId: string) => Promise<void>;

  // ── 事件 ──
  addEvent: (anchorId?: string | null) => Promise<void>;
  /** 在此事件后新增：插到该事件所在格的堆叠尾（设计稿右键「＋ 在此事件后新增」） */
  addEventAfter: (eventId: string) => Promise<void>;
  /** 空白右键：新建待归类事件（进托盘，绝不隐式吸附） */
  addTrayEvent: () => Promise<void>;
  patchEvent: (id: string, patch: Partial<OutlineEventDTO>) => Promise<void>;
  placeEvent: (
    id: string,
    laneId: string | null,
    slot: number,
  ) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;

  // ── 实体 / 出场 ──
  addEntity: (type: OutlineEntityDTO["type"], name: string) => Promise<void>;
  /** 实体资料编辑（名 / 别名 / 简介） */
  patchEntity: (id: string, patch: Partial<OutlineEntityDTO>) => Promise<void>;
  deleteEntity: (entityId: string) => Promise<void>;
  addCast: (eventId: string, entityId: string) => Promise<void>;
  removeCast: (eventId: string, entityId: string) => Promise<void>;
  moveCast: (
    eventId: string,
    entityId: string,
    toEventId: string,
  ) => Promise<void>;
  /** 浮卡移动（cardX/cardY）；x/y 为负 = 收回卡内（置 null） */
  setCastPosition: (
    eventId: string,
    entityId: string,
    x: number,
    y: number,
  ) => Promise<void>;

  // ── 区域 / 时代带 ──
  createZoneFromPair: (aId: string, bId: string) => Promise<void>;
  patchZone: (id: string, patch: Partial<OutlineZoneDTO>) => Promise<void>;
  deleteZone: (id: string) => Promise<void>;
  addEraNextTo: (eraId: string | null, before: boolean) => Promise<string | null>;
  /** 时间条空白右键：按点击列新增（默认 2 格，随后就地改名）；span 可指定额外跨度 */
  addEraAt: (slot: number, span?: number) => Promise<string | null>;
  patchEra: (id: string, patch: Partial<OutlineEraDTO>) => Promise<void>;
  deleteEra: (id: string) => Promise<void>;

  // ── 整理 / 撤销 / 拖拽 ──
  tidy: () => void;
  undo: () => void;
  pushUndo: () => void;
  /** Enter：请求右栏聚焦选中事件的正文 */
  focusEventBody: () => void;
  startDrag: (eventId: string, clientX: number, clientY: number) => void;
  updateDragTarget: (target: DropTarget | null) => void;
  /** 指针进/出待归类托盘（拖拽期间） */
  setDragTrayHint: (on: boolean) => void;
  finishDrag: (commit: boolean) => Promise<void>;
  /** 命中判定（与高亮同源：组件的高亮 overlay 也调这里）。
   *  横向的行高随同槽堆叠深度变化，因此传入渲染层算好的行带而不是统一行距。 */
  hitTest: (
    x: number,
    y: number,
    slotsTop: number,
    bands: readonly LaneBand[],
    rowPitch?: number,
  ) => DropTarget | null;
}

/** 事件 → 纯位置视图（算法层输入） */
const asChain = (event: OutlineEventDTO): ChainEvent => ({
  id: event.id,
  laneId: event.laneId,
  slot: event.slot,
  sort: event.sort,
  breakBefore: event.breakBefore,
});

const asEraRange = (era: OutlineEraDTO): EraRange => ({
  id: era.id,
  name: era.name,
  fromSlot: era.fromSlot,
  toSlot: era.toSlot,
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 槽位变更路径统一收口：era 自适应（守卫 7/8） */
function adaptEras(
  events: OutlineEventDTO[],
  eras: OutlineEraDTO[],
): OutlineEraDTO[] {
  const normalized = normalizeEras(eras.map(asEraRange), events.map(asChain));
  // 归一化按 id 保序输出；写回 DTO
  return eras.map((era) => {
    const next = normalized.find((item) => item.id === era.id);
    return next
      ? { ...era, fromSlot: next.fromSlot, toSlot: next.toSlot }
      : era;
  });
}

/** 纯区间结果（EraRange）合并回渲染层 DTO：保住 note / colorSlot / sort */
function mergeEraRanges(
  original: readonly OutlineEraDTO[],
  ranges: readonly EraRange[],
): OutlineEraDTO[] {
  const byId = new Map(original.map((era) => [era.id, era]));
  return ranges.map((range) => {
    const base = byId.get(range.id);
    return base
      ? { ...base, fromSlot: range.fromSlot, toSlot: range.toSlot }
      : {
          id: range.id,
          name: range.name,
          note: "",
          colorSlot: "",
          sort: 0,
          fromSlot: range.fromSlot,
          toSlot: range.toSlot,
        };
  });
}

/** 空画布占位段（FR-15a）：UI 态不落库；改名 / 新增段后「转正」 */
export const PLACEHOLDER_ERA_ID = "__placeholder__";

function ensurePlaceholderEra(eras: OutlineEraDTO[]): OutlineEraDTO[] {
  if (eras.length > 0) return eras;
  return [
    {
      id: PLACEHOLDER_ERA_ID,
      name: "",
      note: "",
      colorSlot: "",
      fromSlot: 0,
      toSlot: 2,
      sort: 0,
    },
  ];
}

/**
 * 装载代次：显式切换大纲时旧请求可能还在飞，迟到的旧结果不得覆盖新选中的
 * 项目与它刚编辑过的选中态。每次 load 领一个号，只有最新号能写状态。
 */
let outlineLoadSeq = 0;

export const useOutlineStore = create<OutlineState>((set, get) => ({
  project: null,
  lanes: [],
  events: [],
  entities: [],
  casts: [],
  zones: [],
  eras: [],
  chapterRefs: {},
  loading: false,

  mode: "axis",
  dir: "h",
  query: "",
  selEventId: null,
  selEntityId: null,
  zoneArm: null,
  drag: null,
  undoStack: [],
  bodyFocusToken: 0,

  load: async (projectId) => {
    const seq = ++outlineLoadSeq;
    set({ loading: true });
    try {
      const bundle = await fetchOutlineBundle(projectId);
      if (seq !== outlineLoadSeq) return; // 过期结果：用户已经切到别的大纲
      if (!bundle) {
        set({ loading: false, project: null });
        return;
      }
      set({
        loading: false,
        project: bundle.project,
        lanes: bundle.lanes,
        events: bundle.events,
        entities: bundle.entities,
        casts: bundle.casts,
        zones: bundle.zones,
        eras: ensurePlaceholderEra(bundle.eras),
        chapterRefs: bundle.chapterRefs,
        selEventId: null,
        selEntityId: null,
        zoneArm: null,
        drag: null,
        undoStack: [],
      });
    } catch (error) {
      if (seq !== outlineLoadSeq) return; // 过期请求的失败不该弹 toast
      // 错误必须透出：吞掉它排查就只能靠猜（曾经为此空转过一轮）
      console.error("[outline] 大纲装载失败", error);
      set({ loading: false });
      void fb().message.error("大纲装载失败，请稍后重试");
    }
  },

  /** 打开草稿（大纲先行）：无参 = 最近编辑的草稿，没有就现场建一份（§7.1）。
   *  有参 = 目标 id，**projectId 或 workId 均可**：书卡角标 / 编辑器快捷键
   *  传的是 workId，早期只按 project.id 匹配，导致作品大纲永远打不开、还会
   *  凭空多出一份草稿（评审 P0-1）。
   *  并发去重：挂载 effect / 工具条切换器可能在极短时间内重复调进来；不去重
   *  就会各自 projectList + createOutlineDraft —— 一次进入凭空造出两个草稿
   *  （库里曾出现两条相差 2ms 的记录），迟到的 load 还会重置用户刚点的选中态。
   *  按目标 key 合并：同一目标的并发调用复用在途 Promise，带显式 id 的切换
   *  是不同 key，照常发起，不会被吞掉。 */
  openDraft: (() => {
    let inflight: Promise<void> | null = null;
    let inflightKey = "";
    const impl = async (projectId?: string): Promise<void> => {
      let list: OutlineProjectListResult;
      try {
        list = await fetchOutlineProjects();
      } catch (error) {
        console.error("[outline] 大纲列表读取失败", error);
        void fb().message.error("大纲列表读取失败，请稍后重试");
        return;
      }
      const pool = [...list.drafts, ...list.works];
      // workId 与 projectId 都可能是入口传入的目标：两种键都试
      const explicit = projectId
        ? pool.find((item) => item.id === projectId || item.workId === projectId)
        : undefined;
      if (projectId && !explicit) {
        // 目标还存在但还没建大纲（或已被删除）：明确告知，再落到最近草稿
        void fb().message.warning("没有找到这个目标的大纲，已打开最近的草稿");
      }
      const target = explicit ?? list.drafts[0] ?? null;
      if (target) {
        await get().load(target.id);
        return;
      }
      const created = await createOutlineDraft("");
      if (created) await get().load(created.id);
    };
    return (projectId?: string): Promise<void> => {
      const key = projectId ?? "*";
      // 无参默认打开与同目标的并发请求合并；带显式 id 的切换是
      // 另一个意图，必须真正发起（旧请求的结果由 outlineLoadSeq 拦掉）。
      if (inflight && key === inflightKey) return inflight;
      const run = impl(projectId).finally(() => {
        if (inflight === run) {
          inflight = null;
          inflightKey = "";
        }
      });
      inflight = run;
      inflightKey = key;
      return run;
    };
  })(),

  newDraft: async () => {
    const created = await createOutlineDraft("");
    if (created) {
      await get().load(created.id);
      void fb().message.success("已新建大纲草稿 · 随时从左上角切换器切回");
    } else {
      void fb().message.error("新建草稿失败，请稍后重试");
    }
  },

  renameProject: async (name) => {
    const project = get().project;
    if (!project) return;
    await get().renameProjectOf(project.id, name);
  },

  renameProjectOf: async (projectId, name) => {
    const trimmed = name.trim();
    if (!projectId || !trimmed) return;
    if (await commit(renameOutlineProject(projectId, trimmed))) {
      const current = get().project;
      if (current?.id === projectId) set({ project: { ...current, name: trimmed } });
    }
  },

  /** 软删除（回收站，30 天可恢复）；返回是否成功（组件据而切走） */
  trashProject: async (projectId) => {
    const ok = await trashOutlineProject(projectId);
    if (ok) void fb().message.success("已移入回收站，30 天内可恢复");
    return ok;
  },

  bindWork: async (name, genre) => {
    const project = get().project;
    if (!project) return false;
    const workId = await bindOutlineWork(project.id, name, genre);
    if (!workId) {
      void fb().message.error("创建作品失败：该书可能已绑定过其他大纲");
      return false;
    }
    set({ project: { ...project, workId } });
    void fb().message.success(`已创建《${name}》并绑定此大纲`);
    return true;
  },

  setMode: (mode) => set({ mode }),
  setDir: (dir) => set({ dir }),
  setQuery: (query) => set({ query }),
  selectEvent: (id) => set({ selEventId: id, selEntityId: null }),
  selectEntity: (id) => set({ selEntityId: id }),
  armZone: (eventId) => set({ zoneArm: eventId }),

  addLane: async () => {
    const project = get().project;
    if (!project) return;
    if (get().lanes.length >= 12) {
      void fb().message.warning("泳道已达上限（12 条）");
      return;
    }
    get().pushUndo();
    const lane: OutlineLaneDTO = {
      id: `ol-l-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: "",
      note: "",
      sort: get().lanes.length,
    };
    set({ lanes: [...get().lanes, lane] });
    await commit(saveOutlineLane({ ...lane, projectId: project.id }));
  },

  renameLane: async (laneId, name) => {
    const lane = get().lanes.find((item) => item.id === laneId);
    if (!lane) return;
    get().pushUndo();
    const next = { ...lane, name: name.trim().slice(0, 20) };
    set({
      lanes: get().lanes.map((item) => (item.id === laneId ? next : item)),
    });
    await commit(saveOutlineLane({ ...next, projectId: get().project?.id ?? "" }));
  },

  /** 删线：事件转待归类（槽号保留）+ 浮卡收回 + 线上 zone 随删 + era 收包（FR-13）
   *  §8.7 写「era 不受影响」，指的是不随线删除而消失/移位；成员被移出时间线后
   *  区间仍应按剩余成员收缩——否则守卫 7「槽位变更即自适应」在删线路径上失效。 */
  deleteLane: async (laneId) => {
    const state = get();
    const lane = state.lanes.find((item) => item.id === laneId);
    if (!lane || state.lanes.length <= 1) {
      if (state.lanes.length <= 1) void fb().message.warning("至少保留一条时间线");
      return;
    }
    const movedIds = new Set(
      state.events.filter((event) => event.laneId === laneId).map((event) => event.id),
    );
    const count = movedIds.size;
    get().pushUndo();
    const events = state.events.map((event) =>
      event.laneId === laneId ? { ...event, laneId: null } : event,
    );
    const eras = adaptEras(events, state.eras);
    set({
      lanes: state.lanes.filter((item) => item.id !== laneId),
      events,
      // 浮卡宿主不在格里了：内存侧一并收回（守卫 11；DB 侧 lane-delete 已做）
      casts: state.casts.map((cast) =>
        movedIds.has(cast.eventId) && (cast.cardX !== null || cast.cardY !== null)
          ? { ...cast, cardX: null, cardY: null }
          : cast,
      ),
      zones: state.zones.filter((zone) => zone.laneId !== laneId),
      eras,
    });
    await commit(deleteOutlineLane(laneId));
    const projectId = state.project?.id;
    if (projectId) {
      for (const era of eras) {
        const before = state.eras.find((item) => item.id === era.id);
        if (
          before &&
          era.id !== PLACEHOLDER_ERA_ID &&
          (before.fromSlot !== era.fromSlot || before.toSlot !== era.toSlot)
        ) {
          await commit(saveOutlineEra({ ...era, projectId }));
        }
      }
    }
    void fb().message.success(
      `已删除「${lane.name || "未命名时间线"}」· ${count} 个事件转入待归类`,
    );
  },

  /** 新建事件（FR-02 / §8.7）：追加到当前泳道链尾并选中。
   *  锚点 = 选中事件 → 该线末槽 + 1；无选中 → 第一条线的末槽 + 1；
   *  一条线都没有 → 待归类托盘（没有「当前泳道」可追加）。 */
  addEvent: async (anchorId) => {
    const state = get();
    if (!state.project) return;
    get().pushUndo();
    const selected = anchorId
      ? state.events.find((event) => event.id === anchorId)
      : state.selEventId
        ? state.events.find((event) => event.id === state.selEventId)
        : null;
    const laneId =
      selected?.laneId ?? (state.lanes.length > 0
        ? [...state.lanes].sort((a, b) => a.sort - b.sort)[0].id
        : null);
    const laneEvents = laneId
      ? state.events.filter((event) => event.laneId === laneId)
      : [];
    const slot = laneEvents.length
      ? Math.max(...laneEvents.map((event) => event.slot)) + 1
      : 0;
    const event: OutlineEventDTO = {
      id: `ol-e-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      laneId,
      slot,
      sort: 0,
      breakBefore: false,
      title: "",
      body: "",
      whenText: "",
      starred: false,
    };
    // 新开一槽，槽位变更同样触发 era 自适应（守卫 7）
    const events = [...state.events, event];
    set({
      events,
      eras: adaptEras(events, state.eras),
      selEventId: event.id,
      zoneArm: null,
    });
    await commit(saveOutlineEvent({ ...event, projectId: state.project.id }));
  },

  /** 在此事件后新增（设计稿右键「＋ 在此事件后新增」）：不改整条链的顺序，
   *  只插到该事件所在格的堆叠尾——同槽 sort 取 max+1，视觉上落在它后面。 */
  addEventAfter: async (eventId) => {
    const state = get();
    const anchor = state.events.find((item) => item.id === eventId);
    if (!anchor || !state.project) return;
    get().pushUndo();
    const siblings = state.events.filter(
      (item) => item.id !== anchor.id && item.laneId === anchor.laneId && item.slot === anchor.slot,
    );
    const sort = siblings.length
      ? Math.max(...siblings.map((item) => item.sort)) + 1
      : anchor.sort + 1;
    const event: OutlineEventDTO = {
      id: `ol-e-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      laneId: anchor.laneId,
      slot: anchor.slot,
      sort,
      breakBefore: false,
      title: "",
      body: "",
      whenText: "",
      starred: false,
    };
    const events = [...state.events, event];
    set({
      events,
      eras: adaptEras(events, state.eras),
      selEventId: event.id,
      zoneArm: null,
    });
    await commit(saveOutlineEvent({ ...event, projectId: state.project.id }));
    void fb().message.success("已新建一段（插入同格堆叠尾）· 在右栏改标题");
  },

  /** 空白右键新增：lane=null 直接进待归类托盘（v7.0：绝不隐式吸附到格子） */
  addTrayEvent: async () => {
    const state = get();
    if (!state.project) return;
    get().pushUndo();
    const loose = state.events.filter((item) => item.laneId === null);
    const sort = loose.length ? Math.max(...loose.map((item) => item.sort)) + 1 : 0;
    const event: OutlineEventDTO = {
      id: `ol-e-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      laneId: null,
      slot: 0,
      sort,
      breakBefore: false,
      title: "",
      body: "",
      whenText: "",
      starred: false,
    };
    set({ events: [...state.events, event], selEventId: event.id, zoneArm: null });
    await commit(saveOutlineEvent({ ...event, projectId: state.project.id }));
    void fb().message.success("已创建待归类事件 · 拖到画布时间格松手即可入链");
  },

  patchEvent: async (id, patch) => {
    const state = get();
    const event = state.events.find((item) => item.id === id);
    if (!event || !state.project) return;
    get().pushUndo();
    const next = { ...event, ...patch };
    const events = state.events.map((item) => (item.id === id ? next : item));
    set({ events });
    await commit(saveOutlineEvent({ ...next, projectId: state.project.id }));
  },

  /** 落格（FR-03）：写 lane_id + slot；转待归类时浮卡收回（守卫 11） */
  placeEvent: async (id, laneId, slot) => {
    const state = get();
    const event = state.events.find((item) => item.id === id);
    if (!event || !state.project) return;
    if (event.laneId === laneId && event.slot === slot) return; // 落回原格零写入
    get().pushUndo();
    // 同槽堆叠：落在已占格时排到该格现有卡之后（否则 sort 相撞，顺序随机）
    const siblings = state.events.filter(
      (item) => item.id !== id && item.laneId === laneId && item.slot === slot,
    );
    const sort = siblings.length
      ? Math.max(...siblings.map((item) => item.sort)) + 1
      : 0;
    const next: OutlineEventDTO = { ...event, laneId, slot, sort };
    const events = state.events.map((item) => (item.id === id ? next : item));
    // 所有槽位变更路径都触发 era 自适应（守卫 7）
    const eras = adaptEras(events, state.eras);
    const casts =
      laneId === null
        ? state.casts.map((cast) =>
            cast.eventId === id ? { ...cast, cardX: null, cardY: null } : cast,
          )
        : state.casts;
    set({ events, eras, casts });
    await commit(saveOutlineEvent({ ...next, projectId: state.project.id }));
    for (const era of eras) {
      const before = state.eras.find((item) => item.id === era.id);
      if (
        !before ||
        before.fromSlot !== era.fromSlot ||
        before.toSlot !== era.toSlot
      ) {
        if (era.id !== PLACEHOLDER_ERA_ID) {
          await commit(saveOutlineEra({ ...era, projectId: state.project.id }));
        }
      }
    }
  },

  /** 删事件：级联删出场 + 清章节引用（主进程事务）+ era 收缩（FR-02） */
  deleteEvent: async (id) => {
    const state = get();
    if (!state.project) return;
    const removed = state.events.find((item) => item.id === id);
    get().pushUndo();
    const events = state.events.filter((item) => item.id !== id);
    const eras = adaptEras(events, state.eras);
    set({
      events,
      eras,
      casts: state.casts.filter((cast) => cast.eventId !== id),
      selEventId: state.selEventId === id ? null : state.selEventId,
    });
    await commit(deleteOutlineEvent(id));
    for (const era of eras) {
      const before = state.eras.find((item) => item.id === era.id);
      if (
        !before ||
        before.fromSlot !== era.fromSlot ||
        before.toSlot !== era.toSlot
      ) {
        if (era.id !== PLACEHOLDER_ERA_ID) {
          await commit(saveOutlineEra({ ...era, projectId: state.project.id }));
        }
      }
    }
    void fb().message.success(
      `已删除「${removed?.title || "未命名事件"}」· Ctrl+Z 可撤销`,
    );
  },

  addEntity: async (type, name) => {
    const project = get().project;
    if (!project || !name.trim()) return;
    const entity: OutlineEntityDTO = {
      id: `ol-n-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type,
      name: name.trim().slice(0, 40),
      aliases: "",
      body: "",
      colorSlot: "",
    };
    set({ entities: [...get().entities, entity] });
    await commit(saveOutlineEntity({ ...entity, projectId: project.id }));
  },

  /** 实体资料编辑（角色页做的别名 / 简介，工作台汇总卡可直接补） */
  patchEntity: async (id, patch) => {
    const state = get();
    const entity = state.entities.find((item) => item.id === id);
    if (!entity || !state.project) return;
    get().pushUndo();
    const next: OutlineEntityDTO = {
      ...entity,
      ...patch,
      name: (patch.name ?? entity.name).trim().slice(0, 40),
      aliases: (patch.aliases ?? entity.aliases).slice(0, 200),
      body: (patch.body ?? entity.body).slice(0, 2000),
    };
    set({
      entities: state.entities.map((item) => (item.id === id ? next : item)),
    });
    await commit(saveOutlineEntity({ ...next, projectId: state.project.id }));
  },

  /** 删实体：级联清出场 chip（主进程事务） */
  deleteEntity: async (entityId) => {
    const state = get();
    const entity = state.entities.find((item) => item.id === entityId);
    if (!entity) return;
    get().pushUndo();
    set({
      entities: state.entities.filter((item) => item.id !== entityId),
      casts: state.casts.filter((cast) => cast.entityId !== entityId),
      selEntityId: state.selEntityId === entityId ? null : state.selEntityId,
    });
    await commit(deleteOutlineEntity(entityId));
    void fb().message.success(`已删除「${entity.name}」及其出场记录`);
  },

  /** 添加出场：同一事件同一实体一枚 chip（FR-05，服务端幂等兜底） */
  addCast: async (eventId, entityId) => {
    const state = get();
    if (
      state.casts.some(
        (cast) => cast.eventId === eventId && cast.entityId === entityId,
      )
    ) {
      void fb().message.warning("这个事件里已经有一张了");
      return;
    }
    get().pushUndo();
    const sort = state.casts.filter((cast) => cast.eventId === eventId).length;
    const cast: OutlineCastDTO = {
      eventId,
      entityId,
      roleLabel: "",
      sort,
      cardX: null,
      cardY: null,
    };
    set({ casts: [...state.casts, cast] });
    await commit(setOutlineCast(cast));
  },

  /** 移除出场：只影响本处，提示其他处数量（FR-08） */
  removeCast: async (eventId, entityId) => {
    const state = get();
    get().pushUndo();
    set({
      casts: state.casts.filter(
        (cast) => cast.eventId !== eventId || cast.entityId !== entityId,
      ),
    });
    await commit(removeOutlineCast(eventId, entityId));
    const elsewhere = state.casts.filter(
      (cast) => cast.entityId === entityId && cast.eventId !== eventId,
    ).length;
    const name =
      state.entities.find((entity) => entity.id === entityId)?.name ?? "";
    void fb().message.success(
      `已移除「${name}」在这处出场` +
        (elsewhere > 0 ? ` · 它还在其他 ${elsewhere} 个事件里` : ""),
    );
  },

  /** 改挂（FR-23）：目标已有同实体 chip → 拦截（服务端同样拒绝） */
  moveCast: async (eventId, entityId, toEventId) => {
    if (eventId === toEventId) return;
    if (!get().events.some((event) => event.id === toEventId)) return;
    const ok = await moveOutlineCast(eventId, entityId, toEventId);
    if (!ok) {
      void fb().message.warning("这个事件里已经有一张了");
      return;
    }
    get().pushUndo();
    const state = get();
    const source = castOf(state.casts, eventId, entityId);
    set({
      casts: state.casts
        .filter(
          (cast) => !(cast.eventId === eventId && cast.entityId === entityId),
        )
        .concat({ ...source, eventId: toEventId, cardX: null, cardY: null }),
    });
    void fb().message.success(
      `已把「${entityName(state.entities, entityId)}」收进「${
        get().events.find((event) => event.id === toEventId)?.title || "未命名事件"
      }」`,
    );
  },

  /** 浮卡位置：拖动只更新坐标（视觉态，不进撤销栈）；负坐标 = 收回卡内 */
  setCastPosition: async (eventId, entityId, x, y) => {
    const state = get();
    const cast = state.casts.find(
      (item) => item.eventId === eventId && item.entityId === entityId,
    );
    if (!cast) return;
    const recall = x < 0 || y < 0;
    const next: OutlineCastDTO = {
      ...cast,
      cardX: recall ? null : x,
      cardY: recall ? null : y,
    };
    set({
      casts: state.casts.map((item) =>
        item.eventId === eventId && item.entityId === entityId ? next : item,
      ),
    });
    await commit(setOutlineCast(next));
  },

  /** 「包一个区域」（FR-14a）：两步选点成区，跨线拦截 */
  createZoneFromPair: async (aId, bId) => {
    const state = get();
    const a = state.events.find((event) => event.id === aId);
    const b = state.events.find((event) => event.id === bId);
    if (!a || !b || !a.laneId || !b.laneId || a.laneId !== b.laneId) {
      void fb().message.warning("两个事件必须在同一条线的时间格上");
      return;
    }
    const project = state.project;
    if (!project) return;
    const from = Math.min(a.slot, b.slot);
    const to = Math.max(a.slot, b.slot);
    const zone: OutlineZoneDTO = {
      id: `ol-z-${Date.now()}`,
      laneId: a.laneId,
      name: "",
      note: "",
      colorSlot: "teal",
      shape: "brace",
      solid: false,
      filled: false,
      fromSlot: from,
      toSlot: to,
      sort: state.zones.length,
    };
    get().pushUndo();
    set({ zones: [...state.zones, zone], zoneArm: null });
    await commit(saveOutlineZone({ ...zone, projectId: project.id }));
    void fb().message.success(`已框住第 ${from + 1}-${to + 1} 格 · 双击标签改名`);
  },

  patchZone: async (id, patch) => {
    const state = get();
    const zone = state.zones.find((item) => item.id === id);
    if (!zone || !state.project) return;
    get().pushUndo();
    const next = { ...zone, ...patch };
    set({ zones: state.zones.map((item) => (item.id === id ? next : item)) });
    await commit(saveOutlineZone({ ...next, projectId: state.project.id }));
  },

  deleteZone: async (id) => {
    const zone = get().zones.find((item) => item.id === id);
    get().pushUndo();
    set({ zones: get().zones.filter((item) => item.id !== id) });
    await commit(deleteOutlineZone(id));
    void fb().message.success(
      `已删除区域「${zone?.name || "未命名区域"}」· 事件与角色都不受影响`,
    );
  },

  /** 时代带：前方 / 后方新增（默认 1 格紧贴，自动进改名，FR-15b）。
   *  锚点为 0 或占位段时不能直接取 from-1/0 —— 新段会与邻段重叠落库，
   *  这里统一跑一遍让位 + 收拢再写回。 */
  addEraNextTo: async (eraId, before) => {
    const state = get();
    if (!state.project) return null;
    const eras = state.eras.filter((era) => era.id !== PLACEHOLDER_ERA_ID);
    const anchor = eras.find((era) => era.id === eraId);
    const from = anchor
      ? before
        ? anchor.fromSlot - 1
        : anchor.toSlot + 1
      : 0;
    // 相邻新增默认 1 格（设计稿 addEraAdjacent）：就地改名 / 拖边拉伸由用户决定跨度
    return get().addEraAt(from, 0);
  },

  /** 新增时间段（默认 2 格＝span 1）并写回：让位 → 成员 bbox → 空洞收拢。
   *  返回新段 id，调用方据此立即进入就地改名（设计稿 inlineEraName）。 */
  addEraAt: async (slot, span = 1) => {
    const state = get();
    if (!state.project) return null;
    const eras = state.eras.filter((era) => era.id !== PLACEHOLDER_ERA_ID);
    const from = Math.max(0, Math.floor(slot));
    const to = Math.max(from, from + Math.max(0, Math.floor(span)));
    const era: OutlineEraDTO = {
      id: `ol-era-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: "",
      note: "",
      colorSlot: "",
      fromSlot: from,
      toSlot: to,
      sort: eras.length,
    };
    get().pushUndo();
    const withNew = [...eras, era];
    const placed = resolveEraOverlaps(withNew, era.id, from, to);
    const resolved = adaptEras(state.events, mergeEraRanges(withNew, placed.eras));
    set({ eras: ensurePlaceholderEra(resolved) });
    const saved = resolved.find((item) => item.id === era.id) ?? era;
    await commit(saveOutlineEra({ ...saved, projectId: state.project.id }));
    for (const item of resolved) {
      if (item.id === era.id) continue;
      const beforeState = eras.find((prev) => prev.id === item.id);
      if (
        beforeState &&
        (beforeState.fromSlot !== item.fromSlot || beforeState.toSlot !== item.toSlot)
      ) {
        await commit(saveOutlineEra({ ...item, projectId: state.project.id }));
      }
    }
    void fb().message.success(
      `已新增时间段（第 ${saved.fromSlot + 1}-${saved.toSlot + 1} 格）· 双击名称就地改名`,
    );
    return era.id;
  },

  patchEra: async (id, patch) => {
    const state = get();
    const era = state.eras.find((item) => item.id === id);
    if (!era || !state.project) return;
    const next = { ...era, ...patch };
    // 非法区间直接拒绝：先校验再拍快照，避免撤销栈里塞一条空操作
    if (next.toSlot < next.fromSlot) return;
    get().pushUndo();
    const projectId = state.project.id;
    // 占位段「转正」：任何改名 / 改范围都让它变成普通段（落库）
    if (id === PLACEHOLDER_ERA_ID) {
      const real: OutlineEraDTO = { ...next, id: `ol-era-${Date.now()}` };
      const eras = ensurePlaceholderEra(
        adaptEras(
          state.events,
          state.eras.filter((item) => item.id !== PLACEHOLDER_ERA_ID).concat(real),
        ),
      );
      set({ eras });
      await commit(saveOutlineEra({ ...real, projectId }));
      return;
    }
    // 手动改长度：编辑段新范围生效 → 邻段保跨度让位 → 空洞收拢；
    // 段被推动时它的卡 / 区域框一起走（只挪框不挪卡会读成「事件跑进别的时间段」）
    const realEras = state.eras.filter((item) => item.id !== PLACEHOLDER_ERA_ID);
    const resized = resizeEra(
      realEras.map(asEraRange),
      state.events.map(asChain),
      state.zones.map((zone) => ({
        id: zone.id,
        fromSlot: zone.fromSlot,
        toSlot: zone.toSlot,
      })),
      id,
      next.fromSlot,
      next.toSlot,
    );
    const eras = ensurePlaceholderEra(mergeEraRanges(realEras, resized.eras));
    const events = state.events.map((event) => {
      const slot = resized.moves.get(event.id);
      return slot === undefined ? event : { ...event, slot };
    });
    const zones = state.zones.map((zone) => {
      const shift = resized.zoneShifts.get(zone.id);
      return shift ? { ...zone, ...shift } : zone;
    });
    set({ eras, events, zones });
    for (const item of eras) {
      if (item.id === PLACEHOLDER_ERA_ID) continue;
      const before = state.eras.find((prev) => prev.id === item.id);
      if (
        !before ||
        before.fromSlot !== item.fromSlot ||
        before.toSlot !== item.toSlot
      ) {
        await commit(saveOutlineEra({ ...item, projectId }));
      }
    }
    for (const event of events) {
      if (resized.moves.has(event.id)) {
        await commit(saveOutlineEvent({ ...event, projectId }));
      }
    }
    for (const zone of zones) {
      if (resized.zoneShifts.has(zone.id)) {
        await commit(saveOutlineZone({ ...zone, projectId }));
      }
    }
    if (resized.clamped) void fb().message.info("已顶到最左格");
    else if (resized.expanded) {
      void fb().message.info("长度已覆盖本段时间段内的全部事件");
    }
  },

  deleteEra: async (id) => {
    if (id === PLACEHOLDER_ERA_ID) return; // 占位段不可删（§8.5）
    const era = get().eras.find((item) => item.id === id);
    get().pushUndo();
    set({
      eras: ensurePlaceholderEra(get().eras.filter((item) => item.id !== id)),
    });
    await commit(deleteOutlineEra(id));
    // 渲染层 compactedEras 会把空洞收拢：相邻段贴过来，事件槽号不变
    void fb().message.success(
      `已删除时间段「${era?.name || "未命名时间段"}」· 事件不受影响，相邻段已收拢`,
    );
  },

  /** 一键整理（FR-24）：链序展开 + zone/era 成员重映射 + 浮卡收回。
   *  真相只有一份：`shared/novel/outline/tidy.ts`（此前 store 里另有一套只改
   *  slot 的循环，区域框不跟随、浮卡不收回，且快照拍在原地修改之后导致撤销
   *  无效）。这里只负责「应用 + 落库」，且**先拍快照再产生新数组**。 */
  tidy: () => {
    const state = get();
    if (!state.project) return;
    const realEras = state.eras.filter((era) => era.id !== PLACEHOLDER_ERA_ID);
    const result = tidyTimeline(
      state.events.map(asChain),
      state.lanes.map((lane) => lane.id),
      state.zones.map((zone) => ({
        id: zone.id,
        laneId: zone.laneId,
        fromSlot: zone.fromSlot,
        toSlot: zone.toSlot,
      })),
      realEras.map(asEraRange),
    );
    const hasFloats = state.casts.some(
      (cast) => cast.cardX !== null || cast.cardY !== null,
    );
    if (
      result.moves.size === 0 &&
      result.zoneRemaps.size === 0 &&
      result.eraRemaps.size === 0 &&
      !hasFloats
    ) {
      void fb().message.success("已整理：各线事件都在连续时间格上，画布上没有浮卡");
      return;
    }
    // 快照必须在任何状态变更之前拍
    get().pushUndo();
    const events = state.events.map((event) => {
      const slot = result.moves.get(event.id);
      return slot === undefined ? event : { ...event, slot };
    });
    const zones = state.zones.map((zone) => {
      const range = result.zoneRemaps.get(zone.id);
      return range ? { ...zone, ...range } : zone;
    });
    const remapped = realEras.map((era) => {
      const range = result.eraRemaps.get(era.id);
      return range ? { ...era, ...range } : era;
    });
    // 重映射后仍要让位 / 收拢（区段可能因 bbox 变化互相顶到）
    const eras = adaptEras(events, remapped);
    // FR-24 ②：浮卡统一收回卡内（整理是定稿动作）
    const casts = state.casts.map((cast) =>
      cast.cardX === null && cast.cardY === null
        ? cast
        : { ...cast, cardX: null, cardY: null },
    );
    set({ events, zones, eras: ensurePlaceholderEra(eras), casts });
    void commit(
      bulkSaveOutline(state.project.id, {
        lanes: state.lanes,
        events,
        entities: state.entities,
        casts,
        zones,
        eras,
      }),
    );
    void fb().message.success("已整理：堆叠展开成连续时间格，区域与时间线自动跟随，浮卡已收回");
  },

  pushUndo: () => {
    const state = get();
    const snapshot: OutlineSnapshot = {
      lanes: clone(state.lanes),
      events: clone(state.events),
      entities: clone(state.entities),
      casts: clone(state.casts),
      zones: clone(state.zones),
      eras: clone(state.eras),
      selEventId: state.selEventId,
    };
    const stack = [...state.undoStack, snapshot];
    if (stack.length > UNDO_LIMIT) stack.shift();
    set({ undoStack: stack });
  },

  /** Ctrl+Z（FR-26）：整体还原 + bulkSave 单事务落库 */
  undo: () => {
    const state = get();
    const stack = [...state.undoStack];
    const snapshot = stack.pop();
    if (!snapshot) {
      void fb().message.info("没有可撤销的操作");
      return;
    }
    set({
      undoStack: stack,
      lanes: snapshot.lanes,
      events: snapshot.events,
      entities: snapshot.entities,
      casts: snapshot.casts,
      zones: snapshot.zones,
      eras: snapshot.eras,
      selEventId: snapshot.selEventId,
    });
    if (state.project) {
      void commit(
        bulkSaveOutline(state.project.id, {
          lanes: snapshot.lanes,
          events: snapshot.events,
          entities: snapshot.entities,
          casts: snapshot.casts,
          zones: snapshot.zones,
          eras: snapshot.eras.filter((era) => era.id !== PLACEHOLDER_ERA_ID),
        }),
      );
    }
    void fb().message.success("已撤销（Ctrl+Z 可继续回退）");
  },

  focusEventBody: () => set({ bodyFocusToken: get().bodyFocusToken + 1 }),

  startDrag: (eventId, clientX, clientY) => {
    const event = get().events.find((item) => item.id === eventId);
    if (!event) return;
    set({
      drag: {
        eventId,
        from: { laneId: event.laneId, slot: event.slot },
        target: null,
        toTray: false,
        origin: { x: clientX, y: clientY },
      },
    });
  },

  updateDragTarget: (target) => {
    const drag = get().drag;
    if (!drag) return;
    set({ drag: { ...drag, target, toTray: false } });
  },

  setDragTrayHint: (on) => {
    const drag = get().drag;
    if (!drag) return;
    set({ drag: { ...drag, toTray: on, target: null } });
  },

  finishDrag: async (commit) => {
    const drag = get().drag;
    set({ drag: null });
    if (!drag || !commit) return;
    // 拖进托盘松手 = 转待归类（槽号保留，浮卡收回）
    if (drag.toTray) {
      if (drag.from.laneId === null) return; // 本就是待归类：吸回原位零写入
      await get().placeEvent(drag.eventId, null, drag.from.slot);
      void fb().message.success("已转入待归类 · 拖回时间格即可重新入链");
      return;
    }
    if (!drag.target) return;
    await get().placeEvent(drag.eventId, drag.target.laneId, drag.target.slot);
    if (drag.target.laneId !== drag.from.laneId) {
      const laneName =
        get().lanes.find((lane) => lane.id === drag.target?.laneId)?.name ?? "";
      void fb().message.success(
        `已移入「${laneName || "未命名时间线"}」第 ${drag.target.slot + 1} 格`,
      );
    } else {
      void fb().message.success(`已吸附到第 ${drag.target.slot + 1} 格`);
    }
  },

  hitTest: (x, y, slotsTop, bands, rowPitch) => {
    const state = get();
    // 渲染顺序 = sort 升序；命中必须用同一顺序，否则 lanes 数组乱序时落错行
    const laneIds = [...state.lanes]
      .sort((a, b) => a.sort - b.sort)
      .map((lane) => lane.id);
    if (laneIds.length === 0) return null;
    return state.dir === "h"
      ? hitHorizontal(x, y, laneIds, bands)
      : hitVertical(x, y, laneIds, slotsTop, rowPitch);
  },
}));

function entityName(entities: OutlineEntityDTO[], entityId: string): string {
  return entities.find((entity) => entity.id === entityId)?.name ?? "出场";
}

function castOf(
  casts: OutlineCastDTO[],
  eventId: string,
  entityId: string,
): OutlineCastDTO {  const found = casts.find(
    (cast) => cast.eventId === eventId && cast.entityId === entityId,
  );
  return (
    found ?? {
      eventId,
      entityId,
      roleLabel: "",
      sort: 0,
      cardX: null,
      cardY: null,
    }
  );
}

/** 测试隔离用 */
export function resetOutlineStore(): void {
  outlineLoadSeq += 1; // 作废在途装载，避免上一个用例的迟到结果污染本用例
  useOutlineStore.setState({
    project: null,
    lanes: [],
    events: [],
    entities: [],
    casts: [],
    zones: [],
    eras: [],
    chapterRefs: {},
    loading: false,
    mode: "axis",
    dir: "h",
    query: "",
    selEventId: null,
    selEntityId: null,
    zoneArm: null,
    drag: null,
    undoStack: [],
    bodyFocusToken: 0,
  });
}

/** 托盘事件数（空态文案用） */
export function trayCount(events: readonly OutlineEventDTO[]): number {
  return looseEvents(events.map(asChain)).length;
}

/** 全局槽号上限（画布宽 / 时代 rail 长度） */
export function maxSlotOf(events: readonly OutlineEventDTO[]): number {
  return events.reduce(
    (max, event) => (event.laneId ? Math.max(max, event.slot) : max),
    0,
  );
}

/** 收拢后的 era 视图（渲染层直接画，不再自己算）。
 *  占位段（FR-15a）必须对渲染层可见：空画布上它是「第一段」，改名即转正；
 *  这里只在有真实段时才把占位滤掉——之前全程过滤，导致空画布时间线带恒空、
 *  计数恒显「0 段」，作者永远看不到可以双击改名的起点。 */
export function compactedEras(eras: readonly OutlineEraDTO[]): OutlineEraDTO[] {
  const real = eras.filter((era) => era.id !== PLACEHOLDER_ERA_ID);
  if (real.length === 0) {
    const placeholder = eras.find((era) => era.id === PLACEHOLDER_ERA_ID);
    return placeholder ? [placeholder] : [];
  }
  return compactEras(real.map(asEraRange))
    .map((range) => {
      const era = real.find((item) => item.id === range.id);
      return era
        ? { ...era, fromSlot: range.fromSlot, toSlot: range.toSlot }
        : era;
    })
    .filter((era): era is OutlineEraDTO => era !== undefined);
}
