/**
 * BoundedQuestionDialog tests — deterministic rendering and interaction.
 *
 * These tests verify the bounded-rendering invariant (line count, line width),
 * header truncation, option completeness, and programmatic selection without
 * any live terminal dependency.
 */

import { describe, it, expect, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  BoundedQuestionDialog,
  boundedEditorTitle,
  boundedSelectionSummary,
  DONE_DISPLAY,
  DONE_VALUE,
  type DialogOption,
} from "../dialog.ts";

// ── Helpers ────────────────────────────────────────────────────────────

/** Maximum visible width of any line in an array. */
function maxLineWidth(lines: string[]): number {
  return lines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
}

/** Convenience factory for a dialog with sensible defaults. */
function makeDialog(overrides?: {
  title?: string;
  options?: DialogOption[];
  freeTextLabel?: string;
  maxLines?: number;
  maxWidth?: number;
  maxHeaderLines?: number;
}): BoundedQuestionDialog {
  const opts = {
    title: overrides?.title ?? "Pick one?",
    options: overrides?.options ?? [
      { label: "Yes", description: "Affirmative" },
      { label: "No", description: "Negative" },
    ],
    freeTextLabel: overrides?.freeTextLabel ?? "Type your answer",
    maxLines: overrides?.maxLines,
    maxWidth: overrides?.maxWidth,
    maxHeaderLines: overrides?.maxHeaderLines,
  };
  return new BoundedQuestionDialog(opts);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("BoundedQuestionDialog construction", () => {
  it("creates a valid dialog with required options", () => {
    const d = makeDialog();
    expect(d).toBeInstanceOf(BoundedQuestionDialog);
    expect(d.maxLines).toBeGreaterThan(0);
    expect(d.maxWidth).toBeGreaterThan(0);
  });

  it("exposes config constants for test assertions", () => {
    const d = makeDialog({ maxLines: 10, maxWidth: 60, maxHeaderLines: 2 });
    expect(d.maxLines).toBe(10);
    expect(d.maxWidth).toBe(60);
    expect(d.maxHeaderLines).toBe(2);
  });

  it("uses sensible defaults when no budget is specified", () => {
    const d = makeDialog();
    expect(d.maxLines).toBe(15);
    expect(d.maxWidth).toBe(120);
    expect(d.maxHeaderLines).toBe(3);
  });

  it("implements the Component interface (render, handleInput, invalidate)", () => {
    const d = makeDialog();
    expect(typeof d.render).toBe("function");
    expect(typeof d.handleInput).toBe("function");
    expect(typeof d.invalidate).toBe("function");
  });
});

describe("BoundedQuestionDialog bounded line count", () => {
  it("respects the maxLines budget when the dialog fits", () => {
    // Small title + 2 options = header(1) + separator(1) + list(2) = 4
    const d = makeDialog({ maxLines: 6 });
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("never exceeds maxLines even with many options", () => {
    // 4 options + free text = 5 items, header=1, sep=1, list=5 → total=7
    const d = makeDialog({
      title: "Pick one?",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
      maxLines: 5,
    });
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("fits a long multi-line header within maxLines", () => {
    // Long title that wraps to 3 lines + separator(1) + list items = total
    const d = makeDialog({
      title:
        "Are you absolutely, positively, without-a-doubt sure that you want to proceed with this action right now?",
      maxLines: 8,
      maxWidth: 40,
      maxHeaderLines: 3,
    });
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("reserves at least one line for the list even when header fills the budget", () => {
    // Header takes all lines → list budget should still be at least 1
    const d = makeDialog({
      title: "Short",
      maxLines: 1,
      maxHeaderLines: 1,
    });
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});

describe("BoundedQuestionDialog line width bounding", () => {
  it("renders every line within maxWidth when terminal is wider", () => {
    const d = makeDialog({ maxWidth: 50 });
    const lines = d.render(120); // terminal wider than maxWidth
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(50);
  });

  it("renders every line within terminal width when terminal is narrower than maxWidth", () => {
    const d = makeDialog({
      maxWidth: 120,
      title:
        "Grammar strictness: How constrained should the Markdown grammar be? I recommend a canonical, documented structure—title, optional link, required description, then named responsibility sections—so authors and tests cross a predictable seam.",
    });
    const lines = d.render(106); // narrower than the default display budget
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(106);
  });

  it("keeps long descriptions within the render width", () => {
    const d = makeDialog({
      options: [
        {
          label: "A",
          description:
            "This is an extremely long description that should be wrapped or truncated to fit within the requested dialog width without overflowing",
        },
        {
          label: "B",
          description:
            "Another very lengthy description that should also stay within the width bound",
        },
      ],
      maxLines: 8,
      maxWidth: 80,
    });
    const lines = d.render(80);
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(80);
  });
});

describe("BoundedQuestionDialog header truncation", () => {
  it("shows short titles without truncation", () => {
    const d = makeDialog({ title: "Proceed?", maxHeaderLines: 2 });
    const lines = d.render(80);
    const headerEnd = lines.indexOf("");
    const headerLines = headerEnd >= 0 ? lines.slice(0, headerEnd) : lines;
    expect(headerLines.length).toBeGreaterThanOrEqual(1);
    expect(headerLines[0]).toContain("Proceed?");
  });

  it("caps long titles to maxHeaderLines and shows truncation affordance", () => {
    // Title that wraps to 5+ lines at width 40
    const longTitle =
      "This is an extremely long question that should definitely be truncated to a reasonable number of lines so it doesn't take up too much space in the bounded dialog.";
    const d = makeDialog({
      title: longTitle,
      maxWidth: 40,
      maxHeaderLines: 2,
    });
    const lines = d.render(80);
    const headerEnd = lines.indexOf("");
    const headerLines = headerEnd >= 0 ? lines.slice(0, headerEnd) : lines;
    expect(headerLines.length).toBeLessThanOrEqual(2);
    // Truncation affordance (ellipsis or similar)
    const lastHeader = headerLines[headerLines.length - 1] ?? "";
    expect(visibleWidth(lastHeader)).toBeLessThanOrEqual(40);
  });

  it("does not truncate when title fits within maxHeaderLines", () => {
    const d = makeDialog({
      title: "Short question?",
      maxHeaderLines: 3,
    });
    const lines = d.render(80);
    const headerEnd = lines.indexOf("");
    const headerLines = headerEnd >= 0 ? lines.slice(0, headerEnd) : lines;
    expect(headerLines.length).toBeGreaterThanOrEqual(1);
    expect(headerLines[0]).toContain("Short question?");
  });
});

describe("BoundedQuestionDialog long supplied header layout", () => {
  const DOWN = "\x1b[B";
  const LONG_HEADER =
    "An extremely long supplied header that keeps going and going well past any reasonable header budget for a question dialog";

  /** Multi-select dialog whose wrapped answers overflow a narrow viewport. */
  function longHeaderDialog(): BoundedQuestionDialog {
    return new BoundedQuestionDialog({
      title: `${LONG_HEADER}: Right size?`,
      options: [
        {
          label: "A",
          description:
            "first option whose description is deliberately long enough to wrap several times at narrow width",
        },
        {
          label: "B",
          description:
            "second option whose description is deliberately long enough to wrap several times at narrow width",
        },
        {
          label: "C",
          description:
            "third option whose description is deliberately long enough to wrap several times at narrow width",
        },
      ],
      freeTextLabel: "Type your answer",
      freeTextDisplay: "✎ Type your answer — Write a custom response",
      multiSelect: true,
      chosenLabels: ["A"],
    });
  }

  it("keeps the focused answer visible when the header fills the header budget", () => {
    // A narrow terminal: the header wraps to the full 3-line budget and the
    // selection summary adds one more line, so the list viewport must shrink
    // with it instead of pushing the focused answer off the bottom.
    const WIDTH = 40;
    const d = longHeaderDialog();
    for (let i = 0; i < 4; i++) d.handleInput(DOWN); // Done is the last answer item

    const lines = d.render(WIDTH);
    expect(lines.length).toBeLessThanOrEqual(d.maxLines);
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(WIDTH);
    // Exactly one focused answer item is marked, and it is not clipped away.
    expect(lines.filter((line) => line.startsWith("→ "))).toHaveLength(1);
    expect(lines.join("\n")).toContain(DONE_DISPLAY);
  });
});

describe("BoundedQuestionDialog option completeness", () => {
  it("includes all preset options in the rendered output", () => {
    const d = makeDialog({
      options: [
        { label: "Alpha", description: "First" },
        { label: "Beta", description: "Second" },
        { label: "Gamma", description: "Third" },
      ],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("Alpha");
    expect(output).toContain("Beta");
    expect(output).toContain("Gamma");
  });

  it("includes the free-prose escape hatch in the rendered output", () => {
    const d = makeDialog({
      freeTextLabel: "My answer",
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("✎");
    expect(output).toContain("My answer");
  });

  it("shows description text for options that have one", () => {
    const d = makeDialog({
      options: [{ label: "Opt", description: "Has a description" }, { label: "NoDesc" }],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("Has a description");
  });
});

describe("BoundedQuestionDialog recommended option", () => {
  it("marks the recommended option with (recommended) visible text", () => {
    const d = makeDialog({
      options: [{ label: "First", recommended: true }, { label: "Second" }],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("recommended");
    // Ensure it's attached to the right option
    const firstLine = lines.find((l) => l.includes("First"));
    expect(firstLine).toBeTruthy();
    expect(firstLine).toContain("recommended");
  });

  it("does not mark non-recommended options", () => {
    const d = makeDialog({
      options: [{ label: "One" }, { label: "Two" }, { label: "Three" }],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    // "(recommended)" should not appear
    expect(output).not.toContain("recommended");
  });
});

describe("BoundedQuestionDialog interaction", () => {
  // Raw terminal sequences matching matchesKey expectations:
  const ENTER = "\r";
  const ESCAPE = "\x1b";
  const UP = "\x1b[A";
  const DOWN = "\x1b[B";

  it("fires onSelect with the first option when enter is pressed (default selection)", () => {
    const d = makeDialog({
      options: [{ label: "Choice A" }, { label: "Choice B" }],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0];
    expect(item.label).toContain("Choice A");
  });

  it("fires onSelect with the navigated-to option after moving down", () => {
    const d = makeDialog({
      options: [{ label: "First" }, { label: "Second" }],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN);
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0];
    expect(item.label).toContain("Second");
  });

  it("fires onCancel when escape is pressed", () => {
    const d = makeDialog();
    const onCancel = vi.fn();
    d.onCancel = onCancel;

    d.handleInput(ESCAPE);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("selects the second option after pressing down then enter", () => {
    const d = makeDialog({
      options: [{ label: "Top" }, { label: "Middle" }, { label: "Bottom" }],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Down from Top → Middle
    d.handleInput(DOWN);
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0];
    expect(item.label).toContain("Middle");
  });

  it("wraps to the last item when pressing up at the first item", () => {
    const d = makeDialog({
      options: [{ label: "Top" }, { label: "Middle" }, { label: "Bottom" }],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Up at first item wraps to the last (free text)
    d.handleInput(UP);
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0];
    expect(item.label).toContain("✎");
  });
});

// ── boundedEditorTitle ──────────────────────────────────────────────────

describe("boundedEditorTitle", () => {
  it("returns the header when a header is provided", () => {
    expect(
      boundedEditorTitle(
        "Confirm",
        "A very long question that would otherwise be unbounded in the editor title?",
      ),
    ).toBe("Confirm");
  });

  it("returns the full question when no header and question is short", () => {
    expect(boundedEditorTitle(undefined, "Proceed?")).toBe("Proceed?");
  });

  it("caps a long question to 60 chars with ellipsis when no header", () => {
    const longQ =
      "Are you absolutely, positively, without-a-doubt sure that you want to proceed with this action right now, here, today?";
    const result = boundedEditorTitle(undefined, longQ);
    // Must be shorter than the original
    expect(result.length).toBeLessThan(longQ.length);
    // Must end with truncation suffix
    expect(result).toMatch(/…$/);
    // Must not exceed the char limit
    expect(result.length).toBeLessThanOrEqual(61); // 60 chars max + suffix replaces last char
    expect(result.length).toBe(60); // 59 chars + "…" = 60 chars
  });

  it("does not cap a short question when no header", () => {
    const shortQ = "Pick one?";
    expect(boundedEditorTitle(undefined, shortQ)).toBe("Pick one?");
  });

  it("uses header even when question is empty", () => {
    expect(boundedEditorTitle("Go", "")).toBe("Go");
  });

  it("caps an oversized header to 60 chars with ellipsis", () => {
    const longHeader =
      "An extremely long supplied header that keeps going and going well past any reasonable display budget";
    const result = boundedEditorTitle(longHeader, "Right size?");
    expect(result.length).toBe(60);
    expect(result).toMatch(/…$/);
    expect(longHeader.startsWith(result.slice(0, -1))).toBe(true);
    expect(result).not.toContain("display budget");
  });

  it("returns empty string when both header and question are empty/undefined", () => {
    expect(boundedEditorTitle(undefined, "")).toBe("");
  });
});

// ── Selection identity ────────────────────────────────────────────────

describe("BoundedQuestionDialog selection identity", () => {
  const ENTER = "\r";
  const DOWN = "\x1b[B";

  it("reports the preset option item identity, not its display text", () => {
    const d = makeDialog({
      options: [
        { label: "Right", description: "feels right", recommended: true },
        { label: "Wrong", description: "feels off" },
      ],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Start at first (recommended) option, confirm
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0]!;
    expect(item.value).toBe("option:0");
    // The display text stays available for rendering.
    expect(item.label).toBe("Right  (recommended)");
  });

  it("reports the free-prose control identity when free text is selected", () => {
    const d = makeDialog({
      options: [{ label: "Alpha" }, { label: "Beta" }],
      freeTextLabel: "My answer",
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Navigate to the last item (free text, since all presets + free text = 3 items)
    d.handleInput(DOWN);
    d.handleInput(DOWN);
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0]!;
    expect(item.value).toBe("freeText");
    expect(item.label).toContain("✎ My answer");
  });
});

// ── Multi-select rendering ─────────────────────────────────────────────

describe("BoundedQuestionDialog multi-select rendering", () => {
  it("shows checkmark (✓) for selected options", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "Alpha" }, { label: "Beta" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: ["Alpha"],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("✓ Alpha");
    expect(output).toContain("○ Beta");
  });

  it("shows circle (○) when nothing is selected", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "Alpha" }, { label: "Beta" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: [],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("○ Alpha");
    expect(output).toContain("○ Beta");
  });

  it("includes the Done completion button", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "Alpha" }, { label: "Beta" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: [],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain(DONE_DISPLAY);
  });

  it("hides the free-text option when hasFreeText is true", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "Alpha" }, { label: "Beta" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: [],
      hasFreeText: true,
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).not.toContain("✎");
    expect(output).not.toContain("Type your answer");
    // But Done button is still there
    expect(output).toContain(DONE_DISPLAY);
  });

  it("shows bounded selection summary when labels are chosen", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: ["Alpha", "Beta"],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("2 selected");
    // Individual checkmarks still present
    expect(output).toContain("✓ Alpha");
    expect(output).toContain("✓ Beta");
  });

  it("reports a count-only summary with no shortened label preview", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [
        { label: "A very long option label that must never appear as a shortened preview" },
        { label: "Beta" },
        { label: "Gamma" },
      ],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: [
        "A very long option label that must never appear as a shortened preview",
        "Beta",
      ],
      maxWidth: 40,
    });
    const lines = d.render(80);
    const output = lines.join("\n");
    // The summary reports only the selected count.
    const summary = lines.find((l) => l.includes("selected"));
    expect(summary).toBe("[2 selected]");
    // No label preview anywhere: no "selected:" prefix and no ellipsis (the
    // option rows keep full wrapped labels, so ellipsis would betray a preview).
    expect(output).not.toContain("selected:");
    expect(output).not.toMatch(/…/);
    // Full labels are still readable in the option rows.
    expect(output).toContain("✓ A very long option label");
    expect(output).toContain("✓ Beta");
  });

  it("keeps the summary bounded within maxWidth", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick",
      options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: ["Alpha", "Beta"],
      maxWidth: 30,
    });
    const lines = d.render(80);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("includes all preset options alongside the Done button", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: [],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("Alpha");
    expect(output).toContain("Beta");
    expect(output).toContain("Gamma");
    expect(output).toContain(DONE_DISPLAY);
  });

  it("preserves recommended marking in multi-select items", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "First", recommended: true }, { label: "Second" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: [],
    });
    const lines = d.render(80);
    const output = lines.join(" ");
    expect(output).toContain("recommended");
    expect(output).toContain("First");
  });

  it("respects the maxLines budget", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: ["A", "B"],
      maxLines: 6,
    });
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(6);
  });
});

// ── Multi-select interaction ────────────────────────────────────────────

describe("BoundedQuestionDialog multi-select interaction", () => {
  const ENTER = "\r";
  const DOWN = "\x1b[B";

  it("fires onSelect with the preset option value when selected", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A", description: "First option" }, { label: "B" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: [],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0]!;
    expect(item.label).toContain("A");
  });

  it("fires onSelect with DONE_DISPLAY when Done is pressed", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: [],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Items: ○ A, ○ B, ✎ Type..., ✓ Done = 4 items
    // Navigate to Done (4th item, need 3 downs from top)
    d.handleInput(DOWN);
    d.handleInput(DOWN);
    d.handleInput(DOWN);
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0]!;
    expect(item.label).toBe(DONE_DISPLAY);
  });

  it("fires onSelect with the free-prose control identity when free text is selected", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "My answer",
      multiSelect: true,
      chosenLabels: [],
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Items: ○ A, ○ B, ✎ My answer..., ✓ Done = 4 items
    // Navigate to free text (3rd item, need 2 downs)
    d.handleInput(DOWN);
    d.handleInput(DOWN);
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    const item = onSelect.mock.calls[0]![0]!;
    expect(item.value).toBe("freeText");
    expect(item.label).toContain("My answer");
  });

  it("fires onCancel when escape is pressed", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: [],
    });
    const onCancel = vi.fn();
    d.onCancel = onCancel;

    d.handleInput("\x1b");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ── Requested initial focus ────────────────────────────────────────────────

describe("BoundedQuestionDialog requested initial focus", () => {
  const ENTER = "\r";

  it("starts focused on the requested preset option value and shows its checkbox", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      freeTextLabel: "Type your answer",
      multiSelect: true,
      chosenLabels: ["B"],
      initialFocusValue: "option:1",
    });
    const lines = d.render(80).join("\n");
    // The focus prefix sits on B and its checkbox reflects the chosen state.
    expect(lines).toContain("→ ✓ B");

    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].label).toBe("✓ B");
  });

  it("falls back to the first item when the requested focus value is unknown", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: [],
      initialFocusValue: "No such option",
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].label).toBe("○ A");
  });

  it("can start focused on the Done completion button", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: [],
      initialFocusValue: "done",
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].label).toBe(DONE_DISPLAY);
  });
});

// ── boundedSelectionSummary ─────────────────────────────────────────────

describe("boundedSelectionSummary", () => {
  it("returns empty string when no labels are chosen", () => {
    expect(boundedSelectionSummary([], 80)).toBe("");
  });

  it("reports only the selected count with no label preview", () => {
    expect(boundedSelectionSummary(["A"], 80)).toBe("[1 selected]");
    expect(boundedSelectionSummary(["Alpha", "Beta"], 80)).toBe("[2 selected]");
  });

  it("never emits a shortened label preview or ellipsis, however long the labels", () => {
    const result = boundedSelectionSummary(
      ["ExtremelyLongOptionNameThatShouldNeverBePreviewed", "AnotherLongOption"],
      30,
    );
    expect(result).toBe("[2 selected]");
    expect(result).not.toContain("ExtremelyLong");
    expect(result).not.toMatch(/…/);
    expect(visibleWidth(result)).toBeLessThanOrEqual(30);
  });

  it("collapses to a bare count when the summary does not fit", () => {
    const result = boundedSelectionSummary(["A", "B"], 10);
    expect(result).toBe("[2]");
    expect(visibleWidth(result)).toBeLessThanOrEqual(10);
  });
});
// ── Cancellation ────────────────────────────────────────────────────────

describe("BoundedQuestionDialog cancellation", () => {
  const ENTER = "\r";
  const ESCAPE = "\x1b";

  it("fires only onCancel when escape discards partial multi-selections", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: ["A", "C"],
    });
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    d.onSelect = onSelect;
    d.onCancel = onCancel;

    d.handleInput(ESCAPE);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps Done as the only way to confirm multi-select choices", () => {
    const d = new BoundedQuestionDialog({
      title: "Pick any",
      options: [{ label: "A" }, { label: "B" }],
      freeTextLabel: "Type",
      multiSelect: true,
      chosenLabels: ["A"],
      initialFocusValue: DONE_VALUE,
    });
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Focus starts on Done; confirming reports the Done value, never a preset.
    d.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]!.value).toBe(DONE_VALUE);
  });
});