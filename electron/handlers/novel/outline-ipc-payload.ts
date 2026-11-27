/**
 * `novel-outline-load` 的 IPC 载荷编码（纯函数，无 electron / DB 依赖）。
 *
 * 为什么返回 **JSON 字符串**而不是对象：
 * 渲染层拿到的值要连过三道结构化克隆 —— 主进程 handler 返回值序列化、
 * ipcRenderer.invoke 的响应反序列化、preload contextBridge 把 Promise 结果
 * 搬进隔离世界。任何一道用了与 Node `v8.serialize` 不同的实现（Blink 的
 * StructuredClone 与 contextBridge 各自有自己的白名单），对象里只要混进一个
 * 非普通原型的值，用户看到的就是笼统的 `An object could not be cloned.`，
 * 而且发生在 handler 的 try/catch 之外，主进程一行错误日志都不会有。
 *
 * 字符串是三道克隆的公共子集，无论 bundle 里将来混进什么奇形怪状的值，
 * 都不会再让整条通道崩在框架层。解码与结构校验在渲染层
 * `outline-service.ts` 的 `parseOutlineLoadPayload` 完成。
 */

/**
 * 把任意值编码成可跨 IPC 传递的纯 JSON 字符串。
 *
 * `JSON.stringify` 会剥掉自定义 prototype、只保留普通对象 / 数组 / 原始值；
 * 这正是 Electron 三道克隆都能接受的最小集合。
 *
 * @param bundle 原始装载结果（通常是 OutlineBundleDTO，null 表示项目不存在）
 * @returns JSON 字符串；bundle 为 null / undefined 时返回 "null"
 * @throws 当值含 BigInt、循环引用等 JSON 无法表达的内容时抛出 TypeError
 */
export function toOutlineIpcJson(bundle: unknown): string {
  const json: string | undefined = JSON.stringify(bundle);
  if (typeof json !== "string") {
    throw new TypeError("大纲装载结果无法编码为 JSON 字符串");
  }
  return json;
}
