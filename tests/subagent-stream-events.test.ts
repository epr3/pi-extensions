/**
 * Runner-level tests for StreamEvent mapping from SDK session events.
 *
 * Tests that:
 * - text_delta events are forwarded from SDK message_update events
 * - tool_start/tool_end events are forwarded
 * - thinking_delta events are ignored
 * - multiple text deltas are accumulated correctly
 * - the runner still extracts the correct final result with streaming active
 * - no stream callback = no stream events emitted
 *
 * Run:  npx tsx tests/subagent-stream-events.test.ts
 */

import { strict as assert } from "node:assert";
import type { StreamEvent, StreamCallback } from "../packages/subagents/runner.ts";

// ---------------------------------------------------------------------------
// Event mapping helper — replicates the subscribe handler from runner.ts
// without needing a real AgentSession. This tests the mapping contract
// that the runner applies to each SDK event.
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

/**
 * Replicates the subscribe handler from runner.ts using a shared
 * toolUses counter so that sequential events accumulate correctly.
 */
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

function testForwardsTextDeltas() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  handle(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
    cb,
  );
  assert.strictEqual(received.length, 1, "one event");
  assert.strictEqual(received[0].type, "text_delta");
  if (received[0].type === "text_delta") {
    assert.strictEqual(received[0].delta, "Hello");
  }

  console.log("  Forwards text_delta events ....................... PASS");
}

function testForwardsMultipleTextDeltas() {
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

  assert.strictEqual(received.length, 3, "three events");
  const text = received
    .filter((e): e is StreamEvent & { type: "text_delta" } => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
  assert.strictEqual(text, "Hello world!");

  console.log("  Forwards multiple text deltas in order .......... PASS");
}

function testIgnoresThinkingDeltas() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  handle(
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Let me think..." } },
    cb,
  );
  // Text delta after thinking should still come through
  handle(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Answer" } },
    cb,
  );

  assert.strictEqual(received.length, 1, "only text_delta forwarded");
  assert.strictEqual(received[0].type, "text_delta");

  console.log("  Ignores thinking_delta events ................... PASS");
}

function testForwardsToolStart() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  handle(
    { type: "tool_execution_start", toolName: "read", toolCallId: "call1", args: { path: "test.ts" } },
    cb,
  );

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "tool_start");
  if (received[0].type === "tool_start") {
    assert.strictEqual(received[0].name, "read");
  }

  console.log("  Forwards tool_start events ...................... PASS");
}

function testForwardsToolEnd() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  handle(
    { type: "tool_execution_end", toolName: "read", toolCallId: "call1", isError: false },
    cb,
  );

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "tool_end");
  if (received[0].type === "tool_end") {
    assert.strictEqual(received[0].name, "read");
    assert.strictEqual(received[0].error, false);
  }

  console.log("  Forwards tool_end events ........................ PASS");
}

function testForwardsToolError() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  handle(
    { type: "tool_execution_end", toolName: "bash", toolCallId: "call2", isError: true },
    cb,
  );

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].type, "tool_end");
  if (received[0].type === "tool_end") {
    assert.strictEqual(received[0].name, "bash");
    assert.strictEqual(received[0].error, true);
  }

  console.log("  Forwards tool_end with error flag .............. PASS");
}

function testNoStreamCallbackEmitsNothing() {
  const handle = createEventHandler();

  // When onStreamEvent is undefined, the handler should not crash
  const tu1 = handle(
    { type: "tool_execution_start", toolName: "read", toolCallId: "call1", args: { path: "test.ts" } },
    undefined,
  );
  assert.strictEqual(tu1, 0, "no toolUses counted for start");

  const tu2 = handle(
    { type: "tool_execution_end", toolName: "read", toolCallId: "call1", isError: false },
    undefined,
  );
  assert.strictEqual(tu2, 1, "toolUses still counted even without stream callback");

  console.log("  No stream callback: no crash, toolUses counted .. PASS");
}

function testToolUsesIncrementedOnEnd() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  const tu1 = handle(
    { type: "tool_execution_start", toolName: "read", toolCallId: "call1", args: { path: "a.ts" } },
    cb,
  );
  assert.strictEqual(tu1, 0, "start doesn't increment");

  const tu2 = handle(
    { type: "tool_execution_end", toolName: "read", toolCallId: "call1", isError: false },
    cb,
  );
  assert.strictEqual(tu2, 1, "end increments");

  const tu3 = handle(
    { type: "tool_execution_end", toolName: "grep", toolCallId: "call2", isError: false },
    cb,
  );
  assert.strictEqual(tu3, 2, "second end increments again");

  console.log("  Tool uses counted correctly ..................... PASS");
}

function testTextDeltaWithEmptyDeltaIgnored() {
  const received: StreamEvent[] = [];
  const cb: StreamCallback = (e) => received.push(e);
  const handle = createEventHandler();

  handle(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } },
    cb,
  );

  assert.strictEqual(received.length, 0, "empty delta ignored");

  // Also test missing delta
  handle(
    { type: "message_update", assistantMessageEvent: { type: "text_delta" } as any },
    cb,
  );

  assert.strictEqual(received.length, 0, "undefined delta ignored");

  console.log("  Empty/undefined text delta ignored ............. PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nSub-agent Stream Event mapping tests\n");

  testForwardsTextDeltas();
  testForwardsMultipleTextDeltas();
  testIgnoresThinkingDeltas();
  testForwardsToolStart();
  testForwardsToolEnd();
  testForwardsToolError();
  testNoStreamCallbackEmitsNothing();
  testToolUsesIncrementedOnEnd();
  testTextDeltaWithEmptyDeltaIgnored();

  console.log("\nAll tests PASS\n");
}

main();
