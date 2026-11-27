/**
 * 大纲 store 关键路径单测（覆盖评审 P0/P1 里最容易再犯的回归）
 *
 * 1. openDraft(workId) 必须反查到已绑定作品的大纲（不能退化成「最近草稿」）；
 * 2. tidy → undo 槽号必须还原（快照不能拍在原地修改之后）；
 * 3. placeEvent 必须触发 era 收包（槽位变更路径统一自适应）；
 * 4. addEraNextTo 不得落库出重叠区间。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineEraDTO, OutlineEventDTO, OutlineProjectDTO } from "@/shared/types/electron";

vi.mock("antd", () => ({
  message: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  Modal: { confirm: vi.fn() },
}));

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

import {
  fetchOutlineBundle,
  fetchOutlineProjects,
  saveOutlineEra,
} from "../../NovelPage/services/outline-service";
import {
  PLACEHOLDER_ERA_ID,
  resetOutlineStore,
  useOutlineStore,
} from "./useOutlineStore";

const project = (id: string, workId: string | null): OutlineProjectDTO => ({
  id,
  name: id,
  workId,
  updatedAt: 1,
  eventCount: 0,
});

const event = (
  id: string,
  laneId: string | null,
  slot: number,
  sort = 0,
): OutlineEventDTO => ({
  id,
  laneId,
  slot,
  sort,
  breakBefore: false,
  title: id,
  body: "",
  whenText: "",
  starred: false,
});

const era = (id: string, fromSlot: number, toSlot: number): OutlineEraDTO => ({
  id,
  name: id,
  note: "",
  colorSlot: "",
  fromSlot,
  toSlot,
  sort: fromSlot,
});

const bundle = (projectId: string) => ({
  project: project(projectId, projectId === "p2" ? "w9" : null),
  lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
  events: [],
  entities: [],
  casts: [],
  zones: [],
  eras: [],
  chapterRefs: {},
});

beforeEach(() => {
  resetOutlineStore();
  vi.mocked(fetchOutlineProjects).mockReset();
  vi.mocked(fetchOutlineBundle).mockReset();
});

describe("openDraft：projectId / workId 双键反查", () => {
  it("传 workId 打开已绑定作品的大纲，而不是最近草稿", async () => {
    vi.mocked(fetchOutlineProjects).mockResolvedValue({
      drafts: [project("d1", null)],
      works: [project("p2", "w9")],
    });
    vi.mocked(fetchOutlineBundle).mockImplementation(async (id: string) => bundle(id));

    await useOutlineStore.getState().openDraft("w9");

    expect(fetchOutlineBundle).toHaveBeenCalledWith("p2");
    expect(useOutlineStore.getState().project?.id).toBe("p2");
  });

  it("无参仍落到最近编辑草稿", async () => {
    vi.mocked(fetchOutlineProjects).mockResolvedValue({
      drafts: [project("d1", null), project("d2", null)],
      works: [project("p2", "w9")],
    });
    vi.mocked(fetchOutlineBundle).mockImplementation(async (id: string) => bundle(id));

    await useOutlineStore.getState().openDraft();

    expect(fetchOutlineBundle).toHaveBeenCalledWith("d1");
  });
});

describe("tidy：先快照后应用，撤销可还原槽号", () => {
  it("整理把空洞展开成连续格，Ctrl+Z 还原", () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("e1", "l1", 0), event("e2", "l1", 3)],
      eras: [],
      zones: [],
      casts: [],
      entities: [],
    });

    useOutlineStore.getState().tidy();
    const tidied = useOutlineStore.getState().events;
    expect(tidied.find((item) => item.id === "e2")?.slot).toBe(1);

    useOutlineStore.getState().undo();
    const restored = useOutlineStore.getState().events;
    expect(restored.find((item) => item.id === "e2")?.slot).toBe(3);
  });
});

describe("placeEvent：槽位变更触发 era 收包", () => {
  it("把尾卡移到前面，时代带按剩余成员收缩", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("e1", "l1", 0), event("e2", "l1", 1), event("e3", "l1", 3)],
      eras: [era("era1", 0, 3)],
      zones: [],
      casts: [],
      entities: [],
    });

    await useOutlineStore.getState().placeEvent("e3", "l1", 1);

    const next = useOutlineStore.getState().eras.find((item) => item.id === "era1");
    expect(next).toMatchObject({ fromSlot: 0, toSlot: 1 });
  });
});

describe("addEraNextTo：新增段不得与邻段重叠", () => {
  it("在两段之间新增一段，邻段让位后区间互不重叠", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [],
      eras: [era("era1", 0, 1), era("era2", 2, 3)],
      zones: [],
      casts: [],
      entities: [],
    });

    await useOutlineStore.getState().addEraNextTo("era1", false);

    const eras = useOutlineStore
      .getState()
      .eras.filter((item) => item.id !== "__placeholder__")
      .sort((a, b) => a.fromSlot - b.fromSlot);
    expect(eras.length).toBe(3);
    for (let index = 1; index < eras.length; index += 1) {
      expect(eras[index].fromSlot).toBeGreaterThan(eras[index - 1].toSlot);
    }
  });
});

describe("patchEra：纯改名也要落库", () => {
  it("只改名字（区间不变）同样调用 saveOutlineEra，名字不随重启回退", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [],
      eras: [era("era1", 0, 1)],
      zones: [],
      casts: [],
      entities: [],
    });
    vi.mocked(saveOutlineEra).mockClear();

    await useOutlineStore.getState().patchEra("era1", { name: "第一卷" });

    expect(
      useOutlineStore.getState().eras.find((item) => item.id === "era1")?.name,
    ).toBe("第一卷");
    expect(saveOutlineEra).toHaveBeenCalledWith(
      expect.objectContaining({ id: "era1", name: "第一卷", projectId: "p1" }),
    );
  });
});

describe("addEraNextTo：占位段（空白大纲首段）邻接新增", () => {
  it("先转正占位段再贴着新增：原领地保留，两段都落库", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [],
      eras: [
        {
          id: PLACEHOLDER_ERA_ID,
          name: "",
          note: "",
          colorSlot: "",
          fromSlot: 0,
          toSlot: 2,
          sort: 0,
        },
      ],
      zones: [],
      casts: [],
      entities: [],
    });
    vi.mocked(saveOutlineEra).mockClear();

    const newId = await useOutlineStore
      .getState()
      .addEraNextTo(PLACEHOLDER_ERA_ID, false);
    expect(newId).toBeTruthy();

    const eras = useOutlineStore.getState().eras;
    // 占位段已转正成真实段，原 3 格领地保留（不被新段顶替吞掉）
    const promoted = eras.find(
      (item) => item.id !== PLACEHOLDER_ERA_ID && item.id !== newId,
    );
    expect(promoted).toMatchObject({ fromSlot: 0, toSlot: 2 });
    // 新段紧贴其后
    const created = eras.find((item) => item.id === newId);
    expect(created).toMatchObject({ fromSlot: 3, toSlot: 3 });
    // 两段都落库（转正 + 新增各一次）
    expect(saveOutlineEra).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fromSlot: 0, toSlot: 2 }),
    );
    expect(saveOutlineEra).toHaveBeenCalledWith(
      expect.objectContaining({ id: newId, projectId: "p1" }),
    );
  });
});

describe("addEraAt：时间条空白按列新增", () => {  it("默认 2 格、返回新段 id，并让原有段让位", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [],
      eras: [era("era1", 0, 1)],
      zones: [],
      casts: [],
      entities: [],
    });

    const id = await useOutlineStore.getState().addEraAt(0);
    expect(id).toBeTruthy();

    const eras = useOutlineStore
      .getState()
      .eras.filter((item) => item.id !== "__placeholder__")
      .sort((a, b) => a.fromSlot - b.fromSlot);
    const created = eras.find((item) => item.id === id);
    expect(created).toMatchObject({ fromSlot: 0, toSlot: 1 });
    for (let index = 1; index < eras.length; index += 1) {
      expect(eras[index].fromSlot).toBeGreaterThan(eras[index - 1].toSlot);
    }
  });
});

describe("createZoneFromPair：默认色轮换", () => {
  it("连续框两个区域，默认色从色槽交替取值（不再清一色 teal）", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("e1", "l1", 0), event("e2", "l1", 2), event("e3", "l1", 5)],
      eras: [],
      zones: [],
      casts: [],
      entities: [],
    });

    const { createZoneFromPair } = useOutlineStore.getState();
    await createZoneFromPair("e1", "e2");
    await createZoneFromPair("e2", "e3");

    const zones = useOutlineStore.getState().zones;
    expect(zones).toHaveLength(2);
    expect(zones[0].colorSlot).toBeTruthy();
    expect(zones[0].colorSlot).not.toBe(zones[1].colorSlot);
    // 区间归一：a/b 乱序传入也取 min..max
    expect(zones[1]).toMatchObject({ fromSlot: 2, toSlot: 5 });
  });
});

describe("addEventAfter / addTrayEvent：右键新增的两种落点", () => {
  it("在此事件后新增＝同槽堆叠尾（不改链上其他事件的槽号）", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("e1", "l1", 0), event("e2", "l1", 3, 4)],
      eras: [],
      zones: [],
      casts: [],
      entities: [],
    });

    await useOutlineStore.getState().addEventAfter("e2");

    const added = useOutlineStore.getState().events.find((item) => item.id !== "e1" && item.id !== "e2");
    expect(added).toMatchObject({ laneId: "l1", slot: 3, sort: 5 });
    expect(useOutlineStore.getState().events.find((item) => item.id === "e1")?.slot).toBe(0);
  });

  it("空白新增＝待归类（laneId null），不进任何时间格", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("e1", null, 0, 2)],
      eras: [],
      zones: [],
      casts: [],
      entities: [],
    });

    await useOutlineStore.getState().addTrayEvent();

    const loose = useOutlineStore.getState().events.filter((item) => item.laneId === null);
    expect(loose).toHaveLength(2);
    expect(loose.some((item) => item.sort === 3)).toBe(true);
  });
});

describe("patchEra：改长度带着段内的卡一起走", () => {
  it("A 段加长 → 邻段保跨度右移，邻段里的卡同步右移（框与卡不脱节）", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("a", "l1", 0), event("b", "l1", 3)],
      eras: [era("era1", 0, 1), era("era2", 2, 3)],
      zones: [],
      casts: [],
      entities: [],
    });

    // 第 1 格起、共 4 格 → era1 = 0-3，era2 被推到 4-5
    await useOutlineStore.getState().patchEra("era1", { fromSlot: 0, toSlot: 3 });

    const state = useOutlineStore.getState();
    expect(state.eras.find((item) => item.id === "era1")).toMatchObject({
      fromSlot: 0,
      toSlot: 3,
    });
    // era2 保 2 格跨度，从 2 挪到 4
    expect(state.eras.find((item) => item.id === "era2")).toMatchObject({
      fromSlot: 4,
      toSlot: 5,
    });
    // b 属于 era2 → 跟着 +2
    expect(state.events.find((item) => item.id === "b")?.slot).toBe(5);
    expect(state.events.find((item) => item.id === "a")?.slot).toBe(0);
  });

  it("缩短不会把段内的事件甩到框外（下界取成员 bbox）", async () => {
    useOutlineStore.setState({
      project: project("p1", null),
      lanes: [{ id: "l1", name: "", note: "", sort: 0 }],
      events: [event("a", "l1", 0), event("b", "l1", 2)],
      eras: [era("era1", 0, 2)],
      zones: [],
      casts: [],
      entities: [],
    });

    await useOutlineStore.getState().patchEra("era1", { fromSlot: 0, toSlot: 0 });

    expect(useOutlineStore.getState().eras.find((item) => item.id === "era1")).toMatchObject({
      fromSlot: 0,
      toSlot: 2,
    });
  });
});
