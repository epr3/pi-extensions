# Prompt-directed extraction with session-owned source artifacts

Status: accepted design; implementation in progress (disk-backed downloads,
session-owned artifacts, and library-based whole-page HTML conversion landed;
AI extraction and crash-safe cleanup in follow-up tickets). On 2026-11-06,
`pnpm install --offline --frozen-lockfile` restored this worktree's dependencies,
and the real-Pi `extension-load` smoke then passed all 7 checks on
`pi 1.5.0 (Pi-Bolt 1.1.0, darwin-arm64, JIT off)` with Node `v22.22.3`.
Pi loaded all nine packages, advertised `web_fetch` and `web_search`, settled the
run, and dispatched the probe's startup `session_start` and quit
`session_shutdown` events. This verifies package loading and those observed
session lifecycle hooks only. The scenario does not invoke `web_fetch`, access
the network, or inspect Web Fetch artifact cleanup. The earlier dependency
resolution failure is therefore resolved for this run, but Web Fetch cleanup,
cancellation, crash recovery, and network lifecycle remain unverified. No live-Pi
evidence supports changing the cleanup requirements or claiming that Web Fetch
lifecycle behavior is verified.

`web_fetch` will require `{ url, prompt }` and return a prompt-directed **AI extraction** answer plus a **Readable artifact** path, rather than inline source Markdown. This deliberately breaks URL-only calls and introduces a model-call dependency: an explicitly configured provider/model uses Pi's existing credentials, independently of the session model, with usage included in session accounting. Missing configuration, credentials, or failed extraction produces an actionable error, not a silent model substitution; a completed source artifact remains available through its path when AI extraction fails. The plain-text `content` plus structured `details` contract remains, although the meaning of the text changes from source document to answer.

HTML uses **Disk-backed download** and **Library HTML conversion** (Turndown + jsdom) for cleaned **Whole-page Markdown conversion**, preserving document structure, tables, code, and links while removing scripts and styles. It does not select a single article. Transport streams to disk; conversion holds the capped source and its Markdown in memory — the response cap (512 KiB ordinary, 10 MiB PDF) is the documented memory bound. Conversion continues to the readable artifact within source limits even after the extraction model's input budget is filled. AI extraction receives only a bounded prefix when necessary, and a tool-generated warning explicitly identifies partial evidence; artifact completeness and model-input truncation are distinct. Artifacts enable verification and follow-up reading without putting the whole source in the calling model's context.

Direct HTML, plain text, and the existing limited PDF extraction remain supported. PDF parsing is not upgraded and OCR is out of scope. Jina fallback is removed: JS-only, blocked, and unextractable pages receive actionable failures rather than third-party retrieval. Existing network limits and behavior remain the baseline; this is not a broader Claude Code parity project. The whole-page policy and removal of Jina supersede those parts of [Define Web Tool Boundaries](../../../docs/adr/2026-06-30-web-tool-boundaries.md); search and fetch remain separate packages.

## Artifact lifetime and cleanup

- Readable Markdown/text artifacts belong to the session that created them and are deleted when leaving that session, including session replacement/switch and shutdown; they are not a durable cache or a promise of availability after resume.
- Raw temporary downloads are deleted after conversion. Failure and cancellation remove incomplete downloads and artifacts; a completed readable artifact can survive AI extraction failure until session cleanup.
- Abandoned files from crashes are swept automatically with ownership-aware checks that must not delete another live session's files. Graceful shutdown alone is insufficient.
- Session-event behavior and crash ownership detection must be verified against Pi during implementation; these are cleanup requirements, not claims that the current extension already satisfies them.

## Trade-offs

This adopts Claude Code's conversion-plus-prompted-answer behavior, not exact implementation parity: [its documented WebFetch behavior](https://code.claude.com/docs/en/tools-reference.md#webfetch-tool-behavior) is intentionally lossy. Keeping a readable source artifact provides an escape hatch for omitted evidence, at the cost of capped in-memory conversion, disk ownership, and automatic cleanup. Whole-page conversion preserves reference material that article extraction can drop, but spends more of the extraction model's bounded input on navigation and other non-article content. Removing Jina sacrifices fallback coverage for direct-only retrieval and predictable source handling.

Amended during the structured-fidelity ticket: the hand-rolled streaming converter was replaced by Turndown + jsdom. Rationale: a streaming HTML→Markdown emitter with no ecosystem equivalent had to hand-roll every rich construct (GFM tables, nested list indentation, adaptive code fences, pipe escaping), while the libraries provide battle-tested fidelity. Cost: conversion is no longer incremental — accepted because the response cap already bounds memory and fails before conversion. Streaming now applies to transport only.

Amended during the truthful-PDF-reporting ticket: the result `details` now carry `artifactCompleteness` (`"complete" | "partial" | "unknown"`) instead of `artifactComplete: boolean`, and `truncated` is removed; `pageCount` is present only when an extractor can verify it. This is a deliberate result-details compatibility break: the previous boolean could not express "the extractor cannot verify this", and `truncated` described a 50-page extraction limit that was never enforced. The lightweight regex extractor scans the whole size-capped file, applies no page limit, and claims neither a page count nor completeness (compressed object streams hide the page tree, so a missing count is reported as unknown rather than zero). The 10 MB cap is unchanged, and model-input truncation stays a separate, independently measured claim.