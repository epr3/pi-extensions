# Pi Extensions — statusline

Domain language for the `packages/statusline` Extension package. Terms are opinionated, one sentence each; aliases under `_Avoid_`. New terms are lazy-added on first use.

## Language

**Statusline Extension package**: Runnable Pi `ExtensionAPI` module under `packages/statusline` whose default export renders context-degradation state into Pi's footer.
_Avoid_: Status package, footer plugin, progress bar.

**Dumb zone**: Named context-quality band on the cliff-not-slope model: `sharp`, `fading`, `risky`, or `caveman`.
_Avoid_: Context level, budget tier, health state.

**Effective limit**: Absolute token boundary where reasoning is treated as degraded regardless of the model's nominal context window.
_Avoid_: Context window, max tokens, budget.

**Headroom meter**: Footer meter showing remaining effective headroom toward the **Effective limit**.
_Avoid_: Progress bar, usage meter.

**Caveman boundary**: The **Dumb zone** transition past which the session should switch to caveman compression or handoff.
_Avoid_: Overflow, hard limit, danger zone.

## Relationships

- **Statusline Extension package** computes a **Dumb zone** from current usage and the **Effective limit**.
- **Headroom meter** fills as remaining effective headroom shrinks.
- **Caveman boundary** is independent of the model's advertised context size unless the model is smaller.

## Example dialogue

> **Dev:** "The model says 200k, so are we safe at 130k?"
> **Domain expert:** "No — the **Caveman boundary** is absolute, so the **Dumb zone** is already `caveman`."

## Flagged ambiguities

- "status line" could mean arbitrary footer text; resolved: **Statusline Extension package** specifically reports context degradation.
- "limit" could mean the model context window; resolved: **Effective limit** is the degradation boundary used by this package.
- **Headroom meter** fill could mean sub-character precision or a visually continuous bar; resolved: continuity wins over eighth-block precision.