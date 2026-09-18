# model-compaction — model-aware compaction trigger (Pi extension, TypeScript)

A Pi extension that is the sole automatic compaction trigger. After each completed turn it starts one compaction when known context usage has reached **50% of the active model's advertised context window** — a model-aware boundary, not a fixed token reserve.

## How it works (real Pi APIs)

- `pi.on("turn_end", …)` → fires after each completed turn, carrying the turn's `toolResults`.
- `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }`, with `tokens: null` while unknown (right after a compaction, before the next response).
- `ctx.compact({ onComplete, onError })` → fire-and-forget compaction; the callbacks settle the in-progress guard and drive resume/recovery.
- `pi.sendMessage(…, { triggerTurn: true })` with `display: false` → hidden continuation context.
- `ctx.ui.notify(…)` → user-visible compaction failure.

The trigger decision is `tokens >= contextWindow * 0.5`. Unknown usage and a non-positive window never trigger.

After a successful compaction of an **interrupted work** turn (one that produced tool results), the extension injects hidden continuation context that resumes the work from the compaction summary and retained messages. A text-only turn compacts without a follow-up reply. A failed compaction notifies the user, clears the guard, and retries on the next completed turn still at or above the boundary.

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

`trigger.ts` holds the pure boundary decision (`isAtOrAboveThreshold`); `resume.ts` holds the pure interrupted-work decision (`isInterruptedWork`) and the continuation text. `index.ts` only wires the `turn_end` event, the in-progress guard, `ctx.compact`, continuation injection, and failure notification.

## Behavior

- **Model-aware boundary** — compaction starts after a completed turn when `tokens >= contextWindow * 0.5`; unknown usage never triggers.
- **Resume** — a compacted tool-result turn injects hidden continuation context so the model continues without the user restating the task.
- **No noise** — a compacted text-only turn produces no extra assistant response.
- **Recovery** — a failed compaction notifies the user and retries on the next completed turn still at or above the boundary.