import { describe, it, expect } from "vitest";
import type { StreamEvent, StreamCallback } from "../runner.ts";
import type { StreamEntry } from "../index.ts";

// ---------------------------------------------------------------------------
// Simulate the stream logic from index.ts execute handler.
// ---------------------------------------------------------------------------

interface PartialToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function formatExpandedStream(entries: StreamEntry[]): string {
  const lines: string[] = [];
  let textBuffer = "";
  for (const e of entries) {
    if (e.type === "text") {
      textBuffer += e.text;
      continue;
    }
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = "";
    }
    const marker = e.type === "tool_start" ? "▶" : e.error ? "✗" : "✓";
    lines.push(`${marker} ${e.name}`);
  }
  if (textBuffer) lines.push(textBuffer);
  return lines.join("\n");
}

function createStreamSetup(background: boolean) {
  const updates: PartialToolResult[] = [];
  const onUpdate = (result: PartialToolResult) => {
    updates.push(result);
  };

  const streamEntries: StreamEntry[] = [];
  const onStreamEvent: StreamCallback | undefined = background
    ? undefined
    : (event: StreamEvent) => {
        if (event.type === "text_delta") {
          if (!event.delta) return;
          streamEntries.push({ type: "text", text: event.delta });
        } else if (event.type === "tool_start") {
          streamEntries.push({ type: "tool_start", name: event.name });
        } else if (event.type === "tool_end") {
          streamEntries.push({ type: "tool_end", name: event.name, error: !!event.error });
        }
        const streamText = formatExpandedStream(streamEntries);
        onUpdate({
          content: [{ type: "text", text: streamText }],
          details: { streamText, streamEntries: [...streamEntries] },
        });
      };

  return { streamEntries: () => streamEntries, updates, onStreamEvent };
}

// ---------------------------------------------------------------------------
// Foreground stream behavior
// ---------------------------------------------------------------------------

describe("foreground stream callback", () => {
  it("is defined and is a function", () => {
    const { onStreamEvent } = createStreamSetup(false);
    expect(onStreamEvent).toBeDefined();
    expect(typeof onStreamEvent).toBe("function");
  });

  it("accumulates text from deltas", () => {
    const { onStreamEvent, streamEntries } = createStreamSetup(false);

    onStreamEvent!({ type: "text_delta", delta: "Found " });
    expect(streamEntries()).toEqual([{ type: "text", text: "Found " }]);

    onStreamEvent!({ type: "text_delta", delta: "3 " });
    expect(streamEntries()).toEqual([
      { type: "text", text: "Found " },
      { type: "text", text: "3 " },
    ]);

    onStreamEvent!({ type: "text_delta", delta: "files" });
    expect(streamEntries()).toEqual([
      { type: "text", text: "Found " },
      { type: "text", text: "3 " },
      { type: "text", text: "files" },
    ]);
  });

  it("emits onUpdate per text delta", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "text_delta", delta: "Hello " });
    expect(updates).toHaveLength(1);
    expect(updates[0].content[0].text).toBe("Hello ");

    onStreamEvent!({ type: "text_delta", delta: "world" });
    expect(updates).toHaveLength(2);
    expect(updates[0].content[0].text).toBe("Hello ");
    expect(updates[1].content[0].text).toBe("Hello world");
  });

  it("emits tool start summary", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "tool_start", name: "read" });

    expect(updates).toHaveLength(1);
    expect(updates[0].content[0].text).toContain("▶ read");
    const entries = updates[0].details.streamEntries as StreamEntry[];
    expect(entries).toEqual([{ type: "tool_start", name: "read" }]);
  });

  it("emits tool end summary (success)", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "tool_end", name: "read", error: false });

    expect(updates).toHaveLength(1);
    expect(updates[0].content[0].text).toContain("✓ read");
    const entries = updates[0].details.streamEntries as StreamEntry[];
    expect(entries).toEqual([{ type: "tool_end", name: "read", error: false }]);
  });

  it("emits tool error summary", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "tool_end", name: "bash", error: true });

    expect(updates).toHaveLength(1);
    expect(updates[0].content[0].text).toContain("✗ bash");
    const entries = updates[0].details.streamEntries as StreamEntry[];
    expect(entries).toEqual([{ type: "tool_end", name: "bash", error: true }]);
  });

  it("does not stream raw tool result inline", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "tool_end", name: "read", error: false });

    expect(updates).toHaveLength(1);
    expect(updates[0].content[0].text).not.toContain("file contents");
    expect(updates[0].content[0].text).not.toContain('{"data"');
  });

  it("onUpdate has streamText and streamEntries in details", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "text_delta", delta: "some text" });

    expect(updates[0].details).toBeDefined();
    expect(updates[0].details.streamText).toBe("some text");
    expect(updates[0].details.streamEntries).toEqual([{ type: "text", text: "some text" }]);
  });
});

// ---------------------------------------------------------------------------
// Background stream behavior
// ---------------------------------------------------------------------------

describe("background stream callback", () => {
  it("has no stream callback", () => {
    const { onStreamEvent } = createStreamSetup(true);
    expect(onStreamEvent).toBeUndefined();
  });

  it("has no onUpdate calls", () => {
    const { updates } = createStreamSetup(true);
    expect(updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Final result isolation — stream data is not part of final return
// ---------------------------------------------------------------------------

describe("final result isolation", () => {
  it("final result is clean subagent answer", () => {
    const { onStreamEvent } = createStreamSetup(false);

    onStreamEvent!({ type: "text_delta", delta: "Found 3 files:\n" });
    onStreamEvent!({ type: "text_delta", delta: "- file1.ts\n" });
    onStreamEvent!({ type: "text_delta", delta: "- file2.ts\n" });
    onStreamEvent!({ type: "text_delta", delta: "- file3.ts\n" });
    onStreamEvent!({ type: "text_delta", delta: "Summary: all clean.\n" });

    const finalResult = {
      content: [
        {
          type: "text" as const,
          text: "Found 3 files:\n- file1.ts\n- file2.ts\n- file3.ts\nSummary: all clean.\n",
        },
      ],
      details: { agent_id: "sa_abc", status: "completed", tokens: 100, toolUses: 2 },
    };

    expect(finalResult.content[0].type).toBe("text");
    expect(finalResult.content[0].text).toBe(
      "Found 3 files:\n- file1.ts\n- file2.ts\n- file3.ts\nSummary: all clean.\n",
    );
    expect((finalResult.details as any).streamText).toBeUndefined();
    expect((finalResult.details as any).streamEntries).toBeUndefined();
  });

  it("stream text separate from final content", () => {
    const { onStreamEvent, streamEntries } = createStreamSetup(false);

    onStreamEvent!({ type: "text_delta", delta: "Let me check the codebase...\n" });
    onStreamEvent!({ type: "tool_start", name: "grep" });
    onStreamEvent!({ type: "tool_end", name: "grep", error: false });
    onStreamEvent!({ type: "text_delta", delta: "I found some patterns.\n" });
    onStreamEvent!({ type: "tool_start", name: "read" });
    onStreamEvent!({ type: "tool_end", name: "read", error: false });
    onStreamEvent!({ type: "text_delta", delta: "Here is my analysis:\n" });
    onStreamEvent!({ type: "text_delta", delta: "The code uses TypeScript.\n" });

    const entries = streamEntries();
    expect(entries.some((e) => e.type === "tool_start" && e.name === "grep")).toBe(true);
    expect(entries.some((e) => e.type === "tool_end" && e.name === "read" && !e.error)).toBe(true);

    const finalAnswer = "Here is my analysis:\nThe code uses TypeScript.";
    expect(finalAnswer).not.toBe(formatExpandedStream(streamEntries()));
  });

  it("final return details exclude stream data", () => {
    const finalDetails = {
      agent_id: "sa_xyz",
      status: "completed" as const,
      tokens: 25,
      toolUses: 1,
    };

    expect((finalDetails as any).streamText).toBeUndefined();
    expect((finalDetails as any).streamEntries).toBeUndefined();
    expect(Object.keys(finalDetails)).toHaveLength(4);
    expect(finalDetails).toHaveProperty("agent_id");
    expect(finalDetails).toHaveProperty("status");
    expect(finalDetails).toHaveProperty("tokens");
    expect(finalDetails).toHaveProperty("toolUses");
  });

  it("final details have no stream keys even with warnings", () => {
    const finalDetails = {
      agent_id: "sa_warn",
      status: "completed" as const,
      tokens: 50,
      toolUses: 3,
      warnings: [
        { scope: "explore" as const, reference: "bad/ref", type: "unresolvable" as const },
      ],
    };

    expect((finalDetails as any).streamText).toBeUndefined();
    expect((finalDetails as any).streamEntries).toBeUndefined();
    expect(Array.isArray(finalDetails.warnings)).toBe(true);
    expect(finalDetails.warnings).toHaveLength(1);
  });
});