import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classify, meter, human, ZONE_GLYPH, ZONE_LABEL, ZONE_COLOR, ZONE_DEFAULTS, configFromEnv, formatStatusSegments, AWAITING_CONTEXT_TEXT, type Zone } from "./zone.ts";

const PARTIAL_GLYPHS = /[\u258F\u258E\u258D\u258C\u258B\u258A\u2589]/; // ▏▎▍▌▋▊▉

function onlyWholeCells(s: string): boolean {
  return !PARTIAL_GLYPHS.test(s);
}

test("meter uses only whole filled and track cells", () => {
  for (const f of [0, 0.12, 0.25, 0.33, 0.5, 0.66, 0.75, 0.88, 1]) {
    const { filled, track } = meter(f, 10);
    assert.ok(onlyWholeCells(filled), `filled has partial glyph at ${f}: ${filled}`);
    assert.ok(onlyWholeCells(track), `track has partial glyph at ${f}: ${track}`);
  }
});

test("meter filled and track lengths sum to width for representative fractions", () => {
  for (const width of [4, 10, 20]) {
    for (let i = 0; i <= width; i++) {
      const { filled, track } = meter(i / width, width);
      assert.equal(filled.length + track.length, width, `width=${width} frac=${i / width}`);
    }
  }
});

test("meter clamps below zero to empty and above one to full", () => {
  assert.deepEqual(meter(-0.5, 10), { filled: "", track: "░░░░░░░░░░" });
  assert.deepEqual(meter(0, 10), { filled: "", track: "░░░░░░░░░░" });
  assert.deepEqual(meter(1, 10), { filled: "██████████", track: "" });
  assert.deepEqual(meter(1.5, 10), { filled: "██████████", track: "" });
});

test("meter rounds fractional progress to nearest whole cell", () => {
  assert.equal(meter(0.04, 10).filled.length, 0); // rounds down to 0
  assert.equal(meter(0.05, 10).filled.length, 1); // rounds up to 1
  assert.equal(meter(0.14, 10).filled.length, 1); // rounds down to 1
  assert.equal(meter(0.16, 10).filled.length, 2); // rounds up to 2
  assert.equal(meter(0.74, 10).filled.length, 7); // rounds down to 7
  assert.equal(meter(0.76, 10).filled.length, 8); // rounds up to 8
  assert.equal(meter(0.95, 10).filled.length, 10); // rounds up to 10
});

test("classify preserves zone thresholds and effective limit semantics", () => {
  const limit = ZONE_DEFAULTS.effectiveLimit;
  const cases: [number, Zone][] = [
    [limit * 0.1, "sharp"],
    [limit * 0.5, "fading"],
    [limit * 0.9, "risky"],
    [limit * 1.1, "caveman"],
  ];
  for (const [used, expected] of cases) {
    assert.equal(classify(used, limit * 2).zone, expected);
  }
});

test("zone glyphs and human formatting remain unchanged", () => {
  assert.equal(ZONE_GLYPH.sharp, "\u25CF");
  assert.equal(ZONE_GLYPH.fading, "\u25D5");
  assert.equal(ZONE_GLYPH.risky, "\u25D1");
  assert.equal(ZONE_GLYPH.caveman, "\u25D4");
  assert.equal(human(1_500), "2k");
  assert.equal(human(1_200_000), "1.2M");
});

test("ZONE_LABEL maps each zone to its uppercase display label", () => {
  assert.equal(ZONE_LABEL.sharp, "SHARP");
  assert.equal(ZONE_LABEL.fading, "FADING");
  assert.equal(ZONE_LABEL.risky, "RISKY");
  assert.equal(ZONE_LABEL.caveman, "CAVEMAN");
});

test("ZONE_COLOR maps each zone to the expected theme color role", () => {
  assert.equal(ZONE_COLOR.sharp, "success");
  assert.equal(ZONE_COLOR.fading, "warning");
  assert.equal(ZONE_COLOR.risky, "warning");
  assert.equal(ZONE_COLOR.caveman, "error");
});

test("configFromEnv uses defaults when no env vars set", () => {
  const c = configFromEnv({}, ZONE_DEFAULTS);
  assert.equal(c.effectiveLimit, ZONE_DEFAULTS.effectiveLimit);
  assert.equal(c.thresholds.sharp, ZONE_DEFAULTS.thresholds.sharp);
  assert.equal(c.thresholds.fading, ZONE_DEFAULTS.thresholds.fading);
  assert.equal(c.thresholds.risky, ZONE_DEFAULTS.thresholds.risky);
});

test("configFromEnv accepts k/M suffix token counts and overrides individual thresholds", () => {
  const c = configFromEnv(
    { EFFECTIVE_LIMIT: "200k", Z_SHARP: "0.5", Z_RISKY: "0.9" },
    ZONE_DEFAULTS,
  );
  assert.equal(c.effectiveLimit, 200_000);
  assert.equal(c.thresholds.sharp, 0.5);
  assert.equal(c.thresholds.fading, ZONE_DEFAULTS.thresholds.fading); // unset -> default
  assert.equal(c.thresholds.risky, 0.9);
});

test("configFromEnv handles M suffix and plain number token limits", () => {
  assert.equal(configFromEnv({ EFFECTIVE_LIMIT: "0.5M" }, ZONE_DEFAULTS).effectiveLimit, 500_000);
  assert.equal(configFromEnv({ EFFECTIVE_LIMIT: "80000" }, ZONE_DEFAULTS).effectiveLimit, 80_000);
});

test("formatStatusSegments returns correct glyphAndLabel and effPct for each zone", () => {
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
    assert.equal(segs.glyphAndLabel, expectedGlyphAndLabel, `glyphAndLabel at ${used} tokens`);
    assert.equal(segs.effPct, expectedEff, `effPct at ${used} tokens`);
  }
});

test("formatStatusSegments usageMeta contains expected wording and separator structure", () => {
  const used = 40_000;
  const window = 200_000;
  const { zone, fracEff, fracNom } = classify(used, window);
  const segs = formatStatusSegments(zone, fracEff, fracNom, used, window);
  // "eff · 40k/200k · 20% nom"  (40k/200k = 0.2 = 20%)
  assert.match(segs.usageMeta, /^eff · 40k\/200k · 20% nom$/);
});

test("formatStatusSegments usageMeta adapts to different token counts", () => {
  const window = 200_000;
  // At 1 token: "eff · 1/200k · 0% nom"
  const { zone: z1, fracEff: e1, fracNom: n1 } = classify(1, window);
  const segs1 = formatStatusSegments(z1, e1, n1, 1, window);
  assert.match(segs1.usageMeta, /^eff · 1\/200k · 0% nom$/);

  // At 200k tokens: "eff · 200k/200k · 100% nom" — should be caveman since limit is 120k
  const { zone: z2, fracEff: e2, fracNom: n2 } = classify(200_000, window);
  const segs2 = formatStatusSegments(z2, e2, n2, 200_000, window);
  assert.match(segs2.usageMeta, /^eff · 200k\/200k · 100% nom$/);
});

test("AWAITING_CONTEXT_TEXT is the expected placeholder string", () => {
  assert.equal(AWAITING_CONTEXT_TEXT, "\u25CB awaiting context"); // ○
});
