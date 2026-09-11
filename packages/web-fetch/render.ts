import type {
  Theme,
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { WebFetchDetails } from "./fetch.ts";

/**
 * Render the web_fetch tool call row — compact URL summary.
 *
 * Collapsed (always compact):
 *   Web Fetch  https://example.com/page
 */
export function renderWebFetchCall(args: { url?: string; prompt?: string }, theme: Theme): Text {
  const url = args.url ?? "(no URL)";
  const displayUrl = url.length > 70 ? `${url.slice(0, 67)}…` : url;
  const text =
    theme.fg("toolTitle", theme.bold("Web Fetch")) + theme.fg("muted", `  ${displayUrl}`);
  return new Text(text, 0, 0);
}

/**
 * Render the web_fetch tool result row.
 *
 * Collapsed: one line — status + URL + answer length.
 * Expanded: title, source identity, artifact reference, answer length, source
 * length, completeness/PDF/model-input warnings, and a bounded answer preview.
 */
export function renderWebFetchResult(
  result: AgentToolResult<WebFetchDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Component {
  const d = result.details;

  if (!d) {
    // No details — fall back to raw content text (shouldn't happen normally)
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return new Text(theme.fg("toolOutput", text), 0, 0);
  }

  // Source badge
  const sourceBadge = d.source === "pdf" ? theme.fg("accent", "[PDF] ") : "";

  if (!options.expanded) {
    // Collapsed: one-liner
    const size = d.answerLength > 0 ? `  ${d.answerLength} chars` : "";
    const displayUrl = d.url.length > 50 ? `${d.url.slice(0, 47)}…` : d.url;
    const preview = d.title ? `  ${d.title}` : "";
    return new Text(theme.fg("success", `✓  ${sourceBadge}${displayUrl}${preview}${size}`), 0, 0);
  }

  // Expanded: title, source identity, artifact reference, warnings, preview.
  const contentText = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  // Prefer the structured answer; fall back to parsing the inline content.
  const answerText = d.answer || contentText;

  // Build header info
  const lines: string[] = [];
  if (d.title) lines.push(theme.fg("accent", d.title));
  lines.push(`${theme.fg("dim", d.url)}  ${theme.fg("muted", `[${d.source}]`)}`);
  if (d.contentType) lines.push(theme.fg("muted", `Content-Type: ${d.contentType}`));
  if (d.answerLength > 0) lines.push(theme.fg("muted", `Answer: ${d.answerLength} chars`));
  if (d.sourceLength > 0) lines.push(theme.fg("muted", `Source: ${d.sourceLength} chars`));
  if (d.artifactPath) {
    lines.push(theme.fg("accent", `Artifact: ${d.artifactPath}`));
    lines.push(theme.fg("muted", "Deleted when you leave this session — refetch to regenerate."));
  }
  if (d.pageCount !== undefined) {
    const pageInfo = d.truncated ? `Pages: ${d.pageCount} (truncated)` : `Pages: ${d.pageCount}`;
    lines.push(theme.fg("muted", pageInfo));
  }
  if (d.artifactComplete === false) {
    lines.push(
      theme.fg("warning", "Warning: artifact is partial — it does not contain the full source."),
    );
  }
  if (d.modelInputTruncated) {
    lines.push(
      theme.fg(
        "warning",
        "Warning: model input was truncated — the answer used only a leading portion of the source.",
      ),
    );
  }
  if (d.extractionWarning) lines.push(theme.fg("warning", `Warning: ${d.extractionWarning}`));
  lines.push(theme.fg("accent", "Answer:"));
  lines.push("");

  // Preview: show first ~2000 chars of the answer
  const preview = answerText.length > 2000 ? `${answerText.slice(0, 1997)}…` : answerText;
  lines.push(preview);

  return new Text(lines.join("\n"), 0, 0);
}