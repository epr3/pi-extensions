# Keep Foreground Subagent Streams UI-Only

Foreground **Subagent runs** stream live progress into the parent `Agent` tool row, with the invoked **Subagent type** visible in the call and stream headers; child thinking deltas are not shown, and parent abort cancels the child rather than returning a live transcript — any assistant text the run captured before cancellation surfaces later as clearly marked partial output under the stopped-run contract, not as a transcript. The stream is UI-only and does not become parent LLM context: the final subagent result remains the only parent-context payload, while the collapsed tool row shows stable identity plus compact tool/progress markers instead of live assistant prose, and the expanded view shows a bounded UI-only activity tail that never enters results.

This trades perfect transcript fidelity and post-abort transcript recovery for context hygiene, readable in-progress UI, and a small first slice built on Pi's existing tool `onUpdate` and SDK `session.subscribe()` streaming seams.

> **Updated 2026-11-01:** the original clause that background runs "keep the existing
> id/status/final polling behavior for now" is superseded by
> `2026-11-01-attributed-completion-via-custom-message.md` — terminal background runs now
> deliver one attributed completion automatically during normal operation, and explicit
> retrieval with `get_subagent_result` remains on top. Live streaming itself stays
> foreground UI-only by design; it is presentation for an active run, not a delivery
> mechanism, and interruption keeps its cancellation semantics above.