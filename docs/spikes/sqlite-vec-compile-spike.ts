import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vecEmbeddedPath from "sqlite-vec-linux-x64/vec0.so" with { type: "file" };

const outputDir = process.argv[2] ?? join(process.cwd(), ".tmp", "sqlite-vec-spike");
mkdirSync(outputDir, { recursive: true });

const extensionBytes = readFileSync(vecEmbeddedPath);
const sha256 = createHash("sha256").update(extensionBytes).digest("hex");
const extractedPath = join(outputDir, `vec0-${sha256.slice(0, 16)}.so`);
writeFileSync(extractedPath, extensionBytes, { mode: 0o700 });
chmodSync(extractedPath, 0o700);

const databasePath = join(outputDir, "vectors.db");
const db = new Database(databasePath, { create: true });
db.loadExtension(extractedPath, "sqlite3_vec_init");
const version = db.query<{ version: string }, []>("SELECT vec_version() AS version").get()!.version;

db.exec("DROP TABLE IF EXISTS vec_items");
db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3])");
const insert = db.query("INSERT INTO vec_items(rowid, embedding) VALUES (?, vec_f32(?))");
insert.run(1, JSON.stringify([1, 0, 0]));
insert.run(2, JSON.stringify([0, 1, 0]));
insert.run(3, JSON.stringify([0.8, 0.2, 0]));

const nearest = db.query<{ rowid: number; distance: number }, [string, number]>(
  "SELECT rowid, distance FROM vec_items WHERE embedding MATCH vec_f32(?) AND k = ? ORDER BY distance",
).all(JSON.stringify([1, 0, 0]), 3);
db.close();

console.log(JSON.stringify({
  runtime: { bun: Bun.version, compiled: Bun.main.startsWith("/$bunfs/") || !import.meta.dir.includes("docs/spikes") },
  embeddedPath: vecEmbeddedPath,
  embeddedBytes: extensionBytes.byteLength,
  sha256,
  extractedPath,
  sqliteVecVersion: version,
  nearest,
}, null, 2));
