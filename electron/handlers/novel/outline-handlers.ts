/**
 * 大纲工作台语义化 IPC handlers（spec：docs/spec/outline-plan-spec.md v7.1）
 *
 * 职责：大纲域七表（novel_outline_projects + lanes / events / entities /
 * casts / zones / eras）的读写编排：
 * - 项目（草稿 / 作品大纲统一宿主）：新建 / 重命名 / 软删除 / 列表 / 打开装载
 * - 泳道：增改删（**删线事件转待归类**，线上 zone 随删、浮卡收回卡内）
 * - 事件：增改删（落格 = 写 lane_id + slot + sort；删除级联清章节引用）
 * - 实体 / 出场：chip 增删（幂等）、浮卡落位与收回、跨事件改挂（去重拦截）
 * - 区域 / 时代带：CRUD（自适应计算在渲染层纯函数，落库只存槽号区间）
 * - 「由此大纲创建作品」绑定：单事务 INSERT novel_works + UPDATE project，
 *   一作品一份大纲由 idx_ol_projects_work 部分唯一索引硬守（冲突整体回滚）
 * - 章节拍入：novel_chapters.outline_event_id 写 / 清（悬挂引用零容忍）
 *
 * 边界：SQL 只出现在本文件与 novel-db.ts；不导入 main.ts；
 * 渲染层通过 preload 的 outline 命名空间调用，禁止裸拼 SQL。
 *
 * 位置语义（v7.0 铁律）：事件位置 = (lane_id, slot, sort) 唯一决定，
 * 表里**没有任何坐标列**；浮卡坐标只存在 casts.card_x/card_y 上。
 */
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { toOutlineIpcJson } from "./outline-ipc-payload";
import {
  novelAll as dbAll,
  novelGet as dbGet,
  novelRun as dbRun,
  getNovelDb as getDb,
  isNovelDbReady,
} from "../../novel/novel-db";
import { log } from "../../core/logger";

// ── 行类型（snake_case，对应表结构） ──

interface OutlineProjectRow {
  id: string;
  name: string;
  work_id: string | null;
  sort: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  /** project-list 的 JOIN 附加列；其余查询无此列 → mapProject 兜底 0 */
  event_count?: number;
}

interface OutlineLaneRow {
  id: string;
  project_id: string;
  name: string;
  note: string;
  sort: number;
  created_at: number;
  updated_at: number;
}

interface OutlineEventRow {
  id: string;
  project_id: string;
  lane_id: string | null;
  slot: number;
  sort: number;
  break_before: number;
  title: string;
  body: string;
  when_text: string;
  starred: number;
  created_at: number;
  updated_at: number;
}

interface OutlineEntityRow {
  id: string;
  project_id: string;
  type: string;
  name: string;
  aliases: string;
  body: string;
  color_slot: string;
  created_at: number;
  updated_at: number;
}

interface OutlineCastRow {
  event_id: string;
  entity_id: string;
  role_label: string;
  sort: number;
  card_x: number | null;
  card_y: number | null;
}

interface OutlineZoneRow {
  id: string;
  project_id: string;
  lane_id: string;
  name: string;
  note: string;
  color_slot: string;
  shape: string;
  solid: number;
  filled: number;
  from_slot: number;
  to_slot: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

interface OutlineEraRow {
  id: string;
  project_id: string;
  name: string;
  note: string;
  color_slot: string;
  from_slot: number;
  to_slot: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

// ── DTO（camelCase，渲染层契约） ──

export interface OutlineProjectDTO {
  id: string;
  name: string;
  workId: string | null;
  updatedAt: number;
  /** 事件数（project-list 附带；其余装载路径为 0） */
  eventCount: number;
}

export interface OutlineLaneDTO {
  id: string;
  name: string;
  note: string;
  sort: number;
}

export interface OutlineEventDTO {
  id: string;
  laneId: string | null;
  slot: number;
  sort: number;
  breakBefore: boolean;
  title: string;
  body: string;
  whenText: string;
  starred: boolean;
}

export interface OutlineEntityDTO {
  id: string;
  type: "char" | "force" | "item" | "place" | "clue" | string;
  name: string;
  aliases: string;
  body: string;
  colorSlot: string;
}

export interface OutlineCastDTO {
  eventId: string;
  entityId: string;
  roleLabel: string;
  sort: number;
  cardX: number | null;
  cardY: number | null;
}

export interface OutlineZoneDTO {
  id: string;
  laneId: string;
  name: string;
  note: string;
  colorSlot: string;
  shape: "brace" | "box" | "pill" | string;
  solid: boolean;
  filled: boolean;
  fromSlot: number;
  toSlot: number;
  sort: number;
}

export interface OutlineEraDTO {
  id: string;
  name: string;
  note: string;
  colorSlot: string;
  fromSlot: number;
  toSlot: number;
  sort: number;
}

/** 工作台整包装载（一次 IPC 拉齐七表 + 已拍章计数） */
export interface OutlineBundleDTO {
  project: OutlineProjectDTO;
  lanes: OutlineLaneDTO[];
  events: OutlineEventDTO[];
  entities: OutlineEntityDTO[];
  casts: OutlineCastDTO[];
  zones: OutlineZoneDTO[];
  eras: OutlineEraDTO[];
  /** 已拍章计数：eventId → 引用章数（「已拍 N 章」角标） */
  chapterRefs: Record<string, number>;
}

// ── 入参（渲染层传来的半信任数据：先收窄再进业务） ──

interface LaneInput {
  id: string;
  name?: string;
  note?: string;
  sort?: number;
}

interface EventInput {
  id: string;
  laneId?: string | null;
  slot?: number;
  sort?: number;
  breakBefore?: boolean;
  title?: string;
  body?: string;
  whenText?: string;
  starred?: boolean;
}

interface EntityInput {
  id: string;
  type?: string;
  name?: string;
  aliases?: string;
  body?: string;
  colorSlot?: string;
}

interface CastPatchInput {
  eventId: string;
  entityId: string;
  roleLabel?: string;
  sort?: number;
  cardX?: number | null;
  cardY?: number | null;
}

interface ZoneInput {
  id: string;
  laneId: string;
  name?: string;
  note?: string;
  colorSlot?: string;
  shape?: string;
  solid?: boolean;
  filled?: boolean;
  fromSlot: number;
  toSlot: number;
  sort?: number;
}

interface EraInput {
  id: string;
  name?: string;
  note?: string;
  colorSlot?: string;
  fromSlot: number;
  toSlot: number;
  sort?: number;
}

// ── 归一化工具 ──

const clampText = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  return value.slice(0, max);
};

const clampInt = (value: unknown, min: number, fallback = 0): number => {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, num);
};

const ENTITY_TYPES = new Set(["char", "force", "item", "place", "clue"]);
const ZONE_SHAPES = new Set(["brace", "box", "pill"]);

function normalizeEntityType(value: unknown): string {
  return typeof value === "string" && ENTITY_TYPES.has(value) ? value : "char";
}

function normalizeZoneShape(value: unknown): string {
  return typeof value === "string" && ZONE_SHAPES.has(value) ? value : "brace";
}

// ── 行 → DTO 映射 ──

const mapProject = (row: OutlineProjectRow): OutlineProjectDTO => ({
  id: row.id,
  name: row.name,
  workId: row.work_id,
  updatedAt: row.updated_at,
  eventCount: row.event_count ?? 0,
});

const mapLane = (row: OutlineLaneRow): OutlineLaneDTO => ({
  id: row.id,
  name: row.name,
  note: row.note,
  sort: row.sort,
});

const mapEvent = (row: OutlineEventRow): OutlineEventDTO => ({
  id: row.id,
  laneId: row.lane_id,
  slot: row.slot,
  sort: row.sort,
  breakBefore: row.break_before === 1,
  title: row.title,
  body: row.body,
  whenText: row.when_text,
  starred: row.starred === 1,
});

const mapEntity = (row: OutlineEntityRow): OutlineEntityDTO => ({
  id: row.id,
  type: row.type,
  name: row.name,
  aliases: row.aliases,
  body: row.body,
  colorSlot: row.color_slot,
});

const mapCast = (row: OutlineCastRow): OutlineCastDTO => ({
  eventId: row.event_id,
  entityId: row.entity_id,
  roleLabel: row.role_label,
  sort: row.sort,
  cardX: row.card_x,
  cardY: row.card_y,
});

const mapZone = (row: OutlineZoneRow): OutlineZoneDTO => ({
  id: row.id,
  laneId: row.lane_id,
  name: row.name,
  note: row.note,
  colorSlot: row.color_slot,
  shape: row.shape,
  solid: row.solid === 1,
  filled: row.filled === 1,
  fromSlot: row.from_slot,
  toSlot: row.to_slot,
  sort: row.sort,
});

const mapEra = (row: OutlineEraRow): OutlineEraDTO => ({
  id: row.id,
  name: row.name,
  note: row.note,
  colorSlot: row.color_slot,
  fromSlot: row.from_slot,
  toSlot: row.to_slot,
  sort: row.sort,
});

// ── 内部工具 ──

function getProjectRow(id: string): OutlineProjectRow | undefined {
  return dbGet(
    "SELECT * FROM novel_outline_projects WHERE id = ? AND deleted_at IS NULL",
    [id],
  ) as OutlineProjectRow | undefined;
}

/** 空白大纲的默认车道名：画布必须至少有一条轨道行，卡片才有落点 */
const DEFAULT_LANE_NAME = "主线";

/**
 * 给「一条车道都没有」的大纲补一条默认线（主线），已有线时原样返回首条 id。
 *
 * 为什么必须有：事件的落格坐标是 (lane_id, slot, sort)，画布的可放置区域
 * 完全由车道行决定。零车道的画布没有任何命中区——托盘 / 搜索 / 幽灵卡片
 * 拖进来都命不中目标，新建事件也只会进待归类，用户看到就是「空白画布
 * 拖不进东西」。新草稿在 projectCreate 里与项目行同事务建线；这里兜的是
 * 默认车道机制之前建好的既有草稿（以及历史数据被异常清空的情况）。
 */
function ensureDefaultLane(projectId: string, now = Date.now()): string | null {
  const existing = dbGet(
    "SELECT id FROM novel_outline_lanes WHERE project_id = ? ORDER BY sort LIMIT 1",
    [projectId],
  ) as { id: string } | undefined;
  if (existing) return existing.id;
  const laneId = `ol-l-${randomUUID()}`;
  const inserted = dbRun(
    `INSERT INTO novel_outline_lanes (id, project_id, name, note, sort, created_at, updated_at)
     VALUES (?, ?, ?, '', 0, ?, ?)`,
    [laneId, projectId, DEFAULT_LANE_NAME, now, now],
  );
  return inserted.changes > 0 ? laneId : null;
}

/**
 * 彻底删除一个大纲项目的六表数据（项目行由调用方决定是否一并删）。
 * 软删除的回收站清理与「删作品级联清大纲」共用这一个收口。
 */
function purgeOutlineProjectData(db: ReturnType<typeof getDb>, projectId: string): void {
  db.prepare("DELETE FROM novel_outline_casts WHERE event_id IN (SELECT id FROM novel_outline_events WHERE project_id = ?)").run(projectId);
  db.prepare("DELETE FROM novel_outline_events WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM novel_outline_lanes WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM novel_outline_entities WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM novel_outline_zones WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM novel_outline_eras WHERE project_id = ?").run(projectId);
}

// ── 注册 ──

/**
 * 出场写入的归属校验：事件 / 目标事件 / 实体必须同属一个项目。
 * casts 表既无 project_id 也无外键，跨项目挂接只能在这里堵（服务端兜底）。
 */
function castScopeOk(eventId: string, entityId: string, toEventId?: string): boolean {
  const eventOwner = (id: string): { project_id: string } | undefined =>
    dbGet(
      `SELECT e.project_id FROM novel_outline_events e
         JOIN novel_outline_projects p ON p.id = e.project_id
        WHERE e.id = ? AND p.deleted_at IS NULL`,
      [id],
    ) as { project_id: string } | undefined;
  const from = eventOwner(eventId);
  if (!from) return false;
  if (toEventId) {
    const to = eventOwner(toEventId);
    if (!to || to.project_id !== from.project_id) return false;
  }
  return (
    dbGet(
      "SELECT 1 AS hit FROM novel_outline_entities WHERE id = ? AND project_id = ?",
      [entityId, from.project_id],
    ) !== undefined
  );
}

export function registerOutlineHandlers(): void {
  /* ── 项目（草稿 / 作品大纲统一宿主）────────────────────────────── */

  // 项目列表（不含回收站里的）：drafts = work_id IS NULL（按最近编辑倒序），
  // works = 已绑定作品的大纲（渲染层只取最近 5 部展示）
  ipcMain.handle("novel-outline-project-list", () => {
    if (!isNovelDbReady()) return { drafts: [], works: [] };
    // 附带每份大纲的事件数：书架「大纲 · N 个事件」快捷入口直接读，不再逐份 load
    const rows = dbAll(
      `SELECT p.*, (SELECT COUNT(*) FROM novel_outline_events e
                    WHERE e.project_id = p.id) AS event_count
       FROM novel_outline_projects p
       WHERE p.deleted_at IS NULL
       ORDER BY p.updated_at DESC`,
    ) as OutlineProjectRow[];
    const all = rows.map(mapProject);
    return {
      drafts: all.filter((p) => p.workId === null),
      works: all.filter((p) => p.workId !== null),
    };
  });

  // 新建草稿：id 由渲染层生成；默认名空串（UI 显示「未命名大纲」）
  ipcMain.handle(
    "novel-outline-project-create",
    (_event, id: string, name: string): OutlineProjectDTO | null => {
      const now = Date.now();
      try {
        const db = getDb();
        // 项目行 + 默认「主线」同一事务：空画布没有轨道行 = 卡片无处可落
        // （拖拽命不中、新建事件只能进待归类），新草稿必须自带一条线。
        const apply = db.transaction((): void => {
          db.prepare(
            "INSERT INTO novel_outline_projects (id, name, work_id, sort, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)",
          ).run(id, clampText(name, 40), now, now);
          db.prepare(
            `INSERT INTO novel_outline_lanes (id, project_id, name, note, sort, created_at, updated_at)
             VALUES (?, ?, ?, '', 0, ?, ?)`,
          ).run(`ol-l-${randomUUID()}`, id, DEFAULT_LANE_NAME, now, now);
        });
        apply();
      } catch (error) {
        log("warn", "main", "outline-handlers", "新建大纲草稿失败", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      const row = getProjectRow(id);
      return row ? mapProject(row) : null;
    },
  );

  ipcMain.handle("novel-outline-project-rename", (_event, id: string, name: string) => {
    const trimmed = clampText(name, 40).trim();
    if (!trimmed) return false;
    return (
      dbRun(
        "UPDATE novel_outline_projects SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        [trimmed, Date.now(), id],
      ).changes > 0
    );
  });

  // 软删除草稿（进回收站）：六表原位保留，恢复清标记（novel-trash-restore）
  ipcMain.handle("novel-outline-project-trash", (_event, id: string) => {
    return (
      dbRun(
        "UPDATE novel_outline_projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND work_id IS NULL",
        [Date.now(), id],
      ).changes > 0
    );
  });

  // 彻底删除（回收站过期 / 手动清除）：六表 + 项目行一个事务物理清空
  ipcMain.handle("novel-outline-purge", (_event, id: string) => {
    const db = getDb();
    const apply = db.transaction((): boolean => {
      purgeOutlineProjectData(db, id);
      db.prepare("DELETE FROM novel_outline_projects WHERE id = ?").run(id);
      return true;
    });
    return apply();
  });

  /* ── 工作台装载 ─────────────────────────────────────────────── */

  ipcMain.handle("novel-outline-load", (_event, projectId: string): string | null => {
    try {
      const bundle = loadBundle(projectId);
      // 无条件 JSON 编码：返回值必须是「三道结构化克隆的公共子集」（字符串）。
      // 详见 outline-ipc-payload.ts 的模块注释——v8.serialize 自检只能证明
      // Node 侧的克隆能过，证明不了 Electron / contextBridge 那两道能过。
      return bundle === null ? null : toOutlineIpcJson(bundle);
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      log("error", "main", "outline-handlers", "novel-outline-load 处理异常", {
        reason,
        stack: error instanceof Error ? error.stack : undefined,
        projectId,
      });
      // Electron 序列化抛出的 Error 时会连同 cause / 自有属性一起克隆；
      // 原生 DB 错误里挂着 native 引用时，连错误都克隆失败，渲染层就只剩
      // 一句「An object could not be cloned.」。这里只抛纯字符串字段的新 Error。
      // eslint-disable-next-line preserve-caught-error -- 刻意不挂 cause：native 引用会让 IPC 克隆失败
      throw new Error(reason);
    }
  });

  function loadBundle(projectId: string): OutlineBundleDTO | null {
    if (!isNovelDbReady()) return null;
    const projectRow = getProjectRow(projectId);
    if (!projectRow) return null;
    let lanes = dbAll(
      "SELECT * FROM novel_outline_lanes WHERE project_id = ? ORDER BY sort",
      [projectId],
    ) as OutlineLaneRow[];
    // 老草稿（默认车道机制之前建的）装载时就地补一条「主线」：否则这张
    // 空白画布没有轨道行，卡片拖不进来、新建事件只能进待归类。
    // 补线失败（库只读 / 被锁）不能连带装载失败——退化成旧的空画布即可。
    if (lanes.length === 0) {
      try {
        ensureDefaultLane(projectId);
        lanes = dbAll(
          "SELECT * FROM novel_outline_lanes WHERE project_id = ? ORDER BY sort",
          [projectId],
        ) as OutlineLaneRow[];
      } catch (error) {
        log("warn", "main", "outline-handlers", "补默认时间线失败（按空画布继续）", {
          projectId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const events = dbAll(
      "SELECT * FROM novel_outline_events WHERE project_id = ? ORDER BY slot, sort",
      [projectId],
    ) as OutlineEventRow[];
    const entities = dbAll(
      "SELECT * FROM novel_outline_entities WHERE project_id = ? ORDER BY created_at",
      [projectId],
    ) as OutlineEntityRow[];
    const casts = dbAll(
      `SELECT c.* FROM novel_outline_casts c
        JOIN novel_outline_events e ON e.id = c.event_id
        WHERE e.project_id = ? ORDER BY c.sort`,
      [projectId],
    ) as OutlineCastRow[];
    const zones = dbAll(
      "SELECT * FROM novel_outline_zones WHERE project_id = ? ORDER BY sort",
      [projectId],
    ) as OutlineZoneRow[];
    const eras = dbAll(
      "SELECT * FROM novel_outline_eras WHERE project_id = ? ORDER BY from_slot",
      [projectId],
    ) as OutlineEraRow[];
    // 已拍章计数（§7.4「已拍 N 章」角标）：按 outline_event_id 聚合在架章节
    const refs = dbAll(
      `SELECT outline_event_id AS event_id, COUNT(*) AS n
         FROM novel_chapters
        WHERE outline_event_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY outline_event_id`,
    ) as Array<{ event_id: string; n: number }>;
    const chapterRefs: Record<string, number> = {};
    for (const ref of refs) chapterRefs[ref.event_id] = Number(ref.n) || 0;
    // 这里保持原始 DTO 组装；跨 IPC 的安全化统一在 handler 出口做一次
    // toOutlineIpcJson，避免两条返回路径（自检通过 / 兜底）行为不一致。
    const bundle: OutlineBundleDTO = {
      project: mapProject(projectRow),
      lanes: lanes.map(mapLane),
      events: events.map(mapEvent),
      entities: entities.map(mapEntity),
      casts: casts.map(mapCast),
      zones: zones.map(mapZone),
      eras: eras.map(mapEra),
      chapterRefs,
    };
    return bundle;
  }

  /* ── 泳道（删线：事件转待归类 + 浮卡收回 + zone 随删，单事务）──── */

  ipcMain.handle("novel-outline-lane-save", (_event, lane: LaneInput) => {
    if (!lane?.id) return false;
    const existing = dbGet(
      `SELECT l.id FROM novel_outline_lanes l
        JOIN novel_outline_projects p ON p.id = l.project_id
        WHERE l.id = ? AND p.deleted_at IS NULL`,
      [lane.id],
    );
    const now = Date.now();
    if (existing) {
      return (
        dbRun(
          "UPDATE novel_outline_lanes SET name = ?, note = ?, sort = ?, updated_at = ? WHERE id = ?",
          [
            clampText(lane.name, 20),
            clampText(lane.note, 120),
            clampInt(lane.sort, 0),
            now,
            lane.id,
          ],
        ).changes > 0
      );
    }
    // 新建：project_id 必须是渲染层传入的合法项目——单带 lane.id 无法推导，
    // 约定渲染层把 projectId 一起放进入参（lane.projectId）
    const projectId = (lane as LaneInput & { projectId?: string }).projectId ?? "";
    if (!getProjectRow(projectId)) return false;
    // 服务端兜底：单项目 ≤12 条时间线（FR-13），渲染层上限不能是唯一防线
    const laneCount = dbGet(
      "SELECT COUNT(*) AS n FROM novel_outline_lanes WHERE project_id = ?",
      [projectId],
    ) as { n: number } | undefined;
    if ((laneCount?.n ?? 0) >= 12) return false;
    dbRun(
      "INSERT INTO novel_outline_lanes (id, project_id, name, note, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [lane.id, projectId, clampText(lane.name, 20), clampText(lane.note, 120), clampInt(lane.sort, 0), now, now],
    );
    return true;
  });

  ipcMain.handle("novel-outline-lane-delete", (_event, laneId: string) => {
    const lane = dbGet(
      "SELECT id, project_id FROM novel_outline_lanes WHERE id = ?",
      [laneId],
    ) as { id: string; project_id: string } | undefined;
    if (!lane) return false;
    const db = getDb();
    const apply = db.transaction((): boolean => {
      // 线内事件转待归类：lane_id 置 NULL（槽号保留，作者重新归置时参考）
      db.prepare(
        "UPDATE novel_outline_events SET lane_id = NULL, updated_at = ? WHERE lane_id = ? AND project_id = ?",
      ).run(Date.now(), laneId, lane.project_id);
      // 浮卡宿主不在格里了：全部收回卡内（card_x/y 置 NULL，虚线不连托盘）
      db.prepare(
        `UPDATE novel_outline_casts SET card_x = NULL, card_y = NULL
           WHERE event_id IN (SELECT id FROM novel_outline_events WHERE project_id = ? AND lane_id IS NULL)`,
      ).run(lane.project_id);
      // 线上的区域随删；时代带跨线，不动
      db.prepare("DELETE FROM novel_outline_zones WHERE lane_id = ?").run(laneId);
      db.prepare("DELETE FROM novel_outline_lanes WHERE id = ?").run(laneId);
      return true;
    });
    return apply();
  });

  /* ── 事件 ───────────────────────────────────────────────────── */

  ipcMain.handle("novel-outline-event-save", (_event, event: EventInput) => {
    if (!event?.id) return false;
    const existing = dbGet(
      `SELECT e.id, e.project_id FROM novel_outline_events e
        JOIN novel_outline_projects p ON p.id = e.project_id
        WHERE e.id = ? AND p.deleted_at IS NULL`,
      [event.id],
    ) as { id: string; project_id: string } | undefined;
    const now = Date.now();
    const laneId = typeof event.laneId === "string" && event.laneId ? event.laneId : null;
    const slot = laneId ? clampInt(event.slot, 0) : 0;
    if (existing) {
      dbRun(
        `UPDATE novel_outline_events
            SET lane_id = ?, slot = ?, sort = ?, break_before = ?, title = ?, body = ?, when_text = ?, starred = ?, updated_at = ?
          WHERE id = ?`,
        [
          laneId,
          slot,
          clampInt(event.sort, 0),
          event.breakBefore ? 1 : 0,
          clampText(event.title, 60),
          clampText(event.body, 20000),
          clampText(event.whenText, 60),
          event.starred ? 1 : 0,
          now,
          event.id,
        ],
      );
      // 入线事件若原来是待归类宿主，浮卡保持；转**待归类**时浮卡收回
      if (!laneId) {
        dbRun(
          "UPDATE novel_outline_casts SET card_x = NULL, card_y = NULL WHERE event_id = ?",
          [event.id],
        );
      }
      return true;
    }
    const projectId = (event as EventInput & { projectId?: string }).projectId ?? "";
    if (!getProjectRow(projectId)) return false;
    dbRun(
      `INSERT INTO novel_outline_events
        (id, project_id, lane_id, slot, sort, break_before, title, body, when_text, starred, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        projectId,
        laneId,
        slot,
        clampInt(event.sort, 0),
        event.breakBefore ? 1 : 0,
        clampText(event.title, 60),
        clampText(event.body, 20000),
        clampText(event.whenText, 60),
        event.starred ? 1 : 0,
        now,
        now,
      ],
    );
    return true;
  });

  ipcMain.handle("novel-outline-event-delete", (_event, eventId: string) => {
    const db = getDb();
    const apply = db.transaction((): boolean => {
      db.prepare("DELETE FROM novel_outline_casts WHERE event_id = ?").run(eventId);
      // 悬挂引用零容忍：删事件同事务清掉章节侧的拍入引用
      db.prepare(
        "UPDATE novel_chapters SET outline_event_id = NULL WHERE outline_event_id = ?",
      ).run(eventId);
      db.prepare("DELETE FROM novel_outline_events WHERE id = ?").run(eventId);
      return true;
    });
    return apply();
  });

  /* ── 实体（删实体 = 全部出场一起消失，单事务）────────────────── */

  ipcMain.handle("novel-outline-entity-save", (_event, entity: EntityInput) => {
    if (!entity?.id) return false;
    const existing = dbGet(
      `SELECT e.id, e.project_id FROM novel_outline_entities e
        JOIN novel_outline_projects p ON p.id = e.project_id
        WHERE e.id = ? AND p.deleted_at IS NULL`,
      [entity.id],
    ) as { id: string; project_id: string } | undefined;
    const now = Date.now();
    const type = normalizeEntityType(entity.type);
    const name = clampText(entity.name, 40);
    const aliases = clampText(entity.aliases, 200);
    const body = clampText(entity.body, 2000);
    const colorSlot = clampText(entity.colorSlot, 20);
    if (existing) {
      dbRun(
        "UPDATE novel_outline_entities SET type = ?, name = ?, aliases = ?, body = ?, color_slot = ?, updated_at = ? WHERE id = ?",
        [type, name, aliases, body, colorSlot, now, entity.id],
      );
      return true;
    }
    const projectId = (entity as EntityInput & { projectId?: string }).projectId ?? "";
    if (!getProjectRow(projectId)) return false;
    dbRun(
      `INSERT INTO novel_outline_entities
        (id, project_id, type, name, aliases, body, color_slot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entity.id, projectId, type, name, aliases, body, colorSlot, now, now],
    );
    return true;
  });

  ipcMain.handle("novel-outline-entity-delete", (_event, entityId: string) => {
    const db = getDb();
    const apply = db.transaction((): boolean => {
      db.prepare("DELETE FROM novel_outline_casts WHERE entity_id = ?").run(entityId);
      db.prepare("DELETE FROM novel_outline_entities WHERE id = ?").run(entityId);
      return true;
    });
    return apply();
  });

  /* ── 出场（chip 幂等 upsert / 移除 / 改挂 / 浮卡落位）──────────── */

  ipcMain.handle("novel-outline-cast-set", (_event, patch: CastPatchInput) => {
    if (!patch?.eventId || !patch?.entityId) return false;
    // 事件存在 + 实体与事件同项目（casts 无 project_id / 无外键）
    if (!castScopeOk(patch.eventId, patch.entityId)) return false;
    // 幂等 upsert：同一事件同一实体只一枚 chip（主键兜底 + ON CONFLICT 更新）
    dbRun(
      `INSERT INTO novel_outline_casts (event_id, entity_id, role_label, sort, card_x, card_y)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, entity_id) DO UPDATE SET
         role_label = excluded.role_label,
         sort = excluded.sort,
         card_x = excluded.card_x,
         card_y = excluded.card_y`,
      [
        patch.eventId,
        patch.entityId,
        clampText(patch.roleLabel, 20),
        clampInt(patch.sort, 0),
        typeof patch.cardX === "number" ? Math.floor(patch.cardX) : null,
        typeof patch.cardY === "number" ? Math.floor(patch.cardY) : null,
      ],
    );
    return true;
  });

  ipcMain.handle("novel-outline-cast-remove", (_event, eventId: string, entityId: string) => {
    return (
      dbRun("DELETE FROM novel_outline_casts WHERE event_id = ? AND entity_id = ?", [
        eventId,
        entityId,
      ]).changes > 0
    );
  });

  // 改挂：把某事件的出场挪到另一事件（浮卡拖到别的卡上）。
  // 目标已有同实体 chip → 拒绝（UI 提示「这个事件里已经有一张了」并复位）。
  ipcMain.handle(
    "novel-outline-cast-move",
    (_event, eventId: string, entityId: string, toEventId: string) => {
      if (!eventId || !toEventId || eventId === toEventId) return false;
      if (!castScopeOk(eventId, entityId, toEventId)) return false;
      const dup = dbGet(
        "SELECT 1 AS hit FROM novel_outline_casts WHERE event_id = ? AND entity_id = ?",
        [toEventId, entityId],
      );
      if (dup) return false;
      const db = getDb();
      const apply = db.transaction((): boolean => {
        const row = db
          .prepare(
            "SELECT role_label, sort, card_x, card_y FROM novel_outline_casts WHERE event_id = ? AND entity_id = ?",
          )
          .get(eventId, entityId) as OutlineCastRow | undefined;
        if (!row) return false;
        db.prepare("DELETE FROM novel_outline_casts WHERE event_id = ? AND entity_id = ?").run(
          eventId,
          entityId,
        );
        db.prepare(
          "INSERT INTO novel_outline_casts (event_id, entity_id, role_label, sort, card_x, card_y) VALUES (?, ?, ?, ?, NULL, NULL)",
        ).run(toEventId, entityId, row.role_label, row.sort);
        return true;
      });
      return apply();
    },
  );

  /* ── 区域 / 时代带（自适应在渲染层纯函数，这里只存槽号区间）────── */

  ipcMain.handle("novel-outline-zone-save", (_event, zone: ZoneInput) => {
    if (!zone?.id || !zone.laneId) return false;
    if (zone.toSlot < zone.fromSlot) return false;
    const existing = dbGet(
      `SELECT z.id FROM novel_outline_zones z
        JOIN novel_outline_projects p ON p.id = z.project_id
        WHERE z.id = ? AND p.deleted_at IS NULL`,
      [zone.id],
    );
    const now = Date.now();
    const from = clampInt(zone.fromSlot, 0);
    const to = clampInt(zone.toSlot, 0);
    if (existing) {
      dbRun(
        `UPDATE novel_outline_zones
            SET lane_id = ?, name = ?, note = ?, color_slot = ?, shape = ?, solid = ?, filled = ?, from_slot = ?, to_slot = ?, sort = ?, updated_at = ?
          WHERE id = ?`,
        [
          zone.laneId,
          clampText(zone.name, 30),
          clampText(zone.note, 2000),
          clampText(zone.colorSlot, 20),
          normalizeZoneShape(zone.shape),
          zone.solid ? 1 : 0,
          zone.filled ? 1 : 0,
          from,
          to,
          clampInt(zone.sort, 0),
          now,
          zone.id,
        ],
      );
      return true;
    }
    const projectId = (zone as ZoneInput & { projectId?: string }).projectId ?? "";
    if (!getProjectRow(projectId)) return false;
    dbRun(
      `INSERT INTO novel_outline_zones
        (id, project_id, lane_id, name, note, color_slot, shape, solid, filled, from_slot, to_slot, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        zone.id,
        projectId,
        zone.laneId,
        clampText(zone.name, 30),
        clampText(zone.note, 2000),
        clampText(zone.colorSlot, 20),
        normalizeZoneShape(zone.shape),
        zone.solid ? 1 : 0,
        zone.filled ? 1 : 0,
        from,
        to,
        clampInt(zone.sort, 0),
        now,
        now,
      ],
    );
    return true;
  });

  ipcMain.handle("novel-outline-zone-delete", (_event, zoneId: string) => {
    return dbRun("DELETE FROM novel_outline_zones WHERE id = ?", [zoneId]).changes > 0;
  });

  ipcMain.handle("novel-outline-era-save", (_event, era: EraInput) => {
    if (!era?.id) return false;
    if (era.toSlot < era.fromSlot) return false;
    const existing = dbGet(
      `SELECT e.id FROM novel_outline_eras e
        JOIN novel_outline_projects p ON p.id = e.project_id
        WHERE e.id = ? AND p.deleted_at IS NULL`,
      [era.id],
    );
    const now = Date.now();
    const from = clampInt(era.fromSlot, 0);
    const to = clampInt(era.toSlot, 0);
    if (existing) {
      dbRun(
        `UPDATE novel_outline_eras
            SET name = ?, note = ?, color_slot = ?, from_slot = ?, to_slot = ?, sort = ?, updated_at = ?
          WHERE id = ?`,
        [
          clampText(era.name, 30),
          clampText(era.note, 200),
          clampText(era.colorSlot, 20),
          from,
          to,
          clampInt(era.sort, 0),
          now,
          era.id,
        ],
      );
      return true;
    }
    const projectId = (era as EraInput & { projectId?: string }).projectId ?? "";
    if (!getProjectRow(projectId)) return false;
    dbRun(
      `INSERT INTO novel_outline_eras
        (id, project_id, name, note, color_slot, from_slot, to_slot, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        era.id,
        projectId,
        clampText(era.name, 30),
        clampText(era.note, 200),
        clampText(era.colorSlot, 20),
        from,
        to,
        clampInt(era.sort, 0),
        now,
        now,
      ],
    );
    return true;
  });

  ipcMain.handle("novel-outline-era-delete", (_event, eraId: string) => {
    return dbRun("DELETE FROM novel_outline_eras WHERE id = ?", [eraId]).changes > 0;
  });

  /* ── 「由此大纲创建作品」绑定（v7.1 FR-28，单事务 + UNIQUE 硬守）── */

  ipcMain.handle(
    "novel-outline-bind-work",
    (_event, projectId: string, name: string, genre: string | null): string | null => {
      const project = getProjectRow(projectId);
      if (!project) return null;
      const trimmed = clampText(name, 60).trim();
      if (!trimmed) return null;
      if (project.work_id) return project.work_id; // 已绑定：幂等返回
      const db = getDb();
      const now = Date.now();
      const workId = `w-${randomUUID()}`;
      try {
        const apply = db.transaction((): void => {
          db.prepare(
            "INSERT INTO novel_works (id, name, created_at, genre) VALUES (?, ?, ?, ?)",
          ).run(workId, trimmed, now, genre && genre.trim() ? clampText(genre, 30) : null);
          db.prepare(
            "UPDATE novel_outline_projects SET work_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND work_id IS NULL",
          ).run(workId, now, projectId);
        });
        apply();
        return workId;
      } catch (error) {
        // UNIQUE(project.work_id) 冲突（并发绑定同一作品第二份大纲）→ 整体回滚
        log("warn", "main", "outline-handlers", "大纲绑定作品失败（事务已回滚）", {
          projectId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  );

  /* ── 章节拍入（§7.4：novel_chapters.outline_event_id）────────── */

  ipcMain.handle("novel-outline-chapter-link", (_event, chapterId: string, eventId: string | null) => {
    if (!chapterId) return false;
    // 取消拍入（eventId null）直接清值；拍入时事件必须真实存在
    if (eventId) {
      // 事件与章节必须属于同一个作品：草稿态大纲（work_id 为空）不能拍章
      const scope = dbGet(
        `SELECT c.work_id AS chapterWork, p.work_id AS projectWork
           FROM novel_chapters c
           JOIN novel_outline_events e ON e.id = ?
           JOIN novel_outline_projects p ON p.id = e.project_id
          WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL`,
        [eventId, chapterId],
      ) as { chapterWork: string | null; projectWork: string | null } | undefined;
      if (!scope || !scope.projectWork || scope.chapterWork !== scope.projectWork) {
        return false;
      }
    }
    return (
      dbRun(
        "UPDATE novel_chapters SET outline_event_id = ? WHERE id = ? AND deleted_at IS NULL",
        [eventId, chapterId],
      ).changes > 0
    );
  });

  /* ── 批量整存（撤销栈恢复 / 数据迁移专用）────────────────────── */

  interface BulkPayload {
    lanes?: OutlineLaneDTO[];
    events?: Array<OutlineEventDTO & { projectId?: string }>;
    entities?: OutlineEntityDTO[];
    casts?: OutlineCastDTO[];
    zones?: OutlineZoneDTO[];
    eras?: OutlineEraDTO[];
  }

  // 单事务整体替换项目的六表内容：渲染层撤销栈（50 步深度快照）回放时
  // 一次通道落库，避免逐条 save 在中途失败留下「撤销了一半」的状态。
  ipcMain.handle("novel-outline-bulk-save", (_event, projectId: string, payload: BulkPayload) => {
    const project = getProjectRow(projectId);
    if (!project || !payload) return false;
    const db = getDb();
    const now = Date.now();
    const apply = db.transaction((): boolean => {
      purgeOutlineProjectData(db, projectId);
      const insertLane = db.prepare(
        "INSERT INTO novel_outline_lanes (id, project_id, name, note, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const lane of payload.lanes ?? []) {
        insertLane.run(lane.id, projectId, clampText(lane.name, 20), clampText(lane.note, 120), clampInt(lane.sort, 0), now, now);
      }
      const insertEvent = db.prepare(
        `INSERT INTO novel_outline_events
          (id, project_id, lane_id, slot, sort, break_before, title, body, when_text, starred, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of payload.events ?? []) {
        insertEvent.run(
          event.id,
          projectId,
          event.laneId ?? null,
          event.laneId ? clampInt(event.slot, 0) : 0,
          clampInt(event.sort, 0),
          event.breakBefore ? 1 : 0,
          clampText(event.title, 60),
          clampText(event.body, 20000),
          clampText(event.whenText, 60),
          event.starred ? 1 : 0,
          now,
          now,
        );
      }
      const insertEntity = db.prepare(
        `INSERT INTO novel_outline_entities
          (id, project_id, type, name, aliases, body, color_slot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entity of payload.entities ?? []) {
        insertEntity.run(
          entity.id,
          projectId,
          normalizeEntityType(entity.type),
          clampText(entity.name, 40),
          clampText(entity.aliases, 200),
          clampText(entity.body, 2000),
          clampText(entity.colorSlot, 20),
          now,
          now,
        );
      }
      const insertCast = db.prepare(
        "INSERT INTO novel_outline_casts (event_id, entity_id, role_label, sort, card_x, card_y) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const cast of payload.casts ?? []) {
        insertCast.run(
          cast.eventId,
          cast.entityId,
          clampText(cast.roleLabel, 20),
          clampInt(cast.sort, 0),
          typeof cast.cardX === "number" ? Math.floor(cast.cardX) : null,
          typeof cast.cardY === "number" ? Math.floor(cast.cardY) : null,
        );
      }
      const insertZone = db.prepare(
        `INSERT INTO novel_outline_zones
          (id, project_id, lane_id, name, note, color_slot, shape, solid, filled, from_slot, to_slot, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const zone of payload.zones ?? []) {
        insertZone.run(
          zone.id,
          projectId,
          zone.laneId,
          clampText(zone.name, 30),
          clampText(zone.note, 2000),
          clampText(zone.colorSlot, 20),
          normalizeZoneShape(zone.shape),
          zone.solid ? 1 : 0,
          zone.filled ? 1 : 0,
          clampInt(zone.fromSlot, 0),
          clampInt(zone.toSlot, 0),
          clampInt(zone.sort, 0),
          now,
          now,
        );
      }
      const insertEra = db.prepare(
        `INSERT INTO novel_outline_eras
          (id, project_id, name, note, color_slot, from_slot, to_slot, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const era of payload.eras ?? []) {
        insertEra.run(
          era.id,
          projectId,
          clampText(era.name, 30),
          clampText(era.note, 200),
          clampText(era.colorSlot, 20),
          clampInt(era.fromSlot, 0),
          clampInt(era.toSlot, 0),
          clampInt(era.sort, 0),
          now,
          now,
        );
      }
      db.prepare("UPDATE novel_outline_projects SET updated_at = ? WHERE id = ?").run(now, projectId);
      return true;
    });
    return apply();
  });
}
