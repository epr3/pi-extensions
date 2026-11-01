# Use Hidden Agent Tool Params for Nesting Identity

> **Status: SUPERSEDED (2026-11-01) — see `2026-11-01-single-level-subagent-boundary.md`.**
> The mechanism described here was never shipped. There is no hidden `_parent_id`
> parameter, no depth accounting, no `plan` or `general-purpose` built-in, and no
> `allowNestedSubagents`/`maxSubagentDepth` policy surface. The shipped decision is the
> opposite of bounded nesting: delegation is single-level by construction, enforced by
> removing the subagent tools from every sub-session. This ADR is kept as record only.

Nesting policy identifies calling Subagent via hidden Agent tool param (`_parent_id`) injected into Subagent's system prompt, echoed by LLM on child spawn; the built-in types named here beyond shipped reality (`plan`, `general-purpose`) never existed in the Subagents Extension package, whose only built-ins are `explore` and `general`. `createAgentSession()` returns session whose active tool set restricted via `setActiveToolsByName()`: drops `Agent` for `plan`/`explore` and for `general-purpose` when `allowNestedSubagents` is false or `depth >= maxSubagentDepth`. Executor looks up parent in AgentManager, computes new run's `parentId` + `depth`. LLM = trusted courier for echoed parent ID. Hard to reverse once tests/clients assume hidden-param contract. Surprising — hidden tool params unusual; tool filter alone is user-visible effect. Trade-off: clean local enforcement vs wait for upstream Pi SDK to add `ctx.parentSubagentId`. Choose hidden params now to ship boundary without blocking on SDK; accept LLM as trusted courier.