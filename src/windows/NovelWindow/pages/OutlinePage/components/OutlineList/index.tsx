/**
 * 大纲视图（§7.1「大纲」模式）：多列分组网格——每条时间线一列卡片，
 * 待归类一列虚线卡；行点击选中事件（与时间轴同源数据、同一选中态）。
 * 搜索口径与画布完全一致（共用 outlineSearchHits：标题/摘要/别名/结构名），
 * 未命中行淡出，保留结构感。
 */
import { useMemo } from "react";
import { Button } from "antd";
import {
  chainNumbers,
  chainOf,
  looseEvents,
  outlineSearchHits,
  type ChainEvent,
} from "@/shared/novel/outline";
import { useOutlineStore } from "../../store/useOutlineStore";
import type { OutlineEventDTO } from "@/shared/types/electron";
import { ENTITY_TYPE_COLOR } from "../EventCard/constants";
import "./index.scss";

const asChain = (event: OutlineEventDTO): ChainEvent => ({
  id: event.id,
  laneId: event.laneId,
  slot: event.slot,
  sort: event.sort,
  breakBefore: event.breakBefore,
});

export default function OutlineList() {
  const lanes = useOutlineStore((s) => s.lanes);
  const events = useOutlineStore((s) => s.events);
  const entities = useOutlineStore((s) => s.entities);
  const casts = useOutlineStore((s) => s.casts);
  const zones = useOutlineStore((s) => s.zones);
  const eras = useOutlineStore((s) => s.eras);
  const query = useOutlineStore((s) => s.query);
  const selEventId = useOutlineStore((s) => s.selEventId);
  const selectEvent = useOutlineStore((s) => s.selectEvent);

  const sortedLanes = useMemo(() => [...lanes].sort((a, b) => a.sort - b.sort), [lanes]);
  const byId = useMemo(() => new Map(entities.map((entity) => [entity.id, entity])), [entities]);
  const searchHits = useMemo(
    () => outlineSearchHits({ events, entities, casts, lanes, zones, eras }, query),
    [events, entities, casts, lanes, zones, eras, query],
  );

  const renderRow = (event: OutlineEventDTO, chainNumber: number): React.ReactNode => {
    const own = casts.filter((cast) => cast.eventId === event.id);
    const dimmed = searchHits !== null && !searchHits.has(event.id);
    return (
      <Button
        type="text"
        key={event.id}
        className={`ol-list__row${selEventId === event.id ? " is-sel" : ""}${dimmed ? " is-dim" : ""}`}
        onClick={() => selectEvent(selEventId === event.id ? null : event.id)}
      >
        <span className="ol-list__idx">{chainNumber}</span>
        <div className="ol-list__main">
          <div className="ol-list__title">
            {event.title || "未命名事件"}
            {event.whenText && <span className="ol-list__when">{event.whenText}</span>}
          </div>
          {event.body && <div className="ol-list__body">{event.body}</div>}
          {own.length > 0 && (
            <div className="ol-list__casts">
              {own.map((cast) => {
                const entity = byId.get(cast.entityId);
                if (!entity) return null;
                return (
                  <span className="ol-list__cast" key={cast.entityId}>
                    <span
                      className="ol-list__av"
                      style={{ background: ENTITY_TYPE_COLOR[entity.type][0] }}
                    >
                      {[...entity.name][0] ?? "?"}
                    </span>
                    {entity.name}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </Button>
    );
  };

  return (
    <div className="ol-list" role="list" aria-label="大纲列表">
      <div className="ol-list__grid">
        {sortedLanes.map((lane) => {
          const chain = chainOf(events.map(asChain), lane.id);
          const numbers = chainNumbers(chain);
          const laneMatch = query.trim() === "" || chain.some((item) => searchHits?.has(item.id));
          const byIdMap = new Map(events.map((event) => [event.id, event]));
          return (
            <section
              key={lane.id}
              className={`ol-list__sec${laneMatch ? "" : " is-dim"}`}
            >
              <header className="ol-list__head">
                <b>{lane.name || "未命名时间线"}</b>
                <span>{chain.length} 事件</span>
              </header>
              <div className="ol-list__rows">
                {chain.length === 0 && <div className="ol-list__empty">这条时间线还没有事件</div>}
                {chain.map((item) => {
                  const event = byIdMap.get(item.id);
                  return event ? renderRow(event, numbers.get(item.id) ?? 1) : null;
                })}
              </div>
            </section>
          );
        })}

        {(() => {
          const loose = looseEvents(events.map(asChain));
          const numbers = chainNumbers(loose);
          const byIdMap = new Map(events.map((event) => [event.id, event]));
          return (
            <section className="ol-list__sec is-loose">
              <header className="ol-list__head">
                <b>待归类</b>
                <span>{loose.length} 事件</span>
              </header>
              <div className="ol-list__rows">
                {loose.length === 0 && <div className="ol-list__empty">没有待归类的事件</div>}
                {loose.map((item) => {
                  const event = byIdMap.get(item.id);
                  return event ? renderRow(event, numbers.get(item.id) ?? 1) : null;
                })}
              </div>
            </section>
          );
        })()}
      </div>

      {events.length > 0 && searchHits !== null && searchHits.size === 0 && (
        <div className="ol-list__empty-lg">
          没找到「{query.trim()}」 · 可搜标题、摘要、时间文本、角色名与别名、时间线 / 区域 / 时间段名
        </div>
      )}
    </div>
  );
}
