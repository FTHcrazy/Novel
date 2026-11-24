/**
 * 盘点台账（quickcard）纯函数层 —— spec：docs/spec/pack-quickcard-spec.md v1.3
 *
 * 台账是行囊文档的新数据区段（`doc.quickcard`），随整文档走草稿 / 保存 /
 * 关闭守卫 —— 本文件只放**无 IO 的领域规则**，供组件与单测共用：
 *
 * - 余额不变式：`resource.count === Σ logs[kind≠void].delta`（守卫级，
 *   `verifyLedgerInvariant` 断言；创建资源时写一条 `init` 流水保证它成立）；
 * - 流水截断：每资源最多 `LEDGER_LOG_KEEP` 条，超出丢弃最旧，被截非 void
 *   流水的净额结转成前置 init 流水（保余额不变式；void 记录也占额位 ——
 *   审计记录与普通记录同寿命，见 spec RK-02）；
 * - 进度型：`cap` 仅作展示与超限判定（`isOverCap`），不参与任何校验，
 *   超限允许（剧情常写「突破上限」）；
 * - 模板：按题材预填资源行（清单依据 spec 附录 A 调研），追加同名跳过。
 *
 * 不 import React、不碰 IPC —— 依赖方向：组件 → 本文件 → 类型契约。
 */
import type {
  PackQuickcardDTO,
  PackQuickcardFieldDTO,
  PackQuickcardLogDTO,
  PackQuickcardResourceDTO,
} from "@/shared/types/electron";

/** 领域别名（与 types.ts 其它别名的分工一致：台账是本文件的地盘） */
export type LedgerResource = PackQuickcardResourceDTO;
export type LedgerLog = PackQuickcardLogDTO;
export type LedgerField = PackQuickcardFieldDTO;
export type LedgerSection = PackQuickcardDTO;

/** 空台账（装载兜底与新建作品起点） */
export const EMPTY_LEDGER: LedgerSection = { resources: [], logs: [], fields: [] };

/** 每资源保留的流水条数（spec FR-03：估算上限 50，超出丢弃最旧、不进回收） */
export const LEDGER_LOG_KEEP = 50;

/** 资源条数上限（spec FR-02：达到后添加入口置灰） */
export const LEDGER_RESOURCE_MAX = 100;

/** 记账备注长度上限（与 character.note 的展示口径一致，防整文档膨胀） */
export const LEDGER_NOTE_MAX = 60;

// ── 资源模板（spec 附录 A：题材调研校准，v1.3） ──

export interface LedgerTemplateItem {
  name: string;
  kind: "counter" | "progress";
  /** 仅进度型可带出厂上限（如「好感度」习惯满值 100）；留空由作者自填 */
  cap?: number;
}

export interface LedgerTemplate {
  key: string;
  label: string;
  /** 模板 Popover 里的一行预览（「积分 / 属性点 / …」） */
  desc: string;
  resources: LedgerTemplateItem[];
}

/**
 * ◈ 进度型资源只由模板带入，手动添加资源默认余额型（RK-07 应对：
 * 控制双概念的认知成本）。措辞为估算值，文案定稿前可只调本表。
 */
export const LEDGER_TEMPLATES: LedgerTemplate[] = [
  { key: "blank", label: "空白", desc: "不预填，直接自建", resources: [] },
  {
    key: "system",
    label: "系统流",
    desc: "积分 / 属性点 / 抽奖券 / 经验◈ / 情绪值◈",
    resources: [
      { name: "系统积分", kind: "counter" },
      { name: "属性点", kind: "counter" },
      { name: "抽奖券", kind: "counter" },
      { name: "经验值", kind: "progress" },
      { name: "情绪值", kind: "progress" },
    ],
  },
  {
    key: "game",
    label: "游戏流",
    desc: "经验◈ / 金币 / 生命值◈ / 熟练度◈ / 属性点",
    resources: [
      { name: "经验值", kind: "progress" },
      { name: "金币", kind: "counter" },
      { name: "生命值", kind: "progress" },
      { name: "技能熟练度", kind: "progress" },
      { name: "属性点", kind: "counter" },
    ],
  },
  {
    key: "xianxia",
    label: "玄幻修仙",
    desc: "灵石 / 贡献点 / 丹药 / 寿元◈",
    resources: [
      { name: "灵石", kind: "counter" },
      { name: "贡献点", kind: "counter" },
      { name: "丹药", kind: "counter" },
      { name: "寿元", kind: "progress" },
    ],
  },
  {
    key: "urban",
    label: "现代都市",
    desc: "现金 / 存款 / 系统积分",
    resources: [
      { name: "现金", kind: "counter" },
      { name: "存款", kind: "counter" },
      { name: "系统积分", kind: "counter" },
    ],
  },
  {
    key: "western",
    label: "西幻奇幻",
    desc: "金币 / 魔晶 / 声望◈",
    resources: [
      { name: "金币", kind: "counter" },
      { name: "魔晶", kind: "counter" },
      { name: "声望", kind: "progress" },
    ],
  },
];

// ── 解析与兜底 ──

/**
 * 解析台账区段：历史文档 / 旧草稿没有 `quickcard` 格，或 JSON 半残时
 * 一律按空台账处理（spec FR-07）—— 解析不崩是硬要求，台账是新增区段，
 * 任何兜底失败都会让整份行囊文档打不开。
 */
export function parseLedgerSection(value: unknown): LedgerSection {
  if (!value || typeof value !== "object") return EMPTY_LEDGER;
  const raw = value as Partial<LedgerSection>;
  const isResource = (item: unknown): item is LedgerResource =>
    Boolean(item) &&
    typeof (item as LedgerResource).id === "string" &&
    typeof (item as LedgerResource).name === "string" &&
    ((item as LedgerResource).kind === "counter" || (item as LedgerResource).kind === "progress") &&
    typeof (item as LedgerResource).count === "number";
  const isLog = (item: unknown): item is LedgerLog =>
    Boolean(item) &&
    typeof (item as LedgerLog).id === "string" &&
    typeof (item as LedgerLog).resourceId === "string" &&
    typeof (item as LedgerLog).delta === "number";
  const isField = (item: unknown): item is LedgerField =>
    Boolean(item) && typeof (item as LedgerField).id === "string";
  return {
    resources: Array.isArray(raw.resources) ? raw.resources.filter(isResource) : [],
    logs: Array.isArray(raw.logs) ? raw.logs.filter(isLog) : [],
    fields: Array.isArray(raw.fields) ? raw.fields.filter(isField) : [],
  };
}

// ── 余额不变式 ──

/** 流水累计（排除 void 作废记录）。余额不变式的唯一求和口径。 */
export function sumLedgerLogs(resourceId: string, logs: LedgerLog[]): number {
  let total = 0;
  for (const log of logs) {
    if (log.resourceId !== resourceId || log.kind === "void") continue;
    total += log.delta;
  }
  return total;
}

/** 余额不变式：`count === Σ 非void流水`。守卫测试与开发期断言用。 */
export function verifyLedgerInvariant(section: LedgerSection): boolean {
  for (const resource of section.resources) {
    if (resource.count !== sumLedgerLogs(resource.id, section.logs)) return false;
  }
  return true;
}

// ── 记账 / 盘点 / 撤销 ──

export interface LedgerMutation {
  resources: LedgerResource[];
  logs: LedgerLog[];
}

/** 定序：sortOrder 升序，同序按创建次序（数组原序）稳定排列 */
export function sortLedgerResources(resources: LedgerResource[]): LedgerResource[] {
  return [...resources].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * 记一笔账（±delta）：返回新的资源与流水数组；找不到资源或 delta 非法时
 * 返回 null（调用方按「无操作」处理，不产生流水）。
 *
 * 流水 `balance` 冗余存变动后余额 —— 展示与校验双用途（spec FR-07）。
 */
export function applyLedgerAdjust(
  section: LedgerSection,
  resourceId: string,
  delta: number,
  log: Omit<LedgerLog, "resourceId" | "kind" | "delta" | "balance">,
): LedgerMutation | null {
  if (!Number.isFinite(delta) || delta === 0) return null;
  const resource = section.resources.find((row) => row.id === resourceId);
  if (!resource) return null;
  const balance = resource.count + delta;
  const entry: LedgerLog = {
    ...log,
    resourceId,
    kind: "adjust",
    delta,
    balance,
    note: (log.note ?? "").slice(0, LEDGER_NOTE_MAX) || undefined,
  };
  return {
    resources: section.resources.map((row) =>
      row.id === resourceId ? { ...row, count: balance } : row,
    ),
    logs: trimLedgerLogs([...section.logs, entry], resourceId),
  };
}

/**
 * 盘点核对（FR-04）：输入实际值，差值生成一条 `audit` 修正流水。
 * 输入 = 当前余额时返回 null（调用方提示「账实一致」，不写流水）。
 */
export function applyLedgerAudit(
  section: LedgerSection,
  resourceId: string,
  actual: number,
  log: Omit<LedgerLog, "resourceId" | "kind" | "delta" | "balance">,
): LedgerMutation | null {
  if (!Number.isFinite(actual)) return null;
  const resource = section.resources.find((row) => row.id === resourceId);
  if (!resource || actual === resource.count) return null;
  const delta = actual - resource.count;
  const entry: LedgerLog = {
    ...log,
    resourceId,
    kind: "audit",
    delta,
    balance: actual,
    note: (log.note ?? `盘点修正：输入 ${actual}`).slice(0, LEDGER_NOTE_MAX),
  };
  return {
    resources: section.resources.map((row) =>
      row.id === resourceId ? { ...row, count: actual } : row,
    ),
    logs: trimLedgerLogs([...section.logs, entry], resourceId),
  };
}

/**
 * 撤销最后一笔（FR-03）：该资源最近一条**未作废**流水标 void、余额回退。
 * 没有可撤销的流水时返回 null（调用方提示「已无可撤销」）。
 * void 保留记录（灰色划线展示、不计入余额）—— 账目可审计，不物理删除。
 */
export function voidLastLedgerLog(section: LedgerSection, resourceId: string): LedgerMutation | null {
  const resource = section.resources.find((row) => row.id === resourceId);
  if (!resource) return null;
  let last: LedgerLog | null = null;
  for (const log of section.logs) {
    if (log.resourceId === resourceId && log.kind !== "void") last = log;
  }
  if (!last) return null;
  const resources = section.resources.map((row) =>
    row.id === resourceId ? { ...row, count: row.count - last.delta } : row,
  );
  const logs = section.logs.map((log) =>
    log === last ? { ...log, kind: "void" as const } : log,
  );
  return { resources, logs };
}

/**
 * 截断某资源的流水到最近 `LEDGER_LOG_KEEP` 条（新流水在尾部追加，
 * 截最旧 = 数组前部）。其它资源的流水不受影响。
 *
 * 被截掉的非 void 流水净额**结转**为一条前置 init 流水（note「更早流水结转」）：
 * 否则旧 delta 随截断消失、`count === Σ 非 void delta` 的余额不变式被打破。
 * 净额为 0（或只截到 void 记录）时不需要结转。
 */
function trimLedgerLogs(logs: LedgerLog[], resourceId: string): LedgerLog[] {
  const own = logs.filter((log) => log.resourceId === resourceId);
  if (own.length <= LEDGER_LOG_KEEP) return logs;

  const newest = own.slice(-LEDGER_LOG_KEEP);
  const older = own.slice(0, own.length - LEDGER_LOG_KEEP);
  let carriedDelta = 0;
  let carryBase: LedgerLog | null = null;
  for (const log of older) {
    if (log.kind !== "void") {
      carriedDelta += log.delta;
      carryBase ??= log;
    }
  }
  const others = logs.filter((log) => log.resourceId !== resourceId);
  if (carriedDelta !== 0 && carryBase) {
    // 结转条目占一个额位：把 newest 最旧的一条也并进结转净额，总额仍 ≤ KEEP
    const bumped = newest[0];
    if (bumped && bumped.kind !== "void") carriedDelta += bumped.delta;
    // id 复用被截最旧那条非 void 流水的 id（原记录已删除，不产生新冲突）
    const carry: LedgerLog = {
      ...carryBase,
      kind: "init",
      delta: carriedDelta,
      balance: carriedDelta,
      note: "更早流水结转",
    };
    return [...others, carry, ...newest.slice(1)];
  }
  return [...others, ...newest];
}

/** 该资源是否还有可撤销的流水（「撤销最后一笔」按钮的可用性） */
export function hasRevokableLog(resourceId: string, logs: LedgerLog[]): boolean {
  return logs.some((log) => log.resourceId === resourceId && log.kind !== "void");
}

/** 展示用流水（某资源、最新在前、至多 KEEP 条） */
export function listLedgerLogs(resourceId: string, logs: LedgerLog[]): LedgerLog[] {
  return logs.filter((log) => log.resourceId === resourceId).slice().reverse();
}

// ── 进度型 ──

/** 超上限判定：仅进度型且已设上限时有意义；上限不参与校验（只作提示） */
export function isOverCap(resource: LedgerResource): boolean {
  return resource.kind === "progress" && typeof resource.cap === "number" && resource.count > resource.cap;
}

/** 进度百分比（0–100，cap 未设 / 非法时 null = 不画进度条） */
export function ledgerProgressPercent(resource: LedgerResource): number | null {
  if (resource.kind !== "progress" || typeof resource.cap !== "number" || resource.cap <= 0) return null;
  return Math.max(0, Math.min(100, (resource.count / resource.cap) * 100));
}

// ── 资源增删改排 ──

/** 台账已满？ */
export function isLedgerFull(resources: LedgerResource[]): boolean {
  return resources.length >= LEDGER_RESOURCE_MAX;
}

/** 添加资源（不写流水；初始余额由调用方按「初始值 = Σ流水」配 init 流水） */
export function buildLedgerResource(
  id: string,
  name: string,
  kind: "counter" | "progress",
  sortOrder: number,
  cap?: number,
  unit?: string,
): LedgerResource {
  const trimmed = name.trim().slice(0, 20);
  return {
    id,
    name: trimmed || "未命名资源",
    kind,
    count: 0,
    cap: kind === "progress" && typeof cap === "number" && cap > 0 ? cap : undefined,
    unit: unit?.trim().slice(0, 6) || undefined,
    sortOrder,
  };
}

/** init 流水（创建资源时必写，保证余额不变式在 0 值成立） */
export function buildInitLog(
  id: string,
  resourceId: string,
  ts: number,
  chapterId?: string,
): LedgerLog {
  return { id, resourceId, kind: "init", delta: 0, balance: 0, ts, chapterId };
}

/** 资源名是否重复（允许并存，仅用于非阻断提示） */
export function hasDuplicateLedgerName(resources: LedgerResource[], name: string, excludeId?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return resources.some((row) => row.name === trimmed && row.id !== excludeId);
}

/**
 * 套用资源模板（FR-02）：**追加**（余额 0 + 各一条 init 流水），同名跳过。
 * 返回 null 表示模板没有带来任何新资源（调用方提示「资源已齐全」）。
 */
export function applyLedgerTemplate(
  section: LedgerSection,
  template: LedgerTemplate,
  createId: (suffix: string) => string,
  ts: number,
  chapterId?: string,
): LedgerMutation | null {
  const existing = new Set(section.resources.map((row) => row.name));
  const additions = template.resources.filter((item) => !existing.has(item.name));
  if (additions.length === 0) return null;
  let sortOrder = section.resources.reduce((max, row) => Math.max(max, row.sortOrder), 0);
  const resources = [...section.resources];
  const logs = [...section.logs];
  for (const item of additions) {
    sortOrder += 1;
    const id = createId(item.name);
    resources.push(buildLedgerResource(id, item.name, item.kind, sortOrder, item.cap));
    logs.push(buildInitLog(createId("log"), id, ts, chapterId));
  }
  return { resources, logs };
}

/** 删除资源：连同其全部流水（FR-02，二次确认由调用方负责） */
export function removeLedgerResource(section: LedgerSection, resourceId: string): LedgerMutation {
  return {
    resources: section.resources.filter((row) => row.id !== resourceId),
    logs: section.logs.filter((log) => log.resourceId !== resourceId),
  };
}

/** 拖拽 / 键盘重排：把 from 位置的行移动到 to 位置，其余按序补位 */
export function reorderLedgerResources(resources: LedgerResource[], from: number, to: number): LedgerResource[] {
  if (from === to || from < 0 || to < 0 || from >= resources.length || to >= resources.length) {
    return resources;
  }
  const next = [...resources];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((row, index) => (row.sortOrder === index + 1 ? row : { ...row, sortOrder: index + 1 }));
}

// ── 备注与规则备忘（FR-05：无预设的自由字段行） ──

/** 空态引导列举调研高频用法（spec 附录 A），不做预设数据 */
export const LEDGER_FIELD_HINTS = ["敌人战力表", "系统规则备忘", "兑换价格表"] as const;

/** 备注字段内容上限（防整文档膨胀；与资源名的截断口径不同：内容可较长） */
export const LEDGER_FIELD_VALUE_MAX = 2000;

export function sortLedgerFields(fields: LedgerField[]): LedgerField[] {
  return [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function buildLedgerField(id: string, name: string, sortOrder: number): LedgerField {
  return { id, name: name.trim().slice(0, 20) || "未命名字段", value: "", sortOrder };
}

// ── 导出（FR-10：文本逐行输出，复用 pack-export 的落盘通道） ──

function formatCount(resource: LedgerResource): string {
  if (resource.kind !== "progress" || typeof resource.cap !== "number") {
    return `${resource.count}${resource.unit ?? ""}`;
  }
  return `${resource.count}${resource.unit ?? ""}/${resource.cap}${resource.unit ?? ""}`;
}

/** 导出台账（资源 + 当前余额逐行） */
export function buildLedgerExport(section: LedgerSection, title: string): string {
  const lines: string[] = [`# ${title} · 盘点台账`, ""];
  const resources = sortLedgerResources(section.resources);
  if (resources.length === 0) lines.push("（台账为空）");
  for (const resource of resources) {
    lines.push(`- ${resource.name}：${formatCount(resource)}`);
  }
  return lines.join("\n");
}

/** 导出台账 + 流水明细（每资源一段，void 标注已撤销） */
export function buildLedgerExportWithLogs(section: LedgerSection, title: string): string {
  const head = buildLedgerExport(section, title);
  const lines: string[] = [head, "", "# 流水明细", ""];
  for (const resource of sortLedgerResources(section.resources)) {
    lines.push(`## ${resource.name}`);
    const logs = listLedgerLogs(resource.id, section.logs);
    if (logs.length === 0) lines.push("（无流水）");
    for (const log of logs) {
      const time = new Date(log.ts).toLocaleString();
      const mark = log.kind === "void" ? "（已撤销）" : "";
      const chapter = log.chapterId ? ` · ${log.chapterId}` : "";
      const note = log.note ? ` · ${log.note}` : "";
      lines.push(`- ${time}${chapter}：${log.delta > 0 ? "+" : ""}${log.delta} → ${log.balance}${mark}${note}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
