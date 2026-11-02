# lsp-tool-choice-eval — repeat the LSP tool-choice comparison

Non-gating model-behavior observation for the LSP Extension package's Tool
guidance (spec: `.scratch/lsp-navigation-preference/SPEC.md`, ticket 0005; the
issue tracker lives in that untracked directory). It compares **baseline**
guidance against **revised** guidance under the same model, thinking level, and
tool allowlist, and records what the model actually called. **Model choice is
variable**: the report describes what happened; it asserts no pass rate and is
deliberately not wired into `pnpm test`, vitest, or `verify:ext`.

## Prerequisites

- Monorepo checkout with `node_modules` linked (the primary checkout or a git
  worktree; do **not** run `pnpm install` inside the eval). The runner calls the
  pi CLI at `packages/lsp/node_modules/.bin/pi` (SDK 0.84.1); override with
  `LSP_EVAL_PI=/path/to/pi` if yours lives elsewhere.
- `typescript-language-server` on `PATH` (only one scenario family needs the
  server; the harness refuses to run without it rather than comparing against
  worthless runs).
- A configured pi provider/model in `~/.pi/agent/` (the runner pins model and
  thinking level by pi flags and strips `PI_MODEL`/`PI_PROVIDER`/`PI_DEFAULT_*`
  and `PI_REASONING_LEVEL` so the environment cannot silently override them;
  operator auth/setup still comes from `~/.pi/agent`).
- A baseline revision present in history (default `580785b`, the last commit
  before the LSP-preference guidance landed). Override with
  `LSP_EVAL_BASELINE_REV=<sha or ref>` to compare against a different past
  guidance state.

## Commands

From the repository root (the worktree root that contains `scripts/`):

```sh
# Full comparison (default model gpt-6.1-terra, thinking low)
node_modules/.bin/tsx scripts/lsp-tool-choice-eval.ts

# Different model / thinking level
LSP_EVAL_MODEL=<model-pattern> LSP_EVAL_THINKING=<off|minimal|low|medium|high> \
  node_modules/.bin/tsx scripts/lsp-tool-choice-eval.ts

# Different baseline (e.g. the guidance revision just before yours)
LSP_EVAL_BASELINE_REV=<sha> node_modules/.bin/tsx scripts/lsp-tool-choice-eval.ts
```

Behavior:

- For every task in `scripts/lsp-tool-choice-eval.tasks.json` the runner
  materializes **two** lsp Extension package copies from git
  (`git show <rev>:packages/lsp/<file>` — never a working-tree edit), copies the
  committed `scripts/lsp-eval-fixture` project, and runs
  `pi -p --no-session --mode json` once per (task, variant), extracting the
  ordered tool calls from the session JSON on stdout.
- A Markdown report lands at `packages/lsp/eval/<date>-<model>-thinking-<level>.md`
  (model/provider/pi version/environment/task set/per-task choices/observed
  results/unexecuted-scenario notes are all in the report skeleton).
- Raw `--mode json` stdout per (task, variant) is preserved under
  `packages/lsp/eval/tmp/` (gitignored).
- Deterministic helper unit tests live in `scripts/__tests__/`; they cover the
  transcript-to-tool-order extraction and task-set shape validation, and do not
  invoke any model.
```
```

## Cost / duration caveat

Runs are sequential; on a fast connection the whole 5-task × 2-variant default
set takes roughly `5–15` minutes and a modest number of tokens (think
`sub-thousand-token` answers, small fixture project). Use
`LSP_EVAL_TIMEOUT_MS` to bound each run; a slow provider is the dominant cost.

## Interpretation records

Reports are committed under `packages/lsp/eval/`. Each lists the guidance
revisions compared — do not assume a report without revisions is a real run.
An "observed class ≈ expected" tally is only a lens (whether the model chose
the kind of tool that fits the scenario), never a score: model choice is
variable by nature.
