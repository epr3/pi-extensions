import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createCatalog, resolveCycle, resolvePreset, findRepairTarget } from "./catalog.ts";
import { activatePreset } from "./activate.ts";
import type { ModelPresetCatalog } from "./catalog.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ─── Settings reading ────────────────────────────────────────────────────────

/**
 * Read the modelPresets settings from global and project settings files.
 * Global settings are read first, then project settings override.
 */
function readSettings(): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const files = [
    path.join(homedir(), ".pi", "agent", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
  ];
  for (const file of files) {
    try {
      const content = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const section = content["modelPresets"] as Record<string, unknown> | undefined;
      if (section) {
        Object.assign(merged, section);
      }
    } catch {
      // File doesn't exist or isn't valid JSON — skip
    }
  }
  return merged;
}

/**
 * Build a catalog from settings files.
 * Returns an empty catalog when settings are absent.
 */
function readCatalog(): ModelPresetCatalog {
  const settings = readSettings();
  const cycle = Array.isArray(settings.cycle) ? (settings.cycle as string[]) : [];
  const presets =
    typeof settings.presets === "object" && settings.presets !== null
      ? (settings.presets as Record<string, unknown>)
      : {};
  return createCatalog({ cycle, presets } as any);
}

// ─── Extension factory ───────────────────────────────────────────────────────

/**
 * Model presets Extension package.
 *
 * Registers:
 * - `/model-preset` command with argument-based and selector-based activation
 * - `Ctrl+Shift+M` shortcut to cycle through presets
 * - `model_select` event listener to repair thinking level on catalog matches
 */
export default function (pi: ExtensionAPI, catalog?: ModelPresetCatalog): void {
  const cat = catalog ?? readCatalog();

  // ── /model-preset command ──────────────────────────────────────────────────

  pi.registerCommand("model-preset", {
    description: "Activate a named model preset or open the preset selector",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (trimmed) {
        // Direct activation by name
        const preset = resolvePreset(cat, trimmed);
        if (!preset) {
          ctx.ui.notify(`Unknown preset "${trimmed}"`, "error");
          return;
        }
        await doActivate(cat, trimmed, pi, ctx);
      } else {
        // Open selector
        if (cat.presets.size === 0) {
          ctx.ui.notify("No model presets configured", "warning");
          return;
        }

        const entries = [...cat.presets.entries()];
        const options = entries.map(
          ([, p]) => `${p.label} — ${p.provider}/${p.model} · ${p.thinkingLevel}`,
        );

        const chosen = await ctx.ui.select("Select a model preset:", options);
        if (!chosen) return; // cancelled

        const idx = options.indexOf(chosen);
        if (idx === -1) return;
        const [name] = entries[idx];
        await doActivate(cat, name, pi, ctx);
      }
    },
  });

  // ── Ctrl+Shift+M shortcut (cycle presets) ──────────────────────────────────

  pi.registerShortcut("ctrl+shift+m", {
    description: "Cycle through model presets",
    handler: async (ctx: ExtensionContext) => {
      const cycleResult = resolveCycle(cat);

      // Warn about missing cycle entries
      for (const missing of cycleResult.missing) {
        ctx.ui.notify(`Preset "${missing}" in cycle but not in catalog`, "warning");
      }

      if (cycleResult.entries.length === 0) {
        ctx.ui.notify("No model presets configured", "warning");
        return;
      }

      // Find current position based on active model
      const currentModel = ctx.model;
      let currentIndex = -1;
      if (currentModel) {
        currentIndex = cycleResult.entries.findIndex(
          (p) => p.provider === currentModel!.provider && p.model === currentModel!.id,
        );
      }

      // Cycle to next
      const nextIndex = (currentIndex + 1) % cycleResult.entries.length;
      const nextPreset = cycleResult.entries[nextIndex];

      await doActivate(cat, nextPreset.name, pi, ctx);
    },
  });

  // ── model_select event: repair thinking on catalog match ──────────────────

  pi.on("model_select", async (event: ModelSelectEvent, ctx: ExtensionContext) => {
    const target = findRepairTarget(cat, event.model.provider, event.model.id);
    if (!target) return; // no match — leave raw

    // Reapply the preset's thinking level
    pi.setThinkingLevel(target.thinkingLevel);

    const effectiveLevel = pi.getThinkingLevel();
    if (effectiveLevel !== target.thinkingLevel) {
      ctx.ui.notify(
        `Preset "${target.label}": thinking clamped to "${effectiveLevel}" (preset "${target.thinkingLevel}")`,
        "warning",
      );
    }

    ctx.ui.setStatus("model-presets", target.label);
  });
}

// ─── Shared activation helper ────────────────────────────────────────────────

/** Minimal event shape for model_select — the public API does not export the event type. */
interface ModelSelectEvent {
  model: { provider: string; id: string };
}

async function doActivate(
  catalog: ModelPresetCatalog,
  presetName: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
): Promise<void> {
  await activatePreset(catalog, presetName, {
    findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
    setModel: (model) => pi.setModel(model as any),
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
    getThinkingLevel: () => pi.getThinkingLevel(),
    notify: (msg, type) => ctx.ui.notify(msg, type),
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
  });
}