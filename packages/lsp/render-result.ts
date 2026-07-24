import type {
  Theme,
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

// ─── Structured detail record shapes ────────────────────────────────────────

export interface LspLocationRecord {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

export interface LspCallRecord {
  kind: string;
  name: string;
  file: string;
  line: number;
  column: number;
}

export interface LspSymbolRecord {
  name: string;
  kind: string;
  line: number;
  children?: LspSymbolRecord[];
}

export interface LspHoverRecord {
  found: boolean;
  content?: string;
}

export interface LspDiagnosticRecord {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  file: string;
  line: number;
  column: number;
}

export type LspResultKind =
  | "definition"
  | "references"
  | "implementation"
  | "incomingCalls"
  | "outgoingCalls"
  | "documentSymbols"
  | "workspaceSymbols"
  | "hover"
  | "diagnostics";

export interface LspNavigationDetails {
  resultKind: LspResultKind;
  locations?: LspLocationRecord[];
  calls?: LspCallRecord[];
  symbols?: LspSymbolRecord[];
  hover?: LspHoverRecord;
  diagnostics?: LspDiagnosticRecord[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyMessage(kind: LspResultKind): string {
  switch (kind) {
    case "definition":
      return "no definition found";
    case "references":
      return "no references found";
    case "implementation":
      return "no implementations found";
    case "incomingCalls":
      return "no callers found";
    case "outgoingCalls":
      return "no outgoing calls found";
    case "documentSymbols":
      return "no symbols";
    case "workspaceSymbols":
      return "no symbols found";
    case "hover":
      return "no hover info";
    case "diagnostics":
      return "no diagnostics";
  }
}

function countLabel(kind: LspResultKind, n: number): string {
  if (n === 0) return emptyMessage(kind);
  let noun: string;
  switch (kind) {
    case "incomingCalls":
      noun = "caller";
      break;
    case "outgoingCalls":
      noun = "call";
      break;
    case "documentSymbols":
    case "workspaceSymbols":
      noun = "symbol";
      break;
    case "diagnostics":
      noun = "diagnostic";
      break;
    default:
      noun = "location";
      break;
  }
  return `${n} ${noun}${n !== 1 ? "s" : ""}`;
}

function symbolTreeText(symbols: LspSymbolRecord[], depth = 0): string[] {
  const lines: string[] = [];
  for (const s of symbols) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${s.kind} ${s.name}  (line ${s.line})`);
    if (s.children) lines.push(...symbolTreeText(s.children, depth + 1));
  }
  return lines;
}

/** Format a severity enum name into a compact label. */
function severityLabel(severity: string): string {
  switch (severity) {
    case "error":
      return "err";
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "hint":
      return "hint";
    default:
      return severity;
  }
}

// ─── Renderer ───────────────────────────────────────────────────────────────

/**
 * Render an LSP tool result for navigation, symbol, hover, and diagnostics
 * tools.
 *
 * Collapsed: compact count summary with first item's file:line:col.
 * Expanded: full listing with paths, positions, and details.
 *
 * Falls back to plain text content when structured details are absent or
 * when a hover result has no content.
 */
export function renderLspNavigationResult(
  result: AgentToolResult<LspNavigationDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _ctx: unknown,
): Component {
  const d = result.details;
  if (!d || (!d.locations && !d.calls && !d.symbols && !d.hover && !d.diagnostics)) {
    // No structured details — render raw text as fallback.
    const lines = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    return new Text(theme.fg("toolOutput", lines.join("\n")), 0, 0);
  }

  const kind = d.resultKind;

  // ── Navigation results (locations / calls) ──

  if (d.locations) {
    if (d.locations.length === 0) {
      return new Text(theme.fg("muted", emptyMessage(kind)), 0, 0);
    }

    if (!options.expanded) {
      const first = d.locations[0];
      return new Text(
        theme.fg("accent", countLabel(kind, d.locations.length)) +
          theme.fg("muted", `  ${first.file}:${first.line}:${first.column}`),
        0,
        0,
      );
    }

    const lines = d.locations.map((loc) =>
      theme.fg("toolOutput", `${loc.file}:${loc.line}:${loc.column}  ${loc.snippet}`),
    );
    return new Text(lines.join("\n"), 0, 0);
  }

  if (d.calls) {
    if (d.calls.length === 0) {
      return new Text(theme.fg("muted", emptyMessage(kind)), 0, 0);
    }

    if (!options.expanded) {
      const first = d.calls[0];
      return new Text(
        theme.fg("accent", countLabel(kind, d.calls.length)) +
          theme.fg(
            "muted",
            `  ${first.kind} ${first.name}  ${first.file}:${first.line}:${first.column}`,
          ),
        0,
        0,
      );
    }

    const lines = d.calls.map((call) =>
      theme.fg("toolOutput", `${call.kind} ${call.name}  ${call.file}:${call.line}:${call.column}`),
    );
    return new Text(lines.join("\n"), 0, 0);
  }

  // ── Symbol results (document / workspace) ──

  if (d.symbols) {
    if (d.symbols.length === 0) {
      return new Text(theme.fg("muted", emptyMessage(kind)), 0, 0);
    }

    if (!options.expanded) {
      const count = countLabel(kind, d.symbols.length);
      const first = d.symbols[0];
      return new Text(
        theme.fg("accent", count) +
          theme.fg("muted", `  ${first.kind} ${first.name}  (line ${first.line})`),
        0,
        0,
      );
    }

    const lines = symbolTreeText(d.symbols).map((l) => theme.fg("toolOutput", l));
    return new Text(lines.join("\n"), 0, 0);
  }

  // ── Hover result ──

  if (d.hover) {
    if (!d.hover.found || !d.hover.content) {
      return new Text(theme.fg("muted", emptyMessage(kind)), 0, 0);
    }

    if (!options.expanded) {
      // Show first line of hover content in collapsed view
      const firstLine = d.hover.content.split("\n")[0]!;
      return new Text(theme.fg("accent", "hover") + theme.fg("muted", `  ${firstLine}`), 0, 0);
    }

    return new Text(theme.fg("toolOutput", d.hover.content), 0, 0);
  }

  // ── Diagnostics result ──

  if (d.diagnostics) {
    if (d.diagnostics.length === 0) {
      return new Text(theme.fg("muted", emptyMessage(kind)), 0, 0);
    }

    if (!options.expanded) {
      const errors = d.diagnostics.filter((dg) => dg.severity === "error").length;
      const warnings = d.diagnostics.filter((dg) => dg.severity === "warning").length;
      const rest = d.diagnostics.length - errors - warnings;
      const parts: string[] = [];
      if (errors > 0) parts.push(`${errors} err`);
      if (warnings > 0) parts.push(`${warnings} warn`);
      if (rest > 0) parts.push(`${rest} more`);
      return new Text(
        theme.fg("accent", countLabel(kind, d.diagnostics.length)) +
          (parts.length ? theme.fg("muted", `  ${parts.join(", ")}`) : ""),
        0,
        0,
      );
    }

    const lines = d.diagnostics.map((dg) => {
      const sev = severityLabel(dg.severity);
      const color =
        dg.severity === "error" ? "error" : dg.severity === "warning" ? "warning" : "muted";
      return theme.fg(color, `${sev} ${dg.file}:${dg.line}:${dg.column}  ${dg.message}`);
    });
    return new Text(lines.join("\n"), 0, 0);
  }

  // Fallback — should not reach here given the guard above.
  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return new Text(theme.fg("toolOutput", text), 0, 0);
}