import type {
  Theme,
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { WebSearchDetails } from "./search.ts";

/**
 * Render the web_search tool call row — compact query summary.
 *
 * Collapsed (always compact):
 *   Web Search  base query  "exact phrase"  site:example.com
 */
export function renderWebSearchCall(
  args: { query?: string; exactPhrases?: string[]; site?: string },
  theme: Theme,
): Text {
  const parts: string[] = [];
  if (args.query) parts.push(args.query);
  if (args.exactPhrases?.length) {
    parts.push(args.exactPhrases.map((p) => `"${p}"`).join(" "));
  }
  if (args.site) parts.push(`site:${args.site}`);
  const summary = parts.length > 0 ? parts.slice(0, 3).join("  ") : "(no query)";
  const text = theme.fg("toolTitle", theme.bold("Web Search")) + theme.fg("muted", `  ${summary}`);
  return new Text(text, 0, 0);
}

/**
 * Render the web_search tool result row.
 *
 * Collapsed: one line — returned result count + truncated composed query.
 * Expanded: full result list with theming.
 */
export function renderWebSearchResult(
  result: AgentToolResult<WebSearchDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Component {
  const d = result.details;
  if (!d) {
    // No details — fall back to raw content text.
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return new Text(theme.fg("toolOutput", text), 0, 0);
  }

  // Count what the API actually returned; `resultCount` is only what we asked for.
  // Legacy persisted details predate `results`, so the count can be unknown.
  const returnedCount = Array.isArray(d.results) ? d.results.length : undefined;

  if (!options.expanded) {
    // Collapsed: one-liner
    const query = d.composedQuery;
    const displayQuery = query.length > 60 ? `${query.slice(0, 57)}…` : query;
    if (returnedCount === undefined) {
      return new Text(theme.fg("muted", displayQuery), 0, 0);
    }
    const prefix =
      returnedCount > 0 ? `${returnedCount} result${returnedCount !== 1 ? "s" : ""}` : "no results";
    const color = returnedCount > 0 ? "success" : "muted";
    return new Text(theme.fg(color, `${prefix}  ${displayQuery}`), 0, 0);
  }

  // Expanded: full result list with theming.
  const contentText = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const lines = contentText.split("\n");
  const themed = lines.map((line, i) => {
    if (i === 0) return theme.fg("accent", line); // header
    if (/^\d+\. /.test(line)) return theme.fg("accent", line); // result title
    if (/^\s+https?:\/\//.test(line)) return theme.fg("dim", line.trim()); // URL
    if (line.startsWith("   ")) return theme.fg("toolOutput", line.trim()); // snippet
    return theme.fg("toolOutput", line); // blank lines
  });

  return new Text(themed.join("\n"), 0, 0);
}