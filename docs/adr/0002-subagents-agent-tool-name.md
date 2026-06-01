# Keep the Subagent Spawning Tool Named Agent

Subagents extension exposes spawning tool as `Agent` even though repo tools use lowercase (e.g. `edit`). `Agent` preserves Claude Code mental model + reference compat. `get_subagent_result` stays lowercase snake_case — already named that way in plan and reference.
