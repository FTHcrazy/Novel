/**
 * 画布右键菜单 / 浮卡结构（设计稿 v9.6 对齐）的回归测试
 *
 * 覆盖用户可见的入口与菜单项，而不是像素：
 * 1. 事件卡右键＝在此事件后新增 / 断开（仅非首段）/ 删除；
 * 2. 画布空白右键＝新增事件（进待归类）/ 新增时间线 / 一键整理；
 * 3. 时间段右键＝改名 / 改长度 / 前后新增（占位段无删除）；
 * 4. 浮卡＝头像 + 名字 + 收起与移除两个按钮（hover 展开由 CSS 负责）。
 */
import { fireEvent, render } from "@testing-library/react";
import { App } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineEventDTO, OutlineProjectDTO } from "@/shared/types/electron";

vi.mock("antd", async () => {
  const actual = await vi.importActual<typeof import("antd")>("antd");
  return {
    ...actual,
    message: {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    },
  };
});

vi.mock("../../../NovelPage/services/outline-service", () => ({
  fetchOutlineProjects: vi.fn(),
  fetchOutlineBundle: vi.fn(),
  createOutlineDraft: vi.fn(),
  bulkSaveOutline: vi.fn(async () => true),
  deleteOutlineEntity: vi.fn(async () => true),
  deleteOutlineEra: vi.fn(async () => true),
  deleteOutlineEvent: vi.fn(async () => true),
  deleteOutlineLane: vi.fn(async () => true),
  deleteOutlineZone: vi.fn(async () => true),
  moveOutlineCast: vi.fn(async () => true),
  removeOutlineCast: vi.fn(async () => true),
  renameOutlineProject: vi.fn(async () => true),
  saveOutlineEra: vi.fn(async () => true),
  saveOutlineEntity: vi.fn(async () => true),
  saveOutlineEvent: vi.fn(async () => true),
  saveOutlineLane: vi.fn(async () => true),
  saveOutlineZone: vi.fn(async () => true),
  setOutlineCast: vi.fn(async () => true),
  trashOutlineProject: vi.fn(async () => true),
  bindOutlineWork: vi.fn(async () => null),
}));

import { resetOutlineStore, useOutlineStore } from "../../store/useOutlineStore";
import OutlineAxis from "./index";

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const project: OutlineProjectDTO = {
  id: "p1",
  name: "草稿",
  workId: null,
  updatedAt: 1,
  eventCount: 0,
};

const event = (id: string, slot: number, title: string): OutlineEventDTO => ({
  id,
  laneId: "l1",
  slot,
  sort: 0,
  breakBefore: false,
  title,
  body: "",
  whenText: "",
  starred: false,
});

const seed = (): void => {
  useOutlineStore.setState({
    project,
    dir: "h",
    lanes: [{ id: "l1", name: "主线", note: "", sort: 0 }],
    events: [event("e1", 0, "开场"), event("e2", 1, "转折")],
    eras: [
      {
        id: "era1",
        name: "第一段",
        note: "",
        colorSlot: "",
        fromSlot: 0,
        toSlot: 1,
        sort: 0,
      },
    ],
    zones: [],
    casts: [],
    entities: [],
    chapterRefs: {},
  });
};

beforeEach(() => {
  resetOutlineStore();
  seed();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

const renderAxis = (): void => {
  render(
    <App>
      <OutlineAxis />
    </App>,
  );
};

const menuText = (): string =>
  document.querySelector(".ol-cmenu")?.textContent ?? "";

describe("画布右键菜单", () => {
  it("事件卡：在后方新增 / 非首段可断开 / 删除", () => {
    renderAxis();
    const card = document.querySelector('[data-event-id="e2"]');
    expect(card).not.toBeNull();
    fireEvent.contextMenu(card as Element, { clientX: 120, clientY: 80 });

    const text = menuText();
    expect(text).toContain("＋ 在此事件后新增");
    expect(text).toContain("✂ 断开与上一段的连线");
    expect(text).toContain("✕ 删除此事件");
  });

  it("首段没有「断开与上一段」入口", () => {
    renderAxis();
    const card = document.querySelector('[data-event-id="e1"]');
    fireEvent.contextMenu(card as Element, { clientX: 120, clientY: 80 });
    expect(menuText()).not.toContain("断开与上一段的连线");
  });

  it("空白：新增事件（进待归类）/ 新增时间线 / 一键整理", () => {
    renderAxis();
    const blank = document.querySelector(".ol-hcanvas");
    fireEvent.contextMenu(blank as Element, { clientX: 400, clientY: 300 });

    const text = menuText();
    expect(text).toContain("＋ 新增事件（进待归类）");
    expect(text).toContain("＋ 新增时间线");
    expect(text).toContain("✳ 一键整理");
  });

  it("时间段：改名 / 改长度 / 前后新增 / 删除", () => {
    renderAxis();
    const eraEl = document.querySelector(".ol-era");
    fireEvent.contextMenu(eraEl as Element, { clientX: 200, clientY: 20 });

    const text = menuText();
    expect(text).toContain("✎ 改名");
    expect(text).toContain("⤢ 改长度…");
    expect(text).toContain("＋ 前方新增时间段");
    expect(text).toContain("＋ 后方新增时间段");
    expect(text).toContain("✕ 删除时间段");
  });
});

describe("泳道标头与纵向列", () => {
  it("横向标头带泳道色点：--lc 按泳道序号取强调色", () => {
    renderAxis();
    const head = document.querySelector(".ol-lanehead");
    expect(head).not.toBeNull();
    expect(head?.getAttribute("style")).toContain("--lc: var(--app-accent-blue)");
    const name = head?.querySelector("b");
    expect(name?.querySelector(".ol-lanehead__dot")).not.toBeNull();
    expect(name?.textContent).toContain("主线");
  });

  it("纵向：列头在前、留白在后，首槽从 92 起（卡再内缩 12）", () => {
    useOutlineStore.setState({ dir: "v" });
    renderAxis();

    const col = document.querySelector(".ol-vcol");
    const head = col?.querySelector(".ol-vcol__head");
    const sp = col?.querySelector(".ol-vcol__sp");
    expect(head).not.toBeNull();
    expect(sp).not.toBeNull();
    // 设计稿顺序：列头 36 → 区域标签留白 56 → 首槽
    expect(head?.compareDocumentPosition(sp as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const first = document
      .querySelector('[data-event-id="e1"]')
      ?.closest(".ol-cellcard") as HTMLElement | null;
    expect(first?.style.top).toBe("104px");
  });
});

describe("浮卡结构", () => {
  it("游离角色渲染头像、名字与两个操作按钮", () => {
    useOutlineStore.setState({
      entities: [
        { id: "n1", type: "char", name: "沈砚", aliases: "", body: "", colorSlot: "" },
      ],
      casts: [
        {
          eventId: "e1",
          entityId: "n1",
          sort: 0,
          roleLabel: "",
          cardX: 640,
          cardY: 420,
        },
      ],
    });
    renderAxis();

    const card = document.querySelector(".ol-fcard");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".ol-fcard__av")?.textContent).toBe("沈");
    expect(card?.querySelector(".ol-fcard__nm")?.textContent).toBe("沈砚");
    expect(card?.querySelectorAll(".ol-fcard__btn")).toHaveLength(2);
    // 牵线不再写 inline stroke：颜色由 .ol-free__line 的主题变量决定
    const line = document.querySelector(".ol-free__line");
    expect(line?.getAttribute("style")).toBeNull();
  });
});
