/**
 * BoundedQuestionDialog — a package-owned interactive question picker that
 * enforces a Display Budget (maxLines, maxWidth) instead of relying on Pi's
 * built-in unbounded picker.
 *
 * Renders a capped/truncated header (the question text) followed by a
 * wrapped, scrollable list of preset options + the Free prose answer.
 *
 * Implements the pi-tui Component interface so it can be rendered as a widget
 * in the interactive TUI.  For deterministic tests, call render(width) directly
 * and simulate user actions via handleInput().
 */

import { type SelectItem, type Component, getKeybindings } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

// ── Public types ───────────────────────────────────────────────────────

/** One preset option for the bounded dialog. */
export interface DialogOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface BoundedQuestionDialogOptions {
  /** Combined header + question text (capped in the dialog). */
  title: string;
  /** The preset options (2–4 items). */
  options: DialogOption[];
  /** Label used for the free-prose escape hatch (e.g. "Type your answer"). */
  freeTextLabel: string;
  /** Maximum total rendered lines. */
  maxLines?: number;
  /** Maximum visible width of any rendered line. */
  maxWidth?: number;
  /** Maximum lines the header (question) can occupy before truncation. */
  maxHeaderLines?: number;

  // ── Multi-select ───────────────────────────────────────────────────

  /** Enable multi-select mode (with checkboxes, toggle, and Done button). */
  multiSelect?: boolean;
  /** Labels already selected (used when re-creating the dialog each round). */
  chosenLabels?: string[];
  /** Whether free text has already been used (hides the free-text option). */
  hasFreeText?: boolean;
  /**
   * Value of the item that starts focused on the next render (searched in
   * `SelectItem.value`); defaults to the first item. Lets a redrawn
   * multi-select dialog keep the user's place after a toggle.
   */
  initialFocusValue?: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_LINES = 15;
const DEFAULT_MAX_WIDTH = 120;
const DEFAULT_MAX_HEADER_LINES = 3;
const TRUNCATION_SUFFIX = "…";
const MAX_EDITOR_TITLE_CHARS = 60;

/** Display string for the Done completion button in multi-select mode. */
export const DONE_DISPLAY = "✓ Done";

/**
 * SelectItem value for the preset option at `index` in the dialog's `options`.
 *
 * Item values are opaque identities, never display text: distinct labels can
 * format to the same string, and no label can collide with a control. Callers
 * map a value back through the same `options` array they passed in.
 */
export function presetOptionValue(index: number): string {
  return `option:${index}`;
}

/** SelectItem value for the Free prose answer row. */
export const FREE_TEXT_VALUE = "freeText";

/** SelectItem value for the Done completion control. */
export const DONE_VALUE = "done";

// ── Public helpers ──────────────────────────────────────────────────────

/**
 * Produce a short bounded title for the free-prose editor, preferring the
 * header (short by design) or a capped question prefix so the editor path
 * cannot reintroduce unbounded prompt rendering. The header is a caller-supplied
 * string and is bounded too: a long one would otherwise overflow the editor
 * prompt unopposed.
 */
export function boundedEditorTitle(header: string | undefined, question: string): string {
  if (header) return capEditorTitle(header);
  return capEditorTitle(question);
}

/** Cap an editor title to MAX_EDITOR_TITLE_CHARS, marking truncation with an ellipsis. */
function capEditorTitle(text: string): string {
  if (text.length <= MAX_EDITOR_TITLE_CHARS) return text;
  return text.slice(0, MAX_EDITOR_TITLE_CHARS - 1) + TRUNCATION_SUFFIX;
}

// ── Wrapped list ───────────────────────────────────────────────────────

const LIST_PREFIX_WIDTH = 2;
const LIST_SELECTED_PREFIX = "→ ";
const LIST_UNSELECTED_PREFIX = "  ";

/**
 * Selectable answer list: renders every item as a wrapped label and navigates
 * by item, not by wrapped row. Up/Down moves the focused item exactly one
 * press at a time (with wraparound) and resets the newly focused item's label
 * to its first line; PageUp/PageDown pages only the focused item's wrapped
 * label so an oversized Scrollable option label stays fully readable without
 * changing focus.
 *
 * Not a pi-tui Component itself: the dialog owns rendering and tells this list
 * how many rows the shared Display budget leaves for it.
 */
class WrappedSelectList {
  private items: SelectItem[];
  /** Visible rows granted by the most recent render; page steps use it. */
  private maxVisible = 1;
  /** Index of the focused item. */
  private focusIndex = 0;
  /** Lines scrolled past at the top of the focused item's wrapped label. */
  private readingOffset = 0;
  /** Wrapped lines computed at the most recent render width. */
  private lastWrapped: string[][] | undefined;

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(items: SelectItem[], initialFocusValue?: string) {
    this.items = items;
    const requested =
      initialFocusValue === undefined
        ? -1
        : items.findIndex((item) => item.value === initialFocusValue);
    this.focusIndex = requested >= 0 ? requested : 0;
  }

  invalidate(): void {
    // No cached state to invalidate.
  }

  /**
   * Render the list into `maxVisible` rows around the focused item.
   * The viewport height is supplied per render because it depends on how many
   * lines the header wraps to at the render width — the header and the list
   * share one Display budget.
   */
  render(width: number, maxVisible: number): string[] {
    this.maxVisible = Math.max(1, maxVisible);
    const wrapWidth = Math.max(1, width - LIST_PREFIX_WIDTH);
    const wrapped = this.items.map((item) => {
      const text = item.description ? `${item.label} — ${item.description}` : item.label;
      return wrapTextWithAnsi(text, wrapWidth);
    });
    this.lastWrapped = wrapped;
    const lineCounts = wrapped.map((lines) => lines.length);
    const total = lineCounts.reduce((sum, n) => sum + n, 0);
    if (total === 0) return [];

    // Width may change between renders; keep the focused label's reading
    // position inside its own lines.
    const focusLen = lineCounts[this.focusIndex] ?? 0;
    this.readingOffset = Math.min(this.readingOffset, Math.max(0, focusLen - this.maxVisible));
    const focusLineStart = lineCounts.slice(0, this.focusIndex).reduce((sum, n) => sum + n, 0);
    const focusRow = focusLineStart + this.readingOffset;
    const windowStart = Math.min(focusRow, Math.max(0, total - this.maxVisible));

    const out: string[] = [];
    let lineIndex = 0;
    for (let i = 0; i < this.items.length; i++) {
      for (const line of wrapped[i]!) {
        if (lineIndex >= windowStart && lineIndex < windowStart + this.maxVisible) {
          // The prefix marks the focused item's first visible label row.
          const prefix = lineIndex === focusRow ? LIST_SELECTED_PREFIX : LIST_UNSELECTED_PREFIX;
          out.push(prefix + line);
        }
        lineIndex++;
      }
    }
    return out;
  }

  handleInput(keyData: string): void {
    if (this.items.length === 0) return;
    const kb = getKeybindings();

    if (kb.matches(keyData, "tui.select.up")) {
      this.focusIndex = (this.focusIndex - 1 + this.items.length) % this.items.length;
      this.readingOffset = 0;
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.focusIndex = (this.focusIndex + 1) % this.items.length;
      this.readingOffset = 0;
    } else if (kb.matches(keyData, "tui.select.pageUp")) {
      this.readingOffset = Math.max(0, this.readingOffset - this.maxVisible);
    } else if (kb.matches(keyData, "tui.select.pageDown")) {
      const focusLen = this.lastWrapped?.[this.focusIndex]?.length ?? 1;
      this.readingOffset = Math.max(
        0,
        Math.min(focusLen - this.maxVisible, this.readingOffset + this.maxVisible),
      );
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      if (this.onSelect) this.onSelect(this.items[this.focusIndex]!);
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      if (this.onCancel) this.onCancel();
    }
  }
}

// ── SelectItem helpers ─────────────────────────────────────────────────

/**
 * Build a bounded count-only selection summary for multi-select mode, e.g.
 * `[2 selected]` — never lists (or truncates) chosen labels, since the option
 * viewport is where selected labels stay readable in full. Collapses to a
 * bare `[N]` when even the count form exceeds `maxWidth`.
 * Returns empty string when nothing is chosen.
 */
export function boundedSelectionSummary(chosenLabels: string[], maxWidth: number): string {
  if (chosenLabels.length === 0) return "";
  const countOnly = `[${chosenLabels.length} selected]`;
  return visibleWidth(countOnly) <= maxWidth ? countOnly : `[${chosenLabels.length}]`;
}

/** Build a SelectItem for the preset option at `index`. */
function presetSelectItem(
  o: DialogOption,
  index: number,
  collidingDisplays: ReadonlySet<string>,
): SelectItem {
  const label = o.recommended ? `${o.label}  (recommended)` : o.label;
  const display = o.description ? `${label} — ${o.description}` : label;
  const disambiguatedLabel = collidingDisplays.has(display)
    ? `${JSON.stringify(o.label)}${o.recommended ? "  (recommended)" : ""}`
    : label;
  return {
    value: presetOptionValue(index),
    label: disambiguatedLabel,
    description: o.description,
  };
}

/** Build the free-prose SelectItem. */
function freeTextSelectItem(freeTextLabel: string): SelectItem {
  return {
    value: FREE_TEXT_VALUE,
    label: `✎ ${freeTextLabel} — Write a custom response`,
    description: undefined,
  };
}

/**
 * Build the Done completion button SelectItem for multi-select mode.
 */
function doneSelectItem(): SelectItem {
  return {
    value: DONE_VALUE,
    label: DONE_DISPLAY,
    description: undefined,
  };
}

/** Build the list of SelectItems for single-select mode (presets + free text). */
function buildSingleSelectItems(options: DialogOption[], freeTextLabel: string): SelectItem[] {
  const formattedDisplays = options.map((option) => {
    const label = option.recommended ? `${option.label}  (recommended)` : option.label;
    return option.description ? `${label} — ${option.description}` : label;
  });
  const counts = new Map<string, number>();
  for (const display of formattedDisplays) counts.set(display, (counts.get(display) ?? 0) + 1);
  const collidingDisplays = new Set(
    [...counts].filter(([, count]) => count > 1).map(([display]) => display),
  );
  const items: SelectItem[] = options.map((option, index) =>
    presetSelectItem(option, index, collidingDisplays),
  );
  items.push(freeTextSelectItem(freeTextLabel));
  return items;
}

/** Build the list of SelectItems for multi-select mode. */
function multiSelectItems(
  options: DialogOption[],
  chosenLabels: string[],
  freeTextLabel: string,
  hasFreeText: boolean,
): SelectItem[] {
  const chosenSet = new Set(chosenLabels);
  const formattedDisplays = options.map((option) => {
    const label = `${option.label}${option.recommended ? "  (recommended)" : ""}`;
    return `${option.recommended ? "○ " : "○ "}${label}${option.description ? ` — ${option.description}` : ""}`;
  });
  const counts = new Map<string, number>();
  for (const display of formattedDisplays) counts.set(display, (counts.get(display) ?? 0) + 1);
  const collidingDisplays = new Set(
    [...counts].filter(([, count]) => count > 1).map(([display]) => display),
  );
  const items: SelectItem[] = [];

  options.forEach((opt, index) => {
    const isChosen = chosenSet.has(opt.label);
    const checkbox = isChosen ? "✓ " : "○ ";
    items.push({
      value: presetOptionValue(index),
      label: `${checkbox}${collidingDisplays.has(formattedDisplays[index]!) ? JSON.stringify(opt.label) : opt.label}${opt.recommended ? "  (recommended)" : ""}`,
      description: opt.description,
    });
  });

  // Free text option — only shown if not yet used
  if (!hasFreeText) {
    items.push(freeTextSelectItem(freeTextLabel));
  }

  // Done button
  items.push(doneSelectItem());

  return items;
}

// ── Component ──────────────────────────────────────────────────────────

/**
 * A bounded-rendering question dialog that caps displayed text and keeps all
 * answers selectable through scrolling.
 *
 * Usage (deterministic test):
 * ```
 * const d = new BoundedQuestionDialog({ title, options, freeTextLabel });
 * const lines = d.render(80);
 * expect(lines.length).toBeLessThanOrEqual(d.maxLines);
 * d.handleInput("enter");       // confirm current selection
 * ```
 *
 * The dialog delegates onSelect / onCancel to the inner list, so
 * consumers set callbacks directly on the dialog instance.
 */
export class BoundedQuestionDialog implements Component {
  /** Fired when the user confirms a selection. */
  get onSelect(): ((item: SelectItem) => void) | undefined {
    return this.selectList.onSelect;
  }
  set onSelect(handler: ((item: SelectItem) => void) | undefined) {
    this.selectList.onSelect = handler;
  }

  /** Fired when the user cancels / escapes. */
  get onCancel(): (() => void) | undefined {
    return this.selectList.onCancel;
  }
  set onCancel(handler: (() => void) | undefined) {
    this.selectList.onCancel = handler;
  }

  // Config (exposed for test assertions).
  readonly maxLines: number;
  readonly maxWidth: number;
  readonly maxHeaderLines: number;

  // Multi-select state.
  readonly multiSelect: boolean;
  readonly chosenLabels: readonly string[];
  readonly hasFreeText: boolean;
  readonly initialFocusValue?: string;

  private selectList: WrappedSelectList;
  private title: string;

  constructor(opts: BoundedQuestionDialogOptions) {
    this.title = opts.title;
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    this.maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
    this.maxHeaderLines = opts.maxHeaderLines ?? DEFAULT_MAX_HEADER_LINES;
    this.multiSelect = opts.multiSelect ?? false;
    this.chosenLabels = opts.chosenLabels ?? [];
    this.hasFreeText = opts.hasFreeText ?? false;
    this.initialFocusValue = opts.initialFocusValue;

    // Build select items based on mode.
    const items: SelectItem[] = this.multiSelect
      ? multiSelectItems(
          opts.options,
          this.chosenLabels as string[],
          opts.freeTextLabel,
          this.hasFreeText,
        )
      : buildSingleSelectItems(opts.options, opts.freeTextLabel);

    this.selectList = new WrappedSelectList(items, opts.initialFocusValue);
  }

  // ── Component interface ────────────────────────────────────────────

  render(width: number): string[] {
    const renderWidth = Math.min(width, this.maxWidth);
    const headerLines = this.computeHeaderLines(renderWidth);
    // Reserve the header and the separator before handing the rest of the
    // Display budget to the list. Counting the separator avoids slicing the
    // viewport's last row off the display, which would make a tall final label
    // (e.g. the free-prose choice) unreadable in full. Both are measured at the
    // render width, since a narrow terminal wraps the header onto more lines
    // than it occupies at maxWidth and would otherwise overrun the budget.
    const separatorBudget = headerLines.length > 0 ? 1 : 0;
    const listBudget = Math.max(1, this.maxLines - headerLines.length - separatorBudget);
    const listLines = this.selectList.render(renderWidth, listBudget);

    const separator = headerLines.length > 0 && listLines.length > 0 ? [""] : [];
    const allLines = [...headerLines, ...separator, ...listLines].slice(0, this.maxLines);

    // Safety net: enforce the Component contract (max line width) on every
    // line before returning it to Pi.
    return allLines.map((line) =>
      visibleWidth(line) > renderWidth ? truncateToWidth(line, renderWidth) : line,
    );
  }

  handleInput(keyData: string): void {
    this.selectList.handleInput(keyData);
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  // ── Implementation ─────────────────────────────────────────────────

  /** Compute the bounded header lines (capped + truncated). */
  private computeHeaderLines(width: number): string[] {
    const lines: string[] = [];

    // Title (wrapped + capped to maxHeaderLines)
    if (this.title) {
      const wrapped = wrapTextWithAnsi(this.title, width);
      if (wrapped.length <= this.maxHeaderLines) {
        lines.push(...wrapped);
      } else {
        const capped = wrapped.slice(0, this.maxHeaderLines);
        const lastIdx = capped.length - 1;
        capped[lastIdx] = truncateToWidth(capped[lastIdx]!, width, TRUNCATION_SUFFIX);
        lines.push(...capped);
      }
    }

    // Multi-select: bounded selection summary line
    if (this.multiSelect && this.chosenLabels.length > 0) {
      const summary = boundedSelectionSummary(this.chosenLabels as string[], width);
      if (summary) lines.push(summary);
    }

    return lines;
  }
}