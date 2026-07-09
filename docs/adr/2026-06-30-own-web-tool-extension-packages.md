# Own Web Tool Extension Packages

We will implement `web_search` and `web_fetch` as first-class local Extension packages in this repo rather than relying on external drop-in extensions from `amosblomqvist/pi-config`. This makes the suite self-contained and auditable alongside the Subagents Extension package that already allowlists those tool names for the `researcher` Subagent type; the trade-off is owning dependencies, credentials documentation, tests, and shipped Pi config wiring instead of delegating maintenance to the upstream inspiration repo.
