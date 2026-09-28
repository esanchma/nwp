import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vecEmbeddedPath from "sqlite-vec-linux-x64/vec0.so" with { type: "file" };
import type { SemanticSearchConfig } from "./config.ts";
import type { DocumentChunkInput, PageStore, SemanticIndexConfig } from "./database.ts";
import { AppError, normalizeProperties, normalizeTags, type DocumentRecord, type DocumentSearchFilters, type DocumentSection, type Page, type PageProperties, type PageStatus, type SearchHit, type SearchResults } from "./domain.ts";

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
    if (task) {
      try {
        if (!task.page) {
          this.store.removeSemanticPage(task.pageId, task.revision);
          return true;
        }
        const chunks = chunkPage(task.page, this.config.chunkCharacters, this.config.chunkOverlap);
        const embeddings = await this.embedBatches(chunks, () => this.store.renewSemanticLease(task.pageId, task.revision, this.owner), signal);
        this.store.completeSemanticTask(task.pageId, task.revision, pageContentHash(task.page), chunks, embeddings, this.indexConfig);
      } catch (error) {
        this.store.failSemanticTask(task.pageId, task.revision, error instanceof Error ? error.message : String(error));
        if (signal?.aborted) throw error;
      }
      return true;
    }

    const documentTask = this.store.claimDocumentSemanticTask(this.owner);
    if (!documentTask) return false;
    try {
      if (!documentTask.document) {
        this.store.removeSemanticDocument(documentTask);
        return true;
      }
      const chunks = chunkDocumentSections(documentTask.document, documentTask.sections, this.config.chunkCharacters, this.config.chunkOverlap);
      const embeddings = await this.embedBatches(chunks.map(({ content }) => content), () => this.store.renewDocumentSemanticLease(documentTask.documentId, documentTask.revision, this.owner), signal);
      this.store.completeDocumentSemanticTask(documentTask, documentContentHash(documentTask.document, documentTask.sections), chunks, embeddings, this.indexConfig);
    } catch (error) {
      this.store.failDocumentSemanticTask(documentTask, error instanceof Error ? error.message : String(error));
      if (signal?.aborted) throw error;
    }
    return true;
  }

  private async embedBatches(chunks: string[], renew: () => boolean, signal?: AbortSignal): Promise<Float32Array[]> {
    const embeddings: Float32Array[] = [];
    for (let offset = 0; offset < chunks.length; offset += 16) {
      if (!renew()) throw new Error("semantic indexing task was superseded");
      embeddings.push(...await this.embedder.embedDocuments(chunks.slice(offset, offset + 16), signal));
    }
    return embeddings;
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

export function lexicalSearch(
  store: PageStore,
  query: string,
  tags: string[],
  cursor: string | null,
  limit: number,
  status: PageStatus | "all",
  properties: PageProperties,
  filters: DocumentSearchFilters = { source: "all" },
): SearchResults {
  const normalizedTags = store.resolveTags(normalizeTags(tags));
  const normalizedProperties = normalizeProperties(properties);
  const { scores, hits } = lexicalCandidates(store, query, normalizedTags, status, normalizedProperties, filters);
  return paginateHits(scores, hits, cursor, limit, searchFingerprint("lexical", query, normalizedTags, status, normalizedProperties, filters), "lexical");
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
  filters: DocumentSearchFilters = { source: "all" },
): Promise<SearchResults> {
  const normalizedTags = store.resolveTags(normalizeTags(tags));
  const normalizedProperties = normalizeProperties(properties);
  if (!query.trim()) return lexicalSearch(store, query, normalizedTags, cursor, limit, status, normalizedProperties, filters);
  const { scores, hits } = lexicalCandidates(store, query, normalizedTags, status, normalizedProperties, filters);
  const queryEmbedding = await embedder.embedQuery(query, signal);

  if (pageSearchEligible(filters)) {
    store.semanticNeighbors(queryEmbedding, 100, status).forEach((neighbor, index) => {
      let page: Page;
      try { page = store.getById(neighbor.pageId); } catch { return; }
      if (!normalizedTags.every((tag) => page.tags.includes(tag))) return;
      if (!Object.entries(normalizedProperties).every(([key, value]) => JSON.stringify(page.properties[key]) === JSON.stringify(value))) return;
      const key = `p:${page.id}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + index + 1));
      if (!hits.has(key)) hits.set(key, { source: "page", page: { id: page.id, title: page.title, alias: page.alias, tags: page.tags, status: page.status, parentId: page.parentId, createdAt: page.createdAt, updatedAt: page.updatedAt, excerpt: neighbor.content.slice(0, 240) } });
    });
  }

  if (filters.source !== "pages") {
    const seenSections = new Set<number>();
    store.semanticDocumentNeighbors(queryEmbedding, filters, normalizedTags, status, normalizedProperties, 100).forEach((neighbor, index) => {
      if (seenSections.has(neighbor.sectionId)) return;
      seenSections.add(neighbor.sectionId);
      const key = `d:${neighbor.sectionId}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + index + 1));
      if (!hits.has(key)) {
        const { chunkId: _chunkId, content: _content, distance: _distance, ...document } = neighbor;
        hits.set(key, { source: "document", document: { ...document, excerpt: document.excerpt.slice(0, 500) } });
      }
    });
  }

  suppressLinkedPageDuplicates(scores, hits);
  return paginateHits(scores, hits, cursor, limit, searchFingerprint("hybrid", query, normalizedTags, status, normalizedProperties, filters), "hybrid");
}

function lexicalCandidates(store: PageStore, query: string, tags: string[], status: PageStatus | "all", properties: PageProperties, filters: DocumentSearchFilters): { scores: Map<string, number>; hits: Map<string, SearchHit> } {
  const scores = new Map<string, number>();
  const hits = new Map<string, SearchHit>();
  const pageCriteria = Boolean(query.trim() || tags.length || Object.keys(properties).length);
  const documentCriteria = Boolean(query.trim() || tags.length || Object.keys(properties).length || filters.source === "documents" || documentFiltersActive(filters));
  if (pageSearchEligible(filters) && pageCriteria) {
    const pages = store.search(query, tags, null, 100, status, properties).pages;
    pages.forEach((page, index) => { const key = `p:${page.id}`; scores.set(key, 1 / (60 + index + 1)); hits.set(key, { source: "page", page }); });
  }
  if (filters.source !== "pages" && documentCriteria) {
    const documents = store.searchDocumentSections(query, filters, tags, status, properties, 100);
    documents.forEach((document, index) => { const key = `d:${document.sectionId}`; scores.set(key, 1 / (60 + index + 1)); hits.set(key, { source: "document", document }); });
  }
  if (!pageCriteria && !documentCriteria) throw new AppError("empty_search", "search text or a compatible filter is required", 400);
  suppressLinkedPageDuplicates(scores, hits);
  return { scores, hits };
}

function pageSearchEligible(filters: DocumentSearchFilters): boolean {
  return filters.source !== "documents" && !documentFiltersActive(filters);
}

function documentFiltersActive(filters: DocumentSearchFilters): boolean {
  return filters.documentId !== undefined || Boolean(filters.documentIds?.length) || filters.format !== undefined || filters.version !== undefined || filters.ocrStatus !== undefined || filters.hidden !== undefined || filters.kind !== undefined || filters.updatedAfter !== undefined || filters.updatedBefore !== undefined;
}

function suppressLinkedPageDuplicates(scores: Map<string, number>, hits: Map<string, SearchHit>): void {
  const documentPages = new Set([...hits.values()].flatMap((hit) => hit.source === "document" ? [hit.document.pageId] : []));
  for (const pageId of documentPages) { scores.delete(`p:${pageId}`); hits.delete(`p:${pageId}`); }
}

function paginateHits(scores: Map<string, number>, hits: Map<string, SearchHit>, cursor: string | null, limit: number, fingerprint: string, mode: "lexical" | "hybrid"): SearchResults {
  const offset = decodeHybridCursor(cursor, fingerprint);
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([key]) => hits.get(key)!).filter(Boolean);
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const selected = ranked.slice(offset, offset + bounded);
  const nextOffset = offset + selected.length;
  return { pages: selected.flatMap((hit) => hit.source === "page" ? [hit.page] : []), hits: selected, nextCursor: nextOffset < ranked.length ? encodeHybridCursor(nextOffset, fingerprint) : null, mode };
}

function searchFingerprint(mode: string, query: string, tags: string[], status: PageStatus | "all", properties: PageProperties, filters: DocumentSearchFilters): string {
  return createHash("sha256").update(JSON.stringify({ mode, query, tags, status, properties, filters })).digest("hex").slice(0, 16);
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
  return chunkText(`${metadata}\n\n${page.body}`.trim() || page.title, maximum, overlap);
}

export function chunkDocumentSections(document: DocumentRecord, sections: DocumentSection[], maximum: number, overlap: number): DocumentChunkInput[] {
  return sections.flatMap((item) => {
    const prefix = [document.filename, document.format.toUpperCase(), item.kind, item.locator.label, item.hidden ? "hidden" : ""].filter(Boolean).join("\n");
    return chunkText(`${prefix}\n\n${item.text}`.trim(), maximum, overlap).map((content, ordinal) => ({ sectionId: item.id, ordinal, content }));
  });
}

function chunkText(source: string, maximum: number, overlap: number): string[] {
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

export function documentContentHash(document: DocumentRecord, sections: DocumentSection[]): string {
  return createHash("sha256").update(JSON.stringify({ versionId: document.currentVersion.id, sha256: document.currentVersion.sha256, sections: sections.map(({ id, kind, locator, text, hidden }) => ({ id, kind, locator, text, hidden })) })).digest("hex");
}
