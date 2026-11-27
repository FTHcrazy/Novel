/**
 * 右栏版式守卫（§7.1）：事件 tab 与角色汇总按 v9 原型排版。
 *
 * 断言的是「结构契约」而不是像素：
 * 1. 事件 tab：标题在 .p-title 位、标签组是 tag、出场行 = 圆头像 + 共 N 处 + ›；
 * 2. 角色汇总：未选中时是「全部实体」列表（按出场数降序），点行进入汇总卡；
 * 3. 出场行的头像与卡片 chip / 选人浮层共用 .ol-av（此前是方块，因为 class 名与
 *    样式对不上——.ol-ev__av 从来没有对应规则）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OutlineCastDTO,
  OutlineEntityDTO,
  OutlineEventDTO,
  OutlineLaneDTO,
  OutlineProjectDTO,
} from "@/shared/types/electron";

vi.mock("../../NovelPage/services/outline-service", () => ({
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
import OutlinePanel from "./index";

const project: OutlineProjectDTO = {
  id: "p1",
  name: "p1",
  workId: null,
  updatedAt: 1,
  eventCount: 0,
};

const lane: OutlineLaneDTO = { id: "l1", name: "主线", note: "", sort: 0 };

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

const entity = (id: string, name: string): OutlineEntityDTO => ({
  id,
  type: "char",
  name,
  aliases: "",
  body: "",
  colorSlot: "",
});

const cast = (eventId: string, entityId: string, sort = 0): OutlineCastDTO => ({
  eventId,
  entityId,
  sort,
  roleLabel: "",
  cardX: null,
  cardY: null,
});

const seed = (): void => {
  resetOutlineStore();
  useOutlineStore.setState({
    project,
    lanes: [lane],
    events: [event("e1", 0, "开场"), event("e2", 1, "转折")],
    entities: [entity("n1", "沈砚"), entity("n2", "师父"), entity("n3", "哑仆")],
    casts: [cast("e1", "n1"), cast("e1", "n2"), cast("e2", "n1")],
    selEventId: "e1",
  });
};

const renderPanel = (): void => {
  render(
    <App>
      <OutlinePanel />
    </App>,
  );
};

describe("右栏：事件 tab", () => {
  beforeEach(seed);
  afterEach(cleanup);

  it("标题 / 标签组 / 出场角色行按设计稿结构渲染", () => {
    renderPanel();
    // 标签组：泳道·第 N 格 / N 个出场
    expect(screen.getByText("主线 · 第 1 格")).toBeTruthy();
    expect(screen.getByText("2 个出场")).toBeTruthy();
    expect(screen.getByText("出场角色")).toBeTruthy();

    // 出场行：原生 button + 圆头像 + 「共 N 处」+ 尾巴 ›
    const rows = document.querySelectorAll(".ol-rowlist .ol-row");
    expect(rows.length).toBe(2);
    const first = rows[0] as HTMLElement;
    expect(first.tagName).toBe("BUTTON");
    expect(first.querySelector(".ol-av")).not.toBeNull();
    expect(first.textContent).toContain("沈砚");
    expect(first.textContent).toContain("共 2 处");
    expect(first.querySelector(".ol-row__go")?.textContent).toBe("›");
  });

  it("点出场行 = 切到角色汇总并选中该角色", () => {
    renderPanel();
    const row = document.querySelectorAll<HTMLElement>(".ol-rowlist .ol-row")[0];
    fireEvent.click(row);
    expect(useOutlineStore.getState().selEntityId).toBe("n1");
    expect(document.querySelector(".ol-sumcard")).not.toBeNull();
  });
});

describe("右栏：角色汇总", () => {
  beforeEach(seed);
  afterEach(cleanup);

  it("未选中先给全部实体，按出场数降序", () => {
    renderPanel();
    fireEvent.click(screen.getByText("角色汇总"));
    expect(screen.getByText("全部实体")).toBeTruthy();
    const rows = Array.from(document.querySelectorAll(".ol-rowlist .ol-row")).map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("沈砚");
    expect(rows[0]).toContain("2 次出场");
    expect(rows[rows.length - 1]).toContain("哑仆");
    expect(rows[rows.length - 1]).toContain("未使用");
  });

  it("选中角色后给汇总卡 + 出现在 + 没出场的实体，可回到全部实体", () => {
    renderPanel();
    useOutlineStore.getState().selectEntity("n1");
    fireEvent.click(screen.getByText("角色汇总"));

    expect(document.querySelector(".ol-sumcard")).not.toBeNull();
    expect(screen.getByText("出现在")).toBeTruthy();
    expect(screen.getByText("没出场的实体")).toBeTruthy();

    fireEvent.click(screen.getByText("‹ 全部实体"));
    expect(useOutlineStore.getState().selEntityId).toBeNull();
    expect(screen.getByText("全部实体")).toBeTruthy();
  });
});
