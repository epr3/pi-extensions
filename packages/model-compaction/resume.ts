import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";

/**
 * Hidden continuation context injected after compacting a turn that produced
 * tool results. Pi exposes extension compaction as a manual operation that
 * aborts the active run, so the model must be told the interrupted work resumes
 * from the compaction summary and retained messages rather than restated.
 */
export const CONTINUATION_CONTEXT =
  "Your previous turn was interrupted by automatic context compaction. " +
  "Resume the in-progress work from the compaction summary and the retained messages. " +
  "Do not restate the task or ask the user to repeat it.";

/**
 * A completed turn that produced tool results was interrupted mid-work: its
 * results are part of the retained context, but the work they belong to is
 * unfinished and must continue after compaction. A text-only turn is a complete
 * response, so compacting it must not start another assistant reply.
 */
export function isInterruptedWork(event: Pick<TurnEndEvent, "toolResults">): boolean {
  return event.toolResults.length > 0;
}