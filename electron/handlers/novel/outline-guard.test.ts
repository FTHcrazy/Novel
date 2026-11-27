/**
 * 大纲工作台守卫（outline-plan-spec v7.1 §17）
 *
 * 大纲域的核心不变量最容易在后续改动中被悄悄破坏：六表混进章节域字段、
 * 位置语义被坐标列腐蚀、删事件忘记清章节引用、绑定丢事务、软删除被改成
 * 物理删除。better-sqlite3 的 native 按 Electron ABI 编译，vitest（node 进程）
 * 跑不了真实建库，所以与 `novel-db-split.test.ts` 同口径，把不变量钉在源码上。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUTLINE_HANDLERS = readFileSync(
  path.resolve(process.cwd(), "electron/handlers/novel/outline-handlers.ts"),
  "utf8",
);
const SAFETY_HANDLERS = readFileSync(
  path.resolve(process.cwd(), "electron/handlers/novel/novel-safety-handlers.ts"),
  "utf8",
);
const NOVEL_HANDLERS = readFileSync(
  path.resolve(process.cwd(), "electron/handlers/novel/novel-handlers.ts"),
  "utf8",
);
const NOVEL_DB = readFileSync(
  path.resolve(process.cwd(), "electron/novel/novel-db.ts"),
  "utf8",
);
const PRELOAD = readFileSync(path.resolve(process.cwd(), "electron/preload.ts"), "utf8");
const MAIN = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
const OUTLINE_SERVICE = readFileSync(
  path.resolve(
    process.cwd(),
    "src/windows/NovelWindow/pages/NovelPage/services/outline-service.ts",
  ),
  "utf8",
);
const ELECTRON_TYPES = readFileSync(
  path.resolve(process.cwd(), "src/shared/types/electron.d.ts"),
  "utf8",
);
const OUTLINE_PAGE = readFileSync(
  path.resolve(process.cwd(), "src/windows/NovelWindow/pages/OutlinePage/OutlinePage.tsx"),
  "utf8",
);

/** 六张大纲表（projects 是唯一挂作品点，不在此列） */
const SIX_TABLES = [
  "novel_outline_lanes",
  "novel_outline_events",
  "novel_outline_entities",
  "novel_outline_casts",
  "novel_outline_zones",
  "novel_outline_eras",
] as const;

describe("大纲域守卫（outline-plan-spec v7.1 §17）", () => {
  it("七表全部建在 novel.db（不是宿主库）", () => {
    for (const table of [...SIX_TABLES, "novel_outline_projects"]) {
      expect(NOVEL_DB, `novel.db 缺少 ${table}`).toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      );
    }
    expect(NOVEL_DB).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ol_projects_work",
    );
    // 部分唯一索引必须带 WHERE：多份草稿（work_id NULL）不受限
    expect(NOVEL_DB).toContain("WHERE work_id IS NOT NULL");
  });

  it("novel_chapters.outline_event_id 增量迁移存在（compat 通道）", () => {
    expect(NOVEL_DB).toContain("ADD COLUMN outline_event_id TEXT");
    expect(NOVEL_DB).toContain("idx_novel_chapters_outline_event");
  });

  it("六表无章节域字段（独立性守卫）", () => {
    for (const table of SIX_TABLES) {
      // 从建表语句里截出该表的列定义，断言不出现章节域字段
      const start = NOVEL_DB.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      expect(start, `${table} 建表语句应在 novel-db.ts 中`).toBeGreaterThanOrEqual(0);
      const body = NOVEL_DB.slice(start, NOVEL_DB.indexOf(");", start));
      expect(body, `${table} 不得出现 chapter_id`).not.toContain("chapter_id");
      expect(body, `${table} 不得出现 volume_id`).not.toContain("volume_id");
    }
  });

  it("事件表无坐标列（位置 = (lane_id, slot, sort) 唯一语义）", () => {
    const start = NOVEL_DB.indexOf("CREATE TABLE IF NOT EXISTS novel_outline_events (");
    const body = NOVEL_DB.slice(start, NOVEL_DB.indexOf(");", start));
    for (const column of ["layout_x", "layout_y", "pos_x", "pos_y", "fx", "fy"]) {
      expect(body, `事件表不得出现坐标列 ${column}`).not.toContain(column);
    }
    // 浮卡坐标只允许存在 casts 上
    const castStart = NOVEL_DB.indexOf("CREATE TABLE IF NOT EXISTS novel_outline_casts (");
    const castBody = NOVEL_DB.slice(castStart, NOVEL_DB.indexOf(");", castStart));
    expect(castBody).toContain("card_x");
    expect(castBody).toContain("card_y");
  });

  it("删事件同事务级联清章节拍入引用（悬挂引用零容忍）", () => {
    const start = OUTLINE_HANDLERS.indexOf("novel-outline-event-delete");
    const body = OUTLINE_HANDLERS.slice(start, start + 900);
    expect(body).toContain("db.transaction");
    expect(body).toContain("outline_event_id = NULL WHERE outline_event_id");
  });

  it("删泳道：事件转待归类（lane_id 置 NULL）+ 浮卡收回（card_x/y 置 NULL）", () => {
    const start = OUTLINE_HANDLERS.indexOf("novel-outline-lane-delete");
    const body = OUTLINE_HANDLERS.slice(start, start + 1400);
    expect(body).toContain("db.transaction");
    expect(body).toContain("SET lane_id = NULL");
    expect(body).toContain("card_x = NULL, card_y = NULL");
    // 线上区域随删；era 跨线不动（不得出现 era 删除）
    expect(body).toContain("DELETE FROM novel_outline_zones WHERE lane_id = ?");
    expect(body).not.toContain("novel_outline_eras");
  });

  it("绑定事务：建书 + 绑定同一个 db.transaction；失败回滚返回 null", () => {
    const start = OUTLINE_HANDLERS.indexOf("novel-outline-bind-work");
    const body = OUTLINE_HANDLERS.slice(start, start + 2200);
    expect(body).toContain("db.transaction");
    expect(body).toContain("INSERT INTO novel_works");
    expect(body).toContain("UPDATE novel_outline_projects SET work_id = ?");
    expect(body).toContain("return null");
  });

  it("同一事件同一实体唯一：cast-set 走 ON CONFLICT（幂等），cast-move 先查重", () => {
    expect(OUTLINE_HANDLERS).toContain("ON CONFLICT(event_id, entity_id) DO UPDATE");
    const moveStart = OUTLINE_HANDLERS.indexOf("novel-outline-cast-move");
    const moveBody = OUTLINE_HANDLERS.slice(moveStart, moveStart + 1200);
    expect(moveBody).toContain("return false");
    expect(moveBody).toContain("DELETE FROM novel_outline_casts");
  });

  it("删除大纲走软删除（project-trash 只打 deleted_at，不物理删）", () => {
    const start = OUTLINE_HANDLERS.indexOf("novel-outline-project-trash");
    const body = OUTLINE_HANDLERS.slice(start, start + 500);
    expect(body).toContain("deleted_at = ?");
    expect(body).not.toContain("DELETE FROM");
  });

  it("新建草稿自带默认「主线」车道（空画布必须有可落格的轨道行）", () => {
    // 零车道的画布没有命中区：托盘 / 搜索里的卡片拖进来命不中目标，
    // 新建事件也只能落到待归类 —— 用户看到的就是「空白画布拖不进东西」。
    const start = OUTLINE_HANDLERS.indexOf('"novel-outline-project-create"');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = OUTLINE_HANDLERS.slice(start, start + 1400);
    expect(body).toContain("db.transaction");
    expect(body).toContain("INSERT INTO novel_outline_lanes");
    expect(body).toContain("DEFAULT_LANE_NAME");
    // 既有草稿（机制之前建的）装载时就地补齐，不能只靠新建路径
    expect(OUTLINE_HANDLERS).toContain("if (lanes.length === 0)");
    expect(OUTLINE_HANDLERS).toContain("ensureDefaultLane(projectId)");
  });

  it("回收站：outline 类条目进列表、恢复只清标记、恢复后 work_id 不动", () => {
    expect(SAFETY_HANDLERS).toContain('"outline"');
    expect(SAFETY_HANDLERS).toContain("'outline'");
    const restoreStart = SAFETY_HANDLERS.indexOf('if (kind === "outline")');
    const restoreBody = SAFETY_HANDLERS.slice(restoreStart, restoreStart + 500);
    expect(restoreBody).toContain("SET deleted_at = NULL");
    expect(restoreBody).not.toContain("DELETE FROM");
    // 删作品同批打标其大纲（恢复作品同批放出）
    expect(SAFETY_HANDLERS).toContain(
      "UPDATE novel_outline_projects SET deleted_at = ? WHERE work_id = ?",
    );
  });

  it("彻底删除作品级联清六表（novel-work-delete 内）", () => {
    for (const table of [...SIX_TABLES, "novel_outline_projects"]) {
      expect(NOVEL_HANDLERS, `novel-work-delete 应级联清 ${table}`).toContain(
        `DELETE FROM ${table}`,
      );
    }
  });

  it("novel-outline-load 返回值恒为纯 JSON 字符串（跨 IPC 三道克隆的公共子集）", () => {
    const start = OUTLINE_HANDLERS.indexOf('ipcMain.handle("novel-outline-load"');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = OUTLINE_HANDLERS.slice(start, start + 1000);
    expect(body).toContain("): string | null =>");
    expect(body).toContain("toOutlineIpcJson(bundle)");
    // v8.serialize 自检只覆盖 Node 侧，不能替代 Electron / contextBridge 的克隆
    expect(OUTLINE_HANDLERS).not.toContain("v8.serialize(");
    expect(PRELOAD).toMatch(
      /load:\s*\(projectId: string\)\s*=>\s*trackedInvoke\('novel-outline-load', projectId\) as Promise<string \| null>/,
    );
    expect(ELECTRON_TYPES).toContain(
      "load: (projectId: string) => Promise<string | null>",
    );
    expect(OUTLINE_SERVICE).toContain("parseOutlineLoadPayload(await api().load(projectId))");
    expect(OUTLINE_SERVICE).toContain("structuredClone(parsed)");
  });

  it("大纲装载只有一条 effect 入口，显式切换不被 in-flight 去重吞掉", () => {
    // 曾经 openRequest 与 visible 两条 effect 各调一次 openDraft，稳定双调用
    const calls = [...OUTLINE_PAGE.matchAll(/void openDraft\(/g)].length;
    expect(calls).toBe(2); // 一条是带 token 的显式请求，一条是默认打开（同一 effect 的两个分支）
    expect(OUTLINE_PAGE).toContain("handledRequestRef");
    expect(OUTLINE_PAGE).not.toContain("void load(");
  });

  it("preload 暴露 outline 命名空间且通道与 handler 一一对应", () => {
    const channels = [...OUTLINE_HANDLERS.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(channels.length).toBeGreaterThan(15);
    for (const channel of channels) {
      expect(PRELOAD, `preload 缺少通道 ${channel}`).toContain(`'${channel}'`);
    }
    expect(MAIN).toContain("registerOutlineHandlers()");
  });
});
