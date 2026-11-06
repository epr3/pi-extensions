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
- **Recovery** — a failed compaction notifies the user and retries on the next completed turn still at or above the boundary. Both failure shapes count: an error delivered to `onError` and a `ctx.compact()` call that throws synchronously before the request starts.

## Lifecycle verification

Real Pi CLI availability was confirmed with Pi-Bolt 1.1.0 / Pi CLI 1.5.0. A normal noninteractive invocation with this extension loaded completed successfully:

```sh
PI_OFFLINE=1 pi --no-session --extension "$PWD/packages/model-compaction/index.ts" --print 'Reply with exactly: smoke-ok'
```

This verifies extension loading and an ordinary turn only; it does **not** exercise compaction. The required repo dependency install was attempted first with `pnpm install --offline --frozen-lockfile` and exited successfully, but this worktree still has no `node_modules`. Consequently the package test command cannot start (`vitest: command not found`), and the deterministic fake-API suite could not be rerun here.

The lifecycle scenarios remain unverified against real Pi:

- **Compaction success / failure:** the extension only requests compaction after real context usage reaches half the advertised model window. This smoke turn did not breach that boundary. No controllable real-Pi provider or failure injection was available to force success and failure in short, reproducible runs.
- **Continuation:** likewise requires a boundary-breaching turn with tool results; text-only versus interrupted-work outcomes were not observed in Pi.
- **Session transitions:** no controlled real-Pi scenario exercised an active compaction crossing a session switch/reload.

No defect was reproduced, so no behavior change was made. Existing package tests use a fake Pi API and must not be interpreted as runtime evidence. Install dependencies online or provision the workspace store, then use a controlled provider/model fixture that permits context-boundary and compaction-error injection to verify these remaining cases.