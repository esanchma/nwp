# nwp TODO

Updated after an audit of the repository, documentation, and Pi session summaries. Items are separated by confidence to avoid turning historical hypotheses into requirements.

## P0: current work state

No confirmed P0 work is currently recorded.

## P1: recommended operational verification (confirmed historical pending work)

- [ ] **Complete manual QA for the no-subtitles transcription cycle.** Verify the transition `queued → fetching → transcribing → ready`, cancellation during Whisper, and retry after a forced failure. Confirm that a video with available VTT does not enter `transcribing` or invoke Whisper.
  - Context: the implementation was released in `v0.21.12`; the automatic-subtitle case for capture 34 was verified, but a case genuinely without subtitles remains pending.
  - Completion criterion: record reproducible results and commands in an issue, commit, or operational documentation. No code change is required if it passes.

- [ ] **Review the global capture limit after the Whisper-specific timeout.** Evaluate whether `web_capture.fetch_timeout_seconds = 900` remains necessary or can be reduced without affecting long transcriptions.
  - Completion criterion: justify the value with representative tests and reflect it in configuration or README if it changes.

- [ ] **Review automatic-tagging quality with real content.** Earlier sessions observed overly generic candidates, for example `topic:topic`. Decide whether to tighten the prompt, filter terms, or improve taxonomy governance.
  - Completion criterion: define an explicit policy and add a regression test if behavior changes.

## P2: product proposals, not committed

- [ ] **Streaming or progress for RAG answers.** The current answer is synchronous and preserves a no-JavaScript fallback. Design UX and API only if perceived latency justifies it.
- [ ] **Rendered or authenticated page capture.** This requires an explicit browser, credential, cookie, isolation, and traceability policy. Do not bypass the native transport's SSRF boundary.
- [ ] **Additional enriched navigation.** Tree and breadcrumbs already exist. Define use cases and acceptance criteria before adding more surfaces.
- [ ] **OneDrive/SharePoint synchronization.** Deferred: current document intake uses local, UI, REST, and CLI upload. It needs an identity model, conflict handling, and permissions before implementation.

## Documentation debt

- [ ] Keep this backlog and [`docs/decisions.md`](docs/decisions.md) current when closing a delivery. Record only durable decisions, risks, and reproducible outcomes, not session transcripts.
- [ ] When changing a configuration default, compare `README.md` with `src/config.ts`. The latter is the runtime source of truth.
- [ ] Keep [`docs/documentation-map.md`](docs/documentation-map.md) up to date when creating or removing a development guide.

## Open questions

- Should the project manage the `web-research` code or binary locally? Session records indicate it was a local dependency without Git history, which reduces reproducibility and auditability.
- What level of operational support is wanted for optional dependencies such as Ollama, models, Tesseract, Poppler, and Whisper? Safe degradation is deliberate today; installation, monitoring, and alerts still need a decision.
- Which corpus and metrics represent real usage for rerunning search and RAG benchmarks? Existing results are reproducible smoke benchmarks, not a general guarantee.
