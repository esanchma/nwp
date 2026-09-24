import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PageStore } from "../src/database.ts";

const stores: PageStore[] = [];
const dirs: string[] = [];

async function store(): Promise<PageStore> {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "db-test-"));
  dirs.push(dir);
  const value = new PageStore(join(dir, "nwp.db"));
  stores.push(value);
  return value;
}

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("PageStore", () => {
  test("creates pages, unique aliases, tags, and cursor lists", async () => {
    const db = await store();
    const first = db.create({ title: "Hello World", body: "Hi", tags: ["Wiki", "wiki"] }, "web");
    const second = db.create({ title: "Hello World", body: "Again", tags: [] }, "mcp");

    expect(first.alias).toBe("hello-world");
    expect(first.tags).toEqual(["wiki"]);
    expect(second.alias).toBe("hello-world-2");

    const page1 = db.list(null, 1);
    expect(page1.pages).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    expect(db.list(page1.nextCursor, 1).pages).toHaveLength(1);
  });

  test("indexes backlinks", async () => {
    const db = await store();
    const target = db.create({ title: "Target", body: "", tags: [] }, "web");
    db.create({ title: "Source", body: "Read [[target]].", tags: [] }, "web");
    expect(db.getById(target.id).backlinks.map(({ alias }) => alias)).toEqual(["source"]);
  });

  test("stores one revision only for meaningful updates", async () => {
    const db = await store();
    const page = db.create({ title: "Page", body: "one", tags: ["a"] }, "web");
    db.update(page.id, { body: "one" }, "cli");
    expect(db.revisionCount(page.id)).toBe(0);
    db.update(page.id, { body: "two", tags: ["b"] }, "cli");
    expect(db.revisionCount(page.id)).toBe(1);
    expect(db.getById(page.id).body).toBe("two");
  });

  test("searches title, alias, body, and tags", async () => {
    const db = await store();
    const guide = db.create({ title: "Bun Installation", alias: "setup-guide", body: "Install the runtime quickly.", tags: ["developer"] }, "web");
    db.create({ title: "Cooking", body: "A different guide.", tags: ["home"] }, "web");

    expect(db.search("installation").pages.map(({ id }) => id)).toEqual([guide.id]);
    expect(db.search("setup").pages.map(({ id }) => id)).toEqual([guide.id]);
    expect(db.search("runtime", ["developer"]).pages.map(({ id }) => id)).toEqual([guide.id]);
    expect(db.search("", ["developer"]).pages.map(({ id }) => id)).toEqual([guide.id]);
    expect(db.search("runtime", ["home"]).pages).toHaveLength(0);

    db.update(guide.id, { body: "The searchable phrase changed." }, "web");
    expect(db.search("runtime").pages).toHaveLength(0);
    expect(db.search("searchable").pages.map(({ id }) => id)).toEqual([guide.id]);
  });

  test("paginates search results", async () => {
    const db = await store();
    for (let index = 0; index < 3; index += 1) db.create({ title: `Common ${index}`, body: "shared term", tags: [] }, "web");
    const first = db.search("shared", [], null, 2);
    expect(first.pages).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(db.search("shared", [], first.nextCursor, 2).pages).toHaveLength(1);
  });

  test("lists and restores complete revisions", async () => {
    const db = await store();
    const page = db.create({ title: "Original", alias: "original", body: "version one", tags: ["old"] }, "web");
    db.update(page.id, { title: "Current", alias: "current", body: "version two", tags: ["new"] }, "cli");

    const history = db.listRevisions(page.id);
    expect(history.revisions).toHaveLength(1);
    const revision = db.getRevision(page.id, history.revisions[0]!.id);
    expect(revision.body).toBe("version one");
    expect(revision.tags).toEqual(["old"]);

    db.create({ title: "Alias owner", alias: "original", body: "", tags: [] }, "web");
    const restored = db.restoreRevision(page.id, revision.id, "mcp");
    expect(restored.title).toBe("Original");
    expect(restored.body).toBe("version one");
    expect(restored.tags).toEqual(["old"]);
    expect(restored.alias).toBe("original-2");
    expect(db.revisionCount(page.id)).toBe(2);
  });

  test("soft-deletes, releases aliases, restores, and purges pages", async () => {
    const db = await store();
    const page = db.create({ title: "Disposable", alias: "disposable", body: "find this", tags: ["temporary"] }, "web");
    db.update(page.id, { body: "find this version two" }, "web");
    const deleted = db.deletePage(page.id);

    expect(deleted.alias).toBe("disposable");
    expect(db.list().pages).toHaveLength(0);
    expect(db.search("find").pages).toHaveLength(0);
    expect(db.listTags()).toHaveLength(0);
    expect(() => db.getByAlias("disposable")).toThrow("not found");
    expect(db.listTrash().pages[0]?.id).toBe(page.id);

    db.create({ title: "Replacement", alias: "disposable", body: "", tags: [] }, "web");
    const restored = db.restoreDeleted(page.id);
    expect(restored.alias).toBe("disposable-2");
    expect(db.search("version").pages.map(({ id }) => id)).toContain(page.id);

    db.deletePage(page.id);
    db.purgeDeleted(page.id);
    expect(() => db.getDeletedById(page.id)).toThrow("not found");
    expect(db.db.query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM revisions WHERE page_id = ?").get(page.id)?.count).toBe(0);
  });

  test("stores statuses, scalar properties, parents, and breadcrumbs", async () => {
    const db = await store();
    const root = db.create({ title: "Root", body: "", tags: [], status: "published", properties: { owner: "team", priority: 2, active: true, note: null } }, "web");
    const child = db.create({ title: "Child", body: "property needle", tags: [], status: "draft", parentId: root.id, properties: { owner: "team" } }, "web");
    const grandchild = db.create({ title: "Grandchild", body: "", tags: [], parentId: child.id }, "web");

    expect(db.list().pages.map(({ id }) => id)).toEqual([grandchild.id, root.id]);
    expect(db.list(null, 50, "draft").pages.map(({ id }) => id)).toEqual([child.id]);
    expect(db.getById(child.id).breadcrumbs.map(({ id }) => id)).toEqual([root.id]);
    expect(db.getById(grandchild.id).breadcrumbs.map(({ id }) => id)).toEqual([root.id, child.id]);
    expect(db.search("needle").pages).toHaveLength(0);
    expect(db.search("needle", [], null, 20, "draft", { owner: "team" }).pages.map(({ id }) => id)).toEqual([child.id]);
    expect(db.search("priority").pages.map(({ id }) => id)).toEqual([root.id]);
    expect(db.tree("all").map(({ depth }) => depth)).toEqual([0, 1, 2]);
    expect(() => db.update(root.id, { parentId: grandchild.id }, "web")).toThrow("cycle");
  });

  test("restores advanced metadata from revisions", async () => {
    const db = await store();
    const parent = db.create({ title: "Parent", body: "", tags: [] }, "web");
    const page = db.create({ title: "Metadata", body: "one", tags: [], status: "draft", parentId: parent.id, properties: { version: 1 } }, "web");
    db.update(page.id, { status: "archived", parentId: null, properties: { version: 2 } }, "web");
    const revision = db.listRevisions(page.id).revisions[0]!;
    expect(revision).toMatchObject({ status: "draft", parentId: parent.id, properties: { version: 1 } });
    const restored = db.restoreRevision(page.id, revision.id, "web");
    expect(restored).toMatchObject({ status: "draft", parentId: parent.id, properties: { version: 1 } });
  });

  test("deduplicates attachments and follows the page lifecycle", async () => {
    const db = await store();
    const firstPage = db.create({ title: "First", body: "", tags: [] }, "web");
    const secondPage = db.create({ title: "Second", body: "", tags: [] }, "web");
    const bytes = new TextEncoder().encode("same content");
    const first = db.addAttachment(firstPage.id, "notes.txt", "text/plain", bytes, null);
    const second = db.addAttachment(secondPage.id, "copy.txt", "text/plain", bytes, null);

    expect(first.sha256).toBe(second.sha256);
    const contentPath = db.attachmentPath(first.id).path;
    expect(existsSync(contentPath)).toBe(true);
    db.removeAttachment(first.id);
    expect(existsSync(contentPath)).toBe(true);

    db.deletePage(secondPage.id);
    expect(() => db.getAttachment(second.id)).toThrow("not found");
    expect(db.listAttachments(secondPage.id, true)).toHaveLength(1);
    db.restoreDeleted(secondPage.id);
    expect(db.getAttachment(second.id).filename).toBe("copy.txt");
    db.deletePage(secondPage.id);
    db.purgeDeleted(secondPage.id);
    expect(existsSync(contentPath)).toBe(false);
  });

  test("detects safe images and enforces attachment limits", async () => {
    const db = await store();
    const page = db.create({ title: "Files", body: "", tags: [] }, "web");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(db.addAttachment(page.id, "image.png", "text/html", png, 20).mimeType).toBe("image/png");
    expect(db.listAttachments(page.id)[0]?.inlineSafe).toBe(true);
    expect(() => db.addAttachment(page.id, "large.bin", "application/octet-stream", new Uint8Array(21), 20)).toThrow("exceeds");
    expect(() => db.addAttachment(page.id, "../bad", "text/plain", new Uint8Array(), null)).toThrow("filename");
  });

  test("backs up and indexes an existing database during migration", async () => {
    const original = await store();
    const dbPath = original.db.filename;
    original.create({ title: "Before Migration", body: "legacy searchable text", tags: [] }, "web");
    original.db.run("DROP TABLE page_attachments");
    original.db.run("DROP TABLE attachment_blobs");
    original.db.run("DROP TABLE page_properties");
    original.db.run("DROP TABLE page_search");
    original.db.run("DROP INDEX pages_status_idx");
    original.db.run("DROP INDEX pages_parent_idx");
    original.db.run("ALTER TABLE revisions DROP COLUMN properties_json");
    original.db.run("ALTER TABLE revisions DROP COLUMN parent_id");
    original.db.run("ALTER TABLE revisions DROP COLUMN status");
    original.db.run("ALTER TABLE pages DROP COLUMN properties_json");
    original.db.run("ALTER TABLE pages DROP COLUMN parent_id");
    original.db.run("ALTER TABLE pages DROP COLUMN status");
    original.db.run("DROP INDEX revisions_page_id_idx");
    original.db.run("DROP INDEX pages_deleted_at_idx");
    original.db.run("DROP INDEX pages_deleted_alias_idx");
    original.db.run("ALTER TABLE pages DROP COLUMN deleted_alias");
    original.db.run("ALTER TABLE pages DROP COLUMN deleted_at");
    original.db.run("PRAGMA user_version = 1");
    original.close();

    const migrated = new PageStore(dbPath);
    stores.push(migrated);
    expect(migrated.search("legacy").pages.map(({ alias }) => alias)).toEqual(["before-migration"]);
    expect((await readdir(dirname(dbPath))).some((name) => name.includes("pre-migration-1"))).toBe(true);
  });

  test("rejects alias collisions", async () => {
    const db = await store();
    db.create({ title: "One", alias: "same", body: "", tags: [] }, "web");
    expect(() => db.create({ title: "Two", alias: "same", body: "", tags: [] }, "web")).toThrow("already exists");
  });
});
