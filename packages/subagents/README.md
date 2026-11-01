# subagents — explore + general + custom Subagent types (Pi extension, TypeScript)

Adds two subagent types for context hygiene. The `Agent` tool surface follows the conventions of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

## Agent types

| Type      | Tools                                                                                                                                   | Read-only | Use                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `explore` | read, grep, find, ls by default; **extra read-only tools are granted in settings** (the shipped `settings.json` grants the `lsp_*` set) | yes       | codebase discovery — the suite's default for context-gathering |
| `general` | everything discovered: all built-ins **and all installed extension tools** (lsp, todo, …), minus the exclusions below                   | no        | off-context work that writes (e.g. parallel interface designs) |

No `Plan` agent, no steering, no resume, no nested delegation — deliberately omitted. Custom Subagent types are supported via `.pi/agents` definition files (see below). **External web research** is also deliberately outside this package: the parent Pi coding agent uses web Extension tools such as `web_search` and `web_fetch` directly, not through a built-in Subagent type.

## Custom Subagent types

Specialized Subagent types are defined as Pi-scoped Markdown definition files, read fresh on every launch — edits apply to subsequent launches, and a run in progress keeps its launch-time definition.

### Definition format

```markdown
---
name: code-reviewer
description: Reviews diffs with extra care for API changes
---

You are a code review Subagent. The Markdown body is the Subagent's system prompt.
```

- Required frontmatter: `name` (identity, matched exactly as `subagent_type`) and `description` (surfaced to the parent so it can pick a type).
- The body is the system prompt. Markdown without frontmatter or without a `name` is documentation and is ignored.
- Frontmatter accepts `name`, `description`, `tools`, `disallowedTools`, and `model` (see below). `skills` is **rejected explicitly** as not yet implemented, as are unknown fields — never silently ignored, so unimplemented settings are never mistaken for guarantees.
- `explore` and `general` are reserved names and cannot be redefined.

### Discovery locations and precedence

- Project scopes: `.pi/agents` directories from the working directory up to the Git repository root inclusive. Outside Git, only the working directory's project scope is inspected. `.claude/agents` is never discovered.
- User scope: the `agents` directory inside Pi's agent config dir (e.g. `~/.pi/agent/agents`, respecting `PI_CODING_AGENT_DIR`).
- Precedence is per-name and never merges: the nearest project scope that mentions a name decides it, beating farther project scopes and the user scope. Two definitions of the same name in one scope conflict; the name becomes unusable and both paths are diagnosed. An invalid nearer definition shadows valid lower-priority ones. Valid types stay usable while unrelated invalid ones are diagnosed.

### Tools: `tools` and `disallowedTools`

A definition can shape the Subagent tool boundary. Both fields accept a YAML list or a
comma-separated string of **exact Pi tool names** (`read`, `bash`, `grep`, `lsp_definition`, …):

```markdown
---
name: code-reader
description: Read-only inspection
# YAML list:
tools:
  - read
  - grep
  - find
  - ls
# equivalently: tools: read, grep, find, ls
disallowedTools: write, bash
---

Body.
```

- **Omitted `tools` inherits everything** the Subagent session would otherwise have — all
  built-ins, all installed extension tools, write and shell tools included — minus
  `disallowedTools` and the fixed safety exclusions. An omitted allowlist is *not*
  read-only: if you want a read-only Subagent, say so explicitly with a read-only
  `tools` list.
- **`disallowedTools` narrows** the allowlisted or inherited set. Denials never touch the
  fixed safety exclusions (those are always removed anyway).
- **Availability is exact.** Every allowlisted or denied name must be a tool that actually
  exists and is active in the launching session (Pi built-ins plus registered extension
  tools). Unknown or currently unavailable names fail the launch — they are never
  silently dropped, so nothing widens or narrows by accident.
- **Scoped patterns are rejected.** Claude-style patterns such as `Bash(git*:*)`,
  `WebFetch(domain:example.com)`, or wildcards like `Edit*` / `Edit:*` are not supported and
  make the definition invalid; write the bare Pi tool names instead. Claude tool names are
  not translated — a definition listing `Bash` or `Edit` fails as unavailable.
- **Empty results are rejected.** If the effective set — allowlist (or inheritance) minus
  denials minus the safety exclusions — is empty, the launch fails with an actionable
  message instead of running a tool-less Subagent.
- **Safety boundaries always win.** Even if a definition explicitly allowlists `Agent`,
  `get_subagent_result`, or `question`, those tools are removed from the Subagent session:
  no custom type can gain nested delegation, result retrieval, or blocking questions.

### Model: `model`

A definition can pin its model:

- **Exact reference** — `model: anthropic/claude-sonnet-4-20250514` sets the model for the
  type's runs, overriding the configured shared `subagents.defaultModel`. The reference must
  be an exact `provider/model` entry of the model registry; an unknown or unavailable model
  **fails the launch** rather than silently running on a different model.
- **`model: inherit`** — explicitly uses the launching session's model.
- **Omitted** — the existing behavior stands: `subagents.defaultModel` when configured,
  then the launching session's model. A configured default that cannot be resolved still
  warns and falls back as before (this never hard-fails, unlike an explicit definition
  model).
- Bare aliases (`haiku`, `opus`, …) are rejected at discovery: write the exact
  `provider/model` value; Pi does no alias translation here.
- When a definition model is set (or `inherit`), the `subagents.defaultModel` setting is not
  consulted for that launch and produces no model warning for it. Thinking-level settings
  keep applying independently of the model choice.

### Claude compatibility limitations

Definitions written for Claude Code must be adapted; compatibility is deliberately partial:

- **Locations:** only Pi locations are discovered (`.pi/agents/` project scopes from the
  working directory to the Git root, and Pi's user `agents/` directory). `.claude/agents/`
  is never read.
- **Tool names:** Pi tool names only. There is no Claude tool-name translation, and scoped
  permission patterns (`Bash(git*:*)`, `WebFetch(domain:…)`, wildcards) are rejected — add
  Pi denial entries per exact tool instead.
- **Write/shell implications:** an omitted `tools` list inherits write and shell tools
  (`write`, `bash`). Claude habits like relying on a narrower default permission profile do
  not transfer; state read-only intentions with an explicit read-only allowlist.
- **Strict field validation:** unknown fields and unimplemented fields (`skills`) make the
  definition invalid rather than ignored — remove or adapt them when migrating.
- **Model identifiers:** exact `provider/model` strings or `inherit` only; Claude aliases
  such as `sonnet` or `opus` are invalid.
- **Safety boundaries take precedence over any frontmatter value:** subagents cannot
  delegate, retrieve results, block on questions, or otherwise bypass the single-level
  boundary, no matter what their files say.

### Type matching and alias compatibility change

Custom names are matched **exactly first**, then the built-in aliases apply. The speculative `expl` prefix alias for `explore` still works (`expl`, `EXPLORE`, …), so existing calls are unaffected — but it no longer swallows an input that exactly matches a valid custom name, such as a custom type named `Explorer`. Compatibility change: before this, any `expl…` input resolved to the built-in `explore`; if you relied on such an input resolving there but have since defined a custom type with that exact name, the custom type now wins. Unknown or invalid requested types fail with an actionable error — never a silent fallback to `general`.

A custom type without its own fields behaves like `general` tool-wise: it inherits every available Subagent tool, including write and shell tools, minus the fixed safety exclusions (`Agent`, `get_subagent_result`, `question`). Per-project resource loading and the one-level-deep boundary apply exactly as for the built-ins.

## Extension tools inside subagents

The sub-session uses the same resource loader as the parent, so it discovers every installed extension. The two types then differ in how tools reach the model:

- **`general` needs nothing** — it passes no allowlist, so any extension you install (lsp, todo, a future one) is available to it automatically. The only subtractions are the safety exclusions: `Agent`, `get_subagent_result`, `question`.
- **`explore` is an allowlist by design** — that's what makes its read-only property structural rather than promised. `explore` holds the core read tools (plus `subagents.explore.extraTools` / `PI_SUBAGENT_EXPLORE_TOOLS`). Only ever grant **read-only** tools — anything that writes or executes belongs to `general`. Take tools away from `general` with `subagents.general.excludeExtraTools`; the safety exclusions (`Agent`, `get_subagent_result`, `question`) are fixed and not configurable.

**One level deep, enforced:** sub-sessions are created with `excludeTools: ["Agent", "get_subagent_result", "question"]`, so a subagent cannot recursively spawn subagents (the resource loader would otherwise hand it this very extension) and can't block on a question no user will see. Foreground runs return their result inline; only background settles raise a notification.

## Tools

- `Agent({ subagent_type, prompt, description, run_in_background? })` — foreground blocks + returns the bounded result; background returns an id. `subagent_type` accepts the two built-ins or any valid custom type name (discovered names and descriptions are listed in the tool description; definitions are re-read at every launch).
- `get_subagent_result({ agent_id, wait? })` — poll/retrieve a background agent's bounded result.
- `/subagents` — list subagents and status.

Background agents run through a concurrency queue (default 4, `PI_SUBAGENT_CONCURRENCY`).

## Bounded result text

Subagent result text is truncated to a fixed **20,000 UTF-8 bytes** on every delivery
path: foreground `Agent` results and explicit `get_subagent_result` retrieval (the same
bound covers automatic background completions and failed/stopped partial output as those
arrive in later slices).

- The limit is fixed and non-configurable — no setting or environment variable overrides it.
- The beginning of the text is kept, and the cut never splits a UTF-8 character.
- When text is truncated, the result ends with a truncation report stating the original
  and retained byte counts. Run status, failure reasons, and that report sit **outside**
  the limit and are never truncated.
- This deliberately changes previous behavior: foreground `Agent` results used to be
  unbounded.
- There is **no dedicated recovery mechanism** for omitted text — it is not retrievable
  from the run afterwards. For large deliverables (documents, artifacts, datasets),
  instruct the Subagent to write the full content to a file and return a concise summary
  plus the file path. The `Agent` tool's model guidance carries the same instruction.

## Same-turn fan-out

The intended way to run multiple independent same-type **Subagent** tasks in parallel is
to issue multiple foreground `Agent` tool calls in one assistant turn — one call per task,
each with its own `subagent_type`, `prompt`, and `description`. This is called **Same-turn
fan-out**.

Each `Agent` call returns its own independent result, with its own `agent_id`, status,
token count, tool-use count, warnings, and bounded result text (see [Bounded result
text](#bounded-result-text)). You synthesize across sibling results in normal
conversation context.

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

Set an optional reasoning-effort preference for Subagent runs, shared across
types or per type, in foreground or background runs:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json
{
  "subagents": {
    // Shared fallback for any type without its own preference.
    "thinkingLevel": "medium",
    "explore": {
      // Per-type preference wins over the shared level for `explore` only.
      "thinkingLevel": "low",
    },
    "general": {
      "thinkingLevel": "high",
    },
  },
}
```

Project settings override global settings, at each level independently (a
project per-type value beats a global per-type value, and a project shared
value beats a global shared value). Accepted values are Pi's `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`.

### Resolution precedence

1. **Per-type** — `subagents.{explore,general}.thinkingLevel` for the type
   being launched.
2. **Shared** — the top-level `subagents.thinkingLevel` setting.
3. **SDK/settings** — no session override: Pi's own defaults and capability
   adaptation remain in effect.

A malformed candidate warns and falls through to the next level, so a typo in
a per-type value still lets a valid shared value apply. The shared value is
warned about only when it is actually consulted — a valid per-type preference
silences a broken shared one. Thinking and `defaultModel` resolve
independently: configure either or both; a malformed model preference does not
discard valid thinking, or vice versa.

- **Omitted:** no session thinking override; existing SDK/settings defaults and
  capability adaptation remain in effect. Inheriting the Parent model does not
  newly inherit the parent's active thinking level.
- **Explicit `"off"`:** requests disabled thinking, subject to Pi's capability
  adaptation; it is not the same as omission. A per-type `"off"` overrides a
  shared enabled level rather than behaving as absent.
- **Malformed:** warns and behaves as absent, falling through to the next
  level.
- **Valid but unsupported:** Pi adapts the preference for the resolved model,
  without choosing a different model. A warning reports the requested and
  effective levels, including when a non-reasoning model disables thinking.

Warnings appear in tool-result `details.warnings` and, when available, UI
notifications—not in generated Subagent result prose. Thinking warnings name
the setting that held the value; model warnings carry the scope and reference.
Thinking traces are not returned to the parent as result text.

This is opt-in: bundled settings remain unchanged. There is no per-call
thinking parameter, model preset, or token-budget setting.

## Structure

`manager.ts` is a deep `AgentManager` — a concurrency-limited scheduler (`launch` / `getResult` / `list`) that hides the records, queue, and lifecycle events and takes an opaque `exec` thunk (so it's testable with a fake, with no Pi). `index.ts` only wires the tools to it; `runner.ts` does the actual spawn.

## How it spawns (real, via the SDK)

`runner.ts` uses the Pi SDK's `createAgentSession` with an in-memory session and a restricted toolset, runs `session.prompt(task)`, and returns the final assistant text. `explore` gets a read-only toolset + a tailored prompt; `general` inherits the normal toolset and system prompt for the cwd. Not a stub.

Skills reference it "if available", falling back to direct `read`/`grep`/`find`/`ls`.