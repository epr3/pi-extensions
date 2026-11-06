# statusline — Dumb-zone status line (Pi extension, TypeScript)

A Pi extension that reports where the session sits on a cliff-not-slope model of context degradation, rendered into Pi's footer via `ctx.ui.setStatus`.

## How it works (real Pi APIs)

- `ctx.getContextUsage()` → current token usage for the active model.
- `ctx.model.contextWindow` → the model's nominal context window.
- `ctx.cwd` → current folder; `pi.exec("git", ["rev-parse","--abbrev-ref","HEAD"])` → branch.
- Updates on `turn_end`, `agent_end`, `model_select`; cleared on `session_shutdown`.

Output (in the footer — location dim, zone glyph/label/meter/percent in the zone color, detail dim; plain Unicode, no Nerd Font needed):

```
checkout-service │ ⎇ feat/login │ ◑ RISKY ███████░░░ 70% eff · 140k/400k · 35% nom
```

The circle glyph is _remaining_ effective headroom — ● sharp, ◕ fading, ◑ risky, ◔ caveman — and the meter is a contiguous whole-cell bar (`█` fill over `░` track), rounded to the nearest whole cell so the boundary stays smooth across terminals. Before the first response it shows `○ awaiting context`.

The two percentages are measured against different boundaries: `70% eff` and the meter use the **Effective limit** (here 140k of the default 200k), while `140k/400k · 35% nom` compares the same usage against the model's nominal context window.

## Structure

The degradation model and meter math live in `zone.ts` (pure: `classify` / `meter` / `human` / `ZONE_GLYPH`, no Pi) and are unit-tested directly. `index.ts` only reads Pi state (usage, window, cwd, git branch) and renders.

## The model

The **Effective limit** is this package's own degradation boundary in tokens. It is a configurable heuristic, not a fact about the model: it does not read or redefine the model's **nominal context window** (`ctx.model.contextWindow`), and it does not claim that a model _cannot_ use tokens past it. The default is 200k tokens because the cliff-not-slope evidence behind this package (NoLiMa, RULER) puts measurable degradation well inside the large windows modern models advertise; treat that default as a tunable starting point for your own model and workload, not a universal constant.

The limit is **absolute — the default 200k limit is the caveman boundary itself**, not a pool that zones take percentages of: at or over the effective limit you're caveman, full stop, no matter how much nominal window the model advertises. The meter reads exactly full at the cliff. Lower zones split the run-up into thirds. The limit clamps to the nominal window for models smaller than it, so a 32k model zones out before it overflows.

| Zone      | tokens (default) | meaning                                             |
| --------- | ---------------- | --------------------------------------------------- |
| `sharp`   | 0–66.7k          | full reasoning                                      |
| `fading`  | 66.7–133.3k      | mid-context retrieval slips                         |
| `risky`   | 133.3–200k       | compact/hand off soon                               |
| `caveman` | ≥200k            | at the cliff — `/skill:caveman` or `/skill:handoff` |

`caveman` the zone and the `caveman` skill are the same idea: the line says when, the skill is the response.

## Configuration

The defaults above (200k limit, equal-thirds thresholds, 10-cell meter) are what the package ships; nothing needs to be configured to use them. Tune via the `statusline` key in Pi's `settings.json` — global `~/.pi/agent/settings.json` first, then project `.pi/settings.json`, shallow-merged so project keys win — or via environment variables, which win over both:

| Setting                     | Env                              | Accepts                                      |
| --------------------------- | -------------------------------- | -------------------------------------------- |
| `statusline.effectiveLimit` | `EFFECTIVE_LIMIT`                | tokens: `200k`, `0.5M`, or plain integers    |
| `statusline.thresholds`     | `Z_SHARP`, `Z_FADING`, `Z_RISKY` | fractions of the effective limit, e.g. `0.4` |
| `statusline.meterWidth`     | —                                | whole number of cells, clamped to 4–40       |

Zones are ordered bands, so custom `thresholds` are only meaningful in ascending order; `meterWidth` changes bar resolution only, never the zone boundaries.

Precedence is: code defaults, then global `~/.pi/agent/settings.json`, then project `.pi/settings.json`, then env. Resolution and validation live in `config.ts` (`resolveStatuslineConfig`).

## Invalid configuration

Bad values are diagnosed instead of silently ignored. On `session_start` the extension notifies once per rejected value (`statusline: <setting> "<value>" is not … — using <fallback>`, warning level, TUI only), and the footer keeps rendering with the fallback. Rendering never receives an unvalidated number.

| Setting                        | Valid values                                 | Invalid value behaves                                             |
| ------------------------------ | -------------------------------------------- | ----------------------------------------------------------------- |
| `effectiveLimit` (settings)    | positive number                              | default `200000`                                                  |
| `EFFECTIVE_LIMIT` (env)        | positive token count, `k`/`M` suffix allowed | the settings limit                                                |
| `thresholds.*` (settings, env) | fraction in `(0, 1]`                         | that setting's default, or the settings value for env             |
| `thresholds` ordering          | strictly increasing `sharp < fading < risky` | all-default thresholds (settings), settings thresholds (env)      |
| `meterWidth`                   | positive number in `[4, 40]`, rounded down   | default `10` when unparsable/non-positive; clamped to `4` or `40` |

Intentional differences from earlier releases, all in invalid configurations only:

- Rejected values used to fall back silently; they now also produce a warning notification.
- `meterWidth` now has an upper bound of 40 cells — wider values used to widen the footer without limit and are now clamped (with a warning).
- `meterWidth` below the existing 4-cell minimum is now reported; the rendered width is unchanged.
- Threshold values outside `(0, 1]`, and thresholds that are not strictly increasing, are now rejected. Previously they could make a zone unreachable (for example `sharp 0.9, fading 0.5` skipped `fading` entirely).
- A rejected env value now defers to the settings value instead of the code default.

Valid configurations render exactly as before, and a malformed or missing settings file stays silent (Pi reports its own settings errors).

## Meter rendering

The bar is contiguous and made of whole cells only — `█` for filled cells and `░` for the track, no partial-block glyphs such as `▌` or `▋`. Progress rounds to the nearest whole cell, so at the default width of 10 each cell is 10%: 0.04 renders empty, 0.05 renders one filled cell, 0.65 renders seven. The bar therefore steps between discrete widths instead of drawing sub-cell precision — that keeps the edge stable across terminals and fonts, and the numeric `eff` percentage and zone label carry the precision.