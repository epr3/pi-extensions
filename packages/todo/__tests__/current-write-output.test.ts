/**
 * todo_write current-item output tests — Vitest.
 *
 * Verifies todo_write plain-text and details use the same current-item
 * result shape as todo_read.
 */

import { describe, it, expect } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import todoExtension from "../index.ts";

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

describe("todo_write — single in_progress", () => {
  it("shows Current: line, summary, no warning", async () => {
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

    expect(txt).toContain("Current:");
    expect(txt).toContain("Step B");
    expect(txt).toContain("1/3 done");
    expect(txt).not.toContain("warning");

    expect((det.currentItem as any)?.content).toBe("Step B");
    expect(det.currentIndex).toBe(1);
    expect(Array.isArray(det.items)).toBe(true);
  });
});

describe("todo_write — no in_progress", () => {
  it('shows "none" for current without a warning', async () => {
    const { write } = registerTodos();

    const result = await write.execute("tc", {
      todos: [
        { content: "Done", status: "completed" },
        { content: "Skipped", status: "completed" },
      ],
    });

    const txt = text(result);
    const det = result.details as Record<string, unknown>;

    expect(txt).toContain("Current:");
    expect(txt).toContain("none");
    expect(txt).not.toContain("warning");

    expect(det.currentItem).toBeNull();
    expect(det.currentIndex).toBeNull();
  });
});

describe("todo_write — multiple in_progress", () => {
  it('shows "multiple" with warning and active candidates', async () => {
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

    expect(txt).toContain("Current:");
    expect(txt).toContain("multiple");
    expect(txt).toContain("warning");
    expect(txt).toContain("invalid workflow state");
    expect(txt).toContain("2 items in_progress");

    expect(det.currentItem).toBeNull();
    expect(det.currentIndex).toBeNull();
    expect(Array.isArray(det.activeCandidates)).toBe(true);
    expect((det.activeCandidates as unknown[]).length).toBe(2);
  });
});

describe("todo_write — empty list", () => {
  it('shows "none" and (empty) for an empty checklist', async () => {
    const { write } = registerTodos();

    const result = await write.execute("tc", { todos: [] });

    const txt = text(result);
    const det = result.details as Record<string, unknown>;

    expect(txt).toContain("Current:");
    expect(txt).toContain("none");
    expect(txt).toContain("(empty)");

    expect(det.currentItem).toBeNull();
    expect(det.currentIndex).toBeNull();
  });
});