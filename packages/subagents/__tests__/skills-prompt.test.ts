import { describe, it, expect } from "vitest";
import { composeCustomSystemPrompt, preloadedSkillsSection } from "../skills-prompt.ts";
import type { PreloadedSkill } from "../skills.ts";

const preloaded = (name: string, filePath: string, content: string): PreloadedSkill => ({
  name,
  filePath,
  content,
});

describe("composing a Subagent's initial context with preloaded skills", () => {
  it("appends each skill's complete SKILL.md content to the definition body", () => {
    const merged = composeCustomSystemPrompt("You review diffs.", [
      preloaded(
        "code-review",
        "/skills/review/SKILL.md",
        "STEP 1. Read the diff.\nSTEP 2. Report.",
      ),
    ]);

    expect(merged).toContain("You review diffs.");
    expect(merged).toContain('<skill name="code-review" file="/skills/review/SKILL.md">');
    expect(merged).toContain("STEP 1. Read the diff.\nSTEP 2. Report.");
    expect(merged.indexOf("You review diffs.")).toBeLessThan(merged.indexOf("STEP 1."));
  });

  it("states that preloading is not an access restriction", () => {
    const section = preloadedSkillsSection([preloaded("a", "/p/SKILL.md", "A body.")]);

    expect(section).toContain("not an access restriction");
    expect(section).toContain("readable on demand");
  });

  it("preloads skills even when the definition body is empty", () => {
    const merged = composeCustomSystemPrompt("", [
      preloaded("only", "/only/SKILL.md", "Only instructions."),
    ]);

    expect(merged).toContain("Only instructions.");
    expect(merged).not.toMatch(/^\n/);
  });

  it("falls through to the normal prompt when nothing is preloaded", () => {
    expect(composeCustomSystemPrompt(undefined, [])).toBeUndefined();
    expect(composeCustomSystemPrompt(undefined, undefined)).toBeUndefined();
    expect(composeCustomSystemPrompt("Body only", [])).toBe("Body only");
  });

  it("returns empty string from preloadedSkillsSection for no skills", () => {
    expect(preloadedSkillsSection(undefined)).toBe("");
    expect(preloadedSkillsSection([])).toBe("");
  });
});