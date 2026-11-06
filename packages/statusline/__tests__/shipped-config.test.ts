import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveStatuslineConfig } from "../config.ts";

const testDir = path.dirname(new URL(import.meta.url).pathname);

/**
 * Resolve the shipped repo-level settings.json from the test file location.
 * Test file:   packages/statusline/__tests__/shipped-config.test.ts
 * Settings:    packages/pi-config/settings.json
 */
const SETTINGS_PATH = path.resolve(testDir, "../../pi-config/settings.json");

function readShippedStatuslineSettings(): Record<string, any> {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, any>;
  return settings.statusline as Record<string, any>;
}

describe("shipped statusline config bundle", () => {
  it("resolves without configuration issues", () => {
    const resolved = resolveStatuslineConfig(readShippedStatuslineSettings(), {});
    expect(resolved.issues).toEqual([]);
  });

  it("keeps the documented default effective limit, thresholds and width", () => {
    const resolved = resolveStatuslineConfig(readShippedStatuslineSettings(), {});
    expect(resolved.config.effectiveLimit).toBe(200_000);
    expect(resolved.config.thresholds.sharp).toBeCloseTo(1 / 3, 6);
    expect(resolved.config.thresholds.fading).toBeCloseTo(2 / 3, 6);
    expect(resolved.config.thresholds.risky).toBe(1);
    expect(resolved.meterWidth).toBe(10);
  });
});