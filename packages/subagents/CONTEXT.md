# Pi Extensions

Domain language for Pi coding agent extension work in this monorepo.

## Language

**Subagent**: Child worker spawned by parent Pi coding agent to handle delegated task in isolated run context.
_Avoid_: Agent, worker, child session.

**Subagent type**: Built-in profile defining **Subagent**'s role + tool boundary.
_Avoid_: Agent type, profile, mode.

**Subagent run**: Single execution instance of **Subagent** for one delegated task.
_Avoid_: Agent record, child session, job.

## Relationships

- **Subagent** launched by parent Pi coding agent
- **Subagent** has exactly one **Subagent type**
- **Subagent run** records one **Subagent** execution
- **Subagent** may launch child **Subagents** (nesting); depth + parent tracked on **Subagent run**

## Example dialogue

> **Dev:** "Should `Agent` tool create agent or **Subagent**?"
> **Domain expert:** "Call spawned child worker **Subagent**; `Agent` just tool name."

## Flagged ambiguities

- "agent" meant both parent Pi coding agent + spawned child worker; resolved: use **Subagent** for spawned child workers.
- "agent type" for selectable spawned-worker profiles; resolved: use **Subagent type**.
- "agent record" for stored execution state; resolved: use **Subagent run**.
- API labels `Agent` + `agent_id` imply domain concepts; resolved: treat as compat names, prose keeps **Subagent** + **Subagent run**.
- "agents" in filesystem naming reads as parent agents; resolved: in this repo names files defining **Subagent type** behavior.
