/**
 * 工具条（§7.1）：左「切换器（草稿组/作品大纲组/新建）+ 草稿徽章 + 由此创建
 * 作品」，中「时间轴/大纲 + 方向」，右「检索 + 一键整理 + 新事件」。
 * 组件库优先（AGENTS §6.1.2）：下拉 = Dropdown、按钮 = Button、分段 = Segmented。
 */
import { useEffect, useMemo, useState } from "react";
import { App, Button, Dropdown, Input, Modal, Segmented, Tooltip } from "antd";
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  PlusOutlined,
  SearchOutlined,
  SortAscendingOutlined,
} from "@ant-design/icons";
import {
  useOutlineStore,
  type OutlineDir,
  type OutlineMode,
} from "../../store/useOutlineStore";
import { fetchOutlineProjects } from "../../../NovelPage/services/outline-service";
import type { OutlineProjectDTO } from "@/shared/types/electron";
import { openRenameDialog } from "../RenameDialog/openRename";
import "./index.scss";

/** 相对时间（切换器 meta 口径：刚刚 / N 分钟前 / 昨天 / N 天前） */
function relativeTime(updatedAt: number): string {
  const diff = Date.now() - updatedAt;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default function OutlineToolbar({ onBackToShelf }: { onBackToShelf: () => void }) {
  const { message, modal } = App.useApp();
  const project = useOutlineStore((s) => s.project);
  const events = useOutlineStore((s) => s.events);
  const casts = useOutlineStore((s) => s.casts);
  const entities = useOutlineStore((s) => s.entities);
  const lanes = useOutlineStore((s) => s.lanes);
  const mode = useOutlineStore((s) => s.mode);
  const dir = useOutlineStore((s) => s.dir);
  const query = useOutlineStore((s) => s.query);
  const setMode = useOutlineStore((s) => s.setMode);
  const setDir = useOutlineStore((s) => s.setDir);
  const setQuery = useOutlineStore((s) => s.setQuery);
  const newDraft = useOutlineStore((s) => s.newDraft);
  const openDraft = useOutlineStore((s) => s.openDraft);
  const trashProject = useOutlineStore((s) => s.trashProject);
  const addLane = useOutlineStore((s) => s.addLane);
  const addEvent = useOutlineStore((s) => s.addEvent);
  const tidy = useOutlineStore((s) => s.tidy);
  const bindWork = useOutlineStore((s) => s.bindWork);

  const [projects, setProjects] = useState<OutlineProjectList>({ drafts: [], works: [] });
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [bindName, setBindName] = useState("");

  // 切换器面板打开时拉一次项目列表（草稿按最近编辑序，§7.1）
  useEffect(() => {
    if (!switcherOpen) return;
    fetchOutlineProjects()
      .then(setProjects)
      .catch(() => setProjects({ drafts: [], works: [] }));
  }, [switcherOpen]);

  const stats = useMemo(() => {
    const eventIds = new Set(events.map((event) => event.id));
    const chars = new Set<string>();
    for (const cast of casts) {
      if (eventIds.has(cast.eventId)) chars.add(cast.entityId);
    }
    return `事件 ${events.length} · 角色 ${chars.size} · 时间线 ${lanes.length}`;
  }, [events, casts, lanes]);

  const isDraft = project !== null && project.workId === null;
  const projectName = project ? project.name || "未命名大纲" : "大纲工作台";

  const menu = {
    items: [
      { type: "group" as const, label: `大纲草稿 ${projects.drafts.length}` },
      ...projects.drafts.map((draft) => ({
        key: draft.id,
        label: (
          <span className="ol-switcher__item">
            <span className={`ol-switcher__name${draft.id === project?.id ? " is-current" : ""}`}>
              {draft.name || "未命名大纲"}
            </span>
            <span className="ol-switcher__meta">{relativeTime(draft.updatedAt)}</span>
          </span>
        ),
      })),
      { type: "divider" as const },
      { type: "group" as const, label: "作品大纲（最近 5 部）" },
      ...projects.works.slice(0, 5).map((work) => ({
        key: work.id,
        label: (
          <span className="ol-switcher__item">
            <span className={`ol-switcher__name${work.id === project?.id ? " is-current" : ""}`}>
              {work.name || "未命名大纲"}
            </span>
            <span className="ol-switcher__meta">{relativeTime(work.updatedAt)}</span>
          </span>
        ),
      })),
      { type: "divider" as const },
      {
        key: "__new__",
        label: (
          <span className="ol-switcher__new">
            <PlusOutlined /> 新建草稿
          </span>
        ),
      },
      ...(project
        ? [
            {
              key: "__rename__",
              label: "重命名当前大纲",
            },
            ...(isDraft
              ? [
                  {
                    key: "__trash__",
                    label: (
                      <span className="ol-switcher__danger">✕ 移入回收站（30 天可恢复）</span>
                    ),
                  },
                ]
              : []),
          ]
        : []),
    ],
    onClick: ({ key }: { key: string }) => {
      setSwitcherOpen(false);
      if (key === "__new__") {
        void newDraft();
        return;
      }
      if (key === "__rename__") {
        openRenameDialog(projectName);
        return;
      }
      if (key === "__trash__" && project) {
        modal.confirm({
          title: `删除「${projectName}」？`,
          content: `删除后移入回收站，30 天内可在回收站恢复。${lanes.length} 条时间线、${events.length} 个事件、${entities.length} 个角色会一并移入回收站。`,
          okText: "✕ 移入回收站",
          okButtonProps: { danger: true },
          cancelText: "取消",
          onOk: async () => {
            const ok = await trashProject(project.id);
            if (ok) await openDraft(); // 落到下一份草稿（没有则现场补一份）
          },
        });
        return;
      }
      const target = [...projects.drafts, ...projects.works].find((item) => item.id === key);
      if (target) void openDraft(target.id);
    },
  };

  return (
    <header className="ol-toolbar">
      <Button
        className="ol-toolbar__back"
        type="text"
        icon={<ArrowLeftOutlined />}
        onClick={onBackToShelf}
        aria-label="返回书架"
      />
      <Dropdown
        menu={menu}
        trigger={["click"]}
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        classNames={{ root: "ol-switcher-popup" }}
      >
        <Button className="ol-toolbar__switcher" type="text" aria-label="切换大纲">
          <span className="ol-toolbar__title">{projectName}</span>
          {isDraft && <span className="ol-toolbar__badge">草稿</span>}
          <span className="ol-toolbar__meta">{stats}</span>
          <span className="ol-toolbar__caret">▾</span>
        </Button>
      </Dropdown>
      {isDraft && (
        <Tooltip title="按此大纲创建作品并绑定（单事务，一作品一份大纲）">
          <Button className="ol-toolbar__bind" onClick={() => setBindOpen(true)}>
            由此创建作品
          </Button>
        </Tooltip>
      )}
      <span className="ol-toolbar__sep" />
      <Segmented
        value={mode}
        onChange={(value) => setMode(value as OutlineMode)}
        options={[
          { label: "时间轴", value: "axis" },
          { label: "大纲", value: "list" },
        ]}
      />
      {mode === "axis" && (
        <Segmented
          value={dir}
          onChange={(value) => setDir(value as OutlineDir)}
          options={[
            { label: <ArrowRightOutlined />, value: "h" },
            { label: <SortAscendingOutlined rotate={90} />, value: "v" },
          ]}
        />
      )}
      <span className="ol-toolbar__spacer" />
      <Input
        className="ol-toolbar__search"
        prefix={<SearchOutlined />}
        placeholder="搜索事件、角色"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        allowClear
      />
      <Button onClick={() => void addLane()}>轨道</Button>
      <Button icon={<SortAscendingOutlined />} onClick={tidy}>
        一键整理
      </Button>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => void addEvent(null)}>
        新事件
      </Button>

      {/* 由此创建作品（§7.1：书名必填 / 题材可跳过；成功留在工作台作品态） */}
      <Modal
        title="由此大纲创建作品"
        open={bindOpen}
        okText="创建并绑定"
        cancelText="取消"
        onCancel={() => setBindOpen(false)}
        onOk={async () => {
          const name = bindName.trim();
          if (!name) {
            void message.warning("书名必填");
            return;
          }
          const ok = await bindWork(name, null);
          if (ok) {
            setBindOpen(false);
            setBindName("");
          }
        }}
      >
        <Input
          placeholder="书名（必填）"
          value={bindName}
          maxLength={60}
          onChange={(event) => setBindName(event.target.value)}
        />
        <p className="ol-toolbar__bindtip">题材可跳过，之后随时在书架补。</p>
      </Modal>
    </header>
  );
}

interface OutlineProjectList {
  drafts: OutlineProjectDTO[];
  works: OutlineProjectDTO[];
}
