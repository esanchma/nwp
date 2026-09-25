import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { DocumentRagConfig, SemanticSearchConfig } from "./config.ts";
import type { PageStore } from "./database.ts";
import { compareRevision } from "./history.ts";
import type { Attachment } from "./domain.ts";
import { exportPageMarkdown, importPageMarkdown } from "./transfer.ts";
import { hybridSearch, OllamaEmbedder } from "./semantic.ts";
import { ocrRuntimeStatus } from "./documents.ts";

export function createMcpHandler(store: PageStore, semanticConfig?: SemanticSearchConfig, documentConfig?: DocumentRagConfig): (request: Request) => Promise<Response> {
  return async (request) => {
    const server = createServer(store, semanticConfig, documentConfig);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 2 * 1024 * 1024 + 64 * 1024,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

function createServer(store: PageStore, semanticConfig?: SemanticSearchConfig, documentConfig?: DocumentRagConfig): McpServer {
  const embedder = semanticConfig?.enabled ? new OllamaEmbedder(semanticConfig) : null;
  const server = new McpServer({ name: "nwp", version: "0.11.0" });
  const statusSchema = z.enum(["draft", "published", "archived"]);
  const statusFilterSchema = z.enum(["draft", "published", "archived", "all"]);
  const propertiesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

  server.registerTool(
    "create_page",
    {
      description: "Create a wiki page",
      inputSchema: {
        title: z.string(),
        alias: z.string().optional(),
        body: z.string().default(""),
        tags: z.array(z.string()).default([]),
        status: statusSchema.default("published"),
        parent_id: z.number().int().positive().nullable().default(null),
        properties: propertiesSchema.default({}),
      },
    },
    async ({ parent_id, ...input }) => toolResult(store.create({ ...input, parentId: parent_id }, "mcp")),
  );

  server.registerTool(
    "get_page",
    {
      description: "Get a wiki page by integer ID or alias",
      inputSchema: { id: z.number().int().positive().optional(), alias: z.string().optional() },
    },
    async ({ id, alias }) => {
      if (id === undefined && alias === undefined) throw new Error("id or alias is required");
      return toolResult(id === undefined ? store.getByAlias(alias!) : store.getById(id));
    },
  );

  server.registerTool(
    "list_pages",
    {
      description: "List wiki pages using cursor pagination",
      inputSchema: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50), status: statusFilterSchema.default("published") },
    },
    async ({ cursor, limit, status }) => toolResult(store.list(cursor ?? null, limit, status)),
  );

  server.registerTool(
    "search_pages",
    {
      description: "Search page titles, aliases, Markdown bodies, and tags; every supplied tag must match",
      inputSchema: {
        query: z.string().default(""),
        tags: z.array(z.string()).default([]),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        status: statusFilterSchema.default("published"),
        properties: propertiesSchema.default({}),
        mode: z.enum(["hybrid", "lexical"]).default("hybrid"),
      },
    },
    async ({ query, tags, cursor, limit, status, properties, mode }) => {
      if (mode === "lexical" || !query.trim() || !embedder) return toolResult({ ...store.search(query, tags, cursor ?? null, limit, status, properties), mode: "lexical", ...(!embedder && mode === "hybrid" ? { warning: "Semantic search is disabled." } : {}) });
      const semanticState = store.semanticStatus(true, semanticConfig!.embeddingModel, semanticConfig!.embeddingDimensions);
      if (!semanticState.vectorAvailable || semanticState.indexedPages === 0) return toolResult({ ...store.search(query, tags, cursor ?? null, limit, status, properties), mode: "lexical", warning: "Semantic index is unavailable or empty." });
      try { return toolResult(await hybridSearch(store, embedder, query, tags, cursor ?? null, limit, status, properties)); }
      catch (error) { return toolResult({ ...store.search(query, tags, null, limit, status, properties), mode: "lexical", warning: `Semantic search unavailable: ${error instanceof Error ? error.message : String(error)}` }); }
    },
  );

  server.registerTool(
    "get_page_tree",
    {
      description: "List pages in parent-child tree order",
      inputSchema: { status: statusFilterSchema.default("published") },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => toolResult({ pages: store.tree(status) }),
  );

  server.registerTool(
    "list_tag_definitions",
    { description: "List canonical tags, kinds, aliases, and usage counts", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => toolResult({ tags: store.listTagDefinitions() }),
  );

  server.registerTool(
    "define_tag",
    {
      description: "Create or update a canonical tag and its aliases",
      inputSchema: { tag: z.string(), kind: z.enum(["topic", "entity", "source", "type", "custom"]), display_name: z.string(), aliases: z.array(z.string()).default([]), description: z.string().nullable().default(null) },
    },
    async ({ tag, kind, display_name, aliases, description }) => toolResult(store.defineTag(tag, kind, display_name, aliases, description)),
  );

  server.registerTool(
    "semantic_index_status",
    { description: "Get semantic indexing availability and queue status", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => toolResult(store.semanticStatus(semanticConfig?.enabled ?? false, semanticConfig?.embeddingModel ?? "", semanticConfig?.embeddingDimensions ?? 0)),
  );

  server.registerTool(
    "document_ocr_status",
    { description: "Check local Tesseract languages and PDF renderer availability", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => toolResult(documentConfig ? await ocrRuntimeStatus(documentConfig) : { enabled: false, available: false, pdfRendererAvailable: false }),
  );

  server.registerTool(
    "list_documents",
    { description: "List imported document metadata and extraction status", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => toolResult({ documents: store.listDocuments() }),
  );

  server.registerTool(
    "get_document",
    { description: "Get document metadata and retained versions", inputSchema: { document_id: z.number().int().positive() }, annotations: { readOnlyHint: true } },
    async ({ document_id }) => toolResult({ document: store.getDocument(document_id), versions: store.listDocumentVersions(document_id) }),
  );

  server.registerTool(
    "get_document_content",
    { description: "Get paginated structured document sections with precise source locators", inputSchema: { document_id: z.number().int().positive(), version_id: z.number().int().positive().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }, annotations: { readOnlyHint: true } },
    async ({ document_id, version_id, offset, limit }) => {
      const sections = store.documentSections(document_id, version_id, offset, limit);
      const nextOffset = offset + sections.length < store.documentSectionCount(document_id, version_id) ? offset + sections.length : null;
      return toolResult({ sections, nextOffset });
    },
  );

  server.registerTool(
    "cancel_document_extraction",
    { description: "Cancel queued or running document extraction", inputSchema: { document_id: z.number().int().positive() } },
    async ({ document_id }) => toolResult(store.cancelDocument(document_id)),
  );

  server.registerTool(
    "retry_document_extraction",
    { description: "Retry failed or cancelled document extraction", inputSchema: { document_id: z.number().int().positive() } },
    async ({ document_id }) => toolResult(store.retryDocument(document_id)),
  );

  server.registerTool(
    "acknowledge_document_review",
    { description: "Accept the current human page fields as the reviewed managed baseline", inputSchema: { document_id: z.number().int().positive() } },
    async ({ document_id }) => toolResult(store.acknowledgeDocumentReview(document_id)),
  );

  server.registerTool(
    "get_document_upload_instructions",
    { description: "Get the REST request needed to import or explicitly replace a binary document", inputSchema: { filename: z.string().min(1), document_id: z.number().int().positive().optional() }, annotations: { readOnlyHint: true } },
    async ({ filename, document_id }) => toolResult({ method: "POST", url: document_id ? `/api/v1/documents/${document_id}/versions?filename=${encodeURIComponent(filename)}` : `/api/v1/documents?filename=${encodeURIComponent(filename)}`, authentication: "Bearer token", body: "raw file bytes" }),
  );

  server.registerTool(
    "export_page",
    {
      description: "Export one page as Markdown with generated YAML front matter",
      inputSchema: { id: z.number().int().positive().optional(), alias: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ id, alias }) => {
      if (id === undefined && alias === undefined) throw new Error("id or alias is required");
      const page = id === undefined ? store.getByAlias(alias!) : store.getById(id);
      return toolResult({ filename: `${page.alias}.md`, markdown: exportPageMarkdown(page) });
    },
  );

  server.registerTool(
    "import_page",
    {
      description: "Import one Markdown document with nwp YAML front matter; alias collisions receive a suffix",
      inputSchema: { markdown: z.string() },
    },
    async ({ markdown }) => toolResult(importPageMarkdown(store, markdown, "mcp")),
  );

  server.registerTool(
    "get_full_export",
    {
      description: "Get the authenticated REST URL for a complete tar.gz wiki export",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => toolResult({ method: "GET", url: "/api/v1/export", authentication: "Bearer token", contentType: "application/gzip" }),
  );

  server.registerTool(
    "list_attachments",
    {
      description: "List attachment metadata and local content URLs for a page",
      inputSchema: { page_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id }) => toolResult({ attachments: store.listAttachments(page_id).map(attachmentMetadata) }),
  );

  server.registerTool(
    "get_attachment",
    {
      description: "Get attachment metadata and local content URLs",
      inputSchema: { attachment_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ attachment_id }) => toolResult(attachmentMetadata(store.getAttachment(attachment_id))),
  );

  server.registerTool(
    "get_attachment_upload_instructions",
    {
      description: "Get the REST request needed to upload binary attachment content",
      inputSchema: { page_id: z.number().int().positive(), filename: z.string().min(1), mime_type: z.string().default("application/octet-stream") },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, filename, mime_type }) => {
      store.getById(page_id);
      return toolResult({ method: "POST", url: `/api/v1/pages/${page_id}/attachments?filename=${encodeURIComponent(filename)}`, headers: { "Content-Type": mime_type }, authentication: "Bearer token", body: "raw file bytes" });
    },
  );

  server.registerTool(
    "delete_attachment",
    {
      description: "Remove an attachment association and delete unreferenced content",
      inputSchema: { attachment_id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    async ({ attachment_id }) => toolResult(attachmentMetadata(store.removeAttachment(attachment_id))),
  );

  server.registerTool(
    "delete_page",
    {
      description: "Move a page to trash and release its alias",
      inputSchema: { page_id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    async ({ page_id }) => toolResult(store.deletePage(page_id)),
  );

  server.registerTool(
    "list_trash",
    {
      description: "List pages in trash",
      inputSchema: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) },
      annotations: { readOnlyHint: true },
    },
    async ({ cursor, limit }) => toolResult(store.listTrash(cursor ?? null, limit)),
  );

  server.registerTool(
    "get_deleted_page",
    {
      description: "Read a page in trash by integer ID",
      inputSchema: { page_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id }) => toolResult(store.getDeletedById(page_id)),
  );

  server.registerTool(
    "restore_page",
    {
      description: "Restore a page from trash; generates another alias if the old one is occupied",
      inputSchema: { page_id: z.number().int().positive() },
    },
    async ({ page_id }) => toolResult(store.restoreDeleted(page_id)),
  );

  server.registerTool(
    "purge_page",
    {
      description: "Permanently purge a page and all its revisions from trash",
      inputSchema: { page_id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    async ({ page_id }) => {
      store.purgeDeleted(page_id);
      return toolResult({ purged: true, pageId: page_id });
    },
  );

  server.registerTool(
    "list_revisions",
    {
      description: "List stored revision snapshots for a page",
      inputSchema: {
        page_id: z.number().int().positive(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ page_id, cursor, limit }) => toolResult(store.listRevisions(page_id, cursor ?? null, limit)),
  );

  server.registerTool(
    "get_revision_diff",
    {
      description: "Compare a stored page revision with the current page",
      inputSchema: { page_id: z.number().int().positive(), revision_id: z.number().int().positive() },
    },
    async ({ page_id, revision_id }) => toolResult(compareRevision(store.getRevision(page_id, revision_id), store.getById(page_id))),
  );

  server.registerTool(
    "restore_revision",
    {
      description: "Restore a stored revision while preserving the current state as a new revision",
      inputSchema: { page_id: z.number().int().positive(), revision_id: z.number().int().positive() },
    },
    async ({ page_id, revision_id }) => toolResult(store.restoreRevision(page_id, revision_id, "mcp")),
  );

  server.registerTool(
    "update_page",
    {
      description: "Update a wiki page by integer ID",
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().optional(),
        alias: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        status: statusSchema.optional(),
        parent_id: z.number().int().positive().nullable().optional(),
        properties: propertiesSchema.optional(),
      },
    },
    async ({ id, parent_id, ...changes }) => toolResult(store.update(id, { ...changes, ...(parent_id === undefined ? {} : { parentId: parent_id }) }, "mcp")),
  );

  return server;
}

function attachmentMetadata(attachment: Attachment) {
  const url = `/attachments/${attachment.id}/${encodeURIComponent(attachment.filename)}`;
  return { ...attachment, url, downloadUrl: `${url}?download=1` };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}
