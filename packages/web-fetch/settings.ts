// ─── Settings reading ───────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Explicit Extraction model configuration.
 *
 * Provider and model identifiers are resolved through Pi's model registry.
 * No automatic model selection or hardcoded active default exists.
 */
export interface ExtractionModelSettings {
  provider: string;
  model: string;
}

/**
 * Package-owned settings for the Web Fetch Extension.
 */
export interface WebFetchSettings {
  extractionModel?: ExtractionModelSettings;
}

const GLOBAL_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS = join(process.cwd(), ".pi", "settings.json");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Read the `webFetch` settings section from global and project settings files.
 *
 * Project settings override global settings (shallow merge at the section
 * level), matching the convention used by other Extension packages in this
 * repo.
 */
export function readWebFetchSettings(): WebFetchSettings {
  const merged: WebFetchSettings = {};

  for (const file of [GLOBAL_SETTINGS, PROJECT_SETTINGS]) {
    try {
      const content = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const section = content["webFetch"];
      if (!isObject(section)) continue;

      const extractionModel = section["extractionModel"];
      if (isObject(extractionModel)) {
        const provider = extractionModel["provider"];
        const model = extractionModel["model"];
        if (isString(provider) && isString(model)) {
          merged.extractionModel = { provider, model };
        }
      }
    } catch {
      // Missing or unreadable file — keep previous values.
    }
  }

  return merged;
}