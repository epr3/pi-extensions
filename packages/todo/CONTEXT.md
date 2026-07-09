# Pi Extensions — todo

Domain language for the `packages/todo` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Todo Extension package**: Runnable Pi `ExtensionAPI` module under `packages/todo` whose default export registers persistent checklist read and write tools.
_Avoid_: Todo package, task plugin, planning extension.

**Todo list**: Ordered checklist representing the agent's current work breakdown for a plan, issue, or implementation slice.
_Avoid_: Task list, plan, checklist.

**Todo item**: Single actionable step in a **Todo list** with content and status.
_Avoid_: Task, bullet, step.

**Current Todo item**: The single **Todo item** in a valid **Todo list** whose **Todo status** is `in_progress`, or none when no work is active.
_Avoid_: Working todo, active task, current task.

**Todo status**: State of a **Todo item**, one of `pending`, `in_progress`, or `completed`.
_Avoid_: Progress, state, phase.

**Session todo state**: Reconstructed **Todo list** stored through tool-result details across session events.
_Avoid_: Memory, persisted todos, saved plan.

**Collapsed Todo result**: Compact user-facing `todo_write` or `todo_read` result rendering that remains visible without expanding the tool call.
_Avoid_: Summary row, compact UI, todo badge.

## Relationships

- **Todo Extension package** registers `todo_write` and `todo_read` tools.
- **Todo list** contains zero or more **Todo items**.
- **Todo item** has exactly one **Todo status**.
- **Current Todo item** is derived from **Todo status** `in_progress`, not stored as an independent selector.
- A valid **Todo list** keeps at most one **Todo item** in `in_progress`.
- A malformed **Todo list** with multiple `in_progress` **Todo items** has no single **Current Todo item** and surfaces all active candidates as invalid workflow state.
- **Session todo state** survives reloads by reconstructing from the session branch.
- **Collapsed Todo result** shows the **Current Todo item** when exactly one **Todo item** is `in_progress`, keeps the invalid-state warning when multiple are `in_progress`, and otherwise stays a compact progress summary.

## Example dialogue

> **Dev:** "Can I mark two implementation steps as in progress?"
> **Domain expert:** "No — the **Todo list** should keep one **Todo item** with **Todo status** `in_progress`."

## Flagged ambiguities

- "todo" can mean either the package or a single task; resolved: use **Todo Extension package** for the runtime package and **Todo item** for one step.
- "plan" can mean the user's design or the checklist; resolved: use **Todo list** only for the tool-managed checklist.
- "exactly one in progress" could mean rejecting a malformed write; resolved: multiple `in_progress` **Todo items** are invalid workflow state surfaced as a warning so the agent can repair the **Todo list**.
- "current" or "working" todo means the **Current Todo item** derived from `in_progress`; resolved: it is reported explicitly by read/write results and the **Collapsed Todo result** but not stored as a separate selector.
