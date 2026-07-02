/**
 * deriveCurrentItem tests — Vitest.
 *
 * Pure function: derives current item from a todo list.
 */

import { describe, it, expect } from "vitest";
import { deriveCurrentItem, type Item } from "../index.ts";

describe("deriveCurrentItem", () => {
  it("returns item and index for exactly one in_progress", () => {
    const items: Item[] = [
      { content: "First", status: "completed" },
      { content: "Current task", status: "in_progress" },
      { content: "Next", status: "pending" },
    ];
    const result = deriveCurrentItem(items);
    expect(result.currentItem).not.toBeNull();
    expect(result.currentItem?.content).toBe("Current task");
    expect(result.currentItem?.status).toBe("in_progress");
    expect(result.currentIndex).toBe(1);
    expect(result.activeCandidates).toBeUndefined();
  });

  it("returns nulls for no in_progress items", () => {
    const items: Item[] = [
      { content: "Done", status: "completed" },
      { content: "Skipped", status: "completed" },
      { content: "Pending", status: "pending" },
    ];
    const result = deriveCurrentItem(items);
    expect(result.currentItem).toBeNull();
    expect(result.currentIndex).toBeNull();
    expect(result.activeCandidates).toBeUndefined();
  });

  it("returns nulls for an empty list", () => {
    const result = deriveCurrentItem([]);
    expect(result.currentItem).toBeNull();
    expect(result.currentIndex).toBeNull();
  });

  it("returns active candidates for multiple in_progress", () => {
    const items: Item[] = [
      { content: "Active A", status: "in_progress" },
      { content: "Completed", status: "completed" },
      { content: "Active B", status: "in_progress" },
    ];
    const result = deriveCurrentItem(items);
    expect(result.currentItem).toBeNull();
    expect(result.currentIndex).toBeNull();
    expect(result.activeCandidates).toBeDefined();
    expect(result.activeCandidates).toHaveLength(2);
    expect(result.activeCandidates![0].content).toBe("Active A");
    expect(result.activeCandidates![0].index).toBe(0);
    expect(result.activeCandidates![1].content).toBe("Active B");
    expect(result.activeCandidates![1].index).toBe(2);
  });
});
