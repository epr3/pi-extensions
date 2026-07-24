import { describe, it, expect } from "vitest";
import type { StreamEvent, StreamCallback } from "../runner.ts";

// ---------------------------------------------------------------------------
// Event mapping helper — replicates the subscribe handler from runner.ts
// without needing a real AgentSession.
// ---------------------------------------------------------------------------

interface FakeMessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent: {
    type: string;
    delta?: string;
  };
}

interface FakeToolStartEvent {
  type: "tool_execution_start";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

interface FakeToolEndEvent {
  type: "tool_execution_end";
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  result?: unknown;
}

type FakeSessionEvent = FakeMessageUpdateEvent | FakeToolStartEvent | FakeToolEndEvent;

function createEventHandler() {
  let toolUses = 0;
  const handle = (event: FakeSessionEvent, onStream: StreamCallback | undefined): number => {
    switch (event.type) {
      case "message_update": {
        const msg = event.assistantMessageEvent;
        if (msg?.type === "text_delta" && msg.delta) {
          onStream?.({ type: "text_delta", delta: msg.delta });
        }
        // thinking_delta deliberately ignored
        break;
      }
      case "tool_execution_start":
        onStream?.({ type: "tool_start", name: event.toolName });
        break;
      case "tool_execution_end":
        toolUses++;
        onStream?.({ type: "tool_end", name: event.toolName, error: event.isError });
        break;
    }
    return toolUses;
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamEvent mapping", () => {
  it("forwards text_delta events", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
      cb,
    );
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("text_delta");
    if (received[0].type === "text_delta") {
      expect(received[0].delta).toBe("Hello");
    }
  });

  it("forwards multiple text deltas in order", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
      cb,
    );
    handle(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " " } },
      cb,
    );
    handle(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world!" } },
      cb,
    );

    expect(received).toHaveLength(3);
    const text = received
      .filter((e): e is StreamEvent & { type: "text_delta" } => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello world!");
  });

  it("ignores thinking_delta events", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Let me think..." },
      },
      cb,
    );
    // Text delta after thinking should still come through
    handle(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Answer" } },
      cb,
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("text_delta");
  });

  it("forwards tool_start events", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "call1",
        args: { path: "test.ts" },
      },
      cb,
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("tool_start");
    if (received[0].type === "tool_start") {
      expect(received[0].name).toBe("read");
    }
  });

  it("forwards tool_end events", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      { type: "tool_execution_end", toolName: "read", toolCallId: "call1", isError: false },
      cb,
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("tool_end");
    if (received[0].type === "tool_end") {
      expect(received[0].name).toBe("read");
      expect(received[0].error).toBe(false);
    }
  });

  it("forwards tool_end with error flag", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      { type: "tool_execution_end", toolName: "bash", toolCallId: "call2", isError: true },
      cb,
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("tool_end");
    if (received[0].type === "tool_end") {
      expect(received[0].name).toBe("bash");
      expect(received[0].error).toBe(true);
    }
  });

  it("no stream callback: no crash, toolUses still counted", () => {
    const handle = createEventHandler();

    const tu1 = handle(
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "call1",
        args: { path: "test.ts" },
      },
      undefined,
    );
    expect(tu1).toBe(0);

    const tu2 = handle(
      { type: "tool_execution_end", toolName: "read", toolCallId: "call1", isError: false },
      undefined,
    );
    expect(tu2).toBe(1);
  });

  it("toolUses incremented on end, not start", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    const tu1 = handle(
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "call1",
        args: { path: "a.ts" },
      },
      cb,
    );
    expect(tu1).toBe(0);

    const tu2 = handle(
      { type: "tool_execution_end", toolName: "read", toolCallId: "call1", isError: false },
      cb,
    );
    expect(tu2).toBe(1);

    const tu3 = handle(
      { type: "tool_execution_end", toolName: "grep", toolCallId: "call2", isError: false },
      cb,
    );
    expect(tu3).toBe(2);
  });

  it("empty text delta ignored", () => {
    const received: StreamEvent[] = [];
    const cb: StreamCallback = (e) => received.push(e);
    const handle = createEventHandler();

    handle(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } },
      cb,
    );
    expect(received).toHaveLength(0);

    // undefined delta also ignored
    handle({ type: "message_update", assistantMessageEvent: { type: "text_delta" } as any }, cb);
    expect(received).toHaveLength(0);
  });
});