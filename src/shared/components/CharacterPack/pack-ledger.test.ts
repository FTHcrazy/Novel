/**
 * 盘点台账纯函数测试（spec：docs/spec/pack-quickcard-spec.md v1.3）
 *
 * 余额不变式（`count === Σ 非void流水`）是守卫级承诺：记账 / 盘点 / 撤销 /
 * 模板追加 / 重排五条编辑路径全部要在改动后仍成立 —— 任何一条破约，作者
 * 的账就对不上了（这正是本功能要防的「吃书」在工具侧的翻版）。
 */
import { describe, expect, it } from "vitest";
import type { LedgerSection } from "./pack-ledger";
import {
  applyLedgerAdjust,
  applyLedgerAudit,
  applyLedgerTemplate,
  buildInitLog,
  buildLedgerExport,
  buildLedgerField,
  buildLedgerResource,
  hasDuplicateLedgerName,
  isLedgerFull,
  LEDGER_LOG_KEEP,
  LEDGER_RESOURCE_MAX,
  LEDGER_TEMPLATES,
  listLedgerLogs,
  parseLedgerSection,
  removeLedgerResource,
  reorderLedgerResources,
  sortLedgerResources,
  sumLedgerLogs,
  verifyLedgerInvariant,
  voidLastLedgerLog,
} from "./pack-ledger";

let seq = 0;
const nextId = (suffix: string): string => `${suffix}-${(seq += 1)}`;

/** 造一个空台账 + 一个资源（含 init 流水），不变式天然成立 */
function sectionWithResource(kind: "counter" | "progress" = "counter"): LedgerSection {
  const id = nextId("res");
  const resource = buildLedgerResource(id, "灵石", kind, 1);
  return {
    resources: [resource],
    logs: [buildInitLog(nextId("log"), id, 1000, "ch-1")],
    fields: [],
  };
}

describe("余额不变式", () => {
  it("空台账恒成立", () => {
    expect(verifyLedgerInvariant({ resources: [], logs: [], fields: [] })).toBe(true);
  });

  it("init 流水（delta 0）成立", () => {
    expect(verifyLedgerInvariant(sectionWithResource())).toBe(true);
  });

  it("记账后成立：count 同步、流水 balance 记变动后余额", () => {
    const section = sectionWithResource();
    const id = section.resources[0].id;
    const next = applyLedgerAdjust(section, id, 500, {
      id: nextId("log"),
      ts: 2000,
      chapterId: "ch-2",
    });
    expect(next).not.toBeNull();
    const mutated = { ...section, resources: next!.resources, logs: next!.logs };
    expect(mutated.resources[0].count).toBe(500);
    expect(mutated.logs.at(-1)?.balance).toBe(500);
    expect(verifyLedgerInvariant(mutated)).toBe(true);
  });

  it("撤销后成立：void 不计入累计，余额回退", () => {
    const section = sectionWithResource();
    const id = section.resources[0].id;
    const adjusted = applyLedgerAdjust(section, id, 300, { id: nextId("log"), ts: 2000 });
    const after = { ...section, resources: adjusted!.resources, logs: adjusted!.logs };
    const undone = voidLastLedgerLog(after, id)!;
    const final = { ...after, resources: undone.resources, logs: undone.logs };
    expect(final.resources[0].count).toBe(0);
    expect(sumLedgerLogs(id, final.logs)).toBe(0);
    expect(final.logs.at(-1)?.kind).toBe("void");
    expect(verifyLedgerInvariant(final)).toBe(true);
  });

  it("盘点修正后成立：audit 流水把账拉回输入值", () => {
    const section = sectionWithResource();
    const id = section.resources[0].id;
    const adjusted = applyLedgerAdjust(section, id, 3500, { id: nextId("log"), ts: 2000 });
    const after = { ...section, resources: adjusted!.resources, logs: adjusted!.logs };
    const audited = applyLedgerAudit(after, id, 3200, { id: nextId("log"), ts: 3000 });
    const final = { ...after, resources: audited!.resources, logs: audited!.logs };
    expect(final.resources[0].count).toBe(3200);
    expect(audited!.logs.at(-1)?.delta).toBe(-300);
    expect(verifyLedgerInvariant(final)).toBe(true);
  });

  it("模板追加后成立", () => {
    const section = sectionWithResource();
    const template = LEDGER_TEMPLATES.find((item) => item.key === "system")!;
    const next = applyLedgerTemplate(section, template, nextId, 4000);
    const final = { ...section, resources: next!.resources, logs: next!.logs };
    expect(verifyLedgerInvariant(final)).toBe(true);
  });
});

describe("记账边界", () => {
  it("delta 0 / 非法输入不产生流水", () => {
    const section = sectionWithResource();
    const id = section.resources[0].id;
    expect(applyLedgerAdjust(section, id, 0, { id: "x", ts: 1 })).toBeNull();
    expect(applyLedgerAdjust(section, id, Number.NaN, { id: "x", ts: 1 })).toBeNull();
  });

  it("资源不存在返回 null", () => {
    expect(applyLedgerAdjust(sectionWithResource(), "nope", 1, { id: "x", ts: 1 })).toBeNull();
  });

  it("透支允许（余额为负不阻断，剧情可能真透支）", () => {
    const section = sectionWithResource();
    const id = section.resources[0].id;
    const next = applyLedgerAdjust(section, id, -100, { id: nextId("log"), ts: 1 });
    expect(next!.resources[0].count).toBe(-100);
  });

  it("流水超 50 条丢弃最旧（不进回收），其它资源不受影响", () => {
    let section = sectionWithResource();
    const id = section.resources[0].id;
    const other = applyLedgerAdjust(section, id, 1, { id: nextId("log"), ts: 1 })!;
    // 第二个资源：校验隔离
    section = {
      ...section,
      resources: [...other.resources, buildLedgerResource("res-2", "丹药", "counter", 2)],
      logs: other.logs,
    };
    for (let index = 0; index < LEDGER_LOG_KEEP + 5; index += 1) {
      const next = applyLedgerAdjust(section, id, 1, { id: nextId("log"), ts: index });
      section = { ...section, resources: next!.resources, logs: next!.logs };
    }
    expect(listLedgerLogs(id, section.logs).length).toBeLessThanOrEqual(LEDGER_LOG_KEEP);
    expect(section.logs.filter((log) => log.resourceId === "res-2").length).toBe(0);
    // 截断后不变式仍要成立（被截掉的旧流水与新余额一致地丢失）
    expect(verifyLedgerInvariant(section)).toBe(true);
  });

  it("没有可撤销的流水时返回 null", () => {
    expect(voidLastLedgerLog(sectionWithResource(), sectionWithResource().resources[0].id)).toBeNull();
  });
});

describe("进度型资源", () => {
  it("cap 参与展示：buildLedgerResource 只在进度型且 cap>0 时保留", () => {
    const progress = buildLedgerResource("p", "经验", "progress", 1, 6000);
    expect(progress.cap).toBe(6000);
    const counter = buildLedgerResource("c", "灵石", "counter", 1, 6000);
    expect(counter.cap).toBeUndefined();
    const bad = buildLedgerResource("b", "经验", "progress", 1, -5);
    expect(bad.cap).toBeUndefined();
  });

  it("超上限允许（不阻断），上限不参与任何校验", () => {
    const section = sectionWithResource("progress");
    const id = section.resources[0].id;
    const withCap = {
      ...section,
      resources: [{ ...section.resources[0], cap: 100 }],
    };
    const next = applyLedgerAdjust(withCap, id, 150, { id: nextId("log"), ts: 1 });
    expect(next!.resources[0].count).toBe(150);
    expect(verifyLedgerInvariant({ ...withCap, resources: next!.resources, logs: next!.logs })).toBe(true);
  });
});

describe("模板", () => {
  it("追加不覆盖：同名跳过", () => {
    const section = sectionWithResource(); // 资源名「灵石」
    const xuanxuan = LEDGER_TEMPLATES.find((item) => item.key === "xianxia")!;
    const next = applyLedgerTemplate(section, xuanxuan, nextId, 1000);
    expect(next).not.toBeNull();
    expect(next!.resources.some((row) => row.name === "灵石")).toBe(true);
    // 灵石只有一条（同名跳过）
    expect(next!.resources.filter((row) => row.name === "灵石").length).toBe(1);
  });

  it("资源已齐全时返回 null", () => {
    const section = sectionWithResource();
    const blank = LEDGER_TEMPLATES.find((item) => item.key === "blank")!;
    expect(applyLedgerTemplate(section, blank, nextId, 1000)).toBeNull();
  });

  it("模板 init 流水带章节上下文", () => {
    const section = { resources: [], logs: [], fields: [] };
    const template = LEDGER_TEMPLATES.find((item) => item.key === "urban")!;
    const next = applyLedgerTemplate(section, template, nextId, 1234, "ch-9");
    expect(next!.logs.every((log) => log.kind === "init" && log.chapterId === "ch-9")).toBe(true);
  });
});

describe("资源增删改排", () => {
  it("重排：from → to 补位，sortOrder 重写为 1..n", () => {
    const resources = ["甲", "乙", "丙"].map((name, index) =>
      buildLedgerResource(`r-${name}`, name, "counter", index + 1),
    );
    const next = reorderLedgerResources(resources, 0, 2);
    expect(next.map((row) => row.name)).toEqual(["乙", "丙", "甲"]);
    expect(next.map((row) => row.sortOrder)).toEqual([1, 2, 3]);
  });

  it("越界重排原样返回", () => {
    const resources = [buildLedgerResource("r", "灵石", "counter", 1)];
    expect(reorderLedgerResources(resources, 0, 5)).toBe(resources);
    expect(reorderLedgerResources(resources, -1, 0)).toBe(resources);
  });

  it("删除资源连流水一并删除", () => {
    const section = sectionWithResource();
    const id = section.resources[0].id;
    const next = removeLedgerResource(section, id);
    expect(next.resources).toHaveLength(0);
    expect(next.logs).toHaveLength(0);
  });

  it("资源上限 100 条", () => {
    const resources = Array.from({ length: LEDGER_RESOURCE_MAX }, (_, index) =>
      buildLedgerResource(`r-${index}`, `资源${index}`, "counter", index + 1),
    );
    expect(isLedgerFull(resources)).toBe(true);
    expect(isLedgerFull(resources.slice(0, 99))).toBe(false);
  });

  it("同名检测（排除自身）", () => {
    const section = sectionWithResource();
    const [resource] = section.resources;
    expect(hasDuplicateLedgerName(section.resources, "灵石")).toBe(true);
    expect(hasDuplicateLedgerName(section.resources, "灵石", resource.id)).toBe(false);
    expect(hasDuplicateLedgerName(section.resources, "丹药")).toBe(false);
  });
});

describe("解析兜底（spec FR-07 异常 #11）", () => {
  it("null / 非对象 / 坏数组一律按空台账", () => {
    expect(parseLedgerSection(null)).toEqual({ resources: [], logs: [], fields: [] });
    expect(parseLedgerSection("junk")).toEqual({ resources: [], logs: [], fields: [] });
    expect(parseLedgerSection({ resources: "nope", logs: [{}], fields: null })).toEqual({
      resources: [],
      logs: [],
      fields: [],
    });
  });

  it("合法数据过滤坏行后保留", () => {
    const parsed = parseLedgerSection({
      resources: [
        { id: "r1", name: "灵石", kind: "counter", count: 5, sortOrder: 1 },
        { id: "r2", name: "坏行" },
      ],
      logs: [{ id: "l1", resourceId: "r1", kind: "init", delta: 0, balance: 0, ts: 1 }],
      fields: [{ id: "f1", name: "备忘", value: "", sortOrder: 1 }],
    });
    expect(parsed.resources).toHaveLength(1);
    expect(parsed.logs).toHaveLength(1);
    expect(parsed.fields).toHaveLength(1);
  });
});

describe("备注字段与导出", () => {
  it("buildLedgerField 截断空白名", () => {
    expect(buildLedgerField("f", "  ", 1).name).toBe("未命名字段");
    expect(buildLedgerField("f", " 系统规则备忘 ", 1).name).toBe("系统规则备忘");
  });

  it("导出台账：进度型显示 当前/上限", () => {
    const section = sectionWithResource("progress");
    const text = buildLedgerExport(
      {
        ...section,
        resources: [{ ...section.resources[0], name: "经验值", count: 500, cap: 6000 }],
      },
      "测试",
    );
    expect(text).toContain("经验值：500/6000");
  });
});

describe("排序", () => {
  it("sortLedgerResources 按 sortOrder 稳定排列", () => {
    const resources = [
      buildLedgerResource("b", "乙", "counter", 2),
      buildLedgerResource("a", "甲", "counter", 1),
    ];
    expect(sortLedgerResources(resources).map((row) => row.name)).toEqual(["甲", "乙"]);
  });
});
