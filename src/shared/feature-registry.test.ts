/**
 * 构建期开关注册表守卫。
 *
 * 这套开关的设计目标是「新增一个裁剪项只改一行注册表」——那意味着**约定**必须被
 * 机器看住，否则下一个人很容易退回「每个开关写一段 if + 每侧各改一个文件」。
 * 这里钉四件事：
 *   1. 注册表条目的形状（env 命名 / 唯一 / 有 summary）；
 *   2. 求值语义（未设置取默认、显式关闭词才关、其它值一律开）；
 *   3. `cropsWindowEntry` 必须是真的窗口入口 key（写错会静默裁不掉产物）；
 *   4. 两个读取层文件里**不许出现新增开关的痕迹**（只许解引用 `__NOVEL_FEATURES__`）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOW_ENTRIES } from "../../electron/window-entries";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_REGISTRY,
  croppedWindowEntries,
  resolveFeatureFlags,
  type FeatureKey,
} from "./feature-registry";

const KEYS = Object.keys(FEATURE_REGISTRY) as FeatureKey[];

function read(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

describe("注册表形状", () => {
  it("每一项都有 NOVEL_WITH_ 前缀的 env、布尔默认值与一句话说明", () => {
    expect(KEYS.length).toBeGreaterThan(0);
    for (const key of KEYS) {
      const definition = FEATURE_REGISTRY[key];
      expect(definition.env, `${key}.env 命名不合约定`).toMatch(/^NOVEL_WITH_[A-Z0-9_]+$/);
      expect(typeof definition.defaultValue, `${key}.defaultValue`).toBe("boolean");
      expect(definition.summary.trim().length, `${key}.summary 不能为空`).toBeGreaterThan(0);
    }
  });

  it("env 变量名唯一（两个开关共用一个变量会互相顶掉）", () => {
    const envs = KEYS.map((key) => FEATURE_REGISTRY[key].env);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("默认值必须是「全功能」：默认态不得自带裁剪", () => {
    // 裁剪只能是显式选择；默认就关掉某项会让「没传参数」和「传了参数」变成两套行为
    for (const key of KEYS) {
      expect(FEATURE_REGISTRY[key].defaultValue, `${key} 默认应为开启`).toBe(true);
    }
  });

  it("cropsWindowEntry 必须是真实的窗口入口 key", () => {
    const entries = KEYS.map(
      (key) => FEATURE_REGISTRY[key].cropsWindowEntry as string | undefined,
    ).filter((entry): entry is string => typeof entry === "string");
    for (const entry of entries) {
      expect(WINDOW_ENTRIES as readonly string[]).toContain(entry);
    }
  });
});

describe("求值语义", () => {
  it("未设置 / 空串 → 取默认值", () => {
    expect(resolveFeatureFlags({})).toEqual(DEFAULT_FEATURE_FLAGS);
    const blank = Object.fromEntries(KEYS.map((key) => [FEATURE_REGISTRY[key].env, "  "]));
    expect(resolveFeatureFlags(blank)).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it("0 / false / off / no → 关闭（大小写不敏感）", () => {
    for (const value of ["0", "false", "OFF", "no", " False "]) {
      const env = Object.fromEntries(KEYS.map((key) => [FEATURE_REGISTRY[key].env, value]));
      const flags = resolveFeatureFlags(env);
      for (const key of KEYS) expect(flags[key], `${key} 应被 ${value} 关掉`).toBe(false);
    }
  });

  it("任何其它值 → 开启（不认识的取值不能把功能静默关掉）", () => {
    for (const value of ["1", "true", "yes", "on", "maybe"]) {
      const env = Object.fromEntries(KEYS.map((key) => [FEATURE_REGISTRY[key].env, value]));
      const flags = resolveFeatureFlags(env);
      for (const key of KEYS) expect(flags[key], `${key} 不该被 ${value} 关掉`).toBe(true);
    }
  });

  it("只关一个开关不影响其它开关", () => {
    const env = { [FEATURE_REGISTRY[KEYS[0]].env]: "0" };
    const flags = resolveFeatureFlags(env);
    expect(flags[KEYS[0]]).toBe(false);
    for (const key of KEYS.slice(1)) expect(flags[key]).toBe(true);
  });
});

describe("窗口入口裁剪", () => {
  it("默认态不裁任何窗口入口", () => {
    expect(croppedWindowEntries(resolveFeatureFlags({}))).toEqual([]);
  });

  it("关掉的开关按 cropsWindowEntry 裁掉对应窗口入口", () => {
    const env = { [FEATURE_REGISTRY.mapWindow.env]: "0" };
    expect(croppedWindowEntries(resolveFeatureFlags(env))).toEqual(["map"]);
  });

  it("裁掉的都是真实入口 key（写错会静默裁不掉产物）", () => {
    const env = Object.fromEntries(KEYS.map((key) => [FEATURE_REGISTRY[key].env, "0"]));
    for (const entry of croppedWindowEntries(resolveFeatureFlags(env))) {
      expect(WINDOW_ENTRIES as readonly string[]).toContain(entry);
    }
  });
});

describe("读取层不承载开关知识（新增开关只改注册表）", () => {
  /**
   * 两个读取层（主进程 / 渲染层）只许做一次 `__NOVEL_FEATURES__` 解引用。
   * 一旦有人在那里按开关写 `if (SOME_ENV)` 或再声明一份默认值，就等于把事实源
   * 拆成三份 —— 这条守卫负责当场拦下。
   */
  for (const file of ["src/shared/features.ts", "electron/feature-flags.ts"]) {
    it(`${file} 只解引用注入常量，不写自己的开关判断`, () => {
      const source = read(file);
      expect(source).toContain("declare const __NOVEL_FEATURES__");
      expect(source).toContain("__NOVEL_FEATURES__;");
      expect(source).not.toContain("process.env");
      expect(source).not.toContain("NOVEL_WITH_");
      // 旧的一次性常量已被注册表取代，不许回流
      expect(source).not.toContain("__NOVEL_FEATURE_MAP__");
    });
  }

  it("vite / vitest 配置都注入同一个常量名", () => {
    expect(read("vite.config.ts")).toContain("__NOVEL_FEATURES__");
    expect(read("vitest.config.ts")).toContain("__NOVEL_FEATURES__");
    // 构建配置也不许直接读某个具体变量：它只按注册表遍历求值
    expect(read("vite.config.ts")).not.toMatch(/process\.env\.[A-Z_]+/);
  });
});
