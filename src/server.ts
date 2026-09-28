import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import logoSvg from "../assets/nwp-logo.svg" with { type: "text" };
import editorScript from "../assets/editor.js" with { type: "text" };
import swaggerUiBundle from "swagger-ui-dist/swagger-ui-bundle.js" with { type: "text" };
import swaggerUiCss from "swagger-ui-dist/swagger-ui.css" with { type: "text" };
import { answerQuestion, type AnswerInput, type AnswerResult } from "./answer.ts";
import type { Config } from "./config.ts";
import type { PageStore } from "./database.ts";
import { AppError, type Attachment, type ChangeSource, type DeletedPage, type DocumentLocator, type DocumentSearchFilters, type Page, type PageProperties, type PageStatus, type PageSummary, type RevisionList, type SearchResults } from "./domain.ts";
import { compareRevision, type PageDiff } from "./history.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { createMcpHandler } from "./mcp.ts";
import { openApiJson } from "./openapi.ts";
import { createFullExport, exportPageMarkdown, importPageMarkdown } from "./transfer.ts";
import { hybridSearch, lexicalSearch, OllamaEmbedder } from "./semantic.ts";
import { canonicalDocumentMime, documentFormat, ocrRuntimeStatus } from "./documents.ts";
import { normalizeWebUrl } from "./web.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 64 * 1024;

export async function createRequestHandler(store: PageStore, config: Config, apiToken: string): Promise<(request: Request) => Promise<Response>> {
  const handleMcp = await createMcpHandler(store, config.semanticSearch, config.documentRag, config.ragAnswer, config.webCapture, config.research);
  const embedder = config.semanticSearch.enabled ? new OllamaEmbedder(config.semanticSearch) : null;
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
      if (request.method === "GET" && url.pathname === "/editor.js") return staticAssetResponse(editorScript, "text/javascript; charset=utf-8");

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
        return await apiRoute(request, url, store, config, embedder);
      }

      return await webRoute(request, url, store, config, embedder);
    } catch (error) {
      return errorResponse(error, request.url.startsWith("http") && new URL(request.url).pathname.startsWith("/api/"));
    }
  };
}

async function apiRoute(request: Request, url: URL, store: PageStore, config: Config, embedder: OllamaEmbedder | null): Promise<Response> {
  const attachmentMaxBytes = config.attachmentMaxBytes;
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
  const documentMatch = /^\/api\/v1\/documents\/(\d+)$/.exec(url.pathname);
  const documentVersionsMatch = /^\/api\/v1\/documents\/(\d+)\/versions$/.exec(url.pathname);
  const documentContentMatch = /^\/api\/v1\/documents\/(\d+)\/content$/.exec(url.pathname);
  const documentDownloadMatch = /^\/api\/v1\/documents\/(\d+)\/download$/.exec(url.pathname);
  const documentReviewMatch = /^\/api\/v1\/documents\/(\d+)\/review$/.exec(url.pathname);
  const documentCancelMatch = /^\/api\/v1\/documents\/(\d+)\/cancel$/.exec(url.pathname);
  const documentRetryMatch = /^\/api\/v1\/documents\/(\d+)\/retry$/.exec(url.pathname);
  const webCaptureMatch = /^\/api\/v1\/web-captures\/(\d+)$/.exec(url.pathname);
  const webCaptureCancelMatch = /^\/api\/v1\/web-captures\/(\d+)\/cancel$/.exec(url.pathname);
  const webCaptureRetryMatch = /^\/api\/v1\/web-captures\/(\d+)\/retry$/.exec(url.pathname);
  const webCaptureRefreshMatch = /^\/api\/v1\/web-captures\/(\d+)\/refresh$/.exec(url.pathname);
  const webCaptureScheduleMatch = /^\/api\/v1\/web-captures\/(\d+)\/schedule$/.exec(url.pathname);
  const researchMatch = /^\/api\/v1\/research\/(\d+)$/.exec(url.pathname);
  const researchCancelMatch = /^\/api\/v1\/research\/(\d+)\/cancel$/.exec(url.pathname);
  const researchRetryMatch = /^\/api\/v1\/research\/(\d+)\/retry$/.exec(url.pathname);

  if (request.method === "GET" && url.pathname === "/api/v1/openapi.json") return openApiResponse();
  if (request.method === "GET" && url.pathname === "/api/v1/research") return json({ research: store.listResearch() });
  if (request.method === "POST" && url.pathname === "/api/v1/research") {
    if (!config.research.enabled || !config.webCapture.enabled || !config.documentRag.enabled || !config.ragAnswer.enabled) throw new AppError("research_disabled", "research, web capture, document ingestion, and cited answers must be enabled", 503);
    const value = await readJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_research", "request body must be an object", 400);
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["query", "urls", "maxSources"].includes(key))) throw new AppError("invalid_research", "request contains unknown fields", 400);
    if (typeof body.query !== "string") throw new AppError("invalid_research", "query is required", 400);
    if (body.urls !== undefined && (!Array.isArray(body.urls) || body.urls.some((item) => typeof item !== "string"))) throw new AppError("invalid_research", "urls must be an array of strings", 400);
    const urls = (body.urls as string[] | undefined ?? []).map(normalizeWebUrl);
    const maxSources = body.maxSources === undefined ? config.research.defaultMaxSources : body.maxSources;
    if (typeof maxSources !== "number" || !Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > config.research.maximumSources) throw new AppError("invalid_research", `maxSources must be between 1 and ${config.research.maximumSources}`, 400);
    return json(store.createResearch(body.query, urls, maxSources), 202);
  }
  if (request.method === "GET" && researchMatch) { const id = Number(researchMatch[1]); return json({ research: store.getResearch(id), sources: store.researchSources(id) }); }
  if (request.method === "POST" && researchCancelMatch) return json(store.cancelResearch(Number(researchCancelMatch[1])));
  if (request.method === "POST" && researchRetryMatch) return json(store.retryResearch(Number(researchRetryMatch[1])));
  if (request.method === "GET" && url.pathname === "/api/v1/web-captures") return json({ captures: store.listWebCaptures() });
  if (request.method === "POST" && url.pathname === "/api/v1/web-captures") {
    if (!config.webCapture.enabled || !config.documentRag.enabled) throw new AppError("web_capture_disabled", "web capture and document ingestion must be enabled", 503);
    const value = await readJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_web_capture", "request body must be an object", 400);
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "url")) throw new AppError("invalid_web_capture", "only url is accepted", 400);
    if (typeof body.url !== "string") throw new AppError("invalid_web_url", "url is required", 400);
    return json(store.createWebCapture(normalizeWebUrl(body.url), apiSource(request)), 202);
  }
  if (request.method === "GET" && webCaptureMatch) { const id = Number(webCaptureMatch[1]); return json({ capture: store.getWebCapture(id), snapshots: store.listWebCaptureSnapshots(id) }); }
  if (request.method === "POST" && webCaptureCancelMatch) return json(store.cancelWebCapture(Number(webCaptureCancelMatch[1])));
  if (request.method === "POST" && webCaptureRetryMatch) return json(store.retryWebCapture(Number(webCaptureRetryMatch[1])));
  if (request.method === "POST" && webCaptureRefreshMatch) return json(store.refreshWebCapture(Number(webCaptureRefreshMatch[1])));
  if (request.method === "PUT" && webCaptureScheduleMatch) {
    const value = await readJson(request);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "refreshIntervalSeconds")) throw new AppError("invalid_refresh_schedule", "request must contain only refreshIntervalSeconds", 400);
    const interval = (value as Record<string, unknown>).refreshIntervalSeconds;
    if (interval !== null && typeof interval !== "number") throw new AppError("invalid_refresh_schedule", "refreshIntervalSeconds must be an integer or null", 400);
    return json(store.scheduleWebCapture(Number(webCaptureScheduleMatch[1]), interval as number | null));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/documents/ocr/status") return json(await ocrRuntimeStatus(config.documentRag));
  if (request.method === "GET" && url.pathname === "/api/v1/documents") return json({ documents: store.listDocuments() });
  if (request.method === "POST" && url.pathname === "/api/v1/documents") {
    if (!config.documentRag.enabled) throw new AppError("document_rag_disabled", "document ingestion is disabled", 503);
    const filename = url.searchParams.get("filename") ?? "";
    const inputMime = request.headers.get("content-type") ?? "application/octet-stream";
    const format = documentFormat(filename, inputMime);
    const bytes = await readDocumentBytes(request, config.documentRag.maxFileBytes);
    return json(store.createDocument(filename, canonicalDocumentMime(format), format, bytes, apiSource(request), config.documentRag.maxFileBytes), 202);
  }
  if (request.method === "GET" && documentContentMatch) {
    const documentId = Number(documentContentMatch[1]);
    const version = optionalPositiveInteger(url.searchParams.get("version"));
    const offset = nonNegativeInteger(url.searchParams.get("offset"));
    const limit = numberParam(url.searchParams.get("limit"), 50);
    const sections = store.documentSections(documentId, version, offset, limit);
    const nextOffset = offset + sections.length < store.documentSectionCount(documentId, version) ? offset + sections.length : null;
    return json({ sections, nextOffset });
  }
  if (request.method === "GET" && documentDownloadMatch) return documentDownloadResponse(store, Number(documentDownloadMatch[1]));
  if (request.method === "POST" && documentReviewMatch) return json(store.acknowledgeDocumentReview(Number(documentReviewMatch[1])));
  if (request.method === "POST" && documentCancelMatch) return json(store.cancelDocument(Number(documentCancelMatch[1])));
  if (request.method === "POST" && documentRetryMatch) return json(store.retryDocument(Number(documentRetryMatch[1])));
  if (request.method === "GET" && documentVersionsMatch) return json({ versions: store.listDocumentVersions(Number(documentVersionsMatch[1])) });
  if (request.method === "POST" && documentVersionsMatch) {
    if (!config.documentRag.enabled) throw new AppError("document_rag_disabled", "document ingestion is disabled", 503);
    const filename = url.searchParams.get("filename") ?? "";
    const inputMime = request.headers.get("content-type") ?? "application/octet-stream";
    const format = documentFormat(filename, inputMime);
    const bytes = await readDocumentBytes(request, config.documentRag.maxFileBytes);
    return json(store.replaceDocument(Number(documentVersionsMatch[1]), filename, canonicalDocumentMime(format), format, bytes, config.documentRag.maxFileBytes), 202);
  }
  if (request.method === "GET" && documentMatch) return json(store.getDocument(Number(documentMatch[1])));
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

  if (request.method === "POST" && url.pathname === "/api/v1/answer") return json(await answerQuestion(store, embedder, config.ragAnswer, answerInput(await readJson(request)), request.signal));
  if (request.method === "GET" && url.pathname === "/api/v1/semantic/status") return json(store.semanticStatus(config.semanticSearch.enabled, config.semanticSearch.embeddingModel, config.semanticSearch.embeddingDimensions));
  if (request.method === "GET" && url.pathname === "/api/v1/tags/definitions") return json({ tags: store.listTagDefinitions() });
  if (request.method === "POST" && url.pathname === "/api/v1/tags/definitions") {
    const body = await readJson(request) as Record<string, unknown>;
    const kind = tagKind(body.kind);
    if (typeof body.tag !== "string" || typeof body.displayName !== "string") throw new AppError("invalid_tag_definition", "tag and displayName are required", 400);
    if (body.aliases !== undefined && (!Array.isArray(body.aliases) || body.aliases.some((alias) => typeof alias !== "string"))) throw new AppError("invalid_tag_definition", "aliases must be strings", 400);
    return json(store.defineTag(body.tag, kind, body.displayName, body.aliases as string[] | undefined, typeof body.description === "string" ? body.description : null), 201);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/search") {
    const limit = numberParam(url.searchParams.get("limit"), 20);
    const tags = (url.searchParams.get("tags") ?? "").split(",").filter(Boolean);
    const status = statusParam(url.searchParams.get("status"), "published");
    const properties = parsePropertiesInput(url.searchParams.get("properties") ?? "{}");
    return json(await searchWithFallback(store, embedder, url.searchParams.get("mode"), url.searchParams.get("q") ?? "", tags, url.searchParams.get("cursor"), limit, status, properties, documentSearchFilters(url.searchParams), request.signal));
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

async function webRoute(request: Request, url: URL, store: PageStore, config: Config, embedder: OllamaEmbedder | null): Promise<Response> {
  const attachmentMaxBytes = config.attachmentMaxBytes;
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
  if (request.method === "GET" && url.pathname === "/answer") {
    return html(layout("Answer", answerForm(csrf, "", "all", config.ragAnswer.includeGeneralKnowledge), csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/answer") {
    await verifyCsrf(request);
    const form = await request.formData();
    const question = String(form.get("question") ?? "");
    const source = String(form.get("source") ?? "all");
    const includeGeneralKnowledge = form.get("include_general_knowledge") === "on";
    const filters = documentSearchFilters(new URLSearchParams({ source }));
    const result = await answerQuestion(store, embedder, config.ragAnswer, { question, includeGeneralKnowledge, filters }, request.signal);
    return html(layout("Answer", `${answerForm(csrf, question, source, includeGeneralKnowledge)}${answerResultView(result)}`, csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/search") {
    const query = url.searchParams.get("q") ?? "";
    const tagsText = url.searchParams.get("tags") ?? "";
    const tags = tagsText.split(",").filter(Boolean);
    const status = statusParam(url.searchParams.get("status"), "published");
    const propertiesText = url.searchParams.get("properties") ?? "";
    const properties = propertiesText.trim() ? parsePropertiesInput(propertiesText) : {};
    const mode = url.searchParams.get("mode") === "lexical" ? "lexical" : "hybrid";
    const documentFilters = documentSearchFilters(url.searchParams);
    const hasFilters = documentFilters.source !== "all" || Object.keys(documentFilters).length > 1;
    const results = query.trim() || tags.length || Object.keys(properties).length || hasFilters ? await searchWithFallback(store, embedder, mode, query, tags, url.searchParams.get("cursor"), 20, status, properties, documentFilters, request.signal) : null;
    return html(layout("Search", searchView(query, tagsText, status, propertiesText, mode, documentFilters, results), csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/explore") {
    const overview = store.exploreOverview(12);
    const tags = store.listTags().sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag)).slice(0, 20).map(({ tag, count }) => `<a class="tag" href="/tags/${encodeURIComponent(tag)}">${escapeHtml(tag)} <small>${count}</small></a>`).join(" ");
    const recent = overview.recent.map((page) => navigationPageItem(page)).join("");
    const linked = overview.mostLinked.map((page) => navigationPageItem(page, `${page.incomingLinks} incoming link${page.incomingLinks === 1 ? "" : "s"}`)).join("");
    const unconnected = overview.unconnected.map((page) => navigationPageItem(page)).join("");
    return html(layout("Explore", `<div class="title-row"><div><h1>Explore</h1><p>Navigate by activity, relationships, hierarchy, and tags.</p></div><a class="button secondary" href="/tree?status=all">Open page tree</a></div><div class="explore-grid"><section><h2>Recently updated</h2>${recent ? `<ul class="navigation-list">${recent}</ul>` : "<p>No pages yet.</p>"}</section><section><h2>Most linked</h2>${linked ? `<ul class="navigation-list">${linked}</ul>` : "<p>No linked pages yet.</p>"}</section><section><h2>Unconnected pages</h2><p><small>Root pages with no incoming wiki-link.</small></p>${unconnected ? `<ul class="navigation-list">${unconnected}</ul>` : "<p>Every root page has an incoming link.</p>"}</section><section><h2>Popular tags</h2><div class="tag-cloud">${tags || "<p>No tags yet.</p>"}</div><p><a href="/tags">Browse all tags</a></p></section></div>`, csrf), 200, headers);
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
  if (request.method === "GET" && url.pathname === "/research") {
    const items = store.listResearch().map((job) => `<li><a href="/research/${job.id}">${escapeHtml(job.query)}</a><small>${escapeHtml(job.status)} · ${formatDate(job.updatedAt)}${job.lastError ? ` · ${escapeHtml(job.lastError)}` : ""}</small></li>`).join("");
    return html(layout("Research", `<h1>Research</h1><p>Provide URLs explicitly, or configure <code>research.search_command</code> for discovery.</p><form method="post" action="/research"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Question or topic<textarea name="query" required></textarea></label><label>Source URLs <small>one per line; optional when discovery is configured</small><textarea name="urls"></textarea></label><label>Maximum sources<input type="number" name="max_sources" min="1" max="${config.research.maximumSources}" value="${config.research.defaultMaxSources}"></label><button type="submit">Queue research</button></form>${items ? `<ul class="page-list">${items}</ul>` : "<p>No research jobs yet.</p>"}`, csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/research") {
    await verifyCsrf(request);
    if (!config.research.enabled || !config.webCapture.enabled || !config.documentRag.enabled || !config.ragAnswer.enabled) throw new AppError("research_disabled", "research dependencies are disabled", 503);
    const form = await request.formData();
    const urls = String(form.get("urls") ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map(normalizeWebUrl);
    const maxSources = Number(form.get("max_sources") ?? config.research.defaultMaxSources);
    if (!Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > config.research.maximumSources) throw new AppError("invalid_research", "maximum sources is invalid", 400);
    const job = store.createResearch(String(form.get("query") ?? ""), urls, maxSources);
    return redirect(`/research/${job.id}`);
  }
  const researchWebMatch = /^\/research\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && researchWebMatch) {
    const id = Number(researchWebMatch[1]);
    const job = store.getResearch(id);
    const sources = store.researchSources(id).map((source) => `<li><a href="${escapeHtml(source.url)}" rel="noreferrer">${escapeHtml(source.title ?? source.url)}</a><small>${escapeHtml(source.status)}${source.documentId ? ` · document ${source.documentId}` : ""}</small></li>`).join("");
    const actions = job.status === "queued" || job.status === "researching" ? `<form method="post" action="/research/${id}/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Cancel</button></form>` : job.status === "failed" || job.status === "cancelled" ? `<form method="post" action="/research/${id}/retry"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Retry</button></form>` : "";
    return html(layout(`Research ${id}`, `<p><a href="/research">← Research</a></p><h1>${escapeHtml(job.query)}</h1><p>Status: <strong>${escapeHtml(job.status)}</strong></p>${job.lastError ? `<p class="error">${escapeHtml(job.lastError)}</p>` : ""}${actions}<h2>Sources</h2>${sources ? `<ul class="page-list">${sources}</ul>` : "<p>Sources have not been selected yet.</p>"}${researchResultView(job.result)}`, csrf), 200, headers);
  }
  const researchActionMatch = /^\/research\/(\d+)\/(cancel|retry)$/.exec(url.pathname);
  if (request.method === "POST" && researchActionMatch) {
    await verifyCsrf(request);
    const id = Number(researchActionMatch[1]);
    if (researchActionMatch[2] === "cancel") store.cancelResearch(id); else store.retryResearch(id);
    return redirect(`/research/${id}`);
  }
  if (request.method === "GET" && url.pathname === "/web-captures") {
    const items = store.listWebCaptures().map((capture) => `<li><a href="/wiki/${encodeURIComponent(store.getById(capture.pageId).alias)}">${escapeHtml(capture.title ?? capture.url)}</a><small>${escapeHtml(capture.status)} · ${escapeHtml(capture.finalUrl ?? capture.url)}${capture.lastError ? ` · ${escapeHtml(capture.lastError)}` : ""}</small></li>`).join("");
    return html(layout("Web captures", `<h1>Web captures</h1><form method="post" action="/web-captures"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Public HTTP(S) URL<input type="url" name="url" required placeholder="https://example.com/article"></label><button type="submit">Queue capture</button></form>${items ? `<ul class="page-list">${items}</ul>` : "<p>No web captures yet.</p>"}`, csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/web-captures") {
    await verifyCsrf(request);
    if (!config.webCapture.enabled || !config.documentRag.enabled) throw new AppError("web_capture_disabled", "web capture and document ingestion must be enabled", 503);
    const form = await request.formData();
    const capture = store.createWebCapture(normalizeWebUrl(String(form.get("url") ?? "")), "web");
    return redirect(`/wiki/${encodeURIComponent(store.getById(capture.pageId).alias)}`);
  }
  if (request.method === "GET" && url.pathname === "/documents") {
    const items = store.listDocuments().map((document) => `<li><a href="/wiki/${encodeURIComponent(store.getById(document.pageId).alias)}">${escapeHtml(document.filename)}</a><small>${escapeHtml(document.format.toUpperCase())} · version ${document.currentVersion.version} · ${escapeHtml(document.status)} · OCR ${escapeHtml(document.ocrStatus)}${document.needsOcr ? " (pending)" : ""}</small></li>`).join("");
    return html(layout("Documents", `<div class="title-row"><h1>Documents</h1><a class="button" href="/documents/import">Import document</a></div>${items ? `<ul class="page-list">${items}</ul>` : "<p>No documents yet.</p>"}`, csrf), 200, headers);
  }
  if (request.method === "GET" && url.pathname === "/documents/import") {
    return html(layout("Import document", `<h1>Import document</h1><p>Supported formats: DOCX, XLSX, PPTX, PDF, Markdown, and TXT.</p><form method="post" enctype="multipart/form-data" action="/documents/import"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Document<input type="file" name="file" accept=".docx,.xlsx,.pptx,.pdf,.md,.markdown,.txt" required></label><button type="submit">Queue import</button></form>`, csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/documents/import") {
    await verifyCsrf(request);
    if (!config.documentRag.enabled) throw new AppError("document_rag_disabled", "document ingestion is disabled", 503);
    requireBoundedMultipart(request, config.documentRag.maxFileBytes);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("document_required", "choose a document", 400);
    if (file.size > config.documentRag.maxFileBytes) throw new AppError("document_too_large", `document exceeds the technical ${config.documentRag.maxFileBytes} byte guard`, 413);
    const format = documentFormat(file.name, file.type);
    const document = store.createDocument(file.name, canonicalDocumentMime(format), format, new Uint8Array(await file.arrayBuffer()), "web", config.documentRag.maxFileBytes);
    return redirect(`/wiki/${encodeURIComponent(store.getById(document.pageId).alias)}`);
  }
  const webCaptureJobMatch = /^\/web-captures\/(\d+)\/(cancel|retry|refresh)$/.exec(url.pathname);
  if (request.method === "POST" && webCaptureJobMatch) {
    await verifyCsrf(request);
    const capture = webCaptureJobMatch[2] === "cancel" ? store.cancelWebCapture(Number(webCaptureJobMatch[1])) : webCaptureJobMatch[2] === "retry" ? store.retryWebCapture(Number(webCaptureJobMatch[1])) : store.refreshWebCapture(Number(webCaptureJobMatch[1]));
    return redirect(`/wiki/${encodeURIComponent(store.getById(capture.pageId).alias)}`);
  }
  const webCaptureScheduleWebMatch = /^\/web-captures\/(\d+)\/schedule$/.exec(url.pathname);
  if (request.method === "POST" && webCaptureScheduleWebMatch) {
    await verifyCsrf(request);
    const form = await request.formData();
    const input = String(form.get("interval") ?? "off");
    const capture = store.scheduleWebCapture(Number(webCaptureScheduleWebMatch[1]), input === "off" ? null : Number(input));
    return redirect(`/wiki/${encodeURIComponent(store.getById(capture.pageId).alias)}`);
  }
  const documentJobWebMatch = /^\/documents\/(\d+)\/(cancel|retry)$/.exec(url.pathname);
  if (request.method === "POST" && documentJobWebMatch) {
    await verifyCsrf(request);
    const document = documentJobWebMatch[2] === "cancel" ? store.cancelDocument(Number(documentJobWebMatch[1])) : store.retryDocument(Number(documentJobWebMatch[1]));
    return redirect(`/wiki/${encodeURIComponent(store.getById(document.pageId).alias)}`);
  }
  const documentReviewWebMatch = /^\/documents\/(\d+)\/review$/.exec(url.pathname);
  if (request.method === "POST" && documentReviewWebMatch) {
    await verifyCsrf(request);
    const document = store.acknowledgeDocumentReview(Number(documentReviewWebMatch[1]));
    return redirect(`/wiki/${encodeURIComponent(store.getById(document.pageId).alias)}`);
  }
  const documentDownloadWebMatch = /^\/documents\/(\d+)\/download$/.exec(url.pathname);
  if (request.method === "GET" && documentDownloadWebMatch) return documentDownloadResponse(store, Number(documentDownloadWebMatch[1]));
  const documentContentWebMatch = /^\/documents\/(\d+)\/content$/.exec(url.pathname);
  if (request.method === "GET" && documentContentWebMatch) {
    const documentId = Number(documentContentWebMatch[1]);
    const document = store.getDocument(documentId);
    const offset = nonNegativeInteger(url.searchParams.get("offset"));
    const sections = store.documentSections(documentId, undefined, offset, 50);
    const total = store.documentSectionCount(documentId);
    const content = sections.map((item) => { const citation = `/documents/${documentId}/content?offset=${Math.floor(item.ordinal / 50) * 50}#section-${item.ordinal}`; return `<section class="document-section" id="section-${item.ordinal}"><h2>${escapeHtml(item.locator.label)}${item.hidden ? " <small>(hidden)</small>" : ""}${item.needsOcr ? " <small>(OCR pending)</small>" : ""}</h2><p><small>${escapeHtml(locatorDetails(item.locator))} · <a href="${citation}">citation §${item.ordinal + 1}</a></small></p><pre>${escapeHtml(item.text)}</pre></section>`; }).join("");
    const previous = offset > 0 ? `<a class="button secondary" href="/documents/${documentId}/content?offset=${Math.max(0, offset - 50)}">Previous</a>` : "";
    const next = offset + sections.length < total ? `<a class="button secondary" href="/documents/${documentId}/content?offset=${offset + sections.length}">Next</a>` : "";
    return html(layout(`Content · ${document.filename}`, `<p><a href="/wiki/${encodeURIComponent(store.getById(document.pageId).alias)}">← ${escapeHtml(document.filename)}</a></p><h1>Extracted content</h1><p>${total} sections · showing ${total ? offset + 1 : 0}–${offset + sections.length}</p>${content || "<p>No extracted text.</p>"}<div class="page-actions">${previous}${next}</div>`, csrf), 200, headers);
  }
  const documentReplaceMatch = /^\/documents\/(\d+)\/replace$/.exec(url.pathname);
  if (request.method === "POST" && documentReplaceMatch) {
    await verifyCsrf(request);
    requireBoundedMultipart(request, config.documentRag.maxFileBytes);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("document_required", "choose a document", 400);
    if (file.size > config.documentRag.maxFileBytes) throw new AppError("document_too_large", `document exceeds the technical ${config.documentRag.maxFileBytes} byte guard`, 413);
    const format = documentFormat(file.name, file.type);
    const document = store.replaceDocument(Number(documentReplaceMatch[1]), file.name, canonicalDocumentMime(format), format, new Uint8Array(await file.arrayBuffer()), config.documentRag.maxFileBytes);
    return redirect(`/wiki/${encodeURIComponent(store.getById(document.pageId).alias)}`);
  }
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
    return html(layout("New page", pageForm({ title, alias, body: "", tags: [], status: "published", parentId: null, properties: {} }, csrf, store.parentCandidates(), store), csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/preview") {
    await verifyCsrf(request);
    const fields = await readForm(request);
    return html(renderPageMarkdown(store, String(fields.get("body") ?? "")));
  }
  if (request.method === "POST" && url.pathname === "/pages") {
    await verifyCsrf(request);
    const fields = await readForm(request);
    const page = store.create(formPage(fields), "web");
    return redirect(`/wiki/${encodeURIComponent(page.alias)}`);
  }
  if (request.method === "GET" && url.pathname === "/taxonomy") {
    const items = store.listTagDefinitions().map((tag) => `<tr><td><a href="/tags/${encodeURIComponent(tag.tag)}">${escapeHtml(tag.tag)}</a></td><td>${escapeHtml(tag.kind)}</td><td>${escapeHtml(tag.displayName)}</td><td>${tag.usageCount}</td><td>${escapeHtml(tag.aliases.join(", "))}</td></tr>`).join("");
    return html(layout("Tag taxonomy", `<h1>Tag taxonomy</h1><form method="post" action="/taxonomy"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><div class="form-grid"><label>Canonical tag<input name="tag" required></label><label>Kind<select name="kind"><option>topic</option><option>entity</option><option>source</option><option>type</option><option>custom</option></select></label></div><label>Display name<input name="displayName" required></label><label>Aliases <small>comma-separated</small><input name="aliases"></label><label>Description<input name="description"></label><button type="submit">Save tag</button></form>${items ? `<table><thead><tr><th>Tag</th><th>Kind</th><th>Name</th><th>Uses</th><th>Aliases</th></tr></thead><tbody>${items}</tbody></table>` : "<p>No tag definitions yet.</p>"}`, csrf), 200, headers);
  }
  if (request.method === "POST" && url.pathname === "/taxonomy") {
    await verifyCsrf(request);
    const fields = await readForm(request);
    store.defineTag(String(fields.get("tag") ?? ""), tagKind(fields.get("kind")), String(fields.get("displayName") ?? ""), String(fields.get("aliases") ?? "").split(","), String(fields.get("description") ?? "") || null);
    return redirect("/taxonomy");
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
    return html(layout(`Edit ${page.title}`, pageForm(page, csrf, store.parentCandidates(page.id), store), csrf), 200, headers);
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

function renderPageMarkdown(store: PageStore, body: string): string {
  return renderMarkdown(body, (alias) => {
    try { store.getByAlias(alias); return "active"; } catch {
      try { return { state: "deleted" as const, id: store.getDeletedByAlias(alias).id }; } catch { return "missing"; }
    }
  });
}

function pageView(page: Page, store: PageStore, csrf: string): string {
  const content = renderPageMarkdown(store, page.body);
  const tags = page.tags.map((tag) => `<a class="tag" href="/tags/${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join(" ");
  const breadcrumbs = page.breadcrumbs.map((crumb) => `<a href="/wiki/${encodeURIComponent(crumb.alias)}">${escapeHtml(crumb.title)}</a>`).join(" <span aria-hidden=\"true\">›</span> ");
  const properties = Object.entries(page.properties).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td><code>${escapeHtml(JSON.stringify(value))}</code></td></tr>`).join("");
  const backlinks = page.backlinks.map((link) => `<li><a href="/wiki/${encodeURIComponent(link.alias)}">${escapeHtml(link.title)}</a></li>`).join("");
  const children = store.pageChildren(page.id).map((child) => `<li><a href="/wiki/${encodeURIComponent(child.alias)}">${escapeHtml(child.title)}</a>${child.status !== "published" ? ` <span class="status status-${child.status}">${child.status}</span>` : ""}</li>`).join("");
  const outgoing = store.outgoingPageLinks(page.id).map((link) => link.state === "active" ? `<li><a href="/wiki/${encodeURIComponent(link.alias)}">${escapeHtml(link.title)}</a></li>` : link.state === "deleted" ? `<li><a class="deleted" href="/trash/${link.id}">${escapeHtml(link.title)}</a> <small>deleted</small></li>` : `<li><a class="missing" href="/new?${escapeHtml(new URLSearchParams({ alias: link.alias, title: link.alias }).toString())}">${escapeHtml(link.alias)}</a> <small>missing</small></li>`).join("");
  const related = store.relatedPages(page.id).map((item) => `<li><a href="/wiki/${encodeURIComponent(item.alias)}">${escapeHtml(item.title)}</a>${item.status !== "published" ? ` <span class="status status-${item.status}">${item.status}</span>` : ""}<small>${escapeHtml(item.sharedTags.join(", "))}</small></li>`).join("");
  const relationships = `<aside class="relationships"><h2>Navigate from this page</h2><div class="relationship-grid"><section><h3>Children</h3>${children ? `<ul>${children}</ul>` : "<p>No child pages.</p>"}</section><section><h3>Links from here</h3>${outgoing ? `<ul>${outgoing}</ul>` : "<p>No outgoing wiki-links.</p>"}</section><section><h3>Backlinks</h3>${backlinks ? `<ul>${backlinks}</ul>` : "<p>No pages link here.</p>"}</section><section><h3>Related by tag</h3>${related ? `<ul>${related}</ul>` : "<p>No related tagged pages.</p>"}</section></div></aside>`;
  const webCapture = store.webCaptureForPage(page.id);
  const webCaptureContent = webCapture ? `<aside><h2>Web source</h2><p><a href="${escapeHtml(webCapture.finalUrl ?? webCapture.url)}" rel="noreferrer">${escapeHtml(webCapture.finalUrl ?? webCapture.url)}</a></p><p>Status: <strong>${escapeHtml(webCapture.status)}</strong>${webCapture.fetchedAt ? ` · captured ${formatDate(webCapture.fetchedAt)}` : ""}${webCapture.lastCheckedAt ? ` · checked ${formatDate(webCapture.lastCheckedAt)}` : ""}</p>${webCapture.lastError ? `<p class="error">${escapeHtml(webCapture.lastError)}</p>` : ""}<div class="page-actions">${webCapture.status === "queued" || webCapture.status === "fetching" ? `<form method="post" action="/web-captures/${webCapture.id}/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Cancel capture</button></form>` : webCapture.status === "failed" || webCapture.status === "cancelled" ? `<form method="post" action="/web-captures/${webCapture.id}/retry"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Retry capture</button></form>` : `<form method="post" action="/web-captures/${webCapture.id}/refresh"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Refresh now</button></form>`}</div><form method="post" action="/web-captures/${webCapture.id}/schedule"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Automatic refresh<select name="interval"><option value="off"${webCapture.refreshIntervalSeconds === null ? " selected" : ""}>Off</option><option value="3600"${webCapture.refreshIntervalSeconds === 3600 ? " selected" : ""}>Hourly</option><option value="86400"${webCapture.refreshIntervalSeconds === 86400 ? " selected" : ""}>Daily</option><option value="604800"${webCapture.refreshIntervalSeconds === 604800 ? " selected" : ""}>Weekly</option></select></label><button class="secondary" type="submit">Save schedule</button></form></aside>` : "";
  const document = store.documentForPage(page.id);
  const documentContent = document ? documentView(document, store, csrf) : "";
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
    ${relationships}
    ${webCaptureContent}
    ${documentContent}
    ${properties ? `<details class="properties"><summary>Properties</summary><table>${properties}</table></details>` : ""}
  </article>
  <aside class="attachments"><h2>Attachments</h2>${attachmentItems ? `<ul>${attachmentItems}</ul>` : "<p>No attachments.</p>"}<form class="attachment-upload" method="post" enctype="multipart/form-data" action="/wiki/${encodeURIComponent(page.alias)}/attachments"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Add file<input type="file" name="file" required></label><button type="submit">Upload</button></form></aside>`;
}

function locatorDetails(locator: DocumentLocator): string {
  const parts: string[] = [];
  if (locator.page !== undefined) parts.push(`page ${locator.page}`);
  if (locator.slide !== undefined) parts.push(`slide ${locator.slide}`);
  if (locator.sheet) parts.push(`sheet ${locator.sheet}`);
  if (locator.range) parts.push(`range ${locator.range}`);
  if (locator.heading) parts.push(`heading ${locator.heading}`);
  if (locator.image) parts.push(`image ${locator.image}`);
  if (locator.part) parts.push(locator.part);
  return parts.length ? parts.join(" · ") : locator.label;
}

function documentView(document: ReturnType<PageStore["getDocument"]>, store: PageStore, csrf: string): string {
  const warnings = document.currentVersion.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const sectionCount = document.status === "ready" ? store.documentSectionCount(document.id) : 0;
  return `<aside class="document-content"><div class="page-header"><div><h2>Document content</h2><p>${escapeHtml(document.filename)} · ${escapeHtml(document.format.toUpperCase())} · version ${document.currentVersion.version} · <strong>${escapeHtml(document.status)}</strong> · OCR ${escapeHtml(document.ocrStatus)}${document.needsOcr ? " (pending)" : ""}${document.needsReview ? " · needs review" : ""}</p></div><a class="button secondary" href="/documents/${document.id}/download">Download original</a></div>${document.lastError ? `<p class="warning">${escapeHtml(document.lastError)}</p>` : ""}${document.status === "queued" || document.status === "extracting" ? `<form method="post" action="/documents/${document.id}/cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Cancel extraction</button></form>` : ""}${document.status === "failed" || document.status === "cancelled" || (document.status === "ready" && document.needsOcr) ? `<form method="post" action="/documents/${document.id}/retry"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Retry extraction</button></form>` : ""}${document.needsReview ? `<form method="post" action="/documents/${document.id}/review"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><p class="notice">Human page fields were preserved during replacement.</p><button type="submit">Mark reviewed</button></form>` : ""}${warnings ? `<ul>${warnings}</ul>` : ""}<form method="post" enctype="multipart/form-data" action="/documents/${document.id}/replace"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Replace with a new version<input type="file" name="file" accept=".docx,.xlsx,.pptx,.pdf,.md,.markdown,.txt" required></label><button type="submit">Queue replacement</button></form>${sectionCount ? `<p><a class="button secondary" href="/documents/${document.id}/content">View extracted text (${sectionCount} sections)</a></p>` : `<p>Extraction is ${escapeHtml(document.status)}.</p>`}</aside>`;
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

function navigationPageItem(page: PageSummary, detail = formatDate(page.updatedAt)): string {
  return `<li><a href="/wiki/${encodeURIComponent(page.alias)}">${escapeHtml(page.title)}</a>${page.status !== "published" ? ` <span class="status status-${page.status}">${page.status}</span>` : ""}<small>${escapeHtml(detail)}</small></li>`;
}

function pageList(title: string, pages: PageSummary[], empty: string): string {
  const items = pages.map((page) => `<li><a href="/wiki/${encodeURIComponent(page.alias)}">${escapeHtml(page.title)}</a>${page.status !== "published" ? ` <span class="status status-${page.status}">${page.status}</span>` : ""}<small>${escapeHtml(page.alias)} · ${formatDate(page.updatedAt)}</small></li>`).join("");
  return `<h1>${title}</h1>${items ? `<ul class="page-list">${items}</ul>` : `<p>${empty}</p>`}`;
}

function answerForm(csrf: string, question: string, source: string, includeGeneralKnowledge: boolean): string {
  return `<h1>Answer from your knowledge base</h1><form method="post" action="/answer"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Question<textarea name="question" rows="4" maxlength="4000" required>${escapeHtml(question)}</textarea></label><label>Source<select name="source"><option value="all"${source === "all" ? " selected" : ""}>Pages and documents</option><option value="pages"${source === "pages" ? " selected" : ""}>Pages</option><option value="documents"${source === "documents" ? " selected" : ""}>Documents</option></select></label><label><input type="checkbox" name="include_general_knowledge"${includeGeneralKnowledge ? " checked" : ""}> Include clearly separated general model knowledge</label><button type="submit">Answer</button></form>`;
}

function researchResultView(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const answer = (result as { answer?: unknown }).answer;
  if (!answer || typeof answer !== "object" || typeof (answer as { answer?: unknown }).answer !== "string" || !Array.isArray((answer as { citations?: unknown }).citations)) return `<h2>Result</h2><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  return `<h2>Research synthesis</h2>${answerResultView(answer as AnswerResult)}`;
}

function answerResultView(result: AnswerResult): string {
  const citations = result.citations.map((citation) => `<li><a href="${escapeHtml(citation.url)}">${escapeHtml(citation.id)} · ${escapeHtml(citation.title)} · ${escapeHtml(citation.locator)}</a><p>${escapeHtml(citation.excerpt)}</p></li>`).join("");
  return `<section class="answer-result"><h2>Document-backed answer</h2>${result.abstained ? "<p class=\"notice\">There was not enough validated evidence to answer.</p>" : `<div class="markdown">${renderMarkdown(result.answer, () => false)}</div>`}${result.generalKnowledge ? `<aside><h2>General model knowledge</h2><p class="notice">This section is not supported by your nwp evidence.</p><div class="markdown">${renderMarkdown(result.generalKnowledge, () => false)}</div></aside>` : ""}<h2>Citations</h2>${citations ? `<ol class="search-results">${citations}</ol>` : "<p>No citations.</p>"}<p><small>Model: ${escapeHtml(result.model)} · retrieval: ${escapeHtml(result.retrievalMode)}</small></p>${result.warning ? `<p class="notice">${escapeHtml(result.warning)}</p>` : ""}</section>`;
}

function searchView(query: string, tags: string, status: PageStatus | "all", properties: string, mode: "hybrid" | "lexical", filters: DocumentSearchFilters, results: SearchResults | null): string {
  const option = (value: string, label: string, selected: string | undefined) => `<option value="${value}"${value === (selected ?? "") ? " selected" : ""}>${label}</option>`;
  const form = `<h1>Search</h1><form class="search-page" method="get" action="/search">
    <label>Text<input type="search" name="q" value="${escapeHtml(query)}" autofocus></label>
    <label>Source<select name="source">${option("all", "Pages and documents", filters.source)}${option("pages", "Pages", filters.source)}${option("documents", "Documents", filters.source)}</select></label>
    <label>Tags <small>comma-separated; all must match</small><input name="tags" value="${escapeHtml(tags)}"></label>
    <label>Status<select name="status">${statusOptions(status, true)}</select></label>
    <label>Mode<select name="mode"><option value="hybrid"${mode === "hybrid" ? " selected" : ""}>Hybrid</option><option value="lexical"${mode === "lexical" ? " selected" : ""}>Lexical</option></select></label>
    <label>Format<select name="format">${option("", "Any", filters.format)}${["docx", "xlsx", "pptx", "pdf", "markdown", "text"].map((value) => option(value, value.toUpperCase(), filters.format)).join("")}</select></label>
    <label>Section<select name="kind">${option("", "Any", filters.kind)}${["heading", "paragraph", "table", "slide", "notes", "sheet", "page", "image", "text"].map((value) => option(value, value, filters.kind)).join("")}</select></label>
    <label>OCR<select name="ocr_status">${option("", "Any", filters.ocrStatus)}${["not_required", "pending", "completed", "partial", "unavailable"].map((value) => option(value, value, filters.ocrStatus)).join("")}</select></label>
    <label>Visibility<select name="hidden">${option("", "Visible and hidden", filters.hidden === undefined ? "" : String(filters.hidden))}${option("false", "Visible", filters.hidden === undefined ? "" : String(filters.hidden))}${option("true", "Hidden", filters.hidden === undefined ? "" : String(filters.hidden))}</select></label>
    <label>Document ID<input type="number" min="1" name="document_id" value="${filters.documentId ?? ""}"></label>
    <label>Version<input type="number" min="1" name="version" value="${filters.version ?? ""}"></label>
    <label>Updated after<input type="date" name="updated_after" value="${escapeHtml(filters.updatedAfter?.slice(0, 10) ?? "")}"></label>
    <label>Updated before<input type="date" name="updated_before" value="${escapeHtml(filters.updatedBefore?.slice(0, 10) ?? "")}"></label>
    <label>Properties <small>JSON object, exact values</small><input name="properties" value="${escapeHtml(properties)}" placeholder='{"owner":"team"}'></label>
    <button type="submit">Search</button>
  </form>`;
  if (!results) return `${form}<p>Enter text or filters.</p>`;
  const items = (results.hits ?? results.pages.map((page) => ({ source: "page" as const, page }))).map((hit) => {
    if (hit.source === "page") return `<li><a href="/wiki/${encodeURIComponent(hit.page.alias)}">${escapeHtml(hit.page.title)}</a><small>Page · ${escapeHtml(hit.page.alias)} · ${formatDate(hit.page.updatedAt)}</small>${hit.page.excerpt ? `<p>${escapeHtml(hit.page.excerpt)}</p>` : ""}</li>`;
    const item = hit.document;
    const citation = `/documents/${item.documentId}/content?offset=${Math.floor(item.ordinal / 50) * 50}#section-${item.ordinal}`;
    return `<li><a href="${citation}">${escapeHtml(item.filename)} · ${escapeHtml(item.locator.label)}</a><small>Document · ${escapeHtml(item.format.toUpperCase())} · version ${item.version} · ${escapeHtml(item.kind)}${item.hidden ? " · hidden" : ""} · OCR ${escapeHtml(item.ocrStatus)}</small>${item.excerpt ? `<p>${escapeHtml(item.excerpt)}</p>` : ""}</li>`;
  }).join("");
  const nextParams = new URLSearchParams({ q: query, tags, status, mode, properties, ...documentFilterQuery(filters), ...(results.nextCursor ? { cursor: results.nextCursor } : {}) });
  const next = results.nextCursor ? `<p><a class="button secondary" href="/search?${nextParams}">More results</a></p>` : "";
  const notice = results.warning ? `<p class="notice">${escapeHtml(results.warning)}</p>` : `<p><small>Search mode: ${results.mode ?? "lexical"}</small></p>`;
  return `${form}${notice}${items ? `<ul class="page-list search-results">${items}</ul>${next}` : "<p>No matches.</p>"}`;
}

function pageForm(page: Pick<Page, "title" | "alias" | "body" | "tags" | "status" | "parentId" | "properties">, csrf: string, parents: Array<{ id: number; title: string }>, store: PageStore): string {
  const editing = "id" in page;
  const parentOptions = parents.map((parent) => `<option value="${parent.id}"${parent.id === page.parentId ? " selected" : ""}>${escapeHtml(parent.title)}</option>`).join("");
  const preview = renderPageMarkdown(store, page.body) || "<p><em>This page is empty.</em></p>";
  return `<h1>${editing ? "Edit page" : "New page"}</h1>
  <form method="post" action="${editing ? `/wiki/${encodeURIComponent(page.alias)}/edit` : "/pages"}">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label>Title<input name="title" required maxlength="200" value="${escapeHtml(page.title)}"></label>
    <label>Alias<input name="alias" maxlength="200" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" value="${escapeHtml(page.alias)}" placeholder="generated-from-title"></label>
    <div class="form-grid"><label>Status<select name="status">${statusOptions(page.status, false)}</select></label><label>Parent<select name="parentId"><option value="">No parent</option>${parentOptions}</select></label></div>
    <label>Tags <small>comma-separated</small><input name="tags" value="${escapeHtml(page.tags.join(", "))}"></label>
    <label>Properties <small>JSON object with string, number, boolean, or null values</small><textarea name="properties" rows="5">${escapeHtml(JSON.stringify(page.properties, null, 2))}</textarea></label>
    <div class="markdown-editor" data-markdown-editor>
      <section class="editor-pane" aria-label="Markdown editor">
        <div class="editor-heading"><strong>Markdown</strong><small data-character-count></small></div>
        <div class="editor-toolbar" role="toolbar" aria-label="Markdown formatting"><button type="button" class="secondary" data-before="## " data-placeholder="Heading">Heading</button><button type="button" class="secondary" data-before="**" data-after="**" data-placeholder="bold text">Bold</button><button type="button" class="secondary" data-before="_" data-after="_" data-placeholder="italic text">Italic</button><button type="button" class="secondary" data-before="[" data-after="](https://example.com)" data-placeholder="link text">Link</button><button type="button" class="secondary" data-before="&#96;" data-after="&#96;" data-placeholder="code">Code</button></div>
        <label class="sr-only" for="markdown-body">Markdown</label><textarea id="markdown-body" name="body" rows="28" spellcheck="true" aria-controls="markdown-preview">${escapeHtml(page.body)}</textarea>
        <small>Press Ctrl/⌘+S to save.</small>
      </section>
      <section class="preview-pane" aria-label="Markdown preview"><div class="editor-heading"><strong>Preview</strong><small data-preview-status role="status" aria-live="polite">Preview up to date</small></div><div id="markdown-preview" class="markdown" data-preview>${preview}</div></section>
    </div>
    <button type="submit">${editing ? "Save changes" : "Create page"}</button>
  </form><script defer src="/editor.js"></script>`;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="${escapeHtml(csrf)}"><link rel="icon" href="/logo.svg" type="image/svg+xml"><title>${escapeHtml(title)} · nwp</title><style>${CSS}</style></head><body><header class="site-header"><nav><a class="brand" href="/"><img src="/logo.svg" width="34" height="34" alt="">nwp</a><form class="nav-search" action="/search" method="get"><label class="sr-only" for="nav-query">Search pages</label><input id="nav-query" type="search" name="q" placeholder="Search" aria-label="Search pages"></form><a href="/pages">Pages</a><a href="/explore">Explore</a><a href="/tree">Tree</a><a href="/tags">Tags</a><a href="/taxonomy">Taxonomy</a><a href="/documents">Documents</a><a href="/web-captures">Web</a><a href="/research">Research</a><a href="/answer">Answer</a><a href="/trash">Trash</a><a href="/api-docs">API</a><a href="/import">Import</a><a href="/export/all">Export all</a><a class="button" href="/new">New page</a></nav></header><main>${body}</main></body></html>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#202124;--muted:#667085;--line:#d0d5dd;--accent:#175cd3;--soft:#eff4ff;--missing:#b42318} @media(prefers-color-scheme:dark){:root{--bg:#111318;--fg:#f2f4f7;--muted:#98a2b3;--line:#344054;--accent:#84adff;--soft:#182230;--missing:#f97066}} *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif} a{color:var(--accent)} a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.site-header{border-bottom:1px solid var(--line)}.site-header nav,main{max-width:900px;margin:auto;padding:1rem}.site-header nav{display:flex;align-items:center;gap:1rem}.brand{display:flex;align-items:center;gap:.55rem;font-size:1.4rem;font-weight:800;text-decoration:none}.brand img{border-radius:9px;box-shadow:0 3px 10px #312e8140}.nav-search{margin-left:auto}.nav-search input{width:13rem;margin:0;padding:.42rem .6rem}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.button,button{display:inline-block;border:0;border-radius:.4rem;background:var(--accent);color:var(--bg);padding:.45rem .8rem;text-decoration:none;font:inherit;font-weight:700;cursor:pointer}.danger{background:var(--missing);color:#fff}.secondary{background:var(--soft);color:var(--accent)}h1,h2,h3{line-height:1.25}.page-header{display:flex;align-items:start;justify-content:space-between;gap:1rem}.page-list{list-style:none;padding:0}.page-list li{border-bottom:1px solid var(--line);padding:.7rem 0}.page-list small{display:block;color:var(--muted)}label{display:block;font-weight:700;margin:1rem 0}label small{font-weight:400;color:var(--muted)}input,textarea,select{display:block;width:100%;margin-top:.3rem;padding:.65rem;border:1px solid var(--line);border-radius:.3rem;background:var(--bg);color:var(--fg);font:inherit}input[type=checkbox]{display:inline;width:auto;margin-right:.4rem}textarea{font-family:ui-monospace,monospace;resize:vertical}.page-actions{display:flex;gap:.5rem}.form-grid{display:grid;grid-template-columns:1fr 2fr;gap:1rem}.markdown-editor{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;width:min(1400px,calc(100vw - 2rem));margin:1.5rem 0 1.5rem 50%;transform:translateX(-50%)}.editor-pane,.preview-pane{min-width:0;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);overflow:hidden}.editor-heading{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.6rem .8rem;border-bottom:1px solid var(--line);background:var(--soft)}.editor-heading small,.editor-pane>small{color:var(--muted)}.editor-toolbar{display:flex;gap:.35rem;flex-wrap:wrap;padding:.5rem;border-bottom:1px solid var(--line)}.editor-toolbar button{padding:.25rem .55rem}.editor-pane textarea{min-height:60vh;margin:0;border:0;border-radius:0;resize:vertical}.editor-pane>small{display:block;padding:.35rem .65rem}.preview-pane .markdown{height:calc(60vh + 5.7rem);overflow:auto;padding:0 1rem}.search-page{display:grid;grid-template-columns:2fr 1fr 1fr 2fr auto;align-items:end;gap:.75rem;margin-bottom:2rem}.search-page label{margin:0}.search-page button{margin-bottom:0}.search-results p{margin:.25rem 0;color:var(--muted)}.metadata-diff,.code-diff{width:100%;border-collapse:collapse}.metadata-diff th,.metadata-diff td,.code-diff th,.code-diff td{border:1px solid var(--line);padding:.35rem .55rem;text-align:left}.metadata-diff .changed{background:color-mix(in srgb,var(--missing) 12%,var(--bg))}.diff-scroll{overflow:auto}.code-diff{table-layout:fixed;min-width:720px;font-size:.875rem}.code-diff .line-no{width:3rem;text-align:right;color:var(--muted);user-select:none}.code-diff code{white-space:pre-wrap;overflow-wrap:anywhere}.diff-removed{background:#fee2e2;color:#7f1d1d}.diff-added{background:#dcfce7;color:#14532d}.diff-blank{background:var(--soft)}@media(prefers-color-scheme:dark){.diff-removed{background:#450a0a;color:#fecaca}.diff-added{background:#052e16;color:#bbf7d0}}.warning{color:var(--missing);font-weight:700}.status-nav{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}.status{font-size:.7em;text-transform:uppercase;letter-spacing:.04em;padding:.15rem .4rem;border-radius:1rem;background:var(--soft);vertical-align:middle}.status-draft{color:#b54708}.status-archived{color:var(--muted)}.breadcrumbs{padding:0;margin:0 0 1rem;color:var(--muted)}.properties{margin-top:2rem}.properties table{border-collapse:collapse}.properties th,.properties td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left}.tree{list-style:none;padding:0}.tree li{padding:.3rem 0 .3rem calc(var(--depth) * 1.5rem)}.explore-grid,.relationship-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.explore-grid>section,.relationship-grid>section{border:1px solid var(--line);border-radius:.5rem;padding:0 1rem 1rem}.explore-grid>section{margin:0}.navigation-list,.relationship-grid ul{list-style:none;padding:0;margin:0}.navigation-list li,.relationship-grid li{padding:.4rem 0;border-bottom:1px solid var(--line)}.navigation-list li:last-child,.relationship-grid li:last-child{border:0}.navigation-list small,.relationship-grid small{display:block;color:var(--muted)}.tag-cloud{display:flex;flex-wrap:wrap;gap:.4rem}.relationships{margin-top:2rem}.attachments ul{list-style:none;padding:0}.attachments li{display:flex;align-items:center;gap:.8rem;border-bottom:1px solid var(--line);padding:.65rem 0}.attachments li>div{flex:1}.attachments small{display:block;color:var(--muted)}.attachment-preview{display:block;width:72px;height:54px;object-fit:cover;border-radius:.35rem;border:1px solid var(--line)}.attachment-upload{display:flex;align-items:end;gap:.75rem}.attachment-upload label{flex:1}.link-danger{padding:.2rem;background:transparent;color:var(--missing)}.status-deleted,.deleted{color:var(--missing);font-weight:700;text-decoration-style:dashed}.tag{display:inline-block;padding:.1rem .45rem;border-radius:1rem;background:var(--soft);text-decoration:none;font-size:.9rem}.missing{color:var(--missing);text-decoration-style:dotted}.markdown{overflow-wrap:anywhere}.markdown pre{overflow:auto;padding:1rem;background:var(--soft);border-radius:.4rem}.markdown table{border-collapse:collapse}.markdown th,.markdown td{border:1px solid var(--line);padding:.35rem .6rem}aside{margin-top:3rem;border-top:1px solid var(--line)}@media(max-width:800px){.site-header nav{flex-wrap:wrap}.nav-search{order:5;width:100%;margin:0}.nav-search input{width:100%}.search-page{grid-template-columns:1fr}.page-header{display:block}.page-header .button{margin-top:.5rem}.markdown-editor{grid-template-columns:1fr;transform:none;margin-left:0;width:100%}.explore-grid,.relationship-grid{grid-template-columns:1fr}.preview-pane .markdown{height:auto;max-height:60vh}}
`;

function tagKind(value: unknown): "topic" | "entity" | "source" | "type" | "custom" {
  if (value === "topic" || value === "entity" || value === "source" || value === "type" || value === "custom") return value;
  throw new AppError("invalid_tag_kind", "tag kind must be topic, entity, source, type, or custom", 400);
}

function statusParam(value: string | null, fallback: PageStatus | "all"): PageStatus | "all" {
  const status = value || fallback;
  if (status === "draft" || status === "published" || status === "archived" || status === "all") return status;
  throw new AppError("invalid_status", "status must be draft, published, archived, or all", 400);
}

function answerInput(value: unknown): AnswerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_answer_request", "answer request must be an object", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["question", "includeGeneralKnowledge", "tags", "status", "properties", "filters"].includes(key))) throw new AppError("invalid_answer_request", "answer request contains unknown fields", 400);
  if (typeof body.question !== "string") throw new AppError("invalid_question", "question is required", 400);
  if (body.includeGeneralKnowledge !== undefined && typeof body.includeGeneralKnowledge !== "boolean") throw new AppError("invalid_answer_request", "includeGeneralKnowledge must be a boolean", 400);
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) throw new AppError("invalid_answer_request", "tags must be strings", 400);
  const status = body.status === undefined ? "published" : statusParam(String(body.status), "published");
  const properties = body.properties === undefined ? {} : parsePropertiesInput(JSON.stringify(body.properties));
  const filterValue = body.filters === undefined ? {} : body.filters;
  if (!filterValue || typeof filterValue !== "object" || Array.isArray(filterValue)) throw new AppError("invalid_answer_request", "filters must be an object", 400);
  const rawFilters = filterValue as Record<string, unknown>;
  if (Object.keys(rawFilters).some((key) => !["source", "documentId", "format", "version", "ocrStatus", "hidden", "kind", "updatedAfter", "updatedBefore"].includes(key))) throw new AppError("invalid_answer_request", "answer filters contain unknown fields", 400);
  const params = new URLSearchParams();
  for (const [field, parameter] of [["source", "source"], ["documentId", "document_id"], ["format", "format"], ["version", "version"], ["ocrStatus", "ocr_status"], ["hidden", "hidden"], ["kind", "kind"], ["updatedAfter", "updated_after"], ["updatedBefore", "updated_before"]] as const) {
    if (rawFilters[field] !== undefined) params.set(parameter, String(rawFilters[field]));
  }
  return { question: body.question, includeGeneralKnowledge: body.includeGeneralKnowledge as boolean | undefined, tags: body.tags as string[] | undefined, status, properties, filters: documentSearchFilters(params) };
}

function documentSearchFilters(params: URLSearchParams): DocumentSearchFilters {
  const sourceValue = params.get("source") || "all";
  if (sourceValue !== "all" && sourceValue !== "pages" && sourceValue !== "documents") throw new AppError("invalid_search_source", "source must be all, pages, or documents", 400);
  const formatValue = params.get("format") || undefined;
  if (formatValue !== undefined && !["docx", "xlsx", "pptx", "pdf", "markdown", "text"].includes(formatValue)) throw new AppError("invalid_document_format", "invalid document format filter", 400);
  const ocrValue = params.get("ocr_status") || undefined;
  if (ocrValue !== undefined && !["not_required", "pending", "completed", "partial", "unavailable"].includes(ocrValue)) throw new AppError("invalid_ocr_status", "invalid OCR status filter", 400);
  const kindValue = params.get("kind") || undefined;
  if (kindValue !== undefined && !["heading", "paragraph", "table", "slide", "notes", "sheet", "page", "image", "text"].includes(kindValue)) throw new AppError("invalid_section_kind", "invalid document section filter", 400);
  const hiddenValue = params.get("hidden");
  if (hiddenValue !== null && hiddenValue !== "" && hiddenValue !== "true" && hiddenValue !== "false") throw new AppError("invalid_hidden_filter", "hidden must be true or false", 400);
  const date = (name: string): string | undefined => {
    const value = params.get(name);
    if (!value) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) throw new AppError("invalid_date_filter", `${name} must be an ISO date or datetime`, 400);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new AppError("invalid_date_filter", `${name} must be an ISO date or datetime`, 400);
    return parsed.toISOString();
  };
  return {
    source: sourceValue,
    documentId: optionalPositiveInteger(params.get("document_id")),
    format: formatValue as DocumentSearchFilters["format"],
    version: optionalPositiveInteger(params.get("version")),
    ocrStatus: ocrValue as DocumentSearchFilters["ocrStatus"],
    hidden: hiddenValue === null || hiddenValue === "" ? undefined : hiddenValue === "true",
    kind: kindValue as DocumentSearchFilters["kind"],
    updatedAfter: date("updated_after"),
    updatedBefore: date("updated_before"),
  };
}

function documentFilterQuery(filters: DocumentSearchFilters): Record<string, string> {
  return Object.fromEntries(Object.entries({ source: filters.source, document_id: filters.documentId, format: filters.format, version: filters.version, ocr_status: filters.ocrStatus, hidden: filters.hidden, kind: filters.kind, updated_after: filters.updatedAfter?.slice(0, 10), updated_before: filters.updatedBefore?.slice(0, 10) }).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
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

async function searchWithFallback(
  store: PageStore,
  embedder: OllamaEmbedder | null,
  requestedMode: string | null,
  query: string,
  tags: string[],
  cursor: string | null,
  limit: number,
  status: PageStatus | "all",
  properties: PageProperties,
  filters: DocumentSearchFilters,
  signal: AbortSignal,
) {
  if (requestedMode === "lexical" || !query.trim()) return lexicalSearch(store, query, tags, cursor, limit, status, properties, filters);
  if (!embedder) return { ...lexicalSearch(store, query, tags, cursor, limit, status, properties, filters), warning: "Semantic search is disabled; showing lexical results." };
  const semanticState = store.semanticStatus(true, "", 0);
  if (!semanticState.vectorAvailable || semanticState.indexedPages + semanticState.indexedDocuments === 0) {
    const reason = !semanticState.vectorAvailable ? "sqlite-vec is unavailable" : "no content has been indexed yet";
    return { ...lexicalSearch(store, query, tags, cursor, limit, status, properties, filters), warning: `Semantic search unavailable (${reason}); showing lexical results.` };
  }
  try {
    const result = await hybridSearch(store, embedder, query, tags, cursor, limit, status, properties, signal, filters);
    const state = store.semanticStatus(true, "", 0);
    const pending = state.pendingPages + state.pendingDocuments;
    return pending > 0 ? { ...result, warning: `${pending} item${pending === 1 ? " is" : "s are"} still pending semantic indexing.` } : result;
  } catch (error) {
    if (error instanceof AppError && error.code === "invalid_cursor") throw error;
    return { ...lexicalSearch(store, query, tags, null, limit, status, properties, filters), warning: `Semantic search unavailable; showing lexical results. ${error instanceof Error ? error.message : String(error)}` };
  }
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

async function documentDownloadResponse(store: PageStore, documentId: number): Promise<Response> {
  const { document, path } = store.documentBlobPath(documentId);
  const file = Bun.file(path);
  if (!await file.exists()) throw new AppError("document_content_missing", "document content is missing", 500);
  return new Response(file, { headers: { "Content-Type": document.mimeType, "Content-Length": String(document.currentVersion.size), "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
}

function requireBoundedMultipart(request: Request, maxBytes: number): void {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!length) throw new AppError("length_required", "document uploads require Content-Length", 411);
  if (length > maxBytes + 1024 * 1024) throw new AppError("document_too_large", `document exceeds the technical ${maxBytes} byte guard`, 413);
}

async function readDocumentBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new AppError("document_too_large", `document exceeds the technical ${maxBytes} byte guard`, 413);
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("document_too_large", `document exceeds the technical ${maxBytes} byte guard`, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
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

function nonNegativeInteger(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError("invalid_offset", "offset must be a non-negative integer", 400);
  return parsed;
}

function optionalPositiveInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AppError("invalid_id", "value must be a positive integer", 400);
  return parsed;
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
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
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
