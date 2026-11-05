import { describe, expect, it } from "vitest";
import { runSubagentSession, type StreamEvent } from "../runner.ts";
import { ActivityCapture } from "../activity.ts";
import { formatCollapsedStream, formatExpandedStream } from "../index.ts";

describe("live tool activity", () => {
  it("forwards tool arguments and cumulative updates from the child session", async () => {
    let handler: (event: any) => void = () => {};
    const events: StreamEvent[] = [];
    const session = {
      subscribe: (cb: (event: any) => void) => {
        handler = cb;
        return () => {};
      },
      abort: () => {},
      dispose: () => {},
      messages: [],
      prompt: async () => {
        handler({
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "1",
          args: { command: "echo hi" },
        });
        handler({
          type: "tool_execution_update",
          toolName: "bash",
          toolCallId: "1",
          partialResult: { content: [{ type: "text", text: "hi" }] },
        });
        handler({
          type: "tool_execution_end",
          toolName: "bash",
          toolCallId: "1",
          isError: false,
          result: { content: [{ type: "text", text: "hi!" }] },
        });
      },
    };
    await runSubagentSession({ session, prompt: "test", onStreamEvent: (e) => events.push(e) });
    const capture = new ActivityCapture();
    capture.push(events[0]);
    capture.push(events[1]);
    expect(formatCollapsedStream(capture.snapshotTail().entries)).toContain("echo hi");
    expect(formatExpandedStream(capture.snapshotTail().entries)).toContain("hi");
    capture.push(events[2]);
    const final = formatExpandedStream(capture.snapshotTail().entries);
    expect(final).toContain("hi!");
    expect(capture.snapshotTail().entries).toHaveLength(2);
  });
});