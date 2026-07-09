# Pi Extensions — web-fetch

Domain language for the `packages/web-fetch` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`.

## Language

**Web Fetch Extension package**: Runnable Pi `ExtensionAPI` module under `packages/web-fetch` whose default export registers the `web_fetch` research retrieval tool.
_Avoid_: Fetch package, web fetch plugin, browser extension.

**Readable content extraction**: Conversion of a fetched HTML, PDF, or plain-text response into model-consumable Markdown or text with page chrome and unsafe excess removed.
_Avoid_: Scraping, page parsing, browser rendering.

**Jina fallback**: Secondary retrieval path through Jina Reader used only when direct HTML extraction is too short or incomplete.
_Avoid_: Proxy fetch, alternate browser, search fallback.

## Relationships

- **Web Fetch Extension package** owns **Readable content extraction** for `web_fetch` results.
- **Jina fallback** is a fallback for **Readable content extraction**, not the primary fetch path.
- **Web Fetch Extension package** remains separate from **Web Search Extension package** so retrieval and discovery can evolve independently.

## Example dialogue

> **Dev:** "Should `web_fetch` call a search API when a page extracts poorly?"
> **Domain expert:** "No — use **Jina fallback** for extraction failures; discovery belongs to the **Web Search Extension package**."

## Flagged ambiguities

- "web fetch package" could mean a generic HTTP helper; resolved: use **Web Fetch Extension package** for the runnable Pi extension.
