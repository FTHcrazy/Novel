import { describe, expect, it } from "vitest";
import { createTypeMetaResolver, customTypeMeta, ENTITY_TYPE_META } from "./entity-type-meta";

/**
 * 类型 meta 的单一事实源契约。
 *
 * 单字前缀（O-17）已废弃：自建类型一律「其」毫无信息量，真机反馈
 * 「前缀完全是废话」——分类信息改由类型色（色带 / 色点 / 标签底色）
 * 承担，hover 卡直接展示类型名。
 */
describe("entity-type-meta：类型 meta", () => {
  it("内置六类的展示名固定", () => {
    expect(ENTITY_TYPE_META.character.label).toBe("角色");
    expect(ENTITY_TYPE_META.location.label).toBe("地点");
    expect(ENTITY_TYPE_META.faction.label).toBe("势力");
    expect(ENTITY_TYPE_META.item.label).toBe("物品");
    expect(ENTITY_TYPE_META.level_system.label).toBe("等级体系");
    expect(ENTITY_TYPE_META.custom.label).toBe("自定义");
  });

  it("自建类型展示名取类型名，含已删除自建类型的兜底路径", () => {
    const def = {
      id: "ct-1",
      name: "宗门",
      color: "var(--app-accent-purple)",
    };
    expect(customTypeMeta(def).label).toBe("宗门");
    const resolve = createTypeMetaResolver([def]);
    expect(resolve("ct-1").label).toBe("宗门");
    // 删除后回落到「自定义」，不允许抛错
    expect(resolve("ct-deleted").label).toBe("自定义");
  });
});
