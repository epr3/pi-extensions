// Configuration resolution for the statusline Extension package: layer Pi
// settings under env tunables, reject invalid values with actionable messages,
// and hand the renderer values it can safely use.

import { ZONE_DEFAULTS, type ZoneConfig } from "./zone.ts";

/** A rejected configuration value and the safe value used instead. */
export interface ConfigIssue {
  /** Settings key or environment variable that was rejected. */
  setting: string;
  /** Actionable single-line explanation, including the value used instead. */
  message: string;
}

export interface ResolvedStatusline {
  config: ZoneConfig;
  meterWidth: number;
  issues: ConfigIssue[];
}

/** Default meter width, and the bounds that keep the footer legible. */
export const METER_WIDTH_DEFAULT = 10;
export const METER_WIDTH_MIN = 4;
export const METER_WIDTH_MAX = 40;

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Plain positive token count, as `settings.json` documents it. */
function parseSettingsTokens(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Token counts accept k/M suffixes: "200k", "0.5M", or plain "200000". */
function parseEnvTokens(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(value.trim());
  if (!m) return undefined;
  const mult = m[2]!.toLowerCase() === "m" ? 1_000_000 : m[2]!.toLowerCase() === "k" ? 1_000 : 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const THRESHOLD_KEYS = ["sharp", "fading", "risky"] as const;
type Thresholds = ZoneConfig["thresholds"];

/** A threshold is a fraction of the limit, so valid values live in (0, 1]. */
function parseFraction(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
}

function ordered(t: Thresholds): boolean {
  return t.sharp < t.fading && t.fading < t.risky;
}

function describeThresholds(t: Thresholds): string {
  return `sharp ${t.sharp}, fading ${t.fading}, risky ${t.risky}`;
}

function resolveThresholds(rawSettings: Record<string, any>, issues: ConfigIssue[]): Thresholds {
  const thresholds: Thresholds = { ...ZONE_DEFAULTS.thresholds };
  const raw = rawSettings.thresholds;
  if (raw === undefined) return thresholds;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      setting: "thresholds",
      message: `thresholds ${describe(raw)} is not an object — using ${describeThresholds(thresholds)}`,
    });
    return thresholds;
  }
  for (const key of THRESHOLD_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    const parsed = parseFraction(value);
    if (parsed === undefined) {
      issues.push({
        setting: `thresholds.${key}`,
        message: `thresholds.${key} ${describe(value)} is not a fraction between 0 and 1 — using ${thresholds[key]}`,
      });
      continue;
    }
    thresholds[key] = parsed;
  }
  if (!ordered(thresholds)) {
    issues.push({
      setting: "thresholds",
      message: `thresholds must increase (sharp < fading < risky); got ${describeThresholds(thresholds)} — using ${describeThresholds(ZONE_DEFAULTS.thresholds)}`,
    });
    return { ...ZONE_DEFAULTS.thresholds };
  }
  return thresholds;
}

const ENV_THRESHOLD_KEYS = [
  ["Z_SHARP", "sharp"],
  ["Z_FADING", "fading"],
  ["Z_RISKY", "risky"],
] as const;

/**
 * Layer env tunables over resolved settings. Env wins, but a rejected env value
 * defers to the settings value rather than dropping straight to the code default.
 */
function resolveEnv(env: NodeJS.ProcessEnv, base: ZoneConfig, issues: ConfigIssue[]): ZoneConfig {
  let effectiveLimit = base.effectiveLimit;
  const rawLimit = env.EFFECTIVE_LIMIT;
  if (rawLimit !== undefined && rawLimit !== "") {
    const parsed = parseEnvTokens(rawLimit);
    if (parsed === undefined) {
      issues.push({
        setting: "EFFECTIVE_LIMIT",
        message: `EFFECTIVE_LIMIT ${describe(rawLimit)} is not a valid token count — using ${effectiveLimit}`,
      });
    } else {
      effectiveLimit = parsed;
    }
  }

  const thresholds: Thresholds = { ...base.thresholds };
  const applied: string[] = [];
  for (const [envKey, key] of ENV_THRESHOLD_KEYS) {
    const value = env[envKey];
    if (value === undefined || value === "") continue;
    const parsed = parseFraction(value);
    if (parsed === undefined) {
      issues.push({
        setting: envKey,
        message: `${envKey} ${describe(value)} is not a fraction between 0 and 1 — using ${thresholds[key]}`,
      });
      continue;
    }
    thresholds[key] = parsed;
    applied.push(envKey);
  }
  if (!ordered(thresholds)) {
    issues.push({
      setting: "thresholds",
      message: `thresholds must increase (sharp < fading < risky); environment set ${describeThresholds(thresholds)} via ${applied.join(", ")} — using ${describeThresholds(base.thresholds)}`,
    });
    return { effectiveLimit, thresholds: { ...base.thresholds } };
  }

  return { effectiveLimit, thresholds };
}

function resolveMeterWidth(rawSettings: Record<string, any>, issues: ConfigIssue[]): number {
  const value = rawSettings.meterWidth;
  if (value === undefined) return METER_WIDTH_DEFAULT;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    issues.push({
      setting: "meterWidth",
      message: `meterWidth ${describe(value)} is not a positive number — using ${METER_WIDTH_DEFAULT}`,
    });
    return METER_WIDTH_DEFAULT;
  }
  const width = Math.floor(n);
  if (width < METER_WIDTH_MIN) {
    issues.push({
      setting: "meterWidth",
      message: `meterWidth ${width} is below the minimum of ${METER_WIDTH_MIN} — using ${METER_WIDTH_MIN}`,
    });
    return METER_WIDTH_MIN;
  }
  if (width > METER_WIDTH_MAX) {
    issues.push({
      setting: "meterWidth",
      message: `meterWidth ${width} exceeds the maximum of ${METER_WIDTH_MAX} — using ${METER_WIDTH_MAX}`,
    });
    return METER_WIDTH_MAX;
  }
  return width;
}

export function resolveStatuslineConfig(
  rawSettings: Record<string, any> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedStatusline {
  const issues: ConfigIssue[] = [];
  const raw = rawSettings ?? {};

  let effectiveLimit = ZONE_DEFAULTS.effectiveLimit;
  if (raw.effectiveLimit !== undefined) {
    const n = parseSettingsTokens(raw.effectiveLimit);
    if (n === undefined) {
      issues.push({
        setting: "effectiveLimit",
        message: `effectiveLimit ${describe(raw.effectiveLimit)} is not a positive number — using ${effectiveLimit}`,
      });
    } else {
      effectiveLimit = n;
    }
  }

  const settingsConfig: ZoneConfig = {
    effectiveLimit,
    thresholds: resolveThresholds(raw, issues),
  };
  const config = resolveEnv(env, settingsConfig, issues);

  return {
    config,
    meterWidth: resolveMeterWidth(raw, issues),
    issues,
  };
}