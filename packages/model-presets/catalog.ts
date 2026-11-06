// ─── Types ──────────────────────────────────────────────────────────────────

/** Allowed thinking levels that Pi supports. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Every allowed thinking level, in Pi's own order. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

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

/**
 * A malformed part of the settings input, kept out of the usable catalog and
 * reported instead of being silently dropped or defaulted.
 */
export interface CatalogIssue {
  /** Preset name the issue concerns, when the issue names one. */
  readonly preset?: string;
  /** Actionable description naming the settings location and the problem. */
  readonly message: string;
}

/** Immutable parsed catalog. */
export interface ModelPresetCatalog {
  /** Valid presets only; malformed entries never appear here. */
  readonly presets: ReadonlyMap<string, ResolvedPreset>;
  /** Valid, string-typed cycle entry names in configured order. */
  readonly cycle: readonly string[];
  /** Malformed settings entries, in settings order. */
  readonly invalid: readonly CatalogIssue[];
}

// ─── Catalog creation ────────────────────────────────────────────────────────

/**
 * Parse, validate and normalize a raw `CatalogInput` into an immutable
 * `ModelPresetCatalog`.
 *
 * - Labels default to the preset key/name when not provided.
 * - `repairDefault` defaults to `false`.
 * - Malformed presets and cycle entries are excluded from the catalog and
 *   reported in `invalid` with an actionable message; valid entries are kept
 *   and no fallback values are invented.
 *
 * Accepts untrusted settings input, so a non-object input is reported instead
 * of throwing.
 */
export function createCatalog(input: unknown): ModelPresetCatalog {
  const presets = new Map<string, ResolvedPreset>();
  const invalid: CatalogIssue[] = [];

  if (input === undefined) {
    // No settings section at all: no presets configured, nothing to report.
    return { presets, cycle: [], invalid };
  }

  if (!isPlainObject(input)) {
    invalid.push({
      message: `modelPresets must be an object with "cycle" and "presets" (got ${describe(input)})`,
    });
    return { presets, cycle: [], invalid };
  }

  // An absent presets section is not malformed: it means no presets configured.
  const rawPresets = input.presets;
  if (rawPresets !== undefined && !isPlainObject(rawPresets)) {
    invalid.push({
      message: `modelPresets.presets must be an object mapping preset names to preset definitions (got ${describe(rawPresets)})`,
    });
  } else if (isPlainObject(rawPresets)) {
    for (const [name, raw] of Object.entries(rawPresets)) {
      const problems = presetProblems(raw);
      if (problems.length > 0) {
        invalid.push({
          preset: name,
          message: `modelPresets.presets["${name}"] is invalid: ${problems.join("; ")}`,
        });
        continue;
      }

      const p = raw as PresetInput;
      presets.set(name, {
        name,
        label: p.label ?? name,
        provider: p.provider,
        model: p.model,
        thinkingLevel: p.thinkingLevel,
        repairDefault: p.repairDefault ?? false,
      });
    }
  }

  const cycle = parseCycle(input.cycle, invalid);
  return { presets, cycle, invalid };
}

/**
 * Collect every problem with a single raw preset entry, so one preset is
 * reported once with all of its repair work listed together.
 */
function presetProblems(raw: unknown): string[] {
  if (!isPlainObject(raw)) {
    return [
      `expected an object with "provider", "model" and "thinkingLevel" (got ${describe(raw)})`,
    ];
  }

  const problems: string[] = [];

  if (raw.label !== undefined && !isNonEmptyString(raw.label)) {
    problems.push(`"label" must be a non-empty string (got ${describe(raw.label)})`);
  }
  if (!isNonEmptyString(raw.provider)) {
    problems.push(`"provider" must be a non-empty string (got ${describe(raw.provider)})`);
  }
  if (!isNonEmptyString(raw.model)) {
    problems.push(`"model" must be a non-empty string (got ${describe(raw.model)})`);
  }
  if (!isThinkingLevel(raw.thinkingLevel)) {
    problems.push(
      `"thinkingLevel" must be one of ${THINKING_LEVELS.join(", ")} (got ${describe(raw.thinkingLevel)})`,
    );
  }
  if (raw.repairDefault !== undefined && typeof raw.repairDefault !== "boolean") {
    problems.push(`"repairDefault" must be a boolean (got ${describe(raw.repairDefault)})`);
  }

  return problems;
}

/**
 * Keep the string-typed cycle names and report any other entries in place.
 * A malformed cycle never discards valid preset data.
 */
function parseCycle(raw: unknown, invalid: CatalogIssue[]): string[] {
  if (raw === undefined) return [];

  if (!Array.isArray(raw)) {
    invalid.push({
      message: `modelPresets.cycle must be an array of preset names (got ${describe(raw)})`,
    });
    return [];
  }

  const cycle: string[] = [];
  raw.forEach((entry, index) => {
    if (isNonEmptyString(entry)) {
      cycle.push(entry);
    } else {
      invalid.push({
        message: `modelPresets.cycle[${index}] must be a preset name (got ${describe(entry)})`,
      });
    }
  });
  return cycle;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Render a received value for an error message without dumping large payloads. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

// ─── Preset resolution ───────────────────────────────────────────────────────

/**
 * Look up a named preset in the catalog.
 * Returns the resolved preset or `undefined` if the name is unknown or its
 * settings entry is malformed; `findPresetIssue` reports the latter.
 */
export function resolvePreset(
  catalog: ModelPresetCatalog,
  name: string,
): ResolvedPreset | undefined {
  return catalog.presets.get(name);
}

/**
 * Find the catalog issue reported for a named preset.
 * Returns `undefined` when the name is valid or completely unknown.
 */
export function findPresetIssue(
  catalog: ModelPresetCatalog,
  name: string,
): CatalogIssue | undefined {
  return catalog.invalid.find((issue) => issue.preset === name);
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
    if (preset) {
      entries.push(preset);
    } else if (findPresetIssue(catalog, name)) {
      invalid.push(name);
    } else {
      missing.push(name);
    }
  }

  return { entries, missing, invalid };
}