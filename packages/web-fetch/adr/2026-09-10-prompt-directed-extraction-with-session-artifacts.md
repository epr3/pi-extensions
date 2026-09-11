# Prompt-directed extraction with session-owned source artifacts

Status: accepted design; implementation in progress (disk-backed downloads,
session-owned artifacts, and streaming whole-page HTML conversion landed;
AI extraction and crash-safe cleanup in follow-up tickets).

`web_fetch` will require `{ url, prompt }` and return a prompt-directed **AI extraction** answer plus a **Readable artifact** path, rather than inline source Markdown. This deliberately breaks URL-only calls and introduces a model-call dependency: an explicitly configured provider/model uses Pi's existing credentials, independently of the session model, with usage included in session accounting. Missing configuration, credentials, or failed extraction produces an actionable error, not a silent model substitution; a completed source artifact remains available through its path when AI extraction fails. The plain-text `content` plus structured `details` contract remains, although the meaning of the text changes from source document to answer.

HTML uses **Disk-backed download** and **Streaming HTML extraction** for cleaned **Whole-page Markdown conversion**, preserving document structure, tables, code, and links while removing scripts and styles. It does not select a single article or retain the complete HTML or converted output in memory. Conversion continues to the readable artifact within source limits even after the extraction model's input budget is filled. AI extraction receives only a bounded prefix when necessary, and a tool-generated warning explicitly identifies partial evidence; artifact completeness and model-input truncation are distinct. Artifacts enable verification and follow-up reading without putting the whole source in the calling model's context.

Direct HTML, plain text, and the existing limited PDF extraction remain supported. PDF parsing is not upgraded and OCR is out of scope. Jina fallback is removed: JS-only, blocked, and unextractable pages receive actionable failures rather than third-party retrieval. Existing network limits and behavior remain the baseline; this is not a broader Claude Code parity project. The whole-page policy and removal of Jina supersede those parts of [Define Web Tool Boundaries](../../../docs/adr/2026-06-30-web-tool-boundaries.md); search and fetch remain separate packages.

## Artifact lifetime and cleanup

- Readable Markdown/text artifacts belong to the session that created them and are deleted when leaving that session, including session replacement/switch and shutdown; they are not a durable cache or a promise of availability after resume.
- Raw temporary downloads are deleted after conversion. Failure and cancellation remove incomplete downloads and artifacts; a completed readable artifact can survive AI extraction failure until session cleanup.
- Abandoned files from crashes are swept automatically with ownership-aware checks that must not delete another live session's files. Graceful shutdown alone is insufficient.
- Session-event behavior and crash ownership detection must be verified against Pi during implementation; these are cleanup requirements, not claims that the current extension already satisfies them.

## Trade-offs

This adopts Claude Code's conversion-plus-prompted-answer behavior, not exact implementation parity: [its documented WebFetch behavior](https://code.claude.com/docs/en/tools-reference.md#webfetch-tool-behavior) is intentionally lossy. Keeping a readable source artifact provides an escape hatch for omitted evidence, at the cost of streaming conversion, disk ownership, and automatic cleanup. Whole-page conversion preserves reference material that article extraction can drop, but spends more of the extraction model's bounded input on navigation and other non-article content. Removing Jina sacrifices fallback coverage for direct-only retrieval and predictable source handling.