import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import tar from "tar-stream";
import { PageStore } from "../src/database.ts";
import { createFullExport, exportPageMarkdown, importPageMarkdown } from "../src/transfer.ts";

let store: PageStore | null = null;
let dir = "";

async function setup(): Promise<PageStore> {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "transfer-test-"));
  store = new PageStore(join(dir, "nwp.db"));
  return store;
}

afterEach(async () => {
  store?.close();
  store = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Markdown transfer", () => {
  test("exports generated front matter and imports with a new alias", async () => {
    const db = await setup();
    const parent = db.create({ title: "Parent", body: "", tags: [] }, "web");
    const page = db.create({
      title: "Portable",
      alias: "portable",
      body: "Body with [[parent]].\n",
      tags: ["export"],
      status: "draft",
      parentId: parent.id,
      properties: { owner: "team", priority: 3, ready: true, note: null },
    }, "web");

    const markdown = exportPageMarkdown(page);
    expect(markdown).toContain("nwp: 1");
    expect(markdown).toContain("parent: parent");
    expect(markdown).toContain("Body with [[parent]].");

    const imported = importPageMarkdown(db, markdown, "cli");
    expect(imported.alias).toBe("portable-2");
    expect(imported).toMatchObject({ status: "draft", parentId: parent.id, properties: page.properties, body: page.body });
  });

  test("rejects missing or non-scalar front matter", async () => {
    const db = await setup();
    expect(() => importPageMarkdown(db, "# no front matter", "web")).toThrow("front matter");
    expect(() => importPageMarkdown(db, "---\ntitle: Bad\nproperties:\n  nested:\n    no: true\n---\nbody", "web")).toThrow("scalar");
  });
});

describe("complete export", () => {
  test("contains manifest, pages, revisions, trash, and deduplicated blobs", async () => {
    const db = await setup();
    const active = db.create({ title: "Active", body: "one", tags: [] }, "web");
    db.update(active.id, { body: "two" }, "web");
    const deleted = db.create({ title: "Deleted", body: "gone", tags: [] }, "web");
    db.deletePage(deleted.id);
    const attachment = db.addAttachment(active.id, "file.txt", "text/plain", new TextEncoder().encode("content"), null);

    const archive = createFullExport(db);
    const compressed = Buffer.from(await new Response(archive.stream).arrayBuffer());
    const entries = await untar(gunzipSync(compressed));
    expect(entries.has("manifest.json")).toBe(true);
    expect(entries.has(`pages/${active.id}.md`)).toBe(true);
    expect(entries.has(`trash/${deleted.id}.md`)).toBe(true);
    expect([...entries.keys()].some((name) => name.startsWith(`history/${active.id}/`))).toBe(true);
    expect(entries.get(`attachments/${attachment.sha256}`)?.toString()).toBe("content");
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as { format: string; attachments: unknown[] };
    expect(manifest.format).toBe("nwp-export");
    expect(manifest.attachments).toHaveLength(1);
  });
});

function untar(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
      stream.on("end", () => { entries.set(header.name, Buffer.concat(chunks)); next(); });
      stream.on("error", reject);
    });
    extract.on("finish", () => resolve(entries));
    extract.on("error", reject);
    Readable.from(buffer).pipe(extract);
  });
}
