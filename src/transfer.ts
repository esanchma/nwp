import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { parse, stringify } from "yaml";
import type { PageStore } from "./database.ts";
import { AppError, type ChangeSource, type DeletedPage, type Page, type PageInput, type PageProperties, type PageStatus, type Revision } from "./domain.ts";

interface FrontMatter {
  nwp: number;
  title: string;
  alias: string;
  tags: string[];
  status: PageStatus;
  parent?: string;
  parent_id?: number;
  properties: PageProperties;
  created_at?: string;
  updated_at?: string;
  revision_id?: number;
  source?: string;
  deleted_at?: string;
}

export function exportPageMarkdown(page: Page | DeletedPage): string {
  const parent = page.breadcrumbs.at(-1)?.alias;
  const frontMatter: FrontMatter = {
    nwp: 1,
    title: page.title,
    alias: page.alias,
    tags: page.tags,
    status: page.status,
    ...(parent ? { parent } : {}),
    ...(page.parentId !== null ? { parent_id: page.parentId } : {}),
    properties: page.properties,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
    ...("deletedAt" in page ? { deleted_at: page.deletedAt } : {}),
  };
  return markdownDocument(frontMatter, page.body);
}

export function exportRevisionMarkdown(revision: Revision): string {
  return markdownDocument({
    nwp: 1,
    title: revision.title,
    alias: revision.alias,
    tags: revision.tags,
    status: revision.status,
    ...(revision.parentId !== null ? { parent_id: revision.parentId } : {}),
    properties: revision.properties,
    created_at: revision.createdAt,
    revision_id: revision.id,
    source: revision.source,
  }, revision.body);
}

export function importPageMarkdown(store: PageStore, markdown: string, source: ChangeSource): Page {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new AppError("front_matter_required", "Markdown import requires YAML front matter", 400);

  let raw: unknown;
  try { raw = parse(match[1]!, { maxAliasCount: 10 }); }
  catch { throw new AppError("invalid_front_matter", "YAML front matter is invalid", 400); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("invalid_front_matter", "front matter must be a mapping", 400);
  const data = raw as Record<string, unknown>;
  if (data.nwp !== undefined && data.nwp !== 1) throw new AppError("unsupported_import_version", "only nwp front matter version 1 is supported", 400);
  const title = requiredString(data.title, "title");
  const alias = optionalString(data.alias, "alias");
  const tags = stringArray(data.tags, "tags");
  const status = pageStatus(data.status);
  const properties = scalarProperties(data.properties);
  const parentAlias = optionalString(data.parent, "parent");
  let parentId: number | null = null;
  if (parentAlias) {
    try { parentId = store.getByAlias(parentAlias).id; }
    catch { parentId = null; }
  }

  const input: PageInput = {
    title,
    ...(alias ? { alias } : {}),
    body: markdown.slice(match[0].length),
    tags,
    status,
    parentId,
    properties,
  };
  return store.createImported(input, source);
}

export function createFullExport(store: PageStore): { stream: ReadableStream; filename: string } {
  const active = store.allActivePages();
  const trash = store.allDeletedPages();
  const revisions = store.allRevisions();
  const attachments = store.allAttachments();
  const documents = store.allDocuments();
  const documentVersions = store.allDocumentVersions();
  const taxonomy = store.listTagDefinitions();
  const generatedAt = new Date().toISOString();
  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });
  const output = pack.pipe(gzip);

  void (async () => {
    try {
      const manifest = {
        format: "nwp-export",
        version: 1,
        generatedAt,
        pages: active.map((page) => ({ id: page.id, alias: page.alias, path: `pages/${page.id}.md` })),
        trash: trash.map((page) => ({ id: page.id, alias: page.alias, deletedAt: page.deletedAt, path: `trash/${page.id}.md` })),
        revisions: revisions.map((revision) => ({ id: revision.id, pageId: revision.pageId, path: `history/${revision.pageId}/${revision.id}.md` })),
        attachments: attachments.map((attachment) => ({ ...attachment, path: `attachments/${attachment.sha256}` })),
        documents: documents.map((document) => ({ ...document, versions: documentVersions.filter((version) => version.documentId === document.id).map((version) => ({ ...version, path: `documents/${version.sha256}` })) })),
        taxonomy,
      };
      await addBuffer(pack, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
      for (const page of active) await addBuffer(pack, `pages/${page.id}.md`, exportPageMarkdown(page));
      for (const page of trash) await addBuffer(pack, `trash/${page.id}.md`, exportPageMarkdown(page));
      for (const revision of revisions) await addBuffer(pack, `history/${revision.pageId}/${revision.id}.md`, exportRevisionMarkdown(revision));
      for (const hash of new Set(attachments.map(({ sha256 }) => sha256))) {
        await addFile(pack, `attachments/${hash}`, store.attachmentFilePath(hash));
      }
      for (const hash of new Set(documentVersions.map(({ sha256 }) => sha256))) {
        await addFile(pack, `documents/${hash}`, store.attachmentFilePath(hash));
      }
      pack.finalize();
    } catch (error) {
      pack.destroy(error as Error);
    }
  })();

  return {
    stream: Readable.toWeb(output) as unknown as ReadableStream,
    filename: `nwp-export-${generatedAt.slice(0, 10)}.tar.gz`,
  };
}

function markdownDocument(frontMatter: FrontMatter, body: string): string {
  const yaml = stringify(frontMatter, { lineWidth: 0, sortMapEntries: true }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

function addBuffer(pack: tar.Pack, name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pack.entry({ name, mode: 0o600, mtime: new Date(0) }, Buffer.from(value), (error) => error ? reject(error) : resolve());
  });
}

function addFile(pack: tar.Pack, name: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = pack.entry({ name, mode: 0o600, mtime: new Date(0), size: statSync(path).size }, (error) => error ? reject(error) : resolve());
    const source = createReadStream(path);
    source.on("error", reject);
    entry.on("error", reject);
    source.pipe(entry);
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError("invalid_front_matter", `${field} must be a non-empty string`, 400);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AppError("invalid_front_matter", `${field} must be a string`, 400);
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new AppError("invalid_front_matter", `${field} must be a string array`, 400);
  return value;
}

function pageStatus(value: unknown): PageStatus {
  if (value === undefined) return "published";
  if (value === "draft" || value === "published" || value === "archived") return value;
  throw new AppError("invalid_front_matter", "status must be draft, published, or archived", 400);
}

function scalarProperties(value: unknown): PageProperties {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_front_matter", "properties must be a mapping", 400);
  const result: PageProperties = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new AppError("invalid_front_matter", `property '${key}' must be a scalar`, 400);
    }
    result[key] = item;
  }
  return result;
}
