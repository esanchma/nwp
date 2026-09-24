import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import logoSvg from "../assets/nwp-logo.svg" with { type: "text" };
import swaggerUiBundle from "swagger-ui-dist/swagger-ui-bundle.js" with { type: "text" };
import swaggerUiCss from "swagger-ui-dist/swagger-ui.css" with { type: "text" };
import type { Config } from "./config.ts";
import type { PageStore } from "./database.ts";
import { AppError, type Attachment, type ChangeSource, type DeletedPage, type Page, type PageProperties, type PageStatus, type PageSummary, type RevisionList } from "./domain.ts";
import { compareRevision, type PageDiff } from "./history.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { createMcpHandler } from "./mcp.ts";
import { openApiJson } from "./openapi.ts";
import { createFullExport, exportPageMarkdown, importPageMarkdown } from "./transfer.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 64 * 1024;

export async function createRequestHandler(store: PageStore, config: Config, apiToken: string): Promise<(request: Request) => Promise<Response>> {
  const handleMcp = await createMcpHandler(store);
  const allowedHosts = new Set([`${config.host}:${config.port}`, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? url.host;
      if (!allowedHosts.has(host)) throw new AppError("invalid_host", "Host header is not allowed", 400);

      if (request.method === "GET" && url.pathname === "/logo.svg") {
        return new Response(logoSvg, {
          headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const publicAttachmentMatch = /^\/attachments\/(\d+)\/[^/]+$/.exec(url.pathname);
      if (request.method === "GET" && publicAttachmentMatch) {
        return attachmentResponse(store, Number(publicAttachmentMatch[1]), url.searchParams.has("download"));
      }

      if (url.pathname === "/mcp") {
        requireBearer(request, apiToken);
        rejectCrossOrigin(request, url);
        return handleMcp(request);
      }

      if (url.pathname.startsWith("/api/v1")) {
        requireBearer(request, apiToken);
        rejectCrossOrigin(request, url);
        return await apiRoute(request, url, store, config.attachmentMaxBytes);
      }

      return await webRoute(request, url, store, config.attachmentMaxBytes);
    } catch (error) {
      return errorResponse(error, request.url.startsWith("http") && new URL(request.url).pathname.startsWith("/api/"));
    }
  };
}

async function apiRoute(request: Request, url: URL, store: PageStore, attachmentMaxBytes: number | null): Promise<Response> {
  const pageMatch = /^\/api\/v1\/pages\/(\d+|[a-z0-9][a-z0-9-]*)$/.exec(url.pathname);
  const revisionsMatch = /^\/api\/v1\/pages\/(\d+)\/revisions$/.exec(url.pathname);
  const revisionMatch = /^\/api\/v1\/pages\/(\d+)\/revisions\/(\d+)$/.exec(url.pathname);
  const revisionDiffMatch = /^\/api\/v1\/pages\/(\d+)\/revisions\/(\d+)\/diff$/.exec(url.pathname);
  const revisionRestoreMatch = /^\/api\/v1\/pages\/(\d+)\/revisions\/(\d+)\/restore$/.exec(url.pathname);
  const trashMatch = /^\/api\/v1\/trash\/(\d+)$/.exec(url.pathname);
  const trashRestoreMatch = /^\/api\/v1\/trash\/(\d+)\/restore$/.exec(url.pathname);
  const pageAttachmentsMatch = /^\/api\/v1\/pages\/(\d+)\/attachments$/.exec(url.pathname);
  const attachmentMatch = /^\/api\/v1\/attachments\/(\d+)$/.exec(url.pathname);
  const attachmentContentMatch = /^\/api\/v1\/attachments\/(\d+)\/content$/.exec(url.pathname);
  const pageExportMatch = /^\/api\/v1\/pages\/(\d+)\/export$/.exec(url.pathname);

  if (request.method === "GET" && url.pathname === "/api/v1/openapi.json") return openApiResponse();
  if (request.method === "GET" && url.pathname === "/api/v1/export") return fullExportResponse(store);
  if (request.method === "POST" && url.pathname === "/api/v1/import/pages") {
    const markdown = new TextDecoder().decode(await readLimited(request));
    return json(storePageImport(store, markdown, apiSource(request)), 201);
  }
  if (request.method === "GET" && pageExportMatch) {
    const page = store.getById(Number(pageExportMatch[1]));
    return markdownResponse(exportPageMarkdown(page), `${page.alias}.md`);
  }

  if (request.method === "GET" && pageAttachmentsMatch) {
    return json({ attachments: store.listAttachments(Number(pageAttachmentsMatch[1])).map(attachmentJson) });
  }
  if (request.method === "POST" && pageAttachmentsMatch) {
    const filename = url.searchParams.get("filename") ?? "";
    const bytes = await readAttachmentBytes(request, attachmentMaxBytes);
    const attachment = store.addAttachment(Number(pageAttachmentsMatch[1]), filename, request.headers.get("content-type") ?? "application/octet-stream", bytes, attachmentMaxBytes);
    return json(attachmentJson(attachment), 201);
  }
  if (request.method === "GET" && attachmentContentMatch) return attachmentResponse(store, Number(attachmentContentMatch[1]), url.searchParams.has("download"));
  if (request.method === "GET" && attachmentMatch) return json(attachmentJson(store.getAttachment(Number(attachmentMatch[1]))));
  if (request.method === "DELETE" && attachmentMatch) return json(attachmentJson(store.removeAttachment(Number(attachmentMatch[1]))));

  if (request.method === "GET" && url.pathname === "/api/v1/trash") {
    const limit = numberParam(url.searchParams.get("limit"), 50);
    return json(store.listTrash(url.searchParams.get("cursor"), limit));
  }
  if (request.method === "POST" && trashRestoreMatch) {
    return json(store.restoreDeleted(Number(trashRestoreMatch[1])));
  }
  if (request.method === "GET" && trashMatch) return json(store.getDeletedById(Number(trashMatch[1])));
  if (request.method === "DELETE" && trashMatch) {
    store.purgeDeleted(Number(trashMatch[1]));
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET" && revisionsMatch) {
    const limit = numberParam(url.searchParams.get("limit"), 50);
    return json(store.listRevisions(Number(revisionsMatch[1]), url.searchParams.get("cursor"), limit));
  }
  if (request.method === "GET" && revisionDiffMatch) {
    const pageId = Number(revisionDiffMatch[1]);
    return json(compareRevision(store.getRevision(pageId, Number(revisionDiffMatch[2])), store.getById(pageId)));
  }
  if (request.method === "POST" && revisionRestoreMatch) {
    return json(store.restoreRevision(Number(revisionRestoreMatch[1]), Number(revisionRestoreMatch[2]), apiSource(request)));
  }
  if (request.method === "GET" && revisionMatch) {
    return json(store.getRevision(Number(revisionMatch[1]), Number(revisionMatch[2])));
  }

  if (request.method === "GET" && url.pathname === "/api/v1/search") {
    const limit = numberParam(url.searchParams.get("limit"), 20);
    const tags = (url.searchParams.get("tags") ?? "").split(",").filter(Boolean);
    const status = statusParam(url.searchParams.get("status"), "published");
    const properties = parsePropertiesInput(url.searchParams.get("properties") ?? "{}");
    return json(store.search(url.searchParams.get("q") ?? "", tags, url.searchParams.get("cursor"), limit, status, properties));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/tree") {
    return json({ pages: store.tree(statusParam(url.searchParams.get("status"), "published")) });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/pages") {
    const limit = numberParam(url.searchParams.get("limit"), 50);
    return json(store.list(url.searchParams.get("cursor"), limit, statusParam(url.searchParams.get("status"), "published")));
  }

  if (request.method === "POST" && url.pathname === "/api/v1/pages") {
    const body = await readJson(request);
    return json(store.create(body as never, apiSource(request)), 201);
  }

  if (pageMatch && request.method === "GET") {
    const key = pageMatch[1]!;
    return json(/^\d+$/.test(key) ? store.getById(Number(key)) : store.getByAlias(key));
  }

  if (pageMatch && request.method === "DELETE") {
    if (!/^\d+$/.test(pageMatch[1]!)) throw new AppError("invalid_id", "deletion requires a page ID", 400);
    return json(store.deletePage(Number(pageMatch[1])));
  }

  if (pageMatch && request.method === "PUT") {
    if (!/^\d+$/.test(pageMatch[1]!)) throw new AppError("invalid_id", "updates require a page ID", 400);
    return json(store.update(Number(pageMatch[1]), await readJson(request) as never, apiSource(request)));
  }

  throw new AppError("not_found", "endpoint not found", 404);
}

async function webRoute(request: Request, url: URL, store: PageStore, attachmentMaxBytes: number | null): Promise<Response> {
  rejectCrossOrigin(request, url);
  const csrf = csrfFor(request);
  const headers = csrfHeaders(request, csrf);

  if (request.method === "GET" && url.pathname === "/") {
    const status = statusParam(url.searchParams.get("status"), "published");
    return html(layout("Recent pages", `${statusNav("/", status)}${pageList("Recent pages", store.recent(20, status), "No pages yet.")}`, csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/pages") {
    const status = statusParam(url.searchParams.get("status"), "published");
    return html(layout("All pages", `${statusNav("/pages", status)}${pageList("All pages", store.list(null, 100, status).pages, "No pages yet.")}`, csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/search") {
    const query = url.searchParams.get("q") ?? "";
    const tagsText = url.searchParams.get("tags") ?? "";
    const tags = tagsText.split(",").filter(Boolean);
    const status = statusParam(url.searchParams.get("status"), "published");
    const propertiesText = url.searchParams.get("properties") ?? "";
    const properties = propertiesText.trim() ? parsePropertiesInput(propertiesText) : {};
    const results = query.trim() || tags.length || Object.keys(properties).length ? store.search(query, tags, url.searchParams.get("cursor"), 20, status, properties) : null;
    return html(layout("Search", searchView(query, tagsText, status, propertiesText, results), csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/tree") {
    const status = statusParam(url.searchParams.get("status"), "published");
    const entries = store.tree(status).map((page) => `<li style="--depth:${page.depth}"><a href="/wiki/${encodeURIComponent(page.alias)}">${escapeHtml(page.title)}</a>${page.status !== "published" ? ` <span class="status status-${page.status}">${page.status}</span>` : ""}</li>`).join("");
    return html(layout("Page tree", `${statusNav("/tree", status)}<h1>Page tree</h1>${entries ? `<ul class="tree">${entries}</ul>` : "<p>No pages yet.</p>"}`, csrf), 200, headers);
  }
  if (request.method === "GET" && (url.pathname === "/api-docs" || url.pathname === "/api-docs/")) return swaggerUiResponse();
  if (request.method === "GET" && url.pathname === "/api-docs/swagger-ui.css") return staticAssetResponse(swaggerUiCss, "text/css; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/api-docs/swagger-ui-bundle.js") return staticAssetResponse(swaggerUiBundle, "text/javascript; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/api-docs/init.js") return staticAssetResponse(swaggerUiInitializer, "text/javascript; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/openapi.json") return openApiResponse();
  if (request.method === "GET" && url.pathname === "/export/all") return fullExportResponse(store);
  if (request.method === "GET" && url.pathname === "/import") {
    return html(layout("Import page", `<h1>Import Markdown</h1><p>The file must begin with nwp YAML front matter. Alias collisions create a suffixed alias.</p><form method="post" enctype="multipart/form-data" action="/import"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Markdown file<input type="file" name="file" accept=".md,text/markdown,text/plain" required></label><button type="submit">Import page</button></form>`, csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/import") {
    await verifyCsrf(request);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_REQUEST_BYTES + 64 * 1024) throw new AppError("body_too_large", "import is too large", 413);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("import_required", "choose a Markdown file", 400);
    if (file.size > MAX_REQUEST_BYTES) throw new AppError("body_too_large", "import is too large", 413);
    const page = storePageImport(store, await file.text(), "web");
    return redirect(`/wiki/${encodeURIComponent(page.alias)}`);
  }
  if (request.method === "GET" && url.pathname === "/new") {
    const alias = url.searchParams.get("alias") ?? "";
    const title = url.searchParams.get("title") ?? "";
    return html(layout("New page", pageForm({ title, alias, body: "", tags: [], status: "published", parentId: null, properties: {} }, csrf, store.parentCandidates()), csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/pages") {
    await verifyCsrf(request);
    const fields = await readForm(request);
    const page = store.create(formPage(fields), "web");
    return redirect(`/wiki/${encodeURIComponent(page.alias)}`);
  }
  if (request.method === "GET" && url.pathname === "/tags") {
    const items = store.listTags().map(({ tag, count }) => `<li><a href="/tags/${encodeURIComponent(tag)}">${escapeHtml(tag)}</a> <small>${count}</small></li>`).join("");
    return html(layout("Tags", `<h1>Tags</h1><ul class="page-list">${items || "<li>No tags yet.</li>"}</ul>`, csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/trash") {
    const trash = store.listTrash(url.searchParams.get("cursor"), 50);
    const items = trash.pages.map((page) => `<li><a href="/trash/${page.id}">${escapeHtml(page.title)}</a><small>/${escapeHtml(page.alias)} · deleted ${formatDate(page.deletedAt)}</small></li>`).join("");
    const next = trash.nextCursor ? `<p><a class="button secondary" href="/trash?cursor=${encodeURIComponent(trash.nextCursor)}">Older deleted pages</a></p>` : "";
    return html(layout("Trash", `<h1>Trash</h1><p>Deleted aliases are released immediately. Purging is permanent.</p>${items ? `<ul class="page-list">${items}</ul>${next}` : "<p>Trash is empty.</p>"}`, csrf), 200, headers);
  }

  const trashRestoreMatch = /^\/trash\/(\d+)\/restore$/.exec(url.pathname);
  if (request.method === "POST" && trashRestoreMatch) {
    await verifyCsrf(request);
    const restored = store.restoreDeleted(Number(trashRestoreMatch[1]));
    return redirect(`/wiki/${encodeURIComponent(restored.alias)}`);
  }
  const trashPurgeMatch = /^\/trash\/(\d+)\/purge$/.exec(url.pathname);
  if (request.method === "POST" && trashPurgeMatch) {
    await verifyCsrf(request);
    store.purgeDeleted(Number(trashPurgeMatch[1]));
    return redirect("/trash");
  }
  const trashDetailMatch = /^\/trash\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && trashDetailMatch) {
    const page = store.getDeletedById(Number(trashDetailMatch[1]));
    return html(layout(`Deleted · ${page.title}`, trashPageView(page, store, csrf), csrf), 200, headers);
  }

  const tagMatch = /^\/tags\/(.+)$/.exec(url.pathname);
  if (request.method === "GET" && tagMatch) {
    const tag = decodeURIComponent(tagMatch[1]!);
    return html(layout(`Tag: ${tag}`, pageList(`Tag: ${escapeHtml(tag)}`, store.pagesForTag(tag), "No pages use this tag."), csrf), 200, headers);
  }

  const pageExportMatch = /^\/wiki\/([^/]+)\/export$/.exec(url.pathname);
  if (request.method === "GET" && pageExportMatch) {
    const page = store.getByAlias(decodeURIComponent(pageExportMatch[1]!));
    return markdownResponse(exportPageMarkdown(page), `${page.alias}.md`);
  }

  const attachmentDeleteMatch = /^\/wiki\/([^/]+)\/attachments\/(\d+)\/delete$/.exec(url.pathname);
  if (request.method === "POST" && attachmentDeleteMatch) {
    await verifyCsrf(request);
    const page = store.getByAlias(decodeURIComponent(attachmentDeleteMatch[1]!));
    const attachment = store.getAttachment(Number(attachmentDeleteMatch[2]));
    if (attachment.pageId !== page.id) throw new AppError("attachment_not_found", "attachment not found on this page", 404);
    store.removeAttachment(attachment.id);
    return redirect(`/wiki/${encodeURIComponent(page.alias)}`);
  }
  const attachmentUploadMatch = /^\/wiki\/([^/]+)\/attachments$/.exec(url.pathname);
  if (request.method === "POST" && attachmentUploadMatch) {
    await verifyCsrf(request);
    const page = store.getByAlias(decodeURIComponent(attachmentUploadMatch[1]!));
    const length = Number(request.headers.get("content-length") ?? 0);
    if (attachmentMaxBytes !== null && length > attachmentMaxBytes + 64 * 1024) throw new AppError("attachment_too_large", "attachment exceeds the configured limit", 413);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("attachment_required", "choose a file to upload", 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    store.addAttachment(page.id, file.name, file.type, bytes, attachmentMaxBytes);
    return redirect(`/wiki/${encodeURIComponent(page.alias)}`);
  }

  const deleteMatch = /^\/wiki\/([^/]+)\/delete$/.exec(url.pathname);
  if (request.method === "GET" && deleteMatch) {
    const page = store.getByAlias(decodeURIComponent(deleteMatch[1]!));
    return html(layout(`Delete ${page.title}`, `<p><a href="/wiki/${encodeURIComponent(page.alias)}">← Cancel</a></p><h1>Move “${escapeHtml(page.title)}” to trash?</h1><p>The alias <code>${escapeHtml(page.alias)}</code> will become available immediately.</p><form method="post" action="/wiki/${encodeURIComponent(page.alias)}/delete"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="danger" type="submit">Move to trash</button></form>`, csrf), 200, headers);
  }
  if (request.method === "POST" && deleteMatch) {
    await verifyCsrf(request);
    const page = store.getByAlias(decodeURIComponent(deleteMatch[1]!));
    const deleted = store.deletePage(page.id);
    return redirect(`/trash/${deleted.id}`);
  }

  const historyRestoreMatch = /^\/wiki\/([^/]+)\/history\/(\d+)\/restore$/.exec(url.pathname);
  if (request.method === "POST" && historyRestoreMatch) {
    await verifyCsrf(request);
    const page = store.getByAlias(decodeURIComponent(historyRestoreMatch[1]!));
    const restored = store.restoreRevision(page.id, Number(historyRestoreMatch[2]), "web");
    return redirect(`/wiki/${encodeURIComponent(restored.alias)}`);
  }
  const historyDetailMatch = /^\/wiki\/([^/]+)\/history\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && historyDetailMatch) {
    const page = store.getByAlias(decodeURIComponent(historyDetailMatch[1]!));
    const revision = store.getRevision(page.id, Number(historyDetailMatch[2]));
    return html(layout(`Revision ${revision.id} · ${page.title}`, historyDiffView(page, compareRevision(revision, page), csrf), csrf), 200, headers);
  }
  const historyMatch = /^\/wiki\/([^/]+)\/history$/.exec(url.pathname);
  if (request.method === "GET" && historyMatch) {
    const page = store.getByAlias(decodeURIComponent(historyMatch[1]!));
    const revisions = store.listRevisions(page.id, url.searchParams.get("cursor"), 50);
    return html(layout(`History · ${page.title}`, historyView(page, revisions), csrf), 200, headers);
  }

  const editMatch = /^\/wiki\/([^/]+)\/edit$/.exec(url.pathname);
  if (request.method === "GET" && editMatch) {
    const page = store.getByAlias(decodeURIComponent(editMatch[1]!));
    return html(layout(`Edit ${page.title}`, pageForm(page, csrf, store.parentCandidates(page.id)), csrf), 200, headers);
  }
  if (request.method === "POST" && editMatch) {
    await verifyCsrf(request);
    const page = store.getByAlias(decodeURIComponent(editMatch[1]!));
    const updated = store.update(page.id, formPage(await readForm(request)), "web");
    return redirect(`/wiki/${encodeURIComponent(updated.alias)}`);
  }

  const pageMatch = /^\/wiki\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && pageMatch) {
    const page = store.getByAlias(decodeURIComponent(pageMatch[1]!));
    return html(layout(page.title, pageView(page, store, csrf), csrf), 200, headers);
  }

  if (request.method !== "GET") throw new AppError("method_not_allowed", "method not allowed", 405);
  throw new AppError("not_found", "page not found", 404);
}

function pageView(page: Page, store: PageStore, csrf: string): string {
  const content = renderMarkdown(page.body, (alias) => {
    try { store.getByAlias(alias); return "active"; } catch {
      try { return { state: "deleted" as const, id: store.getDeletedByAlias(alias).id }; } catch { return "missing"; }
    }
  });
  const tags = page.tags.map((tag) => `<a class="tag" href="/tags/${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join(" ");
  const breadcrumbs = page.breadcrumbs.map((crumb) => `<a href="/wiki/${encodeURIComponent(crumb.alias)}">${escapeHtml(crumb.title)}</a>`).join(" <span aria-hidden=\"true\">›</span> ");
  const properties = Object.entries(page.properties).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td><code>${escapeHtml(JSON.stringify(value))}</code></td></tr>`).join("");
  const backlinks = page.backlinks.map((link) => `<li><a href="/wiki/${encodeURIComponent(link.alias)}">${escapeHtml(link.title)}</a></li>`).join("");
  const attachments = store.listAttachments(page.id);
  const attachmentItems = attachments.map((attachment) => {
    const url = attachmentUrl(attachment);
    const preview = attachment.inlineSafe ? `<a href="${url}"><img class="attachment-preview" src="${url}" alt="${escapeHtml(attachment.filename)}" loading="lazy"></a>` : "";
    return `<li>${preview}<div><a href="${url}${attachment.inlineSafe ? "?download=1" : ""}">${escapeHtml(attachment.filename)}</a><small>${escapeHtml(attachment.mimeType)} · ${formatBytes(attachment.size)}</small></div><form method="post" action="/wiki/${encodeURIComponent(page.alias)}/attachments/${attachment.id}/delete"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="link-danger" type="submit">Remove</button></form></li>`;
  }).join("");
  return `<article>
    ${breadcrumbs ? `<nav class="breadcrumbs" aria-label="Breadcrumb">${breadcrumbs}</nav>` : ""}
    <header class="page-header"><div><h1>${escapeHtml(page.title)} <span class="status status-${page.status}">${page.status}</span></h1>${tags ? `<div class="tags">${tags}</div>` : ""}</div><div class="page-actions"><a class="button secondary" href="/wiki/${encodeURIComponent(page.alias)}/history">History</a><a class="button secondary" href="/wiki/${encodeURIComponent(page.alias)}/export">Export</a><a class="button secondary" href="/wiki/${encodeURIComponent(page.alias)}/edit">Edit</a><a class="button danger" href="/wiki/${encodeURIComponent(page.alias)}/delete">Delete</a></div></header>
    <div class="markdown">${content || "<p><em>This page is empty.</em></p>"}</div>
    ${properties ? `<details class="properties"><summary>Properties</summary><table>${properties}</table></details>` : ""}
  </article>
  <aside class="attachments"><h2>Attachments</h2>${attachmentItems ? `<ul>${attachmentItems}</ul>` : "<p>No attachments.</p>"}<form class="attachment-upload" method="post" enctype="multipart/form-data" action="/wiki/${encodeURIComponent(page.alias)}/attachments"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Add file<input type="file" name="file" required></label><button type="submit">Upload</button></form></aside>
  <aside><h2>Backlinks</h2>${backlinks ? `<ul>${backlinks}</ul>` : "<p>No pages link here.</p>"}</aside>`;
}

function trashPageView(page: DeletedPage, store: PageStore, csrf: string): string {
  const backlinks = page.backlinks.map((link) => `<li><a href="/wiki/${encodeURIComponent(link.alias)}">${escapeHtml(link.title)}</a></li>`).join("");
  const attachments = store.listAttachments(page.id, true).map((attachment) => `<li>${escapeHtml(attachment.filename)} <small>${formatBytes(attachment.size)}</small></li>`).join("");
  return `<p><a href="/trash">← Trash</a></p><h1>${escapeHtml(page.title)}</h1><p><span class="status-deleted">Deleted</span> ${formatDate(page.deletedAt)}</p><dl><dt>Released alias</dt><dd><code>${escapeHtml(page.alias)}</code></dd></dl>
    <h2>Retained attachments</h2>${attachments ? `<ul>${attachments}</ul>` : "<p>No attachments.</p>"}
    <div class="page-actions"><form method="post" action="/trash/${page.id}/restore"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Restore page</button></form><form method="post" action="/trash/${page.id}/purge"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="danger" type="submit">Purge permanently</button></form></div>
    <h2>Pages linking to this deleted alias</h2>${backlinks ? `<ul>${backlinks}</ul>` : "<p>No active pages link here.</p>"}`;
}

function historyView(page: Page, history: RevisionList): string {
  const items = history.revisions.map((revision) => `<li><a href="/wiki/${encodeURIComponent(page.alias)}/history/${revision.id}">${formatDate(revision.createdAt)}</a><small>revision ${revision.id} · ${escapeHtml(revision.source)} · ${escapeHtml(revision.title)} · /${escapeHtml(revision.alias)}</small></li>`).join("");
  const next = history.nextCursor ? `<p><a class="button secondary" href="/wiki/${encodeURIComponent(page.alias)}/history?cursor=${encodeURIComponent(history.nextCursor)}">Older revisions</a></p>` : "";
  return `<div class="title-row"><div><a href="/wiki/${encodeURIComponent(page.alias)}">← ${escapeHtml(page.title)}</a><h1>History</h1></div></div><p>Each entry is the complete page state before an edit.</p>${items ? `<ol class="page-list history-list">${items}</ol>${next}` : "<p>No revisions yet.</p>"}`;
}

function historyDiffView(page: Page, diff: PageDiff, csrf: string): string {
  const metadata = `<table class="metadata-diff"><thead><tr><th>Field</th><th>Revision ${diff.revisionId}</th><th>Current</th></tr></thead><tbody>
    ${metadataRow("Title", diff.from.title, diff.to.title)}
    ${metadataRow("Alias", diff.from.alias, diff.to.alias)}
    ${metadataRow("Tags", diff.from.tags.join(", "), diff.to.tags.join(", "))}
    ${metadataRow("Status", diff.from.status, diff.to.status)}
    ${metadataRow("Parent ID", diff.from.parentId === null ? "" : String(diff.from.parentId), diff.to.parentId === null ? "" : String(diff.to.parentId))}
    ${metadataRow("Properties", JSON.stringify(diff.from.properties), JSON.stringify(diff.to.properties))}
  </tbody></table>`;
  const limit = 5000;
  const rows = diff.body.slice(0, limit).map((row, index) => `<tr><td class="line-no">${index + 1}</td><td class="diff-${row.leftKind}"><code>${row.left === null ? "" : escapeHtml(row.left)}</code></td><td class="line-no">${index + 1}</td><td class="diff-${row.rightKind}"><code>${row.right === null ? "" : escapeHtml(row.right)}</code></td></tr>`).join("");
  const truncated = diff.body.length > limit ? `<p class="warning">Diff truncated after ${limit} rows.</p>` : "";
  return `<p><a href="/wiki/${encodeURIComponent(page.alias)}/history">← History</a></p><div class="page-header"><div><h1>Revision ${diff.revisionId}</h1><p>${formatDate(diff.from.createdAt)}</p></div><form method="post" action="/wiki/${encodeURIComponent(page.alias)}/history/${diff.revisionId}/restore"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Restore this revision</button></form></div>
    <h2>Metadata</h2>${metadata}<h2>Markdown</h2><div class="diff-scroll"><table class="code-diff"><thead><tr><th colspan="2">Revision ${diff.revisionId}</th><th colspan="2">Current</th></tr></thead><tbody>${rows || "<tr><td colspan=\"4\">Both versions are empty.</td></tr>"}</tbody></table></div>${truncated}`;
}

function metadataRow(label: string, before: string, after: string): string {
  const changed = before !== after ? " class=\"changed\"" : "";
  return `<tr><th>${label}</th><td${changed}>${escapeHtml(before) || "<em>empty</em>"}</td><td${changed}>${escapeHtml(after) || "<em>empty</em>"}</td></tr>`;
}

function pageList(title: string, pages: PageSummary[], empty: string): string {
  const items = pages.map((page) => `<li><a href="/wiki/${encodeURIComponent(page.alias)}">${escapeHtml(page.title)}</a>${page.status !== "published" ? ` <span class="status status-${page.status}">${page.status}</span>` : ""}<small>${escapeHtml(page.alias)} · ${formatDate(page.updatedAt)}</small></li>`).join("");
  return `<h1>${title}</h1>${items ? `<ul class="page-list">${items}</ul>` : `<p>${empty}</p>`}`;
}

function searchView(query: string, tags: string, status: PageStatus | "all", properties: string, results: ReturnType<PageStore["search"]> | null): string {
  const form = `<h1>Search</h1><form class="search-page" method="get" action="/search">
    <label>Text<input type="search" name="q" value="${escapeHtml(query)}" autofocus></label>
    <label>Tags <small>comma-separated; all must match</small><input name="tags" value="${escapeHtml(tags)}"></label>
    <label>Status<select name="status">${statusOptions(status, true)}</select></label>
    <label>Properties <small>JSON object, exact values</small><input name="properties" value="${escapeHtml(properties)}" placeholder='{"owner":"team"}'></label>
    <button type="submit">Search</button>
  </form>`;
  if (!results) return `${form}<p>Enter text, tags, or both.</p>`;
  const items = results.pages.map((page) => `<li><a href="/wiki/${encodeURIComponent(page.alias)}">${escapeHtml(page.title)}</a><small>${escapeHtml(page.alias)} · ${formatDate(page.updatedAt)}</small>${page.excerpt ? `<p>${escapeHtml(page.excerpt)}</p>` : ""}</li>`).join("");
  const next = results.nextCursor
    ? `<p><a class="button secondary" href="/search?${new URLSearchParams({ q: query, tags, status, properties, cursor: results.nextCursor }).toString()}">More results</a></p>`
    : "";
  return `${form}${items ? `<ul class="page-list search-results">${items}</ul>${next}` : "<p>No matching pages.</p>"}`;
}

function pageForm(page: Pick<Page, "title" | "alias" | "body" | "tags" | "status" | "parentId" | "properties">, csrf: string, parents: Array<{ id: number; title: string }>): string {
  const editing = "id" in page;
  const parentOptions = parents.map((parent) => `<option value="${parent.id}"${parent.id === page.parentId ? " selected" : ""}>${escapeHtml(parent.title)}</option>`).join("");
  return `<h1>${editing ? "Edit page" : "New page"}</h1>
  <form method="post" action="${editing ? `/wiki/${encodeURIComponent(page.alias)}/edit` : "/pages"}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label>Title<input name="title" required maxlength="200" value="${escapeHtml(page.title)}"></label>
    <label>Alias<input name="alias" maxlength="200" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value="${escapeHtml(page.alias)}" placeholder="generated-from-title"></label>
    <div class="form-grid"><label>Status<select name="status">${statusOptions(page.status, false)}</select></label><label>Parent<select name="parentId"><option value="">No parent</option>${parentOptions}</select></label></div>
    <label>Tags <small>comma-separated</small><input name="tags" value="${escapeHtml(page.tags.join(", "))}"></label>
    <label>Properties <small>JSON object with string, number, boolean, or null values</small><textarea name="properties" rows="5">${escapeHtml(JSON.stringify(page.properties, null, 2))}</textarea></label>
    <label>Markdown<textarea name="body" rows="24">${escapeHtml(page.body)}</textarea></label>
    <button type="submit">${editing ? "Save changes" : "Create page"}</button>
  </form>`;
}

function formPage(form: FormData) {
  const alias = String(form.get("alias") ?? "").trim();
  const parent = String(form.get("parentId") ?? "").trim();
  return {
    title: String(form.get("title") ?? ""),
    alias: alias || undefined,
    body: String(form.get("body") ?? ""),
    tags: String(form.get("tags") ?? "").split(","),
    status: statusParam(String(form.get("status") ?? "published"), "published") as PageStatus,
    parentId: parent ? Number(parent) : null,
    properties: parsePropertiesInput(String(form.get("properties") ?? "{}")),
  };
}

function layout(title: string, body: string, csrf: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="${escapeHtml(csrf)}"><link rel="icon" href="/logo.svg" type="image/svg+xml"><title>${escapeHtml(title)} · nwp</title><style>${CSS}</style></head><body><header class="site-header"><nav><a class="brand" href="/"><img src="/logo.svg" width="34" height="34" alt="">nwp</a><form class="nav-search" action="/search" method="get"><label class="sr-only" for="nav-query">Search pages</label><input id="nav-query" type="search" name="q" placeholder="Search" aria-label="Search pages"></form><a href="/pages">Pages</a><a href="/tree">Tree</a><a href="/tags">Tags</a><a href="/trash">Trash</a><a href="/api-docs">API</a><a href="/import">Import</a><a href="/export/all">Export all</a><a class="button" href="/new">New page</a></nav></header><main>${body}</main></body></html>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#202124;--muted:#667085;--line:#d0d5dd;--accent:#175cd3;--soft:#eff4ff;--missing:#b42318} @media(prefers-color-scheme:dark){:root{--bg:#111318;--fg:#f2f4f7;--muted:#98a2b3;--line:#344054;--accent:#84adff;--soft:#182230;--missing:#f97066}} *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif} a{color:var(--accent)} a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.site-header{border-bottom:1px solid var(--line)}.site-header nav,main{max-width:900px;margin:auto;padding:1rem}.site-header nav{display:flex;align-items:center;gap:1rem}.brand{display:flex;align-items:center;gap:.55rem;font-size:1.4rem;font-weight:800;text-decoration:none}.brand img{border-radius:9px;box-shadow:0 3px 10px #312e8140}.nav-search{margin-left:auto}.nav-search input{width:13rem;margin:0;padding:.42rem .6rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.button,button{display:inline-block;border:0;border-radius:.4rem;background:var(--accent);color:var(--bg);padding:.45rem .8rem;text-decoration:none;font:inherit;font-weight:700;cursor:pointer}.danger{background:var(--missing);color:#fff}.secondary{background:var(--soft);color:var(--accent)}h1,h2,h3{line-height:1.25}.page-header{display:flex;align-items:start;justify-content:space-between;gap:1rem}.page-list{list-style:none;padding:0}.page-list li{border-bottom:1px solid var(--line);padding:.7rem 0}.page-list small{display:block;color:var(--muted)}label{display:block;font-weight:700;margin:1rem 0}label small{font-weight:400;color:var(--muted)}input,textarea,select{display:block;width:100%;margin-top:.3rem;padding:.65rem;border:1px solid var(--line);border-radius:.3rem;background:var(--bg);color:var(--fg);font:inherit}textarea{font-family:ui-monospace,monospace;resize:vertical}.page-actions{display:flex;gap:.5rem}.form-grid{display:grid;grid-template-columns:1fr 2fr;gap:1rem}.search-page{display:grid;grid-template-columns:2fr 1fr 1fr 2fr auto;align-items:end;gap:.75rem;margin-bottom:2rem}.search-page label{margin:0}.search-page button{margin-bottom:0}.search-results p{margin:.25rem 0;color:var(--muted)}.metadata-diff,.code-diff{width:100%;border-collapse:collapse}.metadata-diff th,.metadata-diff td,.code-diff th,.code-diff td{border:1px solid var(--line);padding:.35rem .55rem;text-align:left}.metadata-diff .changed{background:color-mix(in srgb,var(--missing) 12%,var(--bg))}.diff-scroll{overflow:auto}.code-diff{table-layout:fixed;min-width:720px;font-size:.875rem}.code-diff .line-no{width:3rem;text-align:right;color:var(--muted);user-select:none}.code-diff code{white-space:pre-wrap;overflow-wrap:anywhere}.diff-removed{background:#fee2e2;color:#7f1d1d}.diff-added{background:#dcfce7;color:#14532d}.diff-blank{background:var(--soft)}@media(prefers-color-scheme:dark){.diff-removed{background:#450a0a;color:#fecaca}.diff-added{background:#052e16;color:#bbf7d0}}.warning{color:var(--missing);font-weight:700}.status-nav{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}.status{font-size:.7em;text-transform:uppercase;letter-spacing:.04em;padding:.15rem .4rem;border-radius:1rem;background:var(--soft);vertical-align:middle}.status-draft{color:#b54708}.status-archived{color:var(--muted)}.breadcrumbs{padding:0;margin:0 0 1rem;color:var(--muted)}.properties{margin-top:2rem}.properties table{border-collapse:collapse}.properties th,.properties td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left}.tree{list-style:none;padding:0}.tree li{padding:.3rem 0 .3rem calc(var(--depth) * 1.5rem)}.attachments ul{list-style:none;padding:0}.attachments li{display:flex;align-items:center;gap:.8rem;border-bottom:1px solid var(--line);padding:.65rem 0}.attachments li>div{flex:1}.attachments small{display:block;color:var(--muted)}.attachment-preview{display:block;width:72px;height:54px;object-fit:cover;border-radius:.35rem;border:1px solid var(--line)}.attachment-upload{display:flex;align-items:end;gap:.75rem}.attachment-upload label{flex:1}.link-danger{padding:.2rem;background:transparent;color:var(--missing)}.status-deleted,.deleted{color:var(--missing);font-weight:700;text-decoration-style:dashed}.tag{display:inline-block;padding:.1rem .45rem;border-radius:1rem;background:var(--soft);text-decoration:none;font-size:.9rem}.missing{color:var(--missing);text-decoration-style:dotted}.markdown{overflow-wrap:anywhere}.markdown pre{overflow:auto;padding:1rem;background:var(--soft);border-radius:.4rem}.markdown table{border-collapse:collapse}.markdown th,.markdown td{border:1px solid var(--line);padding:.35rem .6rem}aside{margin-top:3rem;border-top:1px solid var(--line)}@media(max-width:700px){.site-header nav{flex-wrap:wrap}.nav-search{order:5;width:100%;margin:0}.nav-search input{width:100%}.search-page{grid-template-columns:1fr}.page-header{display:block}.page-header .button{margin-top:.5rem}}
`;

function statusParam(value: string | null, fallback: PageStatus | "all"): PageStatus | "all" {
  const status = value || fallback;
  if (status === "draft" || status === "published" || status === "archived" || status === "all") return status;
  throw new AppError("invalid_status", "status must be draft, published, archived, or all", 400);
}

function statusOptions(selected: PageStatus | "all", includeAll: boolean): string {
  const values = [...(includeAll ? ["all"] : []), "published", "draft", "archived"];
  return values.map((value) => `<option value="${value}"${value === selected ? " selected" : ""}>${value[0]!.toUpperCase()}${value.slice(1)}</option>`).join("");
}

function statusNav(path: string, selected: PageStatus | "all"): string {
  return `<nav class="status-nav" aria-label="Page status">${(["published", "draft", "archived", "all"] as const).map((status) => `<a class="button ${status === selected ? "" : "secondary"}" href="${path}?status=${status}">${status}</a>`).join("")}</nav>`;
}

function parsePropertiesInput(value: string): PageProperties {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    for (const item of Object.values(parsed)) {
      if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error();
    }
    return parsed as PageProperties;
  } catch {
    throw new AppError("invalid_properties", "properties must be a JSON object containing only string, number, boolean, or null values", 400);
  }
}

function csrfFor(request: Request): string {
  const existing = cookieValue(request.headers.get("cookie"), "nwp_csrf");
  return existing && /^[A-Za-z0-9_-]{32,}$/.test(existing) ? existing : Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

function csrfHeaders(request: Request, csrf: string): Headers {
  const headers = new Headers();
  if (!cookieValue(request.headers.get("cookie"), "nwp_csrf")) {
    headers.set("Set-Cookie", `nwp_csrf=${csrf}; Path=/; SameSite=Strict; HttpOnly`);
  }
  return headers;
}

async function verifyCsrf(request: Request): Promise<void> {
  const cookie = cookieValue(request.headers.get("cookie"), "nwp_csrf");
  const form = await request.clone().formData();
  const submitted = String(form.get("csrf") ?? "");
  if (!cookie || !submitted || !timingSafeEqual(cookie, submitted)) throw new AppError("csrf_failed", "CSRF validation failed", 403);
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && nodeTimingSafeEqual(a, b);
}

function requireBearer(request: Request, token: string): void {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(supplied, token)) throw new AppError("unauthorized", "valid Bearer token required", 401);
}

function rejectCrossOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new AppError("cross_origin_denied", "cross-origin requests are not allowed", 403);
}

function apiSource(request: Request): ChangeSource {
  return request.headers.get("x-nwp-source") === "cli" ? "cli" : "rest";
}

function storePageImport(store: PageStore, markdown: string, source: ChangeSource): Page {
  return importPageMarkdown(store, markdown, source);
}

const swaggerUiInitializer = `window.addEventListener("load", function () {
  window.ui = SwaggerUIBundle({
    url: "/openapi.json",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: true,
    filter: true,
    persistAuthorization: true,
    syntaxHighlight: { activate: true },
    tryItOutEnabled: false
  });
});\n`;

function swaggerUiResponse(): Response {
  const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>nwp API documentation</title><link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="stylesheet" href="/api-docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script defer src="/api-docs/swagger-ui-bundle.js"></script><script defer src="/api-docs/init.js"></script></body></html>`;
  return new Response(document, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function staticAssetResponse(body: string, contentType: string): Response {
  return new Response(body, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}

function openApiResponse(): Response {
  return new Response(openApiJson(), {
    headers: { "Content-Type": "application/vnd.oai.openapi+json;version=3.1", "X-Content-Type-Options": "nosniff" },
  });
}

function markdownResponse(markdown: string, filename: string): Response {
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fullExportResponse(store: PageStore): Response {
  const archive = createFullExport(store);
  return new Response(archive.stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename=${archive.filename}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function attachmentJson(attachment: Attachment) {
  return { ...attachment, url: attachmentUrl(attachment), downloadUrl: `${attachmentUrl(attachment)}?download=1` };
}

function attachmentUrl(attachment: Attachment): string {
  return `/attachments/${attachment.id}/${encodeURIComponent(attachment.filename)}`;
}

async function attachmentResponse(store: PageStore, attachmentId: number, forceDownload: boolean): Promise<Response> {
  const { attachment, path } = store.attachmentPath(attachmentId);
  const file = Bun.file(path);
  if (!await file.exists()) throw new AppError("attachment_content_missing", "attachment content is missing", 500);
  const disposition = forceDownload || !attachment.inlineSafe ? "attachment" : "inline";
  return new Response(file, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.size),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

async function readAttachmentBytes(request: Request, maxBytes: number | null): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (maxBytes !== null && length > maxBytes) throw new AppError("attachment_too_large", "attachment exceeds the configured limit", 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (maxBytes !== null && bytes.byteLength > maxBytes) throw new AppError("attachment_too_large", "attachment exceeds the configured limit", 413);
  return bytes;
}

async function readJson(request: Request): Promise<unknown> {
  const bytes = await readLimited(request);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AppError("invalid_json", "request body is not valid JSON", 400); }
}

async function readForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new AppError("invalid_content_type", "web forms must use application/x-www-form-urlencoded", 415);
  }
  const params = new URLSearchParams(new TextDecoder().decode(await readLimited(request)));
  const form = new FormData();
  for (const [key, value] of params) form.append(key, value);
  return form;
}

async function readLimited(request: Request): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_REQUEST_BYTES) throw new AppError("body_too_large", "request body is too large", 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new AppError("body_too_large", "request body is too large", 413);
  return bytes;
}

function numberParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new AppError("invalid_limit", "limit must be between 1 and 100", 400);
  return parsed;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function html(value: string, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(value, { status, headers });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function errorResponse(error: unknown, api: boolean): Response {
  let appError: AppError;
  if (error instanceof AppError) appError = error;
  else if (error instanceof ZodError) appError = new AppError("validation_failed", "request validation failed", 400, error.issues);
  else {
    console.error(error);
    appError = new AppError("internal_error", "internal server error", 500);
  }
  if (api) return json({ error: { code: appError.code, message: appError.message, details: appError.details } }, appError.status);
  return html(layout("Error", `<h1>${appError.status}</h1><p>${escapeHtml(appError.message)}</p><p><a href="/">Return home</a></p>`, ""), appError.status);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
