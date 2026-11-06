/**
 * todo_read current-item output tests — Vitest.
 *
 * Verifies todo_read plain-text and details include the current item line.
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

function warningLine(value: string): string | undefined {
  return value.split("\n").find((line) => line.includes("warning"));
}

describe("todo_read — single in_progress", () => {
  it("shows Current: line with active item, summary, and full checklist", async () => {
    const { write, read } = registerTodos();

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

    expect(txt).toContain("Current:");
    expect(txt).toContain("Implement feature");
    expect(txt).toContain("1/3 done");
    expect(txt).toContain("Setup env");
    expect(txt).toContain("Write tests");

    expect((det.currentItem as any)?.content).toBe("Implement feature");
    expect(det.currentIndex).toBe(1);
    expect(Array.isArray(det.items)).toBe(true);
    expect((det.items as unknown[]).length).toBe(3);
  });
});

describe("todo_read — no in_progress", () => {
  it('shows "none" for current without a warning', async () => {
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

    expect(txt).toContain("Current:");
    expect(txt).toContain("none");
    expect(txt).not.toContain("warning");

    expect(det.currentItem).toBeNull();
    expect(det.currentIndex).toBeNull();
  });
});

describe("todo_read — multiple in_progress", () => {
  it('shows "multiple", an advisory warning, and unchanged active candidates', async () => {
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

    expect(txt).toContain("Current:");
    expect(txt).toContain("multiple");
    expect(txt).toContain("warning");
    expect(txt).toContain("invalid workflow state");
    expect(txt).toContain("2 items in_progress");

    // Structured details stay unchanged: still no single current item, warnings
    // remain advisory rather than a rejection.
    expect(det.currentItem).toBeNull();
    expect(det.currentIndex).toBeNull();
    expect(Array.isArray(det.activeCandidates)).toBe(true);
    expect((det.activeCandidates as unknown[]).length).toBe(2);
    expect(det.activeCandidates).toEqual([
      { content: "Active A", status: "in_progress", index: 0 },
      { content: "Active B", status: "in_progress", index: 2 },
    ]);
  });

  it("warns with the same wording as todo_write for identical invalid state", async () => {
    const { write, read } = registerTodos();
    const todos = [
      { content: "Active P", status: "in_progress" },
      { content: "Active Q", status: "in_progress" },
    ];

    const writeText = text(await write.execute("tc", { todos }));
    const readText = text(await read.execute());

    expect(warningLine(readText)).toBeDefined();
    expect(warningLine(readText)).toBe(warningLine(writeText));
  });
});