/**
 * 待归类托盘（§7.1 / FR-03）：画布左缘固定竖条，laneId=null 的事件只渲染在这里。
 * 拖拽期间指针悬入 = 高亮提示，松手 = 转待归类（store.setDragTrayHint）。
 */
import { useRef } from "react";
import { useOutlineStore, trayCount } from "../../store/useOutlineStore";
import {
  chainNumbers,
  looseEvents,
  outlineSearchHits,
  type ChainEvent,
} from "@/shared/novel/outline";
import type { OutlineEventDTO } from "@/shared/types/electron";
import { beginCardDrag } from "../../dragGesture";
import EventCard from "../EventCard";
import "./index.scss";

const asChain = (event: OutlineEventDTO): ChainEvent => ({
  id: event.id,
  laneId: event.laneId,
  slot: event.slot,
  sort: event.sort,
  breakBefore: event.breakBefore,
});

export default function OutlineTray() {
  const events = useOutlineStore((s) => s.events);
  const entities = useOutlineStore((s) => s.entities);
  const casts = useOutlineStore((s) => s.casts);
  const lanes = useOutlineStore((s) => s.lanes);
  const zones = useOutlineStore((s) => s.zones);
  const eras = useOutlineStore((s) => s.eras);
  const query = useOutlineStore((s) => s.query);
  const selEventId = useOutlineStore((s) => s.selEventId);
  const zoneArm = useOutlineStore((s) => s.zoneArm);
  const drag = useOutlineStore((s) => s.drag);
  const selectEvent = useOutlineStore((s) => s.selectEvent);
  const armZone = useOutlineStore((s) => s.armZone);
  const removeCast = useOutlineStore((s) => s.removeCast);
  const addCast = useOutlineStore((s) => s.addCast);
  const setDragTrayHint = useOutlineStore((s) => s.setDragTrayHint);
  const finishDrag = useOutlineStore((s) => s.finishDrag);

  const rootRef = useRef<HTMLDivElement>(null);
  const loose = looseEvents(events.map(asChain));
  const numbers = chainNumbers(loose);
  const count = trayCount(events);
  const searchHits = outlineSearchHits(
    { events, entities, casts, lanes, zones, eras },
    query,
  );

  return (
    <aside
      ref={rootRef}
      className={`ol-tray${drag?.toTray ? " is-hint" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onPointerEnter={() => {
        if (drag) setDragTrayHint(true);
      }}
      onPointerLeave={() => {
        if (drag?.toTray) setDragTrayHint(false);
      }}
      onPointerUp={() => {
        if (drag?.toTray) void finishDrag(true);
      }}
    >
      <div className="ol-tray__head">
        待归类
        <span className="ol-tray__cnt">{count}</span>
      </div>
      <div className="ol-tray__list">
        {loose.length === 0 && (
          <div className="ol-tray__empty">
            没有待归类的事件
            <br />
            按 N 新建，或把时间格上的卡拖进来
          </div>
        )}
        {loose.map((item) => {
          const event = events.find((candidate) => candidate.id === item.id);
          if (!event) return null;
          const own = casts.filter((cast) => cast.eventId === event.id);
          return (
            <div className="ol-tray__item" key={event.id} data-event-id={event.id}>
              <EventCard
                event={event}
                chainNumber={numbers.get(event.id) ?? 1}
                casts={own}
                entities={entities}
                selected={selEventId === event.id}
                zoneArmTarget={zoneArm === event.id}
                dimmed={searchHits !== null && !searchHits.has(event.id)}
                floatingCastIds={own
                  .filter((cast) => cast.cardX !== null && cast.cardY !== null)
                  .map((cast) => cast.entityId)}
                onPointerDown={(e) => beginCardDrag(event.id, e)}
                onClick={() => {
                  // 包区域两步选点：托盘卡不参与（必须在线上），仅选中
                  if (zoneArm) {
                    armZone(null);
                    return;
                  }
                  selectEvent(event.id);
                }}
                onRemoveCast={(entityId) => void removeCast(event.id, entityId)}
                onAddCast={(entityId) => void addCast(event.id, entityId)}
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
