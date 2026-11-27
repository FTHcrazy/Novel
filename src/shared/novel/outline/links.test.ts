import { describe, expect, it } from "vitest";
import { boxFromRect, chainLinkPath, freeLinkPath, rectsHit, roundEdge } from "./links";

const box = (x: number, y: number, w = 208, h = 172) => boxFromRect({ x, y, w, h });

/** 从 path d 里取起点 / 终点坐标 */
function endsOf(d: string): { start: [number, number]; end: [number, number] } {
  const start = /M([-\d.]+) ([-\d.]+)/.exec(d);
  const nums = [...d.matchAll(/[-\d.]+/g)].map((m) => Number(m[0]));
  expect(start).not.toBeNull();
  return {
    start: [Number(start?.[1]), Number(start?.[2])],
    end: [nums[nums.length - 2], nums[nums.length - 1]],
  };
}

describe("links：连线几何（v9 原型同源）", () => {
  it("roundEdge：正对边取边中点，斜向落在圆角轮廓上（不超出矩形）", () => {
    const capsule = box(0, 0, 100, 28); // 浮卡胶囊，r=14
    const right = roundEdge(capsule, { x: 400, y: 14 }, 14);
    expect(right.x).toBeCloseTo(100, 5);
    expect(right.y).toBeCloseTo(14, 5);
    expect(right.nx).toBeCloseTo(1, 5);

    // 斜向射向右下圆角：落点内收到圆角上，法向是径向（两个分量都非零）
    const card = box(0, 0, 208, 172);
    const diag = roundEdge(card, { x: 104 + 400, y: 86 + 330 }, 12);
    expect(diag.x).toBeLessThan(208);
    expect(diag.y).toBeLessThan(172);
    expect(Math.abs(diag.nx)).toBeGreaterThan(0);
    expect(Math.abs(diag.ny)).toBeGreaterThan(0);
    expect(Math.hypot(diag.nx, diag.ny)).toBeCloseTo(1, 5);
  });

  it("freeLinkPath：三次贝塞尔，两端都贴在卡片轮廓上", () => {
    const host = box(300, 100);
    const card = box(520, 430, 96, 28);
    const d = freeLinkPath(card, host, [], 14, 12);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("C");

    const { start, end } = endsOf(d);
    // 起点在浮卡矩形范围内（贴着轮廓，不会跑到卡内深处）
    expect(start[0]).toBeGreaterThanOrEqual(520);
    expect(start[0]).toBeLessThanOrEqual(616);
    expect(start[1]).toBeGreaterThanOrEqual(430);
    expect(start[1]).toBeLessThanOrEqual(458);
    // 终点在宿主卡边上（四个边界之一）
    const onHost =
      Math.abs(end[0] - 300) < 0.6 ||
      Math.abs(end[0] - 508) < 0.6 ||
      Math.abs(end[1] - 100) < 0.6 ||
      Math.abs(end[1] - 272) < 0.6;
    expect(onHost).toBe(true);
  });

  it("freeLinkPath：中间有别的卡时整条曲线侧移避让", () => {
    const host = box(300, 100);
    const card = box(520, 430, 96, 28);
    const blocker = box(380, 200, 120, 120);
    expect(freeLinkPath(card, host, [])).not.toBe(freeLinkPath(card, host, [blocker]));
  });

  it("chainLinkPath：跨格走贝塞尔、同格走短直线、错位大走圆角肘", () => {
    const a = box(0, 100);
    const b = box(252, 100);
    const straight = chainLinkPath(a, b, "h", []);
    expect(straight.d).toContain("C");
    expect(straight.short).toBe(false);
    expect(straight.end).toEqual({ x: 252, y: 186 });

    const stacked = chainLinkPath(a, box(0, 300), "h", [], true);
    expect(stacked.short).toBe(true);
    expect(stacked.d).toBe("M104 272 L104 300");

    // 竖向错位 186、水平只隔 22 → 圆角直角肘（Q 圆角）
    const elbow = chainLinkPath(a, box(230, 300), "h", []);
    expect(elbow.d).toContain("Q");
    expect(elbow.end.x).toBe(230);
  });

  it("chainLinkPath：走廊里有卡时经中点分两段弧绕行", () => {
    const a = box(0, 100);
    const b = box(252, 100);
    const blocker = box(170, 60, 140, 200); // 横跨两卡之间的走廊
    const link = chainLinkPath(a, b, "h", [blocker]);
    expect((link.d.match(/C/g) ?? []).length).toBe(2);
    expect(link.end).toEqual({ x: 252, y: 186 });
  });

  it("rectsHit：只挑真正相交的框", () => {
    const boxes = [box(0, 0, 50, 50), box(100, 100, 50, 50)];
    expect(rectsHit(boxes, 40, 60, 40, 60)).toHaveLength(1);
    expect(rectsHit(boxes, 200, 260, 200, 260)).toHaveLength(0);
  });
});
