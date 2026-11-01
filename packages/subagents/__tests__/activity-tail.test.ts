import { describe, it, expect } from "vitest";
import { ActivityCapture, activityTail, ACTIVITY_TAIL_LIMIT } from "../activity.ts";
import type { StreamEntry } from "../index.ts";

// ---------------------------------------------------------------------------
// The Activity tail bound: the retained UI-only tail of a Subagent run is
// capped at 50 assistant-text and tool-activity entries with an explicit
// omission indicator count for anything dropped. Both the live foreground
// expansion and the persisted background tail share this bound.
// ---------------------------------------------------------------------------

describe("activityTail", () => {
  it("keeps a list that fits entirely, with no omission indicator", () => {
    const entries: StreamEntry[] = [
      { type: "text", text: "Looking…" },
      { type: "tool_start", name: "grep" },
      { type: "tool_end", name: "grep", error: false },
    ];
    expect(activityTail(entries)).toEqual({ entries, omitted: 0 });
  });

  it("keeps the chronological last 50 and reports how many were dropped", () => {
    const entries: StreamEntry[] = Array.from({ length: 55 }, (_, i) => ({
      type: "tool_start" as const,
      name: `tool-${i}`,
    }));
    const tail = activityTail(entries);
    expect(tail.entries).toHaveLength(ACTIVITY_TAIL_LIMIT);
    expect(tail.omitted).toBe(5);
    // It is the LAST 50, in order: the first retained entry is #5.
    expect(tail.entries[0]).toEqual({ type: "tool_start", name: "tool-5" });
    expect(tail.entries[49]).toEqual({ type: "tool_start", name: "tool-54" });
  });

  it("returns an independent copy so later mutation cannot rewrite the retained tail", () => {
    const entries: StreamEntry[] = [{ type: "text", text: "one" }];
    const tail = activityTail(entries);
    (tail.entries[0] as { text: string }).text = "mutated";
    expect(entries[0].text).toBe("one");
  });

  it("never reports a dropped entry for a list that just fits the bound", () => {
    const entries: StreamEntry[] = Array.from({ length: 50 }, () => ({
      type: "tool_end" as const,
      name: "read",
      error: false,
    }));
    const tail = activityTail(entries);
    expect(tail.omitted).toBe(0);
    expect(tail.entries).toHaveLength(50);
  });
});

describe("ActivityCapture", () => {
  function toolStart(name: string) {
    return { type: "tool_start" as const, name };
  }

  it("maps stream events into the same entry shape as the foreground tail", () => {
    const capture = new ActivityCapture();
    capture.push({ type: "text_delta", delta: "Found " });
    capture.push({ type: "text_delta", delta: "3 files" });
    capture.push(toolStart("grep"));
    capture.push({ type: "tool_end", name: "grep", error: false });
    expect(capture.snapshotTail()).toEqual({
      entries: [
        { type: "text", text: "Found " },
        { type: "text", text: "3 files" },
        { type: "tool_start", name: "grep" },
        { type: "tool_end", name: "grep", error: false },
      ],
      omitted: 0,
    });
  });

  it("ignores empty text deltas like the foreground stream does", () => {
    const capture = new ActivityCapture();
    capture.push({ type: "text_delta", delta: "" });
    expect(capture.snapshotTail()).toEqual({ entries: [], omitted: 0 });
  });

  it("holds the 50-entry bound itself so long background runs stay bounded", () => {
    const capture = new ActivityCapture();
    for (let i = 0; i < 53; i++) capture.push(toolStart(`t${i}`));
    const tail = capture.snapshotTail();
    expect(tail.entries).toHaveLength(50);
    expect(tail.omitted).toBe(3);
    expect(tail.entries[0]).toEqual({ type: "tool_start", name: "t3" });
  });

  it("snapshot is detached: pushes after it do not leak into a taken tail", () => {
    const capture = new ActivityCapture();
    capture.push({ type: "text_delta", delta: "before" });
    const taken = capture.snapshotTail();
    capture.push({ type: "text_delta", delta: "after" });
    expect(taken.entries).toEqual([{ type: "text", text: "before" }]);
    expect(capture.snapshotTail().entries).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ]);
  });

  it("excludes hidden reasoning: thinking deltas never reach the tail", () => {
    const capture = new ActivityCapture();
    capture.push({ type: "text_delta", delta: "answer text" });
    // The runner never forwards these; the capture must also not invent them.
    capture.push({ type: "unknown_event" } as never);
    expect(capture.snapshotTail().entries).toEqual([{ type: "text", text: "answer text" }]);
  });
});