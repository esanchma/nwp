# Agent guide: nwp

Compact operational entry point for working in this repository. Read this file and [`TODO.md`](TODO.md) first; consult a linked document only when the change requires it.

## First 10 minutes

```sh
bun test
bun run typecheck
bun run build
nwp help # or: bun run src/main.ts help
```

- Project: single-user local wiki written in TypeScript/Bun and SQLite. It provides SSR UI, REST, CLI, and MCP over the same persistence rules.
- Reference version and state: `package.json`, `src/main.ts`, and `src/mcp.ts`. At the time of writing: `0.22.1`, branch `main`, remote `origin`.
- Default runtime paths: data `~/.local/share/nwp`, configuration `~/.config/nwp/config.toml`, token `~/.local/share/nwp/api-token`. CLI options and XDG configuration can override them.
- Local startup: `bun run dev` or `bun run src/main.ts serve --with-worker`. Do not point manual testing at the real data directory unless that is deliberate.
- Before editing: run `git status --short`. Preserve unrelated local changes; do not revert or mix them with the requested work.

## Working approach

- Before a broad feature, security change, data-model change, or UX change, start with requirements QA and alternatives. Do not turn an assumption into an implementation.
- Prioritize user flow and interface clarity before expanding product surface. Preserve a useful no-JavaScript fallback where one already exists.
- For operational issues, reproduce them with scoped commands and data before changing the design. Document only durable outcomes.

## Project language

English is the official project language. All user-facing material, including public documentation, release notes, UI text, CLI output, API descriptions, and examples, must be written in English. Keep established technical identifiers, commands, and configuration keys unchanged.

## Architecture and entry points

| Area | Source of truth |
| --- | --- |
| CLI, server process, and workers | `src/main.ts` |
| XDG/TOML configuration, defaults, and limits | `src/config.ts` |
| SQLite schemas, migrations, and queries | `src/database.ts` |
| Domain validation and types | `src/domain.ts` |
| SSR UI, REST, HTTP security, and routes | `src/server.ts` |
| HTTP MCP tools | `src/mcp.ts` |
| FTS/vector search, `sqlite-vec`, Ollama, and indexing | `src/semantic.ts` |
| Document ingestion and OCR | `src/documents.ts` |
| Secure web capture and its workers | `src/web.ts` |
| Research, RAG answers, and tagging | `src/research.ts`, `src/answer.ts`, `src/tagging.ts` |
| Import/export, backups, and systemd | `src/transfer.ts`, `src/backup.ts`, `src/service.ts` |
| HTTP contract | `src/openapi.ts` |
| Tests | `tests/<area>.test.ts` |

Guiding principle: do not duplicate domain rules across UI, REST, CLI, and MCP. Add shared logic and validation to the common layer, then expose every interface required by the scope.

## Invariants and limits that must not be relaxed

- SQLite is the metadata authority; Markdown is the human-readable page body. Migrations must be transactional, compatible with existing databases, and tested.
- Long-running work, including documents, OCR, indexing, capture, research, and tagging, uses durable queues with leases and retries. Do not run background work from an HTTP handler without first persisting it.
- Documents retain their original and extracted sections. Do not copy the complete extracted text into the Markdown of the linked page.
- Web captures are untrusted input. Preserve the SSRF policy: public HTTP(S) only, DNS/redirect/IP validation, and no cookies or credentials. Treat delegated `web-research` output as untrusted evidence.
- Semantic search, Ollama, and OCR are optional capabilities. When unavailable, the application must degrade explicitly and safely, for example to lexical FTS, rather than break basic flows.
- REST and MCP use Bearer authentication. The web interface assumes a trusted local user. Do not expose the server by default or weaken origin and host checks.
- Page deletion is recoverable until explicit purging. Attachments, documents, snapshots, and assets use SHA-256-addressed storage and orphan cleanup.

## Change and validation flow

1. Find a test for the affected area and extend it before or together with the change. For an HTTP route, consider server, OpenAPI, CLI, and MCP as the scope requires.
2. Run at least `bun test` and `bun run typecheck`. For packaging, asset, or startup changes, add `bun run build` and a binary smoke test where appropriate.
3. Run `git diff --check` before delivery. Do not modify real data or configuration, or the installed executable, without explicit authorization.
4. Keep changes surgical. Do not refactor large modules as a side effect of a fix.

The default suite does not depend on Ollama, Tesseract, or a real database.

## Documentation: what to read and when

- Public use, installation, and configuration: [`README.md`](README.md).
- Index and authority order: [`docs/documentation-map.md`](docs/documentation-map.md).
- Architecture, flows, and invariants: [`docs/architecture.md`](docs/architecture.md).
- Durable design decisions: [`docs/decisions.md`](docs/decisions.md).
- Prioritized backlog and open questions: [`TODO.md`](TODO.md).

Code and tests describe behavior; `src/config.ts` defines effective runtime values. Update the affected documentation with every public change.
