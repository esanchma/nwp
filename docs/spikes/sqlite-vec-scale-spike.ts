import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vecEmbeddedPath from "sqlite-vec-linux-x64/vec0.so" with { type: "file" };

const count = Number(process.env.VECTOR_COUNT ?? 100_000);
const dimensions = Number(process.env.VECTOR_DIMENSIONS ?? 1024);
const queryCount = Number(process.env.VECTOR_QUERIES ?? 25);
const outputDir = process.argv[2] ?? join(process.cwd(), ".tmp", "sqlite-vec-scale");
mkdirSync(outputDir, { recursive: true });
const extensionPath = join(outputDir, "vec0.so");
writeFileSync(extensionPath, readFileSync(vecEmbeddedPath), { mode: 0o700 });
const databasePath = join(outputDir, "scale.db");
rmSync(databasePath, { force: true });

const db = new Database(databasePath, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
db.loadExtension(extensionPath, "sqlite3_vec_init");
db.exec(`CREATE VIRTUAL TABLE vectors USING vec0(embedding float[${dimensions}] distance_metric=cosine)`);
const insert = db.query("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)");
const vector = new Float32Array(dimensions);
let randomState = 0x12345678;
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x1_0000_0000;
};
const fill = () => {
  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = random() - 0.5;
    vector[index] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < dimensions; index += 1) vector[index] = vector[index]! * scale;
};

const insertStarted = performance.now();
const insertAll = db.transaction(() => {
  for (let rowid = 1; rowid <= count; rowid += 1) {
    fill();
    insert.run(rowid, vector);
  }
});
insertAll();
const insertMs = performance.now() - insertStarted;

const search = db.query<{ rowid: number; distance: number }, [Float32Array, number]>(
  "SELECT rowid, distance FROM vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance",
);
const latencies: number[] = [];
let firstResult: { rowid: number; distance: number } | undefined;
for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
  fill();
  const started = performance.now();
  const rows = search.all(vector, 10);
  latencies.push(performance.now() - started);
  firstResult ??= rows[0];
}
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

console.log(JSON.stringify({
  sqliteVecVersion: "v0.1.9",
  count,
  dimensions,
  databaseBytes: statSync(databasePath).size,
  insertion: { totalMs: round(insertMs), vectorsPerSecond: round(count / (insertMs / 1000)) },
  query: { samples: queryCount, k: 10, p50Ms: round(percentile(latencies, 0.5)), p95Ms: round(percentile(latencies, 0.95)), meanMs: round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length), firstResult },
}, null, 2));

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
