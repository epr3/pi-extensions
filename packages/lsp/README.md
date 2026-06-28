# lsp — Language-server navigation (Pi extension, TypeScript)

Precise code navigation via real language servers instead of grep guesses. Dependency-free (`node:` built-ins only); requires the language servers on `PATH`.

## Tools

`lsp_definition` · `lsp_implementation` · `lsp_references` · `lsp_workspace_symbols` · `lsp_document_symbols` · `lsp_hover` · `lsp_incoming_calls` · `lsp_outgoing_calls` · `lsp_diagnostics` — position tools keyed by `file:line:column` (1-based); `lsp_workspace_symbols` takes a name query plus any file of the target language to route to the right server. One server per language, spawned lazily, mapped by extension in `servers.json` (TS/JS, Python, Rust, Go out of the box) — add or override languages under the `lsp.servers` key in Pi's `settings.json` without touching the extension dir (`lsp.diagnosticsDelayMs` tunes the diagnostics wait). The manager binds to the **session's cwd** lazily on first use and rebuilds (stopping old servers) if the session moves to a different project, e.g. via `/resume`.

The tool catalog (names, descriptions, param-kinds, handlers) is a single data array in `tools.ts`; `index.ts` registers it in a loop, so each tool is declared once. The stdio client (`client.ts`) and handlers (`tools.ts`) are standard LSP and are runtime-tested against a mock server independently of Pi; `index.ts` registers the tools via `pi.registerTool`. Skills prefer these over grep "if available".

## Using them well


When the `lsp_*` tools are available, prefer them over grep/find/read for code navigation — they answer from the compiler's understanding of the code, not text matching:

- `lsp_definition` — jump to a symbol's declaration; `lsp_implementation` for the concrete code behind an interface or abstract member
- `lsp_references` — every usage across the codebase
- `lsp_workspace_symbols` — find where something is defined by name when you don't know the file
- `lsp_document_symbols` — outline a file before reading it whole
- `lsp_hover` — type / signature / docs at a position without opening the file
- `lsp_incoming_calls` / `lsp_outgoing_calls` — who calls this function, and what it calls

Positions are 1-based `file:line:column`.

**Before** renaming or changing any signature, run `lsp_references` on it — grep misses dynamic and re-exported usages and over-matches common names. **After** writing or editing code, run `lsp_diagnostics` on each touched file and fix type errors and missing imports immediately, before moving on.

Grep/find remain the right tool for what the language server can't see: comments, strings, config values, TODOs, log messages, and non-code files.
