# Document retrieval benchmark

This benchmark exercises the nwp 0.12 document pipeline end to end: durable extraction, FTS5 section indexing, sqlite-vec loading, Ollama embeddings, hybrid fusion, document-only filtering, and citation-ready results.

## Reproduction

```sh
bun docs/spikes/document-retrieval-benchmark.ts
```

Environment used on 2026-09-28:

- Ollama native API at `http://127.0.0.1:11434`
- `bge-m3`, 1,024 dimensions
- sqlite-vec 0.1.9 embedded by nwp
- eight English policy documents
- eight paraphrased English and Spanish queries
- expected document measured in the first five results

## Result

| Metric | Result |
| --- | ---: |
| Documents | 8 |
| Queries | 8 |
| Recall@1 | 1.000 |
| MRR | 1.000 |

This is a deterministic smoke benchmark, not evidence of production retrieval quality. The next evaluation should use larger real DOCX, XLSX, PPTX, native PDF, and scanned PDF corpora, with relevance judgments at section level.
