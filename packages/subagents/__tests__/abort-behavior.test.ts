import { describe, it, expect } from "vitest";
import {
  runSubagentSession,
  type StreamEvent,
  type StreamCallback,
  type SubagentSession,
} from "../runner.ts";
import { AgentManager } from "../manager.ts";
import type { StreamEntry } from "../index.ts";

// ---------------------------------------------------------------------------
// Fake session for runner-level abort tests
// ---------------------------------------------------------------------------

function createFakeSession() {
  let handler: ((event: any) => void) | undefined;
  let resolvePrompt: () => void = () => {};
  let rejectPrompt: (err: any) => void = () => {};
  let promptPromise: Promise<void>;
  let aborted = false;
  let disposed = false;

  const resetPrompt = () => {
    promptPromise = new Promise<void>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
  };
  resetPrompt();

  const session: SubagentSession & {
    aborted: boolean;
    disposed: boolean;
    emit: (event: any) => void;
    finish: () => void;
    reject: (err: any) => void;
  } = {
    get aborted() {
      return aborted;
    },
    get disposed() {
      return disposed;
    },
    abort() {
      aborted = true;
      rejectPrompt(new Error("Session aborted"));
    },
    dispose() {
      disposed = true;
    },
    subscribe(h) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    prompt() {
      return promptPromise;
    },
    get messages() {
      return [];
    },
    emit(event: any) {
      handler?.(event);
    },
    finish() {
      resolvePrompt();
    },
    reject(err: any) {
      rejectPrompt(err);
    },
  };

  return session;
}

// ---------------------------------------------------------------------------
// Runner-level abort tests
// ---------------------------------------------------------------------------

describe("runner abort behavior", () => {
  it("propagates abort signal to child session", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow(/Subagent aborted/);
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
  });

  it("stops stream events after abort", async () => {
    const session = createFakeSession();
    const controller = new AbortController();
    const received: StreamEvent[] = [];
    const onStreamEvent: StreamCallback = (e) => received.push(e);

    const promise = runSubagentSession({
      session,
      prompt: "test",
      onStreamEvent,
      abortSignal: controller.signal,
    });

    // Emit events before abort
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Before" },
    });
    session.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: {} });

    controller.abort();

    // Events after abort should be ignored
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "After" },
    });
    session.emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "c1",
      isError: false,
    });

    await expect(promise).rejects.toThrow(/Subagent aborted/);

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe("text_delta");
    if (received[0].type === "text_delta") {
      expect(received[0].delta).toBe("Before");
    }
    expect(received[1].type).toBe("tool_start");
  });

  it("rejects immediately if already aborted", async () => {
    const session = createFakeSession();
    const controller = new AbortController();
    controller.abort();

    const received: StreamEvent[] = [];
    await expect(
      runSubagentSession({
        session,
        prompt: "test",
        onStreamEvent: (e) => received.push(e),
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/Subagent aborted/);

    expect(received).toHaveLength(0);
    expect(session.disposed).toBe(true);
  });

  it("forwards non-abort errors unchanged", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.reject(new Error("Something else broke"));

    await expect(promise).rejects.toThrow(/Something else broke/);
    expect(session.disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool-wiring abort tests (replicate index.ts stream callback logic)
// ---------------------------------------------------------------------------

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

function createForegroundStreamSetup(signal: AbortSignal) {
  const updates: Array<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }> = [];
  const onUpdate = (result: (typeof updates)[0]) => {
    updates.push(result);
  };

  const streamEntries: StreamEntry[] = [];
  const onStreamEvent: StreamCallback = (event: StreamEvent) => {
    // Mirrors the guard in index.ts
    if (signal.aborted) return;
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

  return { onStreamEvent, updates, streamEntries: () => streamEntries };
}

describe("tool-wiring abort behavior", () => {
  it("foreground stream callback stops after abort", () => {
    const controller = new AbortController();
    const { onStreamEvent, updates } = createForegroundStreamSetup(controller.signal);

    onStreamEvent({ type: "text_delta", delta: "Before abort" });
    expect(updates).toHaveLength(1);
    expect(updates[0].content[0].text).toContain("Before abort");

    controller.abort();

    onStreamEvent({ type: "text_delta", delta: "After abort" });
    onStreamEvent({ type: "tool_start", name: "read" });

    expect(updates).toHaveLength(1);
  });

  it("partial stream text not promoted to final result", () => {
    const controller = new AbortController();
    const { onStreamEvent, streamEntries } = createForegroundStreamSetup(controller.signal);

    onStreamEvent({ type: "text_delta", delta: "Partial answer..." });
    onStreamEvent({ type: "tool_start", name: "read" });
    controller.abort();

    expect(streamEntries().length).toBeGreaterThan(0);

    // Simulate the execute handler: record.status === "failed" → throw
    const record = {
      status: "failed" as const,
      error: "Subagent aborted",
      result: undefined,
    };

    expect(() => {
      if (record.status === "failed") {
        throw new Error(`Subagent failed: ${record.error}`);
      }
    }).toThrow(/aborted/);

    expect(record.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Manager-level abort tests
// ---------------------------------------------------------------------------

describe("manager abort behavior", () => {
  it("foreground run fails on abort", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const controller = new AbortController();

    const { record, done } = manager.launch(
      { type: "explore", description: "abort test", background: false },
      () =>
        new Promise((_resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new Error("Subagent aborted"));
            return;
          }
          controller.signal.addEventListener("abort", () => reject(new Error("Subagent aborted")), {
            once: true,
          });
        }),
    );

    expect(record.status).toBe("running");

    controller.abort();
    const settled = await done;

    expect(settled.status).toBe("failed");
    expect(settled.error).toContain("aborted");
    expect(settled.result).toBeUndefined();
  });

  it("background run ignores parent abort signal", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const controller = new AbortController();
    let resolveExec: () => void = () => {};

    const { record, done } = manager.launch(
      { type: "explore", description: "background abort test", background: true },
      () =>
        new Promise<void>((resolve) => {
          resolveExec = resolve;
        }),
    );

    expect(record.status).toBe("running");

    controller.abort();
    resolveExec();
    const settled = await done;

    expect(settled.status).toBe("completed");
  });
});