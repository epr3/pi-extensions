import type { Theme, AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { WebFetchDetails } from "./fetch.ts";

/**
 * Render the web_fetch tool call row — compact URL summary.
 *
 * Collapsed (always compact):
 *   Web Fetch  https://example.com/page
 */
export function renderWebFetchCall(
  args: { url?: string },
  theme: Theme,
): Text {
  const url = args.url ?? "(no URL)";
  const displayUrl = url.length > 70 ? `${url.slice(0, 67)}…` : url;
  const text =
    theme.fg("toolTitle", theme.bold("Web Fetch")) +
    theme.fg("muted", `  ${displayUrl}`);
  return new Text(text, 0, 0);
}

/**
 * Render the web_fetch tool result row.
 *
 * Collapsed: one line — status (success/error) + URL + content size.
 * Expanded: extract title and preview of content.
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

  // isError is available on the render context, but ToolRenderContext isn't
  // publicly exported; for now error rendering is content-driven.

  // Source badge
  const sourceBadge = d.source === "pdf"
    ? theme.fg("accent", "[PDF] ")
    : d.source === "fallback"
      ? theme.fg("accent", "[Fallback] ")
      : "";

  if (!options.expanded) {
    // Collapsed: one-liner
    const size = d.contentLength > 0 ? `  ${d.contentLength} chars` : "";
    const displayUrl = d.url.length > 50 ? `${d.url.slice(0, 47)}…` : d.url;
    const preview = d.title ? `  ${d.title}` : "";
    // Show check mark for success; on error the result text speaks for itself
    return new Text(
      theme.fg("success", `✓  ${sourceBadge}${displayUrl}${preview}${size}`),
      0,
      0,
    );
  }

  // Expanded: show title, URL, and a bounded content preview
  const contentText = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  // Build header info
  const lines: string[] = [];
  if (d.title) lines.push(theme.fg("accent", d.title));
  lines.push(`${theme.fg("dim", d.url)}  ${theme.fg("muted", `[${d.source}]`)}`);
  if (d.contentType) lines.push(theme.fg("muted", `Content-Type: ${d.contentType}`));
  if (d.contentLength > 0) lines.push(theme.fg("muted", `Content: ${d.contentLength} chars`));
  if (d.pageCount !== undefined) {
    const pageInfo = d.truncated
      ? `Pages: ${d.pageCount} (truncated)`
      : `Pages: ${d.pageCount}`;
    lines.push(theme.fg("muted", pageInfo));
  }
  if (d.extractionWarning) lines.push(theme.fg("warning", `Warning: ${d.extractionWarning}`));
  lines.push("");

  // Preview: show first ~2000 chars of content
  const preview = contentText.length > 2000
    ? `${contentText.slice(0, 1997)}…`
    : contentText;
  lines.push(preview);

  return new Text(lines.join("\n"), 0, 0);
}
