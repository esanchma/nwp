#!/usr/bin/env bun
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureRuntimeFiles, loadConfig, readApiToken, type ConfigOverrides } from "./config.ts";
import { PageStore } from "./database.ts";
import { createRequestHandler } from "./server.ts";
import { loadEmbeddedSqliteVec, SemanticIndexer, semanticIndexConfig } from "./semantic.ts";
import { canonicalDocumentMime, documentFormat, DocumentWorker } from "./documents.ts";

const args = process.argv.slice(2);

try {
  await main(args);
} catch (error) {
  console.error(`nwp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "help";
  if (command === "serve") return serve(argv.slice(1));
  if (command === "page") return pageCommand(argv.slice(1));
  if (command === "search") return searchCommand(argv.slice(1));
  if (command === "trash") return trashCommand(argv.slice(1));
  if (command === "attachment") return attachmentCommand(argv.slice(1));
  if (command === "tree") return treeCommand(argv.slice(1));
  if (command === "tag") return tagCommand(argv.slice(1));
  if (command === "document") return documentCommand(argv.slice(1));
  if (command === "import") return importCommand(argv.slice(1));
  if (command === "export") return exportCommand(argv.slice(1));
  if (command === "worker") return workerCommand(argv.slice(1));
  if (command === "index") return indexCommand(argv.slice(1));
  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "--version" || command === "-v") return console.log("nwp 0.10.0");
  throw new Error(`unknown command '${command}'. Run 'nwp help'.`);
}

async function serve(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  const overrides: ConfigOverrides = {
    host: optionalString(options, "host"),
    port: optionalNumber(options, "port"),
    dataDir: optionalString(options, "data-dir"),
    configPath: optionalString(options, "config"),
  };
  const config = await loadConfig(overrides);
  const token = await ensureRuntimeFiles(config);
  const releaseLock = await acquireLock(join(config.dataDir, "nwp.lock"));
  const store = new PageStore(config.dbPath);
  const workerAbort = hasFlag(options, "with-worker") ? new AbortController() : null;
  const workerLoops: Promise<void>[] = [];
  if (config.semanticSearch.enabled) {
    const extension = loadEmbeddedSqliteVec(store, config.dataDir);
    store.configureSemantic(semanticIndexConfig(config.semanticSearch));
    if (!extension.available) console.error(`semantic search unavailable: ${extension.error}`);
    else if (workerAbort) workerLoops.push(new SemanticIndexer(store, config.semanticSearch).runLoop(workerAbort.signal));
  }
  if (workerAbort && config.documentRag.enabled) workerLoops.push(new DocumentWorker(store, config.documentRag).runLoop(workerAbort.signal));
  if (workerLoops.length) console.error("background workers running in server process");

  try {
    const fetch = await createRequestHandler(store, config, token);
    const server = Bun.serve({ hostname: config.host, port: config.port, fetch });
    console.error(`nwp listening on ${server.url}`);
    console.error(`database: ${config.dbPath}`);

    await new Promise<void>((resolve) => {
      const stop = () => {
        server.stop();
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    workerAbort?.abort();
    await Promise.all(workerLoops.map((loop) => loop.catch(() => undefined)));
    store.close();
    await releaseLock();
  }
}

async function documentCommand(argv: string[]): Promise<void> {
  const action = argv[0] ?? "list";
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config"), dataDir: optionalString(options, "data-dir") });
  if (action === "run") {
    await ensureRuntimeFiles(config);
    const store = new PageStore(config.dbPath);
    try { return printResult({ processed: await new DocumentWorker(store, config.documentRag).runUntilIdle() }, hasFlag(options, "json")); }
    finally { store.close(); }
  }
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  if (action === "list") return printResult(await apiRequest(endpoint, token, "/api/v1/documents", "GET"), true);
  if (action === "get" || action === "review" || action === "cancel" || action === "retry") {
    const id = integerArgument(options, 0, `document ${action} requires a document ID`);
    const suffix = action === "get" ? "" : `/${action}`;
    return printResult(await apiRequest(endpoint, token, `/api/v1/documents/${id}${suffix}`, action === "get" ? "GET" : "POST"), true);
  }
  if (action === "import" || action === "replace") {
    const id = action === "replace" ? integerArgument(options, 0, "document replace requires a document ID") : null;
    const path = positional(options, action === "replace" ? 1 : 0);
    if (!path) throw new Error(`document ${action} requires a file path`);
    const file = Bun.file(path);
    if (!await file.exists()) throw new Error(`file not found: ${path}`);
    const filename = optionalString(options, "filename") ?? path.split(/[\\/]/).at(-1)!;
    const format = documentFormat(filename, file.type);
    const target = id === null ? "/api/v1/documents" : `/api/v1/documents/${id}/versions`;
    const response = await fetch(new URL(`${target}?filename=${encodeURIComponent(filename)}`, endpoint), { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-NWP-Source": "cli", "Content-Type": canonicalDocumentMime(format) }, body: file });
    const result = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? `API returned ${response.status}`);
    return printResult(result, true);
  }
  throw new Error("document command must be import, replace, list, get, review, cancel, retry, or run");
}

async function tagCommand(argv: string[]): Promise<void> {
  const action = argv[0] ?? "list";
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  let result: unknown;
  if (action === "list") result = await apiRequest(endpoint, token, "/api/v1/tags/definitions", "GET");
  else if (action === "define") result = await apiRequest(endpoint, token, "/api/v1/tags/definitions", "POST", {
    tag: requiredString(options, "tag"), kind: requiredString(options, "kind"), displayName: optionalString(options, "name") ?? requiredString(options, "tag"), aliases: csvOption(options, "aliases"), description: optionalString(options, "description"),
  });
  else throw new Error("tag command must be list or define");
  printResult(result, true);
}

async function workerCommand(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  const config = await loadConfig({ configPath: optionalString(options, "config"), dataDir: optionalString(options, "data-dir") });
  if (!config.semanticSearch.enabled && !config.documentRag.enabled) throw new Error("all workers are disabled");
  await ensureRuntimeFiles(config);
  const store = new PageStore(config.dbPath);
  const abort = new AbortController();
  const loops: Promise<void>[] = [];
  if (config.semanticSearch.enabled) {
    const extension = loadEmbeddedSqliteVec(store, config.dataDir);
    if (!extension.available) console.error(`semantic indexing unavailable: ${extension.error}`);
    else loops.push(new SemanticIndexer(store, config.semanticSearch).runLoop(abort.signal));
  }
  if (config.documentRag.enabled) loops.push(new DocumentWorker(store, config.documentRag).runLoop(abort.signal));
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (!loops.length) throw new Error("no worker could be started");
  console.error("nwp workers started");
  try { await Promise.all(loops); }
  finally { store.close(); }
}

async function indexCommand(argv: string[]): Promise<void> {
  const action = argv[0] ?? "status";
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config"), dataDir: optionalString(options, "data-dir") });
  await ensureRuntimeFiles(config);
  const store = new PageStore(config.dbPath);
  const extension = config.semanticSearch.enabled ? loadEmbeddedSqliteVec(store, config.dataDir) : { available: false };
  store.configureSemantic(semanticIndexConfig(config.semanticSearch));
  try {
    if (action === "run") {
      if (!config.semanticSearch.enabled || !extension.available) throw new Error("semantic search or sqlite-vec is unavailable");
      const processed = await new SemanticIndexer(store, config.semanticSearch).runUntilIdle();
      return printResult({ processed, status: store.semanticStatus(true, config.semanticSearch.embeddingModel, config.semanticSearch.embeddingDimensions) }, hasFlag(options, "json"));
    }
    if (action === "status") return printResult(store.semanticStatus(config.semanticSearch.enabled, config.semanticSearch.embeddingModel, config.semanticSearch.embeddingDimensions), hasFlag(options, "json"));
    throw new Error("index command must be run or status");
  } finally { store.close(); }
}

async function pageCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const outputJson = hasFlag(options, "json");

  let result: unknown;
  if (action === "create") {
    const title = requiredString(options, "title");
    result = await apiRequest(endpoint, token, "/api/v1/pages", "POST", {
      title,
      alias: optionalString(options, "alias"),
      body: await bodyOption(options),
      tags: csvOption(options, "tags"),
      status: optionalString(options, "status") ?? "published",
      parentId: optionalInteger(options, "parent"),
      properties: jsonObjectOption(options, "properties"),
    });
  } else if (action === "get") {
    const key = positional(options, 0) ?? optionalString(options, "id") ?? optionalString(options, "alias");
    if (!key) throw new Error("page get requires an ID or alias");
    result = await apiRequest(endpoint, token, `/api/v1/pages/${encodeURIComponent(key)}`, "GET");
  } else if (action === "list") {
    const query = new URLSearchParams();
    const cursor = optionalString(options, "cursor");
    const limit = optionalString(options, "limit");
    if (cursor) query.set("cursor", cursor);
    if (limit) query.set("limit", limit);
    const status = optionalString(options, "status");
    if (status) query.set("status", status);
    result = await apiRequest(endpoint, token, `/api/v1/pages${query.size ? `?${query}` : ""}`, "GET");
  } else if (action === "update") {
    const id = integerArgument(options, 0, "page update requires an integer page ID");
    const changes: Record<string, unknown> = {};
    if (hasOption(options, "title")) changes.title = requiredString(options, "title");
    if (hasOption(options, "alias")) changes.alias = requiredString(options, "alias");
    if (hasOption(options, "body") || hasOption(options, "body-file")) changes.body = await bodyOption(options);
    if (hasOption(options, "tags")) changes.tags = csvOption(options, "tags");
    if (hasOption(options, "status")) changes.status = requiredString(options, "status");
    if (hasOption(options, "parent")) changes.parentId = optionalInteger(options, "parent");
    if (hasOption(options, "properties")) changes.properties = jsonObjectOption(options, "properties");
    result = await apiRequest(endpoint, token, `/api/v1/pages/${id}`, "PUT", changes);
  } else if (action === "delete") {
    const id = integerArgument(options, 0, "page delete requires an integer page ID");
    result = await apiRequest(endpoint, token, `/api/v1/pages/${id}`, "DELETE");
  } else if (action === "history") {
    const id = integerArgument(options, 0, "page history requires an integer page ID");
    const query = new URLSearchParams();
    const cursor = optionalString(options, "cursor");
    const limit = optionalString(options, "limit");
    if (cursor) query.set("cursor", cursor);
    if (limit) query.set("limit", limit);
    result = await apiRequest(endpoint, token, `/api/v1/pages/${id}/revisions${query.size ? `?${query}` : ""}`, "GET");
  } else if (action === "diff") {
    const id = integerArgument(options, 0, "page diff requires an integer page ID");
    const revision = integerArgument(options, 1, "page diff requires an integer revision ID");
    result = await apiRequest(endpoint, token, `/api/v1/pages/${id}/revisions/${revision}/diff`, "GET");
  } else if (action === "restore") {
    const id = integerArgument(options, 0, "page restore requires an integer page ID");
    const revision = integerArgument(options, 1, "page restore requires an integer revision ID");
    result = await apiRequest(endpoint, token, `/api/v1/pages/${id}/revisions/${revision}/restore`, "POST");
  } else {
    throw new Error("page command must be create, get, list, update, delete, history, diff, or restore");
  }

  printResult(result, outputJson);
}

async function importCommand(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  const path = positional(options, 0);
  if (!path) throw new Error("import requires a Markdown file path");
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const file = Bun.file(path);
  if (!await file.exists()) throw new Error(`file not found: ${path}`);
  const response = await fetch(new URL("/api/v1/import/pages", endpoint), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-NWP-Source": "cli", "Content-Type": "text/markdown" },
    body: file,
  });
  const result = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? `API returned ${response.status}`);
  printResult(result, hasFlag(options, "json"));
}

async function exportCommand(argv: string[]): Promise<void> {
  const kind = argv[0];
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  let path: string;
  let output: string;
  if (kind === "page") {
    const id = integerArgument(options, 0, "export page requires an integer page ID");
    path = `/api/v1/pages/${id}/export`;
    output = optionalString(options, "output") ?? `page-${id}.md`;
  } else if (kind === "all") {
    path = "/api/v1/export";
    output = optionalString(options, "output") ?? "nwp-export.tar.gz";
  } else throw new Error("export command must be page or all");
  const response = await fetch(new URL(path, endpoint), { headers: { Authorization: `Bearer ${token}`, "X-NWP-Source": "cli" } });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  await Bun.write(output, response);
  printResult({ saved: output }, hasFlag(options, "json"));
}

async function treeCommand(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const status = optionalString(options, "status") ?? "published";
  const result = await apiRequest(endpoint, token, `/api/v1/tree?status=${encodeURIComponent(status)}`, "GET");
  printResult(result, hasFlag(options, "json"));
}

async function attachmentCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  let result: unknown;

  if (action === "add") {
    const pageId = integerArgument(options, 0, "attachment add requires an integer page ID");
    const path = positional(options, 1);
    if (!path) throw new Error("attachment add requires a file path");
    const file = Bun.file(path);
    if (!await file.exists()) throw new Error(`file not found: ${path}`);
    const filename = optionalString(options, "name") ?? path.split(/[\\/]/).at(-1)!;
    const response = await fetch(new URL(`/api/v1/pages/${pageId}/attachments?filename=${encodeURIComponent(filename)}`, endpoint), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-NWP-Source": "cli", "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    result = await response.json();
    if (!response.ok) throw new Error((result as { error?: { message?: string } }).error?.message ?? `API returned ${response.status}`);
  } else if (action === "list") {
    const pageId = integerArgument(options, 0, "attachment list requires an integer page ID");
    result = await apiRequest(endpoint, token, `/api/v1/pages/${pageId}/attachments`, "GET");
  } else if (action === "get") {
    const id = integerArgument(options, 0, "attachment get requires an integer attachment ID");
    const output = optionalString(options, "output");
    if (output) {
      const response = await fetch(new URL(`/api/v1/attachments/${id}/content?download=1`, endpoint), { headers: { Authorization: `Bearer ${token}`, "X-NWP-Source": "cli" } });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      await Bun.write(output, response);
      result = { saved: output, attachmentId: Number(id) };
    } else result = await apiRequest(endpoint, token, `/api/v1/attachments/${id}`, "GET");
  } else if (action === "delete") {
    const id = integerArgument(options, 0, "attachment delete requires an integer attachment ID");
    result = await apiRequest(endpoint, token, `/api/v1/attachments/${id}`, "DELETE");
  } else {
    throw new Error("attachment command must be add, list, get, or delete");
  }
  printResult(result, hasFlag(options, "json"));
}

async function trashCommand(argv: string[]): Promise<void> {
  const action = argv[0] ?? "list";
  const options = parseOptions(argv.slice(1));
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  let result: unknown;

  if (action === "list") {
    const query = new URLSearchParams();
    const cursor = optionalString(options, "cursor");
    const limit = optionalString(options, "limit");
    if (cursor) query.set("cursor", cursor);
    if (limit) query.set("limit", limit);
    result = await apiRequest(endpoint, token, `/api/v1/trash${query.size ? `?${query}` : ""}`, "GET");
  } else if (action === "get") {
    const id = integerArgument(options, 0, "trash get requires an integer page ID");
    result = await apiRequest(endpoint, token, `/api/v1/trash/${id}`, "GET");
  } else if (action === "restore") {
    const id = integerArgument(options, 0, "trash restore requires an integer page ID");
    result = await apiRequest(endpoint, token, `/api/v1/trash/${id}/restore`, "POST");
  } else if (action === "purge") {
    const id = integerArgument(options, 0, "trash purge requires an integer page ID");
    await apiRequest(endpoint, token, `/api/v1/trash/${id}`, "DELETE");
    result = { purged: true, pageId: Number(id) };
  } else {
    throw new Error("trash command must be list, get, restore, or purge");
  }
  printResult(result, hasFlag(options, "json"));
}

async function searchCommand(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  const config = await loadConfig({ configPath: optionalString(options, "config") });
  const token = optionalString(options, "token") ?? await readApiToken(config);
  const endpoint = optionalString(options, "endpoint") ?? `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  const query = positional(options, 0) ?? optionalString(options, "query") ?? "";
  const params = new URLSearchParams({ q: query });
  const tags = optionalString(options, "tags");
  const cursor = optionalString(options, "cursor");
  const limit = optionalString(options, "limit");
  if (tags) params.set("tags", tags);
  if (cursor) params.set("cursor", cursor);
  const status = optionalString(options, "status");
  const properties = optionalString(options, "properties");
  const mode = optionalString(options, "mode");
  if (status) params.set("status", status);
  if (mode) params.set("mode", mode);
  if (properties) params.set("properties", properties);
  if (limit) params.set("limit", limit);
  const result = await apiRequest(endpoint, token, `/api/v1/search?${params}`, "GET");
  printResult(result, hasFlag(options, "json"));
}

async function apiRequest(endpoint: string, token: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, endpoint), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-NWP-Source": "cli",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const value = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? `API returned ${response.status}`);
  return value;
}

function printResult(result: unknown, asJson: boolean): void {
  if (asJson) return console.log(JSON.stringify(result, null, 2));
  if (isPage(result)) return console.log(`${result.id}\t${result.alias}\t${result.title}`);
  if (isObject(result) && Array.isArray(result.pages)) {
    for (const page of result.pages) if (isPage(page)) {
      const depthValue = (page as Record<string, unknown>).depth;
      const depth = typeof depthValue === "number" ? depthValue : 0;
      console.log(`${"  ".repeat(depth)}${page.id}\t${page.alias}\t${page.title}`);
    }
    if (result.nextCursor) console.error(`next cursor: ${result.nextCursor}`);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPage(value: unknown): value is { id: number; alias: string; title: string } {
  return isObject(value) && typeof value.id === "number" && typeof value.alias === "string" && typeof value.title === "string";
}

type ParsedOptions = Map<string, string | true | string[]> & { positionals?: string[] };

function parseOptions(argv: string[]): ParsedOptions {
  const result = new Map<string, string | true | string[]>() as ParsedOptions;
  result.positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) { result.positionals.push(arg); continue; }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    if (!rawKey) throw new Error("invalid empty option");
    const next = argv[index + 1];
    const value = inline ?? (next && !next.startsWith("--") ? (index += 1, next) : true);
    result.set(rawKey, value);
  }
  return result;
}

function hasOption(options: ParsedOptions, key: string): boolean { return options.has(key); }
function hasFlag(options: ParsedOptions, key: string): boolean { return options.get(key) === true; }
function positional(options: ParsedOptions, index: number): string | undefined { return options.positionals?.[index]; }
function optionalString(options: ParsedOptions, key: string): string | undefined {
  const value = options.get(key);
  if (value === undefined) return undefined;
  if (value === true || Array.isArray(value)) throw new Error(`--${key} requires a value`);
  return value;
}
function requiredString(options: ParsedOptions, key: string): string {
  const value = optionalString(options, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}
function optionalNumber(options: ParsedOptions, key: string): number | undefined {
  const value = optionalString(options, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`--${key} must be an integer`);
  return number;
}
function integerArgument(options: ParsedOptions, index: number, message: string): string {
  const value = positional(options, index);
  if (!value || !/^\d+$/.test(value)) throw new Error(message);
  return value;
}
function optionalInteger(options: ParsedOptions, key: string): number | null {
  const value = optionalString(options, key);
  if (value === undefined || value === "" || value === "none" || value === "null") return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--${key} must be a positive integer or 'none'`);
  return Number(value);
}
function jsonObjectOption(options: ParsedOptions, key: string): Record<string, unknown> {
  const value = optionalString(options, key);
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error(`--${key} must be a JSON object`); }
}
function csvOption(options: ParsedOptions, key: string): string[] {
  const value = optionalString(options, key);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}
async function bodyOption(options: ParsedOptions): Promise<string> {
  const file = optionalString(options, "body-file");
  if (file) return file === "-" ? await Bun.stdin.text() : readFile(file, "utf8");
  return optionalString(options, "body") ?? "";
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (!Number.isInteger(pid)) stale = true;
      else process.kill(pid, 0);
    } catch (lockError) {
      if ((lockError as NodeJS.ErrnoException).code === "ESRCH") stale = true;
      else if ((lockError as NodeJS.ErrnoException).code === "ENOENT") stale = true;
    }
    if (!stale) throw new Error(`another nwp instance holds ${path}`);
    await rm(path, { force: true });
    return acquireLock(path);
  }
  return () => rm(path, { force: true });
}

function printHelp(): void {
  console.log(`nwp - nano-wiki-pi

Usage:
  nwp serve [--host HOST] [--port PORT] [--data-dir PATH] [--config PATH]
  nwp page create --title TITLE [--alias ALIAS] [--body TEXT|--body-file PATH] [--tags a,b] [--status STATUS] [--parent ID] [--properties JSON] [--json]
  nwp page get ID|ALIAS [--json]
  nwp page list [--status STATUS|all] [--limit N] [--cursor CURSOR] [--json]
  nwp page update ID [--title TITLE] [--alias ALIAS] [--body TEXT|--body-file PATH] [--tags a,b] [--status STATUS] [--parent ID|none] [--properties JSON] [--json]
  nwp page delete ID [--json]
  nwp page history ID [--limit N] [--cursor CURSOR] [--json]
  nwp page diff ID REVISION_ID [--json]
  nwp page restore ID REVISION_ID [--json]
  nwp search [QUERY] [--mode hybrid|lexical] [--tags a,b] [--status STATUS|all] [--properties JSON] [--limit N] [--cursor CURSOR] [--json]
  nwp tree [--status STATUS|all] [--json]
  nwp tag list
  nwp tag define --tag TAG --kind KIND [--name NAME] [--aliases LIST]
  nwp document import PATH
  nwp document replace ID PATH
  nwp document list
  nwp document get ID
  nwp document review|cancel|retry ID
  nwp document run [--json]
  nwp trash list [--limit N] [--cursor CURSOR] [--json]
  nwp trash get|restore|purge ID [--json]
  nwp attachment add PAGE_ID PATH [--name FILENAME] [--json]
  nwp attachment list PAGE_ID [--json]
  nwp attachment get ID [--output PATH] [--json]
  nwp attachment delete ID [--json]
  nwp import PATH [--json]
  nwp export page ID [--output PATH] [--json]
  nwp export all [--output PATH] [--json]
  nwp index status [--json]
  nwp index run [--json]
  nwp worker

Serve option:
  --with-worker       Run document extraction and semantic indexing in the server process

Client options:
  --endpoint URL   Override the configured server URL
  --token TOKEN    Override the token file
  --config PATH    Use another config file`);
}
