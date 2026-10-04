import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createBackupFile, listBackupFiles, prepareRestore, verifyBackupFile } from "../src/backup.ts";
import { PageStore } from "../src/database.ts";
import { createSystemdUnit } from "../src/service.ts";
import type { Config } from "../src/config.ts";

let dir = "";
let store: PageStore | null = null;
const limits = { maxArchiveEntries: 1000, maxExpandedBytes: 50_000_000 };

async function setup(): Promise<PageStore> {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "backup-test-"));
  store = new PageStore(join(dir, "source", "nwp.db"));
  return store;
}

afterEach(async () => {
  store?.close();
  store = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("backup and restore", () => {
  test("verifies and restores an exact complete archive", async () => {
    const source = await setup();
    const page = source.create({ title: "Recovery", body: "original", tags: ["backup"], properties: { priority: 2 } }, "cli");
    source.update(page.id, { body: "current" }, "cli");
    const attachment = source.addAttachment(page.id, "proof.txt", "text/plain", new TextEncoder().encode("proof"), null);
    source.createDocument("source.txt", "text/plain", "text", new TextEncoder().encode("proof"), "cli", 1000);
    const capture = source.createWebCapture("https://example.com/recovery", "cli");
    const task = source.claimWebCaptureTask("backup-test")!;
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const imageHash = new Bun.CryptoHasher("sha256").update(image).digest("hex") as string;
    source.completeWebCaptureTask(task, { kind: "content", requestedUrl: capture.url, finalUrl: capture.url, status: 200, contentType: "text/html", bytes: new TextEncoder().encode("<p>captured</p>"), title: "Captured", markdown: `# Captured\n\ntext\n\n![Chart](/web-assets/${imageHash}/chart.png)`, assets: [{ ordinal: 0, sourceUrl: "https://example.com/chart.png", finalUrl: "https://example.com/chart.png", filename: "chart.png", mimeType: "image/png", bytes: image, sha256: imageHash, alt: "Chart" }], etag: '"v1"', lastModified: null }, 1000);

    const archivePath = join(dir, "backups", "complete.tar.gz");
    const created = await createBackupFile(source, archivePath);
    expect(created.bytes).toBeGreaterThan(0);
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await listBackupFiles(join(dir, "backups"))).toHaveLength(1);
    const summary = await verifyBackupFile(archivePath, limits);
    expect(summary).toMatchObject({ formatVersion: 2, pages: 3, attachments: 1, documents: 2, webCaptures: 1 });

    const restoredDir = join(dir, "restored");
    await prepareRestore(archivePath, restoredDir, limits, "preserved-token-value-that-is-long-enough");
    const restored = new PageStore(join(restoredDir, "nwp.db"));
    try {
      expect(restored.getById(page.id)).toMatchObject({ body: "current", tags: ["backup"], properties: { priority: 2 } });
      expect(restored.listRevisions(page.id).revisions).toHaveLength(1);
      expect(await readFile(restored.attachmentFilePath(attachment.sha256), "utf8")).toBe("proof");
      expect(restored.latestWebCaptureAssets(capture.id)).toEqual([expect.objectContaining({ blobSha256: imageHash, filename: "chart.png" })]);
      expect(new Uint8Array(await Bun.file(restored.attachmentFilePath(imageHash)).arrayBuffer())).toEqual(image);
      expect(restored.operationalStatistics()).toEqual(source.operationalStatistics());
      expect(restored.healthStatus().database).toBe("ok");
      expect(await readFile(join(restoredDir, "api-token"), "utf8")).toContain("preserved-token-value");
    } finally { restored.close(); }
  });

  test("rejects truncated and legacy archives", async () => {
    const source = await setup();
    source.create({ title: "Page", body: "", tags: [] }, "cli");
    const archivePath = join(dir, "complete.tar.gz");
    await createBackupFile(source, archivePath);
    const bytes = await readFile(archivePath);
    await Bun.write(join(dir, "truncated.tar.gz"), bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(verifyBackupFile(join(dir, "truncated.tar.gz"), limits)).rejects.toThrow();
  });
});

describe("systemd service", () => {
  test("generates a hardened user unit with explicit paths", () => {
    const config = { dataDir: "/home/test/My Wiki", configPath: "/home/test/.config/nwp/config.toml" } as Config;
    const unit = createSystemdUnit(config, ["/opt/nwp"]);
    expect(unit).toContain('ExecStart="/opt/nwp" "serve" "--with-worker"');
    expect(unit).toContain('ReadWritePaths="/home/test/My Wiki" "/home/test/.config/nwp"');
    expect(unit).toMatch(/nwp\.service"/);
    expect(unit).toContain('Environment="PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("WantedBy=default.target");
  });
});
