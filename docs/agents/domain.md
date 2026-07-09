# Domain Docs

**Code repo:** `git@github.com:epr3/pi-extensions.git` (`epr3__pi-extensions`)

How the engineering skills should consume this code repo's domain documentation. This repo uses **in-repo context**: domain docs and ADRs are committed with the code.

## Before exploring, read

This repo uses a **multi-context** layout:

- `CONTEXT-MAP.md` at the repo root lists the available package contexts.
- Each listed context has its own `CONTEXT.md`, mirroring a real code path under `packages/*`.

Read the `CONTEXT.md` files relevant to the task. If no relevant context exists yet, proceed silently; `grill-with-docs` creates terms lazily when decisions resolve.

## File structure

```text
CONTEXT-MAP.md
packages/lsp/CONTEXT.md
packages/model-presets/CONTEXT.md
packages/question/CONTEXT.md
packages/statusline/CONTEXT.md
packages/subagents/CONTEXT.md
packages/todo/CONTEXT.md
packages/web-fetch/CONTEXT.md
packages/web-search/CONTEXT.md
docs/adr/
```

Each package glossary owns its package-specific vocabulary and may have its own `adr/` directory. Repo-wide ADRs live under `docs/adr/`.

## Use the glossary's vocabulary

When naming a domain concept (issue title, refactor proposal, hypothesis, test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use, or there's a real gap to note for `grill-with-docs`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR `2026-01-12-example` — but worth reopening because…_
