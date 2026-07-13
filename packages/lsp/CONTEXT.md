# Pi Extensions — lsp

Domain language for the `packages/lsp` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**LSP Extension package**: Runnable Pi `ExtensionAPI` module under `packages/lsp` whose default export registers language-server-backed code navigation and diagnostics tools.
_Avoid_: LSP package, language-server package, code intelligence plugin.

**Language server**: External stdio process that answers source-code navigation, symbol, hover, call hierarchy, and diagnostic requests for one language family.
_Avoid_: Compiler, analyzer, parser.

**Position tool**: `lsp_*` tool whose request identifies a symbol by `file:line:column` using 1-based positions.
_Avoid_: Navigation command, jump tool.

**Workspace symbol query**: Project-wide symbol search routed through any file of the target language so the right **Language server** is selected.
_Avoid_: Grep search, global find.

**Routing file**: The file argument used only to choose the **Language server** for a **Workspace symbol query**.
_Avoid_: Search scope, target file.

**Tool invocation summary**: User-facing call display shown while an `lsp_*` tool is executing, using the tool argument path plus 1-based position when present and separate from the model-visible tool result.
_Avoid_: Tool output, LSP log, progress stream.

**Diagnostics request**: `lsp_diagnostics` call that returns language-server errors and warnings for one file after an optional debounce delay.
_Avoid_: Typecheck, lint run.

**Server mapping**: Configuration entry that binds one LSP language id to an external language-server command and the file extensions it owns.
_Avoid_: Server preset, language config, extension handler.

## Relationships

- **LSP Extension package** registers multiple **Position tools** plus **Workspace symbol query** and **Diagnostics request**.
- **Position tool** requests are served by one lazily-spawned **Language server**.
- **Workspace symbol query** uses a **Routing file** to select a **Language server**, not to limit symbol results.
- **Tool invocation summary** displays the requested file or query while the final tool result remains language-server answer text.
- **Server mapping** entries live in `servers.json` and can be overridden by Pi settings.
- A **Language server** is not bundled by a **Server mapping**; its command must be available on `PATH`.

## Example dialogue

> **Dev:** "Should I grep for every call before renaming?"
> **Domain expert:** "No — use a **Position tool** like `lsp_references` so the **Language server** answers from code semantics."

## Flagged ambiguities

- "LSP package" sounded like a dependency; resolved: use **LSP Extension package** for this runnable Pi extension.
- "diagnostics" can mean a full repo typecheck; resolved: **Diagnostics request** means one-file language-server diagnostics.
- "output while the tool executes" sounded like streaming progress or server logs; resolved: show a **Tool invocation summary** with the filename/query, not raw **Language server** protocol or logs.
- ".vue support" could mean bundling Vue tooling, documenting a settings override, or shipping a default **Server mapping**; resolved: ship a default `.vue` **Server mapping** for the external `vue-language-server` command while keeping the existing PATH-only **Language server** ownership model.
