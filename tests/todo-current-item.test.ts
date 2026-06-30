/**
 * Tests for deriveCurrentItem — the pure function that derives current item
 * from a todo list.
 *
 * Run:  npx tsx tests/todo-current-item.test.ts
 */

import { strict as assert } from "node:assert";
import { deriveCurrentItem, type Item } from "../packages/todo/index.ts";

// ---------------------------------------------------------------------------
// Single in_progress
// ---------------------------------------------------------------------------

function testSingleInProgressReturnsItemAndIndex() {
  const items: Item[] = [
    { content: "First", status: "completed" },
    { content: "Current task", status: "in_progress" },
    { content: "Next", status: "pending" },
  ];
  const result = deriveCurrentItem(items);
  assert.notStrictEqual(result.currentItem, null, "currentItem should be set");
  assert.strictEqual(result.currentItem?.content, "Current task", "correct content");
  assert.strictEqual(result.currentItem?.status, "in_progress", "correct status");
  assert.strictEqual(result.currentIndex, 1, "correct index");
  assert.strictEqual(result.activeCandidates, undefined, "no activeCandidates for single");
  console.log("  Single in_progress returns item and index ........ PASS");
}

// ---------------------------------------------------------------------------
// No in_progress
// ---------------------------------------------------------------------------

function testNoInProgressReturnsNull() {
  const items: Item[] = [
    { content: "Done", status: "completed" },
    { content: "Skipped", status: "completed" },
    { content: "Pending", status: "pending" },
  ];
  const result = deriveCurrentItem(items);
  assert.strictEqual(result.currentItem, null, "currentItem should be null");
  assert.strictEqual(result.currentIndex, null, "currentIndex should be null");
  assert.strictEqual(result.activeCandidates, undefined, "no activeCandidates for zero");
  console.log("  No in_progress returns null ...................... PASS");
}

function testEmptyListReturnsNull() {
  const result = deriveCurrentItem([]);
  assert.strictEqual(result.currentItem, null, "currentItem should be null for empty list");
  assert.strictEqual(result.currentIndex, null, "currentIndex should be null for empty list");
  console.log("  Empty list returns null .......................... PASS");
}

// ---------------------------------------------------------------------------
// Multiple in_progress
// ---------------------------------------------------------------------------

function testMultipleInProgressReturnsCandidates() {
  const items: Item[] = [
    { content: "Active A", status: "in_progress" },
    { content: "Completed", status: "completed" },
    { content: "Active B", status: "in_progress" },
  ];
  const result = deriveCurrentItem(items);
  assert.strictEqual(result.currentItem, null, "currentItem should be null for multiple");
  assert.strictEqual(result.currentIndex, null, "currentIndex should be null for multiple");
  assert.ok(result.activeCandidates !== undefined, "activeCandidates should be set");
  assert.strictEqual(result.activeCandidates!.length, 2, "two active candidates");
  assert.strictEqual(result.activeCandidates![0].content, "Active A", "first candidate correct");
  assert.strictEqual(result.activeCandidates![0].index, 0, "first candidate index correct");
  assert.strictEqual(result.activeCandidates![1].content, "Active B", "second candidate correct");
  assert.strictEqual(result.activeCandidates![1].index, 2, "second candidate index correct");
  console.log("  Multiple in_progress returns candidates .......... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nderiveCurrentItem tests\n");
  testSingleInProgressReturnsItemAndIndex();
  testNoInProgressReturnsNull();
  testEmptyListReturnsNull();
  testMultipleInProgressReturnsCandidates();
  console.log("\nAll tests PASS\n");
}

main();
