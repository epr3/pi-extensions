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
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  assert.ok(!text.includes("warning"), "no warning for single in_progress");
  assert.ok(text.includes("1/2 done"), "summary shows progress");
  console.log("  Single in_progress has no warning ................. PASS");
}

async function main() {
  console.log("\nTodo contract tests\n");

  testToolNamesAndLabels();
  testDescriptionsMentionChecklistAndWorkflow();
  await testMultipleInProgressSurfacesWarning();
  await testSingleInProgressHasNoWarning();

  console.log("\nAll tests PASS\n");
}

main();