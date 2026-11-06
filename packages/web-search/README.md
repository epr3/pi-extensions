# web_search — Google Custom Search for research workflows (Pi extension, TypeScript)

Adds a `web_search` tool for web discovery in parent-agent and general research workflows through structured Google Custom Search queries. Accepts a base query, exact phrase inclusions, excluded terms, optional site restriction, and optional result count. Credentials resolve from environment variables first, then from `~/.pi/agent/auth/web-search.json`.

```
web_search({ query: "pi coding agent", site: "github.com", count: 3 })
```

## Setup

### 1. Get a Google Custom Search Engine

1. Go to [Google Custom Search](https://programmablesearchengine.google.com/) and create a new search engine.
2. Choose **"Search the entire web"** as the configuration option.
3. Copy your **Search engine ID (cx)**.

### 2. Get a Google API key

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one).
3. Enable the **Custom Search API**.
4. Create an API key under **Credentials**.
5. Copy the **API key**.

### 3. Configure credentials

Either set environment variables:

```bash
export GOOGLE_API_KEY="your-api-key"
export GOOGLE_CSE_ID="your-cse-id"
```

Or create the auth file:

```bash
mkdir -p ~/.pi/agent/auth
cat > ~/.pi/agent/auth/web-search.json <<EOF
{
  "apiKey": "your-api-key",
  "cseId": "your-cse-id"
}
EOF
```

### 4. Load the extension

Add the absolute path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["...existing paths...", "/path/to/pi-extensions/main/packages/web-search"]
}
```

### 5. Verify

Start a Pi session and run:

```
web_search({ query: "test" })
```

You should see search results with numbered titles, URLs, and snippets.

## Usage

### Tool parameters

| Parameter      | Type     | Required | Default | Description                         |
| -------------- | -------- | -------- | ------- | ----------------------------------- |
| `query`        | string   | yes      | —       | The base search query               |
| `exactPhrases` | string[] | no       | []      | Exact phrases to quote in the query |
| `excludeTerms` | string[] | no       | []      | Terms to exclude from results       |
| `site`         | string   | no       | —       | Restrict search to a site/domain    |
| `count`        | integer  | no       | 5       | Number of results (1-10)            |

### Examples

```typescript
// Simple search
web_search({ query: "typescript design patterns" });

// Search with exact phrase
web_search({ query: "pi agent", exactPhrases: ["ExtensionAPI"], count: 3 });

// Search with exclusions and site restriction
web_search({
  query: "web search",
  excludeTerms: ["google", "api"],
  site: "github.com",
});
```

## Behavior

| Scenario                                        | Result                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Results returned                                | Numbered results with title, URL, and snippet, plus structured `details`                          |
| No results                                      | `No results for: <composed query>`                                                                |
| Stalled headers or stalled response body        | Fails after the 15-second deadline with `web_search: Search timed out after 15000ms`              |
| Caller cancels the tool call                    | Fails with `web_search: Search cancelled`, never reported as a timeout                            |
| Network failure (DNS, connection refused, etc.) | Fails with `web_search: Network error: <detail>`                                                  |
| HTTP error from Google CSE                      | Fails with the shaped Google error message                                                        |
| Missing credentials                             | Fails before any request with a setup message naming both environment variables and the auth file |

The deadline covers headers **and** the response body, so discovery cannot hang indefinitely. On timeout, cancellation, or an unreadable body the response body is cancelled and the request aborted so the connection is released.

## Architecture

```
packages/web-search/
├── index.ts      # Extension entry: registers web_search tool
├── search.ts     # Pure query composition, credential resolution, Google CSE API caller, error shaping, result formatting
├── render.ts     # TUI rendering for call/result rows
├── package.json
├── tsconfig.json
└── README.md
```

- `search.ts` exports pure functions (`composeQuery`, `normalizeTerm`, `normalizeSite`, `cleanInput`, `shapeApiError`, `formatSearchResults`) and IO functions (`resolveCredentials`, `searchGoogle`).
- `searchGoogle` accepts optional `{ fetchFn, signal, timeoutMs }` options for testability and caller cancellation (no live web calls in tests).
- `index.ts` wires the tool using Pi's `ExtensionAPI.registerTool` with the dual-result contract (stable `content` text for the model, structured `details` for renderers).
- `render.ts` exports `renderWebSearchCall` and `renderWebSearchResult` for compact/expanded TUI rendering. Collapsed rows report the number of results actually returned (including `no results`), not the requested `count`.

## Google query syntax

`composeQuery` combines exact-phrase inclusions as quote-enclosed phrases and exclusions by prefixing a minus sign. Google's [Custom Search XML results documentation](https://developers.google.com/custom-search/docs/xml_results) documents `-` before a word or phrase to exclude it and quotation marks around a phrase to require that phrase. The API's [`q` parameter reference](https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list) documents the query parameter but does not specify how embedded literal quotation marks are escaped. No escaping behavior is claimed here; inputs containing quotation marks are passed through by the current composer and their interpretation is not established by these sources.

## Testing

The pure functions in `search.ts` (`composeQuery`, `normalizeTerm`, `normalizeSite`, `cleanInput`, `shapeApiError`, `formatSearchResults`) are designed for deterministic unit tests with no live web calls. `searchGoogle` accepts an optional `fetchFn` parameter for injecting a mock fetch.

Tests live in `packages/web-search/__tests__/` as the package's **Package test suite** and run through the shared Vitest harness — they use the **Vitest test idiom** (`describe` / `it` / `expect`), mock the network boundary with `vi.fn()`, and never require Google Custom Search credentials, environment variables, or live network access. `resolveCredentials` is exercised with explicit env objects and an injected `authPath`, so a developer's own `~/.pi/agent/auth/web-search.json` can never affect the outcome.

Run the package's tests locally:

```bash
pnpm --filter @epr3/pi-extension-web-search test
```

Or run the whole workspace roll-up from the repo root:

```bash
pnpm test
```