import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/**
 * Fraction of the active model's advertised context window that starts
 * compaction. Fixed on purpose: the boundary is model-aware, not machine-wide.
 */
export const COMPACT_AT_FRACTION = 0.5;

/**
 * Model-aware boundary: true when known context usage has reached half of the
 * active model's advertised window.
 *
 * Unknown usage (right after a compaction, before the next response) and a
 * non-positive window are never a trigger — compacting on a guess would fire
 * blindly.
 */
export function isAtOrAboveThreshold(usage: ContextUsage | undefined): boolean {
  if (!usage || usage.tokens === null) return false;
  if (usage.contextWindow <= 0) return false;
  return usage.tokens >= usage.contextWindow * COMPACT_AT_FRACTION;
}