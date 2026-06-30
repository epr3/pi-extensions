/**
 * Tests for todo_write current item output.
 *
 * Verifies that todo_write plain-text and details use the same current-item
 * result shape as todo_read.
 *
 * Run:  pnpm dlx tsx tests/todo-current-write-output.test.ts
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import todoExtension from "../packages/todo/index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
    on: () => {},
  } as unknown as ExtensionAPI;
}

function registerTodos(): { write: ToolDefinition; read: ToolDefinition } {
  const tools: ToolDefinition[] = [];
  todoExtension(makeFakeApi(tools));
  const write = tools.find((t) => t.name === "todo_write")!;
  const read = tools.find((t) => t.name === "todo_read")!;
  return { write, read };
}

function text(result: { content: { type: "text"; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------------------
// todo_write — single in_progress
// ---------------------------------------------------------------------------

async function testWriteSingleCurrentShowsCurrentLine() {
  const { write } = registerTodos();

  const result = await write.execute("tc", {
    todos: [
      { content: "Step A", status: "completed" },
      { content: "Step B", status: "in_progress" },
      { content: "Step C", status: "pending" },
    ],
  });

  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // Text has current line (same shape as read)
  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("Step B"), "Current line shows active item content");
  assert.ok(txt.includes("1/3 done"), "summary present");

  // No warning for single in_progress
  assert.ok(!txt.includes("warning"), "no warning for single in_progress");

  // Details contain current item info
  assert.strictEqual((det.currentItem as any)?.content, "Step B", "details currentItem correct");
  assert.strictEqual(det.currentIndex, 1, "details currentIndex correct");
  assert.ok(Array.isArray(det.items), "details has items array");

  console.log("  Write single current shows Current: line ......... PASS");
}

// ---------------------------------------------------------------------------
// todo_write — no in_progress
// ---------------------------------------------------------------------------

async function testWriteNoCurrentShowsNone() {
  const { write } = registerTodos();

  const result = await write.execute("tc", {
    todos: [
      { content: "Done", status: "completed" },
      { content: "Skipped", status: "completed" },
    ],
  });

  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("none"), 'shows "none" for no current item');
  assert.ok(!txt.includes("warning"), "no warning for zero in_progress");

  assert.strictEqual(det.currentItem, null, "details currentItem is null");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null");

  console.log("  Write no current shows 'none' .................... PASS");
}

// ---------------------------------------------------------------------------
// todo_write — multiple in_progress
// ---------------------------------------------------------------------------

async function testWriteMultiCurrentShowsMultipleWithWarning() {
  const { write } = registerTodos();

  const result = await write.execute("tc", {
    todos: [
      { content: "Active X", status: "in_progress" },
      { content: "Completed", status: "completed" },
      { content: "Active Y", status: "in_progress" },
    ],
  });

  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // Text has current line showing multiple
  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("multiple"), 'shows "multiple" indicator');

  // Warning still present for multiple in_progress
  assert.ok(txt.includes("warning"), "warning present for multiple in_progress");
  assert.ok(txt.includes("invalid workflow state"), "warning describes invalid state");
  assert.ok(txt.includes("2 items in_progress"), "warning counts active items");

  // Details
  assert.strictEqual(det.currentItem, null, "details currentItem is null for multi");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null for multi");
  assert.ok(Array.isArray(det.activeCandidates), "details has activeCandidates array");
  assert.strictEqual((det.activeCandidates as any[]).length, 2, "two active candidates");

  console.log("  Write multi current shows multiple + warning ..... PASS");
}

// ---------------------------------------------------------------------------
// todo_write — empty list
// ---------------------------------------------------------------------------

async function testWriteEmptyList() {
  const { write } = registerTodos();

  const result = await write.execute("tc", { todos: [] });

  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  assert.ok(txt.includes("Current:"), "text includes Current: line for empty");
  assert.ok(txt.includes("none"), 'shows "none" for empty list');
  assert.ok(txt.includes("(empty)"), "shows (empty) for empty checklist");

  assert.strictEqual(det.currentItem, null, "details currentItem is null for empty");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null for empty");

  console.log("  Write empty list shows 'none' .................... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\ntodo_write current-item output tests\n");
  await testWriteSingleCurrentShowsCurrentLine();
  await testWriteNoCurrentShowsNone();
  await testWriteMultiCurrentShowsMultipleWithWarning();
  await testWriteEmptyList();
  console.log("\nAll tests PASS\n");
}

main();
