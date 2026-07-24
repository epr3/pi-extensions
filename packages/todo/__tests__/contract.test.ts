/**
 * Todo tool contract tests — Vitest.
 *
 * Verifies tool registration metadata and write execution behavior.
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
  expect(tools).toHaveLength(2);
  const write = tools.find((t) => t.name === "todo_write")!;
  const read = tools.find((t) => t.name === "todo_read")!;
  return { write, read };
}

function text(result: { content: { type: "text"; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("todo tool registration", () => {
  it("registers todo_write and todo_read with stable names and labels", () => {
    const { write, read } = registerTodos();
    expect(write.name).toBe("todo_write");
    expect(write.label).toBe("Write Todos");
    expect(read.name).toBe("todo_read");
    expect(read.label).toBe("Read Todos");
  });

  it("write description advertises checklist workflow and single in_progress rule", () => {
    const { write } = registerTodos();
    expect(write.description).toContain("break an issue into steps");
    expect(write.description).toContain("vertical slices");
    expect(write.description).toContain("exactly one");
  });
});

describe("todo_write execution", () => {
  it("surfaces a warning for multiple in_progress items", async () => {
    const { write } = registerTodos();
    const result = await write.execute("tc", {
      todos: [
        { content: "First", status: "in_progress" },
        { content: "Second", status: "in_progress" },
        { content: "Third", status: "pending" },
      ],
    });
    const txt = text(result);
    expect(txt).toContain("warning");
    expect(txt).toContain("invalid workflow state");
    expect(txt).toContain("2 items in_progress");
    const details = result.details as { items: unknown[] };
    expect(details.items).toHaveLength(3);
  });

  it("does not warn for a single in_progress item", async () => {
    const { write } = registerTodos();
    const result = await write.execute("tc", {
      todos: [
        { content: "First", status: "completed" },
        { content: "Second", status: "in_progress" },
      ],
    });
    const txt = text(result);
    expect(txt).not.toContain("warning");
    expect(txt).toContain("1/2 done");
  });
});