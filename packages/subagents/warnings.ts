import type { AgentType } from "./agents.ts";

/**
 * Which settings level a subagent warning applies to. `"definition"` marks a
 * warning about a **Custom Subagent definition**'s own frontmatter
 * capability rather than a Pi settings key.
 */
export type WarningScope = "shared" | AgentType | "definition";

/**
 * User-facing warning about a configured-but-unusable subagent setting.
 * Belongs in tool-result `details.warnings` and UI notifications — never in
 * generated Subagent result prose.
 */
export interface AgentWarning {
  scope: WarningScope;
  reference: string;
  type: "malformed" | "unresolvable" | "clamped";
  setting?: string;
  requested?: string;
  effective?: string;
}