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

## Default Subagent Model

Each subagent type can use a specific model instead of inheriting the parent
session's model. Configure it under the `subagents` settings key.

### Shared default

A `defaultModel` setting applies to all subagent types that don't have their
own type-specific override:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "subagents": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514"
  }
}
```

### Per-type overrides

Each subagent type (`explore`, `researcher`, `general`) can set its own
`defaultModel` under its own settings key. The type-specific value wins over
the shared default for that type only:

```jsonc
{
  "subagents": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "explore": {
      "defaultModel": "anthropic/claude-haiku-3-5-20241022",
      "extraTools": ["lsp_definition", "lsp_references"]
    },
    "researcher": {
      "defaultModel": "anthropic/claude-sonnet-4-20250514"
    },
    "general": {
      "defaultModel": "openai/gpt-4o"
    }
  }
}
```

Every model value is an exact `provider/model` string matching a model in Pi's
model registry. Provider is the text before the first slash; model id is
everything after. Missing slash, empty provider, or empty model id makes the
reference invalid — the extension falls back to the next level and warns.

### Resolution precedence

1. **Subagent type default** — per-type `defaultModel` under
   `subagents.{explore,researcher,general}`.
2. **Shared default** — the `subagents.defaultModel` setting.
3. **Parent model** — the session's active model at launch time.

Each level: unconfigured, invalid reference syntax, or unresolvable ref
(unknown provider / model id in the registry) → fall through to the next.

### Invalid reference warnings

When a configured model reference cannot be used, the subagent run proceeds
with the next fallback level and emits a warning. Warnings never appear in
the subagent result text — they are delivered in two channels:

1. **Tool details** — a `warnings` array in the machine-readable `details`
   object of the `Agent` tool result and the `get_subagent_result` tool
   result, each entry containing `{ scope, reference, type }` where `scope`
   is `"shared"` or the subagent type, `reference` is the raw config value,
   and `type` is `"malformed"` (invalid syntax) or `"unresolvable"` (not
   found in the model registry).
2. **UI notification** — when the Pi TUI is active, each warning fires a
   toast notification labelled `"warning"` at launch time.

### Why not per-call?

The `Agent` tool parameters do **not** gain a model field — model selection is
settings-driven only, not per-call.

## Structure

`manager.ts` is a deep `AgentManager` — a concurrency-limited scheduler (`launch` / `getResult` / `list`) that hides the records, queue, and lifecycle events and takes an opaque `exec` thunk (so it's testable with a fake, with no Pi). `index.ts` only wires the tools to it; `runner.ts` does the actual spawn.

## How it spawns (real, via the SDK)

`runner.ts` uses the Pi SDK's `createAgentSession` with an in-memory session and a restricted toolset, runs `session.prompt(task)`, and returns the final assistant text. `explore` and `researcher` get a read-only toolset + a tailored prompt (the researcher's adds the web tools and asks for cited, paraphrased findings); `general` inherits the normal toolset and system prompt for the cwd. Not a stub.

Skills reference it "if available", falling back to direct `read`/`grep`/`find`/`ls`.
