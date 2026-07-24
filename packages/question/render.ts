import type {
  Theme,
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

/** Option shape from the tool parameters — used in structured result details. */
export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** Structured details that renderers consume without parsing text. */
export interface QuestionResultDetails {
  /** The preset options presented to the user. */
  options: QuestionOption[];
  /** Selected preset labels (empty array when none selected). */
  selectedLabels: string[];
  /** Free-prose answer text, if any. */
  freeText?: string;
  /** How the user answered. */
  interaction: "preset" | "freeProse" | "none" | "nonInteractive";
  /** Label used for the free-prose escape hatch (for renderers). */
  freeTextLabel?: string;
}

/**
 * Render the Question tool call row — compact summary showing the prompt.
 *
 * Example:  Question  Confirm action: Are you sure?
 */
export function renderQuestionCall(
  args: { header?: string; question: string },
  theme: Theme,
): Text {
  const label = args.header ? `${args.header}: ` : "";
  const text =
    theme.fg("toolTitle", theme.bold("Question")) + theme.fg("muted", `  ${label}${args.question}`);
  return new Text(text, 0, 0);
}

/**
 * Render the Question tool result row.
 *
 * Distinguishes preset selections, free-prose answers, and no-selection.
 * Non-interactive fallback renders the plain text as-is.
 */
export function renderQuestionResult(
  result: AgentToolResult<QuestionResultDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Component {
  const d = result.details;
  if (!d) {
    // No details — render raw text as fallback.
    const lines = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    return new Text(theme.fg("toolOutput", lines.join("\n")), 0, 0);
  }

  switch (d.interaction) {
    case "preset": {
      const labels = d.selectedLabels;
      if (labels.length === 0) {
        return new Text(theme.fg("muted", "(no selection)"), 0, 0);
      }
      return new Text(theme.fg("success", `✓ ${labels.join(", ")}`), 0, 0);
    }
    case "freeProse": {
      const text = d.freeText ?? "";
      const display = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      return new Text(theme.fg("toolOutput", `✎ ${display}`), 0, 0);
    }
    case "none":
      return new Text(theme.fg("muted", "(no selection)"), 0, 0);
    case "nonInteractive":
    default: {
      // Render the fallback text verbatim — already informative.
      const lines = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      return new Text(theme.fg("muted", lines.join("\n")), 0, 0);
    }
  }
}