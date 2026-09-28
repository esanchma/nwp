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
    const html = `<html><head><title>Policy &amp; Guide</title><style>.x{}</style></head><body><nav>Ignore menu</nav><main><h1>Leave</h1><p>Employees receive 16 weeks.</p><figure><img data-src="/charts/leave.png" alt="Leave chart"><figcaption>Weeks by region</figcaption></figure><script>ignore()</script><ul><li>Paid</li></ul></main></body></html>`;
    const result = extractWebContent(new TextEncoder().encode(html), "text/html", "https://example.com/policy", 10_000);
    expect(result.title).toBe("Policy & Guide");
    expect(result.markdown).toContain("Employees receive 16 weeks.");
    expect(result.markdown).toContain("Source: https://example.com/policy");
    expect(result.assets).toEqual([{ ordinal: 0, sourceUrl: "https://example.com/charts/leave.png", alt: "Leave chart", marker: "NWP_WEB_ASSET_0_PLACEHOLDER" }]);
    expect(result.markdown.indexOf("NWP_WEB_ASSET_0_PLACEHOLDER")).toBeLessThan(result.markdown.indexOf("Weeks by region"));
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
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const imageHash = new Bun.CryptoHasher("sha256").update(image).digest("hex") as string;
    const imageUrl = `/web-assets/${imageHash}/leave.png`;
    store.completeWebCaptureTask(task, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: html, title: "Leave policy", assets: [{ ordinal: 0, sourceUrl: "https://example.com/leave.png", finalUrl: "https://example.com/leave.png", filename: "leave.png", mimeType: "image/png", bytes: image, sha256: imageHash, alt: "Leave chart" }], etag: null, lastModified: null, markdown: `# Leave policy\n\nSource: https://example.com/policy\n\nEmployees receive sixteen weeks of paid leave.\n\n![Leave chart](${imageUrl})` }, documentConfig.maxFileBytes);
    const completed = store.getWebCapture(capture.id);
    expect(completed).toMatchObject({ status: "ready", title: "Leave policy", httpStatus: 200 });
    expect(completed.documentId).toBeNumber();
    const snapshot = store.listWebCaptureSnapshots(capture.id)[0]!;
    expect(store.listWebCaptureAssets(snapshot.id)).toEqual([expect.objectContaining({ ordinal: 0, blobSha256: imageHash, filename: "leave.png", alt: "Leave chart" })]);
    expect(new Uint8Array(await Bun.file(store.attachmentFilePath(imageHash)).arrayBuffer())).toEqual(image);
    expect(store.getDocument(completed.documentId!).status).toBe("queued");
    expect(await new DocumentWorker(store, documentConfig).runUntilIdle()).toBe(1);
    expect(store.documentSections(completed.documentId!)[0]!.text).toContain(imageUrl);
  });

  test("refreshes conditionally, retains changed versions, and schedules due work", async () => {
    const capture = store.createWebCapture("https://example.com/versioned", "rest");
    const first = store.claimWebCaptureTask("owner-1")!;
    store.completeWebCaptureTask(first, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<p>version one</p>"), title: "Versioned", markdown: "# Versioned\n\nversion one", assets: [], etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
    const documentId = store.getWebCapture(capture.id).documentId!;
    await new DocumentWorker(store, documentConfig).runUntilIdle();

    store.refreshWebCapture(capture.id);
    const second = store.claimWebCaptureTask("owner-2")!;
    expect(second).toMatchObject({ etag: '"v1"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" });
    store.completeWebCaptureTask(second, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<p>version two</p>"), title: "Versioned", markdown: "# Versioned\n\nversion two", assets: [], etag: '"v2"', lastModified: "Thu, 02 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
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

  test("forces one full refresh for legacy snapshots without asset processing", () => {
    const capture = store.createWebCapture("https://example.com/legacy-assets", "rest");
    const first = store.claimWebCaptureTask("legacy-owner-1")!;
    const raw = new TextEncoder().encode("<p>legacy article</p>");
    store.completeWebCaptureTask(first, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: raw, title: "Legacy", markdown: "# Legacy", assets: [], etag: '"legacy"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
    const snapshot = store.listWebCaptureSnapshots(capture.id)[0]!;
    store.db.run("UPDATE web_capture_snapshots SET assets_captured = 0 WHERE id = ?", [snapshot.id]);

    store.refreshWebCapture(capture.id);
    const refresh = store.claimWebCaptureTask("legacy-owner-2")!;
    expect(refresh).toMatchObject({ etag: null, lastModified: null });
    store.completeWebCaptureTask(refresh, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: raw, title: "Legacy", markdown: "# Legacy", assets: [], etag: '"legacy"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" }, documentConfig.maxFileBytes);
    expect(store.listWebCaptureSnapshots(capture.id)).toHaveLength(2);
    expect(store.listWebCaptureSnapshots(capture.id)[0]?.assetsCaptured).toBe(true);
  });

  test("creates a new immutable version when an interleaved image changes", () => {
    const capture = store.createWebCapture("https://example.com/illustrated", "rest");
    const html = new TextEncoder().encode("<p>stable article</p><img src='chart.png'>");
    const firstImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const secondImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]);
    const finish = (owner: string, image: Uint8Array) => {
      const task = store.claimWebCaptureTask(owner)!;
      const sha256 = new Bun.CryptoHasher("sha256").update(image).digest("hex") as string;
      store.completeWebCaptureTask(task, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: html, title: "Illustrated", markdown: `# Illustrated\n\n![Chart](/web-assets/${sha256}/chart.png)`, assets: [{ ordinal: 0, sourceUrl: "https://example.com/chart.png", finalUrl: "https://example.com/chart.png", filename: "chart.png", mimeType: "image/png", bytes: image, sha256, alt: "Chart" }], etag: null, lastModified: null }, documentConfig.maxFileBytes);
      return sha256;
    };
    const firstHash = finish("asset-owner-1", firstImage);
    const documentId = store.getWebCapture(capture.id).documentId!;
    store.refreshWebCapture(capture.id);
    const secondHash = finish("asset-owner-2", secondImage);

    expect(firstHash).not.toBe(secondHash);
    expect(store.listWebCaptureSnapshots(capture.id)).toHaveLength(2);
    expect(store.listDocumentVersions(documentId)).toHaveLength(2);
    expect(store.latestWebCaptureAssets(capture.id)[0]?.blobSha256).toBe(secondHash);
  });

  test("supports cancellation, safe stale completion, and retry", () => {
    const capture = store.createWebCapture("https://example.com/failure", "rest");
    const task = store.claimWebCaptureTask("test-owner")!;
    store.failWebCaptureTask(task, "permanent", false);
    expect(store.getWebCapture(capture.id).status).toBe("failed");
    expect(store.retryWebCapture(capture.id).status).toBe("queued");
    const stale = store.claimWebCaptureTask("test-owner-2")!;
    expect(store.cancelWebCapture(capture.id).status).toBe("cancelled");
    store.completeWebCaptureTask(stale, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/plain", bytes: new TextEncoder().encode("stale"), title: "Stale", assets: [], etag: null, lastModified: null, markdown: "# Stale" }, documentConfig.maxFileBytes);
    expect(store.getWebCapture(capture.id)).toMatchObject({ status: "cancelled", documentId: null });
  });
});
