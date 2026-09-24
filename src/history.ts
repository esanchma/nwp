import { diffLines } from "diff";
import type { Page, Revision } from "./domain.ts";

export interface DiffRow {
  left: string | null;
  right: string | null;
  leftKind: "same" | "removed" | "blank";
  rightKind: "same" | "added" | "blank";
}

export interface PageDiff {
  revisionId: number;
  pageId: number;
  from: { title: string; alias: string; tags: string[]; status: string; parentId: number | null; properties: Record<string, unknown>; createdAt: string };
  to: { title: string; alias: string; tags: string[]; status: string; parentId: number | null; properties: Record<string, unknown>; updatedAt: string };
  metadataChanged: boolean;
  body: DiffRow[];
}

export function compareRevision(revision: Revision, current: Page): PageDiff {
  return {
    revisionId: revision.id,
    pageId: current.id,
    from: {
      title: revision.title,
      alias: revision.alias,
      tags: revision.tags,
      status: revision.status,
      parentId: revision.parentId,
      properties: revision.properties,
      createdAt: revision.createdAt,
    },
    to: {
      title: current.title,
      alias: current.alias,
      tags: current.tags,
      status: current.status,
      parentId: current.parentId,
      properties: current.properties,
      updatedAt: current.updatedAt,
    },
    metadataChanged: revision.title !== current.title || revision.alias !== current.alias || !sameArray(revision.tags, current.tags) || revision.status !== current.status || revision.parentId !== current.parentId || JSON.stringify(revision.properties) !== JSON.stringify(current.properties),
    body: sideBySideLines(revision.body, current.body),
  };
}

export function sideBySideLines(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const changes = diffLines(before, after);

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (change.removed && changes[index + 1]?.added) {
      const removed = lines(change.value);
      const added = lines(changes[index + 1]!.value);
      const count = Math.max(removed.length, added.length);
      for (let line = 0; line < count; line += 1) {
        rows.push({
          left: removed[line] ?? null,
          right: added[line] ?? null,
          leftKind: removed[line] === undefined ? "blank" : "removed",
          rightKind: added[line] === undefined ? "blank" : "added",
        });
      }
      index += 1;
      continue;
    }

    for (const line of lines(change.value)) {
      if (change.added) rows.push({ left: null, right: line, leftKind: "blank", rightKind: "added" });
      else if (change.removed) rows.push({ left: line, right: null, leftKind: "removed", rightKind: "blank" });
      else rows.push({ left: line, right: line, leftKind: "same", rightKind: "same" });
    }
  }

  return rows;
}

function lines(value: string): string[] {
  if (!value) return [];
  const result = value.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
