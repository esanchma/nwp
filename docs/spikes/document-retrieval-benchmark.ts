import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DocumentRagConfig, SemanticSearchConfig } from "../../src/config.ts";
import { PageStore } from "../../src/database.ts";
import { DocumentWorker } from "../../src/documents.ts";
import { hybridSearch, loadEmbeddedSqliteVec, OllamaEmbedder, SemanticIndexer } from "../../src/semantic.ts";

const root = join(process.cwd(), ".tmp", "document-retrieval-benchmark");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const documentConfig: DocumentRagConfig = {
  enabled: true,
  maxFileBytes: 10_000_000,
  maxExpandedBytes: 50_000_000,
  maxArchiveEntries: 10_000,
  maxCompressionRatio: 1000,
  maxPdfPages: 10_000,
  maxSpreadsheetCells: 5_000_000,
  ocrEnabled: false,
  tesseractCommand: "tesseract",
  pdfRendererCommand: "pdftoppm",
  ocrLanguages: ["spa", "eng"],
  ocrTimeoutSeconds: 120,
  maxOcrItems: 10_000,
  maxOcrOutputCharacters: 1_000_000,
};
const semanticConfig: SemanticSearchConfig = {
  enabled: true,
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "bge-m3",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1024),
  queryPrefix: "",
  chunkCharacters: 1600,
  chunkOverlap: 200,
};

const corpus = [
  ["parental-leave.txt", "Employees receive sixteen weeks of paid parental leave after birth or adoption."],
  ["expenses.txt", "Expense reports require itemized receipts and must be submitted within thirty calendar days."],
  ["backups.txt", "Production database backups run every night at 02:00 UTC and are retained for ninety days."],
  ["security.txt", "Security incidents must be reported to the response team within one hour of discovery."],
  ["travel.txt", "International business travel requires director approval before booking flights or hotels."],
  ["remote-work.txt", "Remote work location changes require manager approval and a payroll compliance review."],
  ["procurement.txt", "Purchases above ten thousand euros require three vendor quotations and finance approval."],
  ["retention.txt", "Customer contracts are retained for seven years after the agreement terminates."],
] as const;
const queries = [
  ["¿Cuánto permiso pagado hay por nacimiento?", "parental-leave.txt"],
  ["deadline for submitting a restaurant receipt", "expenses.txt"],
  ["when is the production data copy made", "backups.txt"],
  ["plazo para avisar de un incidente de seguridad", "security.txt"],
  ["who must authorize an overseas trip", "travel.txt"],
  ["moving while working from home", "remote-work.txt"],
  ["rules for a large purchase", "procurement.txt"],
  ["how long should an expired customer agreement be kept", "retention.txt"],
] as const;

const store = new PageStore(join(root, "nwp.db"));
try {
  const vector = loadEmbeddedSqliteVec(store, root);
  if (!vector.available) throw new Error(vector.error ?? "sqlite-vec unavailable");
  for (const [filename, text] of corpus) store.createDocument(filename, "text/plain", "text", new TextEncoder().encode(text), "cli", documentConfig.maxFileBytes);
  await new DocumentWorker(store, documentConfig).runUntilIdle();
  const indexer = new SemanticIndexer(store, semanticConfig);
  await indexer.runUntilIdle();
  const embedder = new OllamaEmbedder(semanticConfig);
  let reciprocalRanks = 0;
  let recallAtOne = 0;
  for (const [query, expected] of queries) {
    const result = await hybridSearch(store, embedder, query, [], null, 5, "published", {}, undefined, { source: "documents" });
    const filenames = (result.hits ?? []).flatMap((hit) => hit.source === "document" ? [hit.document.filename] : []);
    const rank = filenames.indexOf(expected) + 1;
    if (rank === 1) recallAtOne += 1;
    if (rank > 0) reciprocalRanks += 1 / rank;
    console.log(JSON.stringify({ query, expected, rank: rank || null, results: filenames }));
  }
  console.log(JSON.stringify({ documents: corpus.length, queries: queries.length, model: semanticConfig.embeddingModel, mrr: reciprocalRanks / queries.length, recallAt1: recallAtOne / queries.length }, null, 2));
} finally {
  store.close();
}
