/**
 * 大纲搜索命中集合（outline-plan-spec §8.9）
 *
 * 范围：事件标题 / 正文 / 时间文本 / 实体名与别名 / 泳道名 / 区域名与说明 /
 * 时代带名。语义是「只高亮不隐藏」——返回命中的事件 id 集合，渲染层把集合外
 * 的卡压暗；`null` 表示没有搜索词（全部正常）。
 *
 * 这里集中一份判定，避免画布 / 托盘 / 列表三处各写一套（此前别名、区域名、
 * 时代带名都没进搜索，泳道名只压暗列表头）。纯函数、无 IO，可单测。
 */
import { matchEvent, matchLabel } from "./chips";

export interface SearchEvent {
  id: string;
  title: string;
  body: string;
  whenText: string;
  laneId: string | null;
  slot: number;
}

export interface SearchEntity {
  id: string;
  name: string;
  aliases: string;
}

export interface SearchCast {
  eventId: string;
  entityId: string;
}

export interface SearchLane {
  id: string;
  name: string;
}

export interface SearchZone {
  id: string;
  laneId: string;
  name: string;
  note: string;
  fromSlot: number;
  toSlot: number;
}

export interface SearchEra {
  id: string;
  name: string;
  fromSlot: number;
  toSlot: number;
}

export interface SearchScope {
  events: readonly SearchEvent[];
  entities: readonly SearchEntity[];
  casts: readonly SearchCast[];
  lanes: readonly SearchLane[];
  zones: readonly SearchZone[];
  eras: readonly SearchEra[];
}

/** 别名串按中英文逗号 / 顿号 / 空白切分 */
export function splitAliases(aliases: string): string[] {
  return aliases
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 命中集合。返回 null = 无搜索词（调用方不要压暗任何东西）。
 * 结构名（泳道 / 区域 / 时代带）命中时，其覆盖范围内的事件一并算命中。
 */
export function outlineSearchHits(
  scope: SearchScope,
  query: string,
): Set<string> | null {
  const needle = query.trim();
  if (!needle) return null;

  const entityById = new Map(scope.entities.map((entity) => [entity.id, entity]));
  const namesByEvent = new Map<string, string[]>();
  for (const cast of scope.casts) {
    const entity = entityById.get(cast.entityId);
    if (!entity) continue;
    const names = namesByEvent.get(cast.eventId) ?? [];
    names.push(entity.name, ...splitAliases(entity.aliases));
    namesByEvent.set(cast.eventId, names);
  }

  const laneHits = new Set(
    scope.lanes.filter((lane) => matchLabel(lane.name, needle)).map((lane) => lane.id),
  );
  const zoneHits = scope.zones.filter(
    (zone) => matchLabel(zone.name, needle) || matchLabel(zone.note, needle),
  );
  const eraHits = scope.eras.filter((era) => matchLabel(era.name, needle));

  const hits = new Set<string>();
  for (const event of scope.events) {
    if (
      matchEvent(
        {
          id: event.id,
          title: event.title,
          body: event.body,
          whenText: event.whenText,
          castNames: namesByEvent.get(event.id) ?? [],
        },
        needle,
      )
    ) {
      hits.add(event.id);
      continue;
    }
    if (event.laneId !== null && laneHits.has(event.laneId)) {
      hits.add(event.id);
      continue;
    }
    const inZone = zoneHits.some(
      (zone) =>
        zone.laneId === event.laneId &&
        event.slot >= zone.fromSlot &&
        event.slot <= zone.toSlot,
    );
    if (inZone) {
      hits.add(event.id);
      continue;
    }
    const inEra = eraHits.some(
      (era) => event.slot >= era.fromSlot && event.slot <= era.toSlot,
    );
    if (inEra) hits.add(event.id);
  }
  return hits;
}
