/**
 * Scrollable option label tests — deterministic rendering and interaction for
 * wrapped, item-navigated preset-answer labels (ticket 0001).
 *
 * The Bounded question dialog navigates selectable answer items with
 * Up/Down — one item per press, regardless of wrapped label height — and
 * reveals an oversized Scrollable option label through explicit PageUp/PageDown
 * paging that never changes focus.
 *
 * Acceptance criteria covered:
 * - long preset + free-prose labels readable in full (wrapping, no ellipsis)
 * - Up/Down moves the focus exactly one item per press incl. wraparound
 * - PageUp/PageDown reveals every line of an oversized label without changing
 *   focus or selecting an answer; revisiting an item starts at its first line
 * - short labels keep one-step navigation incl. wraparound
 * - every rendered state respects the Display budget (maxLines, maxWidth)
 *
 * Line arithmetic: with title "Pick one?" (1 header row), a separator row, and
 * maxLines 6, the list viewport renders 4 rows. LONG_LABEL wraps to rows
 * 0..4, then "Beta" (row 5), then the free-prose label (rows 6..10); total
 * 11 wrapped rows.
 */

import { describe, it, expect, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BoundedQuestionDialog, DONE_DISPLAY, type DialogOption } from "../dialog.ts";

const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

/** Wraps to exactly 5 rows at maxWidth 30 (wrap width 28); last row "single word in full ZZZEND". */
const LONG_LABEL =
  "Alpha this option has an extremely long answer label that wraps onto many lines so the reader can see every single word in full ZZZEND";

/** Wraps to exactly 10 rows at maxWidth 28 (wrap width 26); last row "readable TALLEND". */
const TALL_LABEL =
  "Tallest option with a truly enormous answer label that needs many wrapped lines to fit inside a narrow bounded dialog because the terminal budget is very small indeed and every single word must remain readable TALLEND";

const LONG_FREE_TEXT_LABEL =
  "Type a really long free prose answer describing exactly what you want in full ZZZEND";

function makeDialog(overrides?: {
  title?: string;
  options?: DialogOption[];
  freeTextLabel?: string;
  maxLines?: number;
  maxWidth?: number;
}): BoundedQuestionDialog {
  return new BoundedQuestionDialog({
    title: overrides?.title ?? "Pick one?",
    options: overrides?.options ?? [{ label: "Yes" }, { label: "No" }],
    freeTextLabel: overrides?.freeTextLabel ?? "Type your answer",
    freeTextDisplay: overrides?.freeTextLabel
      ? `✎ ${overrides.freeTextLabel} — Write a custom response`
      : "✎ Type your answer — Write a custom response",
    maxLines: overrides?.maxLines,
    maxWidth: overrides?.maxWidth,
  });
}

function maxLineWidth(lines: string[]): number {
  return lines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
}

/** Collapse wrapped-line breaks + row prefixes so word content is comparable. */
function normalized(lines: string[]): string {
  return lines
    .map((l) => l.replace(/^\s+/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** Establish wrapped line counts the way the TUI does: render once before input. */
function renderOnce(d: BoundedQuestionDialog): string[] {
  return d.render(80);
}

describe("scrollable option labels — readability", () => {
  it("wraps long preset and free-prose labels in full with no ellipsis", () => {
    const d = makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
    });
    const lines = d.render(80);
    const output = lines.join("\n");

    // Every word of the long preset label is present, incl. its last line.
    expect(normalized(lines)).toContain(LONG_LABEL);
    // The free-prose choice is present in full too.
    expect(normalized(lines)).toContain(`✎ ${LONG_FREE_TEXT_LABEL} — Write a custom response`);
    // No answer-label ellipsis anywhere in the rendered dialog.
    expect(output).not.toMatch(/…/);
    expect(output).not.toMatch(/\.\.\./);
  });
});

describe("scrollable option labels — item navigation", () => {
  // Header(1) + separator(1) + maxLines 6 → 4-row list viewport.
  // LONG_LABEL rows 0..4 → last row initially hidden behind the viewport.
  function longFirstDialog(): BoundedQuestionDialog {
    return makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
      maxLines: 6,
    });
  }

  it("Down moves to the next item in one press, whatever the label height", () => {
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    const initial = d.render(80).join("\n");
    expect(initial).toContain("Alpha this option has an"); // row 0
    expect(initial).not.toContain("Beta"); // next item hidden

    d.handleInput(DOWN); // one press crosses the whole 5-row label
    const afterOne = d.render(80).join("\n");
    expect(afterOne).toContain("Beta");
    expect(afterOne).not.toContain("Alpha this option has an");

    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Beta");
  });

  it("Up moves back to the previous item in one press", () => {
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN); // focus Beta
    d.handleInput(UP); // back to LONG — viewport restarts at row 0

    expect(d.render(80).join("\n")).toContain("Alpha this option has an");
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Alpha");
  });

  it("reaches the last free-prose item and wraps back to the first in one press each", () => {
    // items: LONG(5 rows), Beta(1), free-prose(5) — rows 0..10.
    const d = makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
      maxLines: 6,
    });
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN); // Beta
    d.handleInput(DOWN); // free prose — still one press despite 5 wrapped rows
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("✎");

    d.handleInput(DOWN); // wraps to the first item
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[1]![0].value).toContain("Alpha");

    d.handleInput(UP); // wraps back to free prose
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[2]![0].value).toContain("✎");
  });
});

describe("scrollable option labels — explicit label paging", () => {
  function longFirstDialog(): BoundedQuestionDialog {
    return makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
      maxLines: 6,
    });
  }

  it("PageDown reveals the focused long label's hidden rows", () => {
    const d = longFirstDialog();
    renderOnce(d);

    const initial = d.render(80).join("\n");
    expect(initial).toContain("Alpha this option has an"); // row 0
    expect(initial).toContain("that wraps onto many lines"); // row 2
    expect(initial).not.toContain("single word in full ZZZEND"); // row 4 hidden
    expect(initial).not.toContain("Beta"); // next item still hidden

    d.handleInput(PAGE_DOWN);
    const paged = d.render(80).join("\n");
    expect(paged).toContain("single word in full ZZZEND"); // row 4 now visible
    expect(paged).not.toContain("Beta"); // still inside the focused label

    // Focus and selection stay on LONG throughout.
    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Alpha");
  });

  it("PageUp reveals preceding rows of the focused long label", () => {
    const d = longFirstDialog();
    renderOnce(d);
    d.handleInput(PAGE_DOWN); // rows 1..4 visible

    d.handleInput(PAGE_UP); // rows 0..3 visible again
    const out = d.render(80).join("\n");
    expect(out).toContain("Alpha this option has an");
    expect(out).not.toContain("single word in full ZZZEND");
  });

  it("pages through a taller-than-viewport label fully and within the budget", () => {
    // TALL_LABEL wraps to 10 rows (0..9); the 4-row viewport pages 0→4→6.
    const d = makeDialog({
      options: [{ label: TALL_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 28,
      maxLines: 6,
    });
    renderOnce(d);

    for (let i = 0; i < 3; i++) {
      const lines = d.render(80);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(maxLineWidth(lines)).toBeLessThanOrEqual(28);
      d.handleInput(PAGE_DOWN);
    }

    // After 3 PageDown presses the 10-row label's last row is reachable.
    expect(d.render(80).join("\n")).toContain("readable TALLEND");
    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER); // still the TALL item
    expect(onSelect.mock.calls[0]![0].value).toContain("Tallest");

    d.handleInput(DOWN); // one press moves on to Beta
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[1]![0].value).toContain("Beta");
  });
});

describe("scrollable option labels — short labels unchanged", () => {
  it("keeps one-step navigation and wraparound for short labels", () => {
    const d = makeDialog({
      options: [{ label: "Top" }, { label: "Middle" }, { label: "Bottom" }],
    });
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN);
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Middle");

    d.handleInput(DOWN);
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[1]![0].value).toContain("Bottom");

    d.handleInput(DOWN);
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[2]![0].value).toContain("✎"); // free prose

    d.handleInput(DOWN); // wraps to the first option
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[3]![0].value).toContain("Top");

    d.handleInput(UP); // wraps back to the last option
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[4]![0].value).toContain("✎");
  });

  it("keeps the recommended marker readable on a long label", () => {
    const d = makeDialog({
      options: [{ label: LONG_LABEL, recommended: true }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
    });
    const output = d.render(80).join("\n");
    expect(output).toContain("(recommended)");
    expect(output).not.toMatch(/…/);

    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("recommended");
  });
});

describe("multi-select scrollable option labels", () => {
  /**
   * Multi-select dialog: LONG_LABEL wraps to rows 0..4, "Beta" row 5, the
   * free-prose choice rows 6..10, Done row 11 — 12 wrapped rows total.
   * Header(1) + separator(1) leaves a 4-row list viewport at maxLines 6, so
   * the long label's final row starts hidden.
   */
  function multiDialog(overrides?: {
    chosenLabels?: string[];
    maxLines?: number;
    maxWidth?: number;
  }): BoundedQuestionDialog {
    return new BoundedQuestionDialog({
      title: "Pick many",
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      freeTextDisplay: `✎ ${LONG_FREE_TEXT_LABEL} — Write a custom response`,
      multiSelect: true,
      chosenLabels: overrides?.chosenLabels ?? [],
      maxLines: overrides?.maxLines,
      maxWidth: overrides?.maxWidth,
    });
  }

  it("pages a long multi-select label into view with no ellipsis", () => {
    const d = multiDialog({ maxWidth: 30, maxLines: 6 });
    renderOnce(d);

    const initial = d.render(80).join("\n");
    expect(initial).toContain("○ Alpha this option has an"); // row 0
    expect(initial).toContain("so the reader can see every"); // row 3
    expect(initial).not.toContain("single word in full ZZZEND"); // row 4 hidden
    expect(initial).not.toContain("Beta"); // next item hidden
    expect(initial).not.toMatch(/…/);

    d.handleInput(PAGE_DOWN);
    const paged = d.render(80).join("\n");
    expect(paged).toContain("single word in full ZZZEND"); // row 4 visible
    expect(paged).not.toContain("Beta"); // focus unchanged
    expect(paged).not.toMatch(/…/);
  });

  it("toggles the focused item, then one press reaches the next item", () => {
    const d = multiDialog({ maxWidth: 30, maxLines: 6 });
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(ENTER); // toggle the focused LONG item
    expect(onSelect.mock.calls[0]![0].value).toContain("Alpha");

    d.handleInput(DOWN); // one press crosses the whole wrapped label onto Beta
    d.handleInput(ENTER); // toggle Beta
    expect(onSelect.mock.calls[1]![0].value).toContain("Beta");
  });

  it("keeps the free-prose choice reachable in multi-select", () => {
    const d = multiDialog({ maxWidth: 30, maxLines: 6 });
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN); // Beta
    d.handleInput(DOWN); // free prose — one press despite its wrapped height
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("✎");
  });

  it("reaches the Done completion and wraps around one press at a time", () => {
    const d = multiDialog({ maxWidth: 30, maxLines: 6 });
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN); // Beta
    d.handleInput(DOWN); // free prose
    d.handleInput(DOWN); // Done
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toBe(DONE_DISPLAY);

    d.handleInput(DOWN); // wraps back to the long first item
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[1]![0].value).toContain("Alpha");

    d.handleInput(UP); // wraps back to Done
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[2]![0].value).toBe(DONE_DISPLAY);
  });

  it("keeps every multi-select rendered state within the Display budget while navigating and paging", () => {
    const d = multiDialog({ maxWidth: 30, maxLines: 6 });
    renderOnce(d);
    const keys = [PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, DOWN, DOWN, DOWN, DOWN];

    for (const key of keys) {
      const lines = d.render(80);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(maxLineWidth(lines)).toBeLessThanOrEqual(30);
      d.handleInput(key);
    }
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(30);
  });

  it("renders checkmark state and count-only summary within the budget when chosen", () => {
    const d = multiDialog({ chosenLabels: [LONG_LABEL], maxWidth: 30, maxLines: 6 });
    renderOnce(d);

    const lines = d.render(80);
    const output = lines.join("\n");
    expect(output).toContain("[1 selected]");
    expect(output).toContain("✓ Alpha this option has an");
    expect(output).not.toContain("selected:");
    expect(output).not.toMatch(/…/);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(30);
  });
});