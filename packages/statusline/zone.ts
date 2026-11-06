// Pure degradation model — no Pi, no IO. This is the test surface: given used
// tokens and a window, where on the cliff are we? The effective context budget
// is *absolute*, not a fraction of the advertised window: the cliff-not-slope
// evidence (NoLiMa / RULER) puts degradation past a token count that does not
// scale with the nominal window. That count is therefore a configurable
// heuristic — default 200k tokens, clamped to the nominal window for small
// models — and each zone boundary is a real step down, not a gradient.

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

// The limit IS the caveman boundary: at-or-over the limit (default 200k tokens)
// is caveman, and the meter reads full exactly at the cliff. Lower zones split
// the run-up into thirds.
export const ZONE_DEFAULTS: ZoneConfig = {
  effectiveLimit: 200_000,
  thresholds: { sharp: 1 / 3, fading: 2 / 3, risky: 1 },
};

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

/** Display labels — explicit, decoupled from Zone type value casing. */
export const ZONE_LABEL: Record<Zone, string> = {
  sharp: "SHARP",
  fading: "FADING",
  risky: "RISKY",
  caveman: "CAVEMAN",
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

/** Pre-first-response placeholder text. */
export const AWAITING_CONTEXT_TEXT = "\u25CB awaiting context"; // ○

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** Pure status text segments, one per themed region. Use in the renderer to
 * build the footer line, then apply zone color / dim per segment. */
export function formatStatusSegments(
  zone: Zone,
  fracEff: number,
  fracNom: number,
  usedTokens: number,
  window: number,
): { glyphAndLabel: string; effPct: string; usageMeta: string } {
  return {
    glyphAndLabel: `${ZONE_GLYPH[zone]} ${ZONE_LABEL[zone]}`,
    effPct: pct(fracEff),
    usageMeta: `eff \u00B7 ${human(usedTokens)}/${human(window)} \u00B7 ${pct(fracNom)} nom`,
  };
}