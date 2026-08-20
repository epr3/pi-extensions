import { describe, it, expect } from "vitest";
import {
  classify,
  meter,
  human,
  ZONE_GLYPH,
  ZONE_LABEL,
  ZONE_COLOR,
  ZONE_DEFAULTS,
  configFromEnv,
  formatStatusSegments,
  AWAITING_CONTEXT_TEXT,
  type Zone,
  type ZoneConfig,
} from "../zone.ts";

const PARTIAL_GLYPHS = /[\u258F\u258E\u258D\u258C\u258B\u258A\u2589]/; // ▏▎▍▌▋▊▉

function onlyWholeCells(s: string): boolean {
  return !PARTIAL_GLYPHS.test(s);
}

describe("headroom meter", () => {
  it("uses only whole filled and track cells", () => {
    for (const f of [0, 0.12, 0.25, 0.33, 0.5, 0.66, 0.75, 0.88, 1]) {
      const { filled, track } = meter(f, 10);
      expect(onlyWholeCells(filled)).toBe(true);
      expect(onlyWholeCells(track)).toBe(true);
    }
  });

  it("filled and track lengths sum to width for representative fractions", () => {
    for (const width of [4, 10, 20]) {
      for (let i = 0; i <= width; i++) {
        const { filled, track } = meter(i / width, width);
        expect(filled.length + track.length).toBe(width);
      }
    }
  });

  it("clamps below zero to empty and above one to full", () => {
    expect(meter(-0.5, 10)).toEqual({ filled: "", track: "░░░░░░░░░░" });
    expect(meter(0, 10)).toEqual({ filled: "", track: "░░░░░░░░░░" });
    expect(meter(1, 10)).toEqual({ filled: "██████████", track: "" });
    expect(meter(1.5, 10)).toEqual({ filled: "██████████", track: "" });
  });

  it("rounds fractional progress to nearest whole cell", () => {
    expect(meter(0.04, 10).filled.length).toBe(0);
    expect(meter(0.05, 10).filled.length).toBe(1);
    expect(meter(0.14, 10).filled.length).toBe(1);
    expect(meter(0.16, 10).filled.length).toBe(2);
    expect(meter(0.74, 10).filled.length).toBe(7);
    expect(meter(0.76, 10).filled.length).toBe(8);
    expect(meter(0.95, 10).filled.length).toBe(10);
  });
});

describe("dumb zone classification", () => {
  it("preserves zone thresholds and effective limit semantics", () => {
    const limit = ZONE_DEFAULTS.effectiveLimit;
    const cases: [number, Zone][] = [
      [limit * 0.1, "sharp"],
      [limit * 0.5, "fading"],
      [limit * 0.9, "risky"],
      [limit * 1.1, "caveman"],
    ];
    for (const [used, expected] of cases) {
      expect(classify(used, limit * 2).zone).toBe(expected);
    }
  });

  it("ships a 200k default effective limit with equal-third thresholds", () => {
    expect(ZONE_DEFAULTS.effectiveLimit).toBe(200_000);
    expect(ZONE_DEFAULTS.thresholds.sharp).toBeCloseTo(1 / 3, 10);
    expect(ZONE_DEFAULTS.thresholds.fading).toBeCloseTo(2 / 3, 10);
    expect(ZONE_DEFAULTS.thresholds.risky).toBe(1);
  });

  it("classifies the default stops at ~66.7k, ~133.3k, and the 200k limit", () => {
    const cases: [number, Zone][] = [
      [66_666, "sharp"],
      [66_667, "fading"],
      [133_333, "fading"],
      [133_334, "risky"],
      [199_999, "risky"],
      [200_000, "caveman"],
      [250_000, "caveman"],
    ];
    for (const [used, expected] of cases) {
      expect(classify(used, 400_000).zone).toBe(expected);
    }
  });

  it("enters caveman at exactly the effective limit (inclusive boundary)", () => {
    expect(classify(200_000, 400_000).zone).toBe("caveman");
    expect(classify(200_000, 200_000).zone).toBe("caveman"); // window == limit
    expect(classify(199_999, 400_000).zone).toBe("risky"); // just before stays risky
  });

  it("clamps the effective limit to smaller nominal windows", () => {
    expect(classify(32_000, 32_000).zone).toBe("caveman"); // effective = 32k
    expect(classify(31_999, 32_000).zone).toBe("risky");
  });

  it("does not move the cliff for larger nominal windows", () => {
    expect(classify(200_000, 1_000_000).zone).toBe("caveman");
    expect(classify(199_999, 1_000_000).zone).toBe("risky");
  });
});

describe("zone presentation", () => {
  it("keeps glyphs unchanged", () => {
    expect(ZONE_GLYPH.sharp).toBe("●");
    expect(ZONE_GLYPH.fading).toBe("◕");
    expect(ZONE_GLYPH.risky).toBe("◑");
    expect(ZONE_GLYPH.caveman).toBe("◔");
  });

  it("formats token counts as k or M", () => {
    expect(human(1_500)).toBe("2k");
    expect(human(1_200_000)).toBe("1.2M");
  });

  it("maps each zone to its uppercase display label", () => {
    expect(ZONE_LABEL.sharp).toBe("SHARP");
    expect(ZONE_LABEL.fading).toBe("FADING");
    expect(ZONE_LABEL.risky).toBe("RISKY");
    expect(ZONE_LABEL.caveman).toBe("CAVEMAN");
  });

  it("maps each zone to the expected theme color role", () => {
    expect(ZONE_COLOR.sharp).toBe("success");
    expect(ZONE_COLOR.fading).toBe("warning");
    expect(ZONE_COLOR.risky).toBe("warning");
    expect(ZONE_COLOR.caveman).toBe("error");
  });
});

describe("environment-derived config", () => {
  it("uses defaults when no env vars are set", () => {
    const c = configFromEnv({}, ZONE_DEFAULTS);
    expect(c.effectiveLimit).toBe(ZONE_DEFAULTS.effectiveLimit);
    expect(c.thresholds.sharp).toBe(ZONE_DEFAULTS.thresholds.sharp);
    expect(c.thresholds.fading).toBe(ZONE_DEFAULTS.thresholds.fading);
    expect(c.thresholds.risky).toBe(ZONE_DEFAULTS.thresholds.risky);
  });

  it("accepts k-suffix token counts and overrides individual thresholds", () => {
    const c = configFromEnv(
      { EFFECTIVE_LIMIT: "200k", Z_SHARP: "0.5", Z_RISKY: "0.9" },
      ZONE_DEFAULTS,
    );
    expect(c.effectiveLimit).toBe(200_000);
    expect(c.thresholds.sharp).toBe(0.5);
    expect(c.thresholds.fading).toBe(ZONE_DEFAULTS.thresholds.fading);
    expect(c.thresholds.risky).toBe(0.9);
  });

  it("handles M-suffix and plain number token limits", () => {
    expect(configFromEnv({ EFFECTIVE_LIMIT: "0.5M" }, ZONE_DEFAULTS).effectiveLimit).toBe(500_000);
    expect(configFromEnv({ EFFECTIVE_LIMIT: "80000" }, ZONE_DEFAULTS).effectiveLimit).toBe(80_000);
  });

  it("applies an env-derived effective limit to classification", () => {
    const base: ZoneConfig = {
      effectiveLimit: 100_000,
      thresholds: ZONE_DEFAULTS.thresholds,
    };
    const c = configFromEnv({ EFFECTIVE_LIMIT: "200k" }, base);
    expect(c.effectiveLimit).toBe(200_000);
    expect(classify(150_000, 300_000, c).zone).toBe("risky"); // 75% of 200k
    expect(classify(200_000, 400_000, c).zone).toBe("caveman");
  });
});

describe("formatStatusSegments", () => {
  it("returns correct glyphAndLabel and effPct for each zone", () => {
    const limit = ZONE_DEFAULTS.effectiveLimit;
    const cases: [number, string, string][] = [
      [limit * 0.1, `${ZONE_GLYPH.sharp} SHARP`, "10%"],
      [limit * 0.34, `${ZONE_GLYPH.fading} FADING`, "34%"],
      [limit * 0.67, `${ZONE_GLYPH.risky} RISKY`, "67%"],
      [limit * 1.0, `${ZONE_GLYPH.caveman} CAVEMAN`, "100%"],
    ];
    for (const [used, expectedGlyphAndLabel, expectedEff] of cases) {
      const { zone, fracEff, fracNom } = classify(used, limit * 2);
      const segs = formatStatusSegments(zone, fracEff, fracNom, used, limit * 2);
      expect(segs.glyphAndLabel).toBe(expectedGlyphAndLabel);
      expect(segs.effPct).toBe(expectedEff);
    }
  });

  it("usageMeta contains expected wording and separator structure", () => {
    const used = 40_000;
    const window = 200_000;
    const { zone, fracEff, fracNom } = classify(used, window);
    const segs = formatStatusSegments(zone, fracEff, fracNom, used, window);
    expect(segs.usageMeta).toMatch(/^eff · 40k\/200k · 20% nom$/);
  });

  it("usageMeta adapts to different token counts", () => {
    const window = 200_000;
    const { zone: z1, fracEff: e1, fracNom: n1 } = classify(1, window);
    const segs1 = formatStatusSegments(z1, e1, n1, 1, window);
    expect(segs1.usageMeta).toMatch(/^eff · 1\/200k · 0% nom$/);

    const { zone: z2, fracEff: e2, fracNom: n2 } = classify(200_000, window);
    const segs2 = formatStatusSegments(z2, e2, n2, 200_000, window);
    expect(segs2.usageMeta).toMatch(/^eff · 200k\/200k · 100% nom$/);
  });
});

describe("statusline constants", () => {
  it("AWAITING_CONTEXT_TEXT is the expected placeholder string", () => {
    expect(AWAITING_CONTEXT_TEXT).toBe("○ awaiting context");
  });
});