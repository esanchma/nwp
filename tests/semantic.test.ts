import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SemanticSearchConfig } from "../src/config.ts";
import { PageStore } from "../src/database.ts";
import { chunkPage, hybridSearch, loadEmbeddedSqliteVec, OllamaEmbedder, SemanticIndexer } from "../src/semantic.ts";

let dir = "";
let store: PageStore | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

async function setup() {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "semantic-test-"));
  store = new PageStore(join(dir, "nwp.db"));
  expect(loadEmbeddedSqliteVec(store, dir).available).toBe(true);
  server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { input: string[] };
    return Response.json({ embeddings: body.input.map(vectorFor) });
  } });
  const config: SemanticSearchConfig = { enabled: true, ollamaUrl: server.url.toString(), embeddingModel: "test-embedding", embeddingDimensions: 3, queryPrefix: "", chunkCharacters: 300, chunkOverlap: 30 };
  return { db: store, config };
}

afterEach(async () => {
  server?.stop(true);
  server = null;
  store?.close();
  store = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("semantic indexing", () => {
  test("indexes queued pages and performs hybrid retrieval", async () => {
    const { db, config } = await setup();
    const fruit = db.create({ title: "Orchard notes", body: "Apples and pears grow on fruit trees.", tags: ["fruit"] }, "web");
    db.create({ title: "Database notes", body: "SQLite stores relational data in tables.", tags: ["database"] }, "web");
    const indexer = new SemanticIndexer(db, config);
    expect(await indexer.runUntilIdle()).toBe(2);
    expect(db.semanticStatus(true, config.embeddingModel, 3)).toMatchObject({ vectorAvailable: true, pendingPages: 0, indexedPages: 2 });

    const results = await hybridSearch(db, new OllamaEmbedder(config), "fresh apple harvest", [], null, 10, "published", {});
    expect(results.mode).toBe("hybrid");
    expect(results.pages[0]?.id).toBe(fruit.id);

    db.update(fruit.id, { body: "Apples are harvested from an updated orchard." }, "web");
    expect(db.semanticStatus(true, config.embeddingModel, 3).pendingPages).toBe(1);
    expect(await indexer.runUntilIdle()).toBe(1);
  });

  test("canonicalizes tag aliases and preserves a reusable taxonomy", async () => {
    const { db } = await setup();
    const page = db.create({ title: "AI", body: "", tags: ["IA"] }, "web");
    db.defineTag("topic:artificial-intelligence", "topic", "Artificial intelligence", ["ia", "inteligencia-artificial"]);
    expect(db.getById(page.id).tags).toEqual(["topic:artificial-intelligence"]);
    expect(db.listTagDefinitions().find(({ tag }) => tag === "topic:artificial-intelligence")).toMatchObject({ aliases: ["ia", "inteligencia-artificial"], usageCount: 1 });
  });

  test("chunks long pages deterministically with bounded overlap", async () => {
    const { db } = await setup();
    const page = db.create({ title: "Long", body: `${"first ".repeat(80)}\n\n${"second ".repeat(80)}`, tags: [] }, "web");
    const chunks = chunkPage(page, 300, 30);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
    expect(chunkPage(page, 300, 30)).toEqual(chunks);
  });
});

function vectorFor(text: string): number[] {
  const value = text.toLowerCase();
  if (value.includes("apple") || value.includes("orchard") || value.includes("fruit")) return [1, 0, 0];
  if (value.includes("sqlite") || value.includes("database") || value.includes("relational")) return [0, 1, 0];
  return [0, 0, 1];
}
