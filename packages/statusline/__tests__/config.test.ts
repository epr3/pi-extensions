import { describe, it, expect } from "vitest";
import { resolveStatuslineConfig } from "../config.ts";
import { classify, ZONE_DEFAULTS } from "../zone.ts";

describe("statusline configuration resolution", () => {
  it("accepts a valid effectiveLimit from settings without issues", () => {
    const r = resolveStatuslineConfig({ effectiveLimit: 250_000 }, {});
    expect(r.config.effectiveLimit).toBe(250_000);
    expect(r.issues).toEqual([]);
  });

  it("falls back to the default limit and reports an unparsable one", () => {
    const r = resolveStatuslineConfig({ effectiveLimit: "lots" }, {});
    expect(r.config.effectiveLimit).toBe(ZONE_DEFAULTS.effectiveLimit);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("effectiveLimit");
    expect(r.issues[0]!.message).toContain('"lots"');
    expect(r.issues[0]!.message).toContain("200000");
  });
});

describe("meter width resolution", () => {
  it("keeps valid widths and floors fractional ones", () => {
    expect(resolveStatuslineConfig({ meterWidth: 16 }, {}).meterWidth).toBe(16);
    const fractional = resolveStatuslineConfig({ meterWidth: 10.7 }, {});
    expect(fractional.meterWidth).toBe(10);
    expect(fractional.issues).toEqual([]);
  });

  it("defaults an unparsable width and reports it", () => {
    const r = resolveStatuslineConfig({ meterWidth: "wide" }, {});
    expect(r.meterWidth).toBe(10);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("meterWidth");
    expect(r.issues[0]!.message).toContain('"wide"');
  });

  it("defaults a non-positive width and reports it", () => {
    const r = resolveStatuslineConfig({ meterWidth: 0 }, {});
    expect(r.meterWidth).toBe(10);
    expect(r.issues[0]!.message).toContain("0");
  });

  it("clamps widths below the minimum and reports the used width", () => {
    const r = resolveStatuslineConfig({ meterWidth: 2 }, {});
    expect(r.meterWidth).toBe(4);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toContain("4");
  });

  it("clamps widths above the maximum and reports the used width", () => {
    const r = resolveStatuslineConfig({ meterWidth: 100 }, {});
    expect(r.meterWidth).toBe(40);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("meterWidth");
    expect(r.issues[0]!.message).toContain("40");
  });
});

describe("threshold resolution", () => {
  it("merges valid threshold overrides over the defaults", () => {
    const r = resolveStatuslineConfig({ thresholds: { sharp: 0.2, fading: 0.5 } }, {});
    expect(r.config.thresholds).toEqual({ sharp: 0.2, fading: 0.5, risky: 1 });
    expect(r.issues).toEqual([]);
  });

  it("rejects non-object thresholds and keeps the defaults", () => {
    const r = resolveStatuslineConfig({ thresholds: 0.5 }, {});
    expect(r.config.thresholds).toEqual(ZONE_DEFAULTS.thresholds);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("thresholds");
    expect(r.issues[0]!.message).toContain("0.5");
  });

  it("rejects unparsable threshold values individually", () => {
    const r = resolveStatuslineConfig({ thresholds: { sharp: "early", fading: 0.5 } }, {});
    expect(r.config.thresholds.sharp).toBeCloseTo(1 / 3, 10);
    expect(r.config.thresholds.fading).toBe(0.5);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("thresholds.sharp");
    expect(r.issues[0]!.message).toContain('"early"');
  });

  it("rejects out-of-range thresholds", () => {
    const above = resolveStatuslineConfig({ thresholds: { fading: 1.5 } }, {});
    expect(above.config.thresholds.fading).toBeCloseTo(2 / 3, 10);
    expect(above.issues[0]!.setting).toBe("thresholds.fading");

    const zero = resolveStatuslineConfig({ thresholds: { risky: 0 } }, {});
    expect(zero.config.thresholds.risky).toBe(1);
    expect(zero.issues[0]!.message).toContain("0");
  });

  it("falls back to the default thresholds when ordering is broken", () => {
    const r = resolveStatuslineConfig({ thresholds: { sharp: 0.9, fading: 0.5 } }, {});
    expect(r.config.thresholds).toEqual(ZONE_DEFAULTS.thresholds);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("thresholds");
    expect(r.issues[0]!.message).toContain("0.9");
    expect(r.issues[0]!.message).toContain("0.5");
  });

  it("rejects equal thresholds as unordered", () => {
    const r = resolveStatuslineConfig({ thresholds: { sharp: 0.5, fading: 0.5 } }, {});
    expect(r.config.thresholds).toEqual(ZONE_DEFAULTS.thresholds);
    expect(r.issues).toHaveLength(1);
  });

  it("keeps classification sane after a threshold fallback", () => {
    const r = resolveStatuslineConfig({ thresholds: { sharp: 0.9, fading: 0.5 } }, {});
    expect(classify(10_000, 400_000, r.config).zone).toBe("sharp");
    expect(classify(200_000, 400_000, r.config).zone).toBe("caveman");
  });
});

describe("environment tunables", () => {
  it("accepted env values win over settings without issues", () => {
    const r = resolveStatuslineConfig(
      { effectiveLimit: 250_000, thresholds: { sharp: 0.2, fading: 0.5 } },
      { EFFECTIVE_LIMIT: "300k", Z_FADING: "0.6", Z_RISKY: "0.9" },
    );
    expect(r.config.effectiveLimit).toBe(300_000);
    expect(r.config.thresholds).toEqual({ sharp: 0.2, fading: 0.6, risky: 0.9 });
    expect(r.issues).toEqual([]);
  });

  it("falls back to the settings limit when the env limit is unparsable", () => {
    const r = resolveStatuslineConfig({ effectiveLimit: 250_000 }, { EFFECTIVE_LIMIT: "nope" });
    expect(r.config.effectiveLimit).toBe(250_000);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("EFFECTIVE_LIMIT");
    expect(r.issues[0]!.message).toContain('"nope"');
    expect(r.issues[0]!.message).toContain("250000");
  });

  it("falls back to the settings threshold when the env threshold is invalid", () => {
    const r = resolveStatuslineConfig({ thresholds: { fading: 0.5 } }, { Z_FADING: "mid" });
    expect(r.config.thresholds.fading).toBe(0.5);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("Z_FADING");
    expect(r.issues[0]!.message).toContain('"mid"');
  });

  it("drops env thresholds that break ordering and keeps the settings ordering", () => {
    const settings = { thresholds: { sharp: 0.2, fading: 0.5, risky: 0.9 } };
    const r = resolveStatuslineConfig(settings, { Z_FADING: "0.1" });
    expect(r.config.thresholds).toEqual({ sharp: 0.2, fading: 0.5, risky: 0.9 });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.setting).toBe("thresholds");
    expect(r.issues[0]!.message).toContain("Z_FADING");
    expect(r.issues[0]!.message).toContain("sharp 0.2, fading 0.5, risky 0.9");
  });
});

describe("environment-derived config", () => {
  it("uses defaults when no env vars are set", () => {
    const c = resolveStatuslineConfig(undefined, {}).config;
    expect(c.effectiveLimit).toBe(ZONE_DEFAULTS.effectiveLimit);
    expect(c.thresholds.sharp).toBe(ZONE_DEFAULTS.thresholds.sharp);
    expect(c.thresholds.fading).toBe(ZONE_DEFAULTS.thresholds.fading);
    expect(c.thresholds.risky).toBe(ZONE_DEFAULTS.thresholds.risky);
  });

  it("accepts k-suffix token counts and overrides individual thresholds", () => {
    const c = resolveStatuslineConfig(undefined, {
      EFFECTIVE_LIMIT: "200k",
      Z_SHARP: "0.5",
      Z_RISKY: "0.9",
    }).config;
    expect(c.effectiveLimit).toBe(200_000);
    expect(c.thresholds.sharp).toBe(0.5);
    expect(c.thresholds.fading).toBe(ZONE_DEFAULTS.thresholds.fading);
    expect(c.thresholds.risky).toBe(0.9);
  });

  it("handles M-suffix and plain number token limits", () => {
    expect(
      resolveStatuslineConfig(undefined, { EFFECTIVE_LIMIT: "0.5M" }).config.effectiveLimit,
    ).toBe(500_000);
    expect(
      resolveStatuslineConfig(undefined, { EFFECTIVE_LIMIT: "80000" }).config.effectiveLimit,
    ).toBe(80_000);
  });

  it("applies an env-derived effective limit to classification", () => {
    const c = resolveStatuslineConfig(
      { effectiveLimit: 100_000 },
      { EFFECTIVE_LIMIT: "200k" },
    ).config;
    expect(c.effectiveLimit).toBe(200_000);
    expect(classify(150_000, 300_000, c).zone).toBe("risky"); // 75% of 200k
    expect(classify(200_000, 400_000, c).zone).toBe("caveman");
  });
});