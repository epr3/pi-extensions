import { describe, it, expect } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  resolveExtractionThinking,
  planExtractionThinking,
  isThinkingLevel,
  EXTRACTION_THINKING_SETTING,
} from "../thinking-level.ts";
import { projectOutputCeiling } from "../extraction.ts";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://test.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  } as Model<Api>;
}

describe("resolveExtractionThinking", () => {
  it("treats omission as no request and no warning", () => {
    expect(resolveExtractionThinking(undefined)).toEqual({ warnings: [] });
  });

  it("accepts every Pi thinking level including explicit off", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(isThinkingLevel(level)).toBe(true);
      expect(resolveExtractionThinking(level)).toEqual({ requested: level, warnings: [] });
    }
  });

  it("warns on a malformed string and behaves as absent", () => {
    const result = resolveExtractionThinking("maximum");
    expect(result.requested).toBeUndefined();
    expect(result.warnings).toEqual([
      {
        setting: EXTRACTION_THINKING_SETTING,
        type: "malformed",
        reference: '"maximum"',
      },
    ]);
  });

  it("warns on non-string malformed values and behaves as absent", () => {
    for (const value of [5, true, null, { high: true }, ["high"]]) {
      const result = resolveExtractionThinking(value);
      expect(result.requested).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].type).toBe("malformed");
    }
  });
});

describe("planExtractionThinking", () => {
  it("does nothing without an explicit request", () => {
    expect(planExtractionThinking(makeModel(), { warnings: [] })).toEqual({ warnings: [] });
  });

  it("passes a supported level through unchanged", () => {
    const plan = planExtractionThinking(makeModel({ reasoning: true }), {
      requested: "high",
      warnings: [],
    });
    expect(plan.effective).toBe("high");
    expect(plan.warnings).toEqual([]);
  });

  it("clamps to off for a non-reasoning model and reports requested vs effective", () => {
    const plan = planExtractionThinking(makeModel({ reasoning: false }), {
      requested: "high",
      warnings: [],
    });
    expect(plan.effective).toBe("off");
    expect(plan.warnings).toEqual([
      {
        setting: EXTRACTION_THINKING_SETTING,
        type: "clamped",
        reference: "high",
        requested: "high",
        effective: "off",
      },
    ]);
  });

  it("clamps a mapped-out level down to the nearest supported one", () => {
    const model = makeModel({ reasoning: true, thinkingLevelMap: { max: null } });
    const plan = planExtractionThinking(model, { requested: "max", warnings: [] });
    expect(plan.effective).toBe("high");
    expect(plan.warnings[0]).toMatchObject({
      type: "clamped",
      requested: "max",
      effective: "high",
    });
  });

  it("preserves malformed warnings alongside adaptation", () => {
    const malformed = resolveExtractionThinking("maximum");
    const plan = planExtractionThinking(makeModel({ reasoning: false }), malformed);
    expect(plan.effective).toBeUndefined();
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].type).toBe("malformed");
  });
});

describe("projectOutputCeiling (Pi reasoning-budget policy)", () => {
  it("adds the high-level budget without exceeding the model ceiling", () => {
    expect(projectOutputCeiling(makeModel({ maxTokens: 8192 }), 1024, "high")).toBe(8192);
    expect(projectOutputCeiling(makeModel({ maxTokens: 32_768 }), 1024, "high")).toBe(17_408);
  });

  it("clamps to a tight completion ceiling", () => {
    expect(projectOutputCeiling(makeModel({ maxTokens: 1200 }), 1024, "high")).toBe(1200);
    expect(projectOutputCeiling(makeModel({ maxTokens: 2048 }), 1024, "high")).toBe(2048);
  });

  it("scales with the requested level", () => {
    expect(projectOutputCeiling(makeModel({ maxTokens: 32_768 }), 1024, "minimal")).toBe(2048);
    expect(projectOutputCeiling(makeModel({ maxTokens: 32_768 }), 1024, "medium")).toBe(9216);
  });

  it("never reserves below the base answer allowance", () => {
    const model = makeModel({ maxTokens: 100, contextWindow: 500 });
    expect(projectOutputCeiling(model, 100, "high")).toBeGreaterThanOrEqual(100);
  });
});