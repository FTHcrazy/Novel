/**
 * `novel-outline-load` 主进程载荷编码守卫。
 *
 * 这里只测纯函数（模块不 import electron / DB），对应 vitest.config.ts
 * 「electron/ 下只纳入不 import electron 运行时的测试」的约定。
 */
import { describe, expect, it } from "vitest";
import { toOutlineIpcJson } from "./outline-ipc-payload";

describe("toOutlineIpcJson（跨 IPC 载荷恒为纯 JSON）", () => {
  it("整包装载结果编码成字符串，解码后 structuredClone 必过", () => {
    const bundle = {
      project: { id: "olp-1", name: "测试", workId: null, updatedAt: 1 },
      lanes: [{ id: "ol-l-1", name: "线", note: "", sort: 0 }],
      events: [],
      entities: [],
      casts: [],
      zones: [],
      eras: [],
      chapterRefs: { "ol-e-1": 2 },
    };
    const payload = toOutlineIpcJson(bundle);
    expect(typeof payload).toBe("string");
    const decoded = JSON.parse(payload) as typeof bundle;
    expect(decoded).toEqual(bundle);
    // Node 与浏览器同源的结构化克隆：能过即证明载荷里没有原型 / 引用异常
    expect(() => structuredClone(decoded)).not.toThrow();
    expect(structuredClone(decoded)).toEqual(bundle);
  });

  it("自定义 prototype 与不可枚举形态被规整成普通 JSON 值", () => {
    class FakeRow {
      readonly id = "x";
    }
    const payload = toOutlineIpcJson({
      project: new FakeRow(),
      lanes: [Object.assign(Object.create(null) as object, { id: "l" })],
    });
    const decoded = JSON.parse(payload) as { project: unknown; lanes: unknown[] };
    expect(decoded).toEqual({ project: { id: "x" }, lanes: [{ id: "l" }] });
    expect(() => structuredClone(decoded)).not.toThrow();
  });

  it("null 保持 null；BigInt / 循环引用抛清晰错误而不是框架层克隆错误", () => {
    expect(toOutlineIpcJson(null)).toBe("null");
    expect(() => toOutlineIpcJson({ n: 1n })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toOutlineIpcJson(cyclic)).toThrow(TypeError);
  });

  /**
   * QA 增补：端到端往返，证明"字符串载荷"确实消掉了本次 bug 的根因。
   *
   * 旧路径的致命点是：Node 侧自检对"带自定义原型的 SQLite row"是绿灯——
   * structuredClone 克隆得动，但克隆出来的东西不在 Electron contextBridge
   * 的白名单里，于是线上只看到 `An object could not be cloned.`。只断言
   * "原对象可克隆"属于验证了个寂寞；必须模拟三道克隆（handler 返回 /
   * invoke 响应 / contextBridge）后仍是纯普通对象，才算证明修复有效。
   */
  it("脏 prototype 的 SQLite-row bundle：旧自检绿灯，新字符串载荷三道克隆后恒为纯 JSON", () => {
    // Arrange：模拟 mapper 产物——字段挂在自定义原型实例上，chapterRefs 是
    // SQLite 聚合常见的 null-prototype 字典，实例上还有不进 JSON 的 getter
    class OutlineRow {
      constructor(data: Record<string, unknown>) {
        Object.assign(this, data);
      }
      get shadow(): string {
        return "not-a-plain-json-value";
      }
    }
    const dirty = {
      project: new OutlineRow({ id: "olp-qa", name: "脏数据", workId: null, updatedAt: 42 }),
      lanes: [new OutlineRow({ id: "ol-l-1", name: "线", note: "", sort: 0 })],
      events: [],
      entities: [],
      casts: [],
      zones: [],
      eras: [],
      chapterRefs: Object.assign(Object.create(null) as Record<string, number>, {
        "ol-e-1": 2,
      }),
    };

    // 旧路径自检确实是绿灯 → 这正是当年漏判的原因（不是测试写错）
    expect(() => structuredClone(dirty)).not.toThrow();
    expect(Object.getPrototypeOf(dirty.project)).not.toBe(Object.prototype);
    expect(Object.getPrototypeOf(dirty.chapterRefs)).toBeNull();

    // Act：编码成字符串，再模拟三道独立的结构化克隆边界
    const wire = toOutlineIpcJson(dirty);
    expect(typeof wire).toBe("string");
    expect(wire).not.toContain("shadow"); // 原型上的 getter 不进载荷
    let decoded: unknown = JSON.parse(wire);
    for (let layer = 0; layer < 3; layer += 1) {
      decoded = structuredClone(decoded);
    }

    // Assert：三道克隆后原型被规整为 Object.prototype，数据无损
    const clean = decoded as typeof dirty;
    expect(Object.getPrototypeOf(clean.project)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(clean.lanes[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(clean.chapterRefs)).toBe(Object.prototype);
    expect(clean.project).toEqual({ id: "olp-qa", name: "脏数据", workId: null, updatedAt: 42 });
    expect(clean.chapterRefs).toEqual({ "ol-e-1": 2 });
    expect("shadow" in clean.project).toBe(false);
  });
});
