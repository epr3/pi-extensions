/**
 * Tests for todo_read current item output.
 *
 * Verifies that todo_read plain-text and details include the current item line.
 *
 * Run:  pnpm dlx tsx tests/todo-current-read-output.test.ts
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
// todo_read — single in_progress
// ---------------------------------------------------------------------------

async function testReadSingleCurrentShowsCurrentLine() {
  const { write, read } = registerTodos();

  // Write a list with one in_progress
  await write.execute("tc", {
    todos: [
      { content: "Setup env", status: "completed" },
      { content: "Implement feature", status: "in_progress" },
      { content: "Write tests", status: "pending" },
    ],
  });

  const result = await read.execute();
  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // Text contains current line
  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("Implement feature"), "Current line shows active item content");
  assert.ok(txt.includes("1/3 done"), "summary present");
  assert.ok(txt.includes("Setup env"), "full checklist present");
  assert.ok(txt.includes("Write tests"), "full checklist present");

  // Details contain current item info
  assert.strictEqual((det.currentItem as any)?.content, "Implement feature", "details currentItem correct");
  assert.strictEqual(det.currentIndex, 1, "details currentIndex correct");
  assert.ok(Array.isArray(det.items), "details has items array");
  assert.strictEqual((det.items as any[]).length, 3, "details has all items");

  console.log("  Read single current shows Current: line .......... PASS");
}

// ---------------------------------------------------------------------------
// todo_read — no in_progress
// ---------------------------------------------------------------------------

async function testReadNoCurrentShowsNone() {
  const { write, read } = registerTodos();

  await write.execute("tc", {
    todos: [
      { content: "Task A", status: "completed" },
      { content: "Task B", status: "pending" },
    ],
  });

  const result = await read.execute();
  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("none"), 'shows "none" for no current item');
  assert.ok(!txt.includes("warning"), "no warning for zero in_progress");

  assert.strictEqual(det.currentItem, null, "details currentItem is null");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null");

  console.log("  Read no current shows 'none' ..................... PASS");
}

// ---------------------------------------------------------------------------
// todo_read — multiple in_progress
// ---------------------------------------------------------------------------

async function testReadMultiCurrentShowsMultiple() {
  const { write, read } = registerTodos();

  await write.execute("tc", {
    todos: [
      { content: "Active A", status: "in_progress" },
      { content: "Completed", status: "completed" },
      { content: "Active B", status: "in_progress" },
    ],
  });

  const result = await read.execute();
  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("multiple"), 'shows "multiple" indicator');
  assert.ok(!txt.includes("warning"), "read should not have warning text");

  assert.strictEqual(det.currentItem, null, "details currentItem is null for multi");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null for multi");
  assert.ok(Array.isArray(det.activeCandidates), "details has activeCandidates array");
  assert.strictEqual((det.activeCandidates as any[]).length, 2, "two active candidates");

  console.log("  Read multi current shows multiple ................ PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\ntodo_read current-item output tests\n");
  await testReadSingleCurrentShowsCurrentLine();
  await testReadNoCurrentShowsNone();
  await testReadMultiCurrentShowsMultiple();
  console.log("\nAll tests PASS\n");
}

main();
