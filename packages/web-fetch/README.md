# web_fetch — Fetch URLs, extract readable source (Pi extension, TypeScript)

Adds a `web_fetch` tool that fetches URLs and extracts readable content as a
**Readable artifact**: a session-owned local Markdown/plain-text file with the
converted source. Supports HTML pages (Markdown conversion), PDF documents
(text extraction with page bounds), and plain-text/Markdown pass-through.

```
web_fetch({ url: "https://example.com/article" })
```

> This is an intermediate release: the tool still returns converted source
> inline and takes only a `url`. Prompt-directed AI extraction is a planned
> follow-up that changes this contract.

## Setup

### 1. Load the extension

Add the absolute path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["...existing paths...", "/path/to/pi-extensions/main/packages/web-fetch"]
}
```

### 2. Verify

Start a Pi session and run:

```
web_fetch({ url: "https://example.com" })
```

You should see extracted content as Markdown and an `Artifact:` path.

## Usage

### Tool parameters

| Parameter | Type   | Required | Description                  |
| --------- | ------ | -------- | ---------------------------- |
| `url`     | string | yes      | The URL to fetch and extract |

### Examples

```typescript
// Fetch an article
web_fetch({ url: "https://en.wikipedia.org/wiki/Markdown" });

// Fetch a PDF document
web_fetch({ url: "https://example.com/whitepaper.pdf" });

// Fetch plain-text content
web_fetch({ url: "https://example.com/robots.txt" });
```

## Behavior

| Scenario                                             | Result                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Valid HTML page                                      | Converted Markdown inline + a `.md` Readable artifact                        |
| PDF document (application/pdf or URL ending in .pdf) | Text extracted from PDF, with page count; truncated at 50 pages with notice  |
| PDF exceeding 10MB                                   | Error with byte counts                                                       |
| PDF with no extractable text (compressed/scanned)    | Clear error suggesting the file may need OCR                                 |
| Plain text / Markdown file                           | Content passes through as a `.txt` Readable artifact                         |
| Invalid URL, HTTP error (4xx/5xx), timeout           | Clear error message; nothing is written to disk                              |
| Binary content type (images, audio, video, archives) | Error with content-type explanation; PDFs are handled, not rejected          |
| Response exceeds size cap (512 KiB ordinary, 10 MiB PDF) | Error with byte counts; partial downloads are removed                   |
| JavaScript-only / unextractable page                 | Actionable error — **no** alternate-service (Jina/browser) fallback          |
| Redirects                                            | Followed automatically                                                       |

## Readable artifacts

Every successful call also writes a Readable artifact file with the converted
source (not the inline headers), and returns its **absolute path** in both the
plain-text result and the structured `details`:

```
Source: https://example.com/article
Artifact: /tmp/pi-web-fetch/<session>/<run>/<call>-artifact.md

<converted source>
```

- **Session lifetime**: artifacts belong to the creating session. They are
  deleted when you leave, replace, fork, or quit that session. Navigation
  within the same session keeps them, and a reload keeps them for the
  continuing session.
- **Old transcripts**: a path from an earlier session becomes stale once that
  session ends. **Refetch the URL** to regenerate the artifact — resuming a
  session does not restore deleted source files.
- **Completeness**: for PDFs over the page limit, the result and `details`
  report a partial artifact (`artifactComplete: false`). The path is published
  only after the file is finalized; failed or cancelled calls never leave
  usable files behind.
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
├── index.ts      # Extension entry: registers web_fetch, lifecycle hooks
├── fetch.ts      # URL validation, fetch logic, content-type detection,
│                 # streaming sink download, PDF extraction, HTML→Markdown
├── storage.ts    # Disk-backed downloads, session/run ownership, Readable
│                 # artifacts, artifact cleanup
├── runtime.ts    # Test-only runtime knobs (mocked HTTP/PDF/storage root)
├── render.ts     # TUI rendering for call/result rows
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
- `storage.ts` owns the private temporary area: one run per extension load,
  session-keyed directories, an on-disk ownership record (kept for crash
  cleanup in a later slice), and idempotent cleanup on session leave.
- `index.ts` wires the tool using Pi's `ExtensionAPI.registerTool` with the
  dual-result contract (stable `content` text for the model, structured
  `details` for renderers), and subscribes to `session_start` /
  `session_shutdown` so artifacts follow session lifetime.
- `render.ts` exports `renderWebFetchCall` and `renderWebFetchResult` for
  compact/expanded TUI rendering, showing the artifact path, PDF page
  count/truncation, and completeness warnings.

## Tests

Tests live in `__tests__/contract.test.ts` and `__tests__/rendering.test.ts`
and run through the registered tool via a fake Pi API, including lifecycle
events:

- Tool metadata, parameter schema, and lifecycle registration
- URL validation, content-type detection, PDF extraction, Markdown conversion
- Disk-backed download (streaming sink), size caps, timeouts
- Successful HTML/text/PDF calls produce finalized artifacts with absolute
  paths; PDF truncation is reported as a partial artifact
- Failures (HTTP, binary, caps, unusable extraction) publish nothing and leave
  no files; no alternate-service requests are ever issued
- Session lifecycle: leave/replace/fork/shutdown remove artifacts; reload and
  in-session navigation keep them; cleanup is idempotent
- Cancellation and ownership: pending work released after its owner left
  cannot recreate files or publish stale artifact paths; concurrent calls get
  distinct artifacts; concurrent sessions keep separate owned areas
- Cleanup failure observability with retry
- Call/result rendering (collapsed and expanded), artifact and warning display

Run with:

```bash
pnpm test
```

All tests use mocked fetches, isolated real temporary directories, and never
require live network access, PDF libraries, Jina, or real user artifacts.