import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, writeConfig } from "../src/config.ts";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

test("writes a complete validated TOML configuration atomically", async () => {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "config-test-"));
  const configPath = join(dir, "config.toml");
  const config = await loadConfig({ configPath });
  const updated = { ...config, host: "0.0.0.0", port: 4321, dataDir: join(dir, "data"), attachmentMaxBytes: 1234, semanticSearch: { ...config.semanticSearch, enabled: false }, documentRag: { ...config.documentRag, ocrLanguages: ["eng"] } };

  await writeConfig(updated);

  await expect(loadConfig({ configPath })).resolves.toMatchObject({ host: "0.0.0.0", port: 4321, dataDir: join(dir, "data"), attachmentMaxBytes: 1234, semanticSearch: { enabled: false }, documentRag: { ocrLanguages: ["eng"] } });
});

test("does not replace the configuration when validation fails", async () => {
  const base = join(process.cwd(), ".tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "config-test-"));
  const configPath = join(dir, "config.toml");
  const config = await loadConfig({ configPath });

  await expect(writeConfig({ ...config, semanticSearch: { ...config.semanticSearch, chunkOverlap: config.semanticSearch.chunkCharacters } })).rejects.toThrow("chunk_overlap");
  await expect(Bun.file(configPath).exists()).resolves.toBe(false);
});
