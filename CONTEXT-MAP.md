# Context Map

This repo uses a multi-context layout mirroring the tracked Pi Extension package directories under `packages/*`.

## Contexts

- [lsp](./packages/lsp/CONTEXT.md) — language-server-backed code navigation and diagnostics tools.
- [model-compaction](./packages/model-compaction/CONTEXT.md) — model-aware compaction trigger that starts automatic compaction at 50% of the active model's advertised context window.
- [model-presets](./packages/model-presets/CONTEXT.md) — atomic provider/model/thinking presets for Pi model selection.
- [question](./packages/question/CONTEXT.md) — structured multiple-choice question tool for interactive agent workflows.
- [statusline](./packages/statusline/CONTEXT.md) — context-degradation footer status rendered inside Pi.
- [subagents](./packages/subagents/CONTEXT.md) — isolated delegated worker sessions launched by the parent Pi coding agent.
- [todo](./packages/todo/CONTEXT.md) — persistent checklist tools used by planning and issue-resolution skills.
- [web-fetch](./packages/web-fetch/CONTEXT.md) — URL fetching and readable-content extraction tool for research workflows.
- [web-search](./packages/web-search/CONTEXT.md) — Google Custom Search backed web discovery tool for research workflows.

## Relationships

- All contexts are sibling **Extension package** directories under `packages/`.
- Root scripts build, typecheck, lint, test, and audit the contexts as first-class package units.
- Each **Extension package** owns an **Extension test harness** and colocated behavior tests so root test orchestration is a roll-up, not the only place tests can run.
- **Coverage report** belongs to the **Extension test harness** and uses Vitest's V8 coverage provider, but does not enforce a minimum during the first migration.
- **Extension test harness** uses the **Vitest test idiom** for migrated and new tests.
- **Extension test harness** uses **Workspace test dependency** versions instead of duplicating Vitest dependencies in every package.
- **Shared Vitest config** supplies common runner behavior for all **Extension package** tests.
- **Package test suite** is the test ownership boundary for an **Extension package**.
- **Test script contract** makes package tests CI-friendly while keeping **Coverage report** available from the root.
- **Package test suite** contains **Deterministic package tests**, especially for web and LSP boundaries.
- Skills depend on these tools only when available and keep prose or direct-tool fallbacks.
- **Tool presentation** uses a dual result contract: stable plain-text `content` for the model plus structured `details` for user-facing renderers or session state.
- **Model-aware compaction Extension package** measures the **Model context window**; the statusline's **Effective limit** stays fixed and independent.

## Cross-context language

**Tool guidance**: Model-facing affordances that help the Pi coding agent choose and call a tool correctly, including tool descriptions, parameter descriptions, prompt snippets, and prompt guidelines.
_Avoid_: Tool docs, better descriptions.

**Tool presentation**: User-facing affordances that make a tool's activity and result legible in Pi, including call rows, result renderers, streaming updates, interactive prompts, and statusline output.
_Avoid_: Tool UI, better UX.

**Model context window**: The active model's advertised token capacity that model-aware compaction measures its 50% boundary against, distinct from the statusline's fixed **Effective limit**.
_Avoid_: Context budget, dumb zone, token reserve.

**Extension test harness**: Vitest-based package-level test setup that lets each **Extension package** run its own behavior tests through its local `test` script.
_Avoid_: Proper testing framework, test tooling, test setup.

**Coverage report**: Non-gating Vitest V8 coverage output used to inspect untested extension code without failing the initial migration.
_Avoid_: Coverage gate, quality bar, threshold.

**Vitest test idiom**: Test style that imports Vitest's `test`/`describe`/`it`, `expect`, and `vi` APIs instead of preserving `node:test` or `node:assert` as the primary test vocabulary.
_Avoid_: Jest style, node:test style, assertion style.

**Workspace test dependency**: Test runner dependency installed once at the pnpm workspace root and consumed by package-local scripts.
_Avoid_: Package test dependency, shared dev tool, root-only tool.

**Shared Vitest config**: Root `vitest.config.ts` that applies the Node test environment, coverage reporting, and common excludes to every **Extension test harness**.
_Avoid_: Package config, Vite config, test defaults.

**Package test suite**: Colocated `__tests__/` directory inside an **Extension package** containing that package's behavior tests.
_Avoid_: Root tests, test folder, unit tests.

**Test script contract**: Package and root script convention where each **Extension package** runs Vitest once with `test`, and the root exposes a reporting-only coverage roll-up.
_Avoid_: Script setup, test commands, npm scripts.

**Deterministic package test**: Package behavior test that avoids live external services and credentials by mocking network and other IO boundaries, except local fixture reads.
_Avoid_: Unit test, mocked test, offline test.

**Atomic model preset**: User-selectable model choice that binds provider, model id, and thinking level into one switch operation.
_Avoid_: Model selector entry, enabled model, profile.

**Model preset catalog**: `modelPresets` settings object owned by the `model-presets` package that stores **Atomic model presets** as a keyed `presets` object plus an explicit `cycle` order.
_Avoid_: Presets file, enabledModels, model list.

**Preset thinking repair**: Behavior that reapplies an **Atomic model preset** thinking level after a raw Pi model selection matches that preset's provider and model id.
_Avoid_: Thinking fallback, clamp fix, auto restore.

**Coding preset set**: Initial **Model preset catalog** example optimized for coding workflows with current default, fast Codex, broad fallback, and deep-reasoning alternatives.
_Avoid_: Balanced presets, default cycle, model list.

**Dependency catalog**: Default pnpm catalog in `pnpm-workspace.yaml` that centralizes shared **Extension package** runtime, library, and workspace tooling dependency versions.
_Avoid_: Shared package.json, dependency bump, version list.

**Exact dependency baseline**: Concrete latest version set recorded without semver range operators so dependency upgrades are explicit catalog edits rather than install-time float.
_Avoid_: Latest deps, pinned lockfile, caret range.

**Node support floor**: The oldest Node.js release the Extension package workspace declares compatible, aligned with its Pi runtime baseline.
_Avoid_: Node version, runtime version, engine range.

**Compatibility update**: Dependency update slice that includes whatever extension code, config, and test adjustments are needed to keep build, typecheck, lint, and tests passing at the **Exact dependency baseline**.
_Avoid_: Manifest-only update, deferred migration, blind bump.

## Flagged ambiguities

- "proper testing framework" was fuzzy; resolved: use **Extension test harness** for the package-owned Vitest test setup.
- Root `tests/*.test.ts` files could either remain a repo-level suite or become package-owned tests; resolved: move extension-specific tests into their owning `packages/*` directories.
- Initial coverage could be disabled, reporting-only, or threshold-gated; resolved: produce **Coverage report** output with the V8 provider and without enforcing thresholds during the first migration.
- Migrated tests could keep `node:assert` or use Vitest APIs; resolved: use the **Vitest test idiom** for consistency.
- Vitest dependencies could live in every package or at the workspace root; resolved: use **Workspace test dependency** placement.
- Vitest config could be per-package, absent, or shared; resolved: use **Shared Vitest config**.
- Tests could live next to source files, in `tests/`, or in `__tests__/`; resolved: use **Package test suite** directories named `__tests__/`.
- Test scripts could include only run, run plus coverage, or run plus watch plus coverage; resolved: use the **Test script contract** with `test` and root coverage reporting.
- Web/search/fetch tests could run against live services, optional live services, or mocks only; resolved: keep **Deterministic package tests** and avoid live external IO.
- The old in-tree `docs/CONTEXT.md` used **Extension package** as a repo-wide term; resolved by defining the concrete package term inside each package context.
- `pi-config` is a config bundle, not a runtime Extension package; it intentionally has no package context here.
- `shared` was support code, not a runtime Extension package; it intentionally has no package context here.
- "model selector package" could mean patching Pi's raw model cycle, config-only `enabledModels`, or a broader mode profile system; resolved: create a `model-presets` Extension package centered on **Atomic model presets**.
- "fix sticky thinking" could mean changing all raw model selections or only preset flows; resolved: **Preset thinking repair** applies only when a raw Pi model selection matches an explicit **Atomic model preset**.
- **Atomic model presets** could live in a separate JSON file or Pi settings; resolved: use the package-owned **Model preset catalog** in Pi settings.
- **Model preset catalog** could be a single ordered array or a merge-friendly map; resolved: use a keyed `presets` object plus explicit `cycle` array.
- Repeated dependency ranges versus centralized shared versions was unresolved; resolved: introduce a **Dependency catalog** for shared **Extension package** dependencies.
- "latest deps" could mean caret ranges, exact versions, or lockfile-only updates; resolved: use an **Exact dependency baseline**.
- Dependency updating could mean manifest-only edits or resolving API/tooling fallout; resolved: perform a **Compatibility update** rather than deferring required code/config/test changes.
- Invalid **Atomic model presets** could fail hard, silently fall back, or warn; resolved: unavailable models notify and leave the current state unchanged, and thinking-level clamp mismatches notify the actual effective level.
- **Preset thinking repair** for duplicate provider/model presets could use cycle order, reject duplicates, or require intent; resolved: duplicate model matches do not repair unless one matching preset is marked `repairDefault: true`.
- The first **Atomic model preset** selector could be a custom TUI overlay or a built-in prompt; resolved: use `ctx.ui.select`, notifications, and a compact status indicator first.
- The **Model preset catalog** shortcut could reuse the upstream preset example's `Ctrl+Shift+U` or define a mnemonic; resolved: use `Ctrl+Shift+M` to avoid the example preset collision and match model-focused scope.
- `model-presets` could ship hardcoded active presets, no examples, or config-bundle examples; resolved: package code has no active preset defaults, while `packages/pi-config/settings.json` should demonstrate the installable **Model preset catalog**.
- The first example cycle could be balanced across cost/default/deep/fallback or coding-oriented; resolved: ship a **Coding preset set** example using `openai-codex/gpt-5.5:medium`, `openai-codex/gpt-5.3-codex-spark:low`, `opencode-go/minimax-m3:high`, and `opencode-go/deepseek-v4-pro:high`.
