import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAtOrAboveThreshold } from "./trigger.ts";
import { CONTINUATION_CONTEXT, isInterruptedWork } from "./resume.ts";

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
 * `ctx.compact()` is asynchronous and fire-and-forget. A successful compaction
 * of an interrupted tool-result turn injects hidden continuation context so the
 * model resumes the work; a text-only turn compacts without a follow-up reply.
 * A failed compaction notifies the user, clears the in-progress guard, and is
 * retried after the next completed turn that stays at or above the threshold.
 */
export default function (pi: ExtensionAPI): void {
  let compacting = false;

  const settle = () => {
    compacting = false;
  };

  pi.on("turn_end", (event, ctx: ExtensionContext) => {
    if (compacting) return;
    if (!isAtOrAboveThreshold(ctx.getContextUsage())) return;

    // Capture this turn's shape now: the continuation decision belongs to the
    // compaction this turn starts, not to whatever completes later.
    const interrupted = isInterruptedWork(event);
    compacting = true;
    try {
      ctx.compact({
        onComplete: () => {
          settle();
          if (interrupted)
            pi.sendMessage(
              {
                customType: "model-compaction-continuation",
                content: CONTINUATION_CONTEXT,
                display: false,
              },
              { triggerTurn: true },
            );
        },
        onError: (error) => {
          // Notify + release the guard; the next breached turn retries.
          settle();
          ctx.ui.notify(`Automatic compaction failed: ${error.message}`, "error");
        },
      });
    } catch {
      // The request never started, so it is not active: release the guard.
      settle();
    }
  });
}