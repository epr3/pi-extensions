# Pi Extensions — subagents

Domain language for the `packages/subagents` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Subagents Extension package**: Runnable Pi `ExtensionAPI` module under `packages/subagents` whose default export registers delegated subagent launch and result tools.
_Avoid_: Agents package, worker plugin, task extension.

**Subagent**: Child worker spawned by the parent Pi coding agent to handle a delegated task in an isolated run context.
_Avoid_: Agent, worker, child session.

**Subagent type**: Built-in profile defining a **Subagent** role and tool boundary.
_Avoid_: Agent type, profile, mode.

**Subagent run**: Single execution instance of a **Subagent** for one delegated task.
_Avoid_: Agent record, child session, job.

**Subagent stream**: UI-only live progress signal of a foreground **Subagent run** shown inside the parent `Agent` tool row while the run is active.
_Avoid_: Child transcript, nested conversation, streamed result.

**Subagent status card**: Structured partial `Agent` tool-row presentation with stable identity and compact progress markers for a foreground **Subagent run**, not live child assistant prose.
_Avoid_: Title card, live transcript, stream panel.

**Same-turn fan-out**: Parent Pi coding agent pattern of emitting multiple foreground `Agent` tool calls in one assistant turn so sibling **Subagent runs** start concurrently.
_Avoid_: Subagent batch, multi-agent, nested subagents.

**Read-only subagent**: **Subagent** whose allowed tools cannot write files or execute shell commands.
_Avoid_: Safe agent, explore agent.

**Parent model**: Active model of the parent Pi coding agent session that launches a **Subagent**.
_Avoid_: Current model, inherited model.

**Default Subagent model**: Configured model selection, either shared or **Subagent type**-specific, written as an exact `provider/model` reference and used by a **Subagent** run in preference to the **Parent model**.
_Avoid_: Default model, fallback model, child model.

**External web research**: Source-gathering workflow performed by the parent Pi coding agent through web Extension tools, not by a built-in **Subagent type**.
_Avoid_: Researcher subagent, web subagent.

## Relationships

- **Subagents Extension package** registers `Agent` and `get_subagent_result` tools.
- **Subagent** is launched by the parent Pi coding agent.
- **Subagent** has exactly one **Subagent type**.
- **Subagent run** records one **Subagent** execution.
- **Subagent stream** belongs to exactly one foreground **Subagent run** and does not become parent LLM context.
- **Subagent status card** renders the **Subagent stream** as a compact current-activity summary with stable identity, while expanded view shows a bounded readable event log.
- **Same-turn fan-out** creates independent sibling **Subagent runs**, each with its own task prompt, description, stream, result, and failure status.
- Foreground **Subagent runs** launched through **Same-turn fan-out** obey the configured subagent concurrency cap rather than bypassing it.
- **Subagent run** uses its **Subagent type**'s **Default Subagent model** first, then the shared **Default Subagent model**, then the **Parent model**; an unresolvable configured reference is treated as absent but warned.
- `explore` is a **Read-only subagent**; `general` can write.
- **External web research** uses web Extension tools directly from the parent Pi coding agent rather than a dedicated built-in **Subagent type**.
- **Subagent** cannot recursively launch child **Subagents** because subagent tools are excluded from sub-sessions.

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
- "title card" could mean the fixed `Agent` tool title, a live title line, or a transcript panel; resolved: use a **Subagent status card** that keeps the title stable and renders compact progress plus a bounded expanded event log.
- "streaming the title card" could mean live assistant prose in the collapsed card or compact run progress; resolved: collapsed **Subagent status card** shows stable identity plus tool/progress markers only, because assistant prose is unreadable while streaming.
- "multiple subagents of the same type" could mean a new batch API, nested delegation, many background runs, or same-turn tool parallelism; resolved: use **Same-turn fan-out** with repeated foreground `Agent` calls, not a `tasks` batch parameter and not recursive child spawning.
- "aggregate result" could mean an extension-level group record; resolved: each **Subagent run** returns its own result and the parent Pi coding agent synthesizes across sibling results in normal conversation context.
- "Sub-agent" appeared in user-facing labels and descriptions; resolved: keep the compatibility tool name `Agent`, but use **Subagent** prose in tool labels, descriptions, and UX copy.
- "add web tools to subagents" could mean `researcher.extraTools`, a new **Subagent type**, or globally loaded Extension packages; originally resolved with a dedicated researcher allowlist, then superseded: **External web research** is direct parent-agent tool use and the **Subagents Extension package** has no built-in web-research type.
- "prefer `llms.txt`" was specific to the retired researcher workflow; resolved: source-selection rules belong with research skills or web tool guidance, not the **Subagents Extension package** glossary.
- Removing `researcher` could mean an alias, a disabled mode, or deleting the API value; resolved: remove it as a built-in **Subagent type**, fail fast on `subagent_type: "researcher"`, and update repo-owned docs/config references in the same change.
