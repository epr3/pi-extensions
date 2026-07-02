/**
 * Todo rendering tests — Vitest.
 *
 * Verifies tool call/result rendering using a plain theme that strips ANSI codes.
 */

import { describe, it, expect } from "vitest";
import { renderTodoCall, renderTodoResult, type Item } from "../index.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

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

describe("renderTodoCall", () => {
  it("shows the Todo label", () => {
    const text = callText(writeArgs([{ content: "Task", status: "pending" }]));
    expect(text).toContain("Todo");
  });

  it("shows item count for write", () => {
    const text = callText(
      writeArgs([
        { content: "A", status: "pending" },
        { content: "B", status: "pending" },
      ]),
    );
    expect(text).toContain("2 items");
  });

  it("shows read-only for read", () => {
    const text = callText({});
    expect(text).toContain("read-only");
  });

  it("shows done and active counts", () => {
    const text = callText(
      writeArgs([
        { content: "Done", status: "completed" },
        { content: "Active", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ]),
    );
    expect(text).toContain("1 done");
    expect(text).toContain("1 active");
  });

  it("returns a renderable component", () => {
    const component = renderTodoCall(writeArgs([{ content: "T", status: "pending" }]), plainTheme);
    expect(typeof component.render).toBe("function");
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("starts with the tool name", () => {
    const text = callText(writeArgs([{ content: "T", status: "pending" }]));
    expect(text.trim()).toMatch(/^Todo/);
  });

  it("handles empty write", () => {
    const text = callText(writeArgs([]));
    expect(text).toContain("0 items");
  });

  it("uses singular for one item", () => {
    const text = callText(writeArgs([{ content: "Solo", status: "pending" }]));
    expect(text).toContain("1 item");
  });
});

describe("renderTodoResult — collapsed", () => {
  it("shows checkmark and done/total when all complete", () => {
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
    expect(text).toContain("✓");
    expect(text).toContain("3/3 done");
  });

  it("shows done/total for partial progress", () => {
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
    expect(text).toContain("1/3 done");
  });

  it("shows warning for multiple in_progress", () => {
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
    expect(text).toContain("⚠");
    expect(text).toContain("2 in_progress");
  });

  it("no warning for single in_progress", () => {
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
    expect(text).not.toContain("⚠");
    expect(text).not.toContain("in_progress");
  });

  it("shows current item for single active", () => {
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
    expect(text).toContain("1/3 done");
    expect(text).toContain("Current:");
    expect(text).toContain("Task B");
    expect(text).not.toContain("⚠");
  });

  it("no current item when no in_progress", () => {
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
    expect(text).toContain("2/3 done");
    expect(text).not.toContain("Current:");
    expect(text.trim()).toBe("2/3 done");
  });

  it("keeps warning for multiple in_progress, no current line", () => {
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
    expect(text).toContain("⚠");
    expect(text).toContain("2 in_progress");
    expect(text).not.toContain("Current:");
  });
});

describe("renderTodoResult — expanded", () => {
  it("shows all items", () => {
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
    expect(text).toContain("Task A");
    expect(text).toContain("Task B");
    expect(text).toContain("Task C");
  });

  it("uses distinct markers for each status", () => {
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
    const lines = text.split("\n");
    const completedLine = lines.find((l) => l.includes("Done"));
    const activeLine = lines.find((l) => l.includes("Active"));
    const pendingLine = lines.find((l) => l.includes("Wait"));
    expect(completedLine).toContain("✓");
    expect(activeLine).toContain("◐");
    expect(pendingLine).toBeDefined();
    expect(pendingLine).not.toContain("✓");
    expect(pendingLine).not.toContain("◐");
  });

  it("shows warning for multiple in_progress", () => {
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
    expect(text).toContain("⚠ Warning");
    expect(text).toContain("2 items in_progress");
  });

  it("no warning for single in_progress", () => {
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
    expect(text).not.toContain("⚠ Warning");
  });

  it("shows current item line before checklist for single active", () => {
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
    expect(text).toContain("Current: Task B");
    const currentLineIdx = lines.findIndex((l) => l.includes("Current:"));
    const firstChecklistIdx = lines.findIndex(
      (l) => l.includes("✓") || l.includes("◐") || (l.trim().length > 0 && !l.includes("Current:")),
    );
    expect(currentLineIdx).toBeLessThan(firstChecklistIdx);
    expect(text).toContain("Task A");
    expect(text).toContain("Task B");
    expect(text).toContain("Task C");
  });

  it('shows "Current: none" for zero in_progress', () => {
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
    expect(text).toContain("Current: none");
    expect(text).toContain("Task A");
    expect(text).toContain("Task C");
  });

  it("no current line for multiple active, keeps warning", () => {
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
    expect(text).not.toContain("Current:");
    expect(text).toContain("⚠ Warning");
    expect(text).toContain("2 items in_progress");
  });
});

describe("renderTodoResult — edge cases", () => {
  it("falls back to raw content when details are missing", () => {
    const result = {
      content: [{ type: "text" as const, text: "1/2 done\n[x] A\n[ ] B" }],
    };
    const text = resultText(result, true);
    expect(text).toContain("1/2 done");
    expect(text).toContain("[x] A");
  });

  it("falls back to raw content for empty items", () => {
    const result = {
      content: [{ type: "text" as const, text: "0/0 done\n(empty)" }],
      details: { items: [] },
    };
    const text = resultText(result, true);
    expect(text).toContain("0/0 done");
    expect(text).toContain("(empty)");
  });

  it("isPartial does not change collapsed rendering", () => {
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
    expect(partial).toBe(final);
  });

  it("expanded flag does not change fallback rendering", () => {
    const result = {
      content: [{ type: "text" as const, text: "Fallback text" }],
    };
    const expanded = resultText(result, true);
    const collapsed = resultText(result, false);
    expect(expanded).toBe(collapsed);
  });

  it("preserves all items in details", () => {
    const items: Item[] = [
      { content: "First", status: "completed" },
      { content: "Second", status: "in_progress" },
      { content: "Third", status: "pending" },
    ];
    const result = {
      content: [{ type: "text" as const, text: "1/3 done" }],
      details: { items },
    };
    const text = resultText(result, true);
    expect(text).toContain("First");
    expect(text).toContain("Second");
    expect(text).toContain("Third");
    expect((result.details.items as Item[]).length).toBe(3);
  });
});
