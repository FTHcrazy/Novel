/**
 * 卡片拖拽启动器（outline-plan-spec §8.8）
 *
 * 三条硬约束：
 * 1. **位移 > 4px 才算拖动**——直接在 pointerdown 里 startDrag 会让单击也
 *    进入拖动态（卡片淡化 + ghost 出现 + 抓手光标），点一下就有可见抖动；
 * 2. **窗口外松手 / 失焦必须清算**——`buttons === 0` 说明指针已经松开但
 *    pointerup 丢在了窗口外；此时吸回原格零写入，不能留一个未结束的会话；
 * 3. **触控长按 300ms 进入拖动**（鼠标没有这条路径）。
 *
 * 启动后真正的 move/up 由 OutlineAxis 的 window 监听接管（ghost 跟随 + 命中 +
 * 落格），这里只负责「什么时候算开始」和「异常结束怎么收尾」。
 */
import { useOutlineStore } from "./store/useOutlineStore";

export const DRAG_THRESHOLD = 4;
export const LONG_PRESS_MS = 300;

interface PointerLike {
  button: number;
  clientX: number;
  clientY: number;
  pointerId?: number;
  pointerType?: string;
}

export function beginCardDrag(eventId: string, pointer: PointerLike): void {
  if (pointer.button !== 0) return;
  const startX = pointer.clientX;
  const startY = pointer.clientY;
  const pointerId = pointer.pointerId;
  let started = false;
  let longPress = 0;

  const start = (): void => {
    if (started) return;
    started = true;
    useOutlineStore.getState().startDrag(eventId, startX, startY);
  };

  const cleanup = (): void => {
    window.clearTimeout(longPress);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onBlur);
  };

  const abort = (): void => {
    cleanup();
    if (started) void useOutlineStore.getState().finishDrag(false);
  };

  const onMove = (move: PointerEvent): void => {
    if (pointerId !== undefined && move.pointerId !== pointerId) return;
    if (move.buttons === 0) {
      // 在窗口外松手：pointerup 收不到，靠这里判定并按「取消」吸回
      abort();
      return;
    }
    if (started) return;
    if (
      Math.abs(move.clientX - startX) >= DRAG_THRESHOLD ||
      Math.abs(move.clientY - startY) >= DRAG_THRESHOLD
    ) {
      start();
    }
  };
  const onUp = (): void => cleanup();
  const onCancel = (): void => abort();
  const onBlur = (): void => abort();

  if (pointer.pointerType === "touch") {
    longPress = window.setTimeout(start, LONG_PRESS_MS);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onBlur);
}
