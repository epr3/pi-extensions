import type { ModelPresetCatalog, ThinkingLevel } from "./catalog.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Narrow interface for the Pi services that activation needs.
 * Testable by providing a fake implementation.
 */
export interface ActivationServices {
  findModel(provider: string, modelId: string): { id: string; provider: string } | undefined;
  setModel(model: { id: string; provider: string }): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
  getThinkingLevel(): ThinkingLevel;
  notify(message: string, type: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface ActivationResult {
  success: boolean;
  presetName: string;
  warning?: string;
}

// ─── Activation ──────────────────────────────────────────────────────────────

/**
 * Activate a named preset from the catalog.
 *
 * Steps:
 * 1. Look up the preset in the catalog.
 * 2. Find the model in the registry.
 * 3. Call setModel — warns and returns early if the model is unavailable.
 * 4. Call setThinkingLevel with the preset's thinking level.
 * 5. Check the effective level after clamping and warn on mismatch.
 * 6. Update the status indicator.
 */
export async function activatePreset(
  catalog: ModelPresetCatalog,
  presetName: string,
  services: ActivationServices,
): Promise<ActivationResult> {
  const preset = catalog.presets.get(presetName);
  if (!preset) {
    services.notify(`Unknown preset "${presetName}"`, "error");
    return { success: false, presetName };
  }

  const model = services.findModel(preset.provider, preset.model);
  if (!model) {
    services.notify(`Model "${preset.provider}/${preset.model}" not available`, "warning");
    return { success: false, presetName };
  }

  const modelSet = await services.setModel(model);
  if (!modelSet) {
    services.notify(`No API key for "${preset.provider}/${preset.model}"`, "warning");
    return { success: false, presetName };
  }

  // Set the thinking level
  services.setThinkingLevel(preset.thinkingLevel);

  // Check if the thinking level was clamped
  const effectiveLevel = services.getThinkingLevel();
  let warning: string | undefined;
  if (effectiveLevel !== preset.thinkingLevel) {
    warning = `Thinking level clamped to "${effectiveLevel}" (preset requested "${preset.thinkingLevel}")`;
    services.notify(warning, "warning");
  }

  // Update status
  services.setStatus("model-presets", preset.label);

  return { success: true, presetName, warning };
}
