import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTITY_TYPE_META } from "@/shared/novel/entity-type-meta";
import EntityTypeChip from ".";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("EntityTypeChip：色带承载分类、形态按 §6.1.2", () => {
  it("纯展示用 antd Tag，不渲染文字前缀（真机反馈：前缀是废话）", () => {
    const { container } = render(
      <EntityTypeChip meta={ENTITY_TYPE_META.character}>林晚照</EntityTypeChip>,
    );
    expect(container.querySelector(".ant-tag")).not.toBeNull();
    expect(screen.getByText("林晚照")).toBeTruthy();
    // 单字前缀已废弃：chip 里不应再出现「人」这类分类前缀字
    expect(screen.queryByText("人")).toBeNull();
    expect(container.querySelector(".nv-type-chip__glyph")).toBeNull();
    expect(container.querySelector(".ant-btn")).toBeNull();
  });

  it("色带承载类型色：左边框取 meta.color（去色前的唯一分类线索）", () => {
    const { container } = render(
      <EntityTypeChip meta={ENTITY_TYPE_META.location}>青云山</EntityTypeChip>,
    );
    const tag = container.querySelector(".ant-tag") as HTMLElement;
    expect(tag.style.borderLeftColor).toContain("--app-accent-green");
  });

  it("可点筛选用一个 antd Button + aria-pressed，点击回调透传", () => {
    const onClick = vi.fn();
    const { container } = render(
      <EntityTypeChip
        meta={ENTITY_TYPE_META.location}
        pressed
        onClick={onClick}
      >
        青云山
      </EntityTypeChip>,
    );
    const button = container.querySelector("button.ant-btn");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("地")).toBeNull();
    (button as HTMLElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
