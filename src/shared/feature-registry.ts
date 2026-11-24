/**
 * 构建期特性开关**注册表** —— 唯一事实源。
 *
 * 本文件是纯数据 + 纯函数：不含 React、不碰 DOM / Node API，所以能被三方共用：
 * · `vite.config.ts`（Node，构建期）：遍历注册表读环境变量，把求值结果以
 *   `define: { __NOVEL_FEATURES__: <json> }` 注入每一份产物；
 * · `src/shared/features.ts`（渲染层）：只读注入常量；
 * · `electron/feature-flags.ts`（主进程）：只读注入常量。
 *
 * ## 新增一个开关（唯一需要动的地方）
 * 在 `FEATURE_REGISTRY` 里加一行即可，**不要**去改上面两个读取层文件：
 * 1. 键名 = 代码里 `FEATURES.xxx` 用的 camelCase 名；
 * 2. `env` = 关闭它的环境变量名，约定 `NOVEL_WITH_<UPPER_SNAKE>`
 *    （值 `0` / `false` / `off` / `no` 视为关闭，其它值或留空取 `defaultValue`）；
 * 3. `defaultValue` 只在没设环境变量时生效 —— 默认必须是「全功能」，
 *    裁剪是显式选择，不能靠默认态生效；
 * 4. `summary` 一句话说明关掉它会消失什么（打包日志与文档都引用它）。
 *
 * 开关值是**编译期字面量**：改开关必须重新构建，运行时读不到也不该被读。
 */

export interface FeatureDefinition {
  /** 关闭该特性的环境变量名（约定 `NOVEL_WITH_<UPPER_SNAKE>`） */
  readonly env: string;
  /** 未设置环境变量时的取值：默认开启 */
  readonly defaultValue: boolean;
  /** 关掉它会消失什么（一句话，给人看） */
  readonly summary: string;
  /**
   * 该特性被关掉时，连带**不参与构建**的窗口入口 key（见 `electron/window-entries.ts`）。
   * 不填 = 不影响任何窗口入口（只影响 UI / IPC）。这样「裁掉一个窗口」也只需在
   * 注册表里写一行，不用再改 `vite.config.ts`。
   */
  readonly cropsWindowEntry?: string;
}

export const FEATURE_REGISTRY = {
  mapWindow: {
    env: "NOVEL_WITH_MAP",
    defaultValue: true,
    summary: "架空地图窗口（MapWindow）：HTML 入口、map.db 读写通道与工具箱入口卡",
    cropsWindowEntry: "map",
  },
} as const satisfies Record<string, FeatureDefinition>;

/** 开关键（`FEATURES` 的属性名） */
export type FeatureKey = keyof typeof FEATURE_REGISTRY;

/** 求值后的开关集合：键集合由注册表推导，新增开关自动带类型 */
export type FeatureFlags = { readonly [K in FeatureKey]: boolean };

/** 全集默认值（不读任何环境变量的结果，供测试与兜底使用） */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = Object.fromEntries(
  (Object.keys(FEATURE_REGISTRY) as FeatureKey[]).map((key) => [
    key,
    FEATURE_REGISTRY[key].defaultValue,
  ]),
) as FeatureFlags;

/** 视为「关闭」的取值 */
const OFF_VALUES = /^(0|false|off|no)$/i;

/**
 * 按给定的环境变量求值。
 *
 * 显式传入 env 记录而不是直接读 `process.env`：一是浏览器 / vitest 里没有
 * `process`，二是测试能直接构造各种取值，不必污染真实环境。
 */
export function resolveFeatureFlags(
  env: Record<string, string | undefined>,
): FeatureFlags {
  const entries = (Object.keys(FEATURE_REGISTRY) as FeatureKey[]).map((key) => {
    const definition = FEATURE_REGISTRY[key];
    const raw = env[definition.env];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    const enabled = trimmed === "" ? definition.defaultValue : !OFF_VALUES.test(trimmed);
    return [key, enabled] as const;
  });
  return Object.fromEntries(entries) as FeatureFlags;
}

/** 本次构建被裁掉的开关（打包时打一行日志，便于确认产物形态） */
export function disabledFeatures(flags: FeatureFlags): FeatureKey[] {
  return (Object.keys(flags) as FeatureKey[]).filter((key) => !flags[key]);
}

/**
 * 本次构建要**从 rollup input 里剔除**的窗口入口 key。
 *
 * 只有登记了 `cropsWindowEntry` 且被关闭的开关才会进来；返回的是入口 key 而非
 * 开关 key，便于 `vite.config.ts` 直接过滤 `WINDOW_ENTRIES`（过滤逻辑放这里，
 * 构建配置只负责消费，守卫可单测）。
 */
export function croppedWindowEntries(flags: FeatureFlags): string[] {
  return (Object.keys(FEATURE_REGISTRY) as FeatureKey[])
    .filter((key) => !flags[key])
    .map((key) => FEATURE_REGISTRY[key].cropsWindowEntry as string | undefined)
    .filter((entry): entry is string => typeof entry === "string");
}
