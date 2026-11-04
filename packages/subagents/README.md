# subagents — explore + general + custom Subagent types (Pi extension, TypeScript)

Adds two subagent types for context hygiene. The `Agent` tool surface follows the conventions of [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

## Agent types

| Type      | Tools                                                                                                                                                 | Read-only | Use                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| `explore` | read, grep, find, ls, and codemode by default; **extra read-only tools are granted in settings** (the shipped `settings.json` grants the `lsp_*` set) | yes       | codebase discovery — the suite's default for context-gathering |
| `general` | everything discovered: all built-ins **and all installed extension tools** (lsp, todo, …), minus the exclusions below                                 | no        | off-context work that writes (e.g. parallel interface designs) |

No Claude-style `plan` or `general-purpose` built-ins — the package's built-ins are exactly `explore` and `general` — no steering, no resume, no nested delegation; all deliberately omitted. Custom Subagent types are supported via `.pi/agents` definition files (see below). **External web research** is also deliberately outside this package: the parent Pi coding agent uses web Extension tools such as `web_search` and `web_fetch` directly, not through a built-in Subagent type.

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
- Frontmatter accepts `name`, `description`, `skills` (a YAML list of Pi skill names to preload — see [Skill preloading](#skill-preloading)), plus `tools`, `disallowedTools`, and `model` (see below). Unknown fields are **rejected explicitly** — never silently ignored, so unimplemented settings are never mistaken for guarantees.
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
  `disallowedTools` and the fixed safety exclusions. An omitted allowlist is _not_
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
  `get_subagent_result`, `stop_subagent`, or `question`, those tools are removed from the
  Subagent session: no custom type can gain nested delegation, result retrieval, stopping,
  or blocking questions.

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
- **Strict field validation:** unknown fields (anything other than `name`, `description`,
  `tools`, `disallowedTools`, `model`, and `skills`) make the definition invalid rather
  than ignored — remove or adapt unsupported fields (`mode`, `permission-mode`, scoped
  tool patterns, model aliases) when migrating.
- **Model identifiers:** exact `provider/model` strings or `inherit` only; Claude aliases
  such as `sonnet` or `opus` are invalid.
- **Safety boundaries take precedence over any frontmatter value:** subagents cannot
  delegate, retrieve results, block on questions, or otherwise bypass the single-level
  boundary, no matter what their files say.

### Type matching and alias compatibility change

Custom names are matched **exactly first**, then the built-in aliases apply. The speculative `expl` prefix alias for `explore` still works (`expl`, `EXPLORE`, …), so existing calls are unaffected — but it no longer swallows an input that exactly matches a valid custom name, such as a custom type named `Explorer`. Compatibility change: before this, any `expl…` input resolved to the built-in `explore`; if you relied on such an input resolving there but have since defined a custom type with that exact name, the custom type now wins. Unknown or invalid requested types fail with an actionable error — never a silent fallback to `general`.

A custom type without its own fields behaves like `general` tool-wise: it inherits every available Subagent tool, including write and shell tools, minus the fixed safety exclusions (`Agent`, `get_subagent_result`, `stop_subagent`, `question`). Per-project resource loading and the one-level-deep boundary apply exactly as for the built-ins.

### Compatibility and migration impacts

Deliberate behavior changes to plan for when updating existing workflows and migrated
Claude-style files (details in the sections above and in the package ADRs):

- **Result bounding is new.** Foreground `Agent` results used to be unbounded; they are
  now capped at a fixed 20,000 UTF-8 bytes with no recovery path for omitted text.
  Workflows that assumed full-length foreground output should have the Subagent write
  large deliverables to files.
- **Built-in alias change.** The `expl` prefix alias still matches `explore` (and its
  case variants), but an input that **exactly** matches a valid custom type name now
  launches the custom type instead.
- **Runs are session-owned.** Runs belong to the session that launched them. On
  `session_shutdown` (quit, `new`, `resume`, `fork`, reload) queued and running runs are
  stopped and delivery is deactivated; a replacement session never receives completions
  from runs it did not own. Plan long-running background work around the owning
  session's lifetime.
- **Mode and version limits.** Automatic background completion is promised only where
  Pi's process keeps the conversation running (`tui`, `rpc`). `print` and `json` modes
  get an explicit diagnostic at launch and must retrieve explicitly. Lifetime,
  persistence, and delivery behavior are built on the supported `pi-coding-agent` API
  surface noted in the package ADRs; feasibility evidence is documentation/source
  analysis plus a session-API integration test, not an end-to-end run against every
  mode.
- **Storage privacy.** The UI-only activity tail (≤50 entries) is stored in session
  files as part of each persisted outcome, where anything in `~/.pi` session storage is
  already visible. The 50-entry bound is an entry count, not a byte-size guarantee, and
  a shutdown or crash can prevent the write.
- **No crash-proof or exactly-once delivery.** Queue clearing, abort, shutdown,
  replacement, or a crash can prevent persistence or delivery; at most one completion
  per run is delivered during normal operation; revisit never redelivers a persisted
  outcome.

### Skill preloading

A definition may list Pi skills to start with:

```markdown
---
name: code-reviewer
description: Reviews diffs with extra care for API changes
skills:
  - code-review
  - house-style
---

You are a code review Subagent. The body is the system prompt; the listed
skills' complete instructions are preloaded into your initial context.
```

- Names resolve through **normal Pi skill discovery and precedence** — the
  same skill loader the sub-session uses: default locations (user skills
  such as `~/.pi/agent/skills` and project `<cwd>/.pi/skills`) plus
  settings-, CLI-, and package-derived skill paths, matched against Pi's
  resolved skill names (the skill's frontmatter `name`, not its directory
  name) with Pi's own precedence for collided names.
- Each resolved skill's **complete `SKILL.md`** (frontmatter included) is
  preloaded into the Subagent's initial system-prompt context. Skill files are
  re-read on every launch, like definitions, so edits apply to subsequent runs.
- A **missing or unreadable** skill makes that launch fail with an actionable
  error naming the skill (and its path, when found but unreadable) before any
  session starts. Unrelated definitions — and definitions without a `skills`
  list — stay fully usable.
- **Preloading is not an access restriction.** The sub-session still runs the
  normal skill loader, so any other installed skill remains discoverable and
  readable on demand. Preloaded content is a startup convenience (the
  Subagent starts with complete instructions instead of reading them
  mid-task), not a permission boundary; it neither grants nor removes tool
  access.
- `skills` must be a YAML list of non-empty names; anything else (a plain
  string, a non-string entry) is a definition error diagnosed at discovery,
  and the definition cannot launch.

## Extension tools inside subagents

The sub-session uses the same resource loader as the parent, so it discovers every installed extension. The two types then differ in how tools reach the model:

- **`general` needs nothing** — it passes no allowlist, so any extension you install (lsp, todo, a future one) is available to it automatically.

Every Subagent with codemode available — built-in or custom, whether the toolset is allowlisted or inherited — gets the same tool guidance: prefer codemode when a task needs several calls, when one call's result feeds the next, or when output must be filtered; use the direct tools for straightforward single calls. The only subtractions are the safety exclusions: `Agent`, `get_subagent_result`, `stop_subagent`, `question`.

- **`explore` is an allowlist by design** — that's what makes its read-only property structural rather than promised. `explore` holds the core read tools plus codemode (for batching/filtering those calls), and `subagents.explore.extraTools` / `PI_SUBAGENT_EXPLORE_TOOLS` adds more. If an optional granted tool is rejected at session creation, the allowlist degrades to the core reads and codemode — codemode is only dropped if it is itself unavailable. Only ever grant **read-only** tools — anything that writes or executes belongs to `general`. Take tools away from `general` with `subagents.general.excludeExtraTools`; the safety exclusions (`Agent`, `get_subagent_result`, `stop_subagent`, `question`) are fixed and not configurable.

**One level deep, enforced:** sub-sessions are created with `excludeTools: ["Agent", "get_subagent_result", "stop_subagent", "question"]`, so a subagent cannot recursively spawn subagents (the resource loader would otherwise hand it this very extension), retrieve or stop runs, or block on a question no user will see. Foreground runs return their result inline; background settles deliver one attributed completion message (see [Background outcome delivery](#background-outcome-delivery)).

## Tools

- `Agent({ subagent_type, prompt, description, run_in_background? })` — foreground blocks + returns the bounded result; background returns an id. `subagent_type` accepts the two built-ins or any valid custom type name (discovered names and descriptions are listed in the tool description; definitions are re-read at every launch).
- `get_subagent_result({ agent_id, wait? })` — poll/retrieve a background agent's bounded result. The model-facing text names the run; the row shows a compact status head (`wait: true` shows live `queued`/`running` while it polls) with the full text behind expansion.
- `stop_subagent({ agent_id })` — stop one queued or running background run (see [Stopping background runs](#stopping-background-runs)).
- `/subagents` — open the [Subagent overview](#subagent-overview-subagents)
  (read-only, scrollable) in the TUI; a textual status listing elsewhere.

Background agents run through a concurrency queue (default 4, `PI_SUBAGENT_CONCURRENCY`).

## Background outcome delivery

Background runs report their outcome to the originating parent session automatically —
one **attributed completion** per run during normal operation, no polling required.
Explicit retrieval with `get_subagent_result` remains available either way.

- The completion is a Pi custom message (`customType: "subagent-outcome"`). Its text
  names the Subagent type, the short task description, the run id, and the terminal
  status (`completed`, `failed`, or `stopped`), and carries the bounded result — or,
  for stopped/failed runs, the available assistant text clearly marked incomplete, or
  an explicit statement that no partial output exists. Structured attribution (run id,
  type, status, counts) rides in the message `details`, not in the model-facing text.
- If the parent is busy (between an agent run start and its full settle), the
  completion queues as a non-interrupting follow-up of the current turn. If the parent
  is idle, the completion starts a parent turn. The busy/idle choice is taken from
  Pi's own agent lifecycle events — never inferred from UI availability (`hasUI`).
- Delivery is bound to the originating session. On `session_shutdown` (quit, `new`,
  `resume`, `fork`, or reload) queued and running runs are stopped, delivery is
  deactivated, and cleanup is idempotent; a replaced session never receives
  completions from runs it did not own, and Pi's stale-`ctx` errors after replacement
  are treated as cancellation, not surfaced as failures.
- Delivery is not guaranteed through everything that can end a turn: queue clearing,
  abort, shutdown, replacement, or a crash can prevent it, and runs stopped by
  session shutdown themselves never deliver (their owner is gone). This is
  **at most one delivery per run during normal operation** — not crash-proof,
  not exactly-once, and there is no automatic redelivery.
- In Pi `print` and `json` modes the process exits after the initial prompt, so
  automatic delivery of a later completion cannot be promised. Background launches
  in those modes say so explicitly — in the launch result text and as
  `details.delivery: { promised: false, mode: "print" }` — and point at explicit
  retrieval. `tui` and `rpc` keep the conversation running and keep delivery
  promised; the distinction follows the Pi mode, not `hasUI`.
- Completions never contain live activity, tool transcripts, or hidden reasoning —
  only the bounded final/partial result text under the shared
  [20,000-byte limit](#bounded-result-text).

### Stopping background runs

`stop_subagent({ agent_id })` targets **one** queued or running background run — it is a
parent-facing operation, never a per-row control:

- **Queued runs never start.** A stop on a queued run removes it from the queue and
  settles it as `stopped` before it begins — no session is created and there is no
  generated output (the record says `Stopped by request before it started`, with no
  partial assistant output).
- **Running runs are aborted.** Assistant text captured before the stop is returned as
  clearly marked incomplete partial output; if none was captured, the response explicitly
  says no partial output is available instead of staying ambiguous. Partial text is
  bounded by the same shared [20,000-byte limit](#bounded-result-text).
- **Already-terminal runs answer, not change.** A stop on a completed, failed, or
  already-stopped run reports why the stop did not apply — `already completed before the
stop request`, `already failed with: …`, `was already stopped` — and leaves the outcome
  exactly as it was. An unknown id is an actionable error — nothing is stopped.
- **First terminal outcome wins.** A stop racing the run's own completion or failure
  resolves to whichever terminal event landed first; later candidates are ignored, so
  there is exactly one terminal status per run.
- **Foreground runs are not stopped this way.** `stop_subagent` refuses them: cancel the
  `Agent` tool call instead. Parent cancellation stops the foreground run, and its
  assistant text follows the same partial/missing-output contract as background stops;
  where the interrupted call cannot return text, none is promised.

Stopped runs still deliver exactly one attributed completion (status `stopped`) during
normal operation — the stop changes the outcome, it does not remove it.

### Persistence and revisit

Terminal background outcomes persist for normal session revisit — independently of
delivery:

- When a background run settles, one append-only custom session entry
  (`customType: "subagent-outcome-record"`) is appended through the originating
  session's `pi.appendEntry`. It carries the run identity, terminal status, the
  bounded result text (or the clearly marked partial output, plus the failure or
  stop reason), and the retained Activity tail — at most 50 entries plus the
  omission count. Persistence succeeds even when delivery is withheld; a crashed
  process or a shutdown racing the write can prevent it (there is no claim of
  crash-proof persistence or exactly-once behavior).
- On revisit, outcomes reconstruct from the CURRENT branch's history
  (`getBranch()`): a branch shows only completions its own history contains —
  never a sibling's completion because both carry the same receipt, and no
  completion is copied down for sibling receipts.
- A launch receipt without a persisted completion reads **outcome unavailable**
  — never showing the run as active or failed, and its activity is unavailable
  too. An outcome persisted but not delivered stays inspectable; revisit never
  automatically redelivers it and never starts a model turn.
- Where it appears:
  - The [Subagent overview](#subagent-overview-subagents) (`/subagents`) shows
    background outcomes on this branch from session history — the textual
    fallback listing states them in detail (status, outcome head,
    delivered/not delivered, activity counts).
  - `get_subagent_result` with a revisited id falls back to the branch history:
    the persisted outcome is returned again via explicit retrieval, a
    receipt-only run answers "outcome unavailable", and the retained activity is
    summarized by counts only — its content stays out of model-facing text.
- Privacy and guarantees: session storage contains the retained activity tail in
  full entries. The 50-entry bound is an entry count, **not a byte-size
  guarantee** — entries vary in size. Shutdown, replacement, or a crash can
  prevent both the write and later delivery; a receipt that lost its write is
  indistinguishable from a run that never showed a completion.

- The completion renders through a message renderer registered for the
  `subagent-outcome` custom type as a bordered result card. Its collapsed
  headline names the run and its tool/token stats
  (`Subagent outcome — general "task" [run sa_x] — completed`); expanding the
  same card reveals the authoritative body — the bounded result, or the clearly
  marked partial output, or the explicit no-partial statement. Failed/stopped
  headlines also carry the reason.

## Run presentation

Runs are presented inline in the parent conversation — no persistent dashboard,
no per-row stop control — using compact tool rows for identity and state, an
expanded activity tail for inspection, and distinct outcome rows. An on-demand
**Subagent overview** is always available through `/subagents` — a read-only
summary that complements, and never replaces, these inline rows (see the
[Subagent overview](#subagent-overview-subagents) section below).

### Compact rows (identity and state)

- The `Agent` row is a bordered card. Its top border names the tool (`Agent`,
  plus `background` when launched with `run_in_background`) and its header line
  carries `<type> · "<description>"`. The displayed type is what the parent
  requested — **custom names are never rewritten to a built-in they resemble**:
  a custom type named `explorer` is displayed as `explorer`, not `explore`
  (only exact built-in names canonicalize, case-insensitively). Launch-time
  validation still rejects unsupported types.
- While a foreground run is active, its result row shows the textual running
  state plus the latest tool lifecycle marker **in words** —
  `◷ running — ▶ started grep`, `◷ running — ✓ finished read`,
  `◷ running — ✗ failed bash` — or the neutral `◷ running` before any tool has
  moved. It never shows live assistant prose: expand for the text tail instead.
- Once the run has an id, the compact row includes it —
  `◷ running [run sa_1_ab] — ✓ finished read` — so sibling rows from same-turn
  fan-out stay attributable to their own runs. Background rows (the receipt and
  the attributed completion) always carry the run id.
- Nothing important rides on color or symbols alone: every state and marker is
  also stated in words, and all of it is plain text that wraps, so identity and
  status survive narrow terminals.
- Outcomes of completed foreground runs render inline in the same card:
  collapsed shows `✓ completed · N tool uses · N tok`; expanding adds
  `Activity` and `Result`. A failed foreground run surfaces its error — reason
  included — distinctly from a completed answer; a parent-cancelled foreground
  run stops leaking updates and its partial text follows the same
  partial/missing-output contract as background stops. Keeping the conversation
  legible is the point: conversation rows stay the primary detailed record —
  there is no persistent aggregate dashboard and no row-specific stop button.
  The on-demand `/subagents` overview is a read-only summary, not a place where
  rows are driven.

### Expanded activity tail (per run)

- Expanding an active run shows a chronological, **UI-only** tail of the last
  50 entries: assistant text plus tool-activity lines
  (`▶ started bash` / `✓ finished read` / `✗ failed bash`).
- When earlier entries were dropped, the tail opens with an explicit omission
  indicator: `… N earlier entries not shown`.
- Hidden reasoning is always excluded — the runner never forwards thinking
  deltas into the tail, and partial output promoted into results is assistant
  prose only.
- Activity stays out of model-facing content: the tail lives in the row's
  `details` during streaming and is retained, bounded, in the finalized row's
  details. Expansion of a completed row shows that retained activity separately
  from the clean result (or the background receipt).

### Background receipts and attributed completions

The finalized background launch row is a **receipt**: its card names the type,
short task description, run id, and textual state —
`Subagent general "refactor the parser" [run sa_7_zzz] — status: queued.
Retrieve the result with get_subagent_result, or stop the run with
stop_subagent.`

The authoritative visible outcome is later the **attributed completion**
message (see [Background outcome delivery](#background-outcome-delivery)),
associated by run id. A best-effort live update of the receipt row is
deliberately **not** implemented — such updates could never be durable or
cross-mode in Pi anyway; the persisted completion message, explicit retrieval,
and the `subagents` status command are the reliable paths.

### Subagent overview (`/subagents`)

`/subagents` opens the **Subagent overview**: a read-only, scrollable overlay
(one run per row). It complements the inline conversation rows — it never
replaces them, never mutates anything, and never redelivers an outcome.

- In the TUI, the command opens the overlay; Esc or Enter dismisses it. Long
  lists scroll; no run controls (stop, retry, launch) exist here.
- Each row names the run id, **Subagent type**, short task description, and a
  textual state — `queued`, `running`, `completed`, `failed`, `stopped`, or
  `outcome unavailable` — in words, never by color or symbol alone.
- Rows order active runs first, then terminal runs, newest first within each
  group. Runs from the current session and reconstructed current-branch
  history are deduped by run id, the live state wins for a run both know.
- Reconstruction keeps **Branch-local outcome** semantics: a run whose
  outcome is not on the current branch's history shows `outcome unavailable`
  and is never classified as active merely because its launch receipt
  exists; another branch's outcome is never shown here.
- The overview updates while it stays open: run state changes — queued,
  running, and terminal transitions, reordering, a returned empty state, and
  an outcome becoming available on the branch — re-render it without closing
  and reopening. The updating is keyed to the owning session: a session
  shutdown or replacement deactivates it before that session's runs settle,
  so a dying session's terminal states never appear in its overview or in a
  replacement session's.
- When neither the session nor the branch history has Subagent runs, the
  overview says so explicitly — it does not render an empty shell.
- Where a TUI overlay is unavailable (print / json mode), the command keeps
  the textual notification listing instead.

The overview revises an earlier design note that restricted Subagent run
presentation to inline rows only: it is a bounded, on-demand summary, so the
inline rows remain the durable per-run record through the conversation while
`/subagents` answers "what is running right now — and what ran on this
branch".

## Bounded result text

Subagent result text is truncated to a fixed **20,000 UTF-8 bytes** on every delivery
path: foreground `Agent` results, explicit `get_subagent_result` retrieval, automatic
background completions, and failed/stopped partial output — one shared limit.

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
- **Not a replacement for background delivery.** Foreground fan-out blocks and returns
  results inline. Background runs report their outcome automatically via one attributed
  completion; `run_in_background: true` + `get_subagent_result` remains the pattern for
  explicitly retrieving or inspecting a background run on demand.
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

A custom Subagent definition's own `model` frontmatter (exact `provider/model` or
`inherit`) overrides all three of these levels — see [Custom Subagent types →
Model](#model-model).

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