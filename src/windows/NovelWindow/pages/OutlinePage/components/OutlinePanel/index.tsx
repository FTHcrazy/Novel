/**
 * 右侧栏（§7.1 / §8.6）：全局汇总 + 选中事件详情，不是编辑主入口。
 *
 * 版式直接对齐 v9 原型：
 * · Tab「事件」：.p-title 标题 / .p-meta 标签组（泳道·第 N 格 / 时间文本 / N 个出场）
 *   / 虚线「＋ 包一个区域」/ 正文 /「出场角色」行（圆头像 + 名字 + 共 N 处 + ›）
 * · Tab「角色汇总」：未选中 = 全部实体列表（按出场数排序）；选中 = .sum-card
 *   汇总卡 +「出现在」+「没出场的实体」
 *
 * 输入提交（§15）：本地态 + 300ms 防抖落库，切事件 / 卸载 / 失焦立即 flush。
 * 早期只在 blur 提交，程序化切视图（Esc、快捷键返回）不触发 blur，直接丢字。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Select, Switch } from "antd";
import {
  DeleteOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  ScanOutlined,
} from "@ant-design/icons";
import { useOutlineStore } from "../../store/useOutlineStore";
import type { OutlineEntityDTO } from "@/shared/types/electron";
import { ENTITY_TYPE_COLOR, ENTITY_TYPE_LABEL } from "../EventCard/constants";
import CastPicker, { EntityAvatar } from "../CastPicker";
import "./index.scss";

type PanelTab = "event" | "cast";

/** 防抖提交字段（本地态 + 300ms 防抖 + 卸载 flush，避免每击键进撤销栈） */
function CommitField({
  value,
  multiline,
  className,
  placeholder,
  maxLength,
  onCommit,
  inputRef,
  debounceMs = 300,
}: {
  value: string;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  onCommit: (v: string) => void;
  inputRef?: React.RefObject<HTMLDivElement | null>;
  debounceMs?: number;
}) {
  const [local, setLocal] = useState(value);
  const pending = useRef(value);
  const committed = useRef(value);
  const commitRef = useRef(onCommit);
  const timer = useRef(0);

  // 回调可能随渲染变化（切换事件后指向新 id）：在 effect 里同步，不在渲染期写 ref
  useEffect(() => {
    commitRef.current = onCommit;
  });

  // 外部值变化（撤销 / 切换事件 / 别处改同一字段）同步回本地态
  useEffect(() => {
    pending.current = value;
    committed.current = value;
    setLocal(value);
  }, [value]);

  const flush = (): void => {
    window.clearTimeout(timer.current);
    if (pending.current === committed.current) return;
    committed.current = pending.current;
    commitRef.current(pending.current);
  };

  // 卸载（切事件 / 切视图 / 关窗口）必须把未提交的内容写掉
  useEffect(() => {
    const pendingTimer = timer;
    return () => {
      window.clearTimeout(pendingTimer.current);
      // 这里直接读 ref：闭包里的 flush 永远指向最新 refs
      if (pending.current !== committed.current) {
        committed.current = pending.current;
        commitRef.current(pending.current);
      }
    };
  }, []);

  const change = (next: string): void => {
    pending.current = next;
    setLocal(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, debounceMs);
  };

  return multiline ? (
    <div ref={inputRef} className={className ? `${className}-wrap` : undefined}>
      <Input.TextArea
        className={className}
        placeholder={placeholder}
        maxLength={maxLength}
        value={local}
        autoSize={{ minRows: 4, maxRows: 10 }}
        onChange={(e) => change(e.target.value)}
        onBlur={flush}
      />
    </div>
  ) : (
    <div ref={inputRef} className={className ? `${className}-wrap` : undefined}>
      <Input
        className={className}
        placeholder={placeholder}
        maxLength={maxLength}
        value={local}
        onChange={(e) => change(e.target.value)}
        onBlur={flush}
        onPressEnter={flush}
      />
    </div>
  );
}

export default function OutlinePanel() {
  const { modal } = App.useApp();
  const events = useOutlineStore((s) => s.events);
  const entities = useOutlineStore((s) => s.entities);
  const casts = useOutlineStore((s) => s.casts);
  const lanes = useOutlineStore((s) => s.lanes);
  const zones = useOutlineStore((s) => s.zones);
  const chapterRefs = useOutlineStore((s) => s.chapterRefs);
  const selEventId = useOutlineStore((s) => s.selEventId);
  const selEntityId = useOutlineStore((s) => s.selEntityId);
  const zoneArm = useOutlineStore((s) => s.zoneArm);
  const bodyFocusToken = useOutlineStore((s) => s.bodyFocusToken);

  const selectEvent = useOutlineStore((s) => s.selectEvent);
  const selectEntity = useOutlineStore((s) => s.selectEntity);
  const armZone = useOutlineStore((s) => s.armZone);
  const patchEvent = useOutlineStore((s) => s.patchEvent);
  const deleteEvent = useOutlineStore((s) => s.deleteEvent);
  const addEntity = useOutlineStore((s) => s.addEntity);
  const patchEntity = useOutlineStore((s) => s.patchEntity);
  const deleteEntity = useOutlineStore((s) => s.deleteEntity);
  const removeCast = useOutlineStore((s) => s.removeCast);
  const addCast = useOutlineStore((s) => s.addCast);

  const [tab, setTab] = useState<PanelTab>("event");
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<OutlineEntityDTO["type"]>("char");
  const bodyRef = useRef<HTMLDivElement>(null);

  const selEvent = events.find((event) => event.id === selEventId) ?? null;
  const selEntity = entities.find((entity) => entity.id === selEntityId) ?? null;
  const laneById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);

  /** 出场计数（角色 Tab 行 + 汇总卡 + 选人浮层的「N 处」） */
  const castCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const cast of casts) map.set(cast.entityId, (map.get(cast.entityId) ?? 0) + 1);
    return map;
  }, [casts]);
  const countOf = (entityId: string): number => castCount.get(entityId) ?? 0;

  /** 浮卡集合（行内「画布上」标记） */
  const floatingKeys = useMemo(
    () =>
      new Set(
        casts
          .filter((cast) => cast.cardX !== null && cast.cardY !== null)
          .map((cast) => `${cast.eventId}-${cast.entityId}`),
      ),
    [casts],
  );

  /* Enter 聚焦正文（§14）：store 自增 token，这里消费 */
  useEffect(() => {
    if (bodyFocusToken <= 0) return;
    bodyRef.current?.querySelector("textarea")?.focus();
  }, [bodyFocusToken]);

  const selEventCasts = casts.filter((cast) => cast.eventId === selEventId);

  /** 角色「出现在」：按泳道 → 槽序排列（待归类排在最后） */
  const appearances = useMemo(() => {
    if (!selEntity) return [];
    const rows = casts
      .filter((cast) => cast.entityId === selEntity.id)
      .map((cast) => events.find((event) => event.id === cast.eventId))
      .filter((event): event is NonNullable<typeof event> => event !== undefined)
      .sort((a, b) => {
        const laneA = laneById.get(a.laneId ?? "")?.sort ?? Number.MAX_SAFE_INTEGER;
        const laneB = laneById.get(b.laneId ?? "")?.sort ?? Number.MAX_SAFE_INTEGER;
        if (laneA !== laneB) return laneA - laneB;
        if (a.slot !== b.slot) return a.slot - b.slot;
        return a.sort - b.sort;
      });
    return rows;
  }, [selEntity, casts, events, laneById]);

  /** 全部实体：按出场数降序（设计稿同上），未使用的沉底 */
  const allEntities = useMemo(
    () =>
      [...entities].sort(
        (a, b) => countOf(b.id) - countOf(a.id) || a.name.localeCompare(b.name, "zh"),
      ),
    // countOf 由 castCount 派生
    [entities, castCount],
  );
  const unusedEntities = allEntities.filter((entity) => countOf(entity.id) === 0);

  const confirmDeleteEvent = (): void => {
    if (!selEventId) return;
    modal.confirm({
      title: "删除这段事件？",
      content: "它的出场记录与章节拍入关联会一并清理（可在撤销栈找回）。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => deleteEvent(selEventId),
    });
  };

  /** 事件所在区域（「位于区域内 / 未包区域」标签） */
  const inZone = selEvent
    ? zones.some(
        (zone) =>
          zone.laneId === selEvent.laneId &&
          selEvent.slot >= zone.fromSlot &&
          selEvent.slot <= zone.toSlot,
      )
    : false;

  if (collapsed) {
    return (
      <aside className="ol-panel is-collapsed">
        <Button
          type="text"
          className="ol-panel__expand"
          icon={<LeftOutlined />}
          title="展开右侧栏"
          aria-label="展开右侧栏"
          onClick={() => setCollapsed(false)}
        />
      </aside>
    );
  }

  const createEntity = (): void => {
    if (!newName.trim()) return;
    void addEntity(newType, newName);
    setNewName("");
  };

  /** 点角色行 = 切到角色汇总并选中（设计稿 selectChar 语义） */
  const openEntity = (entityId: string): void => {
    setTab("cast");
    selectEntity(entityId);
  };

  return (
    <aside className="ol-panel">
      <div className="ol-panel__tabs">
        <Button
          type="text"
          className={tab === "event" ? "is-on" : ""}
          onClick={() => setTab("event")}
        >
          事件
        </Button>
        <Button
          type="text"
          className={tab === "cast" ? "is-on" : ""}
          onClick={() => setTab("cast")}
        >
          角色汇总
        </Button>
        <Button
          type="text"
          className="ol-panel__fold"
          icon={<RightOutlined />}
          title="收起右侧栏"
          aria-label="收起右侧栏"
          onClick={() => setCollapsed(true)}
        />
      </div>

      <div className="ol-panel__body">
        {tab === "event" &&
          (selEvent ? (
            <div className="ol-detail" key={selEvent.id}>
              <CommitField
                value={selEvent.title}
                placeholder="事件标题"
                maxLength={40}
                className="ol-panel__title"
                onCommit={(value) => void patchEvent(selEvent.id, { title: value.trim() })}
              />

              <div className="ol-panel__meta">
                <span className="ol-tag ol-tag--pri">
                  {laneById.get(selEvent.laneId ?? "")?.name || "待归类"} · 第{" "}
                  {selEvent.slot + 1} 格
                </span>
                <span className="ol-tag">{selEvent.whenText || "未标时间"}</span>
                <span className="ol-tag">{selEventCasts.length} 个出场</span>
                {!!chapterRefs[selEvent.id] && (
                  <span className="ol-tag ol-tag--pri">已拍 {chapterRefs[selEvent.id]} 章</span>
                )}
                <span className="ol-tag">{inZone ? "位于区域内" : "未包区域"}</span>
              </div>

              <button
                type="button"
                className={`ol-link-btn is-zone${zoneArm === selEvent.id ? " is-arm" : ""}`}
                onClick={() => armZone(zoneArm === selEvent.id ? null : selEvent.id)}
              >
                <ScanOutlined />
                {zoneArm === selEvent.id ? "再点同线另一事件完成包区" : "包一个区域"}
              </button>

              <CommitField
                value={selEvent.body}
                multiline
                placeholder="两三句话说说这段发生什么（卡上只显示前两行）"
                maxLength={20000}
                className="ol-panel__text"
                inputRef={bodyRef}
                onCommit={(value) => void patchEvent(selEvent.id, { body: value })}
              />

              <div className="ol-panel__fieldrow">
                <span className="ol-panel__fieldlabel">时间文本</span>
                <CommitField
                  value={selEvent.whenText}
                  placeholder="如：第 3 年春 · 大婚当日"
                  maxLength={30}
                  onCommit={(value) => void patchEvent(selEvent.id, { whenText: value })}
                />
              </div>
              <div className="ol-panel__fieldrow">
                <span className="ol-panel__fieldlabel">与前段断开推进链</span>
                <Switch
                  size="small"
                  checked={selEvent.breakBefore}
                  onChange={(checked) => void patchEvent(selEvent.id, { breakBefore: checked })}
                />
              </div>

              <div className="ol-sec">
                <div className="ol-sec__head">
                  <b>出场角色</b>
                  <span className="ol-sec__n">{selEventCasts.length}</span>
                  <span className="ol-sec__sp" />
                  <CastPicker
                    entities={entities}
                    casts={selEventCasts}
                    countOf={countOf}
                    onPick={(entityId) => void addCast(selEvent.id, entityId)}
                  >
                    <button type="button" className="ol-link-btn">
                      <PlusOutlined /> 添加
                    </button>
                  </CastPicker>
                </div>
                <div className="ol-rowlist">
                  {selEventCasts.length === 0 && (
                    <div className="ol-empty">
                      <b>还没有出场角色</b>
                      点「＋ 添加」，同一角色可以在别的事件里再放一张
                    </div>
                  )}
                  {selEventCasts.map((cast) => {
                    const entity = entities.find((item) => item.id === cast.entityId);
                    if (!entity) return null;
                    const floating = floatingKeys.has(`${cast.eventId}-${cast.entityId}`);
                    return (
                      <button
                        type="button"
                        className="ol-row"
                        key={cast.entityId}
                        onClick={() => openEntity(entity.id)}
                        title="看这个角色跨了哪些事件"
                      >
                        <EntityAvatar entity={entity} size={18} />
                        <span className="ol-row__t">
                          {entity.name}
                          {floating && <span className="ol-tag is-mini">画布上</span>}
                        </span>
                        <span className="ol-row__c">共 {countOf(entity.id)} 处</span>
                        {/* 移除出场：hover 才露出（和卡片 chip 的 ✕ 同语义），
                            点它不触发「看角色汇总」 */}
                        <span
                          className="ol-row__rm"
                          role="button"
                          tabIndex={0}
                          aria-label={`移除 ${entity.name} 出场`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeCast(selEvent.id, entity.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            e.stopPropagation();
                            void removeCast(selEvent.id, entity.id);
                          }}
                        >
                          ✕
                        </span>
                        <span className="ol-row__go">›</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="ol-panel__actions">
                <button type="button" className="ol-danger-btn" onClick={confirmDeleteEvent}>
                  <DeleteOutlined /> 删除事件
                </button>
              </div>
            </div>
          ) : (
            <div className="ol-empty is-lg">
              <b>选一个事件</b>
              点画布上的任意事件卡，这里显示它的出场角色与关系。
              <br />
              要看某个角色跨了哪些事件，点它名字。
            </div>
          ))}

        {tab === "cast" && (
          <>
            {selEntity ? (
              <>
                <button
                  type="button"
                  className="ol-back"
                  onClick={() => selectEntity(null)}
                >
                  ‹ 全部实体
                </button>
                <div className="ol-sumcard" key={selEntity.id}>
                  <div className="ol-sumcard__top">
                    <span
                      className="ol-av"
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        fontSize: 14,
                        background: ENTITY_TYPE_COLOR[selEntity.type][0],
                      }}
                    >
                      {[...selEntity.name][0] ?? "?"}
                    </span>
                    <div className="ol-sumcard__namewrap">
                      <CommitField
                        value={selEntity.name}
                        maxLength={40}
                        className="ol-sumcard__name"
                        onCommit={(value) => {
                          const name = value.trim();
                          if (name && name !== selEntity.name) {
                            void patchEntity(selEntity.id, { name });
                          }
                        }}
                      />
                      <div className="ol-sumcard__type">{ENTITY_TYPE_LABEL[selEntity.type]}</div>
                    </div>
                  </div>
                  <CommitField
                    value={selEntity.body}
                    multiline
                    maxLength={2000}
                    className="ol-sumcard__desc"
                    placeholder="还没有描述。写两句这个角色是谁、想要什么。"
                    onCommit={(value) => void patchEntity(selEntity.id, { body: value })}
                  />
                  <div className="ol-sumcard__alias">
                    <span className="ol-panel__fieldlabel">别名</span>
                    <CommitField
                      value={selEntity.aliases}
                      maxLength={200}
                      placeholder="逗号分隔，如：小九，九爷"
                      onCommit={(value) => void patchEntity(selEntity.id, { aliases: value })}
                    />
                  </div>
                  <div className="ol-sumcard__stat">
                    <div title="出现过的事件数">
                      <b>{appearances.length}</b>出场事件
                    </div>
                    <div title="出场事件分布在几条时间线上">
                      <b>
                        {
                          new Set(
                            appearances
                              .map((event) => event.laneId)
                              .filter((laneId): laneId is string => laneId !== null),
                          ).size
                        }
                      </b>
                      涉及时间线
                    </div>
                    <div title="被拖出成浮卡的引用数">
                      <b>
                        {
                          casts.filter(
                            (cast) =>
                              cast.entityId === selEntity.id &&
                              cast.cardX !== null &&
                              cast.cardY !== null,
                          ).length
                        }
                      </b>
                      画布引用
                    </div>
                  </div>
                </div>

                <div className="ol-sec__head">
                  <b>出现在</b>
                  <span className="ol-sec__n">{appearances.length}</span>
                </div>
                <div className="ol-rowlist">
                  {appearances.length === 0 && (
                    <div className="ol-empty">这个角色还没被任何事件引用。</div>
                  )}
                  {appearances.map((event) => {
                    const laneName = laneById.get(event.laneId ?? "")?.name || "待归类";
                    return (
                      <button
                        type="button"
                        key={event.id}
                        className={`ol-row${selEventId === event.id ? " is-sel" : ""}`}
                        onClick={() => {
                          setTab("event");
                          selectEvent(event.id);
                        }}
                      >
                        <span className="ol-row__t">{event.title || "未命名事件"}</span>
                        <span className="ol-row__c">
                          {laneName} 第 {event.slot + 1} 格
                        </span>
                        <span className="ol-row__go">›</span>
                      </button>
                    );
                  })}
                </div>

                <div className="ol-sec__head">
                  <b>没出场的实体</b>
                </div>
                <div className="ol-rowlist">
                  {unusedEntities.length === 0 && (
                    <div className="ol-empty">所有实体都已挂到事件上。</div>
                  )}
                  {unusedEntities.map((entity) => (
                    <button
                      type="button"
                      key={entity.id}
                      className={`ol-row is-unused${
                        selEntityId === entity.id ? " is-sel" : ""
                      }`}
                      onClick={() => selectEntity(entity.id)}
                    >
                      <EntityAvatar entity={entity} size={18} />
                      <span className="ol-row__t">{entity.name}</span>
                      <span className="ol-row__c">{ENTITY_TYPE_LABEL[entity.type]}</span>
                    </button>
                  ))}
                </div>

                <div className="ol-panel__actions">
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => {
                      modal.confirm({
                        title: `删除「${selEntity.name}」？`,
                        content: "它在各事件里的出场 chip 会一并清理（可在撤销栈找回）。",
                        okText: "删除",
                        okButtonProps: { danger: true },
                        cancelText: "取消",
                        onOk: () => deleteEntity(selEntity.id),
                      });
                    }}
                  >
                    删除角色
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="ol-sec__head">
                  <b>全部实体</b>
                  <span className="ol-sec__n">{entities.length}</span>
                  <span className="ol-sec__sp" />
                  <button
                    type="button"
                    className="ol-link-btn"
                    onClick={() => setCreating((prev) => !prev)}
                  >
                    <PlusOutlined /> 新建
                  </button>
                </div>

                {(creating || entities.length === 0) && (
                  <div className="ol-panel__newrow">
                    <Select
                      size="small"
                      value={newType}
                      className="ol-panel__typesel"
                      options={(
                        ["char", "force", "item", "place", "clue"] as OutlineEntityDTO["type"][]
                      ).map((type) => ({ value: type, label: ENTITY_TYPE_LABEL[type] }))}
                      onChange={(value) => setNewType(value)}
                    />
                    <Input
                      size="small"
                      placeholder="名字（Enter 新建）"
                      maxLength={40}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onPressEnter={createEntity}
                    />
                    <Button
                      size="small"
                      type="primary"
                      disabled={!newName.trim()}
                      onClick={createEntity}
                    >
                      新建
                    </Button>
                  </div>
                )}

                <div className="ol-rowlist">
                  {allEntities.map((entity) => {
                    const count = countOf(entity.id);
                    return (
                      <button
                        type="button"
                        key={entity.id}
                        className="ol-row"
                        onClick={() => selectEntity(entity.id)}
                      >
                        <EntityAvatar entity={entity} size={18} />
                        <span className="ol-row__t">{entity.name}</span>
                        <span className="ol-row__c">
                          {count > 0 ? `${count} 次出场` : "未使用"}
                        </span>
                        <span className="ol-row__go">›</span>
                      </button>
                    );
                  })}
                </div>

                {entities.length > 0 && (
                  <div className="ol-empty">
                    点任意角色看它跨了哪些事件。
                    <br />
                    画布上每个事件旁都可以放一张同名卡，右侧负责汇总。
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      <div className="ol-panel__foot">
        <span className="ol-kbd">N</span> 新建
        <span className="ol-kbd">Del</span> 删除
        <span className="ol-kbd">Ctrl+Z</span> 撤销
        <span className="ol-kbd">方向键</span> 移格
        <span className="ol-kbd">Ctrl+Shift+L</span> 整理
      </div>
    </aside>
  );
}
