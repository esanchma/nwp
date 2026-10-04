# Design decisions

Current decisions that help maintain nwp. Code and tests take precedence for exact behavior.

## Product and experience

- nwp is a local personal knowledge base and enriched bookmark collection oriented toward retrieval, not merely a page editor.
- User flow and interface readability take priority over expanding peripheral features. Progressive enhancements must not replace the basic no-JavaScript flow where one exists.
- Capture pages integrate extracted content and local resources. They must not force the user to switch to a technical view to read an article.
- Enriched embeds are an exception limited to YouTube. They are local by default and load only after explicit user interaction. There is no generic embed or oEmbed framework.

## Data and editing

- SQLite is the metadata source of truth; pages use GFM Markdown and wikilinks.
- Aliases are editable, ASCII, and case-insensitive. Pages can be `draft`, `published`, or `archived`.
- Every significant change creates a revision. Trash is recoverable and purging is explicit.
- Attachments, document originals, snapshots, and capture resources are deduplicated by SHA-256.
- Automated updates preserve human changes and can mark a page for review instead of overwriting it.

## Processing and retrieval

- Long-running operations are represented as durable SQLite jobs with a lease, heartbeat, retry, and cancellation.
- Hybrid search combines FTS5 and `sqlite-vec` through rank fusion. If the semantic part is unavailable, the application safely offers lexical search.
- `bge-m3` is the default embedding model. Changing any parameter that defines a vector generation requires reindexing.
- RAG answers accept only citations that resolve to application-retrieved evidence. General knowledge, if enabled, is returned separately from the evidence-backed answer.
- Generated tags have provenance separate from human and operational tags. Removing a generated tag creates a suppression that reclassification cannot silently restore.

## External input and security

- Documents and web content are untrusted, even when used for retrieval or generation.
- Native capture transport applies a strict SSRF policy to the target, DNS, IP, and redirects. It never sends credentials.
- Delegated capture through `web-research` is an explicit trust boundary and deliberate dependency. Do not reimplement its extraction or specialized routes within nwp without a clear product reason. nwp retains limits on processes, storage, evidence handling, and safe local images.
- YouTube uses manual or automatic subtitles before Whisper. Only videos without usable subtitles undergo transcription. Whisper's limit derives from duration and has configurable fallback and cap values.
- OCR, semantic extraction, and local generation are optional enhancements. A dependency failure must not destroy or block basic ingestion.

## Operation

- Effective configuration state lives in `src/config.ts`. `README.md` is its public guide and must remain synchronized.
- Complete backups are verifiable, and restoration validates a temporary instance before swapping directories. A real restore takes the instance lock and preserves the token.
- The user systemd service runs the server and workers. It must have an explicit `PATH` when it depends on programs installed outside the paths inherited by systemd.

## When to revisit these decisions

Reconsider a decision when its threat model, an external dependency, the data scale, or user requirements change. Add only durable, costly-to-reverse decisions here, together with tests and public documentation where appropriate. Do not turn this file into a session diary.
