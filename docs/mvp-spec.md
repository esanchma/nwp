# nwp MVP specification

Status: approved scope after product QA

## Purpose

nwp (nano-wiki-pi) is a small, self-hosted wiki for one trusted local user and local development agents. The MVP succeeds when the user can create and edit Wikipedia-style pages in a browser and can perform the same page operations through the CLI and MCP.

The MVP favors a small working product over the complete product vision. Features listed under [Roadmap](#roadmap) are intentionally excluded from the first release.

## Runtime and distribution

- Runtime and build tool: Bun.
- Distribution: one Linux x86-64 executable built with `bun build --compile`.
- Official platform: Linux x86-64.
- Default address: `127.0.0.1:3000`.
- Database: `~/.local/share/nwp/nwp.db`.
- Configuration: `~/.config/nwp/config.toml`.
- API token: generated on first run and stored in a separate file with mode `0600` under `~/.local/share/nwp/`.
- Logs: human-readable text on stderr.
- Documentation: a README must cover installation, web use, CLI use, configuration, and MCP client setup.

The server must hold an exclusive instance lock for its data directory. A second server using the same directory must fail with a clear error.

## MVP data model

### Page

A page contains:

- an autoincrementing SQLite integer ID;
- a required title;
- a required, unique alias;
- a Markdown body;
- zero or more tags;
- creation and modification timestamps.

Aliases use lowercase ASCII letters, digits, and hyphens. nwp derives the initial alias from the title, adds a suffix when needed, and lets the caller edit it. Alias lookup is case-insensitive.

### Revision

Every meaningful page change stores a full snapshot of the previous page state. A revision contains the title, alias, Markdown body, tags, timestamp, and source (`web`, `cli`, `rest`, or `mcp`). Duplicate updates do not create revisions.

The MVP stores revisions but does not expose history, diff, or restore screens. The schema must preserve enough information to add those features later.

### Link

nwp extracts wiki-links from each saved body and maintains an index of source and target aliases. This index supports backlinks and efficient updates after an edit.

### Tag

Tags are normalized for case-insensitive lookup. The web editor accepts a comma-separated tag field. The UI provides a tag index and a page list for each tag.

## Markdown and wiki-links

- Render GitHub Flavored Markdown.
- Support `[[alias]]` wiki-links.
- Resolve wiki-links by normalized alias without regard to case.
- Show a missing target as a red link.
- A red link opens the create form with a proposed title and alias.
- Show backlinks on each page.
- Sanitize raw HTML with a conservative allowlist before returning rendered content.

SQLite is the source of truth for all metadata. The editable Markdown body has no front matter.

## Web interface

The web interface uses server-rendered HTML and minimal client-side JavaScript. It must work with JavaScript disabled except where an enhancement explicitly requires it.

Required views:

- `/`: recently modified pages;
- `/pages`: all pages;
- `/wiki/:alias`: rendered page, tags, and backlinks;
- `/new`: create page;
- `/wiki/:alias/edit`: edit page;
- `/tags`: tag index;
- `/tags/:tag`: pages with one tag.

The editor is a plain textarea. Preview and side-by-side editing are deferred.

The UI must provide:

- responsive layouts for desktop and mobile;
- light and dark color schemes;
- semantic HTML;
- keyboard operation;
- visible focus states;
- adequate color contrast.

The MVP has no login because the HTTP server listens on loopback by default.

## Page operations

The web interface, CLI, and MCP provide the same operations:

1. create a page;
2. read a page by ID or alias;
3. list pages;
4. update a page.

The MVP does not expose delete, restore, or search operations.

All interfaces call one domain service. They must not implement page rules independently.

## HTTP API

A local JSON API under `/api/v1` supports the CLI and other local clients. It provides create, read, list, and update operations for pages.

Requirements:

- Bearer-token authentication;
- cursor-based page listing;
- stable JSON error objects;
- request-size limits;
- no CORS access by default;
- validated `Host` headers;
- parameterized SQLite queries.

The browser UI uses same-origin form submissions. State-changing web requests use CSRF protection and SameSite cookies. The public OpenAPI contract is deferred, but endpoint handlers and schemas should remain suitable for later documentation.

## CLI

The compiled executable provides:

```text
nwp serve
nwp page create
nwp page get
nwp page list
nwp page update
```

Page commands act as API clients and require a running server. They read the local token automatically unless the caller supplies an explicit endpoint or token. Commands support machine-readable JSON output as well as concise human-readable output.

Direct offline database editing is outside the MVP.

## MCP

The running server exposes MCP through local Streamable HTTP. MCP requires the same Bearer token as the JSON API.

Required tools:

- `create_page`;
- `get_page`;
- `list_pages`;
- `update_page`.

Tool inputs and outputs use the same validation and domain service as the web and JSON API. Page reads include tags and backlinks. Search, history, attachments, metadata, and export tools were added after the MVP; statistics remain deferred.

## SQLite behavior

Use Bun's SQLite support. On every connection, enable foreign keys and set a busy timeout. Use WAL mode and `synchronous=NORMAL`.

Schema changes use ordered migrations. Before an automatic migration, nwp creates a consistent database backup. It retains all migration backups in the data directory. A failed migration must leave the prior database usable.

## Security boundaries

The MVP assumes one trusted Unix account. It does not assume that arbitrary browser pages or local network clients are trusted.

Required controls:

- listen on loopback unless the user explicitly changes the configuration;
- authenticate JSON API and MCP requests with the generated token;
- reject cross-origin browser API requests;
- validate the `Host` header to reduce DNS-rebinding risk;
- protect HTML form writes against CSRF;
- sanitize rendered HTML;
- escape all template values by default;
- validate aliases, tags, IDs, cursors, and body sizes;
- store the API token with owner-only permissions;
- avoid logging secrets or complete page bodies.

## Configuration

`config.toml` initially supports:

```toml
host = "127.0.0.1"
port = 3000
data_dir = "~/.local/share/nwp"
```

Command-line flags may override these values for `nwp serve`. Configuration precedence is:

1. CLI flags;
2. `config.toml`;
3. built-in defaults.

Paths must expand `~` and follow XDG locations when the corresponding environment variables are set.

## Quality requirements

The MVP requires:

- unit tests for alias generation, validation, Markdown sanitization, wiki-link extraction, cursor handling, and revision creation;
- SQLite integration tests for migrations, constraints, transactions, revision snapshots, tags, and backlinks;
- API tests for authentication, validation, pagination, and error responses;
- browser end-to-end tests for create, read, list, update, tags, backlinks, and red-link creation;
- CLI end-to-end tests against a running server;
- security tests for CSRF, CORS, Host validation, token handling, HTML sanitization, and path handling;
- a smoke test of the compiled executable.

## Acceptance criteria

The MVP is complete when all of the following statements are true:

1. A user can build one native executable on Linux x86-64 and start it without a separate Bun runtime.
2. First run creates the required XDG directories, database, migrations, and protected API token.
3. A user can create, read, list, and edit pages from the browser.
4. A user can add tags, browse the tag index, follow wiki-links, create a missing linked page, and inspect backlinks.
5. A local CLI client can perform the same four page operations.
6. An MCP client can perform the same four page operations through Streamable HTTP.
7. Meaningful edits create internal revision snapshots.
8. Restarting the process preserves pages, tags, links, and revisions.
9. The required automated tests pass against source and compiled builds where applicable.
10. The README contains enough information to run the web, CLI, and MCP flows from a clean Linux account.

## Implemented after MVP

Version 0.2 adds SQLite FTS5 search over titles, aliases, Markdown bodies, and tags. Search is available in the web interface, JSON API, CLI, and MCP, with tag filters and cursor pagination.

Version 0.3 adds revision listing, side-by-side Markdown diffs, and safe restoration across the web interface, JSON API, CLI, and MCP. Restoration snapshots the current state and generates an alternate alias when the historical alias is occupied.

Version 0.4 adds recoverable deletion across all interfaces. Deleted pages release their aliases, remain visible in trash, can be restored under an alternate alias after a conflict, and are purged only through an explicit permanent operation.

Version 0.5 adds arbitrary file attachments stored by SHA-256 with SQLite metadata. Safe raster images can render inline; active formats download by default. Associations survive soft deletion, deduplicated blobs are removed only when unreferenced, and MCP exchanges metadata and REST URLs rather than base64 content.

Version 0.6 adds draft, published, and archived states; typed scalar custom properties; optional parent relationships; breadcrumbs; and a tree view. Published pages remain the default for navigation and search, while direct URLs can read every state. Advanced metadata participates in revisions, filters, full-text indexing, REST, CLI, and MCP.

Version 0.7 adds individual Markdown import/export with generated YAML front matter and collision-safe aliases. Complete streaming `tar.gz` exports contain active pages, trash, revision snapshots, deduplicated attachment blobs, and a versioned JSON manifest. Web, REST, CLI, and MCP expose the transfer workflows; attachment URLs in Markdown remain unchanged.

Version 0.8 adds a versioned OpenAPI 3.1 contract for every `/api/v1` operation, including Bearer authentication, structured errors, filters, and binary transfers. Authenticated clients can retrieve it from `/api/v1/openapi.json`, the trusted web UI links to a public local copy, and automated tests validate the schema and unique operation IDs. Version 0.8.1 adds an offline Swagger UI at `/api-docs`; its assets are embedded in the executable and its Authorize flow supports the generated Bearer token.

## Roadmap

The following decisions describe the remaining product vision and do not expand the original MVP scope.

### Content and navigation

- advanced preview and side-by-side editing;
- richer navigation beyond the page tree and breadcrumbs.

### Files and portability

- complete logical archive restore and migration workflows.

### Interfaces and operation

- MCP statistics tools;
- `nwp service install` for a systemd user unit;
- native database backup and restore workflows.
