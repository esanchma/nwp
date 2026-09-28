import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SemanticSearchConfig {
  enabled: boolean;
  ollamaUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  queryPrefix: string;
  chunkCharacters: number;
  chunkOverlap: number;
}

export interface RagAnswerConfig {
  enabled: boolean;
  ollamaUrl: string;
  generationModel: string;
  timeoutSeconds: number;
  maxEvidenceItems: number;
  maxEvidenceCharacters: number;
  maxPromptCharacters: number;
  maxAnswerCharacters: number;
  includeGeneralKnowledge: boolean;
}

export interface DocumentRagConfig {
  enabled: boolean;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxArchiveEntries: number;
  maxCompressionRatio: number;
  maxPdfPages: number;
  maxSpreadsheetCells: number;
  ocrEnabled: boolean;
  tesseractCommand: string;
  pdfRendererCommand: string;
  ocrLanguages: string[];
  ocrTimeoutSeconds: number;
  maxOcrItems: number;
  maxOcrOutputCharacters: number;
}

export type WebResearchMode = "trafilatura" | "readable" | "defuddle" | "raw";

export interface WebCaptureConfig {
  enabled: boolean;
  timeoutSeconds: number;
  maxRedirects: number;
  maxResponseBytes: number;
  maxExtractedCharacters: number;
  maxAssetCount: number;
  maxAssetBytes: number;
  maxTotalAssetBytes: number;
  fetchCommand: string;
  fetchMode: WebResearchMode;
  fetchTimeoutSeconds: number;
  maxFetchOutputBytes: number;
  userAgent: string;
}

export interface ResearchConfig {
  enabled: boolean;
  searchCommand: string;
  searchTimeoutSeconds: number;
  maxSearchOutputBytes: number;
  defaultMaxSources: number;
  maximumSources: number;
}

export interface ContentTaggingConfig {
  enabled: boolean;
  ollamaUrl: string;
  model: string;
  timeoutSeconds: number;
  maxInputCharacters: number;
  maxTopics: number;
  minimumConfidence: number;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  configPath: string;
  attachmentMaxBytes: number | null;
  semanticSearch: SemanticSearchConfig;
  documentRag: DocumentRagConfig;
  ragAnswer: RagAnswerConfig;
  webCapture: WebCaptureConfig;
  research: ResearchConfig;
  contentTagging: ContentTaggingConfig;
}

export interface ConfigOverrides {
  host?: string;
  port?: number;
  dataDir?: string;
  configPath?: string;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function defaultConfigPath(): string {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "nwp", "config.toml");
}

function defaultDataDir(): string {
  const root = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(root, "nwp");
}

export async function loadConfig(overrides: ConfigOverrides = {}): Promise<Config> {
  const configPath = expandHome(overrides.configPath || defaultConfigPath());
  let file: Record<string, unknown> = {};

  try {
    file = Bun.TOML.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const host = overrides.host ?? stringValue(file.host, "host", "127.0.0.1");
  const port = overrides.port ?? numberValue(file.port, "port", 3000);
  const dataDir = expandHome(overrides.dataDir ?? stringValue(file.data_dir, "data_dir", defaultDataDir()));
  const configuredMax = numberValue(file.max_attachment_bytes, "max_attachment_bytes", 0);
  const attachmentMaxBytes = configuredMax === 0 ? null : configuredMax;
  const semantic = objectValue(file.semantic_search, "semantic_search");
  const semanticSearch: SemanticSearchConfig = {
    enabled: booleanValue(semantic.enabled, "semantic_search.enabled", true),
    ollamaUrl: stringValue(semantic.ollama_url, "semantic_search.ollama_url", "http://127.0.0.1:11434"),
    embeddingModel: stringValue(semantic.embedding_model, "semantic_search.embedding_model", "bge-m3"),
    embeddingDimensions: numberValue(semantic.embedding_dimensions, "semantic_search.embedding_dimensions", 1024),
    queryPrefix: stringValue(semantic.query_prefix, "semantic_search.query_prefix", "", true),
    chunkCharacters: numberValue(semantic.chunk_characters, "semantic_search.chunk_characters", 1600),
    chunkOverlap: numberValue(semantic.chunk_overlap, "semantic_search.chunk_overlap", 200),
  };
  const answer = objectValue(file.rag_answer, "rag_answer");
  const ragAnswer: RagAnswerConfig = {
    enabled: booleanValue(answer.enabled, "rag_answer.enabled", true),
    ollamaUrl: stringValue(answer.ollama_url, "rag_answer.ollama_url", semanticSearch.ollamaUrl),
    generationModel: stringValue(answer.generation_model, "rag_answer.generation_model", "qwen3:8b"),
    timeoutSeconds: numberValue(answer.timeout_seconds, "rag_answer.timeout_seconds", 120),
    maxEvidenceItems: numberValue(answer.max_evidence_items, "rag_answer.max_evidence_items", 8),
    maxEvidenceCharacters: numberValue(answer.max_evidence_characters, "rag_answer.max_evidence_characters", 6000),
    maxPromptCharacters: numberValue(answer.max_prompt_characters, "rag_answer.max_prompt_characters", 50_000),
    maxAnswerCharacters: numberValue(answer.max_answer_characters, "rag_answer.max_answer_characters", 12_000),
    includeGeneralKnowledge: booleanValue(answer.include_general_knowledge, "rag_answer.include_general_knowledge", true),
  };
  const web = objectValue(file.web_capture, "web_capture");
  const installedWebResearch = join(homedir(), ".pi", "agent", "skills", "web-research", "web-research");
  const defaultFetchCommand = await Bun.file(installedWebResearch).exists() ? installedWebResearch : "web-research";
  const webCapture: WebCaptureConfig = {
    enabled: booleanValue(web.enabled, "web_capture.enabled", true),
    timeoutSeconds: numberValue(web.timeout_seconds, "web_capture.timeout_seconds", 30),
    maxRedirects: numberValue(web.max_redirects, "web_capture.max_redirects", 5),
    maxResponseBytes: numberValue(web.max_response_bytes, "web_capture.max_response_bytes", 20 * 1024 * 1024),
    maxExtractedCharacters: numberValue(web.max_extracted_characters, "web_capture.max_extracted_characters", 2_000_000),
    maxAssetCount: numberValue(web.max_asset_count, "web_capture.max_asset_count", 50),
    maxAssetBytes: numberValue(web.max_asset_bytes, "web_capture.max_asset_bytes", 10 * 1024 * 1024),
    maxTotalAssetBytes: numberValue(web.max_total_asset_bytes, "web_capture.max_total_asset_bytes", 50 * 1024 * 1024),
    fetchCommand: stringValue(web.fetch_command, "web_capture.fetch_command", defaultFetchCommand, true),
    fetchMode: webResearchMode(web.fetch_mode),
    fetchTimeoutSeconds: numberValue(web.fetch_timeout_seconds, "web_capture.fetch_timeout_seconds", 180),
    maxFetchOutputBytes: numberValue(web.max_fetch_output_bytes, "web_capture.max_fetch_output_bytes", 20 * 1024 * 1024),
    userAgent: stringValue(web.user_agent, "web_capture.user_agent", "nwp/0.20 (+local knowledge capture)"),
  };
  const researchInput = objectValue(file.research, "research");
  const research: ResearchConfig = {
    enabled: booleanValue(researchInput.enabled, "research.enabled", true),
    searchCommand: stringValue(researchInput.search_command, "research.search_command", webCapture.fetchCommand, true),
    searchTimeoutSeconds: numberValue(researchInput.search_timeout_seconds, "research.search_timeout_seconds", 60),
    maxSearchOutputBytes: numberValue(researchInput.max_search_output_bytes, "research.max_search_output_bytes", 2 * 1024 * 1024),
    defaultMaxSources: numberValue(researchInput.default_max_sources, "research.default_max_sources", 5),
    maximumSources: numberValue(researchInput.maximum_sources, "research.maximum_sources", 20),
  };
  const taggingInput = objectValue(file.content_tagging, "content_tagging");
  const contentTagging: ContentTaggingConfig = {
    enabled: booleanValue(taggingInput.enabled, "content_tagging.enabled", true),
    ollamaUrl: stringValue(taggingInput.ollama_url, "content_tagging.ollama_url", ragAnswer.ollamaUrl),
    model: stringValue(taggingInput.model, "content_tagging.model", ragAnswer.generationModel),
    timeoutSeconds: numberValue(taggingInput.timeout_seconds, "content_tagging.timeout_seconds", 120),
    maxInputCharacters: numberValue(taggingInput.max_input_characters, "content_tagging.max_input_characters", 16_000),
    maxTopics: numberValue(taggingInput.max_topics, "content_tagging.max_topics", 3),
    minimumConfidence: numberValue(taggingInput.minimum_confidence, "content_tagging.minimum_confidence", 0.65),
  };
  const documents = objectValue(file.document_rag, "document_rag");
  const documentRag: DocumentRagConfig = {
    enabled: booleanValue(documents.enabled, "document_rag.enabled", true),
    maxFileBytes: numberValue(documents.max_file_bytes, "document_rag.max_file_bytes", 512 * 1024 * 1024),
    maxExpandedBytes: numberValue(documents.max_expanded_bytes, "document_rag.max_expanded_bytes", 2 * 1024 * 1024 * 1024),
    maxArchiveEntries: numberValue(documents.max_archive_entries, "document_rag.max_archive_entries", 100_000),
    maxCompressionRatio: numberValue(documents.max_compression_ratio, "document_rag.max_compression_ratio", 1000),
    maxPdfPages: numberValue(documents.max_pdf_pages, "document_rag.max_pdf_pages", 10_000),
    maxSpreadsheetCells: numberValue(documents.max_spreadsheet_cells, "document_rag.max_spreadsheet_cells", 5_000_000),
    ocrEnabled: booleanValue(documents.ocr_enabled, "document_rag.ocr_enabled", true),
    tesseractCommand: stringValue(documents.tesseract_command, "document_rag.tesseract_command", "tesseract"),
    pdfRendererCommand: stringValue(documents.pdf_renderer_command, "document_rag.pdf_renderer_command", "pdftoppm"),
    ocrLanguages: stringArrayValue(documents.ocr_languages, "document_rag.ocr_languages", ["spa", "eng"]),
    ocrTimeoutSeconds: numberValue(documents.ocr_timeout_seconds, "document_rag.ocr_timeout_seconds", 120),
    maxOcrItems: numberValue(documents.max_ocr_items, "document_rag.max_ocr_items", 10_000),
    maxOcrOutputCharacters: numberValue(documents.max_ocr_output_characters, "document_rag.max_ocr_output_characters", 1_000_000),
  };

  if (!Number.isInteger(semanticSearch.embeddingDimensions) || semanticSearch.embeddingDimensions < 1) throw new Error("semantic_search.embedding_dimensions must be a positive integer");
  if (!Number.isInteger(semanticSearch.chunkCharacters) || semanticSearch.chunkCharacters < 200) throw new Error("semantic_search.chunk_characters must be an integer of at least 200");
  if (!Number.isInteger(semanticSearch.chunkOverlap) || semanticSearch.chunkOverlap < 0 || semanticSearch.chunkOverlap >= semanticSearch.chunkCharacters) throw new Error("semantic_search.chunk_overlap must be smaller than chunk_characters");
  for (const [name, value] of Object.entries({ timeout_seconds: ragAnswer.timeoutSeconds, max_evidence_items: ragAnswer.maxEvidenceItems, max_evidence_characters: ragAnswer.maxEvidenceCharacters, max_prompt_characters: ragAnswer.maxPromptCharacters, max_answer_characters: ragAnswer.maxAnswerCharacters })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`rag_answer.${name} must be a positive integer`);
  }
  if (ragAnswer.maxPromptCharacters < ragAnswer.maxEvidenceCharacters) throw new Error("rag_answer.max_prompt_characters must not be smaller than max_evidence_characters");

  for (const [name, value] of Object.entries({ timeout_seconds: webCapture.timeoutSeconds, max_redirects: webCapture.maxRedirects, max_response_bytes: webCapture.maxResponseBytes, max_extracted_characters: webCapture.maxExtractedCharacters, max_asset_count: webCapture.maxAssetCount, max_asset_bytes: webCapture.maxAssetBytes, max_total_asset_bytes: webCapture.maxTotalAssetBytes, fetch_timeout_seconds: webCapture.fetchTimeoutSeconds, max_fetch_output_bytes: webCapture.maxFetchOutputBytes })) {
    if (!Number.isSafeInteger(value) || value < (name === "max_redirects" || name === "max_asset_count" ? 0 : 1)) throw new Error(`web_capture.${name} must be ${name === "max_redirects" || name === "max_asset_count" ? "a non-negative" : "a positive"} integer`);
  }
  if (webCapture.maxRedirects > 20) throw new Error("web_capture.max_redirects must not exceed 20");
  if (webCapture.maxAssetCount > 500) throw new Error("web_capture.max_asset_count must not exceed 500");
  if (webCapture.maxTotalAssetBytes < webCapture.maxAssetBytes) throw new Error("web_capture.max_total_asset_bytes must not be smaller than max_asset_bytes");
  if (webCapture.userAgent.length > 256 || /[\r\n]/.test(webCapture.userAgent)) throw new Error("web_capture.user_agent must be a single line of at most 256 characters");
  if (webCapture.fetchCommand && (webCapture.fetchCommand.length > 4096 || /[\r\n]/.test(webCapture.fetchCommand))) throw new Error("web_capture.fetch_command must be a single executable path");

  for (const [name, value] of Object.entries({ search_timeout_seconds: research.searchTimeoutSeconds, max_search_output_bytes: research.maxSearchOutputBytes, default_max_sources: research.defaultMaxSources, maximum_sources: research.maximumSources })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`research.${name} must be a positive integer`);
  }
  if (research.defaultMaxSources > research.maximumSources || research.maximumSources > 100) throw new Error("research source limits are inconsistent or exceed 100");
  if (research.searchCommand && (research.searchCommand.length > 4096 || /[\r\n]/.test(research.searchCommand))) throw new Error("research.search_command must be a single executable path");

  for (const [name, value] of Object.entries({ timeout_seconds: contentTagging.timeoutSeconds, max_input_characters: contentTagging.maxInputCharacters, max_topics: contentTagging.maxTopics })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`content_tagging.${name} must be a positive integer`);
  }
  if (contentTagging.maxTopics > 5) throw new Error("content_tagging.max_topics must not exceed 5");
  if (!Number.isFinite(contentTagging.minimumConfidence) || contentTagging.minimumConfidence < 0 || contentTagging.minimumConfidence > 1) throw new Error("content_tagging.minimum_confidence must be between 0 and 1");

  for (const [name, value] of Object.entries({ max_file_bytes: documentRag.maxFileBytes, max_expanded_bytes: documentRag.maxExpandedBytes, max_archive_entries: documentRag.maxArchiveEntries, max_compression_ratio: documentRag.maxCompressionRatio, max_pdf_pages: documentRag.maxPdfPages, max_spreadsheet_cells: documentRag.maxSpreadsheetCells, ocr_timeout_seconds: documentRag.ocrTimeoutSeconds, max_ocr_items: documentRag.maxOcrItems, max_ocr_output_characters: documentRag.maxOcrOutputCharacters })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`document_rag.${name} must be a positive integer`);
  }
  if (documentRag.maxExpandedBytes < documentRag.maxFileBytes) throw new Error("document_rag.max_expanded_bytes must not be smaller than max_file_bytes");
  if (!documentRag.ocrLanguages.length || documentRag.ocrLanguages.some((language) => !/^[a-zA-Z0-9_]{2,32}$/.test(language))) throw new Error("document_rag.ocr_languages must contain language identifiers");

  if (attachmentMaxBytes !== null && (!Number.isSafeInteger(attachmentMaxBytes) || attachmentMaxBytes < 1)) {
    throw new Error("max_attachment_bytes must be zero (unlimited) or a positive integer");
  }
  if (port < 1 || port > 65535 || !Number.isInteger(port)) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  return {
    host,
    port,
    dataDir,
    dbPath: join(dataDir, "nwp.db"),
    tokenPath: join(dataDir, "api-token"),
    configPath,
    attachmentMaxBytes,
    semanticSearch,
    documentRag,
    ragAnswer,
    webCapture,
    research,
    contentTagging,
  };
}

function webResearchMode(value: unknown): WebResearchMode {
  if (value === undefined) return "trafilatura";
  if (value === "trafilatura" || value === "readable" || value === "defuddle" || value === "raw") return value;
  throw new Error("web_capture.fetch_mode must be trafilatura, readable, defuddle, or raw");
}

function stringValue(value: unknown, name: string, fallback: string, allowEmpty = false): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  return value;
}

function booleanValue(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a TOML table`);
  return value as Record<string, unknown>;
}

function stringArrayValue(value: unknown, name: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))];
}

function numberValue(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new Error(`${name} must be a number`);
  return value;
}

export async function ensureRuntimeFiles(config: Config): Promise<string> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(config.configPath), { recursive: true, mode: 0o700 });

  try {
    const token = (await readFile(config.tokenPath, "utf8")).trim();
    if (token.length < 32) throw new Error(`API token in ${config.tokenPath} is invalid`);
    await chmod(config.tokenPath, 0o600);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await writeFile(config.tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  await chmod(config.tokenPath, 0o600);
  return token;
}

export async function readApiToken(config: Config): Promise<string> {
  const token = (await readFile(config.tokenPath, "utf8")).trim();
  if (!token) throw new Error(`No API token found at ${config.tokenPath}. Start nwp serve first.`);
  return token;
}
