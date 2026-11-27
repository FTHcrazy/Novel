/**
 * 改名弹框的命令式入口（与组件分离，保住 react-refresh 的组件文件边界）。
 *
 * 打开时锁定 projectId：弹框开着时切大纲，也不会把新名字写到切过去的那份。
 */
import { useOutlineStore } from "../../store/useOutlineStore";

type OpenHandler = (name: string, projectId: string | null) => void;

let openHandler: OpenHandler | null = null;

/** 弹框挂载期注册；卸载时传 null 解绑 */
export function bindRenameDialog(handler: OpenHandler | null): void {
  openHandler = handler;
}

/** 组件外部的命令式入口：openRenameDialog("当前名") */
export function openRenameDialog(name: string): void {
  openHandler?.(name, useOutlineStore.getState().project?.id ?? null);
}
