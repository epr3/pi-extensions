/**
 * Question tool rendering tests — Vitest.
 *
 * Verifies user-facing tool call/result presentation without depending on
 * incidental styling — uses a plain theme that strips ANSI codes.
 */

import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderQuestionCall, renderQuestionResult, type QuestionResultDetails } from "../render.ts";

// Plain theme: pass-through, no styling.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function callText(args: { header?: string; question: string }): string {
  return renderQuestionCall(args, plainTheme).render(80).join("\n");
}

function resultText(
  result: Parameters<typeof renderQuestionResult>[0],
  isPartial = false,
  expanded = false,
): string {
  return renderQuestionResult(result, { isPartial, expanded }, plainTheme, undefined)
    .render(80)
    .join("\n");
}

describe("renderQuestionCall", () => {
  it("starts with the 'Question' tool name", () => {
    const text = callText({ question: "Test?" });
    expect(text.trimStart()).toMatch(/^Question/);
  });

  it("shows the question text", () => {
    const text = callText({ question: "What is your favorite color?" });
    expect(text).toContain("What is your favorite color?");
  });

  it("prefixes the question with the header when one is given", () => {
    const text = callText({ header: "Color", question: "What is your favorite color?" });
    expect(text).toContain("Color:");
    expect(text).toContain("What is your favorite color?");
  });

  it("omits the header prefix when none is given", () => {
    const text = callText({ question: "Proceed?" });
    expect(text).not.toContain("undefined");
    expect(text).toContain("Proceed?");
  });

  it("returns a renderable component producing at least one line", () => {
    const component = renderQuestionCall({ question: "Pick one" }, plainTheme);
    expect(typeof component.render).toBe("function");
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("renderQuestionResult — preset selection", () => {
  it("marks a single preset selection with a checkmark and the label", () => {
    const result = {
      content: [{ type: "text" as const, text: "Selected: Right size" }],
      details: {
        options: [{ label: "Right size", recommended: true }, { label: "Too coarse" }],
        selectedLabels: ["Right size"],
        interaction: "preset",
      } satisfies QuestionResultDetails,
    };
    const text = resultText(result);
    expect(text).toContain("✓");
    expect(text).toContain("Right size");
  });

  it("marks a multi-select with checkmark and all selected labels", () => {
    const result = {
      content: [{ type: "text" as const, text: "Selected: A, B" }],
      details: {
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        selectedLabels: ["A", "B"],
        interaction: "preset",
      } satisfies QuestionResultDetails,
    };
    const text = resultText(result);
    expect(text).toContain("✓");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });
});

describe("renderQuestionResult — free prose", () => {
  it("marks a free-prose answer with the pencil glyph and the typed text", () => {
    const result = {
      content: [{ type: "text" as const, text: "Free text: Custom answer" }],
      details: {
        options: [{ label: "Yes" }, { label: "No" }],
        selectedLabels: [],
        freeText: "Custom answer",
        interaction: "freeProse",
      } satisfies QuestionResultDetails,
    };
    const text = resultText(result);
    expect(text).toContain("✎");
    expect(text).toContain("Custom answer");
  });

  it("truncates very long free-prose text with an ellipsis", () => {
    const longText = "a".repeat(100);
    const result = {
      content: [{ type: "text" as const, text: `Free text: ${longText}` }],
      details: {
        options: [{ label: "Yes" }, { label: "No" }],
        selectedLabels: [],
        freeText: longText,
        interaction: "freeProse",
      } satisfies QuestionResultDetails,
    };
    const text = resultText(result);
    expect(text.length).toBeLessThan(100);
    expect(text).toContain("…");
  });
});

describe("renderQuestionResult — no selection", () => {
  it("shows a muted no-selection indicator and no glyphs", () => {
    const result = {
      content: [{ type: "text" as const, text: "No selection" }],
      details: {
        options: [{ label: "Yes" }, { label: "No" }],
        selectedLabels: [],
        interaction: "none",
      } satisfies QuestionResultDetails,
    };
    const text = resultText(result);
    expect(text).toContain("no selection");
    expect(text).not.toContain("✓");
    expect(text).not.toContain("✎");
  });
});

describe("renderQuestionResult — non-interactive fallback", () => {
  it("renders the fallback prose text verbatim", () => {
    const prose = "Proceed?\n  · Yes  (recommended)\n  · No";
    const result = {
      content: [{ type: "text" as const, text: prose }],
      details: {
        options: [{ label: "Yes", recommended: true }, { label: "No" }],
        selectedLabels: [],
        interaction: "nonInteractive",
      } satisfies QuestionResultDetails,
    };
    const text = resultText(result);
    expect(text).toContain("Proceed?");
    expect(text).toContain("Yes");
    expect(text).toContain("No");
  });
});

describe("renderQuestionResult — edge cases", () => {
  it("falls back to raw content text when details are missing", () => {
    const result = {
      content: [{ type: "text" as const, text: "Selected: Yes" }],
    };
    const text = resultText(result as unknown as Parameters<typeof renderQuestionResult>[0]);
    expect(text).toContain("Selected: Yes");
  });

  it("does not change rendering when isPartial is true", () => {
    const result = {
      content: [{ type: "text" as const, text: "Selected: Yes" }],
      details: {
        options: [{ label: "Yes" }, { label: "No" }],
        selectedLabels: ["Yes"],
        interaction: "preset",
      } satisfies QuestionResultDetails,
    };
    expect(resultText(result, true)).toBe(resultText(result, false));
  });

  it("does not change rendering when expanded is true", () => {
    const result = {
      content: [{ type: "text" as const, text: "Selected: Yes" }],
      details: {
        options: [{ label: "Yes" }, { label: "No" }],
        selectedLabels: ["Yes"],
        interaction: "preset",
      } satisfies QuestionResultDetails,
    };
    expect(resultText(result, false, true)).toBe(resultText(result, false, false));
  });
});