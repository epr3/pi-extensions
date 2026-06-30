/**
 * Todo tool contract tests.
 *
 * Verifies metadata and the warning-level handling of multiple in_progress items.
 *
 * Run: node_modules/.pnpm/node_modules/.bin/tsx tests/todo-contract.test.ts
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import todoExtension from "../packages/todo/index.ts";
import type { CurrentItemResult, Item } from "../packages/todo/index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
    on: () => {},
  } as unknown as ExtensionAPI;
}

function registerTodos(): { write: ToolDefinition; read: ToolDefinition } {
  const tools: ToolDefinition[] = [];
  todoExtension(makeFakeApi(tools));
  assert.strictEqual(tools.length, 2, "todo registers two tools");
  const write = tools.find((t) => t.name === "todo_write")!;
  const read = tools.find((t) => t.name === "todo_read")!;
  return { write, read };
}

function text(result: { content: { type: "text"; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

function testToolNamesAndLabels() {
  const { write, read } = registerTodos();
  assert.strictEqual(write.name, "todo_write", "write tool name stable");
  assert.strictEqual(write.label, "Write Todos", "write label stable");
  assert.strictEqual(read.name, "todo_read", "read tool name stable");
  assert.strictEqual(read.label, "Read Todos", "read label stable");
  console.log("  Tool names and labels stable ...................... PASS");
}

function testDescriptionsMentionChecklistAndWorkflow() {
  const { write } = registerTodos();
  assert.ok(
    write.description.includes("break an issue into steps"),
    "write description mentions step breakdown",
  );
  assert.ok(
    write.description.includes("vertical slices"),
    "write description mentions vertical slices",
  );
  assert.ok(
    write.description.includes("exactly one"),
    "write description mentions exactly one in_progress",
  );
  console.log("  Descriptions mention checklist and workflow ....... PASS");
}

async function testMultipleInProgressSurfacesWarning() {
  const { write } = registerTodos();
  const result = await write.execute("tc", {
    todos: [
      { content: "First", status: "in_progress" },
      { content: "Second", status: "in_progress" },
      { content: "Third", status: "pending" },
    ],
  });
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  assert.ok(text.includes("warning"), "warning is surfaced");
  assert.ok(text.includes("invalid workflow state"), "warning describes invalid workflow state");
  assert.ok(text.includes("2 items in_progress"), "warning counts active items");
  assert.deepStrictEqual((result.details as any).items.length, 3, "details preserve all items");
  console.log("  Multiple in_progress surfaces warning ............. PASS");
}

async function testSingleInProgressHasNoWarning() {
  const { write } = registerTodos();
  const result = await write.execute("tc", {
    todos: [
      { content: "First", status: "completed" },
      { content: "Second", status: "in_progress" },
    ],
  });
  const txt = text(result);
  assert.ok(!txt.includes("warning"), "no warning for single in_progress");
  assert.ok(txt.includes("1/2 done"), "summary shows progress");
  console.log("  Single in_progress has no warning ................. PASS");
}

// ---------------------------------------------------------------------------
// Current-item contract — read tool
// ---------------------------------------------------------------------------

async function testReadSingleCurrentDetailsIncludeItemAndIndex() {
  const { write, read } = registerTodos();

  await write.execute("tc", {
    todos: [
      { content: "Done", status: "completed" },
      { content: "Active", status: "in_progress" },
      { content: "Next", status: "pending" },
    ],
  });

  const result = await read.execute();
  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // Plain-text contract: summary + current line + full checklist
  assert.ok(txt.includes("1/3 done"), "text has done/total summary");
  assert.ok(txt.includes("Current:"), "text has explicit current line");
  assert.ok(txt.includes("Active"), "current line shows the active item");
  assert.ok(txt.includes("Done"), "full checklist present");
  assert.ok(txt.includes("Next"), "full checklist present");

  // Structured details: items array preserved
  assert.ok(Array.isArray(det.items), "details has items array");
  assert.strictEqual((det.items as Item[]).length, 3, "details preserves all items");

  // Structured details: currentItem and currentIndex when exactly one in_progress
  assert.notStrictEqual(det.currentItem, null, "details has currentItem");
  assert.strictEqual((det.currentItem as Item).content, "Active", "currentItem content correct");
  assert.strictEqual(det.currentIndex, 1, "currentIndex correct");

  console.log("  Read single current details include item+index ..... PASS");
}

async function testReadNoCurrentShowsNoneWithoutWarning() {
  const { write, read } = registerTodos();

  await write.execute("tc", {
    todos: [
      { content: "Done", status: "completed" },
      { content: "Pending", status: "pending" },
    ],
  });

  const result = await read.execute();
  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // No warning
  assert.ok(!txt.includes("warning"), "no warning for zero in_progress");

  // Shows "none" for current
  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("none"), 'shows "none" for no current');

  // Details explicitly represent no current item (not as a warning)
  assert.strictEqual(det.currentItem, null, "details currentItem is null");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null");
  assert.strictEqual(det.activeCandidates, undefined, "no activeCandidates for zero");

  console.log("  Read no current shows nulls without warning ....... PASS");
}

async function testReadMultipleCurrentIncludesCandidatesWithoutWarning() {
  const { write, read } = registerTodos();

  await write.execute("tc", {
    todos: [
      { content: "Alpha", status: "in_progress" },
      { content: "Beta", status: "in_progress" },
      { content: "Gamma", status: "pending" },
    ],
  });

  const result = await read.execute();
  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // No warning in read (the warning belongs to write)
  assert.ok(!txt.includes("warning"), "no warning in read for multiple in_progress");

  // Shows current as multiple
  assert.ok(txt.includes("Current:"), "text includes Current: line");
  assert.ok(txt.includes("multiple"), 'shows "multiple" indicator');

  // Details: no unique current
  assert.strictEqual(det.currentItem, null, "details currentItem is null for multi");
  assert.strictEqual(det.currentIndex, null, "details currentIndex is null for multi");

  // Details: active candidates present
  assert.ok(Array.isArray(det.activeCandidates), "details has activeCandidates");
  assert.strictEqual((det.activeCandidates as any[]).length, 2, "two active candidates");
  assert.strictEqual((det.activeCandidates as any[])[0].content, "Alpha", "first candidate");
  assert.strictEqual((det.activeCandidates as any[])[0].index, 0, "first candidate index");
  assert.strictEqual((det.activeCandidates as any[])[1].content, "Beta", "second candidate");

  console.log("  Read multiple current includes candidates ......... PASS");
}

// ---------------------------------------------------------------------------
// Current-item contract — write tool
// ---------------------------------------------------------------------------

async function testWriteOutputShapeMatchesRead() {
  const { write } = registerTodos();

  const result = await write.execute("tc", {
    todos: [
      { content: "Task", status: "in_progress" },
    ],
  });

  const txt = text(result);
  const det = result.details as Record<string, unknown>;

  // Same text shape: summary + current line + checklist
  assert.ok(txt.includes("0/1 done"), "summary present");
  assert.ok(txt.includes("Current:"), "current line present");
  assert.ok(txt.includes("Task"), "checklist present");

  // Same details shape
  assert.strictEqual((det.currentItem as Item).content, "Task", "currentItem in write details");
  assert.strictEqual(det.currentIndex, 0, "currentIndex in write details");
  assert.ok(Array.isArray(det.items), "items array in write details");

  console.log("  Write output shape matches read ................... PASS");
}

async function testWriteMultipleInProgressAcceptedByExecution() {
  const { write } = registerTodos();

  // Must not throw — multiple in_progress is accepted by write execution
  let result;
  try {
    result = await write.execute("tc", {
      todos: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "pending" },
      ],
    });
  } catch (e) {
    assert.fail(`write should not throw for multiple in_progress: ${e}`);
  }

  const txt = text(result!);
  const det = result!.details as Record<string, unknown>;

  // Warning surfaced, not rejection
  assert.ok(txt.includes("warning"), "warning is surfaced");
  assert.ok(txt.includes("invalid workflow state"), "warning describes invalid workflow");
  assert.ok(txt.includes("2 items in_progress"), "warning counts active items");

  // Details: no unique current
  assert.strictEqual(det.currentItem, null, "currentItem null for multi");
  assert.strictEqual(det.currentIndex, null, "currentIndex null for multi");

  // Details: active candidates present
  assert.ok(Array.isArray(det.activeCandidates), "activeCandidates present");
  assert.strictEqual((det.activeCandidates as any[]).length, 2, "two candidates");

  // Items preserved
  assert.strictEqual((det.items as any[]).length, 3, "all items preserved");

  console.log("  Multiple in_progress accepted, not rejected ........ PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nTodo contract tests\n");

  testToolNamesAndLabels();
  testDescriptionsMentionChecklistAndWorkflow();
  await testMultipleInProgressSurfacesWarning();
  await testSingleInProgressHasNoWarning();

  // Current-item contract
  await testReadSingleCurrentDetailsIncludeItemAndIndex();
  await testReadNoCurrentShowsNoneWithoutWarning();
  await testReadMultipleCurrentIncludesCandidatesWithoutWarning();
  await testWriteOutputShapeMatchesRead();
  await testWriteMultipleInProgressAcceptedByExecution();

  console.log("\nAll tests PASS\n");
}

main();