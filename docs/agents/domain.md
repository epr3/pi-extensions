# Domain Docs

How engineering skills consume this repo's domain docs.

## Before exploring, read

- `CONTEXT.md` at repo root, **or**
- `CONTEXT-MAP.md` at repo root if exists — points at per-context `CONTEXT.md` files. Read each relevant to topic.

If neither exists, **proceed silently**. Don't flag absence; don't suggest creating files upfront. `/grill-with-docs` creates them lazily when terms/decisions resolve.

## File structure

**Single-context** (most repos):

```
CONTEXT.md
src/
```

**Multi-context** (`CONTEXT-MAP.md` at root):

```
CONTEXT-MAP.md
src/
  ordering/CONTEXT.md
  billing/CONTEXT.md
```

## Use glossary vocabulary

Naming domain concept (issue title, refactor proposal, hypothesis, test name), use term as defined in `CONTEXT.md`. Don't drift to synonyms glossary explicitly avoids.

If concept not in glossary yet, that's signal — either inventing language project doesn't use (reconsider), or real gap (note for `/grill-with-docs`).
