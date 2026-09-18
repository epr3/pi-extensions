import { describe, it, expect } from "vitest";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { COMPACT_AT_FRACTION, isAtOrAboveThreshold } from "../trigger.ts";

function usage(tokens: number | null, contextWindow: number): ContextUsage {
  return {
    tokens,
    contextWindow,
    percent: tokens === null ? null : (tokens / contextWindow) * 100,
  };
}

describe("model-aware compaction boundary", () => {
  it("is half of the advertised context window", () => {
    expect(COMPACT_AT_FRACTION).toBe(0.5);
  });

  it("triggers at exactly half the advertised window", () => {
    expect(isAtOrAboveThreshold(usage(100_000, 200_000))).toBe(true);
  });

  it("triggers above half the advertised window", () => {
    expect(isAtOrAboveThreshold(usage(150_000, 200_000))).toBe(true);
  });

  it("does not trigger below half the advertised window", () => {
    expect(isAtOrAboveThreshold(usage(99_999, 200_000))).toBe(false);
  });

  it("scales with the model: half of 400k is 200k, not the fixed 200k dumb-zone limit", () => {
    expect(isAtOrAboveThreshold(usage(199_999, 400_000))).toBe(false);
    expect(isAtOrAboveThreshold(usage(200_000, 400_000))).toBe(true);
  });

  it("does not trigger on unknown usage", () => {
    expect(isAtOrAboveThreshold(usage(null, 200_000))).toBe(false);
    expect(isAtOrAboveThreshold(undefined)).toBe(false);
  });

  it("does not trigger without an advertised window", () => {
    expect(isAtOrAboveThreshold(usage(500_000, 0))).toBe(false);
    expect(isAtOrAboveThreshold(usage(500_000, -1))).toBe(false);
  });
});