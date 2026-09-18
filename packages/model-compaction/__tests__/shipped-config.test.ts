import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const testDir = path.dirname(new URL(import.meta.url).pathname);

/**
 * Resolve the shipped repo-level settings.json from the test file location.
 * Test file:   packages/model-compaction/__tests__/shipped-config.test.ts
 * Settings:    packages/pi-config/settings.json
 */
const SETTINGS_PATH = path.resolve(testDir, "../../pi-config/settings.json");

function readShippedSettings(): Record<string, any> {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, any>;
}

describe("shipped model-aware compaction config bundle", () => {
  it("activates the model-compaction extension through the extensions list", () => {
    const settings = readShippedSettings();
    expect(settings.extensions).toContain("./packages/model-compaction");
  });

  it("disables native fixed-token auto-compaction", () => {
    const settings = readShippedSettings();
    expect(settings.compaction.enabled).toBe(false);
  });

  it("retains 8k recent tokens", () => {
    const settings = readShippedSettings();
    expect(settings.compaction.keepRecentTokens).toBe(8000);
  });

  it("leaves the statusline Dumb-zone contract unchanged", () => {
    const settings = readShippedSettings();
    expect(settings.statusline.effectiveLimit).toBe(200_000);
    expect(settings.statusline.thresholds).toEqual({
      sharp: 0.3333333333,
      fading: 0.6666666666,
      risky: 1,
    });
    expect(settings.statusline.meterWidth).toBe(10);
  });
});