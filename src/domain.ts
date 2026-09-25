import { z } from "zod";

export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_TAGS = 50;

const aliasPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const titleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
const aliasSchema = z.string().trim().max(200);
const bodySchema = z.string().refine((value) => Buffer.byteLength(value) <= MAX_BODY_BYTES, "body is too large");
const tagsSchema = z.array(z.string()).max(MAX_TAGS);
export const pageStatusSchema = z.enum(["draft", "published", "archived"]);
const propertyValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const propertiesSchema = z.record(z.string(), propertyValueSchema);

export const pageInputSchema = z.object({
  title: titleSchema,
  alias: aliasSchema.optional(),
  body: bodySchema.default(""),
  tags: tagsSchema.default([]),
  status: pageStatusSchema.default("published"),
  parentId: z.number().int().positive().nullable().default(null),
  properties: propertiesSchema.default({}),
});

export const pageUpdateSchema = z.object({
  title: titleSchema.optional(),
  alias: aliasSchema.optional(),
  body: bodySchema.optional(),
  tags: tagsSchema.optional(),
  status: pageStatusSchema.optional(),
  parentId: z.number().int().positive().nullable().optional(),
  properties: propertiesSchema.optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), "at least one field is required");

export type PageInput = z.input<typeof pageInputSchema>;
export type PageUpdate = z.input<typeof pageUpdateSchema>;
export type ChangeSource = "web" | "cli" | "rest" | "mcp";
export type PageStatus = z.infer<typeof pageStatusSchema>;
export type PropertyValue = string | number | boolean | null;
export type PageProperties = Record<string, PropertyValue>;

export interface Page {
  id: number;
  title: string;
  alias: string;
  body: string;
  tags: string[];
  status: PageStatus;
  parentId: number | null;
  properties: PageProperties;
  breadcrumbs: PageReference[];
  backlinks: PageReference[];
  createdAt: string;
  updatedAt: string;
}

export interface PageReference {
  id: number;
  title: string;
  alias: string;
}

export interface DeletedPage extends Page {
  deletedAt: string;
}

export interface TrashList {
  pages: DeletedPage[];
  nextCursor: string | null;
}

export interface Attachment {
  id: number;
  pageId: number;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  inlineSafe: boolean;
  createdAt: string;
}

export interface PageSummary extends PageReference {
  tags: string[];
  status: PageStatus;
  parentId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PageList {
  pages: PageSummary[];
  nextCursor: string | null;
}

export interface SearchResult extends PageSummary {
  excerpt: string;
}

export interface SearchResults {
  pages: SearchResult[];
  nextCursor: string | null;
  mode?: "lexical" | "hybrid";
  warning?: string;
}

export interface RevisionSummary {
  id: number;
  pageId: number;
  title: string;
  alias: string;
  tags: string[];
  status: PageStatus;
  parentId: number | null;
  properties: PageProperties;
  source: ChangeSource;
  createdAt: string;
}

export interface Revision extends RevisionSummary {
  body: string;
}

export interface RevisionList {
  revisions: RevisionSummary[];
  nextCursor: string | null;
}

export interface TreeEntry extends PageReference {
  status: PageStatus;
  parentId: number | null;
  depth: number;
}

export type TagKind = "topic" | "entity" | "source" | "type" | "custom";

export interface TagDefinition {
  tag: string;
  kind: TagKind;
  displayName: string;
  description: string | null;
  createdBy: "human" | "model" | "migration";
  aliases: string[];
  usageCount: number;
  createdAt: string;
}

export type DocumentFormat = "docx" | "xlsx" | "pptx" | "pdf" | "markdown" | "text";
export type DocumentStatus = "queued" | "extracting" | "ready" | "failed" | "cancelled";
export type DocumentVersionStatus = DocumentStatus | "superseded";
export type DocumentSectionKind = "heading" | "paragraph" | "table" | "slide" | "notes" | "sheet" | "page" | "image" | "text";
export type OcrStatus = "not_required" | "pending" | "completed" | "partial" | "unavailable";

export interface DocumentLocator {
  label: string;
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  heading?: string;
  image?: string;
  part?: string;
}

export interface DocumentSection {
  id: number;
  documentVersionId: number;
  ordinal: number;
  kind: DocumentSectionKind;
  title: string | null;
  locator: DocumentLocator;
  text: string;
  hidden: boolean;
  needsOcr: boolean;
}

export interface DocumentVersion {
  id: number;
  documentId: number;
  version: number;
  sha256: string;
  size: number;
  status: DocumentVersionStatus;
  parserVersion: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ocrStatus: OcrStatus;
  warnings: string[];
  createdAt: string;
  extractedAt: string | null;
}

export interface DocumentRecord {
  id: number;
  pageId: number;
  filename: string;
  mimeType: string;
  format: DocumentFormat;
  status: DocumentStatus;
  needsOcr: boolean;
  ocrStatus: OcrStatus;
  needsReview: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersion: DocumentVersion;
}

export interface SemanticStatus {
  enabled: boolean;
  vectorAvailable: boolean;
  model: string;
  dimensions: number;
  pendingPages: number;
  indexedPages: number;
  lastError: string | null;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180)
    .replace(/-+$/g, "");
  return slug || "page";
}

export function validateAlias(value: string): string {
  const alias = normalizeAlias(value);
  if (!aliasPattern.test(alias) || alias.length > 200) {
    throw new AppError("invalid_alias", "alias must contain lowercase ASCII letters, numbers, and single hyphens", 400);
  }
  return alias;
}

export function normalizeTags(values: string[]): string[] {
  const tags = [...new Set(values.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > MAX_TAGS) throw new AppError("invalid_tags", `a page may have at most ${MAX_TAGS} tags`, 400);
  for (const tag of tags) {
    if (tag.length > 60) throw new AppError("invalid_tags", "tags may not exceed 60 characters", 400);
  }
  return tags.sort();
}

export function normalizeProperties(values: PageProperties): PageProperties {
  const result: PageProperties = {};
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(key)) {
      throw new AppError("invalid_properties", `property key '${rawKey}' is invalid`, 400);
    }
    if (Object.hasOwn(result, key)) throw new AppError("invalid_properties", `duplicate property key '${key}'`, 400);
    if (typeof value === "string" && value.length > 2000) throw new AppError("invalid_properties", `property '${key}' is too long`, 400);
    if (typeof value === "number" && !Number.isFinite(value)) throw new AppError("invalid_properties", `property '${key}' must be finite`, 400);
    result[key] = value;
  }
  if (Object.keys(result).length > 100) throw new AppError("invalid_properties", "a page may have at most 100 properties", 400);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export function extractWikiLinks(markdown: string): string[] {
  const aliases = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const candidate = normalizeAlias(match[1] ?? "");
    if (aliasPattern.test(candidate)) aliases.add(candidate);
  }
  return [...aliases];
}

export function encodeCursor(id: number): string {
  return Buffer.from(String(id), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) throw new Error();
    const id = Number(decoded);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error();
    return id;
  } catch {
    throw new AppError("invalid_cursor", "cursor is invalid", 400);
  }
}

export function encodeSearchCursor(offset: number): string {
  return Buffer.from(`search:${offset}`, "utf8").toString("base64url");
}

export function decodeSearchCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^search:(\d+)$/.exec(decoded);
    if (!match) throw new Error();
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error();
    return offset;
  } catch {
    throw new AppError("invalid_cursor", "search cursor is invalid", 400);
  }
}
