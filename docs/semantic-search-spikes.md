# Spikes de búsqueda semántica

**Estado:** decisiones aceptadas para la implementación.

## Objetivo

Validar dos riesgos antes de implementar búsqueda híbrida en nwp:

1. distribuir `sqlite-vec` dentro del ejecutable Linux x86-64 compilado por Bun;
2. elegir un modelo multilingüe de embeddings para Ollama mediante una prueba reproducible.

Las mediciones se realizaron en la misma máquina descrita en [`scrapping_and_agents.md`](scrapping_and_agents.md): Intel Core i5-1345U, inferencia por CPU, 61 GiB de RAM, Bun 1.4.2 y Ollama 0.34.2.

## Resultado ejecutivo

- `sqlite-vec` 0.1.9 puede incluirse en el ejecutable, extraerse de `/$bunfs/` y cargarse con `Database.loadExtension()`.
- El ejecutable de prueba funcionó desde `/tmp` sin `node_modules` ni una copia externa de la extensión.
- La extensión debe cargarse indicando `sqlite3_vec_init`, porque el archivo extraído lleva un hash en el nombre y SQLite no puede inferir el entry point correcto.
- Con 100.000 vectores de 1.024 dimensiones, una consulta exacta top-10 tardó aproximadamente 118 ms de mediana y la base ocupó 414 MB.
- `bge-m3` obtuvo la mejor calidad del benchmark bilingüe: MRR y recall@1 perfectos en esta muestra.
- `qwen3-embedding:0.6b` mejoró de forma clara al añadir una instrucción de recuperación a la consulta.
- Decisión: `bge-m3` será el modelo predeterminado y `qwen3-embedding:0.6b` la alternativa ligera.

Los resultados son de una ejecución controlada sobre un corpus sintético pequeño. Sirven para elegir una dirección de implementación, no como benchmark estadístico general.

## Spike 1: sqlite-vec y ejecutable compilado

### Paquetes

```text
sqlite-vec                 0.1.9
sqlite-vec-linux-x64       0.1.9
vec0.so                    159.816 bytes
SHA-256                    5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8
```

El paquete de plataforma contiene una biblioteca ELF x86-64 enlazada dinámicamente solo con `libc` y el cargador del sistema.

### Estrategia validada

La extensión se importa como archivo embebido:

```ts
import vecEmbeddedPath from "sqlite-vec-linux-x64/vec0.so" with { type: "file" };
```

En desarrollo, la ruta apunta a `node_modules`. En el ejecutable compilado apunta a una ruta virtual:

```text
/$bunfs/root/vec0-6zn72t7p.so
```

`dlopen()` no debe recibir esa ruta virtual. El proceso probado fue:

1. leer los bytes mediante `readFileSync()`;
2. calcular SHA-256;
3. escribirlos en un directorio real;
4. asignar permisos `0700`;
5. cargar la extensión mediante:

```ts
db.loadExtension(extractedPath, "sqlite3_vec_init");
```

La prueba creó una tabla `vec0`, insertó tres vectores y devolvió los vecinos en el orden esperado tanto desde Bun como desde el ejecutable independiente.

### Diseño aprobado para producción

- Extraer a `~/.local/share/nwp/extensions/vec0-<sha>.so`.
- Escribir primero un archivo temporal y hacer `rename()` atómico.
- Verificar el hash antes de reutilizar una extracción existente.
- Mantener la versión en el nombre para permitir actualizaciones y rollback.
- Cargar la extensión en cada conexión SQLite que utilice funciones o tablas `vec0`.
- Si la carga falla, mantener FTS operativo y marcar la búsqueda semántica como no disponible.

### Escala

Vectores aleatorios normalizados, distancia coseno, consultas exactas top-10:

| Vectores | Dimensiones | Tamaño SQLite | Inserción | Consulta p50 | Consulta p95 |
|---:|---:|---:|---:|---:|---:|
| 10.000 | 1.024 | 42,2 MB | 8.582 vectores/s | 11,7 ms | 12,7 ms |
| 100.000 | 1.024 | 413,8 MB | 8.542 vectores/s | 118,0 ms | 128,4 ms |

El comportamiento observado es compatible con búsqueda exacta aproximadamente lineal. Resulta razonable para la escala objetivo de hasta 100.000 chunks. Antes de crecer hacia un millón de chunks habría que reevaluar latencia, cuantización o un índice ANN.

### Reproducción

```sh
bun docs/spikes/sqlite-vec-compile-spike.ts .tmp/sqlite-vec-source

TMPDIR="$PWD/.tmp" bun build --compile --minify \
  --outfile .tmp/sqlite-vec-spike-bin \
  docs/spikes/sqlite-vec-compile-spike.ts

(cd /tmp && /ruta/al/sqlite-vec-spike-bin nwp-sqlite-vec-standalone)

VECTOR_COUNT=10000 \
  bun docs/spikes/sqlite-vec-scale-spike.ts .tmp/sqlite-vec-scale-10k
VECTOR_COUNT=100000 \
  bun docs/spikes/sqlite-vec-scale-spike.ts .tmp/sqlite-vec-scale-100k
```

## Spike 2: embeddings multilingües con Ollama

### Modelos

```text
qwen3-embedding:0.6b    639 MB
bge-m3                  1,2 GB
```

Ambos produjeron vectores de 1.024 dimensiones. Se probaron tres configuraciones:

- Qwen3 sin instrucción;
- Qwen3 con una instrucción de recuperación bilingüe añadida solo a las consultas;
- BGE-M3 sin prefijo.

La instrucción usada con Qwen3 fue:

```text
Instruct: Retrieve passages that answer the search query across Spanish and English.
Query: …
```

### Corpus

- 24 documentos cortos en español e inglés.
- 14 consultas cruzadas entre idiomas.
- Temas próximos y distractores: modelos locales y cloud, FTS y vectores, workers y threads, prompt injection y XSS, energía solar y eólica, además de cocina, viajes, finanzas, salud y metadatos.
- Relevancia binaria definida manualmente.
- Similitud coseno exacta.

### Calidad

| Configuración | MRR | Recall@1 | Recall@3 | nDCG@5 |
|---|---:|---:|---:|---:|
| `qwen3-embedding:0.6b`, raw | 0,860 | 0,786 | 0,929 | 0,881 |
| `qwen3-embedding:0.6b`, instruido | 0,946 | 0,929 | 0,929 | 0,939 |
| `bge-m3`, raw | **1,000** | **1,000** | **1,000** | **0,994** |

BGE-M3 colocó un documento relevante en primera posición para las 14 consultas. Qwen3 instruido falló en primera posición en una consulta sobre recuperación semántica, aunque la opción relevante permaneció dentro de los primeros resultados.

### Latencia

| Configuración | Arranque frío | Indexación del lote | Rendimiento | Consulta p50 | Consulta p95 |
|---|---:|---:|---:|---:|---:|
| Qwen3 raw | 1.529 ms | 4.409 ms | 5,44 docs/s | 121 ms | 257 ms |
| Qwen3 instruido | 1.562 ms | 4.375 ms | 5,49 docs/s | 119 ms | 135 ms |
| BGE-M3 raw | 1.798 ms | 5.318 ms | 4,51 docs/s | 118 ms | 126 ms |

BGE-M3 fue aproximadamente un 18 % más lento durante la indexación del lote y ocupa casi el doble en disco, pero su latencia de consulta caliente fue equivalente.

### Decisión aprobada

Configuración inicial:

```toml
[semantic_search]
embedding_model = "bge-m3"
embedding_dimensions = 1024
```

Alternativa para instalaciones con menos disco o memoria:

```toml
embedding_model = "qwen3-embedding:0.6b"
query_prefix = "Instruct: Retrieve passages that answer the search query across Spanish and English.\nQuery: "
```

Cada generación del índice debe registrar modelo, dimensión, prefijo de consulta y estrategia de chunking. Cambiar cualquiera de esos valores requiere reindexar.

El valor predeterminado queda aceptado para la primera implementación. El benchmark se repetirá con páginas reales de nwp para verificarlo y ajustar el ranking, sin bloquear el desarrollo inicial.

### Reproducción

```sh
ollama pull qwen3-embedding:0.6b
ollama pull bge-m3
bun docs/spikes/ollama-embedding-benchmark.ts \
  > docs/spikes/ollama-embedding-results.json
```

El JSON conserva rankings, puntuaciones y métricas detalladas por consulta.

## Conclusión

Los dos riesgos técnicos quedan desbloqueados para Linux x86-64:

- sqlite-vec puede distribuirse dentro del único ejecutable de nwp;
- BGE-M3 ofrece una base multilingüe suficientemente rápida y precisa para la escala inicial.

El siguiente bloque puede implementar la infraestructura de taxonomía, chunks, generaciones de índice y búsqueda híbrida sin introducir un servicio vectorial externo.
