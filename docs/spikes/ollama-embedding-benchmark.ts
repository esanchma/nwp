interface Document { id: string; language: "es" | "en"; text: string }
interface Query { id: string; language: "es" | "en"; text: string; relevant: string[]; crossLanguage: boolean }
interface EmbedResponse { model: string; embeddings: number[][]; total_duration?: number; load_duration?: number; prompt_eval_count?: number }

const endpoint = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const modelNames = (process.env.EMBED_MODELS ?? "qwen3-embedding:0.6b,bge-m3").split(",").filter(Boolean);

const documents: Document[] = [
  { id: "local-models-es", language: "es", text: "Ollama permite ejecutar modelos de lenguaje localmente en CPU o GPU. Una aplicación puede llamar a su API nativa para generar JSON estructurado, embeddings y respuestas sin enviar datos a la nube." },
  { id: "local-models-en", language: "en", text: "Local language models can run through Ollama without a cloud provider. Its native HTTP API supports model loading, keep-alive settings, embeddings, and structured generation." },
  { id: "cloud-models-en", language: "en", text: "Managed cloud language model APIs provide elastic capacity and avoid local hardware management, but prompts leave the machine and usage is billed per token." },
  { id: "fts-es", language: "es", text: "SQLite FTS5 crea índices invertidos para búsqueda léxica. BM25 ordena coincidencias de palabras, mientras los filtros SQL restringen estado, etiquetas y propiedades." },
  { id: "vector-en", language: "en", text: "sqlite-vec adds vector columns and nearest-neighbor queries to SQLite. Embeddings enable semantic retrieval when a query and a passage use different words." },
  { id: "hybrid-es", language: "es", text: "La búsqueda híbrida combina resultados de FTS y similitud vectorial. Reciprocal Rank Fusion une ambos rankings sin comparar directamente sus puntuaciones." },
  { id: "postgres-en", language: "en", text: "PostgreSQL with pgvector stores embeddings in a server database and supports approximate nearest-neighbor indexes for large multi-user systems." },
  { id: "jobs-es", language: "es", text: "Una cola durable guarda trabajos asíncronos en SQLite. Los workers reclaman tareas con leases, renuevan un heartbeat y recuperan trabajos abandonados después de un reinicio." },
  { id: "jobs-en", language: "en", text: "Background workers process queued jobs outside the HTTP server. Retry state, cancellation flags, leases, and progress counters make long-running batches observable and recoverable." },
  { id: "threads-en", language: "en", text: "An in-process thread pool runs CPU tasks concurrently but does not provide durable recovery when the application process crashes." },
  { id: "prompt-injection-es", language: "es", text: "El contenido web es no confiable. Una página puede incluir prompt injection para ordenar al agente que revele secretos o ejecute herramientas, por lo que datos e instrucciones deben permanecer separados." },
  { id: "prompt-injection-en", language: "en", text: "Web pages may contain malicious instructions aimed at an AI agent. Tool calls must be validated and scraped text must be treated only as untrusted evidence." },
  { id: "xss-en", language: "en", text: "Cross-site scripting injects JavaScript into a browser page. Output encoding and a restrictive content security policy reduce the impact of untrusted HTML." },
  { id: "solar-es", language: "es", text: "Los paneles solares fotovoltaicos convierten la luz en electricidad. El inversor transforma corriente continua en alterna y las baterías almacenan excedentes para la noche." },
  { id: "solar-en", language: "en", text: "Rooftop photovoltaic systems generate electricity from sunlight. Home batteries can store excess daytime energy and supply the house after sunset." },
  { id: "wind-en", language: "en", text: "Wind turbines convert moving air into electrical power. Offshore wind farms benefit from strong consistent winds but require expensive marine infrastructure." },
  { id: "cooking-es", language: "es", text: "Para preparar una tortilla de patatas se fríen lentamente patatas y cebolla, se mezclan con huevo batido y se cuajan por ambos lados en una sartén." },
  { id: "cooking-en", language: "en", text: "Sourdough bread uses a fermented starter instead of commercial yeast. Long fermentation develops flavor before the loaf is baked in a hot oven." },
  { id: "travel-es", language: "es", text: "El Camino de Santiago reúne rutas de peregrinación que terminan en Galicia. Conviene planificar etapas, alojamiento, calzado y transporte del equipaje." },
  { id: "gardening-en", language: "en", text: "Tomato plants need sunlight, well-drained soil, regular watering, and support as they grow. Mulch helps retain moisture around the roots." },
  { id: "labor-es", language: "es", text: "Un contrato de trabajo regula jornada, salario, vacaciones y periodo de prueba. La normativa laboral establece derechos mínimos y procedimientos de despido." },
  { id: "finance-en", language: "en", text: "Index funds track a market benchmark with low fees. Diversification reduces exposure to the failure of a single company but does not eliminate market risk." },
  { id: "medical-es", language: "es", text: "La hipertensión arterial suele diagnosticarse mediante varias mediciones. El tratamiento puede incluir ejercicio, dieta, control médico y medicación prescrita." },
  { id: "metadata-en", language: "en", text: "Document metadata records source URL, author, publication date, language, content type, and extraction model. Facets let users narrow search results by these fields." },
];

const queries: Query[] = [
  { id: "q-local-es", language: "es", text: "ejecutar inteligencia artificial sin enviar información a servicios externos", relevant: ["local-models-es", "local-models-en"], crossLanguage: true },
  { id: "q-local-en", language: "en", text: "run an LLM privately on my own computer", relevant: ["local-models-en", "local-models-es"], crossLanguage: true },
  { id: "q-vector-es", language: "es", text: "encontrar textos relacionados aunque no compartan las mismas palabras", relevant: ["vector-en", "hybrid-es"], crossLanguage: true },
  { id: "q-hybrid-en", language: "en", text: "combine keyword ranking with semantic similarity", relevant: ["hybrid-es", "fts-es", "vector-en"], crossLanguage: true },
  { id: "q-jobs-es", language: "es", text: "recuperar tareas largas después de que el servidor se reinicie", relevant: ["jobs-es", "jobs-en"], crossLanguage: true },
  { id: "q-jobs-en", language: "en", text: "durable queue with worker leases and cancellation", relevant: ["jobs-en", "jobs-es"], crossLanguage: true },
  { id: "q-injection-es", language: "es", text: "evitar que una web ordene al agente ejecutar acciones maliciosas", relevant: ["prompt-injection-es", "prompt-injection-en"], crossLanguage: true },
  { id: "q-injection-en", language: "en", text: "treat scraped instructions as untrusted evidence", relevant: ["prompt-injection-en", "prompt-injection-es"], crossLanguage: true },
  { id: "q-solar-es", language: "es", text: "guardar durante el día energía renovable para usarla cuando oscurece", relevant: ["solar-es", "solar-en"], crossLanguage: true },
  { id: "q-cooking-en", language: "en", text: "Spanish omelette with potatoes and eggs", relevant: ["cooking-es"], crossLanguage: true },
  { id: "q-travel-en", language: "en", text: "walking pilgrimage routes ending in Galicia", relevant: ["travel-es"], crossLanguage: true },
  { id: "q-metadata-es", language: "es", text: "filtrar documentos por autor idioma dominio y fecha", relevant: ["metadata-en"], crossLanguage: true },
  { id: "q-finance-es", language: "es", text: "invertir de forma diversificada siguiendo un índice con comisiones bajas", relevant: ["finance-en"], crossLanguage: true },
  { id: "q-health-en", language: "en", text: "repeated blood pressure measurements and lifestyle treatment", relevant: ["medical-es"], crossLanguage: true },
];

const configurations = modelNames.flatMap((model) => model.startsWith("qwen3-embedding") ? [
  { name: `${model}:raw`, model, queryPrefix: "" },
  { name: `${model}:instructed`, model, queryPrefix: "Instruct: Retrieve passages that answer the search query across Spanish and English.\nQuery: " },
] : [{ name: `${model}:raw`, model, queryPrefix: "" }]);

const ollamaVersion = await fetch(`${endpoint}/api/version`).then((response) => response.json());
const results = [];
for (const configuration of configurations) {
  await unload(configuration.model);
  const coldStarted = performance.now();
  const cold = await embed(configuration.model, [documents[0]!.text], "0");
  const coldMs = performance.now() - coldStarted;

  const indexStarted = performance.now();
  const documentResponse = await embed(configuration.model, documents.map(({ text }) => text), "10m");
  const indexMs = performance.now() - indexStarted;
  const dimension = documentResponse.embeddings[0]?.length ?? cold.embeddings[0]?.length ?? 0;

  const queryEmbeddings: number[][] = [];
  const queryLatencies: number[] = [];
  for (const query of queries) {
    const started = performance.now();
    const response = await embed(configuration.model, [`${configuration.queryPrefix}${query.text}`], "10m");
    queryLatencies.push(performance.now() - started);
    queryEmbeddings.push(response.embeddings[0]!);
  }

  const rankings = queries.map((query, index) => ({
    query,
    ranking: documents.map((document, documentIndex) => ({ id: document.id, score: cosine(queryEmbeddings[index]!, documentResponse.embeddings[documentIndex]!) }))
      .sort((left, right) => right.score - left.score),
  }));
  const quality = summarizeQuality(rankings);
  results.push({
    configuration: configuration.name,
    model: configuration.model,
    queryPrefix: configuration.queryPrefix,
    dimension,
    quality,
    latency: {
      coldMs: round(coldMs),
      indexBatchMs: round(indexMs),
      documentsPerSecond: round(documents.length / (indexMs / 1000)),
      warmQueryP50Ms: round(percentile(queryLatencies, 0.5)),
      warmQueryP95Ms: round(percentile(queryLatencies, 0.95)),
      warmQueryMeanMs: round(queryLatencies.reduce((sum, value) => sum + value, 0) / queryLatencies.length),
    },
    rankings: rankings.map(({ query, ranking }) => ({ queryId: query.id, relevant: query.relevant, top5: ranking.slice(0, 5) })),
  });
  await unload(configuration.model);
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(), endpoint, ollamaVersion, corpus: { documents: documents.length, queries: queries.length, allQueriesCrossLanguage: queries.every(({ crossLanguage }) => crossLanguage) }, results,
}, null, 2));

async function embed(model: string, input: string[], keepAlive: string): Promise<EmbedResponse> {
  const response = await fetch(`${endpoint}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, keep_alive: keepAlive, truncate: false }),
  });
  if (!response.ok) throw new Error(`${model}: Ollama returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<EmbedResponse>;
}

async function unload(model: string): Promise<void> {
  await embed(model, ["unload"], "0").catch(() => undefined);
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function summarizeQuality(rankings: Array<{ query: Query; ranking: Array<{ id: string; score: number }> }>) {
  let reciprocalRank = 0;
  let recall1 = 0;
  let recall3 = 0;
  let ndcg5 = 0;
  for (const { query, ranking } of rankings) {
    const firstRelevant = ranking.findIndex(({ id }) => query.relevant.includes(id));
    if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
    if (ranking.slice(0, 1).some(({ id }) => query.relevant.includes(id))) recall1 += 1;
    if (ranking.slice(0, 3).some(({ id }) => query.relevant.includes(id))) recall3 += 1;
    const dcg = ranking.slice(0, 5).reduce((sum, { id }, index) => sum + (query.relevant.includes(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const ideal = Array.from({ length: Math.min(5, query.relevant.length) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
    ndcg5 += dcg / ideal;
  }
  const count = rankings.length;
  return { mrr: round(reciprocalRank / count), recallAt1: round(recall1 / count), recallAt3: round(recall3 / count), ndcgAt5: round(ndcg5 / count) };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
