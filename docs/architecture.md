# nwp architecture

`nwp` is a local wiki for a single user and development agents. It provides an SSR web interface, CLI, REST API, and MCP over a single SQLite database. The implemented behavior is defined by `src/` and `tests/`; this document explains how its components fit together.

## System boundaries

- **Local by default:** the server listens on `127.0.0.1`; data, configuration, and token follow XDG paths. REST and MCP require a Bearer token.
- **SQLite is the authority:** it stores metadata, relationships, queues, and versions. Pages retain their GFM Markdown body; documents retain their original and structured extraction.
- **Thin interfaces:** UI, REST, CLI, and MCP share validation and persistence. A domain rule must not be reimplemented in each interface.
- **Optional capabilities:** Ollama, `sqlite-vec`, Tesseract, Poppler, Whisper, and `web-research` improve particular functions, but their absence must not prevent creating, reading, or searching lexically.

## Components

| Area | Main modules | Responsibility |
| --- | --- | --- |
| Startup and configuration | `main.ts`, `config.ts` | CLI, server and worker process, TOML/XDG, and default limits. |
| Domain and storage | `domain.ts`, `database.ts` | Validation, migrations, transactions, pages, revisions, taxonomy, and SQLite queues. |
| HTTP interfaces | `server.ts`, `openapi.ts`, `mcp.ts` | SSR UI, REST API, OpenAPI contract, authentication, and MCP tools. |
| Knowledge | `semantic.ts`, `answer.ts`, `tagging.ts` | FTS5, vectors, hybrid ranking, cited RAG, and assisted tags. |
| Ingestion | `documents.ts`, `web.ts`, `research.ts` | Document extraction, OCR, web capture, research, and transcription. |
| Portability and operation | `transfer.ts`, `backup.ts`, `service.ts` | Import/export, recovery, backups, and the user systemd unit. |

## Data flows

### Pages

A write passes through domain validation and a SQLite transaction. The application records a revision before a significant change, updates links and tags, and queues semantic indexing when enabled. Deletion moves a page to trash; only purging destroys data permanently.

### Documents and captures

An import or capture creates a linked page and a durable job. The worker extracts sections and, where appropriate, OCR; it then indexes them in FTS and the semantic queue. Replacements retain versions and do not silently overwrite human changes. Captures store snapshots and local SHA-256-addressed resources.

### Search and answers

Search uses FTS5 immediately and merges vector results when `sqlite-vec` and Ollama are available. Answers retrieve evidence first, generate citations with application-controlled identifiers, and validate every citation before returning it. When semantic capability is unavailable, lexical search remains available with an explicit notice.

## Durable jobs

Extraction, OCR, indexing, capture, research, and tagging use SQLite queues. Each job uses a lease, heartbeat, retry, cancellation, and checks against stale results. An HTTP handler must enqueue work; it must not start a long-running, unpersisted background task.

## Security and untrusted content

- Native capture permits only public HTTP(S): it validates the URL, DNS, IP, and every redirect, and sends neither cookies nor credentials.
- Delegated mode entrusts transport and text extraction to `web-research`, but bounds the process, validates its envelope, and treats every result as untrusted evidence. Images use the safe native transport.
- Documents, captured pages, and retrieved text are data, never instructions. RAG and tagging use bounded inputs and deterministic output validation.
- The UI sanitizes Markdown and HTML. REST and MCP use Bearer authentication. Loopback addressing, Host, origin, and CSRF are part of the security boundary.

## Changes requiring additional attention

- A migration must be transactional, compatible with existing installations, and covered by tests.
- Changing the embedding model, dimensions, prefix, or chunking requires a complete reindex.
- Changing a public interface requires updating implementation, OpenAPI, CLI or MCP as appropriate, and `README.md`.
- Changes to capture, OCR, or subprocesses must preserve time, size, path, and cancellation limits.
