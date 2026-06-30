// Three agent types: a read-only `explore` agent for codebase discovery, a
// read-only `researcher` agent for web research (web tools + read, no write),
// and a `general` agent for off-context work that may write. Conventions (the
// Agent tool surface, subagent_type) are loosely modeled on @tintinweb/pi-subagents
// and the researcher role on amosblomqvist/pi-subagents; not followed verbatim —
// only what this suite needs.
//
// Tool access is configuration, not code:
// - `general` passes no allowlist — every built-in and every discovered
//   extension tool, minus the safety exclusions (plus any extras from config).
// - `explore` defaults to the core read-only built-ins. Additional read-only
//   tools (e.g. the lsp_* navigation set) are granted under the `subagents.explore.extraTools`
//   key of Pi's settings.json — see the shipped example — or ad hoc via
//   the PI_SUBAGENT_EXPLORE_TOOLS env var. Never grant anything that can
//   write or execute; that's what `general` is for.

export type AgentType = "explore" | "general" | "researcher";

/** Read-only built-ins — the floor of the explore toolset. */
export const CORE_READ_TOOLS = ["read", "grep", "find", "ls"];

/** Always excluded from sub-sessions: no recursion, no questions without a user. */
export const SAFETY_EXCLUDES = ["Agent", "get_subagent_result", "question"];

/** The explore allowlist: core + configured grants + env extras, deduped. */
export function exploreToolset(extraTools: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const envExtra = (env.PI_SUBAGENT_EXPLORE_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...CORE_READ_TOOLS, ...extraTools, ...envExtra])];
}

/** Web tools the researcher needs; supplied by separate Pi extensions (web-search/web-fetch). */
export const RESEARCH_TOOLS = ["web_search", "web_fetch"];

/** The researcher allowlist: core read + web + configured grants + env extras, deduped. */
export function researcherToolset(extraTools: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const envExtra = (env.PI_SUBAGENT_RESEARCHER_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...CORE_READ_TOOLS, ...RESEARCH_TOOLS, ...extraTools, ...envExtra])];
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
  researcher: {
    readOnly: true,
    systemPrompt:
      "You are a read-only research sub-agent. Investigate the assigned question using your web tools " +
      "(web_search, web_fetch) and your read-only local tools (read, grep, find, ls). Use the web for " +
      "current, authoritative information; use the local read tools to ground findings against this " +
      "codebase when the question touches it. You cannot edit, write, or run commands. Do not attempt " +
      "to spawn further sub-agents.\n\n" +
      "## Research workflow\n\n" +
      "1. **Break the research into facets.** Decompose the main question into 2-4 searchable angles " +
      "or facets. Search each one independently to cover different perspectives rather than relying " +
      "on a single query. Vary your search terms across facets.\n\n" +
      "2. **Prefer official and primary sources.** Prioritize official documentation, primary-source " +
      "pages, and authoritative references over blog posts, forums, or secondary summaries. When " +
      "researching a library, API, framework, or documentation-heavy topic, check the canonical " +
      "/llms.txt on its official documentation host first — it may provide documentation structured " +
      "for LLM consumption. Also look for llms-full.txt or llms-all.txt variants, which may contain " +
      "more complete bundled documentation.\n\n" +
      "3. **Verify important claims.** Treat LLM-oriented documentation sources (/llms.txt and " +
      "variants) as convenient starting points, not unchallenged authorities. Before treating an " +
      "important claim as settled, verify it against the corresponding official source page (the " +
      "human-readable docs, spec, or reference). Cross-check factual claims, version numbers, API " +
      "signatures, and behavioural statements against the official pages.\n\n" +
      "4. **Fetch promising sources.** Do not rely only on search result snippets. Use web_fetch to " +
      "retrieve the full content of the most promising URLs so you can read beyond the excerpt. " +
      "Evaluate each source for relevance, authority, and timeliness.\n\n" +
      "5. **Cite your sources and explain your choices.** In the final answer, cite every source " +
      "you used (URLs and/or file paths). Explain why you kept each source (e.g. official docs, " +
      "primary source, authoritative reference). Where you considered but dropped a source, briefly " +
      "explain why (e.g. outdated, low authority, off-topic). If the research leaves open questions " +
      "or gaps in coverage, list them explicitly.\n\n" +
      "Keep raw quoted material short — paraphrase and summarize rather than pasting large blocks.",
    description: "Read-only web research (web + read)",
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
  if (s.startsWith("rese")) return "researcher";
  return "general";
}
