# model-compaction — model-aware compaction trigger (Pi extension, TypeScript)

A Pi extension that is the sole automatic compaction trigger. After each completed turn it starts one compaction when known context usage has reached **50% of the active model's advertised context window** — a model-aware boundary, not a fixed token reserve.

## How it works (real Pi APIs)

- `pi.on("turn_end", …)` → fires after each completed turn.
- `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }`, with `tokens: null` while unknown (right after a compaction, before the next response).
- `ctx.compact({ onComplete, onError })` → fire-and-forget compaction; the callbacks settle the in-progress guard.

The trigger decision is `tokens >= contextWindow * 0.5`. Unknown usage and a non-positive window never trigger.

## Configuration

Native fixed-token auto-compaction must be off so this extension is the only automatic trigger; the 8k retained-context budget comes from Pi's own compaction settings:

```json
"compaction": {
  "enabled": false,
  "keepRecentTokens": 8000
}
```

Manual `/compact` keeps working with native auto-compaction disabled. The statusline's fixed 200k **Dumb-zone contract** is a separate setting (`statusline.effectiveLimit`) and is deliberately untouched — model-aware compaction measures the model's window; the dumb zone measures degradation.

## Structure

`trigger.ts` holds the pure boundary decision (`isAtOrAboveThreshold`), unit-tested directly. `index.ts` only wires the `turn_end` event, the in-progress guard, and `ctx.compact`.

## Follow-up

Automatic continuation after an interrupted tool-result turn and user-visible failure reporting/retry are ticket `0002-resume-and-recover-model-aware-compaction`.