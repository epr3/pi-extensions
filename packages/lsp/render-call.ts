import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LspArgs, ParamKind } from "./tools.ts";

/** User-facing summary text for an LSP tool call, separate from the final
 * language-server result. Uses caller-supplied positions (1-based) and paths
 * so the row matches the arguments the user already sees. */
export function formatLspCallSummary(kind: ParamKind, args: LspArgs): string {
  switch (kind) {
    case "pos":
    case "ref":
      // Caller supplies 1-based positions; keep them as-is for the summary.
      return `${args.file}:${args.line!}:${args.column!}`;
    case "file":
      return args.file;
    case "query":
      // file routes to the right language server, it is not the search scope.
      return `${args.query!} via ${args.file}`;
  }
}

/** Factory for the LSP tool `renderCall` callback. The label comes from the
 * tool spec; the summary shape is keyed only by parameter kind. */
export function renderLspCall(label: string, kind: ParamKind) {
  return (args: Record<string, unknown>, theme: Theme, _ctx: unknown): Text => {
    const summary = formatLspCallSummary(kind, args as unknown as LspArgs);
    const text = theme.fg("toolTitle", theme.bold(label)) + theme.fg("muted", `  ${summary}`);
    return new Text(text, 0, 0);
  };
}