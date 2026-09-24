import { describe, expect, test } from "bun:test";
import { compareRevision, sideBySideLines } from "../src/history.ts";
import type { Page, Revision } from "../src/domain.ts";

describe("revision diffs", () => {
  test("builds side-by-side rows for changed lines", () => {
    expect(sideBySideLines("same\nold\n", "same\nnew\nextra\n")).toEqual([
      { left: "same", right: "same", leftKind: "same", rightKind: "same" },
      { left: "old", right: "new", leftKind: "removed", rightKind: "added" },
      { left: null, right: "extra", leftKind: "blank", rightKind: "added" },
    ]);
  });

  test("compares metadata and body", () => {
    const revision: Revision = { id: 4, pageId: 1, title: "Old", alias: "old", body: "before", tags: ["a"], status: "draft", parentId: null, properties: { owner: "old" }, source: "web", createdAt: "2026-01-01T00:00:00Z" };
    const page: Page = { id: 1, title: "New", alias: "new", body: "after", tags: ["b"], status: "published", parentId: null, properties: { owner: "new" }, breadcrumbs: [], backlinks: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" };
    const diff = compareRevision(revision, page);
    expect(diff.metadataChanged).toBe(true);
    expect(diff.body[0]?.left).toBe("before");
    expect(diff.body[0]?.right).toBe("after");
  });
});
