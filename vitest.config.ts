import { defineConfig } from "vitest/config";

// Shared Vitest config for every Extension package's Package test suite.
// All packages invoke this via `vitest run --config ../../vitest.config.ts`,
// so Node environment, discovery, and reporting-only V8 coverage stay aligned.
export default defineConfig({
	test: {
		environment: "node",
		include: ["**/__tests__/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/coverage/**",
			// subagents migrated to vitest in issue 0007.
		],
		coverage: {
			provider: "v8",
			// Reporting-only during the first migration — no thresholds enforced.
			reporter: ["text", "html"],
			include: ["packages/*/*.ts"],
			exclude: ["**/node_modules/**", "**/dist/**", "**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
		},
	},
});
