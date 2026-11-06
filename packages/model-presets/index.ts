import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createCatalog,
  findPresetIssue,
  resolveCycle,
  resolvePreset,
  findRepairTarget,
} from "./catalog.ts";
import { activatePreset } from "./activate.ts";
import type { ModelPresetCatalog } from "./catalog.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ─── Settings reading ────────────────────────────────────────────────────────

/**
 * Read the modelPresets settings from global and project settings files.
 * Global settings are read first, then project settings override.
 *
 * Unreadable or malformed files are skipped here; file-level diagnostics belong
 * to settings loading. The catalog validator reports malformed catalog entries.
 */
export function readSettingsFiles(files: string[]): {
  settings: Record<string, unknown>;
  issues: string[];
} {
  const merged: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      issues.push(`Could not read settings file ${file}: ${(error as Error).message}`);
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(text);
    } catch (error) {
      issues.push(`Invalid JSON in settings file ${file}: ${(error as Error).message}`);
      continue;
    }
    if (content === null || typeof content !== "object" || Array.isArray(content)) {
      issues.push(`Settings file ${file} must contain a JSON object`);
      continue;
    }
    const section = (content as Record<string, unknown>)["modelPresets"];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      Object.assign(merged, section);
    }
  }
  return { settings: merged, issues };
}

/**
 * Build a catalog from settings files.
 * Returns an empty catalog when settings are absent. Raw settings shape is
 * validated in `createCatalog`, which reports malformed entries instead of
 * throwing or silently substituting values.
 */
function readCatalog(): ModelPresetCatalog {
  const { settings, issues } = readSettingsFiles([
    path.join(homedir(), ".pi", "agent", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
  ]);
  const catalog = createCatalog(settings);
  return {
    ...catalog,
    invalid: [...issues.map((message) => ({ message })), ...catalog.invalid],
  };
}

// ─── Extension factory ───────────────────────────────────────────────────────

/**
 * Model presets Extension package.
 *
 * Registers:
 * - `/model-preset` command with argument-based and selector-based activation
 * - `Ctrl+Shift+M` shortcut to cycle through presets
 * - `model_select` event listener to repair thinking level on catalog matches
 * - `session_start` listener that reports malformed catalog entries once
 */
export default function (pi: ExtensionAPI, catalog?: ModelPresetCatalog): void {
  const cat = catalog ?? readCatalog();
  let lastCycledPresetName: string | undefined;

  // ── /model-preset command ──────────────────────────────────────────────────

  pi.registerCommand("model-preset", {
    description: "Activate a named model preset or open the preset selector",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (trimmed) {
        // Direct activation by name
        const preset = resolvePreset(cat, trimmed);
        if (!preset && !findPresetIssue(cat, trimmed)) {
          ctx.ui.notify(`Unknown preset "${trimmed}"`, "error");
          return;
        }
        // activatePreset reports the catalog issue for a malformed preset.
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

      // Warn about malformed cycle entries with their repair instructions
      for (const invalidName of cycleResult.invalid) {
        const issue = findPresetIssue(cat, invalidName);
        if (issue) ctx.ui.notify(issue.message, "warning");
      }

      if (cycleResult.entries.length === 0) {
        ctx.ui.notify("No model presets configured", "warning");
        return;
      }

      // Use the last preset selected by this shortcut when available. A duplicate
      // model cannot identify its active thinking preset from ctx.model alone.
      let currentIndex = lastCycledPresetName
        ? cycleResult.entries.findIndex((preset) => preset.name === lastCycledPresetName)
        : -1;

      // On the first cycle after a raw model selection, only an unambiguous
      // repair target can identify the current preset. Ambiguous matches start
      // at the first cycle entry.
      if (currentIndex === -1 && ctx.model) {
        const repairTarget = findRepairTarget(cat, ctx.model.provider, ctx.model.id);
        if (repairTarget) {
          currentIndex = cycleResult.entries.findIndex(
            (preset) => preset.name === repairTarget.name,
          );
        }
      }

      const nextIndex = (currentIndex + 1) % cycleResult.entries.length;
      const nextPreset = cycleResult.entries[nextIndex];

      await doActivate(cat, nextPreset.name, pi, ctx);
      lastCycledPresetName = nextPreset.name;
    },
  });

  // ── session_start event: report malformed catalog entries once ────────────

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    for (const issue of cat.invalid) {
      ctx.ui.notify(issue.message, "warning");
    }
  });

  // ── model_select event: repair thinking on catalog match ──────────────────

  pi.on("model_select", async (event: ModelSelectEvent, ctx: ExtensionContext) => {
    const target = findRepairTarget(cat, event.model.provider, event.model.id);
    if (!target) {
      lastCycledPresetName = undefined;
      // No unambiguous preset describes this selection: leave thinking untouched
      // but drop any label that no longer matches the active model.
      ctx.ui.setStatus("model-presets", undefined);
      return;
    }

    // Reapply the preset's thinking level
    lastCycledPresetName = target.name;
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