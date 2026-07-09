# Issue tracker: Local Markdown

Tickets and specs for this repo live as markdown files under `.scratch/` in the repo.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/SPEC.md`
- Implementation tickets are `.scratch/<feature-slug>/tickets/<NNNN>-<slug>.md`, zero-padded build order from `0001`; each records its parent spec path/slug and its `blocked_by` ticket numbers
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## Wayfinding operations

The `wayfinder` map is `.scratch/<effort-slug>/MAP.md`; child tickets are ticket files beside it under `tickets/`, each with a `blocked_by:` list. Frontier: tickets whose blockers are all resolved. Closing a ticket: record the decision in the ticket, then update the map's "Decisions so far" with a one-line gist + relative link.

## When a skill says "fetch the relevant issue"

Read the matching `.scratch/*/tickets/*.md` file.
