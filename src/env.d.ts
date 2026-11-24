/**
 * 渲染层全局声明。
 *
 * 本应用只有单一构建形态，已无版本 / 变体编译期开关：业务代码不依赖任何
 * 编译期注入常量，`vite.config.ts` 也不再写 `define`。
 */

/**
 * Vite 的 `?raw` 导入（图标 SVG 内联用）：iconfont 导出的 SVG 带
 * `fill="currentColor"`，按 raw 字符串内联进 DOM 才能跟随文字色
 * （`<img>` 引用做不到）。资产清单见 `src/assets/novel/`。
 */
declare module "*.svg?raw" {
  const content: string;
  export default content;
}
