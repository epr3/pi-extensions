// Two agent types: a read-only `explore` agent for codebase discovery and a
// `general` agent for off-context work that may write. External web research
// is a parent-agent workflow using web Extension tools directly, not a built-in
// Subagent type.
//
// Tool access is configuration, not code:
// - `general` passes no allowlist — every built-in and every discovered
//   extension tool, minus the safety exclusions (plus any extras from config).
// - `explore` defaults to the core read-only built-ins. Additional read-only
//   tools (e.g. the lsp_* navigation set) are granted under the `subagents.explore.extraTools`
//   key of Pi's settings.json — see the shipped example — or ad hoc via
//   the PI_SUBAGENT_EXPLORE_TOOLS env var. Never grant anything that can
//   write or execute; that's what `general` is for.

export type AgentType = "explore" | "general";

import type { CustomTypeDiscovery } from "./discovery.ts";

/** Read-only built-ins — the floor of the explore toolset. */
export const CORE_READ_TOOLS = ["read", "grep", "find", "ls"];

/** Default explore toolset: core reads plus codemode, which lets the model batch
 *  and filter calls to the tools active in the child session. codemode is not
 *  itself read-only, so the allowlist still has to keep write/execute tools out. */
export const DEFAULT_EXPLORE_TOOLS = [...CORE_READ_TOOLS, "codemode"];

/** Tool guidance for every Subagent when codemode is available: prefer it when
 *  a task needs several calls, calls whose results feed later calls, or
 *  filtering large output; keep simple single calls on the direct tools. */
export const CODEMODE_GUIDANCE =
  "Prefer codemode when a task needs several tool calls, when one call's result feeds the next, " +
  "or when tool output must be filtered before it reaches you: it batches independent calls, " +
  "chains dependent ones, and filters large results in one step. Use the direct tools for " +
  "straightforward single calls.";

/** Always excluded from sub-sessions: no recursion, no stopping, and no
 *  questions without a user — only the parent launches, retrieves, stops. */
export const SAFETY_EXCLUDES = ["Agent", "get_subagent_result", "stop_subagent", "question"];

/** The explore allowlist: core + configured grants + env extras, deduped. */
export function exploreToolset(
  extraTools: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envExtra = (env.PI_SUBAGENT_EXPLORE_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_EXPLORE_TOOLS, ...extraTools, ...envExtra])];
}

export interface AgentDef {
  readOnly: boolean;
  /** Full system-prompt override, or undefined to inherit the normal prompt. */
  systemPrompt?: string;
  description: string;
}

export const AGENTS: Record<AgentType, AgentDef> = {
  explore: {
    readOnly: true,
    systemPrompt:
      "You are a read-only exploration sub-agent. Investigate the assigned question using only " +
      "your read-only tools: read, grep, find, ls, plus codemode for batching/filtering those " +
      "calls and any additional read-only tools you have been granted (e.g. lsp_definition, " +
      "lsp_references, lsp_hover, lsp_document_symbols, lsp_diagnostics). When the lsp_* tools are " +
      "present, prefer them over grep for typed languages: they answer definition/reference " +
      "questions precisely. Use codemode only to call tools inside this allowlist. You cannot " +
      "edit, write, or run commands. Return the relevant file paths with a one-line summary each, " +
      "then the answer to the question. Cap any raw quoted code at ~30 lines and summarize the " +
      "rest. Do not attempt to spawn further sub-agents.",
    description: "Read-only codebase discovery",
  },
  general: {
    readOnly: false,
    systemPrompt: undefined, // inherits the normal system prompt for the cwd
    description: "Scoped read/write work off the main context",
  },
};

export function resolveAgentType(requested: string): AgentType {
  const s = String(requested).toLowerCase();
  if (s.startsWith("expl")) return "explore";
  if (s === "general") return "general";
  // No fallback to a supported type: a stale or unknown request must not be
  // silently widened to write-capable `general` work.
  const retired =
    s === "researcher"
      ? ` The "researcher" type was retired — use the parent agent's web_search / web_fetch ` +
        `tools directly for web research.`
      : "";
  throw new Error(
    `Unsupported subagent_type "${requested}". Supported types: "explore" (read-only ` +
      `discovery), "general" (read/write), or a custom type defined in your agent ` +
      `definition directories (.pi/agents).${retired}`,
  );
}

// ─── Custom type resolution ─────────────────────────────────────────────────┼

export type ResolvedRequest =
  | { kind: "builtin"; type: AgentType }
  | { kind: "custom"; name: string };

/**
 * Resolve a `subagent_type` request against built-ins and currently discovered
 * custom definitions.
 *
 * Exact matches against valid custom names win FIRST, before any built-in
 * alias: a custom type named e.g. "Explorer" must not be captured by the
 * speculative `expl` prefix alias for `explore`. (Compatibility change: that
 * alias previously swallowed any "expl…" input; it still applies, but only
 * when no exact custom name matches.) `explore`/`general` are reserved and
 * can never appear as custom names, so built-in requests keep working.
 *
 * Unknown or invalid requested types fail — no silent fallback to `general`.
 */
export function resolveTypeRequest(
  requested: string,
  custom: CustomTypeDiscovery,
): ResolvedRequest {
  const exact = custom.valid.get(requested);
  if (exact) return { kind: "custom", name: exact.name };

  const s = String(requested).toLowerCase();
  if (s.startsWith("expl")) return { kind: "builtin", type: "explore" };
  if (s === "general") return { kind: "builtin", type: "general" };
  const retired =
    s === "researcher"
      ? ` The "researcher" type was retired — use the parent agent's web_search / web_fetch ` +
        `tools directly for web research.`
      : "";
  throw new Error(
    `Unsupported subagent_type "${requested}". Supported types: "explore" (read-only ` +
      `discovery), "general" (read/write), or one of the currently valid custom ` +
      `types${custom.valid.size ? `: ${[...custom.valid.keys()].map((n) => `"${n}"`).join(", ")}` : " (none are defined right now)"}. That custom name may be invalid, conflicted, ` +
      `or shadowed — see the definition diagnostics emitted at launch.${retired}`,
  );
}