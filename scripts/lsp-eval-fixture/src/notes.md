# Fixture notes

The `TODO(eventions)` markers exist so textual-search tasks have real hits in
comments — the language server never reports comments as symbols.

`run()` / `run()`/`run(` variants appear across `tasks.ts`, `task-types.ts`,
`sinks.ts`, and `emitters.ts`. Text search over `run` naturally over-matches
common words like "queue", "runway" would too; the point of the semantic tasks
is that only real call relationships survive.

Direction matters for call hierarchy: `always(` appears in several files, but
only the concrete `ConsoleEmitter` method is a real implementation site.
