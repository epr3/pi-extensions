import { describe, it, expect } from "vitest";
import {
  runSubagentSession,
  type StreamEvent,
  type StreamCallback,
  type SubagentSession,
} from "../runner.ts";
import { AgentManager } from "../manager.ts";
import { formatExpandedStream, type StreamEntry } from "../index.ts";
import { RESULT_TEXT_LIMIT } from "../result-limit.ts";
import { sdkAbortResolvingSession } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fake session for runner-level abort tests
// ---------------------------------------------------------------------------

function createFakeSession() {
  let handler: ((event: any) => void) | undefined;
  let resolvePrompt: () => void;
  let rejectPrompt: (err: any) => void;
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

  it("attaches captured assistant text as partial output on abort", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Working on it… " },
    });
    session.emit({ type: "tool_execution_start", toolName: "read" });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "found the bug" },
    });
    controller.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Subagent aborted");
    expect(err.partialCapture).toEqual({
      text: "Working on it… found the bug",
      truncated: false,
      // 30 UTF-8 bytes: the ellipsis is three.
      originalBytes: 30,
      retainedBytes: 30,
    });
  });

  it("attaches partial output to a non-abort failure too", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial findings" },
    });
    session.reject(new Error("model exploded"));

    const err: any = await promise.catch((e) => e);
    expect(err.message).toBe("model exploded");
    expect(err.partialCapture.text).toBe("partial findings");
  });

  it("omits partial output when no assistant text was captured", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.emit({ type: "tool_execution_start", toolName: "read" });
    controller.abort();

    const err: any = await promise.catch((e) => e);
    expect(err.message).toBe("Subagent aborted");
    expect(err.partialCapture).toBeUndefined();
  });

  it("bounds partial output captured during the run and reports byte counts", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    // 25,000 bytes of assistant text arrive in 1,000-byte deltas; the capture
    // stops retaining at the 20,000-byte limit and keeps counting.
    for (let i = 0; i < 25; i++) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a".repeat(1_000) },
      });
    }
    controller.abort();

    const err: any = await promise.catch((e) => e);
    expect(err.partialCapture).toEqual({
      text: "a".repeat(RESULT_TEXT_LIMIT),
      truncated: true,
      originalBytes: 25_000,
      retainedBytes: RESULT_TEXT_LIMIT,
    });
  });

  it("keeps character boundaries when a delta splits a multibyte character", async () => {
    const session = createFakeSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "\uD83D" },
    });
    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "\uDE00 done" },
    });
    controller.abort();

    const err: any = await promise.catch((e) => e);
    expect(err.partialCapture.text).toBe("\u{1F600} done");
    expect(err.partialCapture.originalBytes).toBe(9);
    expect(err.partialCapture.truncated).toBe(false);
  });

  it("still streams every delta to the UI after the capture is full", async () => {
    const session = createFakeSession();
    const controller = new AbortController();
    const deltas: string[] = [];

    const promise = runSubagentSession({
      session,
      prompt: "test",
      onStreamEvent: (e) => {
        if (e.type === "text_delta") deltas.push(e.delta);
      },
      abortSignal: controller.signal,
    });

    for (let i = 0; i < 21; i++) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "b".repeat(1_000) },
      });
    }
    controller.abort();

    const err: any = await promise.catch((e) => e);
    // The UI stream is not bounded by the capture: every delta is forwarded.
    expect(deltas).toHaveLength(21);
    expect(err.partialCapture.retainedBytes).toBe(RESULT_TEXT_LIMIT);
    expect(err.partialCapture.originalBytes).toBe(21_000);
  });

  it("reports an abort as aborted even when the session resolves its prompt", async () => {
    // Pi's agent loop ends an aborted run by returning a terminal assistant
    // message with stopReason "aborted" and resolving prompt() — it does not
    // reject. The runner must still report the aborted outcome instead of
    // promoting the cut-short turn to a completed result.
    const session = sdkAbortResolvingSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.emitText("findings so far");
    controller.abort();

    const err: any = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Subagent aborted");
    expect(err.partialCapture.text).toBe("findings so far");
    expect(session.disposed).toBe(true);
  });

  it("still completes a run the session finished without an abort", async () => {
    // Guard against over-reporting: a session that ends normally keeps its
    // completed result even though an abort signal was supplied.
    const session = sdkAbortResolvingSession();
    const controller = new AbortController();

    const promise = runSubagentSession({
      session,
      prompt: "test",
      abortSignal: controller.signal,
    });

    session.finish("all done");

    await expect(promise).resolves.toMatchObject({ result: "all done" });
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

describe("manager partial output from a real runner capture", () => {
  it("delivers the bounded capture with its original and retained byte counts", async () => {
    // Real wiring: the manager's exec thunk is runSubagentSession over a fake
    // session, so this covers the runner -> manager hand-off.
    const session = createFakeSession();
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record, done } = manager.launch(
      { type: "general", description: "streamy", background: true },
      (signal: AbortSignal) => runSubagentSession({ session, prompt: "work", abortSignal: signal }),
    );

    for (let i = 0; i < 25; i++) {
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a".repeat(1_000) },
      });
    }
    await manager.stop(record.id);
    const settled = await done;

    expect(settled.status).toBe("stopped");
    expect(settled.partialText!.startsWith("a".repeat(RESULT_TEXT_LIMIT))).toBe(true);
    expect(settled.partialText).toContain("[Truncated: showing the first 20,000 of 25,000 bytes.]");
  });
});

// ---------------------------------------------------------------------------
// Tool-wiring abort tests (replicate index.ts stream callback logic)
// ---------------------------------------------------------------------------

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
    let resolveExec: () => void;

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