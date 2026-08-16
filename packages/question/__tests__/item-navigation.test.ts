/**
 * Item-based question navigation tests (ticket 0001).
 *
 * The Bounded question dialog navigates selectable answer items with
 * Up/Down — one item per press, regardless of wrapped label height — while
 * PageUp/PageDown explicitly pages the focused Scrollable option label.
 */

import { describe, it, expect, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BoundedQuestionDialog, type DialogOption } from "../dialog.ts";

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

/** Establish wrapped line counts the way the TUI does: render once before input. */
function renderOnce(d: BoundedQuestionDialog): string[] {
  return d.render(80);
}

describe("item navigation — one press per answer item", () => {
  // Layout: LONG_LABEL rows 0..4, "Beta" row 5, free-prose rows 6..10 (11 rows).
  // Header(1) + separator(1) + maxLines 6 → 4-row list viewport.
  function longFirstDialog(): BoundedQuestionDialog {
    return makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
      maxLines: 6,
    });
  }

  it("Down moves the focus across a whole wrapped label onto the next item in one press", () => {
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    // Row 4 of LONG and "Beta" start hidden behind the 4-row viewport.
    const initial = d.render(80).join("\n");
    expect(initial).toContain("Alpha this option has an");
    expect(initial).not.toContain("Beta");

    // One Down press jumps the whole 5-row label straight to "Beta".
    d.handleInput(DOWN);
    const after = d.render(80).join("\n");
    expect(after).toContain("Beta");

    d.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].value).toContain("Beta");
  });
});

describe("explicit label paging — PageUp/PageDown", () => {
  // Same layout: LONG_LABEL rows 0..4, "Beta" row 5, free-prose rows 6..10.
  function longFirstDialog(): BoundedQuestionDialog {
    return makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
      maxLines: 6,
    });
  }

  it("PageDown reveals the hidden lines of the focused long label", () => {
    const d = longFirstDialog();
    renderOnce(d);

    const initial = d.render(80).join("\n");
    expect(initial).toContain("Alpha this option has an");
    expect(initial).not.toContain("single word in full ZZZEND");

    // One page reveals the label's final line; focus stays on LONG.
    d.handleInput(PAGE_DOWN);
    const paged = d.render(80).join("\n");
    expect(paged).toContain("single word in full ZZZEND");
    expect(paged).not.toContain("Beta");

    // Confirm after paging still selects the focused item.
    const onSelect = vi.fn();
    d.onSelect = onSelect;
    d.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].value).toContain("Alpha");
  });

  it("PageDown repeatedly pages through a taller-than-viewport label", () => {
    // TALL_LABEL wraps to 10 rows (0..9); the 4-row viewport pages 0→4→6
    // with clamping so the final row is always reachable.
    const d = makeDialog({
      options: [{ label: TALL_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 28,
      maxLines: 6,
    });
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(PAGE_DOWN);
    d.handleInput(PAGE_DOWN);
    d.handleInput(PAGE_DOWN);

    // Final row of the 10-row label is reachable and still focused.
    const out = d.render(80).join("\n");
    expect(out).toContain("readable TALLEND");
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Tallest");
  });
});

describe("label viewport resets on revisit; page nav has no side effects", () => {
  function longFirstDialog(): BoundedQuestionDialog {
    return makeDialog({
      options: [{ label: LONG_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 30,
      maxLines: 6,
    });
  }

  it("PageUp scrolls the long label back toward its first line", () => {
    const d = longFirstDialog();
    renderOnce(d);
    d.handleInput(PAGE_DOWN);
    expect(d.render(80).join("\n")).toContain("single word in full ZZZEND");

    d.handleInput(PAGE_UP);
    const back = d.render(80).join("\n");
    expect(back).toContain("Alpha this option has an");
    expect(back).not.toContain("single word in full ZZZEND");
  });

  it("moving focus away from and back to an item starts its label at the first line", () => {
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(PAGE_DOWN); // read deep into LONG
    expect(d.render(80).join("\n")).not.toContain("Alpha this option has an");

    d.handleInput(DOWN); // leave LONG for Beta
    d.handleInput(UP); // return to LONG — viewport must restart at row 0

    expect(d.render(80).join("\n")).toContain("Alpha this option has an");
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Alpha");
  });

  it("paging a one-row label is a no-op and still confirms the item", () => {
    // Focus Beta (1 row): the label needs no scroll state.
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN); // focus Beta
    const before = d.render(80).join("\n");
    d.handleInput(PAGE_DOWN);
    d.handleInput(PAGE_UP);
    const after = d.render(80).join("\n");
    expect(after).toBe(before);

    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Beta");
  });

  it("Up/Down wraparound still holds across a paged long label", () => {
    // LONG(5 rows), Beta(1), free prose(5 rows); from the free-prose item one
    // Down wraps to LONG, whose viewport restarts at its first line.
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    d.onSelect = onSelect;

    d.handleInput(DOWN); // Beta
    d.handleInput(DOWN); // free prose
    d.handleInput(PAGE_DOWN); // read into the tall free-prose label
    d.handleInput(DOWN); // wraps onto LONG

    const out = d.render(80).join("\n");
    expect(out).toContain("Alpha this option has an");
    d.handleInput(ENTER);
    expect(onSelect.mock.calls[0]![0].value).toContain("Alpha");
  });

  it("paging never fires onSelect or onCancel", () => {
    const d = longFirstDialog();
    renderOnce(d);
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    d.onSelect = onSelect;
    d.onCancel = onCancel;

    d.handleInput(PAGE_DOWN);
    d.handleInput(PAGE_UP);
    d.handleInput(PAGE_DOWN);
    d.handleInput(PAGE_UP);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps every paged state within the Display budget", () => {
    const d = makeDialog({
      options: [{ label: TALL_LABEL }, { label: "Beta" }],
      freeTextLabel: LONG_FREE_TEXT_LABEL,
      maxWidth: 28,
      maxLines: 6,
    });
    renderOnce(d);

    for (let i = 0; i < 8; i++) {
      const lines = d.render(80);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(maxLineWidth(lines)).toBeLessThanOrEqual(28);
      d.handleInput(i % 2 === 0 ? PAGE_DOWN : PAGE_UP);
    }
    const lines = d.render(80);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(maxLineWidth(lines)).toBeLessThanOrEqual(28);
  });
});