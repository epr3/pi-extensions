// Pure degradation model — no Pi, no IO. This is the test surface: given used
// tokens and a window, where on the cliff are we? Effective context is an
// *absolute* budget, not a fraction of the advertised window: NoLiMa / RULER
// show degradation sets in past a fixed token count regardless of how big the
// nominal window is. Zones therefore map onto a fixed effective limit
// (default 120k tokens, clamped to the nominal window for small models), and
// each boundary is a real step down, not a gradient.

export type Zone = "sharp" | "fading" | "risky" | "caveman";

export interface ZoneConfig {
  /** Effective context budget in tokens — absolute, independent of the model's window. */
  effectiveLimit: number;
  /** Upper bounds as fractions of the limit; risky's bound is 1 — caveman begins at the limit itself. */
  thresholds: { sharp: number; fading: number; risky: number };
}

export interface ZoneResult {
  zone: Zone;
  /** Used / effective window. */
  fracEff: number;
  /** Used / nominal window. */
  fracNom: number;
}

export const ZONE_COLOR: Record<Zone, "success" | "warning" | "error"> = {
  sharp: "success",
  fading: "warning",
  risky: "warning",
  caveman: "error",
};

// The limit IS the caveman boundary: >120k tokens = caveman, and the meter
// reads full exactly at the cliff. Lower zones split the run-up into thirds.
export const ZONE_DEFAULTS: ZoneConfig = {
  effectiveLimit: 120_000,
  thresholds: { sharp: 1 / 3, fading: 2 / 3, risky: 1 },
};

function num(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Token counts accept k/M suffixes: "120k", "0.5M", or plain "120000". */
function tokens(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(v.trim());
  if (!m) return fallback;
  const mult = m[2]!.toLowerCase() === "m" ? 1_000_000 : m[2]!.toLowerCase() === "k" ? 1_000 : 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Layer env tunables (EFFECTIVE_LIMIT in tokens, Z_SHARP, Z_FADING, Z_RISKY)
 * over a base config — the base being either the code defaults or settings
 * already loaded from Pi's settings.json. Env wins: it's the quick-experiment layer.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  base: ZoneConfig = ZONE_DEFAULTS,
): ZoneConfig {
  return {
    effectiveLimit: tokens(env.EFFECTIVE_LIMIT, base.effectiveLimit),
    thresholds: {
      sharp: num(env.Z_SHARP, base.thresholds.sharp),
      fading: num(env.Z_FADING, base.thresholds.fading),
      risky: num(env.Z_RISKY, base.thresholds.risky),
    },
  };
}

export function classify(
  usedTokens: number,
  window: number,
  config: ZoneConfig = ZONE_DEFAULTS,
): ZoneResult {
  // The budget is absolute; a bigger advertised window doesn't move the cliff.
  // Clamp to the nominal window only so models *smaller* than the limit zone
  // out before they overflow.
  const effective = window > 0 ? Math.min(config.effectiveLimit, window) : config.effectiveLimit;
  const fracEff = effective > 0 ? usedTokens / effective : 0;
  const fracNom = window > 0 ? usedTokens / window : 0;
  const t = config.thresholds;
  const zone: Zone =
    fracEff < t.sharp
      ? "sharp"
      : fracEff < t.fading
        ? "fading"
        : fracEff < t.risky
          ? "risky"
          : "caveman";
  return { zone, fracEff, fracNom };
}

/** Glyph per zone: a circle showing *remaining* effective headroom. */
export const ZONE_GLYPH: Record<Zone, string> = {
  sharp: "\u25CF", // ● full
  fading: "\u25D5", // ◕ three-quarters
  risky: "\u25D1", // ◑ half
  caveman: "\u25D4", // ◔ a sliver
};

/**
 * Contiguous whole-cell meter. Fractions round to the nearest whole cell,
 * clamped to an empty or full bar. Returns filled and track separately so
 * the renderer can color them independently (bright fill, dim track).
 */
export function meter(fracEff: number, width = 10): { filled: string; track: string } {
  const f = Math.max(0, Math.min(1, fracEff));
  const used = Math.max(0, Math.min(width, Math.round(f * width)));
  return { filled: "\u2588".repeat(used), track: "\u2591".repeat(width - used) };
}

export function human(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}