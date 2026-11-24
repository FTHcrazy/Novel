/**
 * 窗口入口清单单一事实源。
 *
 * 本模块同时被两侧引用：
 * - vite.config.ts（构建期）：据此生成 rollupOptions.input
 * - electron/main.ts（运行期）：据此装载窗口、决定主窗口归属
 *
 * 只有一个构建形态：NovelWindow 为主窗口（登录后唤起，关闭进托盘），
 * 附 LoginWindow / SettingsWindow / PackWindow / GlobalSettingWindow /
 * RelationWindow / MapWindow —— 全部属于小说业务域。
 */

/** 窗口入口 key，与 windowManager 注册名保持一致 */
export type WindowEntryKey =
  | "login"
  | "novel"
  | "pack"
  | "relation"
  | "settings"
  | "globalSetting"
  | "map";

/** 入口 key → 渲染层 HTML 路径（相对项目根，dev 与 app:// 协议同用该相对路径） */
export const RENDERER_ENTRY_PATHS: Record<WindowEntryKey, string> = {
  login: "src/windows/LoginWindow/index.html",
  novel: "src/windows/NovelWindow/index.html",
  pack: "src/windows/PackWindow/index.html",
  // 人物关系网络独立窗口：可拖拽建模
  relation: "src/windows/RelationWindow/index.html",
  // 全局设置窗口（外观 / 账号 / 个人资料 / 快捷键）
  settings: "src/windows/SettingsWindow/index.html",
  // 全局设定中心独立窗口
  globalSetting: "src/windows/GlobalSettingWindow/index.html",
  // 地图编辑器独立窗口（架空地图）
  map: "src/windows/MapWindow/index.html",
};

/**
 * 本构建打包的全部窗口入口（vite input 与主进程可加载窗口的唯一依据）。
 *
 * ⚠️ `map` 可被构建期开关裁掉：`NOVEL_WITH_MAP=0` 时 `vite.config.ts` 会把这一项
 * 从 rollup input 里剔除（主进程同时不注册 map IPC），清单本身仍保持完整 ——
 * 它是「有哪些窗口」的事实源，不是「本次构建产出了哪些」的清单。见 AGENTS §6.9。
 */
export const WINDOW_ENTRIES: readonly WindowEntryKey[] = [
  "login",
  "novel",
  "pack",
  "relation",
  "settings",
  "globalSetting",
  "map",
];

/** 主窗口入口：NovelWindow 即主窗口 */
export const PRIMARY_WINDOW_ENTRY: WindowEntryKey = "novel";

/** 主窗口在 windowManager 中的注册名 */
export const PRIMARY_WINDOW_NAME = "novel";
