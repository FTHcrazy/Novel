/**
 * 文档索引与元信息守卫
 *
 * 【为什么需要它】文档的事实一致性一旦没有机制兜底，坏法永远是同几种：
 * 索引里查不到的文档、索引指向已删除的文件、新文档缺「输入 / 基线」无法判断是否过期、
 * 以及 `AGENTS.md` 声明的篇数与实物不一致。这些都不是笔误，是**没人拦着下一个人再写一遍**。
 *
 * 【钉什么】只钉「机器可判定、判错必然意味着文档坏了」的五件事：
 *   ① **索引双向**：`docs/` 下每篇文档都在 `docs/README.md` 索引里；索引里每条相对链接
 *      都真实存在。索引是唯一导航入口，单向都不行。
 *   ② **头部三行**：每篇非索引文档必须有 `> 状态` / `> 输入` / `> 基线`。
 *   ③ **命名**：`docs/spec/` 下只允许 `<主题>-spec.md`（本仓只保留活规范一级，
 *      过程稿不进仓库，见 AGENTS.md §5.1）。
 *   ④ **引用无悬空**：全仓 `docs/...md` 引用都指向真实存在的文件。
 *   ⑤ **形态描述与实物一致**：`AGENTS.md` §5.1 目录树里的「合计 N 篇 md」必须等于实物篇数
 *      —— 这一节是规范的自我例证，一旦失真比任何单篇笔误都更误导人。
 *
 * 【明确不钉什么】—— 这两条是刻意放弃的，不是遗漏：
 *   - **不钉用例数真值**：它只能实跑 vitest 得出，写死在测试里就是第二事实源。
 *   - **不钉「文档基线 == package.json version」**：`基线` 的语义是「本篇订立时对应的
 *     代码版本」（历史事实），强制相等会让每次发版都要改一堆历史文档。
 *
 * 【判据不能自己命中自己】本文件在扫描引用时**排除自身**：它必须用 `docs/prd/...` 这类
 * 字面量来说明「以前长什么样」，否则判据会把自己当悬空引用。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCS_DIR = path.resolve(ROOT, "docs");
const README_REL = "docs/README.md";
const SELF_REL = "electron/docs-index-guard.test.ts";

/** 文档头部三行的键名 */
const HEAD_KEYS = ["状态", "输入", "基线"] as const;
/** 头部三行只在前若干行内认（正文里出现同名前缀不算） */
const HEAD_SCAN_LINES = 15;

/** 引用源扫描面（`docs/**`、`src/**` 注释、根文档） */
const SCAN_ROOTS = ["docs", "src", "electron", "scripts"];
const SCAN_ROOT_FILES = ["AGENTS.md", "README.md"];
const SCAN_EXTS = new Set([".md", ".ts", ".tsx", ".yaml", ".yml"]);
/** 与 grep 的 `--exclude-dir` 对齐（按目录名，任意层级匹配） */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "release",
  "changeLogHistory",
  ".workbuddy",
  "coverage",
]);

function toRel(absPath: string): string {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

function read(relPath: string): string {
  return readFileSync(path.resolve(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

function walkDocs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDocs(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(toRel(full));
  }
  return acc;
}

function walkForRefs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkForRefs(full, acc);
      continue;
    }
    if (SCAN_EXTS.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

/** `docs/` 下全部 md（含 README.md 自身，调用方按需排除） */
const ALL_DOCS = walkDocs(DOCS_DIR).sort();

/**
 * README 里的相对链接 → 仓库相对路径。
 *
 * 只认 `.md` 且非 http(s)、非纯锚点。README 的链接一律相对 `docs/` 书写
 * （`spec/x.md`），所以以 docs 为基准解析。
 */
function readmeLinkTargets(): string[] {
  const text = read(README_REL);
  const pattern = /\]\((?!https?:|#)([^)\s]+?\.md)(?:#[^)]*)?\)/g;
  const targets: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;
    targets.push(path.posix.normalize(path.posix.join("docs", raw)));
  }
  return [...new Set(targets)].sort();
}

/** 文档头部的三行（只在前 HEAD_SCAN_LINES 行内认，避免正文里的同名引用块误判） */
function missingHeadKeys(relPath: string): string[] {
  const head = read(relPath).split("\n").slice(0, HEAD_SCAN_LINES);
  return HEAD_KEYS.filter((key) => !head.some((line) => line.startsWith(`> ${key}`)));
}

/**
 * 从一条文本里抽出 `docs/...` 形式的 `.md` 引用。
 *
 * 路径首段必须以字母数字 / 下划线 / 连字符开头：文档里描述规则时天然会写
 * 「`docs/...md` 引用」这种占位写法，宽松匹配会把**占位符本身**当成一条悬空路径。
 * 结尾限定 `.md`，避免把 `docs/spec/map-db-spec.md:23` 的行号吃进路径。
 */
const DOC_REF = /docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md/g;

function danglingRefs(): string[] {
  const sources: string[] = [];
  for (const rel of SCAN_ROOT_FILES) {
    const abs = path.resolve(ROOT, rel);
    if (existsSync(abs)) sources.push(abs);
  }
  for (const root of SCAN_ROOTS) {
    const abs = path.resolve(ROOT, root);
    if (existsSync(abs)) walkForRefs(abs, sources);
  }

  const missing = new Set<string>();
  for (const abs of sources) {
    if (toRel(abs) === SELF_REL) continue; // 判据不能自己命中自己
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(DOC_REF)) {
      if (!existsSync(path.resolve(ROOT, match[0]))) missing.add(match[0]);
    }
  }
  return [...missing].sort();
}

describe("docs 索引与元信息", () => {
  it("① 索引双向：docs 下每篇文档都在 README 索引里", () => {
    const indexed = new Set(readmeLinkTargets());
    const unindexed = ALL_DOCS.filter((rel) => rel !== README_REL && !indexed.has(rel));

    // 失败时给出可直接照抄的补行清单，而不是让人自己 grep
    expect(unindexed, `以下文档存在但 README 查不到索引行：\n${unindexed.join("\n")}`).toEqual([]);
  });

  it("① 索引双向：README 每条链接都指向真实文件", () => {
    const ghosts = readmeLinkTargets().filter((rel) => !existsSync(path.resolve(ROOT, rel)));

    expect(ghosts, `README 指向不存在的文件：\n${ghosts.join("\n")}`).toEqual([]);
  });

  it("② 每篇文档必须有头部三行（状态 / 输入 / 基线）", () => {
    const offenders = ALL_DOCS.filter((rel) => rel !== README_REL)
      .map((rel) => ({ rel, missing: missingHeadKeys(rel) }))
      .filter((item) => item.missing.length > 0);

    const detail = offenders.map((item) => `${item.rel} 缺：${item.missing.join(" / ")}`);
    expect(detail, `以下文档缺头部三行：\n${detail.join("\n")}`).toEqual([]);
  });

  it("③ 活规范一律以 -spec.md 结尾", () => {
    const offenders = ALL_DOCS.filter(
      (rel) => rel !== README_REL && !rel.endsWith("-spec.md"),
    );

    expect(
      offenders,
      `本仓只保留活规范：\`docs/spec/<主题>-spec.md\`。以下文档命名不合规（过程稿的结论应并入 AGENTS.md / CHANGELOG.md）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("④ 全仓 docs 引用不得悬空", () => {
    expect(danglingRefs(), "以下引用指向不存在的文档：\n").toEqual([]);
  });

  it("⑤ AGENTS 声明的文档总数与实物一致", () => {
    const match = /合计 (\d+) 篇 md/.exec(read("AGENTS.md"));
    if (!match) {
      throw new Error(
        "AGENTS.md §5.1 目录树必须保留「合计 N 篇 md」这句（本守卫依赖它定位数字）",
      );
    }

    expect(
      Number(match[1]),
      `AGENTS.md 声明 ${match[1]} 篇，docs/ 下实为 ${ALL_DOCS.length} 篇`,
    ).toBe(ALL_DOCS.length);
  });
});
