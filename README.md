# nwp

nwp (nano-wiki-pi) is a small local wiki for people and development agents. It provides a server-rendered web interface, a CLI, and MCP tools over one SQLite database.

nwp supports page creation, reading, listing, editing, hybrid full-text and semantic search, durable document extraction with local OCR, versioned web capture, durable multi-source research, citation-grounded answers, revision history, restoration, a recoverable trash, deduplicated file attachments, publication states, custom properties, parent-child navigation, and portable import/export. Pages use GitHub Flavored Markdown, `[[wiki-links]]`, backlinks, and tags. nwp stores a complete snapshot before each meaningful edit.

## Requirements

Building requires Bun 1.4 or newer on Linux x86-64. The compiled executable does not require Bun at runtime. Hybrid search and answers require a local Ollama service with the configured models; the defaults can be installed with `ollama pull bge-m3` and `ollama pull qwen3:8b`. Document OCR is optional and uses local `tesseract` plus the `spa` and `eng` language packs. OCR of scanned PDF pages also requires `pdftoppm` from Poppler. Ingestion remains available when these programs are absent.

## Build and test

```sh
bun install
bun test
bun run typecheck
bun run build
```

The executable is written to `dist/nwp`.

## Run

```sh
./dist/nwp serve
```

Open <http://127.0.0.1:3000>. By default nwp stores its files here:

- database: `~/.local/share/nwp/nwp.db`
- API token: `~/.local/share/nwp/api-token`
- configuration: `~/.config/nwp/config.toml`

The token file is generated on first run with owner-only permissions.

Only one server may use a data directory at a time. nwp records human-readable logs on stderr.

## Configuration

Create `~/.config/nwp/config.toml` when you need non-default values:

```toml
host = "127.0.0.1"
port = 3000
data_dir = "~/.local/share/nwp"
max_attachment_bytes = 0 # zero means unlimited

[semantic_search]
enabled = true
ollama_url = "http://127.0.0.1:11434"
embedding_model = "bge-m3"
embedding_dimensions = 1024
query_prefix = ""
chunk_characters = 1600
chunk_overlap = 200

[rag_answer]
enabled = true
ollama_url = "http://127.0.0.1:11434"
generation_model = "qwen3:8b"
timeout_seconds = 120
max_evidence_items = 8
max_evidence_characters = 6000
max_prompt_characters = 50000
max_answer_characters = 12000
include_general_knowledge = true

[web_capture]
enabled = true
timeout_seconds = 30
max_redirects = 5
max_response_bytes = 20971520
max_extracted_characters = 2000000
user_agent = "nwp/0.17 (+local knowledge capture)"

[research]
enabled = true
search_command = "" # optional path to the web-research executable
search_timeout_seconds = 60
max_search_output_bytes = 2097152
default_max_sources = 5
maximum_sources = 20

[document_rag]
enabled = true
max_file_bytes = 536870912
max_expanded_bytes = 2147483648
max_archive_entries = 100000
max_compression_ratio = 1000
max_pdf_pages = 10000
max_spreadsheet_cells = 5000000
ocr_enabled = true
tesseract_command = "tesseract"
pdf_renderer_command = "pdftoppm"
ocr_languages = ["spa", "eng"]
ocr_timeout_seconds = 120
max_ocr_items = 10000
max_ocr_output_characters = 1000000
```

The server also accepts `--host`, `--port`, `--data-dir`, and `--config`. Command-line values override the configuration file.

The default loopback address is part of nwp's security boundary. Exposing nwp on a network requires a separate security review.

## Web interface

The home page lists recently modified pages. Use **New page** to enter a title, optional alias, comma-separated tags, and Markdown. Creation and editing provide a responsive side-by-side Markdown editor and sanitized server-rendered preview. The preview updates after a short pause, understands current wiki-link state, includes a compact formatting toolbar and character count, warns about unsaved changes, and supports Ctrl/⌘+S. The form and its initial preview still work when JavaScript is unavailable.

Link to another page with its alias:

```markdown
Read the [[installation-guide]].
```

A missing target appears as a red link that opens a prefilled creation form. Existing pages show backlinks below their content.

## CLI

Page commands connect to the running local server and read the generated token automatically.

```sh
./dist/nwp page create \
  --title "Installation guide" \
  --tags "nwp,guide" \
  --status published \
  --parent 1 \
  --properties '{"owner":"platform","priority":2}' \
  --body "Return to [[home]]."

./dist/nwp page list
./dist/nwp page get installation-guide --json
./dist/nwp page update 1 --body-file updated-page.md
./dist/nwp page history 1
./dist/nwp page diff 1 3
./dist/nwp page restore 1 3
./dist/nwp page delete 1
./dist/nwp trash list
./dist/nwp trash restore 1
./dist/nwp trash purge 1
./dist/nwp attachment add 1 ./diagram.png
./dist/nwp attachment list 1
./dist/nwp attachment get 4 --output ./diagram.png
./dist/nwp attachment delete 4
./dist/nwp search "installation runtime" --tags "nwp,guide" --status published
./dist/nwp search "approval policy" --source documents --format pdf --ocr-status completed --kind page
./dist/nwp answer "¿Cuánto dura el permiso parental?" --source all --general-knowledge true
./dist/nwp tree --status all
./dist/nwp tag define --tag topic:artificial-intelligence --kind topic --name "Artificial intelligence" --aliases "ai,ia,inteligencia-artificial"
./dist/nwp tag list
./dist/nwp document import ./handbook.docx
./dist/nwp document list
./dist/nwp document ocr-status
./dist/nwp document get 1
./dist/nwp document replace 1 ./handbook-v2.docx
./dist/nwp document review 1
./dist/nwp document cancel 2
./dist/nwp document retry 2
./dist/nwp document run --json
./dist/nwp web add https://example.com/article
./dist/nwp web list
./dist/nwp web get 1
./dist/nwp web refresh 1
./dist/nwp web schedule 1 --interval 86400
./dist/nwp web schedule 1 --interval off
./dist/nwp web cancel 1
./dist/nwp web retry 1
./dist/nwp web run --json
./dist/nwp research add "Compare the parental leave policies" --urls "https://example.com/policy-a,https://example.org/policy-b"
./dist/nwp research list
./dist/nwp research get 1
./dist/nwp research run 1
./dist/nwp index status --json
./dist/nwp index run
./dist/nwp export page 1 --output installation-guide.md
./dist/nwp import installation-guide.md
./dist/nwp export all --output nwp-export.tar.gz
./dist/nwp backup create
./dist/nwp backup list
./dist/nwp backup verify ./nwp-export.tar.gz
./dist/nwp backup restore ./nwp-export.tar.gz --dry-run
./dist/nwp backup restore ./nwp-export.tar.gz
./dist/nwp service install
./dist/nwp service status
```

Use `--body-file -` to read Markdown from stdin. Add `--json` for machine-readable output. Remote or non-default clients can pass `--endpoint`, `--token`, and `--config`.

Run `./dist/nwp help` for the complete command summary.

## JSON API

The local API is rooted at `/api/v1` and requires the token as a Bearer credential.

```sh
TOKEN=$(cat ~/.local/share/nwp/api-token)
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3000/api/v1/pages
```

Available operations:

- `GET /api/v1/openapi.json`
- `POST /api/v1/pages`
- `GET /api/v1/pages?limit=50&cursor=...`
- `GET /api/v1/pages/:id-or-alias`
- `PUT /api/v1/pages/:id`
- `GET /api/v1/search?q=terms&mode=hybrid&source=all&format=pdf&kind=page&ocr_status=completed&hidden=false`
- `POST /api/v1/answer` with a question and optional evidence filters
- `GET|POST /api/v1/tags/definitions`
- `GET /api/v1/semantic/status`
- `GET|POST /api/v1/documents`
- `GET|POST /api/v1/web-captures`
- `GET /api/v1/web-captures/:id`
- `POST /api/v1/web-captures/:id/refresh|cancel|retry`
- `PUT /api/v1/web-captures/:id/schedule`
- `GET|POST /api/v1/research`
- `GET /api/v1/research/:id`
- `POST /api/v1/research/:id/cancel|retry`
- `GET /api/v1/documents/ocr/status`
- `GET /api/v1/documents/:id`
- `GET|POST /api/v1/documents/:id/versions`
- `GET /api/v1/documents/:id/content`
- `GET /api/v1/documents/:id/download`
- `POST /api/v1/documents/:id/review`
- `POST /api/v1/documents/:id/cancel|retry`
- `GET /api/v1/tree?status=published`
- `GET /api/v1/pages/:id/export`
- `POST /api/v1/import/pages` with a Markdown request body
- `GET /api/v1/export`
- `GET /api/v1/pages/:id/revisions`
- `GET /api/v1/pages/:id/revisions/:revision-id`
- `GET /api/v1/pages/:id/revisions/:revision-id/diff`
- `POST /api/v1/pages/:id/revisions/:revision-id/restore`
- `DELETE /api/v1/pages/:id`
- `GET /api/v1/trash`
- `GET /api/v1/trash/:id`
- `POST /api/v1/trash/:id/restore`
- `DELETE /api/v1/trash/:id`
- `POST /api/v1/pages/:id/attachments?filename=name.ext` with raw bytes
- `GET /api/v1/pages/:id/attachments`
- `GET /api/v1/attachments/:id`
- `GET /api/v1/attachments/:id/content`
- `DELETE /api/v1/attachments/:id`

## OpenAPI and Swagger UI

Interactive Swagger UI documentation is available at <http://127.0.0.1:3000/api-docs>. Its CSS and JavaScript are bundled into the nwp executable, so it works without a CDN or internet connection. Use **Authorize** and enter the contents of `~/.local/share/nwp/api-token` to run API requests from the page.

The versioned OpenAPI 3.1 contract is available from authenticated API clients at `/api/v1/openapi.json`. The trusted local web interface and Swagger UI use the public local copy at `/openapi.json`. It documents Bearer authentication, request and response schemas, errors, filtering, binary transfer, and all `/api/v1` operations.

The test suite validates the document against the official OpenAPI schema, verifies unique and complete operation IDs, and checks that the local Swagger UI assets are served with a restrictive Content Security Policy.

## MCP

The server exposes stateless Streamable HTTP at:

```text
http://127.0.0.1:3000/mcp
```

Configure the MCP client to send this header:

```text
Authorization: Bearer <contents of ~/.local/share/nwp/api-token>
```

Tools:

- `create_page`
- `get_page`
- `list_pages`
- `search_pages`
- `search_knowledge`
- `answer_question`
- `update_page`
- `get_page_tree`
- `list_tag_definitions`
- `define_tag`
- `get_statistics`
- `get_health`
- `semantic_index_status`
- `list_documents`
- `document_ocr_status`
- `get_document`
- `get_document_content`
- `get_document_upload_instructions`
- `acknowledge_document_review`
- `cancel_document_extraction`
- `retry_document_extraction`
- `queue_web_capture`
- `list_web_captures`
- `get_web_capture`
- `cancel_web_capture`
- `retry_web_capture`
- `refresh_web_capture`
- `schedule_web_capture`
- `queue_research`
- `list_research`
- `get_research`
- `cancel_research`
- `retry_research`
- `export_page`
- `import_page`
- `get_full_export`
- `list_revisions`
- `get_revision_diff`
- `restore_revision`
- `delete_page`
- `list_trash`
- `get_deleted_page`
- `restore_page`
- `purge_page`
- `list_attachments`
- `get_attachment`
- `get_attachment_upload_instructions`
- `delete_attachment`

Each tool uses the same validation and storage rules as the web and CLI interfaces.

## Import and export

Exporting one page produces Markdown with generated YAML front matter containing its title, alias, tags, state, parent, properties, and timestamps. Import requires this front matter. Database IDs and timestamps are not reused, and an occupied alias receives a numeric suffix. If the named parent is unavailable, the page is imported at the root. Attachment URLs in Markdown remain unchanged.

A complete export is a streaming `tar.gz` containing:

- active pages under `pages/`;
- deleted pages under `trash/`;
- historical snapshots under `history/`;
- each deduplicated attachment blob under `attachments/`;
- original document versions under `documents/`;
- retained raw web responses under `web/`;
- an integrity-protected SQLite snapshot under `database/`;
- `manifest.json` with format version, SHA-256 metadata, associations, taxonomy, document parser metadata, web capture provenance, and research results.

Format version 2 archives support exact restoration. `nwp backup verify` applies path, file-type, entry-count, expanded-byte, declared-size, SHA-256, SQLite integrity, foreign-key, and referenced-blob checks. `nwp backup restore --dry-run` builds and validates a disposable restored data directory without changing the current installation.

A real restore requires the server and workers to be stopped. nwp takes the instance lock, creates an automatic pre-restore archive in the sibling `nwp-backups/` directory, builds the restored database in a staging directory, preserves the API token, and atomically swaps data directories. If the swap fails, the previous directory is moved back into place.

## Service operation

`nwp service install` writes and enables a hardened systemd user unit for the current executable and configured paths. It runs `nwp serve --with-worker`, restarts on failure, uses a private temporary directory, makes the system read-only, and grants write access only to the nwp data directory. Use `nwp service status` to inspect it and `nwp service uninstall` to stop and remove it.

## States, properties, and hierarchy

Pages can be `draft`, `published`, or `archived`. Direct URLs remain readable for every state. Recent pages, page lists, tags, trees, and search use published pages by default; choose another state or `all` explicitly.

Custom properties are a JSON object whose keys use lowercase letters, numbers, dots, underscores, or hyphens. Values may be strings, finite numbers, booleans, or null. Search indexes keys and textual values and supports exact typed property filters.

A page may have one parent. nwp prevents cycles, renders breadcrumbs, and exposes a tree view at `/tree`. Parent relationships do not alter aliases or URLs.

States, parents, and properties are included in revision snapshots and restoration.

## Attachments

Upload files from a page or with `nwp attachment add`. nwp stores bytes under `~/.local/share/nwp/attachments/` by SHA-256, so identical content is stored once even when several pages use it. SQLite stores association and display metadata.

PNG, JPEG, GIF, WebP, BMP, and AVIF files are recognized from their byte signatures and may render inline. SVG, HTML, and every other type download by default with `nosniff` protection. Copy an attachment URL into Markdown when you want to embed or link it.

Deleting a page retains its attachment associations. Restoring the page restores them. Permanently purging a page removes unreferenced blobs but preserves content still attached elsewhere.

MCP exposes metadata and local URLs. Binary upload and download use the authenticated REST endpoints instead of base64 tool payloads.

## Document ingestion

Import DOCX, XLSX, PPTX, PDF, Markdown, and TXT from `/documents`, REST, or the CLI. Each document receives a linked wiki page and content-addressed original storage. Extraction runs in the durable worker and produces source-aware sections: Word headings and tables, PowerPoint slides and speaker notes, Excel sheet/range blocks, PDF pages, and Markdown headings. Hidden slides and sheets are retained and marked.

The page displays extracted text virtually rather than duplicating it in Markdown. Replacements are explicit by document ID, retain earlier versions, preserve human page edits, and set `needsReview` when managed fields diverge.

When enabled, the worker runs local Tesseract OCR with Spanish and English data. It extracts text from DOCX and PPTX images, renders low-text PDF pages through `pdftoppm`, and stores image or page locators with each OCR section. OCR state is `pending`, `completed`, `partial`, or `unavailable`; a missing executable or language pack does not fail native extraction. Install the missing capability and run `nwp document retry ID` to reprocess an OCR-pending document. Use `nwp document ocr-status` to diagnose the runtime.

Every extracted section is added to FTS5 immediately and queued for durable semantic indexing. Document replacement removes stale search entries before the new version is extracted. Results link directly to the cited page, slide, sheet/range, image, or section in the content viewer.

Office archives are parsed without executing macros, formulas, or external connections. Configurable technical guards constrain archive expansion, compression ratio, entry count, XML depth, PDF pages, spreadsheet cells, upload memory, OCR item counts, subprocess time, and OCR output. Run extraction with `nwp worker`, `nwp serve --with-worker`, or the one-shot `nwp document run`.

## Web capture

Queue a public page from `/web-captures`, `nwp web add`, REST, or MCP. The durable worker fetches it, retains the exact raw response as a content-addressed snapshot, extracts bounded Markdown, and sends that Markdown through the existing document extraction and semantic indexing pipeline. Each capture receives a linked wiki page with `source:web`, `type:web-capture`, and a `web.url` property. Once both workers finish, captured content participates in document search, cited answers, and complete exports.

Network access is deliberately narrow: only HTTP(S) is allowed; URL credentials, localhost, private, loopback, link-local, multicast, documentation, and reserved addresses are blocked. nwp resolves every redirect independently, rejects any hostname with a non-public DNS answer, pins the validated address for the connection, sends no cookies or credentials, accepts only textual content, disables compression, and enforces redirect, timeout, response-byte, and extracted-character guards. Web content remains untrusted evidence and cannot issue model or tool instructions.

A failed capture retries with a leased SQLite job up to three times. Cancellation and retry are explicit. Existing captures can be refreshed manually or hourly, daily, weekly, or at another interval of at least five minutes. Refresh requests use retained `ETag` and `Last-Modified` validators. HTTP 304 and byte-identical responses do not create document versions; changed responses retain a new raw snapshot and queue an explicit document version while preserving human page edits.

Run capture with `nwp worker`, `nwp serve --with-worker`, or the one-shot `nwp web run`. The extractor remains deterministic and native; browser-rendered and authenticated pages are intentionally outside this release.

## Multi-source research

Research jobs combine source discovery, secure capture, document extraction, retrieval, and citation-grounded synthesis in one durable workflow. Supply URLs explicitly or configure `research.search_command` with the path to the `web-research` executable. nwp invokes only its `search` operation without a shell, parses URL records from bounded output, and passes every result through the same public-network policy. The external adapter never performs the authoritative capture.

Each research job records its selected captures, waits for usable document versions, restricts retrieval to those exact documents, and stores the validated answer and citations. Jobs have leases, retry and cancellation semantics and are available through `/research`, CLI, REST, MCP, and complete exports. General model knowledge is disabled for research synthesis.

## Trash

Deleting a page moves it to trash and immediately releases its public alias. Wiki-links show a deleted state while that alias remains unused. If another page claims the alias, links resolve to the new active page.

Restoring uses the original alias when it is free and generates a unique suffixed alias otherwise. Purging is explicit, permanent, and removes the page, its revisions, tags, and outgoing link records.

## History and restoration

Every meaningful update records the complete previous page state. Open **History** on a page to inspect snapshots and compare one with the current page in a side-by-side Markdown diff.

Restoring a revision first snapshots the current state, so the restoration itself can be undone later. If another page now owns the historical alias, nwp generates a unique suffixed alias instead of overwriting either page.

## Search

Hybrid search combines SQLite FTS5 results with semantic chunk similarity through sqlite-vec and Reciprocal Rank Fusion. It covers titles, aliases, Markdown bodies, tags, properties, deterministic page chunks, and extracted document sections, including OCR text. If Ollama or sqlite-vec is unavailable, nwp returns lexical results with a warning.

Semantic indexing is asynchronous and durable for both pages and current document versions. Run a separate `nwp worker`, use `nwp serve --with-worker`, or execute `nwp index run` as a one-shot. Page writes and lexical document search remain immediate while the vector index catches up. The default embedding model is `bge-m3`; changing model, dimensions, query prefix, or chunk settings queues a complete reindex.

The lexical index uses SQLite FTS5. Words are matched as case-insensitive prefixes. Accent variants match when SQLite can remove their diacritics.

Use the advanced search page to choose hybrid or lexical mode and filter by source, document ID, format, version, OCR state, hidden state, section kind, update interval, tags, page state, and exact typed property values. Multiple text words, tags, and properties use AND semantics. When a matching document section exists, its linked wiki page is suppressed to avoid duplicate results. Search results use opaque cursors for pagination.

## Citation-grounded answers

Use `/answer`, `nwp answer`, `POST /api/v1/answer`, or the MCP `answer_question` tool to generate a synchronous answer with Ollama. The default generation model is `qwen3:8b`. nwp retrieves evidence first, labels it with application-generated IDs, and accepts only citations that resolve to those IDs. Document citations link to the exact section in the content viewer.

Document and page content is treated as untrusted quoted evidence. The system prompt explicitly rejects instructions found inside evidence, generation uses a strict JSON schema, and nwp validates every inline citation. Each evidence-backed sentence or bullet must end in a marker such as `[E1]`. An invalid response receives one repair attempt; if it remains invalid, nwp abstains instead of returning an unsupported answer.

Evidence-backed output and general model knowledge are separate response fields and separate sections in the web interface. General knowledge can be disabled per request or globally. When retrieval finds no evidence and general knowledge is disabled, nwp abstains without calling the generation model.

## Tag taxonomy

Canonical tags have a kind (`topic`, `entity`, `source`, `type`, or `custom`), display name, optional description, and aliases. Aliases are resolved on page writes and tag-filtered searches. Defining an alias also migrates existing uses to the canonical tag while preserving search and semantic indexing.

Manage the vocabulary at `/taxonomy`, through REST, CLI, or MCP. Existing unclassified tags are migrated as `custom` definitions.

## Development

Run the server from source:

```sh
bun run dev
```

The main modules are:

- `src/database.ts`: migrations and page/document persistence
- `src/documents.ts`: safe document detection, extraction, and durable worker
- `src/web.ts`: SSRF-resistant HTTP capture, conditional refresh, deterministic extraction, and durable worker
- `src/research.ts`: bounded source discovery and durable multi-source cited synthesis
- `src/domain.ts`: validation and domain rules
- `src/server.ts`: web and JSON HTTP handlers
- `src/mcp.ts`: MCP tools and transport
- `src/main.ts`: executable and CLI

The approved scope and later roadmap are in [`docs/mvp-spec.md`](docs/mvp-spec.md). The sqlite-vec packaging and Ollama embedding experiments are documented in [`docs/semantic-search-spikes.md`](docs/semantic-search-spikes.md). The reproducible document retrieval smoke benchmark is in [`docs/document-search-benchmark.md`](docs/document-search-benchmark.md). Citation-grounded answer results and reproduction instructions are in [`docs/rag-answer-benchmark.md`](docs/rag-answer-benchmark.md).
