import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { PageStore } from "../src/database.ts";
import { createRequestHandler } from "../src/server.ts";
import { DocumentWorker } from "../src/documents.ts";

let dir: string;
let store: PageStore;
let handler: (request: Request) => Promise<Response>;
const token = "a".repeat(43);

beforeEach(async () => {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "server-test-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 3000,
    dataDir: dir,
    dbPath: join(dir, "nwp.db"),
    tokenPath: join(dir, "api-token"),
    configPath: join(dir, "config.toml"),
    attachmentMaxBytes: null,
    semanticSearch: { enabled: false, ollamaUrl: "http://127.0.0.1:11434", embeddingModel: "bge-m3", embeddingDimensions: 1024, queryPrefix: "", chunkCharacters: 1600, chunkOverlap: 200 },
    documentRag: { enabled: true, maxFileBytes: 10_000_000, maxExpandedBytes: 50_000_000, maxArchiveEntries: 10_000, maxCompressionRatio: 1000, maxPdfPages: 10_000, maxSpreadsheetCells: 5_000_000, ocrEnabled: false, tesseractCommand: "tesseract", pdfRendererCommand: "pdftoppm", ocrLanguages: ["spa", "eng"], ocrTimeoutSeconds: 120, maxOcrItems: 10_000, maxOcrOutputCharacters: 1_000_000 },
  };
  store = new PageStore(config.dbPath);
  handler = await createRequestHandler(store, config, token);
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

function api(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return request(path, { ...init, headers });
}

describe("HTTP API", () => {
  test("requires a token", async () => {
    const response = await handler(request("/api/v1/pages"));
    expect(response.status).toBe(401);
  });

  test("serves the versioned OpenAPI contract", async () => {
    const apiDocument = await handler(api("/api/v1/openapi.json"));
    expect(apiDocument.status).toBe(200);
    expect(apiDocument.headers.get("content-type")).toContain("application/vnd.oai.openapi+json");
    expect((await apiDocument.json() as { openapi: string; info: { version: string } })).toMatchObject({ openapi: "3.1.0", info: { version: "0.11.0" } });
    const publicDocument = await handler(request("/openapi.json"));
    expect(publicDocument.status).toBe(200);
  });

  test("creates, reads, lists, and updates pages", async () => {
    const createdResponse = await handler(api("/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API Page", body: "one", tags: ["api"] }),
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: number; alias: string };

    expect((await handler(api(`/api/v1/pages/${created.alias}`))).status).toBe(200);
    const list = await (await handler(api("/api/v1/pages?limit=10"))).json() as { pages: unknown[] };
    expect(list.pages).toHaveLength(1);

    const updated = await handler(api(`/api/v1/pages/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "two" }),
    }));
    expect(updated.status).toBe(200);
    expect((await updated.json() as { body: string }).body).toBe("two");
  });

  test("imports, extracts, reads, and explicitly replaces documents", async () => {
    const ocr = await (await handler(api("/api/v1/documents/ocr/status"))).json() as { enabled: boolean; available: boolean };
    expect(ocr).toEqual(expect.objectContaining({ enabled: false, available: false }));
    const importedResponse = await handler(api("/api/v1/documents?filename=notes.txt", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "first source" }));
    expect(importedResponse.status).toBe(202);
    const imported = await importedResponse.json() as { id: number; pageId: number; status: string };
    expect(imported.status).toBe("queued");
    expect(await new DocumentWorker(store, { enabled: true, maxFileBytes: 10_000_000, maxExpandedBytes: 50_000_000, maxArchiveEntries: 10_000, maxCompressionRatio: 1000, maxPdfPages: 10_000, maxSpreadsheetCells: 5_000_000, ocrEnabled: false, tesseractCommand: "tesseract", pdfRendererCommand: "pdftoppm", ocrLanguages: ["spa", "eng"], ocrTimeoutSeconds: 120, maxOcrItems: 10_000, maxOcrOutputCharacters: 1_000_000 }).runUntilIdle()).toBe(1);
    const content = await (await handler(api(`/api/v1/documents/${imported.id}/content`))).json() as { sections: Array<{ text: string }> };
    expect(content.sections[0]?.text).toBe("first source");
    const viewer = await (await handler(request(`/documents/${imported.id}/content`))).text();
    expect(viewer).toContain(`id="section-0"`);
    expect(viewer).toContain("citation §1");
    expect((await handler(request(`/wiki/${store.getById(imported.pageId).alias}`))).status).toBe(200);

    const replaced = await handler(api(`/api/v1/documents/${imported.id}/versions?filename=notes-v2.txt`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "second source" }));
    expect(replaced.status).toBe(202);
    const versions = await (await handler(api(`/api/v1/documents/${imported.id}/versions`))).json() as { versions: unknown[] };
    expect(versions.versions).toHaveLength(2);
    store.update(imported.pageId, { body: "human summary" }, "web");
    await handler(api(`/api/v1/documents/${imported.id}/versions?filename=notes-v3.txt`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "third source" }));
    expect(store.getDocument(imported.id).needsReview).toBe(true);
    expect((await handler(api(`/api/v1/documents/${imported.id}/review`, { method: "POST" }))).status).toBe(200);
    expect(store.getDocument(imported.id).needsReview).toBe(false);

    const cancellable = await (await handler(api("/api/v1/documents?filename=cancel.txt", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "cancel me" }))).json() as { id: number };
    expect((await handler(api(`/api/v1/documents/${cancellable.id}/cancel`, { method: "POST" }))).status).toBe(200);
    expect(store.getDocument(cancellable.id).status).toBe("cancelled");
    expect((await handler(api(`/api/v1/documents/${cancellable.id}/retry`, { method: "POST" }))).status).toBe(200);
    expect(store.getDocument(cancellable.id).status).toBe("queued");
  });

  test("manages tag taxonomy and semantic status through the API", async () => {
    const defined = await handler(api("/api/v1/tags/definitions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "topic:ai", kind: "topic", displayName: "Artificial intelligence", aliases: ["ia"] }) }));
    expect(defined.status).toBe(201);
    const page = store.create({ title: "Tagged", body: "", tags: ["ia"] }, "web");
    expect(page.tags).toEqual(["topic:ai"]);
    const tags = await (await handler(api("/api/v1/tags/definitions"))).json() as { tags: Array<{ tag: string; usageCount: number }> };
    expect(tags.tags.find(({ tag }) => tag === "topic:ai")?.usageCount).toBe(1);
    const status = await (await handler(api("/api/v1/semantic/status"))).json() as { enabled: boolean; pendingPages: number };
    expect(status.enabled).toBe(false);
    expect(status.pendingPages).toBeGreaterThan(0);
  });

  test("searches through the API", async () => {
    store.create({ title: "Searchable", body: "A distinctive phrase", tags: ["docs"] }, "web");
    const response = await handler(api("/api/v1/search?q=distinctive&tags=docs"));
    expect(response.status).toBe(200);
    const results = await response.json() as { pages: Array<{ alias: string }> };
    expect(results.pages.map(({ alias }) => alias)).toEqual(["searchable"]);
  });

  test("filters status, properties, and hierarchy through the API", async () => {
    const parent = store.create({ title: "API Parent", body: "", tags: [] }, "web");
    const created = await handler(api("/api/v1/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API Draft", body: "metadata term", status: "draft", parentId: parent.id, properties: { owner: "agent", score: 4 } }),
    }));
    const page = await created.json() as { id: number; status: string; parentId: number };
    expect(page).toMatchObject({ status: "draft", parentId: parent.id });
    const defaults = await (await handler(api("/api/v1/pages"))).json() as { pages: Array<{ id: number }> };
    expect(defaults.pages.map(({ id }) => id)).not.toContain(page.id);
    const drafts = await (await handler(api("/api/v1/pages?status=draft"))).json() as { pages: Array<{ id: number }> };
    expect(drafts.pages.map(({ id }) => id)).toContain(page.id);
    const properties = encodeURIComponent(JSON.stringify({ owner: "agent" }));
    const search = await (await handler(api(`/api/v1/search?q=metadata&status=draft&properties=${properties}`))).json() as { pages: Array<{ id: number }> };
    expect(search.pages.map(({ id }) => id)).toEqual([page.id]);
    const tree = await (await handler(api("/api/v1/tree?status=all"))).json() as { pages: Array<{ id: number; depth: number }> };
    expect(tree.pages.find(({ id }) => id === page.id)?.depth).toBe(1);
  });

  test("lists, compares, and restores revisions through the API", async () => {
    const page = store.create({ title: "History", body: "before", tags: [] }, "web");
    store.update(page.id, { body: "after" }, "web");
    const history = await (await handler(api(`/api/v1/pages/${page.id}/revisions`))).json() as { revisions: Array<{ id: number }> };
    const revisionId = history.revisions[0]!.id;

    const diff = await (await handler(api(`/api/v1/pages/${page.id}/revisions/${revisionId}/diff`))).json() as { body: Array<{ left: string; right: string }> };
    expect(diff.body[0]).toMatchObject({ left: "before", right: "after" });

    const restored = await handler(api(`/api/v1/pages/${page.id}/revisions/${revisionId}/restore`, { method: "POST" }));
    expect(restored.status).toBe(200);
    expect((await restored.json() as { body: string }).body).toBe("before");
  });

  test("deletes, lists, restores, and purges trash through the API", async () => {
    const page = store.create({ title: "Trash API", body: "", tags: [] }, "web");
    expect((await handler(api(`/api/v1/pages/${page.id}`, { method: "DELETE" }))).status).toBe(200);
    const trash = await (await handler(api("/api/v1/trash"))).json() as { pages: Array<{ id: number }> };
    expect(trash.pages.map(({ id }) => id)).toContain(page.id);
    expect((await handler(api(`/api/v1/trash/${page.id}/restore`, { method: "POST" }))).status).toBe(200);

    store.deletePage(page.id);
    expect((await handler(api(`/api/v1/trash/${page.id}`, { method: "DELETE" }))).status).toBe(204);
    expect((await handler(api(`/api/v1/trash/${page.id}`))).status).toBe(404);
  });

  test("uploads, serves, lists, and deletes attachments through the API", async () => {
    const page = store.create({ title: "Files API", body: "", tags: [] }, "web");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const uploaded = await handler(api(`/api/v1/pages/${page.id}/attachments?filename=image.png`, {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: png,
    }));
    expect(uploaded.status).toBe(201);
    const attachment = await uploaded.json() as { id: number; mimeType: string; inlineSafe: boolean; url: string };
    expect(attachment).toMatchObject({ mimeType: "image/png", inlineSafe: true });

    const content = await handler(request(attachment.url));
    expect(content.headers.get("content-disposition")).toStartWith("inline");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(png);
    const listed = await (await handler(api(`/api/v1/pages/${page.id}/attachments`))).json() as { attachments: unknown[] };
    expect(listed.attachments).toHaveLength(1);
    expect((await handler(api(`/api/v1/attachments/${attachment.id}`, { method: "DELETE" }))).status).toBe(200);
  });

  test("exports and imports Markdown and complete archives through the API", async () => {
    const page = store.create({ title: "Portable API", body: "portable body", tags: ["transfer"], properties: { owner: "api" } }, "web");
    const exported = await handler(api(`/api/v1/pages/${page.id}/export`));
    expect(exported.headers.get("content-type")).toContain("text/markdown");
    const markdown = await exported.text();
    expect(markdown).toContain("owner: api");
    const imported = await handler(api("/api/v1/import/pages", { method: "POST", headers: { "Content-Type": "text/markdown" }, body: markdown }));
    expect(imported.status).toBe(201);
    expect((await imported.json() as { alias: string }).alias).toBe("portable-api-2");
    const archive = await handler(api("/api/v1/export"));
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    const prefix = new Uint8Array(await archive.arrayBuffer()).slice(0, 2);
    expect([...prefix]).toEqual([0x1f, 0x8b]);
  });

  test("rejects cross-origin and invalid hosts", async () => {
    expect((await handler(api("/api/v1/pages", { headers: { Origin: "https://evil.example" } }))).status).toBe(403);
    expect((await handler(new Request("http://evil.example/api/v1/pages", { headers: { Authorization: `Bearer ${token}` } }))).status).toBe(400);
  });

  test("serves independent stateless MCP requests", async () => {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const initialize = await handler(request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    }));
    expect(initialize.status).toBe(200);

    const toolsResponse = await handler(request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }));
    expect(toolsResponse.status).toBe(200);
    const tools = await toolsResponse.json() as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map(({ name }) => name).sort()).toEqual(["acknowledge_document_review", "cancel_document_extraction", "create_page", "define_tag", "delete_attachment", "delete_page", "document_ocr_status", "export_page", "get_attachment", "get_attachment_upload_instructions", "get_deleted_page", "get_document", "get_document_content", "get_document_upload_instructions", "get_full_export", "get_page", "get_page_tree", "get_revision_diff", "import_page", "list_attachments", "list_documents", "list_pages", "list_revisions", "list_tag_definitions", "list_trash", "purge_page", "restore_page", "restore_revision", "retry_document_extraction", "search_pages", "semantic_index_status", "update_page"]);
  });
});

describe("web", () => {
  test("serves self-contained Swagger UI assets", async () => {
    const docs = await handler(request("/api-docs"));
    const body = await docs.text();
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(body).toContain("/api-docs/swagger-ui-bundle.js");
    expect(body).not.toContain("https://");
    const bundle = await handler(request("/api-docs/swagger-ui-bundle.js"));
    expect(bundle.headers.get("content-type")).toContain("text/javascript");
    expect((await bundle.text()).length).toBeGreaterThan(100_000);
    const css = await handler(request("/api-docs/swagger-ui.css"));
    expect(css.headers.get("content-type")).toContain("text/css");
    const initializer = await (await handler(request("/api-docs/init.js"))).text();
    expect(initializer).toContain('url: "/openapi.json"');
    expect(initializer).toContain("persistAuthorization: true");
  });

  test("renders pages and red links", async () => {
    store.create({ title: "Home", body: "Go to [[missing]].", tags: ["start"] }, "web");
    const response = await handler(request("/wiki/home"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Home");
    expect(body).toContain('class="wikilink missing"');
    expect(body).toContain("start");
  });

  test("renders search results", async () => {
    store.create({ title: "Find Me", body: "A hidden needle", tags: ["docs"] }, "web");
    const response = await handler(request("/search?q=needle&tags=docs"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Find Me");
    expect(body).toContain("hidden needle");
  });

  test("renders statuses, properties, breadcrumbs, and tree", async () => {
    const parent = store.create({ title: "Web Parent", body: "", tags: [] }, "web");
    store.create({ title: "Web Child", body: "", tags: [], status: "draft", parentId: parent.id, properties: { owner: "web" } }, "web");
    const page = await (await handler(request("/wiki/web-child"))).text();
    expect(page).toContain("Web Parent");
    expect(page).toContain("status-draft");
    expect(page).toContain("owner");
    const tree = await (await handler(request("/tree?status=all"))).text();
    expect(tree).toContain("Web Child");
    expect(tree).toContain("--depth:1");
  });

  test("renders revision history and side-by-side diff", async () => {
    const page = store.create({ title: "History Page", body: "old line", tags: [] }, "web");
    store.update(page.id, { body: "new line" }, "web");
    const revisionId = store.listRevisions(page.id).revisions[0]!.id;

    const history = await handler(request("/wiki/history-page/history"));
    expect(await history.text()).toContain(`history/${revisionId}`);
    const diff = await handler(request(`/wiki/history-page/history/${revisionId}`));
    const body = await diff.text();
    expect(body).toContain("old line");
    expect(body).toContain("new line");
    expect(body).toContain("Restore this revision");
  });

  test("renders trash and marks links to deleted pages", async () => {
    const target = store.create({ title: "Gone", body: "", tags: [] }, "web");
    store.create({ title: "Source", body: "See [[gone]].", tags: [] }, "web");
    store.deletePage(target.id);

    const source = await (await handler(request("/wiki/source"))).text();
    expect(source).toContain('class="wikilink deleted"');
    expect(source).toContain(`/trash/${target.id}`);
    const trash = await (await handler(request(`/trash/${target.id}`))).text();
    expect(trash).toContain("Restore page");
    expect(trash).toContain("Purge permanently");
  });

  test("uploads attachments from the web form", async () => {
    store.create({ title: "Web Files", body: "", tags: [] }, "web");
    const formPage = await handler(request("/wiki/web-files"));
    const cookie = formPage.headers.get("set-cookie")!.split(";", 1)[0]!;
    const csrf = /nwp_csrf=([^;]+)/.exec(cookie)![1]!;
    const data = new FormData();
    data.set("csrf", csrf);
    data.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const uploaded = await handler(request("/wiki/web-files/attachments", { method: "POST", headers: { Cookie: cookie }, body: data }));
    expect(uploaded.status).toBe(303);
    const page = store.getByAlias("web-files");
    expect(store.listAttachments(page.id)[0]?.filename).toBe("hello.txt");
  });

  test("imports Markdown from the web form", async () => {
    const formPage = await handler(request("/import"));
    const cookie = formPage.headers.get("set-cookie")!.split(";", 1)[0]!;
    const csrf = /nwp_csrf=([^;]+)/.exec(cookie)![1]!;
    const data = new FormData();
    data.set("csrf", csrf);
    data.set("file", new File(["---\ntitle: Web Import\nalias: web-import\n---\nImported body"], "page.md", { type: "text/markdown" }));
    const imported = await handler(request("/import", { method: "POST", headers: { Cookie: cookie }, body: data }));
    expect(imported.status).toBe(303);
    expect(store.getByAlias("web-import").body).toBe("Imported body");
  });

  test("requires CSRF for form writes", async () => {
    const denied = await handler(request("/pages", { method: "POST", body: new URLSearchParams({ title: "Nope" }) }));
    expect(denied.status).toBe(403);

    const form = await handler(request("/new"));
    const cookie = form.headers.get("set-cookie")!.split(";", 1)[0]!;
    const csrf = /nwp_csrf=([^;]+)/.exec(cookie)![1]!;
    const allowed = await handler(request("/pages", {
      method: "POST",
      headers: { Cookie: cookie },
      body: new URLSearchParams({ csrf, title: "Created", alias: "", tags: "one,two", body: "text" }),
    }));
    expect(allowed.status).toBe(303);
    expect(store.getByAlias("created").tags).toEqual(["one", "two"]);
  });
});
