// ─── Types ──────────────────────────────────────────────────────────────────

/** Allowed thinking levels that Pi supports. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Raw preset as it appears in settings input. */
export interface PresetInput {
  label?: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  repairDefault?: boolean;
}

/** Input shape of the whole catalog from settings. */
export interface CatalogInput {
  cycle: string[];
  presets: Record<string, PresetInput>;
}

/** A fully resolved preset with all defaults filled in. */
export interface ResolvedPreset {
  readonly name: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly repairDefault: boolean;
}

/** Result of walking the cycle array. */
export interface CycleResult {
  /** Valid entries in configured cycle order. */
  readonly entries: readonly ResolvedPreset[];
  /** Cycle entry names that do not exist in the catalog. */
  readonly missing: readonly string[];
  /** Cycle entry names whose preset data is invalid (e.g. missing fields). */
  readonly invalid: readonly string[];
}

/** Immutable parsed catalog. */
export interface ModelPresetCatalog {
  readonly presets: ReadonlyMap<string, ResolvedPreset>;
  readonly cycle: readonly string[];
}

// ─── Catalog creation ────────────────────────────────────────────────────────

/**
 * Parse and normalize a raw `CatalogInput` into an immutable `ModelPresetCatalog`.
 *
 * - Labels default to the preset key/name when not provided.
 * - `repairDefault` defaults to `false`.
 */
export function createCatalog(input: CatalogInput): ModelPresetCatalog {
  const presets = new Map<string, ResolvedPreset>();

  for (const [name, p] of Object.entries(input.presets)) {
    presets.set(name, {
      name,
      label: p.label ?? name,
      provider: p.provider,
      model: p.model,
      thinkingLevel: p.thinkingLevel,
      repairDefault: p.repairDefault ?? false,
    });
  }

  return {
    presets,
    cycle: [...input.cycle],
  };
}

// ─── Preset resolution ───────────────────────────────────────────────────────

/**
 * Look up a named preset in the catalog.
 * Returns the resolved preset or `undefined` if the name is unknown.
 */
export function resolvePreset(
  catalog: ModelPresetCatalog,
  name: string,
): ResolvedPreset | undefined {
  return catalog.presets.get(name);
}

// ─── Repair matching ───────────────────────────────────────────────────────

/**
 * Find the unambiguous repair target for a raw provider/model selection.
 *
 * Rules:
 * - If exactly one preset matches the provider/model pair → return it.
 * - If multiple presets match, repair happens only if exactly **one** of them
 *   has `repairDefault: true` → that one is returned.
 * - Otherwise (zero matches, or ambiguous duplicates) → returns `undefined`.
 */
export function findRepairTarget(
  catalog: ModelPresetCatalog,
  provider: string,
  model: string,
): ResolvedPreset | undefined {
  const matches: ResolvedPreset[] = [];

  for (const preset of catalog.presets.values()) {
    if (preset.provider === provider && preset.model === model) {
      matches.push(preset);
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    // Multiple presets match the same provider/model.
    // Repair only if exactly one of them is marked as the repair default.
    const defaults = matches.filter((p) => p.repairDefault);
    if (defaults.length === 1) {
      return defaults[0];
    }
  }

  return undefined;
}

// ─── Cycle resolution ────────────────────────────────────────────────────────

/**
 * Walk the configured cycle array and return:
 * - `entries`: valid presets in the configured order
 * - `missing`: cycle entry names that don't exist in the catalog
 * - `invalid`: cycle entry names whose preset data is invalid
 *
 * Missing and invalid entries are reported without inventing replacements.
 */
export function resolveCycle(catalog: ModelPresetCatalog): CycleResult {
  const entries: ResolvedPreset[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const name of catalog.cycle) {
    const preset = catalog.presets.get(name);
    if (!preset) {
      missing.push(name);
    } else {
      entries.push(preset);
    }
  }

  return { entries, missing, invalid };
}
