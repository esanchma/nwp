const json = (schema: object) => ({ "application/json": { schema } });
const response = (description: string, schema: object) => ({ description, content: json(schema) });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponses = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" },
  "413": { $ref: "#/components/responses/TooLarge" },
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "nwp JSON API",
    version: "0.8.1",
    description: "Local API for nano-wiki-pi. SQLite metadata is authoritative and every endpoint requires the generated Bearer token.",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{ url: "/api/v1", description: "Current nwp server" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Pages" }, { name: "Search" }, { name: "History" }, { name: "Trash" },
    { name: "Attachments" }, { name: "Transfer" }, { name: "Contract" },
  ],
  paths: {
    "/openapi.json": {
      get: {
        tags: ["Contract"], operationId: "getOpenApiDocument", summary: "Download this OpenAPI document",
        responses: { "200": response("OpenAPI 3.1 document", { type: "object" }), "401": errorResponses["401"] },
      },
    },
    "/pages": {
      get: {
        tags: ["Pages"], operationId: "listPages", summary: "List pages",
        parameters: [{ $ref: "#/components/parameters/Cursor" }, { $ref: "#/components/parameters/Limit" }, { $ref: "#/components/parameters/StatusFilter" }],
        responses: { "200": response("Page list", ref("PageList")), ...errorResponses },
      },
      post: {
        tags: ["Pages"], operationId: "createPage", summary: "Create a page",
        requestBody: { required: true, content: json(ref("PageInput")) },
        responses: { "201": response("Created page", ref("Page")), ...errorResponses },
      },
    },
    "/pages/{pageKey}": {
      parameters: [{ $ref: "#/components/parameters/PageKey" }],
      get: { tags: ["Pages"], operationId: "getPage", summary: "Get a page by ID or alias", responses: { "200": response("Page", ref("Page")), ...errorResponses } },
      put: {
        tags: ["Pages"], operationId: "updatePage", summary: "Update a page by numeric ID",
        requestBody: { required: true, content: json(ref("PageUpdate")) },
        responses: { "200": response("Updated page", ref("Page")), ...errorResponses },
      },
      delete: { tags: ["Trash"], operationId: "deletePage", summary: "Move a page to trash by numeric ID", responses: { "200": response("Deleted page", ref("DeletedPage")), ...errorResponses } },
    },
    "/search": {
      get: {
        tags: ["Search"], operationId: "searchPages", summary: "Search page text, tags, state, and scalar properties",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "tags", in: "query", description: "Comma-separated tags with AND semantics", schema: { type: "string" } },
          { name: "properties", in: "query", description: "JSON object of exact typed property filters", schema: { type: "string" } },
          { $ref: "#/components/parameters/StatusFilter" }, { $ref: "#/components/parameters/Cursor" }, { $ref: "#/components/parameters/Limit" },
        ],
        responses: { "200": response("Search results", ref("SearchResults")), ...errorResponses },
      },
    },
    "/tree": {
      get: {
        tags: ["Pages"], operationId: "getPageTree", summary: "Get the flattened page tree",
        parameters: [{ $ref: "#/components/parameters/StatusFilter" }],
        responses: { "200": response("Tree entries", { type: "object", required: ["pages"], properties: { pages: { type: "array", items: ref("TreeEntry") } } }), ...errorResponses },
      },
    },
    "/pages/{pageId}/revisions": {
      parameters: [{ $ref: "#/components/parameters/PageId" }],
      get: {
        tags: ["History"], operationId: "listRevisions", summary: "List revision snapshots",
        parameters: [{ $ref: "#/components/parameters/Cursor" }, { $ref: "#/components/parameters/Limit" }],
        responses: { "200": response("Revision list", ref("RevisionList")), ...errorResponses },
      },
    },
    "/pages/{pageId}/revisions/{revisionId}": {
      parameters: [{ $ref: "#/components/parameters/PageId" }, { $ref: "#/components/parameters/RevisionId" }],
      get: { tags: ["History"], operationId: "getRevision", summary: "Get a complete revision snapshot", responses: { "200": response("Revision", ref("Revision")), ...errorResponses } },
    },
    "/pages/{pageId}/revisions/{revisionId}/diff": {
      parameters: [{ $ref: "#/components/parameters/PageId" }, { $ref: "#/components/parameters/RevisionId" }],
      get: { tags: ["History"], operationId: "getRevisionDiff", summary: "Compare a revision with the current page", responses: { "200": response("Side-by-side diff", ref("RevisionDiff")), ...errorResponses } },
    },
    "/pages/{pageId}/revisions/{revisionId}/restore": {
      parameters: [{ $ref: "#/components/parameters/PageId" }, { $ref: "#/components/parameters/RevisionId" }],
      post: { tags: ["History"], operationId: "restoreRevision", summary: "Restore a revision after snapshotting current state", responses: { "200": response("Restored page", ref("Page")), ...errorResponses } },
    },
    "/trash": {
      get: {
        tags: ["Trash"], operationId: "listTrash", summary: "List soft-deleted pages",
        parameters: [{ $ref: "#/components/parameters/Cursor" }, { $ref: "#/components/parameters/Limit" }],
        responses: { "200": response("Trash list", ref("TrashList")), ...errorResponses },
      },
    },
    "/trash/{pageId}": {
      parameters: [{ $ref: "#/components/parameters/PageId" }],
      get: { tags: ["Trash"], operationId: "getDeletedPage", summary: "Get a deleted page", responses: { "200": response("Deleted page", ref("DeletedPage")), ...errorResponses } },
      delete: { tags: ["Trash"], operationId: "purgePage", summary: "Permanently purge a deleted page", responses: { "204": { description: "Page permanently removed" }, ...errorResponses } },
    },
    "/trash/{pageId}/restore": {
      parameters: [{ $ref: "#/components/parameters/PageId" }],
      post: { tags: ["Trash"], operationId: "restoreDeletedPage", summary: "Restore a deleted page with collision-safe aliasing", responses: { "200": response("Restored page", ref("Page")), ...errorResponses } },
    },
    "/pages/{pageId}/attachments": {
      parameters: [{ $ref: "#/components/parameters/PageId" }],
      get: { tags: ["Attachments"], operationId: "listAttachments", summary: "List page attachments", responses: { "200": response("Attachment list", { type: "object", required: ["attachments"], properties: { attachments: { type: "array", items: ref("AttachmentWithUrls") } } }), ...errorResponses } },
      post: {
        tags: ["Attachments"], operationId: "uploadAttachment", summary: "Upload raw attachment bytes",
        parameters: [{ name: "filename", in: "query", required: true, schema: { type: "string", minLength: 1 } }],
        requestBody: { required: true, content: { "*/*": { schema: { type: "string", format: "binary" } } } },
        responses: { "201": response("Created attachment", ref("AttachmentWithUrls")), ...errorResponses },
      },
    },
    "/attachments/{attachmentId}": {
      parameters: [{ $ref: "#/components/parameters/AttachmentId" }],
      get: { tags: ["Attachments"], operationId: "getAttachment", summary: "Get attachment metadata", responses: { "200": response("Attachment metadata", ref("AttachmentWithUrls")), ...errorResponses } },
      delete: { tags: ["Attachments"], operationId: "deleteAttachment", summary: "Delete an attachment association", responses: { "200": response("Removed attachment", ref("AttachmentWithUrls")), ...errorResponses } },
    },
    "/attachments/{attachmentId}/content": {
      parameters: [{ $ref: "#/components/parameters/AttachmentId" }],
      get: {
        tags: ["Attachments"], operationId: "downloadAttachment", summary: "Read attachment bytes",
        parameters: [{ name: "download", in: "query", description: "Force download disposition", schema: { type: "boolean", default: false } }],
        responses: { "200": { description: "Attachment bytes", content: { "*/*": { schema: { type: "string", format: "binary" } } } }, ...errorResponses },
      },
    },
    "/pages/{pageId}/export": {
      parameters: [{ $ref: "#/components/parameters/PageId" }],
      get: { tags: ["Transfer"], operationId: "exportPage", summary: "Export one page as Markdown with YAML front matter", responses: { "200": { description: "Portable page", content: { "text/markdown": { schema: { type: "string" } } } }, ...errorResponses } },
    },
    "/import/pages": {
      post: {
        tags: ["Transfer"], operationId: "importPage", summary: "Import Markdown with nwp YAML front matter",
        requestBody: { required: true, content: { "text/markdown": { schema: { type: "string" } }, "text/plain": { schema: { type: "string" } } } },
        responses: { "201": response("Imported page", ref("Page")), ...errorResponses },
      },
    },
    "/export": {
      get: { tags: ["Transfer"], operationId: "exportWiki", summary: "Stream a complete wiki tar.gz archive", responses: { "200": { description: "Complete archive", content: { "application/gzip": { schema: { type: "string", format: "binary" } } } }, ...errorResponses } },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" } },
    parameters: {
      PageKey: { name: "pageKey", in: "path", required: true, description: "Numeric page ID or alias", schema: { type: "string" } },
      PageId: { name: "pageId", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
      RevisionId: { name: "revisionId", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
      AttachmentId: { name: "attachmentId", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
      Cursor: { name: "cursor", in: "query", schema: { type: "string" } },
      Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      StatusFilter: { name: "status", in: "query", schema: { type: "string", enum: ["draft", "published", "archived", "all"], default: "published" } },
    },
    responses: {
      BadRequest: response("Invalid request", ref("Error")), Unauthorized: response("Missing or invalid Bearer token", ref("Error")),
      NotFound: response("Resource not found", ref("Error")), Conflict: response("Resource conflict", ref("Error")), TooLarge: response("Request exceeds configured limits", ref("Error")),
    },
    schemas: {
      PageStatus: { type: "string", enum: ["draft", "published", "archived"] },
      Scalar: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
      Properties: { type: "object", propertyNames: { pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }, additionalProperties: ref("Scalar") },
      PageReference: { type: "object", required: ["id", "title", "alias"], properties: { id: { type: "integer" }, title: { type: "string" }, alias: { type: "string" } } },
      PageSummary: {
        allOf: [ref("PageReference"), { type: "object", required: ["tags", "status", "parentId", "createdAt", "updatedAt"], properties: {
          tags: { type: "array", items: { type: "string" } }, status: ref("PageStatus"), parentId: { type: ["integer", "null"] }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
        } }],
      },
      Page: {
        allOf: [ref("PageSummary"), { type: "object", required: ["body", "properties", "breadcrumbs", "backlinks"], properties: {
          body: { type: "string" }, properties: ref("Properties"), breadcrumbs: { type: "array", items: ref("PageReference") }, backlinks: { type: "array", items: ref("PageReference") },
        } }],
      },
      DeletedPage: { allOf: [ref("Page"), { type: "object", required: ["deletedAt"], properties: { deletedAt: { type: "string", format: "date-time" } } }] },
      PageInput: { type: "object", required: ["title"], additionalProperties: false, properties: {
        title: { type: "string", minLength: 1, maxLength: 200 }, alias: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string" }, tags: { type: "array", items: { type: "string" } }, status: ref("PageStatus"), parentId: { type: ["integer", "null"] }, properties: ref("Properties"),
      } },
      PageUpdate: { type: "object", minProperties: 1, additionalProperties: false, properties: {
        title: { type: "string", minLength: 1, maxLength: 200 }, alias: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string" }, tags: { type: "array", items: { type: "string" } }, status: ref("PageStatus"), parentId: { type: ["integer", "null"] }, properties: ref("Properties"),
      } },
      PageList: { type: "object", required: ["pages", "nextCursor"], properties: { pages: { type: "array", items: ref("PageSummary") }, nextCursor: { type: ["string", "null"] } } },
      SearchResult: { allOf: [ref("PageSummary"), { type: "object", required: ["excerpt"], properties: { excerpt: { type: "string" } } }] },
      SearchResults: { type: "object", required: ["pages", "nextCursor"], properties: { pages: { type: "array", items: ref("SearchResult") }, nextCursor: { type: ["string", "null"] } } },
      TreeEntry: { allOf: [ref("PageReference"), { type: "object", required: ["status", "parentId", "depth"], properties: { status: ref("PageStatus"), parentId: { type: ["integer", "null"] }, depth: { type: "integer", minimum: 0 } } }] },
      RevisionSummary: { type: "object", required: ["id", "pageId", "title", "alias", "tags", "status", "parentId", "properties", "source", "createdAt"], properties: {
        id: { type: "integer" }, pageId: { type: "integer" }, title: { type: "string" }, alias: { type: "string" }, tags: { type: "array", items: { type: "string" } }, status: ref("PageStatus"), parentId: { type: ["integer", "null"] }, properties: ref("Properties"), source: { type: "string", enum: ["web", "api", "cli", "mcp"] }, createdAt: { type: "string", format: "date-time" },
      } },
      Revision: { allOf: [ref("RevisionSummary"), { type: "object", required: ["body"], properties: { body: { type: "string" } } }] },
      RevisionList: { type: "object", required: ["revisions", "nextCursor"], properties: { revisions: { type: "array", items: ref("RevisionSummary") }, nextCursor: { type: ["string", "null"] } } },
      RevisionDiff: { type: "object", required: ["revisionId", "pageId", "from", "to", "metadataChanged", "body"], properties: {
        revisionId: { type: "integer" }, pageId: { type: "integer" }, from: { type: "object" }, to: { type: "object" }, metadataChanged: { type: "boolean" }, body: { type: "array", items: { type: "object", required: ["left", "right", "leftKind", "rightKind"], properties: { left: { type: ["string", "null"] }, right: { type: ["string", "null"] }, leftKind: { type: "string", enum: ["same", "removed", "blank"] }, rightKind: { type: "string", enum: ["same", "added", "blank"] } } } },
      } },
      TrashList: { type: "object", required: ["pages", "nextCursor"], properties: { pages: { type: "array", items: ref("DeletedPage") }, nextCursor: { type: ["string", "null"] } } },
      Attachment: { type: "object", required: ["id", "pageId", "filename", "mimeType", "size", "sha256", "inlineSafe", "createdAt"], properties: {
        id: { type: "integer" }, pageId: { type: "integer" }, filename: { type: "string" }, mimeType: { type: "string" }, size: { type: "integer", minimum: 0 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, inlineSafe: { type: "boolean" }, createdAt: { type: "string", format: "date-time" },
      } },
      AttachmentWithUrls: { allOf: [ref("Attachment"), { type: "object", required: ["contentUrl", "downloadUrl"], properties: { contentUrl: { type: "string" }, downloadUrl: { type: "string" } } }] },
      Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } } },
    },
  },
} as const;

export function openApiJson(): string {
  return `${JSON.stringify(openApiDocument, null, 2)}\n`;
}
