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

/** Read-only built-ins — the floor of the explore toolset. */
export const CORE_READ_TOOLS = ["read", "grep", "find", "ls"];

/** Always excluded from sub-sessions: no recursion, no questions without a user. */
export const SAFETY_EXCLUDES = ["Agent", "get_subagent_result", "question"];

/** The explore allowlist: core + configured grants + env extras, deduped. */
export function exploreToolset(
  extraTools: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envExtra = (env.PI_SUBAGENT_EXPLORE_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...CORE_READ_TOOLS, ...extraTools, ...envExtra])];
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
      "your read-only tools: read, grep, find, ls, plus any additional read-only tools you have " +
      "been granted (e.g. lsp_definition, lsp_references, lsp_hover, lsp_document_symbols, " +
      "lsp_diagnostics). When the lsp_* tools are present, prefer them over grep for typed " +
      "languages: they answer definition/reference questions precisely. You cannot edit, write, " +
      "or run commands. Return the relevant file paths with a one-line summary each, then the " +
      "answer to the question. Cap any raw quoted code at ~30 lines and summarize the rest. Do " +
      "not attempt to spawn further sub-agents.",
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
      `discovery) and "general" (read/write).${retired}`,
  );
}