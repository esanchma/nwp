import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentRagConfig, SemanticSearchConfig } from "../src/config.ts";
import { PageStore } from "../src/database.ts";
import { DocumentWorker } from "../src/documents.ts";
import { chunkPage, hybridSearch, lexicalSearch, loadEmbeddedSqliteVec, OllamaEmbedder, SemanticIndexer } from "../src/semantic.ts";

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

const documentConfig: DocumentRagConfig = { enabled: true, maxFileBytes: 10_000_000, maxExpandedBytes: 50_000_000, maxArchiveEntries: 10_000, maxCompressionRatio: 1000, maxPdfPages: 10_000, maxSpreadsheetCells: 5_000_000, ocrEnabled: false, tesseractCommand: "tesseract", pdfRendererCommand: "pdftoppm", ocrLanguages: ["spa", "eng"], ocrTimeoutSeconds: 120, maxOcrItems: 10_000, maxOcrOutputCharacters: 1_000_000 };

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

  test("indexes document sections and returns citation-ready unified results", async () => {
    const { db, config } = await setup();
    const bytes = new TextEncoder().encode("Remote work policy requires manager approval for employee location changes.");
    const document = db.createDocument("work-policy.txt", "text/plain", "text", bytes, "web", documentConfig.maxFileBytes);
    await new DocumentWorker(db, documentConfig).runUntilIdle();
    db.update(document.pageId, { tags: ["policy"], properties: { owner: "people" } }, "web");
    const indexer = new SemanticIndexer(db, config);
    expect(await indexer.runUntilIdle()).toBe(2);
    expect(db.semanticStatus(true, config.embeddingModel, 3)).toMatchObject({ pendingDocuments: 0, indexedDocuments: 1 });

    const lexical = lexicalSearch(db, "manager approval", [], null, 10, "published", {}, { source: "all", format: "text", hidden: false });
    expect(lexical.hits).toHaveLength(1);
    expect(lexical.hits![0]).toMatchObject({ source: "document", document: { documentId: document.id, filename: "work-policy.txt", locator: { label: "Part 1" } } });
    expect(lexical.pages).toHaveLength(0);
    expect(lexicalSearch(db, "manager", ["policy"], null, 10, "published", { owner: "people" }, { source: "documents" }).hits).toHaveLength(1);
    expect(lexicalSearch(db, "manager", [], null, 10, "published", {}, { source: "documents", updatedAfter: "2999-01-01T00:00:00.000Z" }).hits).toEqual([]);

    const hybrid = await hybridSearch(db, new OllamaEmbedder(config), "employee location rules", [], null, 10, "published", {}, undefined, { source: "all" });
    expect(hybrid.hits?.some((hit) => hit.source === "document" && hit.document.documentId === document.id)).toBe(true);
    expect(lexicalSearch(db, "manager approval", [], null, 10, "published", {}, { source: "documents", format: "pdf" }).hits).toEqual([]);

    db.replaceDocument(document.id, "work-policy-v2.txt", "text/plain", "text", new TextEncoder().encode("Office attendance now requires two days each week."), documentConfig.maxFileBytes);
    expect(lexicalSearch(db, "manager approval", [], null, 10, "published", {}, { source: "documents" }).hits).toEqual([]);
    await new DocumentWorker(db, documentConfig).runUntilIdle();
    expect(await indexer.runUntilIdle()).toBe(1);
    expect(lexicalSearch(db, "office attendance", [], null, 10, "published", {}, { source: "documents" }).hits?.[0]).toMatchObject({ source: "document", document: { documentId: document.id, version: 2 } });
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
