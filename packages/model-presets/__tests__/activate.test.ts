import { describe, it, expect } from "vitest";
import { createCatalog } from "../catalog.ts";
import { activatePreset, type ActivationServices } from "../activate.ts";

function emptyServices(): ActivationServices {
  return {
    findModel: () => undefined,
    setModel: async () => false,
    setThinkingLevel: () => {},
    getThinkingLevel: () => "off",
    notify: () => {},
    setStatus: () => {},
  };
}

describe("activatePreset", () => {
  it("activates a known preset by setting model and thinking level", async () => {
    const catalog = createCatalog({
      cycle: ["default"],
      presets: {
        default: {
          provider: "openai-codex",
          model: "gpt-5.5",
          thinkingLevel: "medium",
        },
      },
    });

    const fakeModel = { id: "gpt-5.5", provider: "openai-codex" };
    const calls: string[] = [];

    const result = await activatePreset(catalog, "default", {
      ...emptyServices(),
      findModel: () => fakeModel,
      setModel: async (_m) => {
        calls.push("setModel");
        return true;
      },
      setThinkingLevel: (level) => {
        calls.push(`setThinkingLevel:${level}`);
      },
      getThinkingLevel: () => "medium",
    });

    expect(result.success).toBe(true);
    expect(result.presetName).toBe("default");
    expect(calls).toEqual(["setModel", "setThinkingLevel:medium"]);
  });

  it("returns success: false and warns for an unknown preset name", async () => {
    const catalog = createCatalog({ cycle: [], presets: {} });
    const notified: string[] = [];

    const result = await activatePreset(catalog, "nonexistent", {
      ...emptyServices(),
      notify: (msg) => notified.push(msg),
    });

    expect(result.success).toBe(false);
    expect(result.presetName).toBe("nonexistent");
    expect(notified.some((m) => m.includes("Unknown"))).toBe(true);
  });

  it("returns success: false and warns when the model is not found in the registry", async () => {
    const catalog = createCatalog({
      cycle: ["x"],
      presets: {
        x: { provider: "p", model: "m", thinkingLevel: "low" },
      },
    });
    const notified: string[] = [];

    const result = await activatePreset(catalog, "x", {
      ...emptyServices(),
      findModel: () => undefined,
      notify: (msg) => notified.push(msg),
    });

    expect(result.success).toBe(false);
    expect(notified.some((m) => m.includes("not available"))).toBe(true);
  });

  it("returns success: false and warns when setModel returns false (no API key)", async () => {
    const catalog = createCatalog({
      cycle: ["x"],
      presets: {
        x: { provider: "p", model: "m", thinkingLevel: "low" },
      },
    });
    const notified: string[] = [];

    const result = await activatePreset(catalog, "x", {
      ...emptyServices(),
      findModel: () => ({ id: "m", provider: "p" }),
      setModel: async () => false,
      notify: (msg) => notified.push(msg),
    });

    expect(result.success).toBe(false);
    expect(notified.some((m) => m.includes("No API key"))).toBe(true);
  });

  it("warns when the effective thinking level differs from the preset level (clamped)", async () => {
    const catalog = createCatalog({
      cycle: ["x"],
      presets: {
        x: { provider: "p", model: "m", thinkingLevel: "high" },
      },
    });
    const notified: string[] = [];

    const result = await activatePreset(catalog, "x", {
      ...emptyServices(),
      findModel: () => ({ id: "m", provider: "p" }),
      setModel: async () => true,
      setThinkingLevel: () => {},
      // Model clamps "high" to "medium"
      getThinkingLevel: () => "medium",
      notify: (msg) => notified.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/clamped/);
    expect(notified.some((m) => m.includes("clamped"))).toBe(true);
  });

  it("updates the status indicator on successful activation", async () => {
    const catalog = createCatalog({
      cycle: ["x"],
      presets: {
        x: {
          label: "My Preset",
          provider: "p",
          model: "m",
          thinkingLevel: "low",
        },
      },
    });
    let statusText: string | undefined;

    const result = await activatePreset(catalog, "x", {
      ...emptyServices(),
      findModel: () => ({ id: "m", provider: "p" }),
      setModel: async () => true,
      setThinkingLevel: () => {},
      getThinkingLevel: () => "low",
      setStatus: (_key, text) => {
        statusText = text;
      },
    });

    expect(result.success).toBe(true);
    expect(statusText).toBe("My Preset");
  });
});
describe("activatePreset with a malformed catalog", () => {
  const catalog = createCatalog({
    cycle: ["good", "broken"],
    presets: {
      good: { provider: "p", model: "m", thinkingLevel: "medium" },
      broken: { provider: "p", model: "m", thinkingLevel: "ultra" } as any,
    },
  });

  it("reports the catalog issue and does not change the model for a malformed preset", async () => {
    const notified: Array<{ message: string; type: string }> = [];
    const calls: string[] = [];

    const result = await activatePreset(catalog, "broken", {
      ...emptyServices(),
      findModel: () => ({ id: "m", provider: "p" }),
      setModel: async () => {
        calls.push("setModel");
        return true;
      },
      setThinkingLevel: () => {
        calls.push("setThinkingLevel");
      },
      getThinkingLevel: () => "medium",
      notify: (message, type) => notified.push({ message, type }),
    });

    expect(result.success).toBe(false);
    expect(result.presetName).toBe("broken");
    expect(calls).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(notified[0].type).toBe("error");
    expect(notified[0].message).toContain('modelPresets.presets["broken"]');
    expect(notified[0].message).toContain("thinkingLevel");
  });

  it("still activates a valid preset from a catalog that also has malformed entries", async () => {
    const result = await activatePreset(catalog, "good", {
      ...emptyServices(),
      findModel: () => ({ id: "m", provider: "p" }),
      setModel: async () => true,
      getThinkingLevel: () => "medium",
    });

    expect(result.success).toBe(true);
  });
});