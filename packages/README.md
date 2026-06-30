# Pi Agent Skill Suite — Artifact-First Workflow

Pi port of a nineteen-skill suite (`@earendil-works/pi`), plus seven Pi Extension packages. The workflow:

```
/grill-with-docs  →  /to-prd  →  /to-issues  →  /resolve-issue  →  /offload-context
```

Grill the thinking out against the domain docs, synthesize a PRD, break it into vertical-slice issues, implement issues one at a time. `improve-codebase-architecture` handles deepening refactors; the rest are utilities.

## The nineteen skills

**Pipeline** — `grill-with-docs` · `to-prd` · `to-issues` · `resolve-issue` · `offload-context`
**Grilling** — `grilling` · `grill-me` · `grill-with-docs` · `domain-modeling`
**Design** — `prototype` (+ `LOGIC`, `UI`)
**Architecture** — `improve-codebase-architecture` (+ `LANGUAGE`, `DEEPENING`, `INTERFACE-DESIGN`, `HTML-REPORT`)
**Setup & utilities** — `setup-context` · `sharpen-context` · `merge-context` · `rebase-context` · `zoom-out` · `handoff` · `write-a-skill` · `caveman` · `teach` (+ 4 format refs)

## The seven Extension packages (`packages/<name>/`, TypeScript)

All are real Pi extensions written against the documented `ExtensionAPI`, loaded via jiti (no build step). `typebox`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-ai` are provided by Pi at runtime. Each Extension package lives in its own directory under `packages/` and is a first-class buildable unit; the shipped config bundle (`pi-config/`) is separate and is not an Extension package.

| Extension package | Adds | Notes |
|-------------------|------|-------|
| `subagents` | `Agent` + `get_subagent_result`, types **explore** (read-only; extra tools granted via settings), **researcher** (read-only + `web_search`/`web_fetch` when present), and **general** (all discovered tools) | spawns real isolated sessions via the SDK `createAgentSession`; conventions loosely from `@tintinweb/pi-subagents`, not verbatim |
| `question` | `question` tool | structured multiple-choice via `ctx.ui.select`; prose fallback in non-interactive modes |
| `todo` | `todo_write` / `todo_read` | state in tool-result details, reconstructed on `session_start` |
| `lsp` | `lsp_definition` / `implementation` / `references` / `workspace_symbols` / `document_symbols` / `hover` / `incoming_calls` / `outgoing_calls` / `diagnostics` | dependency-free stdio LSP client; runtime-tested vs a mock server |
| `statusline` | dumb-zone footer status | uses `ctx.getContextUsage()`, `ctx.model.contextWindow`, `ctx.cwd`, `pi.exec(git)`, `ctx.ui.setStatus` |
| `web-fetch` | `web_fetch` tool for fetching URLs and extracting Markdown | validates URLs, browser-like UA, timeout, size cap, HTML→Markdown via heuristic extraction, plain-text pass-through, binary rejection |
| `web-search` | `web_search` tool for researcher sub-agents | Google Custom Search; credentials from env vars or `~/.pi/agent/auth/web-search.json`; query composition with exact phrases, exclusions, site restriction |


### Subagents: explore + researcher + general

See [web-fetch/README.md](./web-fetch/README.md) for the `web_fetch` tool documentation.

Three types by design. `explore` is read-only (`read/grep/find/ls`) for codebase discovery; `researcher` is read-only too, adding `web_search`/`web_fetch` for web/external research grounded against the code (web tools come from separate extensions — degrades gracefully if absent); `general` has all tools and inherits the normal prompt for off-context work like the parallel interface designs. No Plan agent, steering, resume, or custom `.pi/agents`.

### Status line: real Pi APIs

Not a script — a TypeScript extension. Reads live usage from `ctx.getContextUsage()` and the window from `ctx.model.contextWindow`, computes the zone, and renders into the footer with `ctx.ui.setStatus`. Shows folder + branch. Zones `sharp → fading → risky → caveman` with **caveman at an absolute >120k tokens** (the cliff doesn't move with the advertised window; NoLiMa/RULER), lower zones splitting the run-up into thirds. The `caveman` zone shares its name with the `caveman` skill — the line says when, the skill is the response.

## Global rules (one-time, personal)

The code-intelligence guidance and the context-store/ADR convention are repo-agnostic and personal — install them **once per machine** from `pi-config/skills/setup-context/global-rules.md` into your global Pi instructions (`~/.pi/agent/`), not per repo. `setup-context` detects this block and offers to install it on first run; it then seeds the per-repo `domain.md` into the branch's context worktree.

## Settings — keys in Pi's `settings.json`

No extra config file and no shared loader: each extension inlines its own ~8-line read of **its own top-level key** in Pi's settings (`subagents`, `statusline`, `lsp`) — fully self-contained, copy one directory and it works. Layered **code defaults → `~/.pi/agent/settings.json` (global) → `<project>/.pi/settings.json` → env vars**. Objects deep-merge, arrays replace, `"//"` keys are comments. The shipped `pi-config/settings.json` carries a commented example of all three. Notable knobs: `subagents.explore.extraTools` (read-only tool grants for explore — the example grants the `lsp_*` set), `subagents.maxConcurrency`, `statusline.effectiveLimit` / `thresholds` / `meterWidth`, `lsp.servers` (add languages without touching the extension dir) and `lsp.diagnosticsDelayMs`. `question` and `todo` currently expose no options and gain keys only when they earn one.

## How the skills use the extensions — all "if available"

Nothing hard-depends on an extension; each skill names the tool and the fallback:

- **question** → structured questions; else prose (question, 2–4 options with `(recommended)`, one-sentence reason, one at a time).
- **subagents** → `Agent({ subagent_type: "explore" })` for discovery, `"general"` for parallel designs; else direct `read`/`grep`/`find`/`ls`.
- **lsp** → `lsp_definition`/`lsp_references`/`lsp_diagnostics` for precision; else grep.
- **todo** → slice breakdown (`to-issues`) and steps (`resolve-issue`); else inline.

## Adaptations from the Claude Code originals

Harness-agnostic skills (`zoom-out`, `handoff`, `caveman`, `write-a-skill`) and reference files (`LANGUAGE`, `DEEPENING`, `HTML-REPORT`, `CONTEXT-FORMAT`, `ADR-FORMAT`, `domain`) are verbatim. Changes:

- `AskUserQuestion` → the `question` tool (if available, else prose).
- `Task` / `subagent_type=Explore` → the `Agent` tool, types `explore`/`general`.
- **Plan mode removed** — Pi is leaner; skills just do the work. No read-only-session staging, no plan-mode caveats.
- `setup-context` prefers `AGENTS.md` (Pi's canonical instructions file).

## Layout

```
pi-extensions/
├── package.json              monorepo scripts (build / typecheck / lint) and dev deps
├── pnpm-workspace.yaml       packages/*
└── packages/
    ├── pi-config/            config bundle (settings.json + skills/) — NOT an Extension package
    │   ├── settings.json     loads skills + the seven Extension packages
    │   └── skills/           21 skills (+ reference files)
    ├── subagents/  index.ts agents.ts manager.ts runner.ts
    ├── question/   index.ts
    ├── todo/       index.ts
    ├── lsp/        index.ts tools.ts client.ts servers.json
    ├── web-search/  index.ts search.ts render.ts
    ├── web-fetch/   index.ts fetch.ts render.ts
    └── statusline/ index.ts zone.ts
```

## Architecture

The extensions follow the suite's own deep-module discipline — narrow interfaces over hidden complexity, with the seams placed where they earn their keep:

- **`subagents/manager.ts`** — `AgentManager` is a concurrency-limited scheduler (`launch` / `getResult` / `list`) that owns records, the queue, and lifecycle events. It takes an opaque `exec` thunk, so it knows nothing about cwd/models/Pi and is unit-tested with a fake exec. `index.ts` only wires tools to it.
- **`statusline/zone.ts`** — the degradation model (`classify` / `bar`) is pure and is the test surface; `index.ts` does only Pi event/UI/git wiring.
- **`lsp/tools.ts`** — the tool catalog (name, description, param-kind, handler) is data in one place; `index.ts` maps param-kinds to schemas and registers in a loop, so a tool is declared once.
- **`web-fetch/fetch.ts`** — URL validation, fetch orchestration, HTML→Markdown extraction, and content-type detection; `index.ts` wires the tool; `render.ts` handles TUI.

The pure modules (`zone.ts`, `manager.ts`, `fetch.ts` extraction and conversion functions) and the LSP client are exercised by standalone tests that need no running Pi.

## Install

Drop `pi-config/skills` into your skills path and point Pi's `settings.json` at the seven Extension package dirs (see `pi-config/settings.json`). Extension packages are TypeScript and run as-is under Pi's jiti loader. The language servers used by `lsp` must be on `PATH`.

## Verify

One command, one source of truth — `pnpm verify:ext` runs `scripts/audit-extensions.sh`, which checks that the seven Extension packages build and typecheck, that no code imports the removed shared support, that reference docs and shipped settings use current paths, and that root scripts, package metadata, and the reference README tell the same Extension package story. Run it after any change to a package or to the layout.
