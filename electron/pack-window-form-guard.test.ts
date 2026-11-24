/**
 * 行囊条幅窗形态守卫（spec：docs/spec/pack-quickcard-spec.md v1.3，FR-11）
 *
 * 条幅形态是「边写边记账」的核心承诺，退化路径都很静默：
 * - `maximizable` 默认 true，谁顺手删掉这行窗口就恢复可最大化，作者一点
 *   「最大化」条幅变整屏（与编辑器争屏），断点重校（FR-12）随即全部失真；
 * - 宽度上限若不 clamp 到工作区一半，中条幅 720 在小屏上会横跨半屏以上；
 * - `forwardMaximizeState` 若误挂回 pack 窗口，标题栏会照推最大化状态
 *   （尽管按钮已隐藏），`window-maximize-state` 的订阅方会拿到假信号。
 *
 * 按仓库惯例钉在源码上（同 `novel-pack-save-order.test.ts` 的做法）：
 * 断言 `main.ts` 的窗口创建段与 IPC 段的真实文本。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

/** 截取 createPackWindow 函数体（到下一个窗口创建函数为止） */
function packSection(): string {
  const start = MAIN.indexOf("function createPackWindow");
  const next = MAIN.indexOf("// ── GlobalSettingWindow", start);
  return MAIN.slice(start, next > start ? next : undefined);
}

describe("行囊条幅窗形态（FR-11）", () => {
  it("禁最大化 / 全屏：maximizable 与 fullscreenable 必须显式为 false", () => {
    const section = packSection();
    expect(section).toContain("maximizable: false");
    expect(section).toContain("fullscreenable: false");
  });

  it("不再推送最大化状态（forwardMaximizeState 不挂在 pack 窗口上）", () => {
    const section = packSection();
    expect(section).not.toContain("forwardMaximizeState(packWin)");
  });

  it("默认宽度是条幅档位（台账 400），不再是 1080 大窗", () => {
    const section = packSection();
    expect(section).toContain("PACK_BAND.ledger");
    expect(section).not.toMatch(/width:\s*1080/);
  });

  it("宽度上限按工作区一半 clamp（min(880, 工作区 × 0.5)）", () => {
    expect(MAIN).toContain("workArea.width * 0.5");
  });

  it("渲染层可请求改宽（pack-window-set-band 通道存在且 clamp 后 setSize）", () => {
    expect(MAIN).toContain('"pack-window-set-band"');
    const start = MAIN.indexOf('"pack-window-set-band"');
    const body = MAIN.slice(start, start + 1200);
    expect(body).toContain("clampPackBand");
    expect(body).toContain("setSize");
  });

  it("preload 暴露 packWindow.setBand，契约与 electron.d.ts 一致", () => {
    const preload = readFileSync(path.resolve(process.cwd(), "electron/preload.ts"), "utf8");
    expect(preload).toContain("pack-window-set-band");
    const types = readFileSync(
      path.resolve(process.cwd(), "src/shared/types/electron.d.ts"),
      "utf8",
    );
    expect(types).toContain("packWindow");
    expect(types).toContain("setBand");
  });
});
