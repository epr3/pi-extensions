import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classify, meter, human, ZONE_GLYPH, ZONE_DEFAULTS, type Zone } from "./zone.ts";

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
