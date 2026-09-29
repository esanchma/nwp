import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { answerQuestion } from "../../src/answer.ts";
import type { RagAnswerConfig, SemanticSearchConfig } from "../../src/config.ts";
import { PageStore } from "../../src/database.ts";
import { loadEmbeddedSqliteVec, OllamaEmbedder, SemanticIndexer } from "../../src/semantic.ts";

const root = join(process.cwd(), ".tmp", "rag-answer-benchmark");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const semantic: SemanticSearchConfig = { enabled: true, ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", embeddingModel: process.env.EMBEDDING_MODEL ?? "bge-m3", embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1024), queryPrefix: "", chunkCharacters: 1600, chunkOverlap: 200 };
const answer: RagAnswerConfig = { enabled: true, ollamaUrl: semantic.ollamaUrl, generationModel: process.env.GENERATION_MODEL ?? "qwen3:8b", timeoutSeconds: 180, maxEvidenceItems: 5, maxEvidenceCharacters: 6000, maxPromptCharacters: 50_000, maxAnswerCharacters: 4000, maxGenerationTokens: 384, includeGeneralKnowledge: false };
const cases = [
  { title: "Parental leave", body: "Employees receive sixteen weeks of paid parental leave after birth or adoption.", question: "How much paid parental leave is available?", expected: "Parental leave" },
  { title: "Expense reports", body: "Itemized receipts must be submitted within thirty calendar days of the purchase.", question: "When is the deadline for an expense receipt?", expected: "Expense reports" },
  { title: "Backups", body: "Production database backups run nightly at 02:00 UTC and are retained for ninety days.", question: "¿A qué hora se copia la base de datos de producción?", expected: "Backups" },
  { title: "Security incidents", body: "Security incidents must be reported to the response team within one hour of discovery.", question: "How quickly must a security incident be reported?", expected: "Security incidents" },
  { title: "Procurement", body: "Purchases above ten thousand euros require three vendor quotations and finance approval.", question: "What is required for a purchase over ten thousand euros?", expected: "Procurement" },
] as const;

const store = new PageStore(join(root, "nwp.db"));
try {
  const extension = loadEmbeddedSqliteVec(store, root);
  if (!extension.available) throw new Error(extension.error ?? "sqlite-vec unavailable");
  for (const item of cases) store.create({ title: item.title, body: item.body, tags: [] }, "cli");
  await new SemanticIndexer(store, semantic).runUntilIdle();
  const embedder = new OllamaEmbedder(semantic);
  let answered = 0;
  let correctCitation = 0;
  for (const item of cases) {
    const result = await answerQuestion(store, embedder, answer, { question: item.question, includeGeneralKnowledge: false });
    if (!result.abstained) answered += 1;
    if (result.citations[0]?.title === item.expected) correctCitation += 1;
    console.log(JSON.stringify({ question: item.question, expected: item.expected, abstained: result.abstained, answer: result.answer, citations: result.citations.map(({ id, title }) => ({ id, title })) }));
  }
  console.log(JSON.stringify({ cases: cases.length, embeddingModel: semantic.embeddingModel, generationModel: answer.generationModel, answerRate: answered / cases.length, correctCitationAt1: correctCitation / cases.length }, null, 2));
} finally {
  store.close();
}
