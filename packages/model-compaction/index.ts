import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAtOrAboveThreshold } from "./trigger.ts";

/**
 * Model-aware compaction Extension package.
 *
 * Sole automatic compaction trigger. After each completed turn it starts one
 * compaction when known context usage has reached 50% of the active model's
 * advertised context window. Pi's native fixed-token auto-compaction is turned
 * off in settings (`compaction.enabled: false`), so this extension owns the
 * automatic boundary while manual `/compact` keeps working.
 *
 * The immutable 8k retained-context budget lives in Pi's own
 * `compaction.keepRecentTokens` setting (see `packages/pi-config/settings.json`),
 * applied to manual and extension-triggered compaction alike.
 *
 * `ctx.compact()` is asynchronous and fire-and-forget: the callbacks settle the
 * in-progress guard. Automatic continuation after an interrupted turn and
 * user-visible failure reporting are follow-up ticket 0002.
 */
export default function (pi: ExtensionAPI): void {
  let compacting = false;

  const settle = () => {
    compacting = false;
  };

  pi.on("turn_end", (_event, ctx: ExtensionContext) => {
    if (compacting) return;
    if (!isAtOrAboveThreshold(ctx.getContextUsage())) return;

    compacting = true;
    try {
      ctx.compact({ onComplete: settle, onError: settle });
    } catch {
      // The request never started, so it is not active: release the guard.
      settle();
    }
  });
}