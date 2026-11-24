/**
 * 构建期特性开关（渲染层读取层）。
 *
 * **不要在这里加开关**：注册表在 `src/shared/feature-registry.ts`，值由
 * `vite.config.ts` 以 `define: { __NOVEL_FEATURES__ }` 注入，这里只做一次解引用。
 * 因此新增开关不需要改本文件，业务代码直接 `FEATURES.<key>` 即可。
 *
 * 打包后 `FEATURES` 就是一个字面量对象，未使用的分支会被 tree-shaking 掉 ——
 * 这也意味着**换开关必须重新构建**，运行时改环境变量没有任何效果。
 */
import type { FeatureFlags } from "./feature-registry";

declare const __NOVEL_FEATURES__: FeatureFlags;

/** 本次构建的开关集合（键见注册表） */
export const FEATURES: FeatureFlags = __NOVEL_FEATURES__;

/** 地图窗口（架空地图 / MapWindow）是否参与本次构建 */
export const FEATURE_MAP_WINDOW: boolean = FEATURES.mapWindow;
