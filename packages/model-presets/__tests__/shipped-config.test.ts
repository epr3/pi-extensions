import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createCatalog, resolvePreset, resolveCycle } from "../catalog.ts";

const testDir = path.dirname(new URL(import.meta.url).pathname);

/**
 * Resolve the shipped repo-level settings.json from the test file location.
 * Test file:   packages/model-presets/__tests__/shipped-config.test.ts
 * Settings:    packages/pi-config/settings.json
 */
const SETTINGS_PATH = path.resolve(testDir, "../../pi-config/settings.json");

function readShippedSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
}

describe("shipped model-presets config bundle", () => {
  it("includes model-presets in the extensions list", () => {
    const settings = readShippedSettings();
    const extensions = settings.extensions as string[];
    expect(extensions).toContain("./packages/model-presets");
  });

  it("includes a modelPresets top-level key", () => {
    const settings = readShippedSettings();
    expect(settings.modelPresets).toBeDefined();
    expect(typeof settings.modelPresets).toBe("object");
  });

  it("parses the shipped modelPresets catalog with createCatalog", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);

    expect(catalog.presets.size).toBe(4);
    expect(catalog.cycle).toHaveLength(4);
  });

  it("has default preset: openai-codex/gpt-5.5 with medium thinking and repairDefault", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);
    const preset = resolvePreset(catalog, "default");

    expect(preset).toBeDefined();
    expect(preset!.label).toBe("GPT 5.5 medium");
    expect(preset!.provider).toBe("openai-codex");
    expect(preset!.model).toBe("gpt-5.5");
    expect(preset!.thinkingLevel).toBe("medium");
    expect(preset!.repairDefault).toBe(true);
  });

  it("has fast-codex preset: openai-codex/gpt-5.3-codex-spark with low thinking", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);
    const preset = resolvePreset(catalog, "fast-codex");

    expect(preset).toBeDefined();
    expect(preset!.label).toBe("Codex Spark low");
    expect(preset!.provider).toBe("openai-codex");
    expect(preset!.model).toBe("gpt-5.3-codex-spark");
    expect(preset!.thinkingLevel).toBe("low");
    expect(preset!.repairDefault).toBe(false);
  });

  it("has coding-fallback preset: opencode-go/minimax-m3 with high thinking", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);
    const preset = resolvePreset(catalog, "coding-fallback");

    expect(preset).toBeDefined();
    expect(preset!.label).toBe("MiniMax M3 high");
    expect(preset!.provider).toBe("opencode-go");
    expect(preset!.model).toBe("minimax-m3");
    expect(preset!.thinkingLevel).toBe("high");
    expect(preset!.repairDefault).toBe(false);
  });

  it("has deep-reasoning preset: opencode-go/deepseek-v4-pro with high thinking", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);
    const preset = resolvePreset(catalog, "deep-reasoning");

    expect(preset).toBeDefined();
    expect(preset!.label).toBe("DeepSeek V4 Pro high");
    expect(preset!.provider).toBe("opencode-go");
    expect(preset!.model).toBe("deepseek-v4-pro");
    expect(preset!.thinkingLevel).toBe("high");
    expect(preset!.repairDefault).toBe(false);
  });

  it("has the correct cycle order: default → fast-codex → coding-fallback → deep-reasoning", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);

    expect(catalog.cycle).toEqual(["default", "fast-codex", "coding-fallback", "deep-reasoning"]);
  });

  it("resolves cycle with no missing entries", () => {
    const settings = readShippedSettings();
    const catalog = createCatalog(settings.modelPresets as any);
    const result = resolveCycle(catalog);

    expect(result.missing).toEqual([]);
    expect(result.entries).toHaveLength(4);
  });
});