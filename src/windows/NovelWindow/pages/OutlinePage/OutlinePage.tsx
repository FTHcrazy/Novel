/**
 * 大纲工作台（NovelWindow 第 4 视图，outline-plan-spec v7.1 §7.1）
 *
 * 布局：工具条（切换器 / 视图 / 检索 / 动作）+ 托盘（待归类）+ 时间轴画布
 * + 右侧栏；「大纲」模式整画布切换为多列网格列表（同源数据）。
 * 草稿态：标题旁「草稿」徽章 +「由此创建作品」；作品态共用同一画布。
 *
 * 键盘（§14）：N 新建 / Delete 删除选中 / Ctrl+Z 撤销 / H·V 切方向 /
 * Ctrl+Shift+L 一键整理 / Esc 取消拖拽与待选态。输入框聚焦时不响应。
 */
import { useEffect, useRef, useState } from "react";
import { App, Spin } from "antd";
import OutlineToolbar from "./components/OutlineToolbar";
import OutlineAxis from "./components/OutlineAxis";
import OutlineTray from "./components/OutlineTray";
import OutlinePanel from "./components/OutlinePanel";
import OutlineList from "./components/OutlineList";
import RenameDialog from "./components/RenameDialog";
import { bindOutlineFeedback, useOutlineStore } from "./store/useOutlineStore";
import "./index.scss";

export default function OutlinePage({
  openRequest,
  onOpenRequestConsumed,
  visible,
  onBackToShelf,
}: {
  /** 幂等打开请求（openOutline 协议）：workId 有值 = 作品态直达 */
  openRequest: { workId?: string; token: number } | null;
  onOpenRequestConsumed: () => void;
  visible: boolean;
  onBackToShelf: () => void;
}) {
  const openDraft = useOutlineStore((s) => s.openDraft);
  const loading = useOutlineStore((s) => s.loading);
  const mode = useOutlineStore((s) => s.mode);
  const selEventId = useOutlineStore((s) => s.selEventId);
  const deleteEvent = useOutlineStore((s) => s.deleteEvent);
  const undo = useOutlineStore((s) => s.undo);
  const tidy = useOutlineStore((s) => s.tidy);
  const addEvent = useOutlineStore((s) => s.addEvent);
  const setDir = useOutlineStore((s) => s.setDir);
  const finishDrag = useOutlineStore((s) => s.finishDrag);
  const armZone = useOutlineStore((s) => s.armZone);
  const zoneArm = useOutlineStore((s) => s.zoneArm);
  const { message, modal } = App.useApp();

  /* 首屏 Spin 延迟 300ms 才出现：本地 SQLite 通常 <100ms，直接闪一下全屏
     Spin 反而是噪声（§11.2）。 */
  const [spinVisible, setSpinVisible] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSpinVisible(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSpinVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, [loading]);

  /* antd v6：静态 message/Modal 无法消费上下文主题（控制台警告），统一改走
     App 实例。store 不在组件树里，挂载期把实例桥接进去（卸载时解绑）。 */
  useEffect(() => {
    bindOutlineFeedback({ message, modal: (config) => modal.confirm(config) });
    return () => bindOutlineFeedback(null);
  }, [message, modal]);

  /* 幂等打开请求：有参 = 作品态直达（v1 直开草稿口径）；无参 = 最近编辑
     草稿或全新空态。
     ⚠️ 这里必须是**唯一**的装载 effect：曾经 openRequest 与 visible 各挂一条，
     store 的 in-flight 去重只能合并同一条通道的并发调用，两条 effect 仍会
     各自发出一次 novel-outline-load（日志里稳定成对出现）。用 token ref
     把「请求到达」「请求被消费后变 null」两步合并成一次装载；StrictMode
     的二次挂载也因 ref 已置位而跳过。 */
  const handledRequestRef = useRef<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (openRequest) {
      if (handledRequestRef.current === openRequest.token) return;
      handledRequestRef.current = openRequest.token;
      const target = openRequest.workId;
      onOpenRequestConsumed();
      // 显式目标走同一去重通道：key 不同，不会被在途的默认打开吞掉
      void openDraft(target);
      return;
    }
    // openRequest 刚被本 effect 消费成 null：装载已经发起，不能再来一次
    if (handledRequestRef.current !== null) return;
    handledRequestRef.current = -1; // -1 = 本挂载已按「默认打开」发起过
    void openDraft();
  }, [visible, openRequest, openDraft, onOpenRequestConsumed]);

  /* 键盘（§14）：输入框聚焦时不响应；弹窗打开时只放行 Esc */
  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      // 弹窗（删除确认 / 改名 / 改范围）打开时，画布快捷键不得穿透
      const modalOpen = document.querySelector(".ant-modal-wrap") !== null;

      if (event.key === "Escape") {
        const state = useOutlineStore.getState();
        if (state.drag) {
          void finishDrag(false);
        } else if (zoneArm) {
          armZone(null);
        } else if (state.query) {
          state.setQuery("");
        }
        return;
      }

      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".ol-toolbar__search input")?.focus();
        return;
      }

      if (modalOpen) return;

      if (mod && event.shiftKey && event.key.toLowerCase() === "z") return;
      if (mod && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        tidy();
        return;
      }

      const state = useOutlineStore.getState();
      const selected = state.events.find((item) => item.id === state.selEventId) ?? null;
      const laneIds = [...state.lanes].sort((a, b) => a.sort - b.sort).map((lane) => lane.id);
      const laneIdx = selected?.laneId ? laneIds.indexOf(selected.laneId) : -1;

      /* 方向键（§14）：同线内按槽移动；Ctrl = 移一格；Ctrl+Shift = 跨线同槽。
         横向布局：左右 = 槽，上下 = 换线；纵向布局相反。 */
      const arrow = /^(Arrow(Left|Right|Up|Down))$/.exec(event.key);
      if (arrow && selected && selected.laneId && laneIdx >= 0) {
        const horizontal = state.dir === "h";
        const alongAxis =
          (horizontal && (event.key === "ArrowLeft" || event.key === "ArrowRight")) ||
          (!horizontal && (event.key === "ArrowUp" || event.key === "ArrowDown"));
        const delta =
          event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        event.preventDefault();
        if (mod && event.shiftKey) {
          // 跨线移动到同槽
          const nextLane = laneIds[laneIdx + delta];
          if (nextLane) void state.placeEvent(selected.id, nextLane, selected.slot);
        } else if (alongAxis || mod) {
          void state.placeEvent(
            selected.id,
            selected.laneId,
            Math.max(0, selected.slot + delta),
          );
        } else {
          // 纯上下（横向）= 选中邻线同槽（或最近）的事件
          const nextLane = laneIds[laneIdx + delta];
          if (!nextLane) return;
          const inLane = state.events.filter((item) => item.laneId === nextLane);
          if (inLane.length === 0) return;
          const nearest = inLane.reduce((best, item) =>
            Math.abs(item.slot - selected.slot) < Math.abs(best.slot - selected.slot)
              ? item
              : best,
          );
          state.selectEvent(nearest.id);
        }
        return;
      }

      if (event.key === "Enter" && selected) {
        event.preventDefault();
        state.focusEventBody();
        return;
      }
      if (event.key.toLowerCase() === "n" && !mod) {
        event.preventDefault();
        void addEvent(null);
        return;
      }
      if ((event.key === "h" || event.key === "v") && !mod) {
        setDir(event.key === "h" ? "h" : "v");
        return;
      }
      if (event.key === "Delete" && selEventId) {
        event.preventDefault();
        modal.confirm({
          title: "删除这段事件？",
          content: "它的出场记录与章节拍入关联会一并清理（可在撤销栈找回）。",
          okText: "删除",
          okButtonProps: { danger: true },
          cancelText: "取消",
          onOk: () => deleteEvent(selEventId),
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    visible,
    undo,
    tidy,
    addEvent,
    setDir,
    selEventId,
    deleteEvent,
    finishDrag,
    armZone,
    zoneArm,
    modal,
  ]);

  return (
    <div className="ol-page">
      <OutlineToolbar onBackToShelf={onBackToShelf} />
      {/* antd v6 弃用 wrapperClassName：外层自备容器，嵌套 Spin 的
          .ant-spin-nested-loading 直接吃 .ol-spin 的布局链 */}
      <div className="ol-spin">
        <Spin spinning={spinVisible}>
          {mode === "axis" ? (
            <div className="ol-body">
              <OutlineTray />
              <OutlineAxis />
              <OutlinePanel />
            </div>
          ) : (
            <div className="ol-body">
              <OutlineList />
            </div>
          )}
        </Spin>
      </div>
      <RenameDialog />
      {/* 包区域待选提示（FR-14a） */}
      {zoneArm && (
        <div className="ol-page__armtip">
          再点同一条线上的另一段事件，完成「包一个区域」（Esc 取消）
        </div>
      )}
      {/* 画布点击兜底：包区域待选时点空白取消 */}
      <div
        className="ol-page__clickcatch"
        onClick={() => {
          if (zoneArm) armZone(null);
        }}
      />
    </div>
  );
}
