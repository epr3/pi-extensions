# subagents — explore + general subagents (Pi extension, TypeScript)

Adds two subagent types for context hygiene. The `Agent` tool surface follows the conventions of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

## Agent types

| Type      | Tools                                                                                                                                   | Read-only | Use                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `explore` | read, grep, find, ls by default; **extra read-only tools are granted in settings** (the shipped `settings.json` grants the `lsp_*` set) | yes       | codebase discovery — the suite's default for context-gathering |
| `general` | everything discovered: all built-ins **and all installed extension tools** (lsp, todo, …), minus the exclusions below                   | no        | off-context work that writes (e.g. parallel interface designs) |

No `Plan` agent, no steering, no resume, no custom `.pi/agents` — deliberately omitted. **External web research** is also deliberately outside this package: the parent Pi coding agent uses web Extension tools such as `web_search` and `web_fetch` directly, not through a built-in Subagent type.

## Extension tools inside subagents

The sub-session uses the same resource loader as the parent, so it discovers every installed extension. The two types then differ in how tools reach the model:

- **`general` needs nothing** — it passes no allowlist, so any extension you install (lsp, todo, a future one) is available to it automatically. The only subtractions are the safety exclusions: `Agent`, `get_subagent_result`, `question`.
- **`explore` is an allowlist by design** — that's what makes its read-only property structural rather than promised. `explore` holds the core read tools (plus `subagents.explore.extraTools` / `PI_SUBAGENT_EXPLORE_TOOLS`). Only ever grant **read-only** tools — anything that writes or executes belongs to `general`. Take tools away from `general` with `subagents.general.excludeExtraTools`; the safety exclusions (`Agent`, `get_subagent_result`, `question`) are fixed and not configurable.

**One level deep, enforced:** sub-sessions are created with `excludeTools: ["Agent", "get_subagent_result", "question"]`, so a subagent cannot recursively spawn subagents (the resource loader would otherwise hand it this very extension) and can't block on a question no user will see. Foreground runs return their result inline; only background settles raise a notification.

## Tools

- `Agent({ subagent_type, prompt, description, run_in_background? })` — foreground blocks + returns the result; background returns an id.
- `get_subagent_result({ agent_id, wait? })` — poll/retrieve a background agent.
- `/subagents` — list subagents and status.

Background agents run through a concurrency queue (default 4, `PI_SUBAGENT_CONCURRENCY`).

## Same-turn fan-out

The intended way to run multiple independent same-type **Subagent** tasks in parallel is
to issue multiple foreground `Agent` tool calls in one assistant turn — one call per task,
each with its own `subagent_type`, `prompt`, and `description`. This is called **Same-turn
fan-out**.

Each `Agent` call returns its own independent result, with its own `agent_id`, status,
token count, tool-use count, warnings, and result text. You synthesize across sibling
results in normal conversation context.

```typescript
// Same-turn fan-out: multiple Agent calls in one turn, independent prompts.
// Running the subagents in the foreground — same subagent_type, each call
// returns its own record. The concurrency cap is shared between foreground
// and background runs.
Agent({ subagent_type: "explore", prompt: "Search A", description: "Search A" });
Agent({ subagent_type: "explore", prompt: "Search B", description: "Search B" });
```

### What it is not

- **Not a batch API.** There is no `tasks` parameter on `Agent`, no aggregate result
  object, and no batch polling tool. The `Agent` contract stays one-run-only.
- **Not a replacement for background polling.** Foreground fan-out blocks and returns
  results inline. Background runs with `run_in_background: true` + `get_subagent_result`
  remain the correct pattern for long-running or fire-and-forget tasks.
- **Not recursion.** **Subagents** cannot spawn child **Subagents** — the `Agent` and
  `get_subagent_result` tools are excluded from sub-sessions. Same-turn fan-out is
  sibling delegation by the parent Pi coding agent, not nested subagent spawning.

### Concurrency

Foreground fan-out respects the configured subagent concurrency cap (default 4,
`PI_SUBAGENT_CONCURRENCY`). If more same-turn `Agent` calls are issued than the cap
allows, subsequent launches queue and execute as slots free up — foreground launches
have priority over background launches.

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
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
  },
}
```

### Per-type overrides

Each subagent type (`explore`, `general`) can set its own
`defaultModel` under its own settings key. The type-specific value wins over
the shared default for that type only:

```jsonc
{
  "subagents": {
    "defaultModel": "anthropic/claude-sonnet-4-20250514",
    "explore": {
      "defaultModel": "anthropic/claude-haiku-3-5-20241022",
      "extraTools": ["lsp_definition", "lsp_references"],
    },
    "general": {
      "defaultModel": "openai/gpt-4o",
    },
  },
}
```

Every model value is an exact `provider/model` string matching a model in Pi's
model registry. Provider is the text before the first slash; model id is
everything after. Missing slash, empty provider, or empty model id makes the
reference invalid — the extension falls back to the next level and warns.

### Resolution precedence

1. **Subagent type default** — per-type `defaultModel` under
   `subagents.{explore,general}`.
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

## Subagent thinking level

Set an optional shared reasoning-effort preference for both `explore` and
`general`, in foreground or background runs:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "subagents": {
    "thinkingLevel": "medium",
  },
}
```

Project settings override global settings. Accepted values are Pi's `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Thinking and `defaultModel` resolve independently: configure either or both;
a malformed model preference does not discard valid thinking, or vice versa.

- **Omitted:** no session thinking override; existing SDK/settings defaults and
  capability adaptation remain in effect. Inheriting the Parent model does not
  newly inherit the parent's active thinking level.
- **Explicit `"off"`:** requests disabled thinking, subject to Pi's capability
  adaptation; it is not the same as omission.
- **Malformed:** warns and behaves as absent.
- **Valid but unsupported:** Pi adapts the preference for the resolved model,
  without choosing a different model. A warning reports the requested and
  effective levels, including when a non-reasoning model disables thinking.

Warnings appear in tool-result `details.warnings` and, when available, UI
notifications—not in generated Subagent result prose. Thinking traces are not
returned to the parent as result text.

This is opt-in: bundled settings remain unchanged. There is no per-call
thinking parameter, model preset, or token-budget setting.

## Structure

`manager.ts` is a deep `AgentManager` — a concurrency-limited scheduler (`launch` / `getResult` / `list`) that hides the records, queue, and lifecycle events and takes an opaque `exec` thunk (so it's testable with a fake, with no Pi). `index.ts` only wires the tools to it; `runner.ts` does the actual spawn.

## How it spawns (real, via the SDK)

`runner.ts` uses the Pi SDK's `createAgentSession` with an in-memory session and a restricted toolset, runs `session.prompt(task)`, and returns the final assistant text. `explore` gets a read-only toolset + a tailored prompt; `general` inherits the normal toolset and system prompt for the cwd. Not a stub.

Skills reference it "if available", falling back to direct `read`/`grep`/`find`/`ls`.