import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import type { DocumentRagConfig } from "./config.ts";
import { PageStore } from "./database.ts";
import { createFullExport } from "./transfer.ts";

interface ArchiveEntry { path: string; sha256?: string; size?: number }
interface ArchiveManifest {
  format: string;
  version: number;
  generatedAt: string;
  database: Required<ArchiveEntry>;
  pages: ArchiveEntry[];
  trash: ArchiveEntry[];
  revisions: ArchiveEntry[];
  attachments: ArchiveEntry[];
  documents: Array<{ versions?: ArchiveEntry[] }>;
  webCaptures: Array<{ snapshots?: Array<{ path: string; blobSha256: string; size?: number }> }>;
  research: unknown[];
  taxonomy: unknown[];
}

export interface BackupSummary {
  formatVersion: number;
  generatedAt: string;
  pages: number;
  trash: number;
  revisions: number;
  attachments: number;
  documents: number;
  webCaptures: number;
  research: number;
  databaseBytes: number;
}

interface ExtractedArchive {
  directory: string;
  manifest: ArchiveManifest;
  hashes: Map<string, { sha256: string; size: number }>;
}

export function defaultBackupDirectory(dataDir: string): string {
  return join(dirname(resolve(dataDir)), "nwp-backups");
}

export async function createBackupFile(store: PageStore, outputPath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const destination = resolve(outputPath);
  if (await Bun.file(destination).exists()) throw new Error(`backup already exists: ${destination}`);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const archive = createFullExport(store);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(archive.stream as never), createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
    await link(temporary, destination);
    await rm(temporary, { force: true });
    const bytes = (await stat(destination)).size;
    const sha256 = await hashFile(destination);
    return { path: destination, bytes, sha256 };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function listBackupFiles(directory: string): Promise<Array<{ path: string; bytes: number; modifiedAt: string }>> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tar.gz")).map(async (entry) => {
      const path = join(directory, entry.name);
      const info = await stat(path);
      return { path, bytes: info.size, modifiedAt: info.mtime.toISOString() };
    }));
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function verifyBackupFile(path: string, limits: Pick<DocumentRagConfig, "maxArchiveEntries" | "maxExpandedBytes">): Promise<BackupSummary> {
  const extracted = await extractAndVerify(path, limits);
  try { return summarize(extracted.manifest); }
  finally { await rm(extracted.directory, { recursive: true, force: true }); }
}

export async function prepareRestore(path: string, stagingDataDir: string, limits: Pick<DocumentRagConfig, "maxArchiveEntries" | "maxExpandedBytes">, token: string | null): Promise<BackupSummary> {
  const extracted = await extractAndVerify(path, limits);
  try {
    await mkdir(stagingDataDir, { recursive: true, mode: 0o700 });
    await copyFile(join(extracted.directory, extracted.manifest.database.path), join(stagingDataDir, "nwp.db"));
    await chmod(join(stagingDataDir, "nwp.db"), 0o600);
    if (token) await writeFile(join(stagingDataDir, "api-token"), `${token}\n`, { mode: 0o600, flag: "wx" });

    const blobs = archiveBlobs(extracted.manifest);
    for (const blob of blobs.values()) {
      const destination = join(stagingDataDir, "attachments", blob.sha256.slice(0, 2), blob.sha256);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(extracted.directory, blob.path), destination);
      await chmod(destination, 0o600);
    }

    const store = new PageStore(join(stagingDataDir, "nwp.db"));
    try {
      const integrity = store.db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("restored SQLite database failed its integrity check");
      const foreignKeys = store.db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
      if (foreignKeys.length) throw new Error("restored SQLite database has foreign-key violations");
      for (const attachment of store.allAttachments()) await requireBlob(store.attachmentFilePath(attachment.sha256), attachment.sha256);
      for (const version of store.allDocumentVersions()) await requireBlob(store.attachmentFilePath(version.sha256), version.sha256);
      for (const snapshot of store.allWebCaptureSnapshots()) await requireBlob(store.attachmentFilePath(snapshot.blobSha256), snapshot.blobSha256);
    } finally { store.close(); }
    return summarize(extracted.manifest);
  } catch (error) {
    await rm(stagingDataDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(extracted.directory, { recursive: true, force: true });
  }
}

async function extractAndVerify(path: string, limits: Pick<DocumentRagConfig, "maxArchiveEntries" | "maxExpandedBytes">): Promise<ExtractedArchive> {
  const archivePath = resolve(path);
  const info = await stat(archivePath);
  if (!info.isFile()) throw new Error("backup path is not a regular file");
  const directory = await mkdtemp(join(dirname(archivePath), ".nwp-verify-"));
  const hashes = new Map<string, { sha256: string; size: number }>();
  let entries = 0;
  let expanded = 0;
  const extract = tar.extract();
  const completion = new Promise<void>((resolvePromise, reject) => {
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        if (header.type !== "file" && header.type !== undefined) throw new Error(`backup entry '${header.name}' is not a regular file`);
        validateArchivePath(header.name);
        if (hashes.has(header.name)) throw new Error(`backup contains duplicate entry '${header.name}'`);
        entries += 1;
        if (entries > limits.maxArchiveEntries) throw new Error(`backup exceeds the ${limits.maxArchiveEntries} entry guard`);
        const declared = header.size ?? 0;
        if (!Number.isSafeInteger(declared) || declared < 0 || expanded + declared > limits.maxExpandedBytes) throw new Error(`backup exceeds the ${limits.maxExpandedBytes} byte expansion guard`);
        expanded += declared;
        const destination = join(directory, header.name);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
        const hasher = new Bun.CryptoHasher("sha256");
        let actual = 0;
        stream.on("data", (value: unknown) => { const chunk = Buffer.from(value as Uint8Array); actual += chunk.length; hasher.update(chunk); });
        await pipeline(stream, output);
        if (actual !== declared) throw new Error(`backup entry '${header.name}' has an invalid size`);
        hashes.set(header.name, { sha256: hasher.digest("hex") as string, size: actual });
        next();
      })().catch(reject);
    });
    extract.on("finish", resolvePromise);
    extract.on("error", reject);
  });
  try {
    await Promise.all([pipeline(createReadStream(archivePath), createGunzip(), extract), completion]);
    const manifestFile = hashes.get("manifest.json");
    if (!manifestFile || manifestFile.size > 50 * 1024 * 1024) throw new Error("backup manifest is missing or too large");
    const manifest = parseManifest(await readFile(join(directory, "manifest.json"), "utf8"));
    verifyEntries(manifest, hashes);
    return { directory, manifest, hashes };
  } catch (error) {
    extract.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(text: string): ArchiveManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("backup manifest is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("backup manifest must be an object");
  const manifest = value as Partial<ArchiveManifest>;
  if (manifest.format !== "nwp-export" || manifest.version !== 2) throw new Error("only nwp export format version 2 can be restored");
  if (typeof manifest.generatedAt !== "string" || !manifest.database || !Array.isArray(manifest.pages) || !Array.isArray(manifest.trash) || !Array.isArray(manifest.revisions) || !Array.isArray(manifest.attachments) || !Array.isArray(manifest.documents) || !Array.isArray(manifest.webCaptures) || !Array.isArray(manifest.research) || !Array.isArray(manifest.taxonomy)) throw new Error("backup manifest is incomplete");
  return manifest as ArchiveManifest;
}

function verifyEntries(manifest: ArchiveManifest, hashes: Map<string, { sha256: string; size: number }>): void {
  const expected = new Set<string>(["manifest.json"]);
  const requireEntry = (entry: ArchiveEntry, category: string, expectedHash?: string) => {
    if (!entry || typeof entry.path !== "string") throw new Error(`backup ${category} entry has no path`);
    validateArchivePath(entry.path);
    expected.add(entry.path);
    const actual = hashes.get(entry.path);
    if (!actual) throw new Error(`backup is missing '${entry.path}'`);
    if (entry.size !== undefined && entry.size !== actual.size) throw new Error(`backup entry '${entry.path}' does not match its declared size`);
    const hash = expectedHash ?? entry.sha256;
    if (hash !== undefined && (!/^[a-f0-9]{64}$/.test(hash) || hash !== actual.sha256)) throw new Error(`backup entry '${entry.path}' failed SHA-256 verification`);
  };
  if (manifest.database.path !== "database/nwp.db") throw new Error("backup database path is invalid");
  requireEntry(manifest.database, "database");
  for (const entry of [...manifest.pages, ...manifest.trash, ...manifest.revisions]) requireEntry(entry, "Markdown");
  for (const entry of manifest.attachments) requireEntry(entry, "attachment", entry.sha256);
  for (const document of manifest.documents) for (const version of document.versions ?? []) requireEntry(version, "document", version.sha256);
  for (const capture of manifest.webCaptures) for (const snapshot of capture.snapshots ?? []) requireEntry(snapshot, "web snapshot", snapshot.blobSha256);
  for (const name of hashes.keys()) if (!expected.has(name)) throw new Error(`backup contains unexpected entry '${name}'`);
}

function archiveBlobs(manifest: ArchiveManifest): Map<string, { path: string; sha256: string }> {
  const result = new Map<string, { path: string; sha256: string }>();
  const add = (path: string, sha256: string) => {
    if (!result.has(sha256)) result.set(sha256, { path, sha256 });
  };
  for (const entry of manifest.attachments) if (entry.sha256) add(entry.path, entry.sha256);
  for (const document of manifest.documents) for (const version of document.versions ?? []) if (version.sha256) add(version.path, version.sha256);
  for (const capture of manifest.webCaptures) for (const snapshot of capture.snapshots ?? []) add(snapshot.path, snapshot.blobSha256);
  return result;
}

function validateArchivePath(path: string): void {
  if (!path || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe backup entry path '${path}'`);
}

function summarize(manifest: ArchiveManifest): BackupSummary {
  return { formatVersion: manifest.version, generatedAt: manifest.generatedAt, pages: manifest.pages.length, trash: manifest.trash.length, revisions: manifest.revisions.length, attachments: manifest.attachments.length, documents: manifest.documents.length, webCaptures: manifest.webCaptures.length, research: manifest.research.length, databaseBytes: manifest.database.size };
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) hasher.update(chunk as Buffer);
  return hasher.digest("hex") as string;
}

async function requireBlob(path: string, sha256: string): Promise<void> {
  if (await hashFile(path) !== sha256) throw new Error(`restored blob '${sha256}' failed verification`);
}
