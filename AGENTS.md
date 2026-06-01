# pi-extensions

Monorepo for [Pi](https://github.com/badlogic/pi-mono/tree/main) coding agent extensions. Published under the `@epr3` npm scope.

## Structure

```
.
├── package.json          # root workspace manifest
├── pnpm-workspace.yaml   # defines packages/* as workspace members
├── tsconfig.base.json    # shared TS compiler defaults
└── packages/
    ├── answer/           # Q&A extraction hook with interactive TUI
    ├── context/          # context management extension
    ├── handoff/          # conversation handoff extension
    ├── model-status/     # model status indicator
    ├── multi-edit/       # multi-file edit support (diff-based)
    ├── nanogpt-provider/ # NanoGPT model provider
    ├── plan-mode-v2/     # structured planning mode with TUI
    ├── review/           # code review extension
    ├── session-name/     # session naming extension
    └── usage/            # usage tracking extension
```

## Commands

| Command | Description |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm -r build` | Build all packages (tsdown → ESM + CJS + .d.ts) |
| `pnpm -r exec tsc --noEmit` | Typecheck all packages |
| `pnpm -r test` | Run tests |
| `pnpm --filter "@epr3/pi-extension-*" build` | Build only extensions |
| `pnpm -r exec rm -rf dist` | Clean all build outputs |
| `pnpm lint` | Lint all packages with oxlint |
| `pnpm lint:fix` | Auto-fix lint issues with oxlint |
| `pnpm format` | Format all files with oxfmt |
| `pnpm format:check` | Check formatting without writing |

## Package Conventions

- **Naming:** `@epr3/pi-extension-<name>`
- **Entry point:** `index.ts` at the package root
- **Build:** `tsdown` producing ESM + CJS dual format with declarations
- **Module:** `"type": "module"` (ESM-first)
- **TypeScript:** strict mode, `ES2022` target, `NodeNext` module resolution
- **Publishing:** `publishConfig.access: "public"`, `files: ["dist"]`

### Package scaffold (per package)

```
packages/<name>/
├── index.ts            # extension entry point
├── package.json        # @epr3/pi-extension-<name>
├── tsconfig.json       # extends root conventions
├── tsdown.config.ts    # entry → ESM + CJS + dts
├── dist/               # build output (gitignored)
└── tests/              # optional (plan-mode-v2 has 7 test files)
```

### Runtime dependencies

Extensions depend on one or more Pi SDK packages:
- `@mariozechner/pi-ai` — model completion API
- `@mariozechner/pi-coding-agent` — extension API, context types
- `@mariozechner/pi-tui` — terminal UI components

All packages share `tsdown` and `typescript` as dev dependencies.

## Development Workflow

1. **Scaffolding a new extension:**
   - Create `packages/<name>/` with `index.ts`, `package.json`, `tsconfig.json`, `tsdown.config.ts`
   - Follow the `answer` package as a template
   - Run `pnpm install` to link the new workspace member

2. **Building:**
   - Each package builds independently via `tsdown`
   - Output goes to `dist/` (ESM `.js`, CJS `.cjs`, declarations `.d.ts`)

3. **Testing:**
   - Packages with tests use: `node --experimental-strip-types --test tests/*.test.ts` or `tsx --test tests/*.test.ts`
   - Uses `node:test` and `node:assert/strict` — no external test framework

4. **Linting & Formatting:**
   - Run `pnpm lint` to check for issues, `pnpm lint:fix` to auto-fix
   - Run `pnpm format` to format files, `pnpm format:check` to check without writing
   - Config: `.oxlintrc.json` (lint rules), `.oxfmtrc.json` (format settings)

## Key Patterns

- Extensions register via the Pi `ExtensionAPI` and `ExtensionContext` interfaces
- TUI extensions import components from `@mariozechner/pi-tui` (Editor, Key, etc.)
- Model interactions use `complete()` from `@mariozechner/pi-ai`
- Structured output patterns use the model's JSON response format

## Agent skills

### Domain docs

multi-context. See `docs/agents/domain.md`.

## Tooling

- **Package manager:** pnpm v10+ (workspaces)
- **Build:** [tsdown](https://github.com/nicbarker/tsdown) (esbuild-based bundler)
- **TypeScript:** v5.9+ with strict mode
- **Lint:** [oxlint](https://oxc.rs/docs/guide/usage/linter.html) — fast JS/TS linter
- **Format:** [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) — fast JS/TS formatter
- **Node:** >= 20
