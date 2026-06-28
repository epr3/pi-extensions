# subagents — explore + researcher + general sub-agents (Pi extension, TypeScript)

Adds three sub-agent types for context hygiene. The `Agent` tool surface follows the conventions of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), and the `researcher` role takes inspiration from [`amosblomqvist/pi-subagents`](https://github.com/amosblomqvist/pi-subagents) — used as design references, not followed verbatim; this is a lean independent build pulling in only what the suite needs.

## Agent types

| Type | Tools | Read-only | Use |
|------|-------|-----------|-----|
| `explore` | read, grep, find, ls by default; **extra read-only tools are granted in settings** (the shipped `settings.json` grants the `lsp_*` set) | yes | codebase discovery — the suite's default for context-gathering |
| `researcher` | read, grep, find, ls **+ `web_search`, `web_fetch`**; extra read-only tools grantable in settings | yes | web/external research (docs, APIs, libraries), grounded against the codebase when relevant |
| `general` | everything discovered: all built-ins **and all installed extension tools** (lsp, todo, …), minus the exclusions below | no | off-context work that writes (e.g. parallel interface designs) |

No `Plan` agent, no steering, no resume, no custom `.pi/agents` — deliberately omitted.

## Extension tools inside sub-agents

The sub-session uses the same resource loader as the parent, so it discovers every installed extension. The two types then differ in how tools reach the model:

- **`general` needs nothing** — it passes no allowlist, so any extension you install (lsp, todo, a future one) is available to it automatically. The only subtractions are the safety exclusions: `Agent`, `get_subagent_result`, `question`.
- **`explore` and `researcher` are allowlists by design** — that's what makes their read-only property structural rather than promised. `explore` holds the core read tools (plus `subagents.explore.extraTools` / `PI_SUBAGENT_EXPLORE_TOOLS`); `researcher` adds `web_search` + `web_fetch` on top of the core read tools (plus `subagents.researcher.extraTools` / `PI_SUBAGENT_RESEARCHER_TOOLS`). Only ever grant **read-only** tools — anything that writes or executes belongs to `general`. Take tools away from `general` with `subagents.general.excludeExtraTools`; the safety exclusions (`Agent`, `get_subagent_result`, `question`) are fixed and not configurable.
- The web tools come from separate Pi extensions (e.g. `amosblomqvist/pi-config`'s `web-search` / `web-fetch`). If an allowlisted tool isn't installed, the unmatched name is simply absent; should a harness version reject unknown names instead, the runner retries a **read-only** agent (`explore` or `researcher`) with the core read tools, so it degrades gracefully rather than failing.

**One level deep, enforced:** sub-sessions are created with `excludeTools: ["Agent", "get_subagent_result", "question"]`, so a sub-agent cannot recursively spawn sub-agents (the resource loader would otherwise hand it this very extension) and can't block on a question no user will see. Foreground runs return their result inline; only background settles raise a notification.

## Tools

- `Agent({ subagent_type, prompt, description, run_in_background? })` — foreground blocks + returns the result; background returns an id.
- `get_subagent_result({ agent_id, wait? })` — poll/retrieve a background agent.
- `/subagents` — list sub-agents and status.

Background agents run through a concurrency queue (default 4, `PI_SUBAGENT_CONCURRENCY`).

## Structure

`manager.ts` is a deep `AgentManager` — a concurrency-limited scheduler (`launch` / `getResult` / `list`) that hides the records, queue, and lifecycle events and takes an opaque `exec` thunk (so it's testable with a fake, with no Pi). `index.ts` only wires the tools to it; `runner.ts` does the actual spawn.

## How it spawns (real, via the SDK)

`runner.ts` uses the Pi SDK's `createAgentSession` with an in-memory session and a restricted toolset, runs `session.prompt(task)`, and returns the final assistant text. `explore` and `researcher` get a read-only toolset + a tailored prompt (the researcher's adds the web tools and asks for cited, paraphrased findings); `general` inherits the normal toolset and system prompt for the cwd. Not a stub.

Skills reference it "if available", falling back to direct `read`/`grep`/`find`/`ls`.
