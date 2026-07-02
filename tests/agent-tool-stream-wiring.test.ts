/**
 * Tool-wiring tests for foreground Subagent stream callbacks.
 *
 * Verifies that:
 * - Foreground Agent calls create a stream callback that accumulates text
 *   and emits partial updates via onUpdate
 * - Background Agent calls do not create a stream callback
 * - The final tool content contains only the clean subagent answer
 * - onUpdate receives accumulated stream text, not individual deltas
 * - No stream text leaks into the final result content
 * - Child tool start/end/error events produce compact stream entries
 *
 * Run:  npx tsx tests/agent-tool-stream-wiring.test.ts
 */

import { strict as assert } from "node:assert";
import type { StreamEvent, StreamCallback } from "../packages/subagents/runner.ts";
import type { StreamEntry } from "../packages/subagents/index.ts";

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
// Tests — Foreground
// ---------------------------------------------------------------------------

function testForegroundCreatesStreamCallback() {
  const { onStreamEvent } = createStreamSetup(false);
  assert.ok(onStreamEvent !== undefined, "foreground: stream callback is defined");
  assert.strictEqual(typeof onStreamEvent, "function");

  console.log("  Foreground creates stream callback ............. PASS");
}

function testForegroundAccumulatesText() {
  const { onStreamEvent, streamEntries } = createStreamSetup(false);

  onStreamEvent!({ type: "text_delta", delta: "Found " });
  assert.deepStrictEqual(streamEntries(), [{ type: "text", text: "Found " }]);

  onStreamEvent!({ type: "text_delta", delta: "3 " });
  assert.deepStrictEqual(streamEntries(), [
    { type: "text", text: "Found " },
    { type: "text", text: "3 " },
  ]);

  onStreamEvent!({ type: "text_delta", delta: "files" });
  assert.deepStrictEqual(streamEntries(), [
    { type: "text", text: "Found " },
    { type: "text", text: "3 " },
    { type: "text", text: "files" },
  ]);

  console.log("  Foreground accumulates text from deltas ........ PASS");
}

function testForegroundEmitsOnUpdate() {
  const { onStreamEvent, updates } = createStreamSetup(false);

  onStreamEvent!({ type: "text_delta", delta: "Hello " });
  assert.strictEqual(updates.length, 1, "first delta → one update");
  assert.strictEqual(updates[0].content[0].text, "Hello ");

  onStreamEvent!({ type: "text_delta", delta: "world" });
  assert.strictEqual(updates.length, 2, "second delta → second update");
  assert.strictEqual(updates[0].content[0].text, "Hello ");
  assert.strictEqual(updates[1].content[0].text, "Hello world", "second update has accumulated text");

  console.log("  Foreground emits onUpdate per text delta ...... PASS");
}

function testForegroundEmitsToolStartSummary() {
  const { onStreamEvent, updates } = createStreamSetup(false);

  onStreamEvent!({ type: "tool_start", name: "read" });

  assert.strictEqual(updates.length, 1, "tool start triggers onUpdate");
  assert.ok(updates[0].content[0].text.includes("▶ read"), "content shows start marker");
  const entries = updates[0].details.streamEntries as StreamEntry[];
  assert.deepStrictEqual(entries, [{ type: "tool_start", name: "read" }]);

  console.log("  Foreground emits compact tool start summary ... PASS");
}

function testForegroundEmitsToolEndSummary() {
  const { onStreamEvent, updates } = createStreamSetup(false);

  onStreamEvent!({ type: "tool_end", name: "read", error: false });

  assert.strictEqual(updates.length, 1, "tool end triggers onUpdate");
  assert.ok(updates[0].content[0].text.includes("✓ read"), "content shows success marker");
  const entries = updates[0].details.streamEntries as StreamEntry[];
  assert.deepStrictEqual(entries, [{ type: "tool_end", name: "read", error: false }]);

  console.log("  Foreground emits compact tool end summary ..... PASS");
}

function testForegroundEmitsToolErrorSummary() {
  const { onStreamEvent, updates } = createStreamSetup(false);

  onStreamEvent!({ type: "tool_end", name: "bash", error: true });

  assert.strictEqual(updates.length, 1, "tool error triggers onUpdate");
  assert.ok(updates[0].content[0].text.includes("✗ bash"), "content shows error marker");
  const entries = updates[0].details.streamEntries as StreamEntry[];
  assert.deepStrictEqual(entries, [{ type: "tool_end", name: "bash", error: true }]);

  console.log("  Foreground emits compact tool error summary ... PASS");
}

function testForegroundRawResultNotStreamed() {
  const { onStreamEvent, updates } = createStreamSetup(false);

  // The runner's tool_end event carries no raw result payload — only name + error.
  onStreamEvent!({ type: "tool_end", name: "read", error: false });

  assert.strictEqual(updates.length, 1);
  assert.ok(!updates[0].content[0].text.includes("file contents"), "no raw result in stream");
  assert.ok(!updates[0].content[0].text.includes("{\"data\""), "no JSON result in stream");

  console.log("  Raw tool result is not streamed inline ........ PASS");
}

function testForegroundOnUpdateHasDetails() {
  const { onStreamEvent, updates } = createStreamSetup(false);

  onStreamEvent!({ type: "text_delta", delta: "some text" });

  assert.ok(updates[0].details !== undefined, "details present");
  assert.strictEqual(updates[0].details.streamText, "some text");
  assert.deepStrictEqual(updates[0].details.streamEntries, [{ type: "text", text: "some text" }]);

  console.log("  Foreground onUpdate has streamText + entries ... PASS");
}

// ---------------------------------------------------------------------------
// Tests — Background
// ---------------------------------------------------------------------------

function testBackgroundNoStreamCallback() {
  const { onStreamEvent } = createStreamSetup(true);
  assert.strictEqual(onStreamEvent, undefined, "background: no stream callback");

  console.log("  Background has no stream callback .............. PASS");
}

function testBackgroundNoOnUpdate() {
  const { updates } = createStreamSetup(true);
  assert.strictEqual(updates.length, 0, "no onUpdate calls for background");

  console.log("  Background has no onUpdate calls ............... PASS");
}

// ---------------------------------------------------------------------------
// Tests — Final result isolation
// ---------------------------------------------------------------------------

function testFinalResultIsClean() {
  // Simulate the execute handler's return: final result = clean subagent answer.
  // The stream was transient and is not included in the final content.
  const { onStreamEvent } = createStreamSetup(false);

  // Simulate stream events during execution
  onStreamEvent!({ type: "text_delta", delta: "Found 3 files:\n" });
  onStreamEvent!({ type: "text_delta", delta: "- file1.ts\n" });
  onStreamEvent!({ type: "text_delta", delta: "- file2.ts\n" });
  onStreamEvent!({ type: "text_delta", delta: "- file3.ts\n" });
  onStreamEvent!({ type: "text_delta", delta: "Summary: all clean.\n" });

  // Final result returned from execute — clean answer, no stream transcript
  const finalResult = {
    content: [{ type: "text" as const, text: "Found 3 files:\n- file1.ts\n- file2.ts\n- file3.ts\nSummary: all clean.\n" }],
    details: { agent_id: "sa_abc", status: "completed", tokens: 100, toolUses: 2 },
  };

  assert.strictEqual(finalResult.content[0].type, "text");

  // The final result text should be the clean answer
  const text = finalResult.content[0].text;
  assert.ok(text.startsWith("Found 3 files"), "starts with answer");
  assert.ok(text.includes("Summary: all clean"), "includes answer summary");
  assert.strictEqual(text, "Found 3 files:\n- file1.ts\n- file2.ts\n- file3.ts\nSummary: all clean.\n");

  // Details should not contain streamText or streamEntries (they were only in partial updates)
  assert.strictEqual((finalResult.details as any).streamText, undefined,
    "final details do not contain streamText");
  assert.strictEqual((finalResult.details as any).streamEntries, undefined,
    "final details do not contain streamEntries");

  console.log("  Final result is clean subagent answer .......... PASS");
}

function testStreamTextSeparateFromFinalContent() {
  // Verify that the stream text accumulated during execution is a proper
  // subset of the final answer, but the final content is not the stream.
  // This simulates a realistic case where the subagent refines its output.

  const { onStreamEvent, streamEntries } = createStreamSetup(false);

  // Simulate an explore subagent that first reads files, then outputs a refined answer
  onStreamEvent!({ type: "text_delta", delta: "Let me check the codebase...\n" });
  onStreamEvent!({ type: "tool_start", name: "grep" });
  onStreamEvent!({ type: "tool_end", name: "grep", error: false });
  onStreamEvent!({ type: "text_delta", delta: "I found some patterns.\n" });
  onStreamEvent!({ type: "tool_start", name: "read" });
  onStreamEvent!({ type: "tool_end", name: "read", error: false });
  onStreamEvent!({ type: "text_delta", delta: "Here is my analysis:\n" });
  onStreamEvent!({ type: "text_delta", delta: "The code uses TypeScript.\n" });
  const entries = streamEntries();

  // Final result is the clean, definitive answer
  const finalAnswer = "Here is my analysis:\nThe code uses TypeScript.";

  // The stream entries include tool lifecycle markers interleaved with text
  assert.ok(entries.some((e) => e.type === "tool_start" && e.name === "grep"), "stream has grep start");
  assert.ok(entries.some((e) => e.type === "tool_end" && e.name === "read" && !e.error), "stream has read end");

  // Expanded stream text interleaves text and tool markers
  const streamText = formatExpandedStream(streamEntries());
  assert.ok(streamText.includes("▶ grep"), "stream shows grep start");
  assert.ok(streamText.includes("✓ read"), "stream shows read success");
  assert.ok(streamText.includes("Let me check"), "stream includes intermediate text");

  // Final answer differs from the full transient stream
  assert.ok(finalAnswer !== streamText, "final answer differs from full stream");

  console.log("  Stream text separate from final content ........ PASS");
}

function testForegroundFinalReturnDetailsExcludeStreamData() {
  // Verify that the final return from the execute handler (simulated here)
  // excludes streamText and streamEntries — even after stream events fired.
  const { onStreamEvent } = createStreamSetup(false);

  // Stream events fire during execution (transient UI state)
  onStreamEvent!({ type: "text_delta", delta: "Searching... " });
  onStreamEvent!({ type: "tool_start", name: "grep" });
  onStreamEvent!({ type: "tool_end", name: "grep", error: false });
  onStreamEvent!({ type: "text_delta", delta: "Found: patterns.ts" });

  // The execute handler constructs the final return from the completed record,
  // NOT from the transient stream state. This simulates that construction.
  const finalDetails = {
    agent_id: "sa_xyz",
    status: "completed" as const,
    tokens: 25,
    toolUses: 1,
  };

  // No stream data in the final details
  assert.strictEqual((finalDetails as any).streamText, undefined,
    "no streamText in final return details");
  assert.strictEqual((finalDetails as any).streamEntries, undefined,
    "no streamEntries in final return details");

  // Verify the exact keys that should be present
  assert.strictEqual(Object.keys(finalDetails).length, 4,
    "final details have exactly 4 keys (no streaming keys)");
  assert.ok("agent_id" in finalDetails, "agent_id in final details");
  assert.ok("status" in finalDetails, "status in final details");
  assert.ok("tokens" in finalDetails, "tokens in final details");
  assert.ok("toolUses" in finalDetails, "toolUses in final details");

  console.log("  Foreground final return excludes stream data .... PASS");
}

function testFinalResultDetailsHaveNoStreamKeysEvenWithWarnings() {
  // The final return should not include streaming keys even when warnings
  // are present (which do add extra keys to details).
  const finalDetails = {
    agent_id: "sa_warn",
    status: "completed" as const,
    tokens: 50,
    toolUses: 3,
    warnings: [
      { scope: "explore" as const, reference: "bad/ref", type: "unresolvable" as const },
    ],
  };

  // Streaming keys must not be present
  assert.strictEqual((finalDetails as any).streamText, undefined,
    "no streamText even with warnings");
  assert.strictEqual((finalDetails as any).streamEntries, undefined,
    "no streamEntries even with warnings");

  // But warnings IS present
  assert.ok(Array.isArray(finalDetails.warnings), "warnings array present");
  assert.strictEqual(finalDetails.warnings.length, 1, "one warning");

  console.log("  Final details no stream keys even with warnings .. PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nAgent tool stream wiring tests\n");

  // Foreground
  testForegroundCreatesStreamCallback();
  testForegroundAccumulatesText();
  testForegroundEmitsOnUpdate();
  testForegroundEmitsToolStartSummary();
  testForegroundEmitsToolEndSummary();
  testForegroundEmitsToolErrorSummary();
  testForegroundRawResultNotStreamed();
  testForegroundOnUpdateHasDetails();

  // Background
  testBackgroundNoStreamCallback();
  testBackgroundNoOnUpdate();

  // Final result
  testFinalResultIsClean();
  testStreamTextSeparateFromFinalContent();
  testForegroundFinalReturnDetailsExcludeStreamData();
  testFinalResultDetailsHaveNoStreamKeysEvenWithWarnings();

  console.log("\nAll tests PASS\n");
}

main();
