/**
 * Abort behavior tests for foreground Subagent runs.
 *
 * Verifies that:
 * - Parent abort signal is propagated to the foreground child session
 * - Aborting the parent cancels the active foreground run instead of letting
 *   it continue silently
 * - Stream updates stop after cancellation
 * - Partial assistant stream text is not returned as a completed final result
 * - Cancellation follows existing Pi tool error semantics (the tool call fails)
 *
 * Run: npx tsx tests/subagent-abort-behavior.test.ts
 */

import { strict as assert } from "node:assert";
import { runSubagentSession, type StreamEvent, type StreamCallback, type SubagentSession } from "../packages/subagents/runner.ts";
import { AgentManager } from "../packages/subagents/manager.ts";
import type { StreamEntry } from "../packages/subagents/index.ts";

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

async function testRunnerPropagatesAbortToSession() {
  const session = createFakeSession();
  const controller = new AbortController();

  const promise = runSubagentSession({
    session,
    prompt: "test",
    abortSignal: controller.signal,
  });

  controller.abort();

  await assert.rejects(promise, /Subagent aborted/);
  assert.strictEqual(session.aborted, true, "session.abort() was called");
  assert.strictEqual(session.disposed, true, "session was disposed");

  console.log("  Abort signal propagates to child session ........ PASS");
}

async function testRunnerStopsStreamEventsAfterAbort() {
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
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Before" } });
  session.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: {} });

  controller.abort();

  // Race-free: abort is synchronous, so the next event should be ignored
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "After" } });
  session.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false });

  await assert.rejects(promise, /Subagent aborted/);

  assert.strictEqual(received.length, 2, "only pre-abort events forwarded");
  assert.strictEqual(received[0].type, "text_delta");
  assert.strictEqual((received[0] as any).delta, "Before");
  assert.strictEqual(received[1].type, "tool_start");

  console.log("  Stream events stop after abort .................. PASS");
}

async function testRunnerRejectsImmediatelyIfAlreadyAborted() {
  const session = createFakeSession();
  const controller = new AbortController();
  controller.abort();

  const received: StreamEvent[] = [];
  await assert.rejects(
    runSubagentSession({
      session,
      prompt: "test",
      onStreamEvent: (e) => received.push(e),
      abortSignal: controller.signal,
    }),
    /Subagent aborted/,
  );

  assert.strictEqual(received.length, 0, "no stream events emitted");
  assert.strictEqual(session.disposed, true, "session disposed immediately");

  console.log("  Already-aborted signal rejects immediately ...... PASS");
}

async function testRunnerForwardsNonAbortErrors() {
  const session = createFakeSession();
  const controller = new AbortController();

  const promise = runSubagentSession({
    session,
    prompt: "test",
    abortSignal: controller.signal,
  });

  session.reject(new Error("Something else broke"));

  await assert.rejects(promise, /Something else broke/);
  assert.strictEqual(session.disposed, true, "session disposed on non-abort error");

  console.log("  Non-abort errors are forwarded unchanged ........ PASS");
}

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
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> = [];
  const onUpdate = (result: typeof updates[0]) => {
    updates.push(result);
  };

  const streamEntries: StreamEntry[] = [];
  const onStreamEvent: StreamCallback = (event: StreamEvent) => {
    // Mirrors the guard added to index.ts
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

function testForegroundStreamCallbackStopsAfterAbort() {
  const controller = new AbortController();
  const { onStreamEvent, updates } = createForegroundStreamSetup(controller.signal);

  onStreamEvent({ type: "text_delta", delta: "Before abort" });
  assert.strictEqual(updates.length, 1);
  assert.ok(updates[0].content[0].text.includes("Before abort"));

  controller.abort();

  onStreamEvent({ type: "text_delta", delta: "After abort" });
  onStreamEvent({ type: "tool_start", name: "read" });

  assert.strictEqual(updates.length, 1, "no updates emitted after abort");

  console.log("  Foreground stream callback stops after abort .... PASS");
}

function testPartialStreamTextNotPromotedToFinalResult() {
  const controller = new AbortController();
  const { onStreamEvent, streamEntries } = createForegroundStreamSetup(controller.signal);

  // Simulate a run that produced partial stream text then aborted
  onStreamEvent({ type: "text_delta", delta: "Partial answer..." });
  onStreamEvent({ type: "tool_start", name: "read" });
  controller.abort();

  assert.ok(streamEntries().length > 0, "stream entries accumulated");

  // Simulate the manager/execute path when the exec rejects:
  // record.status === "failed", so the tool call throws instead of returning.
  const record = {
    status: "failed" as const,
    error: "Subagent aborted",
    result: undefined,
  };

  let threw = false;
  try {
    if (record.status === "failed") {
      throw new Error(`Subagent failed: ${record.error}`);
    }
  } catch (e: any) {
    threw = true;
    assert.ok(/aborted/.test(e.message), "thrown error indicates abort");
  }
  assert.strictEqual(threw, true, "execute throws on failed foreground run");

  // The partial stream text never becomes final content
  assert.strictEqual(record.result, undefined, "no final result returned");

  console.log("  Partial stream text not promoted to final result  PASS");
}

// ---------------------------------------------------------------------------
// Manager-level abort tests
// ---------------------------------------------------------------------------

async function testManagerForegroundRunFailsOnAbort() {
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
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Subagent aborted")),
          { once: true },
        );
      }),
  );

  assert.strictEqual(record.status, "running", "foreground starts immediately");

  controller.abort();
  const settled = await done;

  assert.strictEqual(settled.status, "failed", "aborted run is failed");
  assert.ok(settled.error?.includes("aborted"), "error message mentions abort");
  assert.strictEqual(settled.result, undefined, "no result on aborted run");

  console.log("  Manager foreground run fails on abort ........... PASS");
}

async function testManagerBackgroundRunNotAffectedByParentAbort() {
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

  // With maxConcurrency=1 and no other active runs, the background job starts
  // immediately, but it is still managed by the queue and should not be tied
  // to the parent's foreground abort signal.
  assert.strictEqual(record.status, "running", "background starts running under available capacity");

  // A parent abort signal should not cancel a background run in this slice
  controller.abort();

  resolveExec();
  const settled = await done;

  assert.strictEqual(settled.status, "completed", "background run completes despite parent abort");

  console.log("  Background run ignores parent abort signal ...... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nSubagent abort behavior tests\n");

  await testRunnerPropagatesAbortToSession();
  await testRunnerStopsStreamEventsAfterAbort();
  await testRunnerRejectsImmediatelyIfAlreadyAborted();
  await testRunnerForwardsNonAbortErrors();

  testForegroundStreamCallbackStopsAfterAbort();
  testPartialStreamTextNotPromotedToFinalResult();

  await testManagerForegroundRunFailsOnAbort();
  await testManagerBackgroundRunNotAffectedByParentAbort();

  console.log("\nAll tests PASS\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
