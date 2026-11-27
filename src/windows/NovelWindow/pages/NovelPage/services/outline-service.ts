/**
 * 大纲工作台数据服务（IPC 封装层，outline-plan-spec v7.1）
 *
 * 只做语义化转发：页面经本文件访问七张 outline 表，禁止直接调
 * `window.electronAPI.outline`、禁止内联 SQL。不导入 React。
 *
 * 放在 NovelPage/services（而非 OutlinePage 私有目录）是刻意的：
 * 回收站页的大纲条目彻底删除、书架页的草稿分区与工作台共用同一套契约，
 * 沿用 useTrashBin 引 novel-service 的先例。
 */
import type {
  ElectronAPI,
  OutlineBundleDTO,
  OutlineCastDTO,
  OutlineEntityDTO,
  OutlineEraDTO,
  OutlineEventDTO,
  OutlineLaneDTO,
  OutlineProjectDTO,
  OutlineProjectListResult,
  OutlineZoneDTO,
} from "@/shared/types/electron";
import { createNovelId } from "@/shared/services/novel-shared";

const api = (): ElectronAPI["outline"] => window.electronAPI!.outline;

// ── 项目（草稿 / 作品大纲统一宿主） ──

export async function fetchOutlineProjects(): Promise<OutlineProjectListResult> {
  const fallback: OutlineProjectListResult = { drafts: [], works: [] };
  const result = (await api().projectList()) as
    | OutlineProjectListResult
    | undefined;
  return result ?? fallback;
}

/** 新建大纲草稿：id 在渲染层生成（与作品域 createNovelId 同一口径） */
export async function createOutlineDraft(name = ""): Promise<OutlineProjectDTO | null> {
  return (await api().projectCreate(createNovelId("olp"), name)) as OutlineProjectDTO | null;
}

export async function renameOutlineProject(id: string, name: string): Promise<boolean> {
  return api().projectRename(id, name);
}

/** 草稿软删除（进回收站，30 天可恢复） */
export async function trashOutlineProject(id: string): Promise<boolean> {
  return api().projectTrash(id);
}

/** 彻底删除（回收站过期 / 手动清除）：六表 + 项目行单事务物理清空 */
export async function outlinePurge(id: string): Promise<boolean> {
  return api().projectPurge(id);
}

// ── 装载载荷解码 ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 装载结果的最小结构校验：只确认渲染层马上要读的字段形态，
 * 字段取值仍由主进程 mapper 负责收窄，这里不做业务层二次加工。
 */
function isOutlineBundle(value: unknown): value is OutlineBundleDTO {
  if (!isRecord(value) || !isRecord(value.project)) return false;
  if (typeof value.project.id !== "string") return false;
  for (const key of ["lanes", "events", "entities", "casts", "zones", "eras"] as const) {
    if (!Array.isArray(value[key])) return false;
  }
  return isRecord(value.chapterRefs);
}

/**
 * 把 `novel-outline-load` 的 JSON 字符串载荷解码成 DTO。
 *
 * 主进程刻意只返回字符串（三道结构化克隆的公共子集）；这里在渲染层
 * 解码并做一次 `structuredClone` 断言——它与 Electron 响应反序列化同源，
 * 能过即证明后续组件层的任何克隆都不会再抛 `An object could not be cloned`。
 * 解析失败一律抛带业务语境的 Error，不让框架层的笼统错误掩盖数据问题。
 */
export function parseOutlineLoadPayload(
  raw: string | null | undefined,
): OutlineBundleDTO | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error("大纲装载失败：IPC 返回值不是 JSON 字符串");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`大纲装载失败：返回数据损坏（${reason}）`);
  }
  if (parsed === null) return null;
  if (!isOutlineBundle(parsed)) {
    throw new Error("大纲装载失败：返回数据结构不符合契约");
  }
  return structuredClone(parsed);
}

/** 工作台整包装载（一次 IPC 拉齐七表 + 已拍章计数） */
export async function fetchOutlineBundle(projectId: string): Promise<OutlineBundleDTO | null> {
  return parseOutlineLoadPayload(await api().load(projectId));
}

// ── 泳道 / 事件 / 实体 ──

export async function saveOutlineLane(lane: OutlineLaneDTO & { projectId: string }): Promise<boolean> {
  return api().laneSave(lane);
}

export async function deleteOutlineLane(laneId: string): Promise<boolean> {
  return api().laneDelete(laneId);
}

export async function saveOutlineEvent(
  event: OutlineEventDTO & { projectId: string },
): Promise<boolean> {
  return api().eventSave(event);
}

export async function deleteOutlineEvent(eventId: string): Promise<boolean> {
  return api().eventDelete(eventId);
}

export async function saveOutlineEntity(
  entity: OutlineEntityDTO & { projectId: string },
): Promise<boolean> {
  return api().entitySave(entity);
}

export async function deleteOutlineEntity(entityId: string): Promise<boolean> {
  return api().entityDelete(entityId);
}

// ── 出场（chip / 浮卡） ──

export async function setOutlineCast(patch: Omit<OutlineCastDTO, "eventId" | "entityId"> & {
  eventId: string;
  entityId: string;
}): Promise<boolean> {
  return api().castSet(patch);
}

export async function removeOutlineCast(eventId: string, entityId: string): Promise<boolean> {
  return api().castRemove(eventId, entityId);
}

/** 改挂：目标已有同实体 chip 返回 false（调用方提示重复并复位） */
export async function moveOutlineCast(
  eventId: string,
  entityId: string,
  toEventId: string,
): Promise<boolean> {
  return api().castMove(eventId, entityId, toEventId);
}

// ── 区域 / 时代带 ──

export async function saveOutlineZone(zone: OutlineZoneDTO & { projectId: string }): Promise<boolean> {
  return api().zoneSave(zone);
}

export async function deleteOutlineZone(zoneId: string): Promise<boolean> {
  return api().zoneDelete(zoneId);
}

export async function saveOutlineEra(era: OutlineEraDTO & { projectId: string }): Promise<boolean> {
  return api().eraSave(era);
}

export async function deleteOutlineEra(eraId: string): Promise<boolean> {
  return api().eraDelete(eraId);
}

// ── 绑定 / 拍入 / 批量整存 ──

/** 「由此大纲创建作品」：返回新作品 id；失败（并发绑定冲突）返回 null */
export async function bindOutlineWork(
  projectId: string,
  name: string,
  genre: string | null,
): Promise<string | null> {
  return api().bindWork(projectId, name, genre);
}

/** 章节拍入 / 取消拍入（eventId null = 取消） */
export async function linkChapterOutlineEvent(
  chapterId: string,
  eventId: string | null,
): Promise<boolean> {
  return api().chapterLink(chapterId, eventId);
}

/** 批量整存（撤销栈回放 / 数据迁移专用）：单事务整体替换六表内容 */
export async function bulkSaveOutline(
  projectId: string,
  payload: {
    lanes: OutlineLaneDTO[];
    events: OutlineEventDTO[];
    entities: OutlineEntityDTO[];
    casts: OutlineCastDTO[];
    zones: OutlineZoneDTO[];
    eras: OutlineEraDTO[];
  },
): Promise<boolean> {
  return api().bulkSave(projectId, payload);
}
