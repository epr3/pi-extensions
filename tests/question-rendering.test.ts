/**
 * Behavior tests for Question tool call/result rendering.
 *
 * Verifies that:
 *   - The call row shows "Question" label and the prompt (header + question).
 *   - The result renderer clearly distinguishes preset selections,
 *     free-prose answers, and no-selection.
 *   - Non-interactive fallback renders plain text as-is.
 *
 * Uses a plain theme that strips ANSI codes, so tests verify the visible
 * text contract without depending on exact styling.
 *
 * Run:  npx tsx tests/question-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import {
  renderQuestionCall,
  renderQuestionResult,
} from "../packages/question/render.ts";
import type { QuestionResultDetails } from "../packages/question/render.ts";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedCall(args: { header?: string; question: string }): string[] {
  const component = renderQuestionCall(args, plainTheme);
  return component.render(80);
}

function callText(args: { header?: string; question: string }): string {
  return renderedCall(args).join("\n");
}

function renderedResult(
  result: Parameters<typeof renderQuestionResult>[0],
  isPartial = false,
  expanded = false,
): string[] {
  const component = renderQuestionResult(
    result,
    { isPartial, expanded },
    plainTheme,
    undefined,
  );
  return component.render(80);
}

function resultText(
  result: Parameters<typeof renderQuestionResult>[0],
  isPartial = false,
  expanded = false,
): string {
  return renderedResult(result, isPartial, expanded).join("\n");
}

// ---------------------------------------------------------------------------
// renderQuestionCall
// ---------------------------------------------------------------------------

function testCallShowsLabel() {
  const text = callText({ question: "What is your favorite color?" });
  assert.ok(text.includes("Question"), "call row shows Question label");
  console.log("  Shows Question label .............................. PASS");
}

function testCallShowsQuestion() {
  const text = callText({ question: "What is your favorite color?" });
  assert.ok(text.includes("What is your favorite color?"), "call row shows question text");
  console.log("  Shows question text ............................... PASS");
}

function testCallShowsHeaderAndQuestion() {
  const text = callText({ header: "Color", question: "What is your favorite color?" });
  assert.ok(text.includes("Color:"), "call row shows header");
  assert.ok(text.includes("What is your favorite color?"), "call row shows question after header");
  console.log("  Shows header and question ........................ PASS");
}

function testCallOmitsHeaderWhenAbsent() {
  const text = callText({ question: "Proceed?" });
  assert.ok(!text.includes("undefined"), "no header text when header omitted");
  assert.ok(text.includes("Proceed?"), "question visible without header prefix");
  console.log("  Omits header when absent ......................... PASS");
}

function testCallReturnsRenderable() {
  const component = renderQuestionCall(
    { question: "Pick one" },
    plainTheme,
  );
  assert.ok(typeof component.render === "function", "returns a renderable component");
  const lines = component.render(80);
  assert.ok(Array.isArray(lines), "render() returns an array");
  assert.ok(lines.length > 0, "render() returns at least one line");
  console.log("  Returns renderable component ..................... PASS");
}

function testCallStartsWithToolName() {
  const text = callText({ question: "Test?" });
  const trimmed = text.trim();
  assert.ok(trimmed.startsWith("Question"), "call row starts with tool name");
  console.log("  Call row starts with tool name ................... PASS");
}

// ---------------------------------------------------------------------------
// renderQuestionResult — preset selection
// ---------------------------------------------------------------------------

function testPresetSingleSelection() {
  const result = {
    content: [{ type: "text" as const, text: "Selected: Right size" }],
    details: {
      options: [{ label: "Right size", recommended: true }, { label: "Too coarse" }],
      selectedLabels: ["Right size"],
      interaction: "preset",
    } satisfies QuestionResultDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("✓"), "checkmark present for preset selection");
  assert.ok(text.includes("Right size"), "selected label shown");
  console.log("  Preset single selection ........................... PASS");
}

function testPresetMultiSelection() {
  const result = {
    content: [{ type: "text" as const, text: "Selected: A, B" }],
    details: {
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      selectedLabels: ["A", "B"],
      interaction: "preset",
    } satisfies QuestionResultDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("✓"), "checkmark present");
  assert.ok(text.includes("A"), "first label shown");
  assert.ok(text.includes("B"), "second label shown");
  console.log("  Preset multi selection ........................... PASS");
}

// ---------------------------------------------------------------------------
// renderQuestionResult — free prose
// ---------------------------------------------------------------------------

function testFreeProseAnswer() {
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
  assert.ok(text.includes("✎"), "pencil indicator for free prose");
  assert.ok(text.includes("Custom answer"), "free text shown");
  console.log("  Free prose answer ................................ PASS");
}

function testFreeProseTruncatesLongText() {
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
  assert.ok(text.length < 100, "long free text is truncated in result row");
  assert.ok(text.includes("…"), "truncation ellipsis present");
  console.log("  Free prose truncates long text ................... PASS");
}

// ---------------------------------------------------------------------------
// renderQuestionResult — no selection
// ---------------------------------------------------------------------------

function testNoSelection() {
  const result = {
    content: [{ type: "text" as const, text: "No selection" }],
    details: {
      options: [{ label: "Yes" }, { label: "No" }],
      selectedLabels: [],
      interaction: "none",
    } satisfies QuestionResultDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no selection"), "shows no-selection indicator");
  assert.ok(!text.includes("✓"), "no checkmark");
  assert.ok(!text.includes("✎"), "no pencil");
  console.log("  No selection ...................................... PASS");
}

// ---------------------------------------------------------------------------
// renderQuestionResult — non-interactive fallback
// ---------------------------------------------------------------------------

function testNonInteractiveFallback() {
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
  assert.ok(text.includes("Proceed?"), "question in fallback text");
  assert.ok(text.includes("Yes"), "option in fallback text");
  assert.ok(text.includes("No"), "option in fallback text");
  console.log("  Non-interactive fallback ......................... PASS");
}

// ---------------------------------------------------------------------------
// renderQuestionResult — missing details (fallback to raw content)
// ---------------------------------------------------------------------------

function testMissingDetailsFallback() {
  const result = {
    content: [{ type: "text" as const, text: "Selected: Yes" }],
  };
  const text = resultText(result as any);
  assert.ok(text.includes("Selected: Yes"), "falls back to raw content text");
  console.log("  Missing details fallback ......................... PASS");
}

// ---------------------------------------------------------------------------
// renderQuestionResult — partial / expanded flags (graceful noop)
// ---------------------------------------------------------------------------

function testPartialFlagDoesNotChangeResult() {
  const result = {
    content: [{ type: "text" as const, text: "Selected: Yes" }],
    details: {
      options: [{ label: "Yes" }, { label: "No" }],
      selectedLabels: ["Yes"],
      interaction: "preset",
    } satisfies QuestionResultDetails,
  };
  const partial = resultText(result, true);
  const final = resultText(result, false);
  assert.strictEqual(partial, final, "isPartial flag does not change rendering");
  console.log("  Partial flag does not change rendering ............ PASS");
}

function testExpandedFlagDoesNotChangeResult() {
  const result = {
    content: [{ type: "text" as const, text: "Selected: Yes" }],
    details: {
      options: [{ label: "Yes" }, { label: "No" }],
      selectedLabels: ["Yes"],
      interaction: "preset",
    } satisfies QuestionResultDetails,
  };
  const expanded = resultText(result, false, true);
  const collapsed = resultText(result, false, false);
  assert.strictEqual(expanded, collapsed, "expanded flag does not change rendering");
  console.log("  Expanded flag does not change rendering .......... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nQuestion rendering tests\n");

  // Call rendering
  testCallShowsLabel();
  testCallShowsQuestion();
  testCallShowsHeaderAndQuestion();
  testCallOmitsHeaderWhenAbsent();
  testCallReturnsRenderable();
  testCallStartsWithToolName();

  // Result rendering — preset
  testPresetSingleSelection();
  testPresetMultiSelection();

  // Result rendering — free prose
  testFreeProseAnswer();
  testFreeProseTruncatesLongText();

  // Result rendering — no selection
  testNoSelection();

  // Result rendering — non-interactive
  testNonInteractiveFallback();

  // Result rendering — edge cases
  testMissingDetailsFallback();
  testPartialFlagDoesNotChangeResult();
  testExpandedFlagDoesNotChangeResult();

  console.log("\nAll tests PASS\n");
}

main();
