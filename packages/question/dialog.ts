/**
 * BoundedQuestionDialog — a package-owned interactive question picker that
 * enforces a Display Budget (maxLines, maxWidth) instead of relying on Pi's
 * built-in unbounded picker.
 *
 * Renders a capped/truncated header (the question text) followed by a
 * SelectList of preset options + the Free prose answer.
 *
 * Implements the pi-tui Component interface so it can be rendered as a widget
 * in the interactive TUI.  For deterministic tests, call render(width) directly
 * and simulate user actions via handleInput().
 */

import {
  SelectList,
  type SelectItem,
  type SelectListTheme,
  type Component,
} from "@earendil-works/pi-tui";
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
  /** Full display string for the free-prose escape hatch (e.g. "✎ Type your answer — Write a custom response"). */
  freeTextDisplay: string;
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
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_LINES = 15;
const DEFAULT_MAX_WIDTH = 120;
const DEFAULT_MAX_HEADER_LINES = 3;
const TRUNCATION_SUFFIX = "…";
const MAX_EDITOR_TITLE_CHARS = 60;

/** Display string for the Done completion button in multi-select mode. */
export const DONE_DISPLAY = "✓ Done";

// ── Public helpers ──────────────────────────────────────────────────────

/**
 * Produce a short bounded title for the free-prose editor, preferring the
 * header (short by design) or a capped question prefix so the editor path
 * cannot reintroduce unbounded prompt rendering.
 */
export function boundedEditorTitle(
  header: string | undefined,
  question: string,
): string {
  if (header) return header;
  if (question.length <= MAX_EDITOR_TITLE_CHARS) return question;
  return question.slice(0, MAX_EDITOR_TITLE_CHARS - 1) + TRUNCATION_SUFFIX;
}

// ── Theme ──────────────────────────────────────────────────────────────

/** Plain SelectList theme used by default (no ANSI styling). */
function plainSelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (t) => `> ${t}`,
    selectedText: (t) => t,
    description: (t) => (t ? ` — ${t}` : ""),
    scrollInfo: (t) => `  (${t})`,
    noMatch: (t) => `  ${t}`,
  };
}

// ── SelectItem helpers ─────────────────────────────────────────────────

/** Build the display string used to map a selection back to its option. */
function optionDisplay(o: DialogOption): string {
  let s = o.label;
  if (o.recommended) s += "  (recommended)";
  if (o.description) s += ` — ${o.description}`;
  return s;
}

/**
 * Build a bounded selection summary for multi-select mode, e.g.
 * `[2 selected: Alpha, Be…]` — never exceeds `maxWidth`.
 * Returns empty string when nothing is chosen.
 */
export function boundedSelectionSummary(
  chosenLabels: string[],
  maxWidth: number,
): string {
  if (chosenLabels.length === 0) return "";
  const count = chosenLabels.length;

  // Fallback for very narrow widths: just show the count.
  const countOnly = `[${count}]`;
  if (visibleWidth(countOnly) > maxWidth) return countOnly;

  // Try full format: "[N selected: label1, label2]"
  const fullPreview = `[${count} selected: ${chosenLabels.join(", ")}]`;
  if (visibleWidth(fullPreview) <= maxWidth) return fullPreview;

  // Need to cap the preview.
  const leftPart = `[${count} selected: `;
  const suffix = ", …]";
  const leftWidth = visibleWidth(leftPart);
  const suffixWidth = visibleWidth(suffix);
  const available = maxWidth - leftWidth - suffixWidth;

  // If there's no room for any label preview, fall back to count-only.
  if (available <= 0) return countOnly;

  let preview = "";
  for (const label of chosenLabels) {
    const separator = preview ? ", " : "";
    const candidate = preview + separator + label;
    if (visibleWidth(candidate) <= available) {
      preview = candidate;
    } else {
      // Truncate this label to fit the remaining space.
      const sepWidth = visibleWidth(separator);
      const remaining = available - sepWidth;
      if (remaining >= 2) {
        // Use empty ellipsis since we add TRUNCATION_SUFFIX ourselves.
        const truncated =
          truncateToWidth(label, Math.max(1, remaining - 1), "") + TRUNCATION_SUFFIX;
        preview = preview + separator + truncated;
      }
      break;
    }
  }

  return `${leftPart}${preview}${suffix}`;
}

/** Build a SelectItem for one preset option. */
function presetSelectItem(o: DialogOption): SelectItem {
  const label = o.recommended ? `${o.label}  (recommended)` : o.label;
  return {
    value: optionDisplay(o),
    label,
    description: o.description,
  };
}

/** Build the free-prose SelectItem. */
function freeTextSelectItem(
  freeTextLabel: string,
  freeTextDisplay: string,
): SelectItem {
  return {
    value: freeTextDisplay,
    label: `✎ ${freeTextLabel} — Write a custom response`,
    description: undefined,
  };
}

/**
 * Build the Done completion button SelectItem for multi-select mode.
 */
function doneSelectItem(): SelectItem {
  return {
    value: DONE_DISPLAY,
    label: DONE_DISPLAY,
    description: undefined,
  };
}

/** Build the list of SelectItems for single-select mode (presets + free text). */
function buildSingleSelectItems(
  options: DialogOption[],
  freeTextLabel: string,
  freeTextDisplay: string,
): SelectItem[] {
  const items: SelectItem[] = options.map(presetSelectItem);
  items.push(freeTextSelectItem(freeTextLabel, freeTextDisplay));
  return items;
}

/** Build the list of SelectItems for multi-select mode. */
function multiSelectItems(
  options: DialogOption[],
  chosenLabels: string[],
  freeTextLabel: string,
  freeTextDisplay: string,
  hasFreeText: boolean,
): SelectItem[] {
  const chosenSet = new Set(chosenLabels);
  const items: SelectItem[] = [];

  for (const opt of options) {
    const isChosen = chosenSet.has(opt.label);
    const checkbox = isChosen ? "✓ " : "○ ";
    items.push({
      // value stays as the canonical display for byDisplay() lookup
      value: optionDisplay(opt),
      label: `${checkbox}${opt.label}${opt.recommended ? "  (recommended)" : ""}`,
      description: opt.description,
    });
  }

  // Free text option — only shown if not yet used
  if (!hasFreeText) {
    items.push(freeTextSelectItem(freeTextLabel, freeTextDisplay));
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
 * const d = new BoundedQuestionDialog({ title, options, freeTextLabel, freeTextDisplay });
 * const lines = d.render(80);
 * expect(lines.length).toBeLessThanOrEqual(d.maxLines);
 * d.handleInput("enter");       // confirm current selection
 * ```
 *
 * The dialog delegates onSelect / onCancel to the inner SelectList, so
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

  private selectList: SelectList;
  private title: string;

  constructor(opts: BoundedQuestionDialogOptions) {
    this.title = opts.title;
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    this.maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
    this.maxHeaderLines = opts.maxHeaderLines ?? DEFAULT_MAX_HEADER_LINES;
    this.multiSelect = opts.multiSelect ?? false;
    this.chosenLabels = opts.chosenLabels ?? [];
    this.hasFreeText = opts.hasFreeText ?? false;

    // Build select items based on mode.
    const items: SelectItem[] = this.multiSelect
      ? multiSelectItems(
          opts.options,
          this.chosenLabels as string[],
          opts.freeTextLabel,
          opts.freeTextDisplay,
          this.hasFreeText,
        )
      : buildSingleSelectItems(opts.options, opts.freeTextLabel, opts.freeTextDisplay);

    // Reserve lines for the header — remaining lines go to the list.
    const headerLines = this.computeHeaderLines();
    const listBudget = Math.max(1, this.maxLines - headerLines.length);

    this.selectList = new SelectList(
      items,
      listBudget,
      plainSelectListTheme(),
    );
  }

  // ── Component interface ────────────────────────────────────────────

  render(width: number): string[] {
    const renderWidth = Math.min(width, this.maxWidth);
    const headerLines = this.computeHeaderLines();
    const listLines = this.selectList.render(renderWidth);

    const separator = headerLines.length > 0 && listLines.length > 0 ? [""] : [];
    const allLines = [...headerLines, ...separator, ...listLines];
    return allLines.slice(0, this.maxLines);
  }

  handleInput(keyData: string): void {
    this.selectList.handleInput(keyData);
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  // ── Implementation ─────────────────────────────────────────────────

  /** Compute the bounded header lines (capped + truncated). */
  private computeHeaderLines(): string[] {
    const lines: string[] = [];

    // Title (wrapped + capped to maxHeaderLines)
    if (this.title) {
      const wrapped = wrapTextWithAnsi(this.title, this.maxWidth);
      if (wrapped.length <= this.maxHeaderLines) {
        lines.push(...wrapped);
      } else {
        const capped = wrapped.slice(0, this.maxHeaderLines);
        const lastIdx = capped.length - 1;
        capped[lastIdx] =
          truncateToWidth(
            capped[lastIdx]!,
            Math.max(1, this.maxWidth - 1),
          ) + TRUNCATION_SUFFIX;
        lines.push(...capped);
      }
    }

    // Multi-select: bounded selection summary line
    if (this.multiSelect && this.chosenLabels.length > 0) {
      const summary = boundedSelectionSummary(
        this.chosenLabels as string[],
        this.maxWidth,
      );
      if (summary) lines.push(summary);
    }

    return lines;
  }
}
