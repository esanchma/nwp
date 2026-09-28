import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PageStore } from "../src/database.ts";
import { DocumentWorker } from "../src/documents.ts";
import type { DocumentRagConfig } from "../src/config.ts";
import { extractWebContent, isPublicIp, normalizeWebUrl } from "../src/web.ts";

let dir: string;
let store: PageStore;
const documentConfig: DocumentRagConfig = { enabled: true, maxFileBytes: 10_000_000, maxExpandedBytes: 50_000_000, maxArchiveEntries: 10_000, maxCompressionRatio: 1000, maxPdfPages: 10_000, maxSpreadsheetCells: 5_000_000, ocrEnabled: false, tesseractCommand: "tesseract", pdfRendererCommand: "pdftoppm", ocrLanguages: ["spa", "eng"], ocrTimeoutSeconds: 120, maxOcrItems: 10_000, maxOcrOutputCharacters: 1_000_000 };

beforeEach(async () => {
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  dir = await mkdtemp(join(process.cwd(), ".tmp", "web-test-"));
  store = new PageStore(join(dir, "nwp.db"));
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("secure web capture", () => {
  test("normalizes public URLs and rejects unsafe URL forms", () => {
    expect(normalizeWebUrl("https://Example.com/a#fragment")).toBe("https://example.com/a");
    for (const url of ["file:///etc/passwd", "http://user:pass@example.com", "http://localhost/x", "http://127.0.0.1/x", "http://2130706433/x", "http://[::1]/x"]) {
      expect(() => normalizeWebUrl(url)).toThrow();
    }
  });

  test("classifies private, reserved, and public addresses", () => {
    for (const address of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.2", "172.16.0.1", "192.168.1.1", "198.51.100.2", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1", "fec0::1", "2001:db8::1", "2002:0a00:0001::", "::ffff:127.0.0.1"]) expect(isPublicIp(address)).toBe(false);
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  test("extracts bounded text while dropping active and navigational HTML", () => {
    const html = `<html><head><title>Policy &amp; Guide</title><style>.x{}</style></head><body><nav>Ignore menu</nav><main><h1>Leave</h1><p>Employees receive 16 weeks.</p><script>ignore()</script><ul><li>Paid</li></ul></main></body></html>`;
    const result = extractWebContent(new TextEncoder().encode(html), "text/html", "https://example.com/policy", 10_000);
    expect(result.title).toBe("Policy & Guide");
    expect(result.markdown).toContain("Employees receive 16 weeks.");
    expect(result.markdown).toContain("Source: https://example.com/policy");
    expect(result.markdown).not.toContain("Ignore menu");
    expect(result.markdown).not.toContain("ignore()");
    expect(() => extractWebContent(new TextEncoder().encode(html), "text/html", "https://example.com", 10)).toThrow();
  });

  test("persists a raw snapshot and queues extracted Markdown as a document", async () => {
    const capture = store.createWebCapture("https://example.com/policy", "rest");
    expect(capture.status).toBe("queued");
    expect(store.getById(capture.pageId).tags).toContain("source:web");
    const task = store.claimWebCaptureTask("test-owner")!;
    const html = new TextEncoder().encode("<title>Leave policy</title><p>Employees receive sixteen weeks of paid leave.</p>");
    store.completeWebCaptureTask(task, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: html, title: "Leave policy", etag: null, lastModified: null, markdown: "# Leave policy\n\nSource: https://example.com/policy\n\nEmployees receive sixteen weeks of paid leave." }, documentConfig.maxFileBytes);
    const completed = store.getWebCapture(capture.id);
    expect(completed).toMatchObject({ status: "ready", title: "Leave policy", httpStatus: 200 });
    expect(completed.documentId).toBeNumber();
    expect(store.listWebCaptureSnapshots(capture.id)).toHaveLength(1);
    expect(store.getDocument(completed.documentId!).status).toBe("queued");
    expect(await new DocumentWorker(store, documentConfig).runUntilIdle()).toBe(1);
    expect(store.documentSections(completed.documentId!)[0]!.text).toContain("Leave policy");
  });

  test("refreshes conditionally, retains changed versions, and schedules due work", async () => {
    const capture = store.createWebCapture("https://example.com/versioned", "rest");
    const first = store.claimWebCaptureTask("owner-1")!;
    store.completeWebCaptureTask(first, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<p>version one</p>"), title: "Versioned", markdown: "# Versioned\n\nversion one", etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
    const documentId = store.getWebCapture(capture.id).documentId!;
    await new DocumentWorker(store, documentConfig).runUntilIdle();

    store.refreshWebCapture(capture.id);
    const second = store.claimWebCaptureTask("owner-2")!;
    expect(second).toMatchObject({ etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" });
    store.completeWebCaptureTask(second, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<p>version two</p>"), title: "Versioned", markdown: "# Versioned\n\nversion two", etag: '"v2"', lastModified: "Thu, 02 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
    expect(store.listDocumentVersions(documentId)).toHaveLength(2);
    expect(store.listWebCaptureSnapshots(capture.id)).toHaveLength(2);
    await new DocumentWorker(store, documentConfig).runUntilIdle();

    store.refreshWebCapture(capture.id);
    const third = store.claimWebCaptureTask("owner-3")!;
    store.completeWebCaptureTask(third, { kind: "not_modified", requestedUrl: capture.url, finalUrl: capture.url, status: 304, etag: '"v2"', lastModified: "Thu, 02 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
    expect(store.getWebCapture(capture.id)).toMatchObject({ status: "ready", httpStatus: 304, etag: '"v2"' });
    expect(store.listDocumentVersions(documentId)).toHaveLength(2);

    expect(store.scheduleWebCapture(capture.id, 300).refreshIntervalSeconds).toBe(300);
    store.db.run("UPDATE web_captures SET next_refresh_at = ? WHERE id = ?", [new Date(0).toISOString(), capture.id]);
    expect(store.enqueueDueWebCaptures()).toBe(1);
    expect(store.getWebCapture(capture.id).status).toBe("queued");
    expect(store.scheduleWebCapture(capture.id, null).refreshIntervalSeconds).toBeNull();
  });

  test("supports cancellation, safe stale completion, and retry", () => {
    const capture = store.createWebCapture("https://example.com/failure", "rest");
    const task = store.claimWebCaptureTask("test-owner")!;
    store.failWebCaptureTask(task, "permanent", false);
    expect(store.getWebCapture(capture.id).status).toBe("failed");
    expect(store.retryWebCapture(capture.id).status).toBe("queued");
    const stale = store.claimWebCaptureTask("test-owner-2")!;
    expect(store.cancelWebCapture(capture.id).status).toBe("cancelled");
    store.completeWebCaptureTask(stale, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/plain", bytes: new TextEncoder().encode("stale"), title: "Stale", etag: null, lastModified: null, markdown: "# Stale" }, documentConfig.maxFileBytes);
    expect(store.getWebCapture(capture.id)).toMatchObject({ status: "cancelled", documentId: null });
  });
});
