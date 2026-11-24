/**
 * 构建期特性开关（主进程读取层）。
 *
 * **不要在这里加开关**：注册表在 `src/shared/feature-registry.ts`（纯数据，
 * 无 React / DOM 依赖），值由 `vite.config.ts` 以 `define` 注入，这里只解引用一次。
 *
 * 跨目录引用的是 `import type`：编译后完全擦除，主进程产物不会因此把渲染层代码
 * 拉进 bundle，只是共用同一份类型定义（`electron/window-entries.ts` 由两侧共用
 * 已是同类先例）。
 *
 * 关闭某个特性时，`main.ts` 会整段跳过它对应的通道：例如关掉地图窗口就不会注册
 * `map.db` 通道、`map-*` handler 与 `map-window-open` IPC，因此也不会新建一个空的
 * `map.db`。具体变量名见注册表里该开关的 `env` 字段。
 */
import type { FeatureFlags } from "../src/shared/feature-registry";

declare const __NOVEL_FEATURES__: FeatureFlags;

/** 本次构建的开关集合（键见注册表） */
export const FEATURES: FeatureFlags = __NOVEL_FEATURES__;

/** 地图窗口（架空地图 / MapWindow）是否参与本次构建 */
export const FEATURE_MAP_WINDOW: boolean = FEATURES.mapWindow;
