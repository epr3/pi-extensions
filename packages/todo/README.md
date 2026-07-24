# todo — Checklist tool (Pi extension, TypeScript)

Adds `todo_write` / `todo_read` (Pi omits Claude Code's TodoWrite) so the agent can break an issue into steps or a plan into slices and track progress. State lives in tool-result `details` and is reconstructed from the session branch on `session_start`, so it survives turns, reloads, and tree navigation. Status ∈ `pending` / `in_progress` / `completed`; keep one `in_progress`.

`to-issues` uses it for the slice breakdown; `resolve-issue` for implementation steps. Referenced "if available".