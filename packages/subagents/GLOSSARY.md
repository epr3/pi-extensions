# Pi Extensions — subagents

Domain language for the `packages/subagents` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Subagents Extension package**: Runnable Pi `ExtensionAPI` module under `packages/subagents` whose default export registers delegated subagent launch and result tools.
_Avoid_: Agents package, worker plugin, task extension.

**Subagent**: Child worker spawned by the parent Pi coding agent to handle a delegated task in an isolated run context.
_Avoid_: Agent, worker, child session.

**Subagent type**: Built-in or custom definition of a **Subagent** role and tool boundary.
_Avoid_: Agent type, profile, mode.

**Custom Subagent definition**: Markdown file with YAML frontmatter `name` and `description` whose body is a **Subagent**'s system prompt, read fresh on every launch so edits apply to subsequent **Subagent runs** while a running run keeps its launch-time snapshot.
_Avoid_: Agent file, pi-agent markdown, prompt template.

**Subagent definitions directory**: `.pi/agents` directory in a project scope (from the working directory up to the Git root inclusive; outside Git only the working directory) or the `agents` directory in Pi's user agent config dir, scanned recursively for **Custom Subagent definitions**.
_Avoid_: Agents folder, claude agents dir.

**Subagent run**: Single execution instance of a **Subagent** for one delegated task.
_Avoid_: Agent record, child session, job.

**Stop request**: Parent-facing `stop_subagent` operation on one background **Subagent run**: a queued run settles as stopped before it starts and produces no output, a running run is aborted and keeps any captured **Partial assistant output**, an already-terminal run's outcome is unchanged, and the first terminal outcome always wins over a competing completion.
_Avoid_: Kill, cancel row, per-row stop.

**Subagent stream**: UI-only live progress signal of a foreground **Subagent run** shown inside the parent `Agent` tool row while the run is active.
_Avoid_: Child transcript, nested conversation, streamed result.

**Subagent status card**: Structured partial `Agent` tool-row presentation with stable identity and compact progress markers for a foreground **Subagent run**, not live child assistant prose.
_Avoid_: Title card, live transcript, stream panel.

**Compact run row**: Collapsed inline conversation row for one **Subagent run** — Subagent type (exactly what was requested, never rewritten to a built-in it resembles), short task description, a textual state word, the latest started/finished/failed tool marker in words, and the run id once known — that never shows live assistant prose.
_Avoid_: Dashboard, status panel, live view.

**Subagent overview**: On-demand, read-only summary of the current session's **Subagent runs**, complementary to their inline conversation rows.
_Avoid_: Replacement dashboard.

**Activity tail**: Chronological, UI-only tail of at most 50 assistant-text and tool-activity entries of one **Subagent run**, shown on expansion, opening with an explicit omission indicator ("… N earlier entries not shown") whenever earlier entries were dropped, and never entering parent-model context or the run's result.
_Avoid_: Transcript dump, activity log, activity feed.

**Launch receipt**: Finalized background launch row naming the **Subagent type**, the short task description, the run id, and the textual queued state — identifiable evidence a run was started, while the **Attributed completion** stays the authoritative visible outcome.
_Avoid_: Start notification, live updater, receipt card.

**Same-turn fan-out**: Parent Pi coding agent pattern of emitting multiple foreground `Agent` tool calls in one assistant turn so sibling **Subagent runs** start concurrently.
_Avoid_: Subagent batch, multi-agent, nested subagents.

**Read-only subagent**: **Subagent** whose allowed tools cannot write files or execute shell commands.
_Avoid_: Safe agent, explore agent.

**Parent model**: Active model of the parent Pi coding agent session that launches a **Subagent**.
_Avoid_: Current model, inherited model.

**Default Subagent model**: Configured model selection, either shared or **Subagent type**-specific, written as an exact `provider/model` reference and used by a **Subagent** run in preference to the **Parent model**.
_Avoid_: Default model, fallback model, child model.

**Subagent thinking level**: Persistent reasoning-effort preference for a **Subagent run**, independent of its model selection and configurable per **Subagent type** or shared across types.
_Avoid_: Thinking budget, parent thinking, model preset.

**Subagent tool allowlist**: Explicit `tools` list in a **Subagent type** definition — exact available Pi tool names — that replaces inheritance for its **Subagent runs**.
_Avoid_: Tool permissions, scoped pattern, grants.

**Subagent tool denial**: `disallowedTools` list subtracted from a **Subagent type**'s **Subagent tool allowlist** or from inheritance for its **Subagent runs**; it can never re-grant the fixed safety exclusions.
_Avoid_: Blacklist, negative permissions.

**Inherited toolset**: Every tool available to the parent Pi coding agent's sub-session — built-ins and installed extension tools, write and shell included — used by a **Subagent** whose **Subagent type** omits a **Subagent tool allowlist**.
_Avoid_: Default toolset, general tools, read-only default.

**External web research**: Source-gathering workflow performed by the parent Pi coding agent through web Extension tools, not by a built-in **Subagent type**.
_Avoid_: Researcher subagent, web subagent.

**Skill preloading**: Launch-time resolution of a **Custom Subagent definition**'s `skills` frontmatter names through Pi's normal skill discovery and precedence, reading each complete SKILL.md into the **Subagent run**'s initial context; a missing or unreadable skill fails that launch only.
_Avoid_: Skill allowlist, skill injection, skill restriction.

**Result-text limit**: Fixed, non-configurable cap of 20,000 UTF-8 bytes on a **Subagent run**'s result text, keeping the beginning and never splitting a character.
_Avoid_: Output budget, truncation cutoff, context cap.

**Bounded result text**: Result output delivered under the **Result-text limit**, with a truncation report carrying original and retained byte counts; run status and failure reason stay outside it.
_Avoid_: Clipped result, shortened output, trimmed result.

**Partial assistant output**: Assistant text a stopped or failed **Subagent run** captured before its terminal event, bounded under the **Result-text limit** and clearly marked incomplete — or an explicit "none available" statement when nothing was captured; a queued run that never started has none.
_Avoid_: Partial result, recovered output, transcript tail.

**Originating session**: Parent Pi session that launched a **Subagent run**; owns the run and its completion delivery and is the only session the completion may enter.
_Avoid_: Owner runtime, launcher session, host session.

**Attributed completion**: One Pi custom message per terminal background **Subagent run**, delivered to its **Originating session**, naming the run (type, description, id) and terminal status and carrying **Bounded result text** or clearly marked partial output — never live activity, tool transcripts, or hidden reasoning.
_Avoid_: Automatic result, push notification, agent message.

**Delivery-capable mode**: Pi mode whose process can still start a later parent turn after a background run settles (`tui`, `rpc`); `print` and `json` are not, and launch an explicit diagnostic instead of promising delivery. Judged from the Pi mode, never from `hasUI`.
_Avoid_: UI mode, with-UI capability, headless mode.

**Persisted outcome**: Append-only custom session entry (`subagent-outcome-record`) a terminal background Subagent run writes through its Originating session, carrying run identity, terminal status, **Bounded result text** or marked partial output, and the retained **Activity tail** (≤50 entries plus the omission count) — best-effort, since shutdown, replacement, or a crash can prevent the write, and the entry bound is not a byte guarantee.
_Avoid_: Checkpoint, completion cache, outcome backup.

**Branch-local outcome**: **Persisted outcome** visible only on the branch whose history recorded it, reconstructed from the current branch's history and never copied onto sibling branches that hold only the **Launch receipt** — those read "outcome unavailable", which never implies the run is active or was lost from the outcome.
_Avoid_: Cross-branch sync, global outcome, sibling completion.

## Relationships

- **Subagents Extension package** registers `Agent` and `get_subagent_result` tools.
- **Subagent** is launched by the parent Pi coding agent.
- **Subagent** has exactly one **Subagent type**.
- **Subagent run** records one **Subagent** execution.
- **Subagent stream** belongs to exactly one foreground **Subagent run** and does not become parent LLM context.
- **Subagent status card** renders the **Subagent stream** as the **Compact run row** (collapsed: status/stats only) and the **Activity tail** plus authoritative **Result** (expanded), with stable identity in both.
- Status words, tool markers, and omission indicators are plain text — meaning never rides on color or symbols alone, and wrapping preserves the **Compact run row**, the **Activity tail**'s states, and every run id.
- A background **Subagent run** departure leaves a **Launch receipt** on its launch row; the associated **Attributed completion** names the same run id and is the authoritative visible outcome, while a best-effort live row update, if ever used, is not durable or cross-mode.
- **Same-turn fan-out** creates independent sibling **Subagent runs**, each with its own task prompt, description, stream, result, and failure status.
- Foreground **Subagent runs** launched through **Same-turn fan-out** obey the configured subagent concurrency cap rather than bypassing it.
- A **Subagent run** without an explicit definition model uses its **Subagent type**'s **Default Subagent model** first, then the shared **Default Subagent model**, then the **Parent model**; an unresolvable configured reference is treated as absent but warned.
- A **Subagent type** definition's exact `provider/model` model overrides the **Default Subagent model**; `inherit` explicitly selects the **Parent model**; an explicit invalid or unavailable model fails the run instead of falling back.
- `explore` is a **Read-only subagent**; `general` can write.
- `explore` and `general` are reserved **Subagent type** names that **Custom Subagent definitions** cannot shadow.
- **Definition scope precedence** is per-name and never merges: the nearest **Subagent definitions directory** that mentions a name decides whether it is valid, invalid, or conflicted, beating farther project scopes and the user scope; two same-name definitions in one scope make the name unusable, and an invalid nearer definition shadows valid lower-priority ones.
- A **Subagent type** without a **Subagent tool allowlist** runs on the **Inherited toolset**, minus its **Subagent tool denial** list and the fixed safety exclusions — write and shell tools included; an explicitly read-only **Subagent type** must declare a read-only **Subagent tool allowlist**.
- Every **Subagent tool allowlist** entry and **Subagent tool denial** must be an exactly available Pi tool name; scoped patterns, wildcards, and unavailable names are rejected, and an empty effective toolset makes the definition's run fail rather than launch.
- **External web research** uses web Extension tools directly from the parent Pi coding agent rather than a dedicated built-in **Subagent type**.
- **Subagent** cannot recursively launch child **Subagents** because the fixed safety exclusions (`Agent`, `get_subagent_result`, `stop_subagent`, `question`) are removed from every sub-session, custom allowlists included — the single-level boundary is structural, not a hidden-parameter convention.
- A **Stop request** produces exactly one terminal outcome: a queued run's stop means no **Partial assistant output** ever exists for it, a running run's stop keeps what was captured, and no run has two terminal statuses in stop/completion races.
- Every **Subagent run** delivers **Bounded result text** — foreground returns, explicit `get_subagent_result` retrieval, and automatic completions and failed/stopped partials — so the parent never sees an unbounded answer.
- **Skill preloading** resolves names the same way the **Subagent run**'s own skill discovery does, so a preloaded skill and an on-demand read of the same name come from the same file; preloading adds startup instructions, never permissions — other skills stay discoverable and readable.
- A missing or unreadable skill makes only the declaring **Custom Subagent definition**'s launch fail; unrelated valid **Subagent types** stay usable.
- Omitted **Bounded result text** is not recoverable; a large deliverable is instead written to a file by the **Subagent**.
- A background **Subagent run** belongs to its **Originating session**; an **Attributed completion** is delivered there at most once during normal operation, queued as a non-interrupting follow-up while the parent is busy and delivered as a turn-starting message when idle.
- **Originating session** shutdown or replacement stops queued and running **Subagent runs**, deactivates delivery, and never lets a replacement session receive an **Attributed completion** it did not own.
- A **Subagent run** in a mode that is not a **Delivery-capable mode** reports an explicit diagnostic at launch instead of promising automatic delivery; explicit `get_subagent_result` retrieval remains available everywhere.
- Every terminal background **Subagent run** in its **Originating session** attempts one **Persisted outcome**, distinct from the **Attributed completion**: delivery can be withheld while the outcome persists, and a shutdown, replacement, or crash can prevent the write without affecting delivery guarantees.
- A **Branch-local outcome** is reconstructed only from the current branch's history; on revisit nothing redelivers or starts a model turn, and a **Launch receipt** without its **Persisted outcome** reads "outcome unavailable", never active or failed, with its **Activity tail** unavailable too.

## Example dialogue

> **Dev:** "Should `Agent` create an agent or a **Subagent**?"
> **Domain expert:** "Call the spawned child worker a **Subagent**; `Agent` is only the tool name."

## Flagged ambiguities

- "agent" meant both parent Pi coding agent and spawned child worker; resolved: use **Subagent** for spawned child workers.
- "agent type" meant selectable spawned-worker profiles; resolved: use **Subagent type**.
- "agent record" meant stored execution state; resolved: use **Subagent run**.
- API labels `Agent` and `agent_id` imply domain concepts; resolved: treat them as compatibility names while prose keeps **Subagent** and **Subagent run**.
- "agents" in filesystem naming reads as parent agents; resolved: in this repo it names files defining **Subagent type** behavior.
- "default model" could mean a fallback after the **Parent model**; resolved: **Default Subagent model** overrides the **Parent model** and the parent remains fallback.
- "a default model" could mean only one shared setting; resolved: support a shared **Default Subagent model** plus **Subagent type**-specific overrides.
- **Default Subagent model** reference shape could mirror Pi root settings or CLI fuzzy matching; resolved: use an exact `provider/model` string in subagents settings.
- Invalid **Default Subagent model** config could fail a **Subagent run**; resolved: treat it as absent, fall back to the **Parent model**, and surface a warning outside the subagent result text.
- "streaming a subagent" could mean adding a child transcript to parent context; resolved: **Subagent stream** is UI-only progress, while the final subagent result remains the parent-context payload.
- "title card" could mean the fixed `Agent` tool title, a live title line, or a transcript panel; resolved: use a **Subagent status card** that keeps the title stable and renders the **Compact run row** plus the bounded **Activity tail**.
- "streaming the title card" could mean live assistant prose in the collapsed card or compact run progress; resolved: the **Compact run row** shows stable identity plus textual state and tool markers only, because assistant prose is unreadable while streaming.
- "a custom type's row" could show a built-in the name resembles (e.g. a custom `explorer` displayed as `explore`); resolved: rows display the requested type exactly, with only exact built-in names canonicalized, because rendering cannot read the definition directories without making redraws nondeterministic and launch-time validation already rejects unsupported names.
- "receipt row" could mean a live-updated background sheet; resolved: the finalized launch row is a static **Launch receipt** and the **Attributed completion** is the authoritative outcome — live row updates are best-effort at best and never promised.
- "multiple subagents of the same type" could mean a new batch API, nested delegation, many background runs, or same-turn tool parallelism; resolved: use **Same-turn fan-out** with repeated foreground `Agent` calls, not a `tasks` batch parameter and not recursive child spawning.
- "aggregate result" could mean an extension-level group record; resolved: each **Subagent run** returns its own result and the parent Pi coding agent synthesizes across sibling results in normal conversation context.
- "Sub-agent" appeared in user-facing labels and descriptions; resolved: keep the compatibility tool name `Agent`, but use **Subagent** prose in tool labels, descriptions, and UX copy.
- "add web tools to subagents" could mean `researcher.extraTools`, a new **Subagent type**, or globally loaded Extension packages; originally resolved with a dedicated researcher allowlist, then superseded: **External web research** is direct parent-agent tool use and the **Subagents Extension package** has no built-in web-research type.
- "prefer `llms.txt`" was specific to the retired researcher workflow; resolved: source-selection rules belong with research skills or web tool guidance, not the **Subagents Extension package** glossary.
- Removing `researcher` could mean an alias, a disabled mode, or deleting the API value; resolved: remove it as a built-in **Subagent type**, fail fast on `subagent_type: "researcher"`, and update repo-owned docs/config references in the same change.
- "an omitted `tools` field in a definition could mean read-only by default or full inheritance"; resolved: it means the **Inherited toolset** including write and shell tools — a read-only **Subagent type** must declare an explicit read-only **Subagent tool allowlist** (Claude-style omitted-allowlist assumptions do not transfer).
- "allowlisting a subagent tool like `Agent` in a definition" could mean granting nested delegation; resolved: the fixed safety exclusions (`Agent`, `get_subagent_result`, `stop_subagent`, `question`) always win — the name is removed from the run's toolset regardless of the frontmatter value.
- "`model: inherit` in a definition could mean inherit everything from the parent run"; resolved: it selects only the **Parent model** for that **Subagent type**; thinking level and settings obey their own rules.
- "expl" was a speculative prefix alias that could capture a distinct custom name such as `Explorer`; resolved: exact matches against valid custom **Subagent type** names win before built-in aliasing, so the `expl` alias still applies (`expl`, `EXPLORE`, …) but never eats an exact custom name.
- "merge definitions across scopes" could mean per-name precedence or combining fields from multiple **Subagent definitions directories**; resolved: per-name precedence without merging, so a nearer scope cannot silently inherit a farther scope's prompt.
- "unknown type" could mean silently delegating to `general` or failing; resolved: unknown, invalid, and shadowed requested types fail with an actionable error that names the currently valid custom types.
- "skills" on a **Custom Subagent definition** could mean a preload list or a skill-access allowlist; resolved: **Skill preloading** only puts the listed skills' complete instructions into the initial context — it is not an access restriction, and listing skills is exactly as safe as the Subagent reading them itself.
- "matching a skill" could mean directory name or resolved skill name; resolved: names match Pi's resolved skill names (frontmatter `name`, falling back to the directory name) under Pi's own precedence, with project scope beating user scope for collided names.
- "automatic completion" could mean the parent learns a background outcome with no assurance at all; resolved: one **Attributed completion** per run during normal operation, explicitly not promised through queue clearing, shutdown, replacement, or crashes, with explicit retrieval kept.
- "can the parent still receive results" could be inferred from `ctx.hasUI`; resolved: **Delivery-capable mode** is judged from the Pi mode (`tui`/`rpc` can continue; `print`/`json` cannot), never from UI availability.
- "persisting an outcome for revisit" could mean copying a completion to every branch holding its receipt; resolved: **Branch-local outcome** — reconstruction reads only the current branch's history, and a receipt-less sibling shows its own "outcome unavailable" rather than borrowing another branch's record.
- "the 50-entry activity bound" could mean a storage size guarantee or crash-proof recovery; resolved: the bound is an entry count, session storage contains the retained **Activity tail** in full, and a shutdown or crash racing the write leaves the receipt with no **Persisted outcome** — no crash-proof or exactly-once claim.