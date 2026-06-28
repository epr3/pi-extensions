# question — Structured question tool (Pi extension, TypeScript)

Adds a `question` tool (Pi has none built in) so the grilling/review skills ask structured multiple-choice questions instead of prose. Backed by `ctx.ui.select`; recommended option shown first; `multiSelect` loops until "Done". In non-interactive modes (`-p`/json) it returns the question as text so the workflow still proceeds.

```
question({ header: "Granularity", question: "Right size?", options: [
  { label: "Right size", recommended: true }, { label: "Too coarse" }, { label: "Too fine" }
]})
```

Skills use it "if available", falling back to prose otherwise.
