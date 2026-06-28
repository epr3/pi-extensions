# statusline — Dumb-zone status line (Pi extension, TypeScript)

A Pi extension that reports where the session sits on a cliff-not-slope model of context degradation, rendered into Pi's footer via `ctx.ui.setStatus`.

## How it works (real Pi APIs)

- `ctx.getContextUsage()` → current token usage for the active model.
- `ctx.model.contextWindow` → the nominal window.
- `ctx.cwd` → current folder; `pi.exec("git", ["rev-parse","--abbrev-ref","HEAD"])` → branch.
- Updates on `turn_end`, `agent_end`, `model_select`; cleared on `session_shutdown`.

Output (in the footer — location dim, zone glyph/label/meter/percent in the zone color, detail dim; plain Unicode, no Nerd Font needed):

```
checkout-service │ ⎇ feat/login │ ◑ RISKY ██████▌░░░ 65% eff · 130k/200k · 33% nom
```

The circle glyph is *remaining* effective headroom — ● sharp, ◕ fading, ◑ risky, ◔ caveman — and the meter is a contiguous whole-cell bar (`█` fill over `░` track), rounded to the nearest whole cell so the boundary stays smooth across terminals. Before the first response it shows `○ awaiting context`.

## Structure

The degradation model and meter math live in `zone.ts` (pure: `classify` / `meter` / `human` / `ZONE_GLYPH`, no Pi) and are unit-tested directly. `index.ts` only reads Pi state (usage, window, cwd, git branch) and renders.

## The model

The budget is **absolute — and the 120k limit is the caveman boundary itself**, not a pool that zones take percentages of: past 120k tokens you're caveman, full stop, regardless of the model's advertised window (NoLiMa / RULER — the cliff doesn't move with context size). The meter reads exactly full at the cliff. Lower zones split the run-up into thirds; the limit clamps to the nominal window for models smaller than it.

| Zone | tokens (default) | meaning |
|------|------------------|---------|
| `sharp` | 0–40k | full reasoning |
| `fading` | 40–80k | mid-context retrieval slips |
| `risky` | 80–120k | compact/hand off soon |
| `caveman` | >120k | past the cliff — `/skill:caveman` or `/skill:handoff` |

`caveman` the zone and the `caveman` skill are the same idea: the line says when, the skill is the response. Tune via the `statusline` key in Pi's `settings.json` (`effectiveLimit`, `thresholds`, `meterWidth`) or via env — `EFFECTIVE_LIMIT` (tokens, accepts `120k` / `0.5M` / plain integers), `Z_SHARP`, `Z_FADING`, `Z_RISKY` (fractions of the limit) — with env winning.
