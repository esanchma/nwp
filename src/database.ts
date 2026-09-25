import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AppError,
  decodeCursor,
  decodeSearchCursor,
  encodeCursor,
  encodeSearchCursor,
  extractWikiLinks,
  normalizeProperties,
  normalizeTags,
  pageInputSchema,
  pageUpdateSchema,
  slugify,
  validateAlias,
  type Attachment,
  type ChangeSource,
  type DeletedPage,
  type DocumentFormat,
  type DocumentRecord,
  type DocumentSection,
  type DocumentStatus,
  type DocumentVersion,
  type DocumentVersionStatus,
  type Page,
  type PageInput,
  type PageList,
  type PageProperties,
  type PageStatus,
  type PageReference,
  type PageSummary,
  type PageUpdate,
  type Revision,
  type RevisionList,
  type RevisionSummary,
  type SearchResults,
  type SemanticStatus,
  type TagDefinition,
  type TagKind,
  type TrashList,
  type TreeEntry,
} from "./domain.ts";
import type { ExtractedDocument } from "./documents.ts";

interface PageRow {
  id: number;
  title: string;
  alias: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_alias: string | null;
  status: PageStatus;
  parent_id: number | null;
  properties_json: string;
}

interface SearchRow extends PageRow {
  rank: number;
}

interface AttachmentRow {
  id: number;
  page_id: number;
  filename: string;
  mime_type: string;
  size: number;
  sha256: string;
  inline_safe: number;
  created_at: string;
}

interface DocumentRow {
  id: number;
  page_id: number;
  filename: string;
  mime_type: string;
  format: DocumentFormat;
  status: DocumentStatus;
  needs_ocr: number;
  needs_review: number;
  last_error: string | null;
  managed_title: string;
  managed_body: string;
  managed_tags_json: string;
  managed_properties_json: string;
  created_at: string;
  updated_at: string;
}

interface DocumentVersionRow {
  id: number;
  document_id: number;
  version: number;
  blob_sha256: string;
  size: number;
  status: DocumentVersionStatus;
  parser_version: string | null;
  metadata_json: string;
  warnings_json: string;
  created_at: string;
  extracted_at: string | null;
}

interface RevisionRow {
  id: number;
  page_id: number;
  title: string;
  alias: string;
  body: string;
  tags_json: string;
  source: ChangeSource;
  created_at: string;
  status: PageStatus;
  parent_id: number | null;
  properties_json: string;
}

const migrations = [
  `
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      alias TEXT NOT NULL COLLATE NOCASE UNIQUE,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      alias TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('web', 'cli', 'rest', 'mcp')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE page_tags (
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      tag TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (page_id, tag)
    );
    CREATE INDEX page_tags_tag_idx ON page_tags(tag COLLATE NOCASE);
    CREATE TABLE page_links (
      source_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      target_alias TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (source_page_id, target_alias)
    );
    CREATE INDEX page_links_target_idx ON page_links(target_alias COLLATE NOCASE);
  `,
  `
    CREATE VIRTUAL TABLE page_search USING fts5(
      page_id UNINDEXED,
      title,
      alias,
      body,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    INSERT INTO page_search (page_id, title, alias, body, tags)
    SELECT p.id, p.title, p.alias, p.body,
      COALESCE((SELECT group_concat(pt.tag, ' ') FROM page_tags pt WHERE pt.page_id = p.id), '')
    FROM pages p;
  `,
  `
    CREATE INDEX IF NOT EXISTS revisions_page_id_idx ON revisions(page_id, id DESC);
  `,
  `
    ALTER TABLE pages ADD COLUMN deleted_at TEXT;
    ALTER TABLE pages ADD COLUMN deleted_alias TEXT COLLATE NOCASE;
    CREATE INDEX pages_deleted_at_idx ON pages(deleted_at, id DESC);
    CREATE INDEX pages_deleted_alias_idx ON pages(deleted_alias COLLATE NOCASE) WHERE deleted_at IS NOT NULL;
  `,
  `
    CREATE TABLE attachment_blobs (
      sha256 TEXT PRIMARY KEY,
      size INTEGER NOT NULL CHECK (size >= 0),
      mime_type TEXT NOT NULL,
      inline_safe INTEGER NOT NULL CHECK (inline_safe IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE page_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      blob_sha256 TEXT NOT NULL REFERENCES attachment_blobs(sha256),
      filename TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      UNIQUE (page_id, filename)
    );
    CREATE INDEX page_attachments_page_idx ON page_attachments(page_id, id);
  `,
  `
    ALTER TABLE pages ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived'));
    ALTER TABLE pages ADD COLUMN parent_id INTEGER REFERENCES pages(id) ON DELETE SET NULL;
    ALTER TABLE pages ADD COLUMN properties_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE revisions ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
    ALTER TABLE revisions ADD COLUMN parent_id INTEGER;
    ALTER TABLE revisions ADD COLUMN properties_json TEXT NOT NULL DEFAULT '{}';
    CREATE INDEX pages_status_idx ON pages(status, updated_at DESC);
    CREATE INDEX pages_parent_idx ON pages(parent_id, title COLLATE NOCASE);
    CREATE TABLE page_properties (
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      key TEXT NOT NULL COLLATE NOCASE,
      value_json TEXT NOT NULL,
      value_text TEXT NOT NULL,
      PRIMARY KEY (page_id, key)
    );
    CREATE INDEX page_properties_filter_idx ON page_properties(key COLLATE NOCASE, value_json);
    DROP TABLE page_search;
    CREATE VIRTUAL TABLE page_search USING fts5(
      page_id UNINDEXED,
      title,
      alias,
      body,
      tags,
      properties,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    INSERT INTO page_search (page_id, title, alias, body, tags, properties)
    SELECT p.id, p.title, p.alias, p.body,
      COALESCE((SELECT group_concat(pt.tag, ' ') FROM page_tags pt WHERE pt.page_id = p.id), ''),
      ''
    FROM pages p WHERE p.deleted_at IS NULL;
  `,
  `
    CREATE TABLE tag_definitions (
      tag TEXT PRIMARY KEY COLLATE NOCASE,
      kind TEXT NOT NULL CHECK (kind IN ('topic', 'entity', 'source', 'type', 'custom')),
      display_name TEXT NOT NULL,
      description TEXT,
      created_by TEXT NOT NULL CHECK (created_by IN ('human', 'model', 'migration')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE tag_aliases (
      alias TEXT PRIMARY KEY COLLATE NOCASE,
      canonical_tag TEXT NOT NULL REFERENCES tag_definitions(tag) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO tag_definitions(tag, kind, display_name, created_by, created_at)
    SELECT DISTINCT tag,
      CASE
        WHEN tag LIKE 'entity:%' THEN 'entity'
        WHEN tag LIKE 'source:%' THEN 'source'
        WHEN tag LIKE 'type:%' THEN 'type'
        WHEN tag LIKE 'topic:%' THEN 'topic'
        ELSE 'custom'
      END,
      tag, 'migration', datetime('now')
    FROM page_tags;
    CREATE TRIGGER page_tags_define AFTER INSERT ON page_tags BEGIN
      INSERT OR IGNORE INTO tag_definitions(tag, kind, display_name, created_by, created_at)
      VALUES (
        NEW.tag,
        CASE
          WHEN NEW.tag LIKE 'entity:%' THEN 'entity'
          WHEN NEW.tag LIKE 'source:%' THEN 'source'
          WHEN NEW.tag LIKE 'type:%' THEN 'type'
          WHEN NEW.tag LIKE 'topic:%' THEN 'topic'
          ELSE 'custom'
        END,
        NEW.tag, 'human', datetime('now')
      );
    END;

    CREATE TABLE semantic_index_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      query_prefix TEXT NOT NULL,
      chunk_characters INTEGER NOT NULL,
      chunk_overlap INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE semantic_page_index (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE page_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE(page_id, ordinal)
    );
    CREATE INDEX page_chunks_page_idx ON page_chunks(page_id, ordinal);
    CREATE TABLE chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES page_chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX chunk_embeddings_model_idx ON chunk_embeddings(model, dimensions);
    CREATE TABLE semantic_index_queue (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT
    );
    INSERT INTO semantic_index_queue(page_id, requested_at, available_at)
      SELECT id, datetime('now'), datetime('now') FROM pages WHERE deleted_at IS NULL;
    CREATE TRIGGER pages_semantic_insert AFTER INSERT ON pages BEGIN
      INSERT INTO semantic_index_queue(page_id, requested_at, available_at, attempts, revision)
      VALUES (NEW.id, datetime('now'), datetime('now'), 0, 1)
      ON CONFLICT(page_id) DO UPDATE SET requested_at = excluded.requested_at, available_at = excluded.available_at, attempts = 0, revision = semantic_index_queue.revision + 1, lease_owner = NULL, lease_until = NULL, last_error = NULL;
    END;
    CREATE TRIGGER pages_semantic_update AFTER UPDATE OF title, alias, body, status, properties_json, deleted_at ON pages BEGIN
      INSERT INTO semantic_index_queue(page_id, requested_at, available_at, attempts, revision)
      VALUES (NEW.id, datetime('now'), datetime('now'), 0, 1)
      ON CONFLICT(page_id) DO UPDATE SET requested_at = excluded.requested_at, available_at = excluded.available_at, attempts = 0, revision = semantic_index_queue.revision + 1, lease_owner = NULL, lease_until = NULL, last_error = NULL;
    END;
  `,
  `
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('docx', 'xlsx', 'pptx', 'pdf', 'markdown', 'text')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'extracting', 'ready', 'failed', 'cancelled')),
      needs_ocr INTEGER NOT NULL DEFAULT 0 CHECK (needs_ocr IN (0, 1)),
      needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
      last_error TEXT,
      managed_title TEXT NOT NULL,
      managed_body TEXT NOT NULL,
      managed_tags_json TEXT NOT NULL,
      managed_properties_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX documents_status_idx ON documents(status, updated_at DESC);
    CREATE TABLE document_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      blob_sha256 TEXT NOT NULL REFERENCES attachment_blobs(sha256),
      status TEXT NOT NULL CHECK (status IN ('queued', 'extracting', 'ready', 'failed', 'cancelled', 'superseded')),
      parser_version TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      extracted_at TEXT,
      UNIQUE(document_id, version)
    );
    CREATE INDEX document_versions_document_idx ON document_versions(document_id, version DESC);
    CREATE TABLE document_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_version_id INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('heading', 'paragraph', 'table', 'slide', 'notes', 'sheet', 'page', 'text')),
      title TEXT,
      locator_json TEXT NOT NULL,
      text TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
      needs_ocr INTEGER NOT NULL DEFAULT 0 CHECK (needs_ocr IN (0, 1)),
      UNIQUE(document_version_id, ordinal)
    );
    CREATE INDEX document_sections_version_idx ON document_sections(document_version_id, ordinal);
    CREATE TABLE document_jobs (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      version_id INTEGER NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT
    );
  `,
];

export interface SemanticIndexConfig {
  model: string;
  dimensions: number;
  queryPrefix: string;
  chunkCharacters: number;
  chunkOverlap: number;
}

export interface SemanticIndexTask { pageId: number; revision: number; page: Page | null }
export interface DocumentTask { documentId: number; versionId: number; revision: number; owner: string }
export interface SemanticNeighbor { pageId: number; chunkId: number; content: string; distance: number }

export class PageStore {
  readonly db: Database;
  readonly attachmentDir: string;
  private vectorAvailable = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.attachmentDir = join(dirname(dbPath), "attachments");
    mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.migrate(dbPath);
  }

  close(): void {
    this.db.close(true);
  }

  private migrate(dbPath: string): void {
    const current = Number(this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0);
    if (current > migrations.length) throw new Error(`database schema ${current} is newer than this nwp build`);
    if (current === migrations.length) return;

    if (current > 0 && existsSync(dbPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.db.run("VACUUM INTO ?", [`${dbPath}.pre-migration-${current}-${stamp}.bak`]);
    }

    const migrate = this.db.transaction(() => {
      for (let index = current; index < migrations.length; index += 1) {
        this.db.run(migrations[index]!);
        this.db.run(`PRAGMA user_version = ${index + 1}`);
      }
    });
    migrate.immediate();
  }

  configureSemantic(config: SemanticIndexConfig): void {
    const current = this.db.query<{ model: string; dimensions: number; query_prefix: string; chunk_characters: number; chunk_overlap: number }, []>("SELECT model, dimensions, query_prefix, chunk_characters, chunk_overlap FROM semantic_index_config WHERE id = 1").get();
    const changed = !current || current.model !== config.model || current.dimensions !== config.dimensions || current.query_prefix !== config.queryPrefix || current.chunk_characters !== config.chunkCharacters || current.chunk_overlap !== config.chunkOverlap;
    if (!changed) return;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run("DELETE FROM semantic_page_index");
      this.db.run("DELETE FROM page_chunks");
      this.db.run("DELETE FROM semantic_index_queue");
      this.db.run("INSERT INTO semantic_index_queue(page_id, requested_at, available_at) SELECT id, ?, ? FROM pages WHERE deleted_at IS NULL", [now, now]);
      this.db.run("INSERT OR REPLACE INTO semantic_index_config(id, model, dimensions, query_prefix, chunk_characters, chunk_overlap, last_error, updated_at) VALUES (1, ?, ?, ?, ?, ?, NULL, ?)", [config.model, config.dimensions, config.queryPrefix, config.chunkCharacters, config.chunkOverlap, now]);
    }).immediate();
  }

  setVectorAvailable(value: boolean): void {
    this.vectorAvailable = value;
  }

  claimSemanticTask(owner: string, leaseMilliseconds = 60_000): SemanticIndexTask | null {
    const now = new Date();
    const until = new Date(now.getTime() + leaseMilliseconds).toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db.query<{ page_id: number; revision: number }, [string, string]>("SELECT page_id, revision FROM semantic_index_queue WHERE available_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY requested_at, page_id LIMIT 1").get(now.toISOString(), now.toISOString());
      if (!row) return null;
      this.db.run("UPDATE semantic_index_queue SET lease_owner = ?, lease_until = ? WHERE page_id = ? AND revision = ?", [owner, until, row.page_id, row.revision]);
      return { pageId: row.page_id, revision: row.revision };
    }).immediate();
    if (claim === null) return null;
    try { return { ...claim, page: this.getById(claim.pageId) }; }
    catch (error) {
      if (error instanceof AppError && error.status === 404) return { ...claim, page: null };
      throw error;
    }
  }

  renewSemanticLease(pageId: number, revision: number, owner: string, leaseMilliseconds = 60_000): boolean {
    const result = this.db.run("UPDATE semantic_index_queue SET lease_until = ? WHERE page_id = ? AND revision = ? AND lease_owner = ?", [new Date(Date.now() + leaseMilliseconds).toISOString(), pageId, revision, owner]);
    return result.changes === 1;
  }

  completeSemanticTask(pageId: number, revision: number, contentHash: string, chunks: string[], embeddings: Float32Array[], config: SemanticIndexConfig): void {
    if (chunks.length !== embeddings.length) throw new Error("semantic chunk and embedding counts differ");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const current = this.db.query<{ revision: number }, [number]>("SELECT revision FROM semantic_index_queue WHERE page_id = ?").get(pageId);
      if (!current || current.revision !== revision) return;
      this.db.run("DELETE FROM page_chunks WHERE page_id = ?", [pageId]);
      const insertChunk = this.db.query("INSERT INTO page_chunks(page_id, ordinal, content, content_hash) VALUES (?, ?, ?, ?)");
      const insertEmbedding = this.db.query("INSERT INTO chunk_embeddings(chunk_id, model, dimensions, embedding, indexed_at) VALUES (?, ?, ?, ?, ?)");
      for (let index = 0; index < chunks.length; index += 1) {
        const embedding = embeddings[index]!;
        if (embedding.length !== config.dimensions) throw new Error(`embedding has ${embedding.length} dimensions; expected ${config.dimensions}`);
        const result = insertChunk.run(pageId, index, chunks[index], createHash("sha256").update(chunks[index]!).digest("hex"));
        insertEmbedding.run(Number(result.lastInsertRowid), config.model, config.dimensions, embedding, now);
      }
      this.db.run("INSERT OR REPLACE INTO semantic_page_index(page_id, content_hash, model, dimensions, indexed_at) VALUES (?, ?, ?, ?, ?)", [pageId, contentHash, config.model, config.dimensions, now]);
      this.db.run("DELETE FROM semantic_index_queue WHERE page_id = ? AND revision = ?", [pageId, revision]);
      this.db.run("UPDATE semantic_index_config SET last_error = NULL, updated_at = ? WHERE id = 1", [now]);
    }).immediate();
  }

  removeSemanticPage(pageId: number, revision: number): void {
    this.db.transaction(() => {
      const current = this.db.query<{ revision: number }, [number]>("SELECT revision FROM semantic_index_queue WHERE page_id = ?").get(pageId);
      if (!current || current.revision !== revision) return;
      this.db.run("DELETE FROM page_chunks WHERE page_id = ?", [pageId]);
      this.db.run("DELETE FROM semantic_page_index WHERE page_id = ?", [pageId]);
      this.db.run("DELETE FROM semantic_index_queue WHERE page_id = ? AND revision = ?", [pageId, revision]);
    }).immediate();
  }

  failSemanticTask(pageId: number, revision: number, message: string): void {
    const row = this.db.query<{ attempts: number }, [number, number]>("SELECT attempts FROM semantic_index_queue WHERE page_id = ? AND revision = ?").get(pageId, revision);
    if (!row) return;
    const attempts = row.attempts + 1;
    const available = new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))).toISOString();
    this.db.run("UPDATE semantic_index_queue SET attempts = ?, available_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ? WHERE page_id = ? AND revision = ?", [attempts, available, message.slice(0, 2000), pageId, revision]);
    this.db.run("UPDATE semantic_index_config SET last_error = ?, updated_at = ? WHERE id = 1", [message.slice(0, 2000), new Date().toISOString()]);
  }

  semanticNeighbors(embedding: Float32Array, limit = 50, status: PageStatus | "all" = "published"): SemanticNeighbor[] {
    if (!this.vectorAvailable) throw new AppError("semantic_unavailable", "semantic vector search is unavailable", 503);
    const config = this.db.query<{ model: string; dimensions: number }, []>("SELECT model, dimensions FROM semantic_index_config WHERE id = 1").get();
    if (!config || embedding.length !== config.dimensions) throw new AppError("semantic_unavailable", "semantic index configuration is unavailable", 503);
    const statusClause = status === "all" ? "" : "AND p.status = ?";
    const bindings: Array<string | number | Float32Array> = [embedding, config.model, config.dimensions, ...(status === "all" ? [] : [status]), Math.max(1, Math.min(100, limit))];
    return this.db.query<SemanticNeighbor, Array<string | number | Float32Array>>(`
      SELECT pc.page_id AS pageId, pc.id AS chunkId, pc.content,
        vec_distance_cosine(ce.embedding, ?) AS distance
      FROM chunk_embeddings ce
      JOIN page_chunks pc ON pc.id = ce.chunk_id
      JOIN pages p ON p.id = pc.page_id
      WHERE ce.model = ? AND ce.dimensions = ? AND p.deleted_at IS NULL ${statusClause}
      ORDER BY distance LIMIT ?
    `).all(...bindings);
  }

  semanticStatus(enabled: boolean, model: string, dimensions: number): SemanticStatus {
    const pendingPages = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM semantic_index_queue").get()!.count;
    const indexedPages = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM semantic_page_index").get()!.count;
    const row = this.db.query<{ last_error: string | null }, []>("SELECT last_error FROM semantic_index_config WHERE id = 1").get();
    return { enabled, vectorAvailable: this.vectorAvailable, model, dimensions, pendingPages, indexedPages, lastError: row?.last_error ?? null };
  }

  resolveTags(values: string[]): string[] {
    return this.canonicalizeTags(values);
  }

  listTagDefinitions(): TagDefinition[] {
    return this.db.query<{ tag: string; kind: TagKind; display_name: string; description: string | null; created_by: "human" | "model" | "migration"; created_at: string; usage_count: number }, []>(`
      SELECT td.*, (SELECT count(*) FROM page_tags pt WHERE pt.tag = td.tag COLLATE NOCASE) AS usage_count
      FROM tag_definitions td ORDER BY usage_count DESC, td.tag COLLATE NOCASE
    `).all().map((row) => ({ tag: row.tag, kind: row.kind, displayName: row.display_name, description: row.description, createdBy: row.created_by, aliases: this.db.query<{ alias: string }, [string]>("SELECT alias FROM tag_aliases WHERE canonical_tag = ? ORDER BY alias COLLATE NOCASE").all(row.tag).map(({ alias }) => alias), usageCount: row.usage_count, createdAt: row.created_at }));
  }

  defineTag(tagValue: string, kind: TagKind, displayName: string, aliases: string[] = [], description: string | null = null, createdBy: "human" | "model" = "human"): TagDefinition {
    const tag = normalizeTags([tagValue])[0]!;
    const normalizedAliases = normalizeTags(aliases).filter((alias) => alias !== tag);
    const now = new Date().toISOString();
    for (const alias of normalizedAliases) {
      const owner = this.db.query<{ canonical_tag: string }, [string]>("SELECT canonical_tag FROM tag_aliases WHERE alias = ? COLLATE NOCASE").get(alias);
      if (owner && owner.canonical_tag !== tag) throw new AppError("tag_alias_conflict", `alias '${alias}' already belongs to '${owner.canonical_tag}'`, 409);
    }
    this.db.transaction(() => {
      this.db.run("INSERT INTO tag_definitions(tag, kind, display_name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tag) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name, description = excluded.description", [tag, kind, displayName.trim() || tag, description, createdBy, now]);
      this.db.run("DELETE FROM tag_aliases WHERE canonical_tag = ?", [tag]);
      for (const alias of normalizedAliases) {
        this.db.run("UPDATE OR IGNORE tag_aliases SET canonical_tag = ? WHERE canonical_tag = ? COLLATE NOCASE", [tag, alias]);
        this.db.run("DELETE FROM tag_definitions WHERE tag = ? COLLATE NOCASE", [alias]);
        this.db.run("INSERT INTO tag_aliases(alias, canonical_tag) VALUES (?, ?)", [alias, tag]);
        const affected = this.db.query<{ page_id: number }, [string]>("SELECT page_id FROM page_tags WHERE tag = ? COLLATE NOCASE").all(alias);
        this.db.run("INSERT OR IGNORE INTO page_tags(page_id, tag) SELECT page_id, ? FROM page_tags WHERE tag = ? COLLATE NOCASE", [tag, alias]);
        this.db.run("DELETE FROM page_tags WHERE tag = ? COLLATE NOCASE", [alias]);
        for (const { page_id } of affected) {
          this.refreshSearch(page_id);
          this.db.run("INSERT INTO semantic_index_queue(page_id, requested_at, available_at, attempts, revision) VALUES (?, ?, ?, 0, 1) ON CONFLICT(page_id) DO UPDATE SET requested_at = excluded.requested_at, available_at = excluded.available_at, attempts = 0, revision = semantic_index_queue.revision + 1, lease_owner = NULL, lease_until = NULL, last_error = NULL", [page_id, now, now]);
        }
      }
    }).immediate();
    return this.listTagDefinitions().find((item) => item.tag === tag)!;
  }

  create(input: PageInput, source: ChangeSource): Page {
    const parsed = pageInputSchema.parse(input);
    const tags = this.canonicalizeTags(parsed.tags);
    const properties = normalizeProperties(parsed.properties);
    const alias = parsed.alias ? validateAlias(parsed.alias) : this.availableAlias(slugify(parsed.title));
    this.validateParent(null, parsed.parentId);
    const now = new Date().toISOString();

    try {
      const create = this.db.transaction(() => {
        const result = this.db.run(
          "INSERT INTO pages (title, alias, body, status, parent_id, properties_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [parsed.title, alias, parsed.body, parsed.status, parsed.parentId, JSON.stringify(properties), now, now],
        );
        const id = Number(result.lastInsertRowid);
        this.replaceTags(id, tags);
        this.replaceProperties(id, properties);
        this.replaceLinks(id, parsed.body);
        this.refreshSearch(id);
        return id;
      });
      return this.getById(create.immediate());
    } catch (error) {
      throw mapDatabaseError(error, alias);
    }
  }

  createImported(input: PageInput, source: ChangeSource): Page {
    const parsed = pageInputSchema.parse(input);
    const alias = parsed.alias ? this.availableAlias(validateAlias(parsed.alias)) : this.availableAlias(slugify(parsed.title));
    return this.create({ ...parsed, alias }, source);
  }

  update(id: number, input: PageUpdate, source: ChangeSource): Page {
    const parsed = pageUpdateSchema.parse(input);
    const current = this.getById(id);
    const title = parsed.title ?? current.title;
    const alias = parsed.alias === undefined ? current.alias : validateAlias(parsed.alias);
    const body = parsed.body ?? current.body;
    const tags = parsed.tags === undefined ? current.tags : this.canonicalizeTags(parsed.tags);
    const status = parsed.status ?? current.status;
    const parentId = parsed.parentId === undefined ? current.parentId : parsed.parentId;
    const properties = parsed.properties === undefined ? current.properties : normalizeProperties(parsed.properties);
    if (parsed.parentId !== undefined) this.validateParent(id, parentId);

    const unchanged = title === current.title && alias === current.alias && body === current.body && arraysEqual(tags, current.tags) && status === current.status && parentId === current.parentId && JSON.stringify(properties) === JSON.stringify(current.properties);
    if (unchanged) return current;

    const now = new Date().toISOString();
    try {
      const update = this.db.transaction(() => {
        this.db.run(
          "INSERT INTO revisions (page_id, title, alias, body, tags_json, status, parent_id, properties_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, current.title, current.alias, current.body, JSON.stringify(current.tags), current.status, current.parentId, JSON.stringify(current.properties), source, now],
        );
        this.db.run(
          "UPDATE pages SET title = ?, alias = ?, body = ?, status = ?, parent_id = ?, properties_json = ?, updated_at = ? WHERE id = ?",
          [title, alias, body, status, parentId, JSON.stringify(properties), now, id],
        );
        this.replaceTags(id, tags);
        this.replaceProperties(id, properties);
        this.replaceLinks(id, body);
        this.refreshSearch(id);
      });
      update.immediate();
      return this.getById(id);
    } catch (error) {
      throw mapDatabaseError(error, alias);
    }
  }

  getById(id: number): Page {
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError("invalid_id", "page ID is invalid", 400);
    const row = this.db.query<PageRow, [number]>("SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!row) throw new AppError("not_found", "page not found", 404);
    return this.hydrate(row);
  }

  getByAlias(alias: string): Page {
    const normalized = validateAlias(alias);
    const row = this.db.query<PageRow, [string]>("SELECT * FROM pages WHERE alias = ? COLLATE NOCASE AND deleted_at IS NULL").get(normalized);
    if (!row) throw new AppError("not_found", "page not found", 404);
    return this.hydrate(row);
  }

  list(cursorValue: string | null = null, limitValue = 50, statusValue: PageStatus | "all" = "published"): PageList {
    const cursor = decodeCursor(cursorValue);
    const limit = Math.max(1, Math.min(100, Math.trunc(limitValue)));
    const status = statusFilter(statusValue);
    const clauses = ["deleted_at IS NULL", ...(status === "all" ? [] : ["status = ?"]), ...(cursor ? ["id < ?"] : [])];
    const bindings: Array<string | number> = [...(status === "all" ? [] : [status]), ...(cursor ? [cursor] : []), limit + 1];
    const rows = this.db.query<PageRow, any[]>(`SELECT * FROM pages WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...bindings);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      pages: selected.map((row) => this.summary(row)),
      nextCursor: hasMore ? encodeCursor(selected.at(-1)!.id) : null,
    };
  }

  recent(limit = 20, statusValue: PageStatus | "all" = "published"): PageSummary[] {
    const status = statusFilter(statusValue);
    const sql = `SELECT * FROM pages WHERE deleted_at IS NULL${status === "all" ? "" : " AND status = ?"} ORDER BY updated_at DESC, id DESC LIMIT ?`;
    const bindings: Array<string | number> = [...(status === "all" ? [] : [status]), Math.max(1, Math.min(100, limit))];
    return this.db
      .query<PageRow, any[]>(sql)
      .all(...bindings)
      .map((row) => this.summary(row));
  }

  search(query: string, tags: string[] = [], cursorValue: string | null = null, limitValue = 20, statusValue: PageStatus | "all" = "published", propertyFilters: PageProperties = {}): SearchResults {
    const terms = ftsQuery(query);
    const normalizedTags = this.canonicalizeTags(tags);
    const properties = normalizeProperties(propertyFilters);
    const status = statusFilter(statusValue);
    if (!terms && normalizedTags.length === 0 && Object.keys(properties).length === 0) {
      throw new AppError("empty_search", "search text, a tag, or a property filter is required", 400);
    }

    const offset = decodeSearchCursor(cursorValue);
    const limit = Math.max(1, Math.min(100, Math.trunc(limitValue)));
    const tagClauses = normalizedTags.map(
      () => "EXISTS (SELECT 1 FROM page_tags filter_tag WHERE filter_tag.page_id = p.id AND filter_tag.tag = ? COLLATE NOCASE)",
    );
    const propertyClauses = Object.keys(properties).map(
      () => "EXISTS (SELECT 1 FROM page_properties filter_property WHERE filter_property.page_id = p.id AND filter_property.key = ? COLLATE NOCASE AND filter_property.value_json = ?)",
    );
    const statusClause = status === "all" ? [] : ["p.status = ?"];
    const filterClauses = [...statusClause, ...tagClauses, ...propertyClauses];
    const filters = filterClauses.length ? ` AND ${filterClauses.join(" AND ")}` : "";
    const sql = terms
      ? `SELECT p.*, bm25(page_search) AS rank FROM page_search JOIN pages p ON p.id = page_search.page_id WHERE page_search MATCH ?${filters} ORDER BY rank, p.id DESC LIMIT ? OFFSET ?`
      : `SELECT p.*, 0 AS rank FROM pages p WHERE p.deleted_at IS NULL${filters} ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`;
    const propertyBindings = Object.entries(properties).flatMap(([key, value]) => [key, JSON.stringify(value)]);
    const bindings: Array<string | number> = [...(terms ? [terms] : []), ...(status === "all" ? [] : [status]), ...normalizedTags, ...propertyBindings, limit + 1, offset];
    const rows = this.db.query<SearchRow, any[]>(sql).all(...bindings);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      pages: selected.map((row) => ({ ...this.summary(row), excerpt: excerpt(row.body) })),
      nextCursor: hasMore ? encodeSearchCursor(offset + limit) : null,
    };
  }

  listTags(): Array<{ tag: string; count: number }> {
    return this.db
      .query<{ tag: string; count: number }, []>("SELECT pt.tag, COUNT(*) AS count FROM page_tags pt JOIN pages p ON p.id = pt.page_id WHERE p.deleted_at IS NULL AND p.status = 'published' GROUP BY pt.tag COLLATE NOCASE ORDER BY pt.tag COLLATE NOCASE")
      .all();
  }

  pagesForTag(tag: string): PageSummary[] {
    const normalized = tag.trim().toLowerCase();
    return this.db
      .query<PageRow, [string]>(
        "SELECT p.* FROM pages p JOIN page_tags pt ON pt.page_id = p.id WHERE p.deleted_at IS NULL AND p.status = 'published' AND pt.tag = ? COLLATE NOCASE ORDER BY p.updated_at DESC",
      )
      .all(normalized)
      .map((row) => this.summary(row));
  }

  allActivePages(): Page[] {
    return this.db.query<PageRow, []>("SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY id").all().map((row) => this.hydrate(row));
  }

  allDeletedPages(): DeletedPage[] {
    return this.db.query<PageRow, []>("SELECT * FROM pages WHERE deleted_at IS NOT NULL ORDER BY id").all().map((row) => this.hydrateDeleted(row));
  }

  allRevisions(): Revision[] {
    return this.db.query<RevisionRow, []>("SELECT * FROM revisions ORDER BY page_id, id").all().map((row) => ({ ...this.revisionSummary(row), body: row.body }));
  }

  allAttachments(): Attachment[] {
    return this.db.query<AttachmentRow, []>(attachmentSelect("1 = 1")).all().map(toAttachment);
  }

  allDocuments(): DocumentRecord[] {
    return this.db.query<DocumentRow, []>("SELECT * FROM documents ORDER BY id").all().map((row) => this.hydrateDocument(row));
  }

  allDocumentVersions(): DocumentVersion[] {
    return this.db.query<DocumentVersionRow, []>(documentVersionSelect("1 = 1") + " ORDER BY dv.document_id, dv.version").all().map(toDocumentVersion);
  }

  attachmentFilePath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new AppError("invalid_attachment_hash", "attachment hash is invalid", 400);
    return this.pathForHash(sha256);
  }

  parentCandidates(pageId: number | null = null): PageReference[] {
    const rows = this.db.query<PageRow, []>("SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE").all();
    if (pageId === null) return rows.map(({ id, title, alias }) => ({ id, title, alias }));
    const excluded = new Set<number>([pageId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.parent_id !== null && excluded.has(row.parent_id) && !excluded.has(row.id)) {
          excluded.add(row.id);
          changed = true;
        }
      }
    }
    return rows.filter(({ id }) => !excluded.has(id)).map(({ id, title, alias }) => ({ id, title, alias }));
  }

  tree(statusValue: PageStatus | "all" = "published"): TreeEntry[] {
    const status = statusFilter(statusValue);
    const sql = `SELECT * FROM pages WHERE deleted_at IS NULL${status === "all" ? "" : " AND status = ?"} ORDER BY title COLLATE NOCASE`;
    const rows = this.db.query<PageRow, any[]>(sql).all(...(status === "all" ? [] : [status]));
    const included = new Set(rows.map(({ id }) => id));
    const children = new Map<number | null, PageRow[]>();
    for (const row of rows) {
      const parent = row.parent_id !== null && included.has(row.parent_id) ? row.parent_id : null;
      children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    const result: TreeEntry[] = [];
    const visit = (parent: number | null, depth: number) => {
      for (const row of children.get(parent) ?? []) {
        result.push({ id: row.id, title: row.title, alias: row.alias, status: row.status, parentId: row.parent_id, depth });
        visit(row.id, depth + 1);
      }
    };
    visit(null, 0);
    return result;
  }

  createDocument(filenameValue: string, mimeTypeValue: string, format: DocumentFormat, bytes: Uint8Array, source: ChangeSource, maxBytes: number): DocumentRecord {
    const filename = validateFilename(filenameValue);
    if (bytes.byteLength > maxBytes) throw new AppError("document_too_large", `document exceeds the technical ${maxBytes} byte guard`, 413);
    const mimeType = normalizeMimeType(mimeTypeValue);
    const title = filename.replace(/\.[^.]+$/, "").trim() || filename;
    const page = this.create({
      title: title.slice(0, 200),
      body: `> Imported document: **${filename.replace(/[\\[\]*_`]/g, "\\$&")}**\n\nExtracted content is managed by nwp and appears below when ready.`,
      tags: ["type:document", `type:${format}`],
      properties: { "document.filename": filename, "document.format": format },
    }, source);
    const now = new Date().toISOString();
    const sha256 = this.ensureBlob(bytes, mimeType, now);
    try {
      const documentId = this.db.transaction(() => {
        const result = this.db.run("INSERT INTO documents(page_id, filename, mime_type, format, status, managed_title, managed_body, managed_tags_json, managed_properties_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)", [page.id, filename, mimeType, format, page.title, page.body, JSON.stringify(page.tags), JSON.stringify(page.properties), now, now]);
        const id = Number(result.lastInsertRowid);
        const version = this.db.run("INSERT INTO document_versions(document_id, version, blob_sha256, status, created_at) VALUES (?, 1, ?, 'queued', ?)", [id, sha256, now]);
        this.db.run("INSERT INTO document_jobs(document_id, version_id, requested_at, available_at) VALUES (?, ?, ?, ?)", [id, Number(version.lastInsertRowid), now, now]);
        return id;
      }).immediate();
      return this.getDocument(documentId);
    } catch (error) {
      this.db.run("DELETE FROM pages WHERE id = ?", [page.id]);
      if (this.removeBlobIfOrphaned(sha256)) this.unlinkBlob(sha256);
      throw error;
    }
  }

  replaceDocument(documentId: number, filenameValue: string, mimeTypeValue: string, format: DocumentFormat, bytes: Uint8Array, maxBytes: number): DocumentRecord {
    const current = this.getDocument(documentId);
    const managed = this.db.query<DocumentRow, [number]>("SELECT * FROM documents WHERE id = ?").get(documentId)!;
    const page = this.getById(current.pageId);
    const humanEdited = page.title !== managed.managed_title || page.body !== managed.managed_body || JSON.stringify(page.tags) !== managed.managed_tags_json || JSON.stringify(page.properties) !== managed.managed_properties_json;
    const filename = validateFilename(filenameValue);
    if (bytes.byteLength > maxBytes) throw new AppError("document_too_large", `document exceeds the technical ${maxBytes} byte guard`, 413);
    const mimeType = normalizeMimeType(mimeTypeValue);
    const now = new Date().toISOString();
    const sha256 = this.ensureBlob(bytes, mimeType, now);
    try {
      this.db.transaction(() => {
        const nextVersion = current.currentVersion.version + 1;
        this.db.run("UPDATE document_versions SET status = 'superseded' WHERE document_id = ? AND status IN ('queued', 'extracting')", [documentId]);
        const version = this.db.run("INSERT INTO document_versions(document_id, version, blob_sha256, status, created_at) VALUES (?, ?, ?, 'queued', ?)", [documentId, nextVersion, sha256, now]);
        this.db.run("UPDATE documents SET filename = ?, mime_type = ?, format = ?, status = 'queued', needs_ocr = 0, needs_review = ?, last_error = NULL, updated_at = ? WHERE id = ?", [filename, mimeType, format, humanEdited ? 1 : managed.needs_review, now, documentId]);
        this.db.run("INSERT INTO document_jobs(document_id, version_id, requested_at, available_at, attempts, revision) VALUES (?, ?, ?, ?, 0, 1) ON CONFLICT(document_id) DO UPDATE SET version_id = excluded.version_id, requested_at = excluded.requested_at, available_at = excluded.available_at, attempts = 0, revision = document_jobs.revision + 1, lease_owner = NULL, lease_until = NULL, last_error = NULL", [documentId, Number(version.lastInsertRowid), now, now]);
      }).immediate();
      return this.getDocument(documentId);
    } catch (error) {
      if (this.removeBlobIfOrphaned(sha256)) this.unlinkBlob(sha256);
      throw error;
    }
  }

  getDocument(documentId: number): DocumentRecord {
    if (!Number.isSafeInteger(documentId) || documentId < 1) throw new AppError("invalid_document_id", "document ID is invalid", 400);
    const row = this.db.query<DocumentRow, [number]>("SELECT d.* FROM documents d JOIN pages p ON p.id = d.page_id WHERE d.id = ? AND p.deleted_at IS NULL").get(documentId);
    if (!row) throw new AppError("document_not_found", "document not found", 404);
    return this.hydrateDocument(row);
  }

  documentForPage(pageId: number): DocumentRecord | null {
    const row = this.db.query<DocumentRow, [number]>("SELECT d.* FROM documents d JOIN pages p ON p.id = d.page_id WHERE d.page_id = ? AND p.deleted_at IS NULL").get(pageId);
    return row ? this.hydrateDocument(row) : null;
  }

  listDocuments(): DocumentRecord[] {
    return this.db.query<DocumentRow, []>("SELECT d.* FROM documents d JOIN pages p ON p.id = d.page_id WHERE p.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC").all().map((row) => this.hydrateDocument(row));
  }

  listDocumentVersions(documentId: number): DocumentVersion[] {
    this.getDocument(documentId);
    return this.db.query<DocumentVersionRow, [number]>(documentVersionSelect("dv.document_id = ?") + " ORDER BY dv.version DESC").all(documentId).map(toDocumentVersion);
  }

  documentSections(documentId: number, versionId?: number, offset = 0, limit?: number): DocumentSection[] {
    const document = this.getDocument(documentId);
    const selected = versionId ?? document.currentVersion.id;
    const owner = this.db.query<{ found: number }, [number, number]>("SELECT 1 AS found FROM document_versions WHERE id = ? AND document_id = ?").get(selected, documentId);
    if (!owner) throw new AppError("document_version_not_found", "document version not found", 404);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError("invalid_offset", "offset must be a non-negative integer", 400);
    const sql = `SELECT * FROM document_sections WHERE document_version_id = ? ORDER BY ordinal${limit === undefined ? "" : " LIMIT ? OFFSET ?"}`;
    const rows = limit === undefined
      ? this.db.query<{ id: number; document_version_id: number; ordinal: number; kind: DocumentSection["kind"]; title: string | null; locator_json: string; text: string; hidden: number; needs_ocr: number }, [number]>(sql).all(selected)
      : this.db.query<{ id: number; document_version_id: number; ordinal: number; kind: DocumentSection["kind"]; title: string | null; locator_json: string; text: string; hidden: number; needs_ocr: number }, [number, number, number]>(sql).all(selected, Math.max(1, Math.min(100, limit)), offset);
    return rows.map((row) => ({ id: row.id, documentVersionId: row.document_version_id, ordinal: row.ordinal, kind: row.kind, title: row.title, locator: JSON.parse(row.locator_json), text: row.text, hidden: row.hidden === 1, needsOcr: row.needs_ocr === 1 }));
  }

  documentSectionCount(documentId: number, versionId?: number): number {
    const document = this.getDocument(documentId);
    const selected = versionId ?? document.currentVersion.id;
    return this.db.query<{ count: number }, [number, number]>("SELECT count(*) AS count FROM document_sections ds JOIN document_versions dv ON dv.id = ds.document_version_id WHERE ds.document_version_id = ? AND dv.document_id = ?").get(selected, documentId)?.count ?? 0;
  }

  documentVersionPath(versionId: number): { document: DocumentRecord; version: DocumentVersion; path: string } {
    const row = this.db.query<DocumentVersionRow, [number]>(documentVersionSelect("dv.id = ?")).get(versionId);
    if (!row) throw new AppError("document_version_not_found", "document version not found", 404);
    const document = this.getDocument(row.document_id);
    return { document, version: toDocumentVersion(row), path: this.pathForHash(row.blob_sha256) };
  }

  claimDocumentTask(owner: string, leaseMilliseconds = 30 * 60_000): DocumentTask | null {
    const now = new Date();
    const until = new Date(now.getTime() + leaseMilliseconds).toISOString();
    return this.db.transaction(() => {
      const row = this.db.query<{ document_id: number; version_id: number; revision: number }, [string, string]>("SELECT document_id, version_id, revision FROM document_jobs WHERE attempts < 3 AND available_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY requested_at, document_id LIMIT 1").get(now.toISOString(), now.toISOString());
      if (!row) return null;
      this.db.run("UPDATE document_jobs SET lease_owner = ?, lease_until = ? WHERE document_id = ? AND revision = ?", [owner, until, row.document_id, row.revision]);
      this.db.run("UPDATE documents SET status = 'extracting', updated_at = ? WHERE id = ?", [now.toISOString(), row.document_id]);
      this.db.run("UPDATE document_versions SET status = 'extracting' WHERE id = ?", [row.version_id]);
      return { documentId: row.document_id, versionId: row.version_id, revision: row.revision, owner };
    }).immediate();
  }

  renewDocumentLease(task: DocumentTask, leaseMilliseconds = 30 * 60_000): boolean {
    return this.db.run("UPDATE document_jobs SET lease_until = ? WHERE document_id = ? AND version_id = ? AND revision = ? AND lease_owner = ?", [new Date(Date.now() + leaseMilliseconds).toISOString(), task.documentId, task.versionId, task.revision, task.owner]).changes === 1;
  }

  completeDocumentTask(task: DocumentTask, extraction: ExtractedDocument, parserVersion: string): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const current = this.db.query<{ revision: number; version_id: number; lease_owner: string | null }, [number]>("SELECT revision, version_id, lease_owner FROM document_jobs WHERE document_id = ?").get(task.documentId);
      if (!current || current.revision !== task.revision || current.version_id !== task.versionId || current.lease_owner !== task.owner) return;
      this.db.run("DELETE FROM document_sections WHERE document_version_id = ?", [task.versionId]);
      const insert = this.db.query("INSERT INTO document_sections(document_version_id, ordinal, kind, title, locator_json, text, hidden, needs_ocr) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      extraction.sections.forEach((item, index) => insert.run(task.versionId, index, item.kind, item.title, JSON.stringify(item.locator), item.text, item.hidden ? 1 : 0, item.needsOcr ? 1 : 0));
      this.db.run("UPDATE document_versions SET status = 'ready', parser_version = ?, metadata_json = ?, warnings_json = ?, extracted_at = ? WHERE id = ?", [parserVersion, JSON.stringify(extraction.metadata), JSON.stringify(extraction.warnings), now, task.versionId]);
      this.db.run("UPDATE documents SET status = 'ready', needs_ocr = ?, last_error = NULL, updated_at = ? WHERE id = ?", [extraction.needsOcr ? 1 : 0, now, task.documentId]);
      this.db.run("DELETE FROM document_jobs WHERE document_id = ? AND revision = ?", [task.documentId, task.revision]);
    }).immediate();
  }

  failDocumentTask(task: DocumentTask, message: string, retryable = true): void {
    const row = this.db.query<{ attempts: number }, [number, number, number, string]>("SELECT attempts FROM document_jobs WHERE document_id = ? AND version_id = ? AND revision = ? AND lease_owner = ?").get(task.documentId, task.versionId, task.revision, task.owner);
    if (!row) return;
    const attempts = retryable ? row.attempts + 1 : 3;
    const failed = attempts >= 3;
    const available = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts)).toISOString();
    this.db.transaction(() => {
      this.db.run("UPDATE document_jobs SET attempts = ?, available_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ? WHERE document_id = ? AND revision = ?", [attempts, available, message.slice(0, 2000), task.documentId, task.revision]);
      this.db.run("UPDATE documents SET status = ?, last_error = ?, updated_at = ? WHERE id = ?", [failed ? "failed" : "queued", message.slice(0, 2000), new Date().toISOString(), task.documentId]);
      this.db.run("UPDATE document_versions SET status = ? WHERE id = ?", [failed ? "failed" : "queued", task.versionId]);
    }).immediate();
  }

  cancelDocument(documentId: number): DocumentRecord {
    const document = this.getDocument(documentId);
    if (document.status !== "queued" && document.status !== "extracting") throw new AppError("document_not_running", "document extraction is not queued or running", 409);
    this.db.transaction(() => {
      this.db.run("DELETE FROM document_jobs WHERE document_id = ?", [documentId]);
      this.db.run("UPDATE documents SET status = 'cancelled', updated_at = ? WHERE id = ?", [new Date().toISOString(), documentId]);
      this.db.run("UPDATE document_versions SET status = 'cancelled' WHERE id = ?", [document.currentVersion.id]);
    }).immediate();
    return this.getDocument(documentId);
  }

  retryDocument(documentId: number): DocumentRecord {
    const document = this.getDocument(documentId);
    if (document.status !== "failed" && document.status !== "cancelled") throw new AppError("document_not_retryable", "only failed or cancelled extraction can be retried", 409);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run("INSERT INTO document_jobs(document_id, version_id, requested_at, available_at, attempts, revision) VALUES (?, ?, ?, ?, 0, 1) ON CONFLICT(document_id) DO UPDATE SET version_id = excluded.version_id, requested_at = excluded.requested_at, available_at = excluded.available_at, attempts = 0, revision = document_jobs.revision + 1, lease_owner = NULL, lease_until = NULL, last_error = NULL", [documentId, document.currentVersion.id, now, now]);
      this.db.run("UPDATE documents SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?", [now, documentId]);
      this.db.run("UPDATE document_versions SET status = 'queued' WHERE id = ?", [document.currentVersion.id]);
    }).immediate();
    return this.getDocument(documentId);
  }

  acknowledgeDocumentReview(documentId: number): DocumentRecord {
    const document = this.getDocument(documentId);
    const page = this.getById(document.pageId);
    this.db.run("UPDATE documents SET needs_review = 0, managed_title = ?, managed_body = ?, managed_tags_json = ?, managed_properties_json = ?, updated_at = ? WHERE id = ?", [page.title, page.body, JSON.stringify(page.tags), JSON.stringify(page.properties), new Date().toISOString(), documentId]);
    return this.getDocument(documentId);
  }

  documentBlobPath(documentId: number): { document: DocumentRecord; path: string } {
    const document = this.getDocument(documentId);
    return { document, path: this.pathForHash(document.currentVersion.sha256) };
  }

  private hydrateDocument(row: DocumentRow): DocumentRecord {
    const version = this.db.query<DocumentVersionRow, [number]>(documentVersionSelect("dv.document_id = ?") + " ORDER BY dv.version DESC LIMIT 1").get(row.id);
    if (!version) throw new Error(`document ${row.id} has no version`);
    return { id: row.id, pageId: row.page_id, filename: row.filename, mimeType: row.mime_type, format: row.format, status: row.status, needsOcr: row.needs_ocr === 1, needsReview: row.needs_review === 1, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, currentVersion: toDocumentVersion(version) };
  }

  private ensureBlob(bytes: Uint8Array, mimeType: string, now: string): string {
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex") as string;
    const path = this.pathForHash(sha256);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.db.run("INSERT OR IGNORE INTO attachment_blobs(sha256, size, mime_type, inline_safe, created_at) VALUES (?, ?, ?, 0, ?)", [sha256, bytes.byteLength, mimeType, now]);
    return sha256;
  }

  addAttachment(pageId: number, filenameValue: string, mimeTypeValue: string, bytes: Uint8Array, maxBytes: number | null): Attachment {
    this.getById(pageId);
    const filename = validateFilename(filenameValue);
    if (maxBytes !== null && bytes.byteLength > maxBytes) {
      throw new AppError("attachment_too_large", `attachment exceeds the configured ${maxBytes} byte limit`, 413);
    }
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex") as string;
    const safeMime = detectSafeImage(bytes);
    const mimeType = safeMime ?? normalizeMimeType(mimeTypeValue);
    const now = new Date().toISOString();
    const path = this.pathForHash(sha256);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }

    try {
      const attach = this.db.transaction(() => {
        this.db.run(
          "INSERT OR IGNORE INTO attachment_blobs (sha256, size, mime_type, inline_safe, created_at) VALUES (?, ?, ?, ?, ?)",
          [sha256, bytes.byteLength, mimeType, safeMime ? 1 : 0, now],
        );
        const result = this.db.run(
          "INSERT INTO page_attachments (page_id, blob_sha256, filename, created_at) VALUES (?, ?, ?, ?)",
          [pageId, sha256, filename, now],
        );
        return Number(result.lastInsertRowid);
      });
      return this.getAttachment(attach.immediate());
    } catch (error) {
      const blobExists = this.db.query<{ found: number }, [string]>("SELECT 1 AS found FROM attachment_blobs WHERE sha256 = ?").get(sha256);
      if (!blobExists) this.unlinkBlob(sha256);
      if (String(error).includes("UNIQUE constraint failed: page_attachments.page_id, page_attachments.filename")) {
        throw new AppError("attachment_name_conflict", `attachment '${filename}' already exists on this page`, 409);
      }
      throw error;
    }
  }

  listAttachments(pageId: number, includeDeleted = false): Attachment[] {
    if (includeDeleted) this.getDeletedById(pageId);
    else this.getById(pageId);
    return this.db.query<AttachmentRow, [number]>(attachmentSelect("pa.page_id = ?")).all(pageId).map(toAttachment);
  }

  getAttachment(attachmentId: number): Attachment {
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) throw new AppError("invalid_attachment_id", "attachment ID is invalid", 400);
    const row = this.db.query<AttachmentRow, [number]>(attachmentSelect("pa.id = ? AND p.deleted_at IS NULL")).get(attachmentId);
    if (!row) throw new AppError("attachment_not_found", "attachment not found", 404);
    return toAttachment(row);
  }

  attachmentPath(attachmentId: number): { attachment: Attachment; path: string } {
    const attachment = this.getAttachment(attachmentId);
    return { attachment, path: this.pathForHash(attachment.sha256) };
  }

  removeAttachment(attachmentId: number): Attachment {
    const attachment = this.getAttachment(attachmentId);
    const remove = this.db.transaction(() => {
      this.db.run("DELETE FROM page_attachments WHERE id = ?", [attachmentId]);
      return this.removeBlobIfOrphaned(attachment.sha256);
    });
    const orphaned = remove.immediate();
    if (orphaned) this.unlinkBlob(attachment.sha256);
    return attachment;
  }

  deletePage(pageId: number): DeletedPage {
    const current = this.getById(pageId);
    const now = new Date().toISOString();
    const tombstoneAlias = this.availableAlias(`nwp-deleted-${pageId}`);
    const remove = this.db.transaction(() => {
      this.db.run(
        "UPDATE pages SET alias = ?, deleted_alias = ?, deleted_at = ?, updated_at = ? WHERE id = ?",
        [tombstoneAlias, current.alias, now, now, pageId],
      );
      this.db.run("DELETE FROM page_search WHERE page_id = ?", [pageId]);
      this.db.run("DELETE FROM document_jobs WHERE document_id IN (SELECT id FROM documents WHERE page_id = ?)", [pageId]);
      this.db.run("UPDATE document_versions SET status = 'cancelled' WHERE document_id IN (SELECT id FROM documents WHERE page_id = ?) AND status IN ('queued', 'extracting')", [pageId]);
      this.db.run("UPDATE documents SET status = 'cancelled', updated_at = ? WHERE page_id = ? AND status IN ('queued', 'extracting')", [now, pageId]);
    });
    remove.immediate();
    return this.getDeletedById(pageId);
  }

  getDeletedById(pageId: number): DeletedPage {
    if (!Number.isSafeInteger(pageId) || pageId < 1) throw new AppError("invalid_id", "page ID is invalid", 400);
    const row = this.db.query<PageRow, [number]>("SELECT * FROM pages WHERE id = ? AND deleted_at IS NOT NULL").get(pageId);
    if (!row) throw new AppError("deleted_page_not_found", "deleted page not found", 404);
    return this.hydrateDeleted(row);
  }

  getDeletedByAlias(alias: string): DeletedPage {
    const normalized = validateAlias(alias);
    const row = this.db.query<PageRow, [string]>("SELECT * FROM pages WHERE deleted_alias = ? COLLATE NOCASE AND deleted_at IS NOT NULL ORDER BY id DESC LIMIT 1").get(normalized);
    if (!row) throw new AppError("deleted_page_not_found", "deleted page not found", 404);
    return this.hydrateDeleted(row);
  }

  listTrash(cursorValue: string | null = null, limitValue = 50): TrashList {
    const cursor = decodeCursor(cursorValue);
    const limit = Math.max(1, Math.min(100, Math.trunc(limitValue)));
    const rows = cursor
      ? this.db.query<PageRow, [number, number]>("SELECT * FROM pages WHERE deleted_at IS NOT NULL AND id < ? ORDER BY id DESC LIMIT ?").all(cursor, limit + 1)
      : this.db.query<PageRow, [number]>("SELECT * FROM pages WHERE deleted_at IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit + 1);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      pages: selected.map((row) => this.hydrateDeleted(row)),
      nextCursor: hasMore ? encodeCursor(selected.at(-1)!.id) : null,
    };
  }

  restoreDeleted(pageId: number): Page {
    const deleted = this.getDeletedById(pageId);
    const owner = this.db.query<{ id: number }, [string]>("SELECT id FROM pages WHERE alias = ? COLLATE NOCASE AND deleted_at IS NULL").get(deleted.alias);
    const alias = owner ? this.availableAlias(deleted.alias) : deleted.alias;
    const now = new Date().toISOString();
    const restore = this.db.transaction(() => {
      this.db.run(
        "UPDATE pages SET alias = ?, deleted_alias = NULL, deleted_at = NULL, updated_at = ? WHERE id = ?",
        [alias, now, pageId],
      );
      this.refreshSearch(pageId);
    });
    restore.immediate();
    return this.getById(pageId);
  }

  purgeDeleted(pageId: number): void {
    this.getDeletedById(pageId);
    const hashes = this.db.query<{ sha256: string }, [number, number]>(
      "SELECT blob_sha256 AS sha256 FROM page_attachments WHERE page_id = ? UNION SELECT dv.blob_sha256 AS sha256 FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE d.page_id = ?",
    ).all(pageId, pageId).map(({ sha256 }) => sha256);
    const purge = this.db.transaction(() => {
      this.db.run("DELETE FROM pages WHERE id = ?", [pageId]);
      return hashes.filter((hash) => this.removeBlobIfOrphaned(hash));
    });
    for (const hash of purge.immediate()) this.unlinkBlob(hash);
  }

  revisionCount(pageId: number): number {
    return this.db.query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM revisions WHERE page_id = ?").get(pageId)?.count ?? 0;
  }

  listRevisions(pageId: number, cursorValue: string | null = null, limitValue = 50): RevisionList {
    this.getById(pageId);
    const cursor = decodeCursor(cursorValue);
    const limit = Math.max(1, Math.min(100, Math.trunc(limitValue)));
    const rows = cursor
      ? this.db.query<RevisionRow, [number, number, number]>("SELECT * FROM revisions WHERE page_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(pageId, cursor, limit + 1)
      : this.db.query<RevisionRow, [number, number]>("SELECT * FROM revisions WHERE page_id = ? ORDER BY id DESC LIMIT ?").all(pageId, limit + 1);
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      revisions: selected.map((row) => this.revisionSummary(row)),
      nextCursor: hasMore ? encodeCursor(selected.at(-1)!.id) : null,
    };
  }

  getRevision(pageId: number, revisionId: number): Revision {
    this.getById(pageId);
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) throw new AppError("invalid_revision_id", "revision ID is invalid", 400);
    const row = this.db.query<RevisionRow, [number, number]>("SELECT * FROM revisions WHERE id = ? AND page_id = ?").get(revisionId, pageId);
    if (!row) throw new AppError("revision_not_found", "revision not found", 404);
    return { ...this.revisionSummary(row), body: row.body };
  }

  restoreRevision(pageId: number, revisionId: number, source: ChangeSource): Page {
    const revision = this.getRevision(pageId, revisionId);
    const owner = this.db.query<{ id: number }, [string]>("SELECT id FROM pages WHERE alias = ? COLLATE NOCASE AND deleted_at IS NULL").get(revision.alias);
    const alias = !owner || owner.id === pageId ? revision.alias : this.availableAlias(revision.alias);
    const parentId = revision.parentId !== null && this.activePageExists(revision.parentId) ? revision.parentId : null;
    return this.update(pageId, {
      title: revision.title,
      alias,
      body: revision.body,
      tags: revision.tags,
      status: revision.status,
      parentId,
      properties: revision.properties,
    }, source);
  }

  private revisionSummary(row: RevisionRow): RevisionSummary {
    let tags: unknown;
    try { tags = JSON.parse(row.tags_json); } catch { tags = []; }
    return {
      id: row.id,
      pageId: row.page_id,
      title: row.title,
      alias: row.alias,
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
      status: row.status,
      parentId: row.parent_id,
      properties: parseProperties(row.properties_json),
      source: row.source,
      createdAt: row.created_at,
    };
  }

  private hydrate(row: PageRow): Page {
    return {
      ...this.summary(row),
      body: row.body,
      properties: parseProperties(row.properties_json),
      breadcrumbs: this.breadcrumbs(row.parent_id),
      backlinks: this.db
        .query<PageReference, [string]>(
          "SELECT p.id, p.title, p.alias FROM page_links l JOIN pages p ON p.id = l.source_page_id WHERE p.deleted_at IS NULL AND l.target_alias = ? COLLATE NOCASE ORDER BY p.title COLLATE NOCASE",
        )
        .all(row.alias),
    };
  }

  private hydrateDeleted(row: PageRow): DeletedPage {
    const originalAlias = row.deleted_alias ?? row.alias;
    return {
      ...this.summary({ ...row, alias: originalAlias }),
      body: row.body,
      properties: parseProperties(row.properties_json),
      breadcrumbs: this.breadcrumbs(row.parent_id),
      backlinks: this.db
        .query<PageReference, [string]>(
          "SELECT p.id, p.title, p.alias FROM page_links l JOIN pages p ON p.id = l.source_page_id WHERE p.deleted_at IS NULL AND l.target_alias = ? COLLATE NOCASE ORDER BY p.title COLLATE NOCASE",
        )
        .all(originalAlias),
      deletedAt: row.deleted_at!,
    };
  }

  private summary(row: PageRow): PageSummary {
    return {
      id: row.id,
      title: row.title,
      alias: row.alias,
      tags: this.db.query<{ tag: string }, [number]>("SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag COLLATE NOCASE").all(row.id).map(({ tag }) => tag),
      status: row.status,
      parentId: row.parent_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private canonicalizeTags(values: string[]): string[] {
    const tags = normalizeTags(values).map((tag) => this.db.query<{ canonical_tag: string }, [string]>("SELECT canonical_tag FROM tag_aliases WHERE alias = ? COLLATE NOCASE").get(tag)?.canonical_tag ?? tag);
    return normalizeTags(tags);
  }

  private availableAlias(base: string): string {
    let candidate = validateAlias(base);
    let suffix = 2;
    while (this.db.query<{ found: number }, [string]>("SELECT 1 AS found FROM pages WHERE alias = ? COLLATE NOCASE").get(candidate)) {
      candidate = `${base.slice(0, 190)}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private replaceTags(pageId: number, tags: string[]): void {
    this.db.run("DELETE FROM page_tags WHERE page_id = ?", [pageId]);
    const insert = this.db.query("INSERT INTO page_tags (page_id, tag) VALUES (?, ?)");
    for (const tag of tags) insert.run(pageId, tag);
  }

  private replaceProperties(pageId: number, properties: PageProperties): void {
    this.db.run("DELETE FROM page_properties WHERE page_id = ?", [pageId]);
    const insert = this.db.query("INSERT INTO page_properties (page_id, key, value_json, value_text) VALUES (?, ?, ?, ?)");
    for (const [key, value] of Object.entries(properties)) {
      insert.run(pageId, key, JSON.stringify(value), value === null ? "null" : String(value));
    }
  }

  private replaceLinks(pageId: number, body: string): void {
    this.db.run("DELETE FROM page_links WHERE source_page_id = ?", [pageId]);
    const insert = this.db.query("INSERT INTO page_links (source_page_id, target_alias) VALUES (?, ?)");
    for (const alias of extractWikiLinks(body)) insert.run(pageId, alias);
  }

  private activePageExists(pageId: number): boolean {
    return Boolean(this.db.query<{ found: number }, [number]>("SELECT 1 AS found FROM pages WHERE id = ? AND deleted_at IS NULL").get(pageId));
  }

  private validateParent(pageId: number | null, parentId: number | null): void {
    if (parentId === null) return;
    if (pageId !== null && pageId === parentId) throw new AppError("invalid_parent", "a page cannot be its own parent", 400);
    if (!this.activePageExists(parentId)) throw new AppError("invalid_parent", "parent page not found", 400);
    if (pageId === null) return;
    let cursor: number | null = parentId;
    const visited = new Set<number>();
    while (cursor !== null) {
      if (cursor === pageId) throw new AppError("invalid_parent", "parent relationship would create a cycle", 400);
      if (visited.has(cursor)) throw new AppError("invalid_parent", "existing parent relationship contains a cycle", 400);
      visited.add(cursor);
      cursor = this.db.query<{ parent_id: number | null }, [number]>("SELECT parent_id FROM pages WHERE id = ? AND deleted_at IS NULL").get(cursor)?.parent_id ?? null;
    }
  }

  private breadcrumbs(parentId: number | null): PageReference[] {
    const result: PageReference[] = [];
    const visited = new Set<number>();
    let cursor = parentId;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      const row = this.db.query<PageRow, [number]>("SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL").get(cursor);
      if (!row) break;
      result.unshift({ id: row.id, title: row.title, alias: row.alias });
      cursor = row.parent_id;
    }
    return result;
  }

  private removeBlobIfOrphaned(sha256: string): boolean {
    const referenced = this.db.query<{ found: number }, [string, string]>("SELECT 1 AS found FROM page_attachments WHERE blob_sha256 = ? UNION ALL SELECT 1 AS found FROM document_versions WHERE blob_sha256 = ? LIMIT 1").get(sha256, sha256);
    if (referenced) return false;
    this.db.run("DELETE FROM attachment_blobs WHERE sha256 = ?", [sha256]);
    return true;
  }

  private pathForHash(sha256: string): string {
    return join(this.attachmentDir, sha256.slice(0, 2), sha256);
  }

  private unlinkBlob(sha256: string): void {
    try { unlinkSync(this.pathForHash(sha256)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private refreshSearch(pageId: number): void {
    this.db.run("DELETE FROM page_search WHERE page_id = ?", [pageId]);
    this.db.run(
      `INSERT INTO page_search (page_id, title, alias, body, tags, properties)
       SELECT p.id, p.title, p.alias, p.body,
         COALESCE((SELECT group_concat(pt.tag, ' ') FROM page_tags pt WHERE pt.page_id = p.id), ''),
         COALESCE((SELECT group_concat(pp.key || ' ' || pp.value_text, ' ') FROM page_properties pp WHERE pp.page_id = p.id), '')
       FROM pages p WHERE p.id = ? AND p.deleted_at IS NULL`,
      [pageId],
    );
  }
}

function documentVersionSelect(where: string): string {
  return `SELECT dv.id, dv.document_id, dv.version, dv.blob_sha256, b.size, dv.status, dv.parser_version, dv.metadata_json, dv.warnings_json, dv.created_at, dv.extracted_at
    FROM document_versions dv JOIN attachment_blobs b ON b.sha256 = dv.blob_sha256 WHERE ${where}`;
}

function toDocumentVersion(row: DocumentVersionRow): DocumentVersion {
  let warnings: unknown = [];
  let metadata: unknown = {};
  try { warnings = JSON.parse(row.warnings_json); } catch { warnings = []; }
  try { metadata = JSON.parse(row.metadata_json); } catch { metadata = {}; }
  return { id: row.id, documentId: row.document_id, version: row.version, sha256: row.blob_sha256, size: row.size, status: row.status, parserVersion: row.parser_version, metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, string | number | boolean | null> : {}, warnings: Array.isArray(warnings) ? warnings.filter((item): item is string => typeof item === "string") : [], createdAt: row.created_at, extractedAt: row.extracted_at };
}

function attachmentSelect(where: string): string {
  return `SELECT pa.id, pa.page_id, pa.filename, b.mime_type, b.size, b.sha256, b.inline_safe, pa.created_at
    FROM page_attachments pa
    JOIN attachment_blobs b ON b.sha256 = pa.blob_sha256
    JOIN pages p ON p.id = pa.page_id
    WHERE ${where}
    ORDER BY pa.id`;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    pageId: row.page_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    inlineSafe: row.inline_safe === 1,
    createdAt: row.created_at,
  };
}

function validateFilename(value: string): string {
  const filename = value.trim();
  if (!filename || filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(filename) || filename === "." || filename === "..") {
    throw new AppError("invalid_attachment_filename", "attachment filename is invalid", 400);
  }
  return filename;
}

function normalizeMimeType(value: string): string {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

function detectSafeImage(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 6 && (new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (starts(0x42, 0x4d)) return "image/bmp";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 12)).startsWith("ftypavi")) return "image/avif";
  return null;
}

function parseProperties(value: string): PageProperties {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return normalizeProperties(parsed as PageProperties);
  } catch { return {}; }
}

function statusFilter(value: string): PageStatus | "all" {
  if (value === "all" || value === "draft" || value === "published" || value === "archived") return value;
  throw new AppError("invalid_status", "status must be draft, published, archived, or all", 400);
}

function ftsQuery(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

function excerpt(body: string): string {
  const plain = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, alias: string, label?: string) => label ?? alias).replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > 180 ? `${plain.slice(0, 177)}…` : plain;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mapDatabaseError(error: unknown, alias: string): Error {
  if (String(error).includes("UNIQUE constraint failed: pages.alias")) {
    return new AppError("alias_conflict", `alias '${alias}' already exists`, 409);
  }
  return error instanceof Error ? error : new Error(String(error));
}
