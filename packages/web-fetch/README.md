# web_fetch — Prompt-directed URL extraction (Pi extension, TypeScript)

Adds a `web_fetch` tool that fetches a URL and returns a prompt-directed answer
from an explicitly configured Extraction model, together with a **Readable
artifact**: a session-owned local Markdown/plain-text file containing the full
converted source. Supports HTML pages (Markdown conversion), PDF documents
(text extraction with page bounds), and plain-text/Markdown pass-through.

```typescript
web_fetch({
  url: "https://example.com/article",
  prompt: "What are the main claims?",
});
```

## Setup

### 1. Load the extension

Add the absolute path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["...existing paths...", "/path/to/pi-extensions/main/packages/web-fetch"]
}
```

### 2. Configure an Extraction model

Add a `webFetch.extractionModel` section to `~/.pi/agent/settings.json` (global)
or `.pi/settings.json` (project override):

```json
{
  "webFetch": {
    "extractionModel": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5"
    }
  }
}
```

Provider and model identifiers are resolved through Pi's model registry and use
Pi's existing credentials. There is no automatic model selection or hardcoded
default.

### 3. Verify

Start a Pi session and run:

```typescript
web_fetch({ url: "https://example.com", prompt: "Summarize this page" });
```

You should see an AI extraction answer and an `Artifact:` path to the converted
source.

## Usage

### Tool parameters

| Parameter | Type   | Required | Description                                             |
| --------- | ------ | -------- | ------------------------------------------------------- |
| `url`     | string | yes      | The URL to fetch and extract content from               |
| `prompt`  | string | yes      | What the Extraction model should answer from the source |

Both parameters must be non-empty strings after trimming. Missing or blank
prompts are rejected with a clear error — there is no implicit summary mode.

### Examples

```typescript
// Ask a specific question about an article
web_fetch({
  url: "https://en.wikipedia.org/wiki/Markdown",
  prompt: "List the standard Markdown syntax elements",
});

// Extract information from a PDF document
web_fetch({
  url: "https://example.com/whitepaper.pdf",
  prompt: "What is the conclusion?",
});

// Query plain-text content
web_fetch({
  url: "https://example.com/robots.txt",
  prompt: "Which user agents are allowed?",
});
```

## Behavior

| Scenario                                                 | Result                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Valid HTML / text / Markdown / supported PDF             | AI extraction answer + finalized Readable artifact path                                         |
| Missing or blank `prompt`                                | Clear error before any fetch                                                                    |
| Extraction model not configured                          | Actionable error pointing to `webFetch.extractionModel` settings                                |
| Configured model unavailable or missing credentials      | Actionable error before expensive retrieval                                                     |
| Model provider fails after successful conversion         | Error includes the completed artifact path and source metadata                                  |
| Source larger than the model input budget                | Model sees only a leading portion; tool warns about partial evidence; artifact remains complete |
| PDF document (application/pdf or URL ending in .pdf)     | Text extracted with page count; truncated at 50 pages with notice                               |
| PDF exceeding 10MB                                       | Error with byte counts                                                                          |
| PDF with no extractable text (compressed/scanned)        | Clear error suggesting the file may need OCR                                                    |
| Plain text / Markdown file                               | Content passes through as a `.txt` Readable artifact                                            |
| Invalid URL, HTTP error (4xx/5xx), timeout               | Clear error message; nothing is written to disk                                                 |
| Binary content type (images, audio, video, archives)     | Error with content-type explanation; PDFs are handled, not rejected                             |
| Response exceeds size cap (512 KiB ordinary, 10 MiB PDF) | Error with byte counts; partial downloads are removed                                           |
| JavaScript-only / unextractable page                     | Actionable error — **no** alternate-service (Jina/browser) fallback                             |
| Process crash leaves abandoned artifacts                 | Swept on next extension init/fetch; live/ambiguous owners preserved                             |
| Redirects                                                | Followed automatically                                                                          |

## AI extraction

- **Required prompt**: every call must supply a `prompt`. The prompt is sent to
  the configured Extraction model together with the converted source as
  untrusted evidence.
- **Explicit model**: the Extraction model is configured in
  `webFetch.extractionModel.provider` and `webFetch.extractionModel.model`.
  Project settings override global settings. There is no implicit current-model
  selection or hardcoded active default.
- **One direct completion**: the tool makes a single tool-free model completion
  through Pi's model registry, using Pi credentials. No subagent or tool loop is
  used.
- **Budget policy**: input, output, and completion time are bounded:
  - `outputTokens` defaults to 1024 and is capped at the model's `maxTokens`.
  - `instructionTokens` reserves 500 tokens for the system prompt and framing.
  - `charsPerToken` defaults to 4, a conservative character-to-token estimate
    used when no tokenizer is exposed.
  - `completionTimeoutMs` defaults to 120 seconds.
  - If the prompt alone exceeds the model's context window after reserving
    instructions and output, the request fails before an unchecked completion.
  - If the converted source exceeds the remaining input budget, only a leading
    portion is sent to the model. The full artifact is still finalized on disk.
- **Partial-evidence warning**: when the model input is truncated, the tool
  reports it independently of the model. The artifact may still be complete.
- **Usage accounting**: model-reported usage is returned on the tool result,
  including for error outcomes when the provider supplies usage.

## Readable artifacts

Every successful conversion writes a Readable artifact file with the converted
source (not the AI answer or inline headers), and returns its **absolute path**
in both the plain-text result and the structured `details`:

```
Source: https://example.com/article
Artifact: /tmp/pi-web-fetch/<session>/<run>/<call>-artifact.md
Answer:

<AI extraction answer>
```

- **Session lifetime**: artifacts belong to the creating session. They are
  deleted when you leave, replace, fork, or quit that session. Navigation
  within the same session keeps them, and a reload keeps them for the
  continuing session.
- **Graceful cleanup vs crash reclamation**: when you leave, replace, fork, or
  quit a session, the extension removes the session's owned files immediately.
  If the owning process crashes instead, those files are reclaimed the next
  time the extension initializes or performs a fetch — there is no
  always-running cleanup service. Live and ambiguously owned sessions are never
  deleted.
- **Old transcripts**: a path from an earlier session becomes stale once that
  session ends. **Refetch the URL** to regenerate the artifact — resuming a
  session does not restore deleted source files.
- **Completeness**: for PDFs over the page limit, the result and `details`
  report a partial artifact (`artifactComplete: false`). Model-input truncation
  is reported separately (`modelInputTruncated: true`) and does not make the
  artifact partial. The path is published only after the file is finalized;
  failed or cancelled calls never leave usable files behind.
- **Model-stage failures**: if AI extraction fails after conversion succeeds,
  the error includes the still-readable artifact path and source metadata. The
  completed artifact remains available until the session is cleaned up.
- Raw downloads are written incrementally to a private temporary area
  (`os.tmpdir()/pi-web-fetch`, keyed by session and run) and removed once
  conversion finishes; incomplete downloads and artifacts are removed on
  failure or cancellation.

## PDF extraction

- **Detection**: By `Content-Type: application/pdf` header, or URL ending in `.pdf` (case-insensitive).
- **Size limit**: PDFs up to **10MB** are fetched (vs 512KB for HTML/text).
- **Page limit**: Up to **50 pages** are extracted. Longer PDFs produce a
  clearly marked partial artifact with a truncation notice.
- **Extraction**: Uses a built-in text extractor that parses PDF text objects
  (`BT...ET` blocks). Works well for text-based PDFs. Compressed or scanned
  PDFs may not extract — the tool reports a clear error when no text is found.
- **When to try another source**: If a PDF fails to extract (e.g., scanned
  document, complex formatting), try finding an HTML version of the same
  content, or use a dedicated PDF-to-text service.

## Architecture

```
packages/web-fetch/
├── index.ts       # Extension entry: registers web_fetch, lifecycle hooks
├── fetch.ts       # URL validation, fetch logic, content-type detection,
│                  # streaming sink download, PDF extraction, HTML→Markdown
├── extraction.ts  # AI extraction: model resolution, budget, completion
├── settings.ts    # Read webFetch.extractionModel from global/project settings
├── storage.ts     # Disk-backed downloads, session/run ownership, Readable
│                  # artifacts, artifact cleanup (normal + crash sweep)
├── liveness.ts    # Process identity / liveness policy for abandoned-run detection
├── runtime.ts     # Test-only runtime knobs (mocked HTTP/PDF/storage/model/budget)
├── render.ts      # TUI rendering for call/result rows
├── package.json
├── tsconfig.json
└── README.md
```

- `fetch.ts` exports pure functions (`validateUrl`, `isBinaryContentType`,
  `isHtmlContentType`, `isTextContentType`, `isPdfContentType`,
  `normalizeContentType`, `extractHtmlContent`, `htmlToMarkdown`,
  `processPlainText`, `extractPdfContent`, `defaultPdfExtractFn`) and IO
  functions (`fetchUrl`). `fetchUrl` accepts an optional `sink` to stream body
  bytes incrementally (Disk-backed download) instead of accumulating them, and
  an optional `fetchFn`/`extractPdfFn` for testability.
- `settings.ts` reads the `webFetch.extractionModel` section from
  `~/.pi/agent/settings.json` and `.pi/settings.json`, with project overriding
  global.
- `extraction.ts` resolves the configured model through Pi's registry, computes
  a bounded input budget from the model's context window, reads only a leading
  prefix of the artifact when over budget, and makes one tool-free model
  completion. Returns the answer, usage, and truncation metadata.
- `storage.ts` owns the private temporary area: one run per extension load,
  session-keyed directories, an on-disk ownership record, idempotent cleanup
  on session leave, and crash/abandoned-run sweep at init and before each
  fetch. Deletion stays inside the extension-owned area; live and ambiguous
  owners are preserved.
- `liveness.ts` defines the process-identity policy used by the sweep. The
  default checker treats the current process as live and remote pids as dead
  only when they no longer exist or their start time differs from the
  ownership record. Uninterpretable owners are classified as ambiguous and
  preserved. On Windows the start-time check is unavailable, so remote pids
  are always treated as ambiguous.
- `index.ts` wires the tool using Pi's `ExtensionAPI.registerTool` with the
  dual-result contract (stable `content` text for the model, structured
  `details` for renderers), and subscribes to `session_start` /
  `session_shutdown` so artifacts follow session lifetime.
- `render.ts` exports `renderWebFetchCall` and `renderWebFetchResult` for
  compact/expanded TUI rendering, showing the answer, artifact path, source
  length, PDF page count/truncation, and model-input truncation warnings.

## Tests

Tests live in `__tests__/contract.test.ts` and `__tests__/rendering.test.ts`
and run through the registered tool via a fake Pi API, including lifecycle
events:

- Tool metadata, parameter schema, and lifecycle registration
- URL validation, content-type detection, PDF extraction, Markdown conversion
- Disk-backed download (streaming sink), size caps, timeouts
- Required `url` and `prompt`; missing/blank prompts are rejected
- Extraction model configuration errors: missing settings, unavailable model,
  missing credentials
- Successful HTML/text/PDF calls return an AI extraction answer and a
  finalized artifact; PDF truncation is reported as a partial artifact
- Source-as-evidence separation: the artifact contains converted source, not
  the answer; the model request includes prompt + evidence with no tools
- Budget policy: oversized prompts fail before completion; large sources send
  only a leading portion to the model and report partial evidence; the
  artifact remains complete
- Model failures after conversion include the artifact path; usage is reported
  when available
- Model-call cancellation/session-change races: leaving the owning session
  aborts in-flight extraction and prevents stale artifact publication
- Failures (HTTP, binary, caps, unusable extraction) publish nothing and leave
  no files; no alternate-service requests are ever issued
- Session lifecycle: leave/replace/fork/shutdown remove artifacts; reload and
  in-session navigation keep them; cleanup is idempotent
- Cancellation and ownership: pending work released after its owner left
  cannot recreate files or publish stale artifact paths; concurrent calls get
  distinct artifacts; concurrent sessions keep separate owned areas
- Cleanup failure observability with retry
- Crash/abandoned-run cleanup: abandoned runs are swept, live/ambiguous owners
  are preserved, PID reuse is handled conservatively, and cleanup failures are
  retried on later fetches
- Call/result rendering (collapsed and expanded), answer/source separation,
  artifact and warning display

Run with:

```bash
pnpm test
```

All tests use mocked fetches, mocked model completions, isolated real
temporary directories, and never require live network access, model services,
PDF libraries, Jina, real credentials, or real user artifacts.