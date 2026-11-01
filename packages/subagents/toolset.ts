// Capability selection for custom Subagent definitions.
//
// A definition's `tools` / `disallowedTools` frontmatter narrows or keeps the
// Subagent's tool boundary, but the fixed safety exclusions from agents.ts
// always win: no Subagent can be granted back delegation (`Agent`), result
// retrieval (`get_subagent_result`), or blocking questions — not even by
// explicitly allowlisting them.
//
// Availability is judged against the parent session's actual active tool
// names (`pi.getActiveTools()` at the extension boundary). Names the parent
// session does not currently have are rejected instead of silently ignored,
// so a mistyped tool name cannot quietly widen or narrow a definition. When
// the boundary cannot report a tool set (test fakes), shape-level checks
// still apply but availability and inherited-set checks are skipped.
import type { CustomSubagentDef } from "./discovery.ts";
import { SAFETY_EXCLUDES } from "./agents.ts";

/** What the runner gets for one custom-type launch. */
export interface ResolvedToolset {
  /** Explicit allowlist, safety-exclusions removed. Omitted: inherit. */
  tools?: string[];
  /** The definition's denial list, passed as exclusions on top of the fixed
   *  safety exclusions (subtracts from inherited or allowlisted tools).
   *  Absent property = no denials (distinguishable from an empty list). */
  excludeExtraTools?: string[];
}

/**
 * Resolve the toolset for one custom definition launch.
 *
 * Effective tool boundary:
 *   (tools allowlist, or every available tool when omitted)
 *   − disallowedTools − the fixed safety exclusions
 *
 * Rejects (throws, never silently ignores):
 * - any allowlisted or denied name the current session does not actually
 *   have (unknown or unavailable tool name);
 * - a definition whose effective set is empty — either because the
 *   allowlist only named excluded tools, or because denials remove
 *   everything the run would otherwise inherit.
 */
export function resolveDefinitionToolset(
  def: CustomSubagentDef,
  availableTools: string[] | undefined,
): ResolvedToolset {
  const deny = def.disallowedTools ?? [];
  const allow = def.tools;

  if (availableTools) {
    const have = new Set(availableTools);
    for (const name of [...(allow ?? []), ...deny]) {
      if (!have.has(name)) {
        throw new Error(
          `Subagent type "${def.name}": tool "${name}" is not among the available Pi tool ` +
            `names in this session — use exact registered tool names (e.g. "read", "bash", "grep")`,
        );
      }
    }
  }

  // What the run could actually use after the fixed safety boundary. Only
  // computable when the inherited side of the subtraction is known.
  const effectiveSource = allow ?? availableTools;
  if (effectiveSource) {
    const denied = new Set([...deny, ...SAFETY_EXCLUDES]);
    const effective = effectiveSource.filter((t) => !denied.has(t));
    if (effective.length === 0) {
      throw new Error(
        `Subagent type "${def.name}": tool settings resolve to no tools — ` +
          `after the safety exclusions (${SAFETY_EXCLUDES.join(", ")}) and any ` +
          `disallowedTools, nothing is left. Allow at least one plain tool name.`,
      );
    }
  }

  const out: ResolvedToolset = { excludeExtraTools: undefined };
  // Defensive subtraction: the runner also enforces the safety boundary via
  // excludeTools, but we never even hand it a subagent tool name.
  if (allow) out.tools = allow.filter((t) => !(SAFETY_EXCLUDES as readonly string[]).includes(t));
  if (deny.length) out.excludeExtraTools = deny;
  return out;
}