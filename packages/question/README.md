# question — Structured question tool (Pi extension, TypeScript)

Adds a `question` tool (Pi has none built in) so the grilling/review skills ask structured questions with preset options plus an automatic free-prose escape hatch. Backed by `ctx.ui.select` and `ctx.ui.editor`; recommended option shown first; `multiSelect` loops until "Done". In non-interactive modes (`-p`/json) it returns the question as text so the workflow still proceeds.

```
question({ header: "Granularity", question: "Right size?", options: [
  { label: "Right size", recommended: true }, { label: "Too coarse" }, { label: "Too fine" }
]})
```

Interactive prompts append `✎ Type your answer`, collecting custom prose when preset options are too narrow. Skills use it "if available", falling back to prose otherwise.
