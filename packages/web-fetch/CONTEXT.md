# Pi Extensions — web-fetch

Domain language for the `packages/web-fetch` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`.

## Language

**Web Fetch Extension package**: Runnable Pi `ExtensionAPI` module under `packages/web-fetch` whose default export registers the `web_fetch` research retrieval tool.
_Avoid_: Fetch package, web fetch plugin, browser extension.

**Readable content extraction**: Conversion of a fetched HTML, PDF, or plain-text response into model-consumable Markdown or text, distinct from prompt-directed AI extraction.
_Avoid_: Scraping, page parsing, browser rendering.

**Whole-page Markdown conversion**: Conversion of the full HTML document into Markdown with scripts and styles removed while preserving content structure, tables, code, and links rather than selecting an article.
_Avoid_: Article extraction, main-content extraction, Readability extraction.

**AI extraction**: Prompt-directed interpretation of retrieved Markdown or text by a model, distinct from document conversion.
_Avoid_: Markdown conversion, readable content extraction.

**Extraction model**: The explicitly configured provider/model used for AI extraction independently of the calling session's model.
_Avoid_: Subagent, current model, automatic fast model.

**Extraction prompt**: The required caller instruction specifying what the AI extraction should find in the retrieved document.
_Avoid_: Search query, URL description.

**Disk-backed download**: A retrieved response body stored incrementally in a temporary file rather than accumulated in memory.
_Avoid_: Unlimited fetch, streamed extraction.

**Streaming HTML extraction**: Readable content extraction that scans HTML incrementally and writes its result incrementally without retaining the complete source or output in memory.
_Avoid_: Chunk-prefix extraction, disk-backed download.

**Readable artifact**: A session-lifetime local Markdown or text file containing the converted source document for verification beyond the AI extraction answer.
_Avoid_: Raw download, summary, inline preview.

**Artifact cleanup**: Automatic reclamation of session-owned readable artifacts and temporary downloads after their useful lifetime or an abandoned run.
_Avoid_: Manual deletion, permanent cache.

## Relationships

- **Web Fetch Extension package** owns **Readable content extraction** for `web_fetch` results.
- **Readable content extraction** supplies Markdown or text to **AI extraction**, which uses an **Extraction prompt** and an **Extraction model**.
- A **Disk-backed download** supplies source bytes to **Readable content extraction**; it does not by itself bound extraction memory.
- **Streaming HTML extraction** is the HTML-specific form of **Readable content extraction**, distinct from PDF extraction.
- **Readable content extraction** produces a **Readable artifact**; **AI extraction** may consume only a bounded prefix of that artifact.
- Each **Readable artifact** belongs to a session and is reclaimed by **Artifact cleanup**.
- **Web Fetch Extension package** remains separate from **Web Search Extension package** so retrieval and discovery can evolve independently.

## Example dialogue

> **Dev:** "Is the AI extraction answer the converted page?"
> **Domain expert:** "No — **Whole-page Markdown conversion** preserves source structure; **AI extraction** returns only what the **Extraction prompt** asks the **Extraction model** to find."

## Flagged ambiguities

- "web fetch package" could mean a generic HTTP helper; resolved: use **Web Fetch Extension package** for the runnable Pi extension.