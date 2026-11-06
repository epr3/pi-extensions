import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { AgentType } from "./agents.ts";
import type { WarningScope } from "./warnings.ts";

/** A per-type scope or the shared scope — custom Subagent types have no
 *  per-type settings of their own; their per-type preference is the
 *  definition's own `thinkingLevel` frontmatter (see
 *  resolveDefinitionThinkingLevel). */
export type AgentTypeOrShared = AgentType | "shared";

/**
 * Pure Subagent thinking-level resolver.
 *
 * Precedence is per-type preference → shared preference → SDK/settings
 * defaults (no override). Each candidate is validated against Pi's thinking
 * vocabulary; an invalid candidate is reported and skipped, letting the next
 * level apply. This mirrors model-ref.ts and keeps thinking independent of
 * model selection.
 */

/** Pi's settings-level thinking vocabulary. */
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** True when `value` is a valid Pi thinking level (exact match, no trimming). */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Warning about a configured thinking preference that could not be used. */
export interface ThinkingWarning {
  /** Which setting level holds the problematic value. */
  scope: WarningScope;
  /** Pi settings path, e.g. `subagents.explore.thinkingLevel`. */
  setting: string;
  /** The raw configured value as JSON for diagnostics. */
  reference: string;
  type: "malformed";
}

/** The candidate that won the precedence cascade, with its settings origin. */
export interface ThinkingWinner {
  level: ThinkingLevel;
  setting: string;
  scope: WarningScope;
}

export interface ThinkingResolution {
  /** Winning candidate, or absent to omit the session override entirely. */
  winner?: ThinkingWinner;
  /** Warnings for configured-but-invalid candidates that were consulted. */
  warnings: ThinkingWarning[];
}

export function thinkingSetting(scope: WarningScope): string {
  return scope === "shared" ? "subagents.thinkingLevel" : `subagents.${scope}.thinkingLevel`;
}

/**
 * Resolve the Subagent thinking level for `type`.
 *
 * Each consulted candidate is validated before moving on: a valid per-type
 * preference short-circuits (the shared value is never inspected, so a broken
 * shared value stays silent); an invalid per-type preference warns and falls
 * through; an invalid shared preference warns only when it is consulted (no
 * valid per-type preference short-circuited it).
 */
export function resolveTypeThinkingLevel(
  typeRaw: unknown,
  sharedRaw: unknown,
  type: AgentTypeOrShared,
): ThinkingResolution {
  const warnings: ThinkingWarning[] = [];

  if (typeRaw !== undefined) {
    if (isThinkingLevel(typeRaw)) {
      return { winner: { level: typeRaw, setting: thinkingSetting(type), scope: type }, warnings };
    }
    warnings.push({
      scope: type,
      setting: thinkingSetting(type),
      reference: JSON.stringify(typeRaw),
      type: "malformed",
    });
  }

  if (sharedRaw !== undefined) {
    if (isThinkingLevel(sharedRaw)) {
      return {
        winner: { level: sharedRaw, setting: thinkingSetting("shared"), scope: "shared" },
        warnings,
      };
    }
    warnings.push({
      scope: "shared",
      setting: thinkingSetting("shared"),
      reference: JSON.stringify(sharedRaw),
      type: "malformed",
    });
  }

  return { warnings };
}

/**
 * Resolve the Subagent thinking level for a custom **Subagent type** from its
 * definition's frontmatter `thinkingLevel` and the shared settings
 * preference.
 *
 * The definition's own preference replaces the per-type settings slot of the
 * built-in cascade: a definition preference short-circuits (the shared setting
 * is never inspected, so a broken shared value stays silent), and omission
 * falls through to the shared setting exactly as before. Discovery rejects an
 * invalid definition value up front (parseThinkingLevelField), so a valid
 * definition value always wins; the defensive malformed branch below exists
 * only to keep the cascade total should an unvalidated raw value ever reach
 * it.
 *
 * `name` is the custom type name; it labels the definition's field in
 * warnings and effective-level reports, e.g.
 * `definition "reader" thinkingLevel requested "high"; effective "low"`.
 */
export function resolveDefinitionThinkingLevel(
  definitionRaw: unknown,
  sharedRaw: unknown,
  name: string,
): ThinkingResolution {
  const warnings: ThinkingWarning[] = [];

  if (definitionRaw !== undefined) {
    if (isThinkingLevel(definitionRaw)) {
      return {
        winner: {
          level: definitionRaw,
          setting: `definition "${name}" thinkingLevel`,
          scope: "definition",
        },
        warnings,
      };
    }
    warnings.push({
      scope: "definition",
      setting: `definition "${name}" thinkingLevel`,
      reference: JSON.stringify(definitionRaw),
      type: "malformed",
    });
  }

  if (sharedRaw !== undefined) {
    if (isThinkingLevel(sharedRaw)) {
      return {
        winner: { level: sharedRaw, setting: thinkingSetting("shared"), scope: "shared" },
        warnings,
      };
    }
    warnings.push({
      scope: "shared",
      setting: thinkingSetting("shared"),
      reference: JSON.stringify(sharedRaw),
      type: "malformed",
    });
  }

  return { warnings };
}