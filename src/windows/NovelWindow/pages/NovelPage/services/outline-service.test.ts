/**
 * 大纲装载载荷的渲染层解码守卫：
 * 主进程只返回 JSON 字符串，本层负责解码、结构校验与可克隆性断言。
 */
import { describe, expect, it } from "vitest";
import type { OutlineBundleDTO } from "@/shared/types/electron";
import { parseOutlineLoadPayload } from "./outline-service";

const BUNDLE: OutlineBundleDTO = {
  project: {
    id: "olp-1",
    name: "测试大纲",
    workId: null,
    updatedAt: 1,
    eventCount: 0,
  },
  lanes: [{ id: "ol-l-1", name: "时间线", note: "", sort: 0 }],
  events: [],
  entities: [],
  casts: [],
  zones: [],
  eras: [],
  chapterRefs: {},
};

describe("parseOutlineLoadPayload", () => {
  it("null / undefined 表示项目不存在", () => {
    expect(parseOutlineLoadPayload(null)).toBeNull();
    expect(parseOutlineLoadPayload(undefined)).toBeNull();
  });

  it("JSON 字符串解码为 DTO，且结果恒可被结构化克隆", () => {
    const decoded = parseOutlineLoadPayload(JSON.stringify(BUNDLE));
    expect(decoded).toEqual(BUNDLE);
    expect(() => structuredClone(decoded)).not.toThrow();
    expect(structuredClone(decoded)).toEqual(BUNDLE);
  });

  it("损坏 JSON 抛带业务语境的错误", () => {
    expect(() => parseOutlineLoadPayload("{not json")).toThrow(/大纲装载失败：返回数据损坏/);
  });

  it("结构不符合契约时抛错，不让 undefined 字段流进组件", () => {
    expect(() => parseOutlineLoadPayload(JSON.stringify({ project: {}, lanes: [] }))).toThrow(
      /返回数据结构不符合契约/,
    );
  });

  // ── QA 增补：边界值与脏数据 ──

  it('字面量 "null" 解码为空；非法载荷类型有独立错误文案', () => {
    expect(parseOutlineLoadPayload("null")).toBeNull();
    // 空串不是主进程的合法输出（只会给 null 或 JSON 文本），当前口径按空态兜底
    expect(parseOutlineLoadPayload("")).toBeNull();
    expect(() => parseOutlineLoadPayload(42 as unknown as string)).toThrow(
      /IPC 返回值不是 JSON 字符串/,
    );
  });

  it("数组 / 标量 / 缺字段 / 字段类型错误的结构一律拒绝", () => {
    const bad = [
      "[]",
      "1",
      '"str"',
      "{}",
      JSON.stringify({ ...BUNDLE, lanes: null }),
      JSON.stringify({ ...BUNDLE, project: { id: 123 } }),
      JSON.stringify({ ...BUNDLE, chapterRefs: [] }),
    ];
    for (const raw of bad) {
      expect(() => parseOutlineLoadPayload(raw), raw).toThrow(/返回数据结构不符合契约/);
    }
  });

  it("载荷里的 __proto__ 字段不污染原型，合法数据仍能读出", () => {
    const raw =
      '{"project":{"id":"olp-1","name":"x","workId":null,"updatedAt":1},' +
      '"lanes":[],"events":[],"entities":[],"casts":[],"zones":[],"eras":[],' +
      '"chapterRefs":{},"__proto__":{"polluted":true}}';
    const decoded = parseOutlineLoadPayload(raw);
    expect(decoded?.project.id).toBe("olp-1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("主进程脏对象经 JSON 载荷抵达渲染层后是干净 DTO（跨层往返）", () => {
    class Row {
      constructor(data: object) {
        Object.assign(this, data);
      }
    }
    // 模拟主进程 mapper 把 SQLite row 挂到自定义原型上
    const dirty = {
      ...BUNDLE,
      project: new Row(BUNDLE.project),
      lanes: BUNDLE.lanes.map((lane) => new Row(lane)),
    };
    const decoded = parseOutlineLoadPayload(JSON.stringify(dirty));
    expect(decoded).toEqual(BUNDLE);
    expect(Object.getPrototypeOf(decoded!.project)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(decoded!.lanes[0])).toBe(Object.prototype);
  });
});
