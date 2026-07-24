# Pi Extensions — web-search

Domain language for the `packages/web-search` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`.

## Language

**Web Search Extension package**: Runnable Pi `ExtensionAPI` module under `packages/web-search` whose default export registers the `web_search` research discovery tool.
_Avoid_: Search package, web search plugin, Google extension.

**Search query composition**: Assembly of base query text, exact-phrase inclusions, excluded terms, and optional site restriction into a Google Custom Search query.
_Avoid_: Query building, prompt search, search string formatting.

**Search credentials**: Google Custom Search API key and search-engine ID resolved from environment variables or the Pi agent auth file.
_Avoid_: Auth config, Google secrets, API settings.

## Relationships

- **Web Search Extension package** owns **Search query composition** for `web_search` requests.
- **Search credentials** are required for live discovery but not for pure formatting behavior.
- **Web Search Extension package** remains separate from **Web Fetch Extension package** so discovery and retrieval can evolve independently.

## Example dialogue

> **Dev:** "Should `web_search` extract the result pages too?"
> **Domain expert:** "No — **Web Search Extension package** discovers URLs; **Web Fetch Extension package** retrieves and extracts them."

## Flagged ambiguities

- "web search package" could mean a generic search helper; resolved: use **Web Search Extension package** for the runnable Pi extension.