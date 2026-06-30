/**
 * Behavior tests for Todo tool call/result rendering.
 *
 * Verifies that:
 *   - The call row shows "Todo" label and compact args summary.
 *   - The result renderer shows a styled checklist with distinct pending,
 *     in_progress, and completed states and a done/total summary.
 *   - Multiple in_progress items produce a visible warning.
 *   - Missing details fall back to plain text content.
 *   - Session todo state details are preserved through the result details.
 *
 * Uses a plain theme that strips ANSI codes, so tests verify the visible
 * text contract without depending on exact styling.
 *
 * Run:  npx tsx tests/todo-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import { renderTodoCall, renderTodoResult, type Item } from "../packages/todo/index.ts";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callText(args: Record<string, unknown>): string {
  const component = renderTodoCall(args, plainTheme);
  return component.render(80).join("\n");
}

function resultText(
  result: Parameters<typeof renderTodoResult>[0],
  expanded = false,
  isPartial = false,
): string {
  const component = renderTodoResult(result, { expanded, isPartial }, plainTheme, undefined);
  return component.render(80).join("\n");
}

function writeArgs(items: Item[]): Record<string, unknown> {
  return { todos: items };
}

// ---------------------------------------------------------------------------
// renderTodoCall
// ---------------------------------------------------------------------------

function testCallShowsToolName() {
  const text = callText(writeArgs([{ content: "Task", status: "pending" }]));
  assert.ok(text.includes("Todo"), "call row shows Todo label");
  console.log("  Shows Todo label .................................. PASS");
}

function testCallShowsItemCountForWrite() {
  const text = callText(
    writeArgs([
      { content: "A", status: "pending" },
      { content: "B", status: "pending" },
    ]),
  );
  assert.ok(text.includes("2 items"), "write call row shows item count");
  console.log("  Shows item count for write ....................... PASS");
}

function testCallShowsReadOnlyForRead() {
  const text = callText({});
  assert.ok(text.includes("read-only"), "read call row shows read-only");
  console.log("  Shows read-only for read ......................... PASS");
}

function testCallShowsDoneAndActive() {
  const text = callText(
    writeArgs([
      { content: "Done", status: "completed" },
      { content: "Active", status: "in_progress" },
      { content: "Pending", status: "pending" },
    ]),
  );
  assert.ok(text.includes("1 done"), "shows done count");
  assert.ok(text.includes("1 active"), "shows active count");
  console.log("  Shows done and active counts ..................... PASS");
}

function testCallReturnsRenderable() {
  const component = renderTodoCall(writeArgs([{ content: "T", status: "pending" }]), plainTheme);
  assert.ok(typeof component.render === "function", "returns a renderable component");
  const lines = component.render(80);
  assert.ok(Array.isArray(lines), "render() returns an array");
  assert.ok(lines.length > 0, "render() returns at least one line");
  console.log("  Returns renderable component ...................... PASS");
}

function testCallStartsWithToolName() {
  const text = callText(writeArgs([{ content: "T", status: "pending" }]));
  assert.ok(text.trim().startsWith("Todo"), "call row starts with tool name");
  console.log("  Call row starts with tool name ................... PASS");
}

function testCallHandlesEmptyWrite() {
  const text = callText(writeArgs([]));
  assert.ok(text.includes("0 items"), "write with 0 items shows 0 count");
  console.log("  Handles empty write .............................. PASS");
}

function testCallSingularItem() {
  const text = callText(writeArgs([{ content: "Solo", status: "pending" }]));
  assert.ok(text.includes("1 item"), "singular 'item' for one item");
  console.log("  Singular 'item' for one .......................... PASS");
}

// ---------------------------------------------------------------------------
// renderTodoResult — collapsed summary
// ---------------------------------------------------------------------------

function testCollapsedAllDone() {
  const result = {
    content: [{ type: "text" as const, text: "3/3 done\n[x] A\n[x] B\n[x] C" }],
    details: {
      items: [
        { content: "A", status: "completed" },
        { content: "B", status: "completed" },
        { content: "C", status: "completed" },
      ],
    },
  };
  const text = resultText(result, false);
  assert.ok(text.includes("✓"), "checkmark for all done");
  assert.ok(text.includes("3/3 done"), "shows done/total");
  console.log("  Collapsed all done ................................ PASS");
}

function testCollapsedPartialProgress() {
  const result = {
    content: [{ type: "text" as const, text: "1/3 done" }],
    details: {
      items: [
        { content: "A", status: "completed" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "pending" },
      ],
    },
  };
  const text = resultText(result, false);
  assert.ok(text.includes("1/3 done"), "shows done/total for partial");
  console.log("  Collapsed partial progress ........................ PASS");
}

function testCollapsedWarningForMultipleInProgress() {
  const result = {
    content: [{ type: "text" as const, text: "warning text" }],
    details: {
      items: [
        { content: "A", status: "in_progress" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "pending" },
      ],
    },
  };
  const text = resultText(result, false);
  assert.ok(text.includes("⚠"), "warning indicator for multiple in_progress");
  assert.ok(text.includes("2 in_progress"), "shows in_progress count");
  console.log("  Collapsed warning for multiple in_progress ........ PASS");
}

function testCollapsedNoWarningForSingleInProgress() {
  const result = {
    content: [{ type: "text" as const, text: "no warning" }],
    details: {
      items: [
        { content: "A", status: "completed" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "pending" },
      ],
    },
  };
  const text = resultText(result, false);
  assert.ok(!text.includes("⚠"), "no warning indicator for single in_progress");
  assert.ok(!text.includes("in_progress"), "no active count in collapsed text");
  console.log("  Collapsed no warning for single in_progress ....... PASS");
}

// ---------------------------------------------------------------------------
// renderTodoResult — collapsed current-item line
// ---------------------------------------------------------------------------

function testCollapsedShowsCurrentItemForSingleActive() {
  const result = {
    content: [{ type: "text" as const, text: "1/3 done" }],
    details: {
      items: [
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "in_progress" },
        { content: "Task C", status: "pending" },
      ],
      currentItem: { content: "Task B", status: "in_progress" },
      currentIndex: 1,
    },
  };
  const text = resultText(result, false);

  // Shows done/total summary
  assert.ok(text.includes("1/3 done"), "shows done/total summary");

  // Shows current item wording and content
  assert.ok(text.includes("Current:"), "has current-item wording");
  assert.ok(text.includes("Task B"), "includes active item content");

  // No warning indicator
  assert.ok(!text.includes("\u26a0"), "no warning indicator for single in_progress");
  console.log("  Collapsed shows current item for single active ....... PASS");
}

function testCollapsedNoCurrentWhenNoInProgress() {
  const result = {
    content: [{ type: "text" as const, text: "2/3 done" }],
    details: {
      items: [
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "completed" },
        { content: "Task C", status: "pending" },
      ],
      currentItem: null,
      currentIndex: null,
    },
  };
  const text = resultText(result, false);

  // Shows done/total summary
  assert.ok(text.includes("2/3 done"), "shows done/total summary");

  // No current item wording
  assert.ok(!text.includes("Current:"), "no current-item wording when no in_progress");

  // Compact — just the summary
  assert.strictEqual(text.trim(), "2/3 done", "collapsed text is just the summary");
  console.log("  Collapsed no current when no in_progress ............ PASS");
}

function testCollapsedKeepsWarningForMultipleInProgress() {
  const result = {
    content: [{ type: "text" as const, text: "warning text" }],
    details: {
      items: [
        { content: "Active 1", status: "in_progress" },
        { content: "Active 2", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ],
      currentItem: null,
      currentIndex: null,
      activeCandidates: [
        { content: "Active 1", status: "in_progress" as const, index: 0 },
        { content: "Active 2", status: "in_progress" as const, index: 1 },
      ],
    },
  };
  const text = resultText(result, false);

  // Warning indicator and active count
  assert.ok(text.includes("\u26a0"), "warning indicator for multiple in_progress");
  assert.ok(text.includes("2 in_progress"), "shows in_progress count");

  // No current item wording
  assert.ok(!text.includes("Current:"), "no current-item wording for multiple in_progress");
  console.log("  Collapsed keeps warning for multiple in_progress ..... PASS");
}

// ---------------------------------------------------------------------------
// renderTodoResult — expanded checklist
// ---------------------------------------------------------------------------

function testExpandedShowsAllItems() {
  const result = {
    content: [{ type: "text" as const, text: "text content" }],
    details: {
      items: [
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "in_progress" },
        { content: "Task C", status: "pending" },
      ],
    },
  };
  const text = resultText(result, true);
  assert.ok(text.includes("Task A"), "expanded shows first item content");
  assert.ok(text.includes("Task B"), "expanded shows second item content");
  assert.ok(text.includes("Task C"), "expanded shows third item content");
  console.log("  Expanded shows all items ......................... PASS");
}

function testExpandedDistinctMarkers() {
  const result = {
    content: [{ type: "text" as const, text: "text content" }],
    details: {
      items: [
        { content: "Done", status: "completed" },
        { content: "Active", status: "in_progress" },
        { content: "Wait", status: "pending" },
      ],
    },
  };
  const text = resultText(result, true);
  // Completed has ✓, in_progress has ◐, pending has a space
  const lines = text.split("\n");
  const completedLine = lines.find((l) => l.includes("Done"));
  const activeLine = lines.find((l) => l.includes("Active"));
  const pendingLine = lines.find((l) => l.includes("Wait"));
  assert.ok(completedLine?.includes("✓"), "completed item has checkmark");
  assert.ok(activeLine?.includes("◐"), "in_progress item has half-circle");
  assert.ok(pendingLine && !pendingLine.includes("✓") && !pendingLine.includes("◐"), "pending item has no special marker");
  console.log("  Expanded distinct markers ......................... PASS");
}

function testExpandedWarningForMultipleInProgress() {
  const result = {
    content: [{ type: "text" as const, text: "warning text" }],
    details: {
      items: [
        { content: "Active 1", status: "in_progress" },
        { content: "Active 2", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ],
    },
  };
  const text = resultText(result, true);
  assert.ok(text.includes("⚠ Warning"), "warning line shown in expanded");
  assert.ok(text.includes("2 items in_progress"), "active count in warning");
  console.log("  Expanded warning for multiple in_progress ......... PASS");
}

function testExpandedNoWarningForSingleInProgress() {
  const result = {
    content: [{ type: "text" as const, text: "no warning" }],
    details: {
      items: [
        { content: "Done", status: "completed" },
        { content: "Active", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ],
    },
  };
  const text = resultText(result, true);
  assert.ok(!text.includes("⚠ Warning"), "no warning line for single in_progress");
  console.log("  Expanded no warning for single in_progress ........ PASS");
}

// ---------------------------------------------------------------------------
// renderTodoResult — expanded current-item line
// ---------------------------------------------------------------------------

function testExpandedShowsCurrentItemForSingleActive() {
  const result = {
    content: [{ type: "text" as const, text: "1/3 done" }],
    details: {
      items: [
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "in_progress" },
        { content: "Task C", status: "pending" },
      ],
      currentItem: { content: "Task B", status: "in_progress" },
      currentIndex: 1,
    },
  };
  const text = resultText(result, true);
  const lines = text.split("\n");

  // Shows "Current:" line with active item content
  assert.ok(text.includes("Current: Task B"), "current item line shows active item content");

  // Current-item line appears before any checklist markers
  const currentLineIdx = lines.findIndex((l) => l.includes("Current:"));
  const firstChecklistIdx = lines.findIndex(
    (l) => l.includes("✓") || l.includes("◐") || (l.trim().startsWith(" ") && l.trim().length > 0),
  );
  assert.ok(
    currentLineIdx < firstChecklistIdx,
    "current item line appears before checklist items",
  );

  // Full checklist still present
  assert.ok(text.includes("Task A"), "first item still shown");
  assert.ok(text.includes("Task B"), "active item still shown in checklist");
  assert.ok(text.includes("Task C"), "pending item still shown");
  console.log("  Expanded shows current item for single active ...... PASS");
}

function testExpandedShowsCurrentNone() {
  const result = {
    content: [{ type: "text" as const, text: "2/3 done" }],
    details: {
      items: [
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "completed" },
        { content: "Task C", status: "pending" },
      ],
      currentItem: null,
      currentIndex: null,
    },
  };
  const text = resultText(result, true);
  assert.ok(text.includes("Current: none"), 'shows "Current: none" for zero in_progress');
  // Full checklist still present
  assert.ok(text.includes("Task A"), "first item still shown");
  assert.ok(text.includes("Task C"), "pending item still shown");
  console.log("  Expanded shows Current: none ...................... PASS");
}

function testExpandedNoCurrentForMultipleActive() {
  const result = {
    content: [{ type: "text" as const, text: "warning text" }],
    details: {
      items: [
        { content: "Active 1", status: "in_progress" },
        { content: "Active 2", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ],
      currentItem: null,
      currentIndex: null,
      activeCandidates: [
        { content: "Active 1", status: "in_progress" as const, index: 0 },
        { content: "Active 2", status: "in_progress" as const, index: 1 },
      ],
    },
  };
  const text = resultText(result, true);
  // No "Current:" line for multi-active
  assert.ok(!text.includes("Current:"), "no Current: line for multiple in_progress");
  // Warning still shown
  assert.ok(text.includes("⚠ Warning"), "warning still shown for multiple in_progress");
  assert.ok(text.includes("2 items in_progress"), "active count in warning");
  console.log("  Expanded no current for multiple active ........... PASS");
}

// ---------------------------------------------------------------------------
// renderTodoResult — edge cases
// ---------------------------------------------------------------------------

function testMissingDetailsFallback() {
  const result = {
    content: [{ type: "text" as const, text: "1/2 done\n[x] A\n[ ] B" }],
  };
  const text = resultText(result, true);
  assert.ok(text.includes("1/2 done"), "falls back to raw content text");
  assert.ok(text.includes("[x] A"), "falls back to raw content checklist");
  console.log("  Missing details fallback ......................... PASS");
}

function testEmptyDetailsItemsFallback() {
  const result = {
    content: [{ type: "text" as const, text: "0/0 done\n(empty)" }],
    details: { items: [] },
  };
  const text = resultText(result, true);
  assert.ok(text.includes("0/0 done"), "falls back to raw content for empty items");
  assert.ok(text.includes("(empty)"), "falls back to (empty) text");
  console.log("  Empty details items fallback ..................... PASS");
}

function testPartialFlagDoesNotChangeCollapsed() {
  const result = {
    content: [{ type: "text" as const, text: "done" }],
    details: {
      items: [
        { content: "A", status: "completed" },
        { content: "B", status: "completed" },
      ],
    },
  };
  const partial = resultText(result, false, true);
  const final = resultText(result, false, false);
  assert.strictEqual(partial, final, "isPartial does not change collapsed rendering");
  console.log("  Partial flag no effect on collapsed .............. PASS");
}

function testExpandedFlagDoesNotChangeFallback() {
  const result = {
    content: [{ type: "text" as const, text: "Fallback text" }],
  };
  const expanded = resultText(result, true);
  const collapsed = resultText(result, false);
  assert.strictEqual(expanded, collapsed, "expanded flag does not change fallback rendering");
  console.log("  Expanded flag no effect on fallback .............. PASS");
}

function testDetailsPreservesAllItems() {
  const items: Item[] = [
    { content: "First", status: "completed" },
    { content: "Second", status: "in_progress" },
    { content: "Third", status: "pending" },
  ];
  const result = {
    content: [{ type: "text" as const, text: "1/3 done" }],
    details: { items },
  };
  // Verify the renderer reads all items from details
  const text = resultText(result, true);
  assert.ok(text.includes("First"), "First item rendered");
  assert.ok(text.includes("Second"), "Second item rendered");
  assert.ok(text.includes("Third"), "Third item rendered");
  assert.strictEqual((result.details.items as Item[]).length, 3, "details preserves all 3 items");
  console.log("  Details preserves all items ...................... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nTodo rendering tests\n");

  // Call rendering
  testCallShowsToolName();
  testCallShowsItemCountForWrite();
  testCallShowsReadOnlyForRead();
  testCallShowsDoneAndActive();
  testCallReturnsRenderable();
  testCallStartsWithToolName();
  testCallHandlesEmptyWrite();
  testCallSingularItem();

  // Result rendering — collapsed
  testCollapsedAllDone();
  testCollapsedPartialProgress();
  testCollapsedWarningForMultipleInProgress();
  testCollapsedNoWarningForSingleInProgress();
  testCollapsedShowsCurrentItemForSingleActive();
  testCollapsedNoCurrentWhenNoInProgress();
  testCollapsedKeepsWarningForMultipleInProgress();

  // Result rendering — expanded
  testExpandedShowsAllItems();
  testExpandedDistinctMarkers();
  testExpandedWarningForMultipleInProgress();
  testExpandedNoWarningForSingleInProgress();

  // Result rendering — expanded current-item line
  testExpandedShowsCurrentItemForSingleActive();
  testExpandedShowsCurrentNone();
  testExpandedNoCurrentForMultipleActive();

  // Result rendering — edge cases
  testMissingDetailsFallback();
  testEmptyDetailsItemsFallback();
  testPartialFlagDoesNotChangeCollapsed();
  testExpandedFlagDoesNotChangeFallback();
  testDetailsPreservesAllItems();

  console.log("\nAll tests PASS\n");
}

main();
