---
status: accepted
---

# Standardize Extension Tests on Vitest

Each Extension package will get a local Vitest-based **Extension test harness** and `test` script, while the root test command remains an orchestration roll-up across packages. Existing extension-specific root tests will move into package-local `__tests__/` suites, migrated tests will use the Vitest API, Vitest and the V8 coverage provider will live as root workspace dev dependencies behind a shared root config, coverage will be reporting-only at first, and package tests will avoid live external IO. We chose Vitest over Node's built-in `node:test`, tap, AVA, Mocha, Jest, and lighter runners because these Node/TypeScript Pi extensions benefit from consistent package-owned tests, ESM/TypeScript ergonomics, watch mode, mocks, snapshots, and coverage without adding Vite application or bundling configuration; the trade-off is adding a new repo-wide test dependency and migrating the existing `node:test` convention.
