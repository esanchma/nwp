# nwp

nwp (nano-wiki-pi) is a small local wiki for people and development agents. It provides a server-rendered web interface, a CLI, and MCP tools over one SQLite database.

nwp supports page creation, reading, listing, editing, full-text search, revision history, restoration, a recoverable trash, deduplicated file attachments, publication states, custom properties, parent-child navigation, and portable import/export. Pages use GitHub Flavored Markdown, `[[wiki-links]]`, backlinks, and tags. nwp stores a complete snapshot before each meaningful edit.

## Requirements

Building requires Bun 1.4 or newer on Linux x86-64. The compiled executable does not require Bun at runtime.

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

[document_rag]
enabled = true
max_file_bytes = 536870912
max_expanded_bytes = 2147483648
max_archive_entries = 100000
max_compression_ratio = 1000
max_pdf_pages = 10000
max_spreadsheet_cells = 5000000
```

The server also accepts `--host`, `--port`, `--data-dir`, and `--config`. Command-line values override the configuration file.

The default loopback address is part of nwp's security boundary. Exposing nwp on a network requires a separate security review.

## Web interface

The home page lists recently modified pages. Use **New page** to enter a title, optional alias, comma-separated tags, and Markdown.

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
./dist/nwp tree --status all
./dist/nwp tag define --tag topic:artificial-intelligence --kind topic --name "Artificial intelligence" --aliases "ai,ia,inteligencia-artificial"
./dist/nwp tag list
./dist/nwp document import ./handbook.docx
./dist/nwp document list
./dist/nwp document get 1
./dist/nwp document replace 1 ./handbook-v2.docx
./dist/nwp document review 1
./dist/nwp document cancel 2
./dist/nwp document retry 2
./dist/nwp document run --json
./dist/nwp index status --json
./dist/nwp index run
./dist/nwp export page 1 --output installation-guide.md
./dist/nwp import installation-guide.md
./dist/nwp export all --output nwp-export.tar.gz
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
- `GET /api/v1/search?q=terms&mode=hybrid&tags=tag-one,tag-two&status=published&properties={...}`
- `GET|POST /api/v1/tags/definitions`
- `GET /api/v1/semantic/status`
- `GET|POST /api/v1/documents`
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
- `update_page`
- `get_page_tree`
- `list_tag_definitions`
- `define_tag`
- `semantic_index_status`
- `list_documents`
- `get_document`
- `get_document_content`
- `get_document_upload_instructions`
- `acknowledge_document_review`
- `cancel_document_extraction`
- `retry_document_extraction`
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
- `manifest.json` with format version, associations, taxonomy, and document parser metadata.

The archive is intended for portable backup and inspection. Page import accepts individual Markdown documents; restoring a complete archive into a database is part of the upcoming operational backup/restore tooling.

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

The page displays extracted text virtually rather than duplicating it in Markdown. Replacements are explicit by document ID, retain earlier versions, preserve human page edits, and set `needsReview` when managed fields diverge. Embedded images and low-text PDF pages are marked for the upcoming OCR delivery.

Office archives are parsed without executing macros, formulas, or external connections. Configurable technical guards constrain archive expansion, compression ratio, entry count, XML depth, PDF pages, spreadsheet cells, and upload memory. Run extraction with `nwp worker`, `nwp serve --with-worker`, or the one-shot `nwp document run`.

## Trash

Deleting a page moves it to trash and immediately releases its public alias. Wiki-links show a deleted state while that alias remains unused. If another page claims the alias, links resolve to the new active page.

Restoring uses the original alias when it is free and generates a unique suffixed alias otherwise. Purging is explicit, permanent, and removes the page, its revisions, tags, and outgoing link records.

## History and restoration

Every meaningful update records the complete previous page state. Open **History** on a page to inspect snapshots and compare one with the current page in a side-by-side Markdown diff.

Restoring a revision first snapshots the current state, so the restoration itself can be undone later. If another page now owns the historical alias, nwp generates a unique suffixed alias instead of overwriting either page.

## Search

Hybrid search combines SQLite FTS5 results with semantic chunk similarity through sqlite-vec and Reciprocal Rank Fusion. It covers titles, aliases, Markdown bodies, tags, properties, and deterministic page chunks. If Ollama or sqlite-vec is unavailable, nwp returns lexical results with a warning.

Semantic indexing is asynchronous and durable. Run a separate `nwp worker`, use `nwp serve --with-worker`, or execute `nwp index run` as a one-shot. Page writes remain immediate while the index catches up. The default embedding model is `bge-m3`; changing model, dimensions, query prefix, or chunk settings queues a complete reindex.

The lexical index uses SQLite FTS5. Words are matched as case-insensitive prefixes. Accent variants match when SQLite can remove their diacritics.

Use the advanced search page to choose hybrid or lexical mode and require tags, a page state, and exact typed property values. Multiple text words, tags, and properties use AND semantics. Search results use opaque cursors for pagination.

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
- `src/domain.ts`: validation and domain rules
- `src/server.ts`: web and JSON HTTP handlers
- `src/mcp.ts`: MCP tools and transport
- `src/main.ts`: executable and CLI

The approved scope and later roadmap are in [`docs/mvp-spec.md`](docs/mvp-spec.md). The sqlite-vec packaging and Ollama embedding experiments are documented in [`docs/semantic-search-spikes.md`](docs/semantic-search-spikes.md).
