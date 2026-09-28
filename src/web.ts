import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { WebCaptureConfig } from "./config.ts";
import type { PageStore, WebCaptureTask } from "./database.ts";
import { AppError } from "./domain.ts";

export interface FetchedWebPage {
  kind: "content";
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  title: string;
  markdown: string;
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

async function requestOnce(url: URL, config: WebCaptureConfig, conditions: WebFetchConditions | null): Promise<{ response: IncomingMessage; bytes: Uint8Array }> {
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
      headers: { Host: url.host, "User-Agent": config.userAgent, Accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9", "Accept-Encoding": "identity", ...(conditions?.etag ? { "If-None-Match": conditions.etag } : {}), ...(conditions?.lastModified ? { "If-Modified-Since": conditions.lastModified } : {}) },
    }, async (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) { clearTimeout(timer); response.resume(); resolve({ response, bytes: new Uint8Array() }); return; }
      try { resolve({ response, bytes: await readResponse(response, config.maxResponseBytes) }); }
      catch (error) { reject(error); }
      finally { clearTimeout(timer); }
    });
    timer = setTimeout(() => request.destroy(new AppError("web_fetch_timeout", "web capture timed out", 504)), config.timeoutSeconds * 1000);
    request.on("error", (error) => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

export async function fetchPublicWebPage(value: string, config: WebCaptureConfig, conditions: WebFetchConditions | null = null): Promise<WebFetchResult> {
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
    const extracted = extractWebContent(bytes, contentType, current.toString(), config.maxExtractedCharacters);
    return { kind: "content", requestedUrl, finalUrl: current.toString(), status, contentType, bytes, ...extracted, etag, lastModified };
  }
}

export function extractWebContent(bytes: Uint8Array, contentType: string, sourceUrl: string, maximum: number): { title: string; markdown: string } {
  const input = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let title = new URL(sourceUrl).hostname;
  let content = input;
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(input);
    if (titleMatch) title = cleanText(titleMatch[1]!).replace(/\s+/g, " ").trim().slice(0, 200) || title;
    content = input
      .replace(/<(script|style|noscript|svg|canvas|template|form|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "\n")
      .replace(/<h1\b[^>]*>/gi, "\n# ").replace(/<h2\b[^>]*>/gi, "\n## ").replace(/<h[3-6]\b[^>]*>/gi, "\n### ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/?(?:p|div|section|article|main|br|tr|blockquote|pre|table|ul|ol|h[1-6])\b[^>]*>/gi, "\n")
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
  return { title, markdown };
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
