import { randomUUID } from "node:crypto";
import { answerQuestion, type AnswerResult } from "./answer.ts";
import type { RagAnswerConfig, ResearchConfig } from "./config.ts";
import type { PageStore } from "./database.ts";
import { AppError } from "./domain.ts";
import type { OllamaEmbedder } from "./semantic.ts";
import { normalizeWebUrl } from "./web.ts";

export async function discoverResearchUrls(query: string, config: ResearchConfig, signal?: AbortSignal): Promise<string[]> {
  if (!config.searchCommand) throw new AppError("research_search_unavailable", "research.search_command is not configured; provide source URLs explicitly", 422);
  const process = Bun.spawn([config.searchCommand, "search", query], { stdout: "pipe", stderr: "pipe", env: processEnv() });
  const timer = setTimeout(() => process.kill(), config.searchTimeoutSeconds * 1000);
  const abort = () => process.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(process.stdout, config.maxSearchOutputBytes, process),
      readBounded(process.stderr, Math.min(config.maxSearchOutputBytes, 64 * 1024), process),
      process.exited,
    ]);
    if (exitCode !== 0) throw new AppError("research_search_failed", `web research search failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`, 502);
    const urls: string[] = [];
    for (const match of stdout.matchAll(/^URL:\s*(\S+)\s*$/gim)) {
      try { urls.push(normalizeSearchResultUrl(match[1]!)); } catch { /* Ignore unsafe and malformed search results. */ }
    }
    return [...new Set(urls)].slice(0, config.maximumSources);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function normalizeSearchResultUrl(value: string): string {
  if (value.startsWith("//duckduckgo.com/l/")) {
    const redirect = new URL(`https:${value.replaceAll("&amp;", "&")}`);
    const destination = redirect.searchParams.get("uddg");
    if (!destination) throw new Error("DuckDuckGo result has no destination");
    return normalizeWebUrl(destination);
  }
  return normalizeWebUrl(value);
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximum: number, process: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        process.kill();
        throw new AppError("research_search_output_too_large", `search output exceeds the ${maximum} byte guard`, 413);
      }
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

export class ResearchWorker {
  readonly owner = `research-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly store: PageStore,
    private readonly config: ResearchConfig,
    private readonly answerConfig: RagAnswerConfig,
    private readonly embedder: OllamaEmbedder | null,
  ) {}

  async runOne(signal?: AbortSignal): Promise<boolean> {
    const task = this.store.claimResearchTask(this.owner);
    if (!task) return false;
    const heartbeat = setInterval(() => this.store.renewResearchLease(task), 30_000);
    try {
      let sources = this.store.researchSources(task.researchId);
      if (!sources.length) {
        const discovered = task.job.requestedUrls.length ? task.job.requestedUrls : await discoverResearchUrls(task.job.query, this.config, signal);
        const urls = [...new Set(discovered.map(normalizeWebUrl))].slice(0, task.job.maxSources);
        if (!urls.length) throw new AppError("research_sources_empty", "research did not produce any safe public source URLs", 422);
        sources = this.store.addResearchSources(task, urls);
        if (!sources.length) throw new AppError("research_sources_empty", "research could not queue any sources", 422);
        this.store.delayResearchTask(task);
        return true;
      }

      let pending = false;
      const usable = [] as typeof sources;
      for (const source of sources) {
        if (source.status === "queued" || source.status === "fetching" || source.status === "transcribing") { pending = true; continue; }
        if (source.status !== "ready" || source.documentId === null) continue;
        try {
          const document = this.store.getDocument(source.documentId);
          if (document.status === "queued" || document.status === "extracting") pending = true;
          else if (document.status === "ready") usable.push(source);
        } catch { /* Deleted or unavailable sources are excluded. */ }
      }
      if (pending) { this.store.delayResearchTask(task); return true; }
      if (!usable.length) throw new AppError("research_sources_failed", "no captured source completed document extraction", 422);
      if (!this.answerConfig.enabled) throw new AppError("rag_answer_disabled", "citation-grounded answers are disabled", 503);
      const answer: AnswerResult = await answerQuestion(this.store, this.embedder, this.answerConfig, {
        question: task.job.query,
        includeGeneralKnowledge: false,
        tags: [],
        status: "all",
        filters: { source: "documents", documentIds: usable.map((source) => source.documentId!) },
      }, signal);
      this.store.completeResearchTask(task, { answer, sources: usable });
    } catch (error) {
      this.store.failResearchTask(task, error instanceof Error ? error.message : String(error), !(error instanceof AppError && error.status < 500));
    } finally { clearInterval(heartbeat); }
    return true;
  }

  async runUntilIdle(signal?: AbortSignal): Promise<number> {
    let processed = 0;
    while (await this.runOne(signal)) processed += 1;
    return processed;
  }

  async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) if (!await this.runOne(signal)) await Bun.sleep(1000);
  }
}
