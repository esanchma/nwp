import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentRagConfig, RagAnswerConfig, ResearchConfig } from "../src/config.ts";
import { PageStore } from "../src/database.ts";
import { DocumentWorker } from "../src/documents.ts";
import { discoverResearchUrls, ResearchWorker } from "../src/research.ts";

let dir: string;
let store: PageStore;
let ollama: ReturnType<typeof Bun.serve> | null = null;
const documentConfig: DocumentRagConfig = { enabled: true, maxFileBytes: 10_000_000, maxExpandedBytes: 50_000_000, maxArchiveEntries: 10_000, maxCompressionRatio: 1000, maxPdfPages: 10_000, maxSpreadsheetCells: 5_000_000, ocrEnabled: false, tesseractCommand: "tesseract", pdfRendererCommand: "pdftoppm", ocrLanguages: ["spa", "eng"], ocrTimeoutSeconds: 120, maxOcrItems: 10_000, maxOcrOutputCharacters: 1_000_000 };
const researchConfig: ResearchConfig = { enabled: true, searchCommand: "", searchTimeoutSeconds: 10, maxSearchOutputBytes: 100_000, defaultMaxSources: 3, maximumSources: 10 };

beforeEach(async () => {
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  dir = await mkdtemp(join(process.cwd(), ".tmp", "research-test-"));
  store = new PageStore(join(dir, "nwp.db"));
});

afterEach(async () => {
  ollama?.stop(true);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function answerConfig(url: string): RagAnswerConfig {
  return { enabled: true, ollamaUrl: url, generationModel: "test", timeoutSeconds: 10, maxEvidenceItems: 8, maxEvidenceCharacters: 6000, maxPromptCharacters: 50_000, maxAnswerCharacters: 12_000, includeGeneralKnowledge: false };
}

describe("durable research", () => {
  test("discovers only syntactically safe public URLs from an external search adapter", async () => {
    const command = join(dir, "search-adapter");
    await writeFile(command, "#!/bin/sh\nprintf '%s\\n' 'TITLE: Good' 'URL: https://example.com/a' '' 'TITLE: Redirect' 'URL:   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=x' '' 'TITLE: Private' 'URL: http://127.0.0.1/secret'\n");
    await chmod(command, 0o700);
    expect(await discoverResearchUrls("topic", { ...researchConfig, searchCommand: command })).toEqual(["https://example.com/a", "https://example.org/b"]);
  });

  test("captures multiple explicit sources and produces a persisted cited synthesis", async () => {
    ollama = Bun.serve({ port: 0, fetch: () => Response.json({ message: { role: "assistant", content: JSON.stringify({ answer: "The policy grants sixteen weeks [E1].", generalKnowledge: null, abstained: false }) } }) });
    const job = store.createResearch("How many weeks does the policy grant?", ["https://example.com/one", "https://example.org/two"], 2);
    const worker = new ResearchWorker(store, researchConfig, answerConfig(ollama.url.toString()), null);
    expect(await worker.runOne()).toBe(true);
    expect(store.researchSources(job.id)).toHaveLength(2);

    for (let index = 0; index < 2; index += 1) {
      const task = store.claimWebCaptureTask(`capture-${index}`)!;
      const text = index === 0 ? "The policy grants sixteen weeks of paid leave." : "Requests require manager approval.";
      store.completeWebCaptureTask(task, { kind: "content", requestedUrl: task.url, finalUrl: task.url, status: 200, contentType: "text/plain", bytes: new TextEncoder().encode(text), title: `Source ${index + 1}`, markdown: `# Source ${index + 1}\n\n${text}`, assets: [], etag: null, lastModified: null }, documentConfig.maxFileBytes);
    }
    expect(await new DocumentWorker(store, documentConfig).runUntilIdle()).toBe(2);
    store.db.run("UPDATE research_queue SET available_at = ? WHERE research_id = ?", [new Date(0).toISOString(), job.id]);
    expect(await worker.runOne()).toBe(true);
    const completed = store.getResearch(job.id);
    expect(completed.status).toBe("ready");
    expect(completed.result).toMatchObject({ answer: { abstained: false, answer: expect.stringContaining("[E1]"), citations: [expect.objectContaining({ id: "E1", source: "document" })] } });
  });

  test("supports cancellation and retry", () => {
    const job = store.createResearch("A question", ["https://example.com"], 1);
    expect(store.cancelResearch(job.id).status).toBe("cancelled");
    expect(store.retryResearch(job.id).status).toBe("queued");
  });
});
