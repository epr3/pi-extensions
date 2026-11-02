# lsp — Language-server navigation (Pi extension, TypeScript)

Precise code navigation via real language servers instead of grep guesses. Dependency-free (`node:` built-ins only); requires the language servers on `PATH`.

## Tools

`lsp_definition` · `lsp_implementation` · `lsp_references` · `lsp_workspace_symbols` · `lsp_document_symbols` · `lsp_hover` · `lsp_incoming_calls` · `lsp_outgoing_calls` · `lsp_diagnostics` — position tools keyed by `file:line:column` (1-based); `lsp_workspace_symbols` takes a name query plus any file of the target language to route to the right server. One server per language, spawned lazily, mapped by extension in `servers.json` (TS/JS, Vue, Python, Rust, Go out of the box) — add or override languages under the `lsp.servers` key in Pi's `settings.json` without touching the extension dir (`lsp.diagnosticsDelayMs` tunes the diagnostics wait). The manager binds to the **session's cwd** lazily on first use and rebuilds (stopping old servers) if the session moves to a different project, e.g. via `/resume`.

Language servers are external commands and must be available on `PATH`; for Vue single-file components, install/provide `vue-language-server` (from `@vue/language-server`) before using the `lsp_*` tools on `.vue` files.

Freshness boundary: the client tracks each opened file's on-disk state and, before serving a request, re-synchronizes the server (`textDocument/didChange` with the new full text) when the saved contents have changed — hands-free, no re-read when nothing changed. Only saved content is visible; unsaved in-editor buffers are not, so save the file before navigating to see your edit.

**Failure behavior** — server problems are surfaced as model-readable tool results, never crashes: a missing/unspawnable server command (e.g. ENOENT) fails fast naming the command, the affected language, and the `'lsp.servers'` setting to fix; a file type no `lsp.servers` entry owns explains the extension and suggests grep fallback; in-flight requests against a server error or exit are rejected with the server's message. The next `lsp_*` call re-spawns a server that exited; no retry loop beyond that.

Diagnostics confidence: `lsp_diagnostics` reports how its answer relates to the latest saved contents — `current` (a `publishDiagnostics` message whose document version matches the opened document; a reported empty set means the file is clean), `uncertain` (the server omitted the version or answered for an older one; diagnostics are shown if any, but the file is never claimed clean), or `pending` (the server has not published anything for the file since it was opened/synchronized; not available yet, not a clean file). `lsp.diagnosticsDelayMs` is only a wait budget that expires when no correlated response arrives — a delay is never proof of current diagnostics.

The tool catalog (names, descriptions, param-kinds, handlers) is a single data array in `tools.ts`; `index.ts` registers it in a loop, so each tool is declared once. The stdio client (`client.ts`) and handlers (`tools.ts`) are standard LSP and are runtime-tested against a mock server independently of Pi; `index.ts` registers the tools via `pi.registerTool`. Skills prefer these over grep "if available".

## Using them well

When the `lsp_*` tools are available, try the appropriate one **first** for supported semantic navigation — they answer from the compiler's understanding of the code, not text matching. The extension supplies this preference itself through registered tool guidance (descriptions, prompt snippets, and guidelines), so it works without editing agent instructions:

- `lsp_definition` — jump to a symbol's declaration; `lsp_implementation` for the concrete code behind an interface or abstract member
- `lsp_references` — every usage across the codebase
- `lsp_workspace_symbols` — find where something is defined by name when you don't know the file
- `lsp_document_symbols` — outline a file before reading it whole
- `lsp_hover` — type / signature / docs at a position without opening the file
- `lsp_incoming_calls` / `lsp_outgoing_calls` — who calls this function, and what it calls

Positions are 1-based `file:line:column`.

**Before** renaming or changing any signature, run `lsp_references` on it — grep misses dynamic and re-exported usages and over-matches common names. **After** writing or editing code, run `lsp_diagnostics` on each touched file and fix type errors and missing imports immediately, before moving on.

Grep/find remain the right tool in three situations. **Orientation and input:** locating an identifier and its `file:line:column` position before a position tool can run. **Textual questions:** what the language server can't see — comments, strings, config values, TODOs, log messages, and non-code files. **Fallback:** when a language server is unavailable, fails, times out, or gives an unhelpful answer; state any uncertainty that matters to the task rather than silently pretending the semantic answer was authoritative.

Empty semantic results are potentially inconclusive — a server may simply not cover the file or symbol. Verify with text search when completeness matters (e.g. before a rename) or the result looks implausible; don't automatically re-check every empty result.

Explore agents carry the same preference: grant them the `lsp_*` set via `subagents.explore.extraTools` or `PI_SUBAGENT_EXPLORE_TOOLS` (the shipped settings example does), and their tailored prompt expresses the same first-choice, fallback, and empty-result guidance.