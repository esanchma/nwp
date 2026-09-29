import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { WebCaptureConfig } from "./config.ts";
import type { PageStore, WebCaptureTask } from "./database.ts";
import { AppError, type DocumentFormat } from "./domain.ts";

export interface FetchedWebAsset {
  ordinal: number;
  sourceUrl: string;
  finalUrl: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
  alt: string;
}

export interface WebAssetReference {
  ordinal: number;
  sourceUrl: string;
  alt: string;
  marker: string;
}

export interface WebCapturedDocument {
  filename: string;
  mimeType: string;
  format: DocumentFormat;
}

export interface FetchedWebPage {
  kind: "content";
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  title: string;
  markdown: string;
  assets: FetchedWebAsset[];
  document?: WebCapturedDocument;
  etag: string | null;
  lastModified: string | null;
}

export interface NotModifiedWebPage {
  kind: "not_modified";
  requestedUrl: string;
  finalUrl: string;
  status: 304;
  etag: string | null;
  lastModified: string | null;
}

export type WebFetchResult = FetchedWebPage | NotModifiedWebPage;
export interface WebFetchConditions { finalUrl: string | null; etag: string | null; lastModified: string | null }

export function normalizeWebUrl(value: string): string {
  if (!value.trim() || value.length > 4096) throw new AppError("invalid_web_url", "URL must contain between 1 and 4096 characters", 400);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError("invalid_web_url", "URL must be an absolute public HTTP(S) URL", 400); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("invalid_web_url", "only HTTP and HTTPS URLs are supported", 400);
  if (url.username || url.password) throw new AppError("invalid_web_url", "URL credentials are not allowed", 400);
  if (!url.hostname || url.hostname.endsWith(".localhost") || url.hostname === "localhost") throw new AppError("unsafe_web_destination", "local destinations are not allowed", 400);
  const literal = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(literal) && !isPublicIp(literal)) throw new AppError("unsafe_web_destination", "private, loopback, link-local, and reserved destinations are blocked", 400);
  url.hash = "";
  return url.toString();
}

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28], ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) blockedV6.addSubnet(network, prefix, "ipv6");

export function isPublicIp(address: string): boolean {
  const value = address.toLowerCase().split("%")[0]!;
  const family = isIP(value);
  return family === 4 ? !blockedV4.check(value, "ipv4") : family === 6 ? !blockedV6.check(value, "ipv6") : false;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new AppError("unsafe_web_destination", "private, loopback, link-local, and reserved destinations are blocked", 400);
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  let records: Array<{ address: string; family: number }>;
  try { records = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new AppError("web_dns_failed", `could not resolve '${hostname}'`, 502); }
  if (!records.length || records.some((record) => !isPublicIp(record.address))) throw new AppError("unsafe_web_destination", "the hostname resolves to a non-public destination", 400);
  const selected = records[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function readResponse(response: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"] ?? 0);
  if (declared > maximum) { response.destroy(); return Promise.reject(new AppError("web_response_too_large", `response exceeds the ${maximum} byte guard`, 413)); }
  if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(); return Promise.reject(new AppError("unsupported_web_encoding", "compressed web responses are not accepted", 415)); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) {
        response.destroy();
        reject(new AppError("web_response_too_large", `response exceeds the ${maximum} byte guard`, 413));
      } else chunks.push(chunk);
    });
    response.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    response.on("error", reject);
  });
}

async function requestOnce(url: URL, config: WebCaptureConfig, conditions: WebFetchConditions | null, maximum = config.maxResponseBytes, accept = "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9"): Promise<{ response: IncomingMessage; bytes: Uint8Array }> {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const target = await resolvePublicAddress(hostname);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.protocol === "https:" ? hostname : undefined,
      headers: { Host: url.host, "User-Agent": config.userAgent, Accept: accept, "Accept-Encoding": "identity", ...(conditions?.etag ? { "If-None-Match": conditions.etag } : {}), ...(conditions?.lastModified ? { "If-Modified-Since": conditions.lastModified } : {}) },
    }, async (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) { clearTimeout(timer); response.resume(); resolve({ response, bytes: new Uint8Array() }); return; }
      try { resolve({ response, bytes: await readResponse(response, maximum) }); }
      catch (error) { reject(error); }
      finally { clearTimeout(timer); }
    });
    timer = setTimeout(() => request.destroy(new AppError("web_fetch_timeout", "web capture timed out", 504)), config.timeoutSeconds * 1000);
    request.on("error", (error) => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

export async function fetchPublicWebPage(value: string, config: WebCaptureConfig, conditions: WebFetchConditions | null = null): Promise<WebFetchResult> {
  if (config.fetchCommand) return fetchWithWebResearch(value, config);
  const requestedUrl = normalizeWebUrl(value);
  let current = new URL(requestedUrl);
  for (let redirects = 0; ; redirects += 1) {
    const sendConditions = conditions?.finalUrl === current.toString() ? conditions : null;
    const { response, bytes } = await requestOnce(current, config, sendConditions);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      if (redirects >= config.maxRedirects) throw new AppError("too_many_web_redirects", "web capture exceeded the redirect guard", 422);
      current = new URL(normalizeWebUrl(new URL(location, current).toString()));
      continue;
    }
    const etag = safeValidator(response.headers.etag);
    const lastModified = safeValidator(response.headers["last-modified"]);
    if (status === 304) return { kind: "not_modified", requestedUrl, finalUrl: current.toString(), status, etag: etag ?? conditions?.etag ?? null, lastModified: lastModified ?? conditions?.lastModified ?? null };
    if (status < 200 || status >= 300) throw new AppError("web_fetch_failed", `remote server returned HTTP ${status}`, status === 408 || status === 429 || status >= 500 ? 502 : 422);
    const contentType = String(response.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
    if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].includes(contentType)) throw new AppError("unsupported_web_content", `unsupported web content type '${contentType}'`, 415);
    const document = capturedWebDocument(current, contentType, bytes, response.headers["content-disposition"]);
    if (document) return { kind: "content", requestedUrl, finalUrl: current.toString(), status, contentType, bytes, title: basename(document.filename, extname(document.filename)), markdown: "", assets: [], document, etag, lastModified };
    if (!["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].includes(contentType)) throw new AppError("unsupported_web_content", `unsupported web content type '${contentType}'`, 415);
    const extracted = extractWebContent(bytes, contentType, current.toString(), config.maxExtractedCharacters);
    const captured = await captureWebAssets(extracted.markdown, extracted.assets, config);
    return { kind: "content", requestedUrl, finalUrl: current.toString(), status, contentType, bytes, title: extracted.title, markdown: captured.markdown, assets: captured.assets, etag, lastModified };
  }
}

async function fetchPublicWebDocument(value: string, config: WebCaptureConfig): Promise<FetchedWebPage> {
  const requestedUrl = normalizeWebUrl(value);
  let current = new URL(requestedUrl);
  for (let redirects = 0; ; redirects += 1) {
    const { response, bytes } = await requestOnce(current, config, null, config.maxResponseBytes, "application/pdf");
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      if (redirects >= config.maxRedirects) throw new AppError("too_many_web_redirects", "web capture exceeded the redirect guard", 422);
      current = new URL(normalizeWebUrl(new URL(location, current).toString()));
      continue;
    }
    if (status < 200 || status >= 300) throw new AppError("web_fetch_failed", `remote server returned HTTP ${status}`, status === 408 || status === 429 || status >= 500 ? 502 : 422);
    const contentType = String(response.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
    const document = capturedWebDocument(current, contentType, bytes, response.headers["content-disposition"]);
    if (!document) throw new AppError("unsupported_web_content", "delegated extraction identified a PDF but the verified response is not a PDF", 415);
    return { kind: "content", requestedUrl, finalUrl: current.toString(), status, contentType, bytes, title: basename(document.filename, extname(document.filename)), markdown: "", assets: [], document, etag: safeValidator(response.headers.etag), lastModified: safeValidator(response.headers["last-modified"]) };
  }
}

function capturedWebDocument(url: URL, contentType: string, bytes: Uint8Array, contentDisposition: string | string[] | undefined): WebCapturedDocument | null {
  if (contentType !== "application/pdf" || !hasPdfSignature(bytes)) return null;
  const header = Array.isArray(contentDisposition) ? contentDisposition[0] : contentDisposition;
  const suggested = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(header ?? "")?.[1];
  const fallback = basename(url.pathname) || "web-capture.pdf";
  const filename = basename(decodeURIComponent(suggested || fallback)).replace(/[^\w.() -]/g, "_").slice(0, 240) || "web-capture.pdf";
  return { filename: filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`, mimeType: "application/pdf", format: "pdf" };
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength - 5, 1024);
  for (let index = 0; index <= limit; index += 1) if (bytes[index] === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44 && bytes[index + 3] === 0x46 && bytes[index + 4] === 0x2d) return true;
  return false;
}

async function fetchWithWebResearch(value: string, config: WebCaptureConfig): Promise<FetchedWebPage> {
  const requestedUrl = normalizeWebUrl(value);
  const process = Bun.spawn([config.fetchCommand, "fetch", requestedUrl, `--mode=${config.fetchMode}`, "--images=references"], { stdout: "pipe", stderr: "pipe", env: { ...processEnv(), WEB_RESEARCH_NO_CACHE: "1" } });
  const timer = setTimeout(() => process.kill(), config.fetchTimeoutSeconds * 1000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessOutput(process.stdout, config.maxFetchOutputBytes, process),
      readProcessOutput(process.stderr, Math.min(config.maxFetchOutputBytes, 64 * 1024), process),
      process.exited,
    ]);
    if (exitCode !== 0) throw new AppError("web_research_fetch_failed", `web-research fetch failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`, 502);
    const parsed = parseWebResearchOutput(stdout);
    const adapterOutput = new TextEncoder().encode(stdout);
    const title = parsed.metadata.TITLE?.trim().slice(0, 200) || /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim().slice(0, 200) || new URL(requestedUrl).hostname;
    const delegatedContentType = parsed.metadata.CONTENT_TYPE?.split(";", 1)[0]?.trim().toLowerCase() || "";
    if (delegatedContentType === "application/pdf") return fetchPublicWebDocument(requestedUrl, config);
    if (config.fetchMode === "raw") {
      const contentType = parsed.metadata.CONTENT_TYPE?.split(";", 1)[0]?.trim().toLowerCase() || "text/html";
      const bytes = new TextEncoder().encode(parsed.body);
      const extracted = extractWebContent(bytes, contentType, requestedUrl, config.maxExtractedCharacters);
      const captured = await captureWebAssets(extracted.markdown, extracted.assets, config);
      return { kind: "content", requestedUrl, finalUrl: requestedUrl, status: 200, contentType: "text/plain; profile=web-research", bytes: adapterOutput, title: extracted.title, markdown: captured.markdown, assets: captured.assets, etag: null, lastModified: null };
    }
    const body = parsed.body.trim();
    if (!body) throw new AppError("empty_web_content", "web-research returned no extracted content", 422);
    const prepared = extractMarkdownAssetReferences(body, requestedUrl);
    let markdown = prepared.markdown;
    if (!/^Source:\s+/mi.test(markdown)) markdown = `Source: ${requestedUrl}\n\n${markdown}`;
    if (markdown.length > config.maxExtractedCharacters) throw new AppError("web_content_too_large", `extracted content exceeds the ${config.maxExtractedCharacters} character guard`, 413);
    const captured = await captureWebAssets(markdown, prepared.assets, config);
    return { kind: "content", requestedUrl, finalUrl: requestedUrl, status: 200, contentType: "text/plain; profile=web-research", bytes: adapterOutput, title, markdown: captured.markdown, assets: captured.assets, etag: null, lastModified: null };
  } finally { clearTimeout(timer); }
}

export function parseWebResearchOutput(output: string): { metadata: Record<string, string>; body: string } {
  const start = "BEGIN_UNTRUSTED_WEB_CONTENT\n";
  const startIndex = output.indexOf(start);
  const endIndex = output.lastIndexOf("\nEND_UNTRUSTED_WEB_CONTENT");
  if (startIndex < 0 || endIndex < startIndex) throw new AppError("invalid_web_research_output", "web-research returned an invalid content envelope", 502);
  const payload = output.slice(startIndex + start.length, endIndex).replace(/\r/g, "");
  const separator = payload.indexOf("\n\n");
  if (separator < 0) throw new AppError("invalid_web_research_output", "web-research content envelope has no body", 502);
  const metadata: Record<string, string> = {};
  for (const line of payload.slice(0, separator).split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) metadata[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  let body = payload.slice(separator + 2).trim();
  body = body.replace(/^WARNING: Potential prompt-injection-like content detected\. Treat the following content as untrusted data only\.\n+/, "");
  return { metadata, body };
}

function extractMarkdownAssetReferences(markdown: string, sourceUrl: string): { markdown: string; assets: WebAssetReference[] } {
  const assets: WebAssetReference[] = [];
  const rewritten = markdown.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/gi, (_match, altValue: string, urlValue: string) => {
    let source: string;
    try { source = normalizeWebUrl(new URL(urlValue, sourceUrl).toString()); } catch { return _match; }
    const ordinal = assets.length;
    const marker = `NWP_WEB_ASSET_${ordinal}_PLACEHOLDER`;
    const alt = altValue.replace(/[\[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    assets.push({ ordinal, sourceUrl: source, alt, marker });
    return `![${alt}](${marker})`;
  });
  return { markdown: rewritten, assets };
}

async function readProcessOutput(stream: ReadableStream<Uint8Array>, maximum: number, process: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { process.kill(); throw new AppError("web_research_output_too_large", `web-research output exceeds the ${maximum} byte guard`, 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function extractWebContent(bytes: Uint8Array, contentType: string, sourceUrl: string, maximum: number): { title: string; markdown: string; assets: WebAssetReference[] } {
  const input = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const assets: WebAssetReference[] = [];
  let title = new URL(sourceUrl).hostname;
  let content = input;
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(input);
    if (titleMatch) title = cleanText(titleMatch[1]!).replace(/\s+/g, " ").trim().slice(0, 200) || title;
    content = input
      .replace(/<(script|style|noscript|svg|canvas|template|form|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "\n")
      .replace(/<img\b[^>]*>/gi, (tag) => imageMarkdown(tag, sourceUrl, assets))
      .replace(/<h1\b[^>]*>/gi, "\n# ").replace(/<h2\b[^>]*>/gi, "\n## ").replace(/<h[3-6]\b[^>]*>/gi, "\n### ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/?(?:p|div|section|article|main|figure|figcaption|br|tr|blockquote|pre|table|ul|ol|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
  } else if (contentType === "text/markdown") {
    const heading = /^#\s+(.+)$/m.exec(input);
    if (heading) title = heading[1]!.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  title ||= new URL(sourceUrl).hostname;
  content = cleanText(content).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!content) throw new AppError("empty_web_content", "the page did not contain extractable text", 422);
  const prefix = `# ${title}\n\nSource: ${sourceUrl}\n\n`;
  const markdown = `${prefix}${content}`;
  if (markdown.length > maximum) throw new AppError("web_content_too_large", `extracted content exceeds the ${maximum} character guard`, 413);
  return { title, markdown, assets };
}

function imageMarkdown(tag: string, sourceUrl: string, assets: WebAssetReference[]): string {
  const source = imageSource(tag);
  if (!source) return "\n";
  let resolved: string;
  try { resolved = normalizeWebUrl(new URL(cleanText(source), sourceUrl).toString()); }
  catch { return "\n"; }
  const ordinal = assets.length;
  const marker = `NWP_WEB_ASSET_${ordinal}_PLACEHOLDER`;
  const alt = cleanText(attribute(tag, "alt") ?? "").replace(/[\[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  assets.push({ ordinal, sourceUrl: resolved, alt, marker });
  return `\n\n![${alt}](${marker})\n\n`;
}

function imageSource(tag: string): string | null {
  for (const name of ["data-src", "data-lazy-src", "data-original", "src"]) {
    const value = attribute(tag, name)?.trim();
    if (value && !value.startsWith("data:") && !value.startsWith("blob:")) return value;
  }
  for (const name of ["data-srcset", "srcset"]) {
    const value = attribute(tag, name);
    if (!value) continue;
    const candidates = value.split(",").map((item) => item.trim().split(/\s+/, 1)[0]).filter(Boolean);
    const selected = candidates.at(-1);
    if (selected && !selected.startsWith("data:") && !selected.startsWith("blob:")) return selected;
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

async function captureWebAssets(markdownValue: string, references: WebAssetReference[], config: WebCaptureConfig): Promise<{ markdown: string; assets: FetchedWebAsset[] }> {
  let markdown = markdownValue;
  const assets: FetchedWebAsset[] = [];
  const fetched = new Map<string, Omit<FetchedWebAsset, "ordinal" | "alt"> | null>();
  let totalBytes = 0;
  for (const reference of references) {
    if (reference.ordinal >= config.maxAssetCount) {
      markdown = dropImage(markdown, reference);
      continue;
    }
    let resource = fetched.get(reference.sourceUrl);
    if (resource === undefined) {
      try {
        const result = await fetchPublicImage(reference.sourceUrl, config);
        if (totalBytes + result.bytes.byteLength > config.maxTotalAssetBytes) resource = null;
        else {
          totalBytes += result.bytes.byteLength;
          resource = result;
        }
      } catch { resource = null; }
      fetched.set(reference.sourceUrl, resource);
    }
    if (!resource) {
      markdown = dropImage(markdown, reference);
      continue;
    }
    const asset = { ...resource, ordinal: reference.ordinal, alt: reference.alt };
    assets.push(asset);
    markdown = markdown.replace(`![${reference.alt}](${reference.marker})`, `![${reference.alt}](/web-assets/${asset.sha256}/${encodeURIComponent(asset.filename)})`);
  }
  return { markdown, assets };
}

function dropImage(markdown: string, reference: WebAssetReference): string {
  return markdown.replace(`![${reference.alt}](${reference.marker})`, reference.alt ? `*Image unavailable: ${reference.alt}*` : "");
}

async function fetchPublicImage(value: string, config: WebCaptureConfig): Promise<Omit<FetchedWebAsset, "ordinal" | "alt">> {
  const sourceUrl = normalizeWebUrl(value);
  let current = new URL(sourceUrl);
  for (let redirects = 0; ; redirects += 1) {
    const { response, bytes } = await requestOnce(current, config, null, config.maxAssetBytes, "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp;q=0.8");
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      if (redirects >= config.maxRedirects) throw new AppError("too_many_web_redirects", "web asset exceeded the redirect guard", 422);
      current = new URL(normalizeWebUrl(new URL(response.headers.location, current).toString()));
      continue;
    }
    if (status < 200 || status >= 300) throw new AppError("web_asset_fetch_failed", `remote image returned HTTP ${status}`, 422);
    const image = detectWebImage(bytes);
    if (!image) throw new AppError("unsupported_web_asset", "web asset is not a supported raster image", 415);
    const original = basename(current.pathname);
    const stem = original.slice(0, Math.max(0, original.length - extname(original).length)).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "image";
    const filename = `${stem}.${image.extension}`;
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex") as string;
    return { sourceUrl, finalUrl: current.toString(), filename, mimeType: image.mimeType, bytes, sha256 };
  }
}

function detectWebImage(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mimeType: "image/png", extension: "png" };
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6)))) return { mimeType: "image/gif", extension: "gif" };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  if (starts(0x42, 0x4d)) return { mimeType: "image/bmp", extension: "bmp" };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 12)).startsWith("ftypavi")) return { mimeType: "image/avif", extension: "avif" };
  return null;
}

function safeValidator(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || !value || value.length > 1000 || /[\r\n]/.test(value)) return null;
  return value;
}

function cleanText(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[entity.toLowerCase()] ?? " ";
  }).replace(/\r/g, "").replace(/[\t ]+/g, " ");
}

export class WebCaptureWorker {
  readonly owner = `web-${process.pid}-${randomUUID()}`;

  constructor(private readonly store: PageStore, private readonly config: WebCaptureConfig, private readonly documentMaxBytes: number) {}

  async runOne(): Promise<boolean> {
    this.store.enqueueDueWebCaptures();
    const task = this.store.claimWebCaptureTask(this.owner);
    if (!task) return false;
    const heartbeat = setInterval(() => this.store.renewWebCaptureLease(task), 10_000);
    try {
      const result = await fetchPublicWebPage(task.url, this.config, { finalUrl: task.finalUrl, etag: task.etag, lastModified: task.lastModified });
      this.store.completeWebCaptureTask(task, result, this.documentMaxBytes);
    } catch (error) {
      this.store.failWebCaptureTask(task, error instanceof Error ? error.message : String(error), !(error instanceof AppError && error.status < 500));
    } finally { clearInterval(heartbeat); }
    return true;
  }

  async runUntilIdle(): Promise<number> {
    let processed = 0;
    while (await this.runOne()) processed += 1;
    return processed;
  }

  async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) if (!await this.runOne()) await Bun.sleep(1000);
  }
}
