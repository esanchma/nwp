import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vecEmbeddedPath from "sqlite-vec-linux-x64/vec0.so" with { type: "file" };
import type { SemanticSearchConfig } from "./config.ts";
import type { PageStore, SemanticIndexConfig } from "./database.ts";
import { AppError, normalizeProperties, normalizeTags, type Page, type PageProperties, type PageStatus, type SearchResults } from "./domain.ts";

interface OllamaEmbedResponse { embeddings: number[][] }

export function semanticIndexConfig(config: SemanticSearchConfig): SemanticIndexConfig {
  return {
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    queryPrefix: config.queryPrefix,
    chunkCharacters: config.chunkCharacters,
    chunkOverlap: config.chunkOverlap,
  };
}

export function loadEmbeddedSqliteVec(store: PageStore, dataDir: string): { available: boolean; path?: string; error?: string } {
  try {
    const bytes = readFileSync(vecEmbeddedPath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const directory = join(dataDir, "extensions");
    const path = join(directory, `vec0-${hash.slice(0, 16)}.so`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { mode: 0o700, flag: "wx" });
        chmodSync(temporary, 0o700);
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    store.db.loadExtension(path, "sqlite3_vec_init");
    store.setVectorAvailable(true);
    return { available: true, path };
  } catch (error) {
    store.setVectorAvailable(false);
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export class OllamaEmbedder {
  constructor(private readonly config: SemanticSearchConfig) {}

  async embedDocuments(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.embed(input, signal);
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array> {
    const embeddings = await this.embed([`${this.config.queryPrefix}${query}`], signal);
    return embeddings[0]!;
  }

  private async embed(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const response = await fetch(new URL("/api/embed", this.config.ollamaUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.embeddingModel, input, keep_alive: "30m", truncate: false }),
      signal,
    });
    if (!response.ok) throw new Error(`Ollama embeddings failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json() as OllamaEmbedResponse;
    if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== input.length) throw new Error("Ollama returned an invalid embedding count");
    return payload.embeddings.map((values) => {
      if (!Array.isArray(values) || values.length !== this.config.embeddingDimensions || values.some((value) => !Number.isFinite(value))) {
        throw new Error(`Ollama returned an invalid embedding; expected ${this.config.embeddingDimensions} dimensions`);
      }
      return Float32Array.from(values);
    });
  }
}

export class SemanticIndexer {
  readonly owner = `semantic-${process.pid}-${randomUUID()}`;
  private readonly embedder: OllamaEmbedder;
  private readonly indexConfig: SemanticIndexConfig;

  constructor(private readonly store: PageStore, private readonly config: SemanticSearchConfig) {
    this.embedder = new OllamaEmbedder(config);
    this.indexConfig = semanticIndexConfig(config);
    store.configureSemantic(this.indexConfig);
  }

  async runOne(signal?: AbortSignal): Promise<boolean> {
    const task = this.store.claimSemanticTask(this.owner);
    if (!task) return false;
    try {
      if (!task.page) {
        this.store.removeSemanticPage(task.pageId, task.revision);
        return true;
      }
      const chunks = chunkPage(task.page, this.config.chunkCharacters, this.config.chunkOverlap);
      const embeddings: Float32Array[] = [];
      for (let offset = 0; offset < chunks.length; offset += 16) {
        if (!this.store.renewSemanticLease(task.pageId, task.revision, this.owner)) throw new Error("semantic indexing task was superseded");
        embeddings.push(...await this.embedder.embedDocuments(chunks.slice(offset, offset + 16), signal));
      }
      this.store.completeSemanticTask(task.pageId, task.revision, pageContentHash(task.page), chunks, embeddings, this.indexConfig);
    } catch (error) {
      this.store.failSemanticTask(task.pageId, task.revision, error instanceof Error ? error.message : String(error));
      if (signal?.aborted) throw error;
    }
    return true;
  }

  async runUntilIdle(signal?: AbortSignal): Promise<number> {
    let processed = 0;
    while (!signal?.aborted && await this.runOne(signal)) processed += 1;
    return processed;
  }

  async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.runOne(signal);
      if (!processed) await Bun.sleep(1000);
    }
  }
}

export async function hybridSearch(
  store: PageStore,
  embedder: OllamaEmbedder,
  query: string,
  tags: string[],
  cursor: string | null,
  limit: number,
  status: PageStatus | "all",
  properties: PageProperties,
  signal?: AbortSignal,
): Promise<SearchResults> {
  const normalizedTags = store.resolveTags(normalizeTags(tags));
  const normalizedProperties = normalizeProperties(properties);
  const fingerprint = createHash("sha256").update(JSON.stringify({ query, tags: normalizedTags, status, properties: normalizedProperties })).digest("hex").slice(0, 16);
  const offset = decodeHybridCursor(cursor, fingerprint);
  const lexical = store.search(query, normalizedTags, null, 100, status, normalizedProperties);
  if (!query.trim()) return { ...lexical, mode: "lexical" };
  const queryEmbedding = await embedder.embedQuery(query, signal);
  const semantic = store.semanticNeighbors(queryEmbedding, 100, status);
  const scores = new Map<number, number>();
  const excerpts = new Map<number, string>();
  const summaries = new Map(lexical.pages.map((page) => [page.id, page]));
  lexical.pages.forEach((page, index) => {
    scores.set(page.id, (scores.get(page.id) ?? 0) + 1 / (60 + index + 1));
    excerpts.set(page.id, page.excerpt);
  });
  semantic.forEach((neighbor, index) => {
    let page: Page;
    try { page = store.getById(neighbor.pageId); }
    catch { return; }
    if (!normalizedTags.every((tag) => page.tags.includes(tag))) return;
    if (!Object.entries(normalizedProperties).every(([key, value]) => JSON.stringify(page.properties[key]) === JSON.stringify(value))) return;
    scores.set(page.id, (scores.get(page.id) ?? 0) + 1 / (60 + index + 1));
    summaries.set(page.id, { id: page.id, title: page.title, alias: page.alias, tags: page.tags, status: page.status, parentId: page.parentId, createdAt: page.createdAt, updatedAt: page.updatedAt, excerpt: neighbor.content.slice(0, 240) });
    if (!excerpts.has(page.id)) excerpts.set(page.id, neighbor.content.slice(0, 240));
  });
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0]).map(([id]) => ({ ...summaries.get(id)!, excerpt: excerpts.get(id) ?? "" }));
  const pageLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const pages = ranked.slice(offset, offset + pageLimit);
  const nextOffset = offset + pages.length;
  return { pages, nextCursor: nextOffset < ranked.length ? encodeHybridCursor(nextOffset, fingerprint) : null, mode: "hybrid" };
}

function encodeHybridCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ h: fingerprint, o: offset })).toString("base64url");
}

function decodeHybridCursor(cursor: string | null, fingerprint: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { h?: unknown; o?: unknown };
    if (parsed.h !== fingerprint || typeof parsed.o !== "number" || !Number.isInteger(parsed.o) || parsed.o < 0) throw new Error();
    return parsed.o;
  } catch { throw new AppError("invalid_cursor", "search cursor is invalid for this query", 400); }
}

export function chunkPage(page: Page, maximum: number, overlap: number): string[] {
  const metadata = [page.title, page.alias, page.tags.join(" "), Object.entries(page.properties).map(([key, value]) => `${key}: ${String(value)}`).join("\n")].filter(Boolean).join("\n");
  const source = `${metadata}\n\n${page.body}`.trim();
  if (!source) return [page.title];
  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + maximum);
    if (end < source.length) {
      const boundary = source.lastIndexOf("\n\n", end);
      if (boundary > start + Math.floor(maximum * 0.6)) end = boundary;
    }
    const chunk = source.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= source.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return [...new Set(chunks)];
}

export function pageContentHash(page: Page): string {
  return createHash("sha256").update(JSON.stringify({ title: page.title, alias: page.alias, body: page.body, tags: page.tags, properties: page.properties })).digest("hex");
}
