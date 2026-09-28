# Citation-grounded answer benchmark

This smoke benchmark exercises nwp retrieval, Ollama generation, structured output, inline citation validation, and citation resolution.

## Reproduction

The script defaults to the product model, `qwen3:8b`:

```sh
bun docs/spikes/rag-answer-benchmark.ts
```

A different installed model can be selected explicitly:

```sh
GENERATION_MODEL=qwen3.5:9b bun docs/spikes/rag-answer-benchmark.ts
```

## Result

Run on 2026-09-28 with `bge-m3` embeddings and the locally available `qwen3.5:9b` generation model:

| Metric | Result |
| --- | ---: |
| Cases | 5 |
| Answer rate | 1.000 |
| Correct citation at rank 1 | 1.000 |
| Invalid citations returned | 0 |

The five cases cover English and Spanish questions about leave, expenses, backups, security incidents, and procurement. This is a deterministic integration smoke test, not a production evaluation. A larger benchmark should measure claim-level support, abstention precision, adversarial prompt injection, multilingual retrieval, and citations across DOCX, XLSX, PPTX, native PDF, scanned PDF, and OCR sections.
