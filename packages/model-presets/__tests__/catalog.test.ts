import { describe, it, expect } from "vitest";
import { createCatalog, resolvePreset, resolveCycle, findRepairTarget } from "../catalog.ts";

describe("createCatalog", () => {
	it("parses a valid catalog and normalizes defaults", () => {
		const catalog = createCatalog({
			cycle: ["fast-codex", "deep-reasoning"],
			presets: {
				"fast-codex": {
					provider: "openai-codex",
					model: "gpt-5.3-codex-spark",
					thinkingLevel: "low",
				},
				"deep-reasoning": {
					label: "DeepSeek V4 Pro high",
					provider: "opencode-go",
					model: "deepseek-v4-pro",
					thinkingLevel: "high",
					repairDefault: true,
				},
			},
		});

		// The map has both presets
		expect(catalog.presets.size).toBe(2);

		// fast-codex has no explicit label → defaults to name
		const fast = catalog.presets.get("fast-codex");
		expect(fast).toBeDefined();
		expect(fast!.name).toBe("fast-codex");
		expect(fast!.label).toBe("fast-codex");
		expect(fast!.provider).toBe("openai-codex");
		expect(fast!.model).toBe("gpt-5.3-codex-spark");
		expect(fast!.thinkingLevel).toBe("low");
		expect(fast!.repairDefault).toBe(false);

		// deep-reasoning has explicit label and repairDefault: true
		const deep = catalog.presets.get("deep-reasoning");
		expect(deep).toBeDefined();
		expect(deep!.name).toBe("deep-reasoning");
		expect(deep!.label).toBe("DeepSeek V4 Pro high");
		expect(deep!.provider).toBe("opencode-go");
		expect(deep!.model).toBe("deepseek-v4-pro");
		expect(deep!.thinkingLevel).toBe("high");
		expect(deep!.repairDefault).toBe(true);

		// Cycle order is preserved
		expect(catalog.cycle).toEqual(["fast-codex", "deep-reasoning"]);
	});

	it("accepts an empty catalog", () => {
		const catalog = createCatalog({ cycle: [], presets: {} });
		expect(catalog.presets.size).toBe(0);
		expect(catalog.cycle).toEqual([]);
	});
});

describe("resolvePreset", () => {
	const catalog = createCatalog({
		cycle: ["default"],
		presets: {
			default: {
				provider: "openai-codex",
				model: "gpt-5.5",
				thinkingLevel: "medium",
			},
			"fast-codex": {
				label: "Codex Spark low",
				provider: "openai-codex",
				model: "gpt-5.3-codex-spark",
				thinkingLevel: "low",
			},
		},
	});

	it("returns the resolved preset for a known name", () => {
		const p = resolvePreset(catalog, "default");
		expect(p).toBeDefined();
		expect(p!.name).toBe("default");
		expect(p!.label).toBe("default");
		expect(p!.provider).toBe("openai-codex");
		expect(p!.model).toBe("gpt-5.5");
		expect(p!.thinkingLevel).toBe("medium");
		expect(p!.repairDefault).toBe(false);
	});

	it("returns the resolved preset with explicit label", () => {
		const p = resolvePreset(catalog, "fast-codex");
		expect(p).toBeDefined();
		expect(p!.name).toBe("fast-codex");
		expect(p!.label).toBe("Codex Spark low");
	});

	it("returns undefined for an unknown name", () => {
		expect(resolvePreset(catalog, "nonexistent")).toBeUndefined();
	});
});

describe("resolveCycle", () => {
	const catalog = createCatalog({
		cycle: ["default", "fast-codex", "missing-preset"],
		presets: {
			default: {
				provider: "openai-codex",
				model: "gpt-5.5",
				thinkingLevel: "medium",
			},
			"fast-codex": {
				provider: "openai-codex",
				model: "gpt-5.3-codex-spark",
				thinkingLevel: "low",
			},
		},
	});

	it("returns entries in configured cycle order", () => {
		const result = resolveCycle(catalog);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].name).toBe("default");
		expect(result.entries[1].name).toBe("fast-codex");
	});

	it("reports missing cycle entries by name", () => {
		const result = resolveCycle(catalog);
		expect(result.missing).toEqual(["missing-preset"]);
	});

	it("has empty missing list when all cycle entries are valid", () => {
		const full = createCatalog({
			cycle: ["default", "fast-codex"],
			presets: {
				default: {
					provider: "openai-codex",
					model: "gpt-5.5",
					thinkingLevel: "medium",
				},
				"fast-codex": {
					provider: "openai-codex",
					model: "gpt-5.3-codex-spark",
					thinkingLevel: "low",
				},
			},
		});
		expect(resolveCycle(full).missing).toEqual([]);
	});

	it("returns empty entries and all-as-missing when no preset matches any cycle entry", () => {
		const empty = createCatalog({
			cycle: ["a", "b"],
			presets: {},
		});
		const result = resolveCycle(empty);
		expect(result.entries).toEqual([]);
		expect(result.missing).toEqual(["a", "b"]);
	});

	it("returns empty entries for an empty cycle", () => {
		const c = createCatalog({ cycle: [], presets: { x: { provider: "p", model: "m", thinkingLevel: "medium" } } });
		expect(resolveCycle(c).entries).toEqual([]);
		expect(resolveCycle(c).missing).toEqual([]);
	});
});

describe("findRepairTarget", () => {
	const catalog = createCatalog({
		cycle: ["default", "fast-codex", "deep-reasoning"],
		presets: {
			default: {
				provider: "openai-codex",
				model: "gpt-5.5",
				thinkingLevel: "medium",
				repairDefault: true,
			},
			"fast-codex": {
				provider: "openai-codex",
				model: "gpt-5.3-codex-spark",
				thinkingLevel: "low",
			},
			"deep-reasoning": {
				provider: "opencode-go",
				model: "deepseek-v4-pro",
				thinkingLevel: "high",
			},
		},
	});

	it("returns the matching preset for a single exact provider/model match", () => {
		const result = findRepairTarget(catalog, "openai-codex", "gpt-5.3-codex-spark");
		expect(result).toBeDefined();
		expect(result!.name).toBe("fast-codex");
	});

	it("returns undefined when no preset matches the provider/model", () => {
		expect(findRepairTarget(catalog, "unknown-provider", "unknown-model")).toBeUndefined();
	});

	it("matches provider and model exactly — partial match does not count", () => {
		// model differs slightly
		expect(findRepairTarget(catalog, "openai-codex", "gpt-5.5-beta")).toBeUndefined();
		// provider differs
		expect(findRepairTarget(catalog, "openai", "gpt-5.5")).toBeUndefined();
	});

	describe("duplicate provider/model matches", () => {
		it("returns undefined when two presets share the same provider/model (ambiguous)", () => {
			const cat = createCatalog({
				cycle: ["low", "high"],
				presets: {
					low: {
						provider: "openai-codex",
						model: "gpt-5.5",
						thinkingLevel: "low",
					},
					high: {
						provider: "openai-codex",
						model: "gpt-5.5",
						thinkingLevel: "high",
					},
				},
			});
			expect(findRepairTarget(cat, "openai-codex", "gpt-5.5")).toBeUndefined();
		});

		it("returns the repairDefault preset when exactly one duplicate has it", () => {
			const cat = createCatalog({
				cycle: ["low", "high"],
				presets: {
					low: {
						provider: "openai-codex",
						model: "gpt-5.5",
						thinkingLevel: "low",
						repairDefault: true,
					},
					high: {
						provider: "openai-codex",
						model: "gpt-5.5",
						thinkingLevel: "high",
					},
				},
			});
			const result = findRepairTarget(cat, "openai-codex", "gpt-5.5");
			expect(result).toBeDefined();
			expect(result!.name).toBe("low");
			expect(result!.thinkingLevel).toBe("low");
		});

		it("returns undefined when multiple duplicates have repairDefault: true (still ambiguous)", () => {
			const cat = createCatalog({
				cycle: ["low", "high"],
				presets: {
					low: {
						provider: "openai-codex",
						model: "gpt-5.5",
						thinkingLevel: "low",
						repairDefault: true,
					},
					high: {
						provider: "openai-codex",
						model: "gpt-5.5",
						thinkingLevel: "high",
						repairDefault: true,
					},
				},
			});
			expect(findRepairTarget(cat, "openai-codex", "gpt-5.5")).toBeUndefined();
		});

		it("works when single match coexists with a non-matching duplicate of another provider/model", () => {
			const cat = createCatalog({
				cycle: ["a", "b"],
				presets: {
					a: {
						provider: "p1",
						model: "m1",
						thinkingLevel: "medium",
					},
					b: {
						provider: "p1",
						model: "m2",
						thinkingLevel: "high",
					},
				},
			});
			// Only one preset matches p1/m1 → unambiguous
			expect(findRepairTarget(cat, "p1", "m1")!.name).toBe("a");
			// Only one preset matches p1/m2 → unambiguous
			expect(findRepairTarget(cat, "p1", "m2")!.name).toBe("b");
		});
	});
});
