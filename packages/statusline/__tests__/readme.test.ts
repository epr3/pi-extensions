import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, meter, human, ZONE_DEFAULTS, ZONE_GLYPH, ZONE_LABEL } from "../zone.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(path.resolve(testDir, "../README.md"), "utf-8");

const PARTIAL_GLYPHS = /[\u258F\u258E\u258D\u258C\u258B\u258A\u2589]/; // ▏▎▍▌▋▊▉

/** Parse token counts as the README writes them: "140k", "1.2M", "80000". */
function tokens(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(text);
  if (!m) throw new Error(`unparsable token count in README example: ${text}`);
  const mult = m[2] === "M" ? 1_000_000 : m[2] === "k" ? 1_000 : 1;
  return Number(m[1]) * mult;
}

/** The single footer example advertised in the README. */
const EXAMPLE =
  /(\S) ([A-Z]+) ([\u2588\u2591]+) (\d+)% eff · ([\d.]+[kM]?)\/([\d.]+[kM]?) · (\d+)% nom/;

function example(): RegExpExecArray {
  const m = EXAMPLE.exec(readme);
  if (!m) throw new Error("README does not contain a parseable footer example");
  return m;
}

describe("README footer example", () => {
  it("uses whole-cell meter cells only", () => {
    const [, , , bar] = example();
    expect(bar).not.toMatch(PARTIAL_GLYPHS);
  });

  it("is reproducible from its documented token counts", () => {
    const [, glyph, label, bar, effPct, usedText, windowText, nomPct] = example();
    const used = tokens(usedText!);
    const window = tokens(windowText!);
    const { zone, fracEff, fracNom } = classify(used, window);

    expect(label).toBe(ZONE_LABEL[zone]);
    expect(glyph).toBe(ZONE_GLYPH[zone]);
    expect(String(Math.round(fracEff * 100))).toBe(effPct);
    expect(String(Math.round(fracNom * 100))).toBe(nomPct);
    // The example's bar is the bar the renderer would draw at that fraction.
    const { filled, track } = meter(fracEff, bar!.length);
    expect(filled + track).toBe(bar);
  });
});

describe("README model documentation", () => {
  it("separates the Effective limit from the model's nominal context window", () => {
    expect(readme).toMatch(/Effective limit/);
    expect(readme).toMatch(/nominal context window/);
    expect(readme).toMatch(/configurable/i);
  });

  it("documents the defaults the code ships, without changing them", () => {
    const limit = ZONE_DEFAULTS.effectiveLimit;
    const third = limit / 3;
    expect(readme).toContain(human(limit));
    expect(readme).toContain(`${(third / 1000).toFixed(1)}k`); // sharp → fading
    expect(readme).toContain(`${((2 * third) / 1000).toFixed(1)}k`); // fading → risky
    for (const zone of ["sharp", "fading", "risky", "caveman"] as const) {
      expect(readme).toContain(zone);
    }
  });

  it("explains whole-cell meter rounding", () => {
    expect(readme).toMatch(/nearest whole cell/);
    expect(readme).toMatch(/meterWidth/);
  });

  it("names the settings and environment overrides", () => {
    for (const key of [
      "effectiveLimit",
      "thresholds",
      "meterWidth",
      "EFFECTIVE_LIMIT",
      "Z_SHARP",
      "Z_FADING",
      "Z_RISKY",
    ]) {
      expect(readme).toContain(key);
    }
  });
});