# Pi Extensions — model-compaction

Domain language for the `packages/model-compaction` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Model-aware compaction Extension package**: Runnable Pi `ExtensionAPI` module under `packages/model-compaction` that is the sole automatic compaction trigger, reading context usage after each completed turn.
_Avoid_: auto-compact plugin, context manager.

**Model-aware boundary**: The point at 50% of the active model's advertised context window at or above which a completed turn starts one compaction.
_Avoid_: fixed threshold, compact limit, token reserve.

**In-progress guard**: Extension state that suppresses further compaction requests until the active request settles.
_Avoid_: lock, mutex, debounce.

**Retained-context budget**: The 8k recent tokens Pi leaves unsummarized during compaction, owned by Pi's `compaction.keepRecentTokens` setting.
_Avoid_: keep window, recent limit, model-relative budget.

## Relationships

- **Model-aware compaction Extension package** starts at most one compaction per **Model-aware boundary** breach.
- **In-progress guard** clears when the active request settles, so a later breached turn can compact again.
- **Retained-context budget** is fixed and independent of the **Model-aware boundary**.

## Example dialogue

> **Dev:** "A 400k-window model and a 200k-window model — do they compact at the same token count?"
> **Domain expert:** "No. The **Model-aware boundary** is half of each advertised window, so 200k and 100k. The statusline's fixed 200k limit is a different contract entirely."

## Flagged ambiguities

- "50% context" measures the active model's advertised window, not the statusline's fixed 200k limit; the two never share a value by construction.
- "disable auto-compaction" means Pi's native fixed-token trigger only — manual `/compact` stays available.