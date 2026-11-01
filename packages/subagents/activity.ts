import type { StreamEvent } from "./runner.ts";

/**
 * One UI-only activity entry of a run: assistant text (deltas joined) or a
 * compact tool lifecycle marker. Never hidden reasoning; never model-facing
 * content on its own.
 */
export type StreamEntry =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; error: boolean };

/**
 * The shared bound for a Subagent run's UI-only Activity tail: at most 50
 * assistant-text and tool-activity entries, chronologically, with an explicit
 * omission indicator when earlier entries were dropped. The bound is an entry
 * count, not a byte guarantee — entries vary in size and session storage can
 * contain the retained tail in full.
 */
export const ACTIVITY_TAIL_LIMIT = 50;

/** Map one runner StreamEvent into the shared entry shape — the single
 *  mapping used by foreground streaming updates and the background capture.
 *  Empty deltas yield nothing (they are not activity); unknown event types
 *  yield nothing so the tail stays the agreed assistant-text + tool-activity
 *  shape. Thinking deltas are never an input. */
export function entryFromStreamEvent(event: StreamEvent): StreamEntry | undefined {
  if (event.type === "text_delta") {
    return event.delta ? { type: "text", text: event.delta } : undefined;
  }
  if (event.type === "tool_start") return { type: "tool_start", name: event.name };
  if (event.type === "tool_end")
    return { type: "tool_end", name: event.name, error: !!event.error };
  return undefined;
}

/** A retained Activity tail: the kept entries plus how many earlier ones
 *  were dropped (the omission indicator's number; 0 = indicator absent). */
export interface ActivitySnapshot {
  entries: StreamEntry[];
  omitted: number;
}

/**
 * Reduce the full chronological activity of one run to the retained tail:
 * the last [limit] entries and the count of earlier dropped entries.
 */
export function activityTail(
  entries: readonly StreamEntry[],
  limit: number = ACTIVITY_TAIL_LIMIT,
): ActivitySnapshot {
  const over = Math.max(0, entries.length - limit);
  // Copy each entry too: the tail is a snapshot that later mutation (an
  // active stream appending after the snap, in-place edits in a caller)
  // must not retroactively rewrite.
  return {
    entries: entries.slice(entries.length - limit).map((e) => ({ ...e })),
    omitted: over,
  };
}

/**
 * Accumulates one run's StreamEvents into entries and retains only the
 * bounded tail. Shared by foreground streaming (which additionally emits
 * OnUpdate rows) and background runs (whose tail is captured at run time,
 * without any live assistant prose reaching the parent context), so both use
 * the same mapping and the same bound. Thinking deltas are deliberately not
 * an input — hidden reasoning never reaches the tail.
 */
export class ActivityCapture {
  private entries: StreamEntry[] = [];
  private omitted = 0;

  constructor(private limit: number = ACTIVITY_TAIL_LIMIT) {}

  push(event: StreamEvent): void {
    const entry = entryFromStreamEvent(event);
    if (entry) this.append(entry);
  }

  private append(entry: StreamEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.shift();
      this.omitted++;
    }
  }

  /** The retained tail at this moment — detached, safe to persist or emit. */
  snapshotTail(): ActivitySnapshot {
    return { entries: [...this.entries], omitted: this.omitted };
  }
}