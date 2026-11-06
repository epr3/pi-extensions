# todo — Checklist tool (Pi extension, TypeScript)

Adds `todo_write` / `todo_read` (Pi omits Claude Code's TodoWrite) so the agent can break an issue into steps or a plan into slices and track progress. State lives in tool-result `details` and is reconstructed from the active session branch on both `session_start` (startup, reload, new, resume, fork) and `session_tree` (`/tree` navigation, which fires no `session_start`), so it survives turns, reloads, and branch switches.

`todo_write` replaces the whole list; `todo_read` returns the current one. Status ∈ `pending` / `in_progress` / `completed`. Keep at most one item `in_progress` at a time: an empty list or an all-completed list is valid.

When several items are `in_progress`, both tools still return the list but append an advisory warning line to the plain-text `content` naming the invalid workflow state, and `details` carries the active candidates instead of a single current item. The warning is advisory, not a rejection — repair the list with the next `todo_write`. `details` semantics are unchanged by the warning.

The warning line is appended, so consumers that match whole plain-text results exactly should switch to prefix or line matching; the existing prefix (`(warning: invalid workflow state — N items in_progress`) is preserved.

`to-issues` uses it for the slice breakdown; `resolve-issue` for implementation steps. Referenced "if available".