# question — Structured question tool (Pi extension, TypeScript)

Adds a `question` tool (Pi has none built in) so the grilling/review skills ask structured questions with preset options plus an automatic free-prose escape hatch. Recommended option shown first; `multiSelect` redraws the picker until you pick Done. In non-interactive modes (`-p`/json) it returns the question as text so the workflow still proceeds.

Interactive prompts are rendered by the package-owned bounded question dialog (`dialog.ts`) inside a display budget rather than Pi's built-in picker: the header and question are wrapped and capped, every option label stays readable through wrapping and paging, and multi-select shows a count-only summary. Header bounds apply only to the interactive dialog and free-prose editor title; non-interactive text output is not bounded. A long supplied `header` is capped like the question text in the dialog and in the title of the free-prose editor opened with `ctx.ui.editor`.

```
question({ header: "Granularity", question: "Right size?", options: [
  { label: "Right size", recommended: true }, { label: "Too coarse" }, { label: "Too fine" }
]})
```

Interactive prompts append `✎ Type your answer`, collecting custom prose when preset options are too narrow. Skills use it "if available", falling back to prose otherwise.

## Confirming and cancelling

Confirming is deliberate: **only Done confirms** a `multiSelect` prompt (Enter on a preset option toggles it; Enter on `✓ Done` submits). Escape cancels the whole interaction and **discards** every preset choice and free-prose answer collected so far; it never submits a partial selection. The result for a cancelled or empty interaction is the unconfirmed one — `interaction: "none"` with no `selectedLabels` and no `freeText` — so callers must not read a missing answer as a partial answer.

This is an intentional change from earlier behavior, where Escape returned partial multi-selections as if they had been confirmed (see [adr/2026-11-06-deliberate-question-cancellation.md](adr/2026-11-06-deliberate-question-cancellation.md)).

When Pi aborts the run (Escape/Ctrl+C at the run level rather than in the dialog), the tool removes its widget and terminal input handler before rejecting with `Question cancelled` (plus `ctx` abort reason text when Pi supplies one), so a later question is not fed input meant for a dead dialog. A free-prose editor session is owned by Pi and is not dismissed by the tool's cleanup.

## Answer identity

Option labels must be distinct. Duplicate labels are rejected with an actionable error instead of silently sharing an answer identity — a compatibility change, since such calls were previously accepted. Answers are tracked by item identity (`option:<index>`, `freeText`, `done`), not by formatted display text, so two distinct labels that happen to render identically stay separately selectable and no preset option can act as Done.