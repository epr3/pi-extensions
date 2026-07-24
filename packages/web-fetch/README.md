# web_fetch — Fetch URLs and extract Markdown (Pi extension, TypeScript)

Adds a `web_fetch` tool that fetches URLs and extracts readable content as Markdown.
Supports HTML pages (article extraction + Markdown conversion), PDF documents (text
extraction with page bounds), plain-text pass-through, and automatic fallback to
Jina Reader for JavaScript-rendered or extraction-resistant HTML pages.

```
web_fetch({ url: "https://example.com/article" })
```

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

You should see extracted content as Markdown.

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
| Valid HTML page                                      | Extracted article content as Markdown, with title and source                |
| PDF document (application/pdf or URL ending in .pdf) | Text extracted from PDF, with page count; truncated at 50 pages with notice |
| PDF exceeding 10MB                                   | Error with byte counts                                                      |
| PDF with no extractable text (compressed/scanned)    | Clear error suggesting the file may need OCR                                |
| JavaScript-heavy HTML page (short extraction)        | Automatic Jina Reader fallback for better markdown                          |
| Plain text file                                      | Content passes through with source URL                                      |
| Invalid URL                                          | Clear error message                                                         |
| HTTP error (4xx/5xx)                                 | Error with status code                                                      |
| Binary content type (images, audio, video, archives) | Error with content-type explanation; PDFs are handled, not rejected         |
| Response exceeds size cap                            | Error with byte counts                                                      |
| Request timeout (30s normal, 15s fallback)           | Timeout error                                                               |
| Redirects                                            | Followed automatically                                                      |

## PDF extraction

- **Detection**: By `Content-Type: application/pdf` header, or URL ending in `.pdf` (case-insensitive).
- **Size limit**: PDFs up to **10MB** are fetched (vs 512KB for HTML/text).
- **Page limit**: Up to **50 pages** are extracted. Longer PDFs include a truncation notice in the returned text.
- **Extraction**: Uses a built-in text extractor that parses PDF text objects (`BT...ET` blocks). Works well for text-based PDFs. Compressed or scanned PDFs may not extract — the tool reports a clear error when no text is found.
- **When to try another source**: If a PDF fails to extract (e.g., scanned document, complex formatting), try finding an HTML version of the same content, or use a dedicated PDF-to-text service.

## Jina Reader fallback

For HTML pages that appear to be JavaScript-rendered or extraction-resistant
(extracted content under 100 characters, or an extraction warning is produced),
the tool automatically attempts a Jina Reader fallback by fetching the URL
through `https://r.jina.ai/<url>`.

- **Success**: Returns clean Markdown from Jina with `[Fallback]` source tag.
- **Failure**: Falls back silently to the original extraction with an extraction
  warning — the model still gets the best available content.
- **No live Jina dependency**: The fallback is attempted with a short 15s timeout
  and never blocks the overall fetch indefinitely.
- **When to try another source**: If Jina fallback also produces poor results,
  consider finding an alternative URL known to serve static HTML or try the
  site's `/llms.txt` if available.

## Architecture

```
packages/web-fetch/
├── index.ts      # Extension entry: registers web_fetch tool
├── fetch.ts      # URL validation, fetch logic, content-type detection,
│                 # PDF extraction, Jina fallback, HTML extraction,
│                 # Markdown conversion
├── render.ts     # TUI rendering for call/result rows
├── package.json
├── tsconfig.json
└── README.md
```

- `fetch.ts` exports pure functions (`validateUrl`, `isBinaryContentType`,
  `isHtmlContentType`, `isTextContentType`, `isPdfContentType`,
  `normalizeContentType`, `extractHtmlContent`, `htmlToMarkdown`,
  `processPlainText`, `extractPdfContent`, `defaultPdfExtractFn`) and IO
  functions (`fetchUrl`, `tryJinaFallback`).
- `fetchUrl` accepts an optional `fetchFn` parameter for testability (no live
  web calls in tests). PDF responses automatically get a larger size cap (10MB).
- `extractPdfContent` accepts an optional `extractPdfFn` for injecting a custom
  PDF parser in tests.
- `tryJinaFallback` uses the same injectable `fetchFn`, returning `null` on any
  failure so callers can degrade gracefully.
- `extractHtmlContent` uses heuristic selectors to find the main content area
  (article > main > .content > body), strips chrome elements (scripts, styles,
  nav, header, footer, aside), and converts to Markdown.
- `htmlToMarkdown` handles headings, paragraphs, links, bold, italic, inline
  code, code blocks, ordered/unordered lists, blockquotes, horizontal rules,
  images, and line breaks.
- `index.ts` wires the tool using Pi's `ExtensionAPI.registerTool` with the
  dual-result contract (stable `content` text for the model, structured `details`
  for renderers). Routes PDFs to PDF extraction, HTML to HTML extraction with
  optional Jina fallback, and plain text to pass-through.
- `render.ts` exports `renderWebFetchCall` and `renderWebFetchResult` for
  compact/expanded TUI rendering. Shows `[PDF]` and `[Fallback]` badges in
  collapsed mode, and page count/truncation info in expanded mode.

## Tests

Tests live in `tests/web-fetch-contract.test.ts` and
`tests/web-fetch-rendering.test.ts`. They cover:

- Tool metadata and parameter schema
- URL validation (valid, invalid, missing protocol, empty)
- Content-type detection (HTML, text, binary, PDF, edge cases)
- PDF detection by content-type and URL
- PDF extraction (basic, injected, empty, non-PDF, page truncation, unparseable)
- PDF bounds (page limit truncation, PDF-specific size cap, oversized reject)
- Jina Reader fallback (success, HTTP error, network error)
- Fetch with mocked responses (success HTML, success text, PDF, HTTP error,
  oversized, timeout, binary content type)
- HTML extraction and Markdown conversion
- Short/incomplete extraction warnings
- Error message quality for each failure path
- Structured details shape
- Call and result rendering (collapsed and expanded)
- PDF and fallback badges in rendering
- Page count and truncation in expanded PDF rendering

Run with:

```bash
npx tsx tests/web-fetch-contract.test.ts
npx tsx tests/web-fetch-rendering.test.ts
```

All tests use mocked fetches and never require live network access, PDF
libraries, or Jina availability.