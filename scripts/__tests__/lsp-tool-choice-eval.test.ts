/**
 * Deterministic unit tests for the LSP tool-choice evaluation harness's parsing
 * and classification helpers only — no model is invoked here, and none of this
 * is wired into any package's `pnpm test` (the package vitest runs are
 * `--root .` per-package). These test the seam between pi's `--mode json`
 * session stream and the observed tool order, plus task-set shape validation.
 */

import { describe, it, expect } from "vitest";
import { parseToolOrder, classifyTool, loadTaskSet, SEMANTIC_TOOLS, TEXTUAL_TOOLS } from "../lsp-tool-choice-eval.ts";

const SESSION = [
  '{"type":"session","version":3,"cwd":"/tmp/x"}',
  '{"type":"tool_execution_start","toolCallId":"a","toolName":"grep","args":{}}',
  '{"type":"tool_execution_start","toolCallId":"b","toolName":"lsp_references","args":{}}',
  'not-json line {',
  '{"type":"tool_execution_start","toolCallId":"c","toolName":"read","args":{}}',
].join("\n");

describe("parseToolOrder", () => {
  it("reads tool_execution_start events in order, skipping non-JSON lines", () => {
    expect(parseToolOrder(SESSION)).toEqual(["grep", "lsp_references", "read"]);
  });

  it("returns empty for empty, tool-free, or garbage transcripts", () => {
    expect(parseToolOrder("")).toEqual([]);
    expect(parseToolOrder('{"type":"turn_end"}\n{"type":"agent_settled"}')).toEqual([]);
    expect(parseToolOrder("completely not json")).toEqual([]);
  });
});

describe("classifyTool", () => {
  it("maps lsp tools to semantic and the search/inspection trio to textual/orientation", () => {
    expect(classifyTool("lsp_definition")).toBe("semantic");
    expect(classifyTool("lsp_references")).toBe("semantic");
    expect(classifyTool("lsp_document_symbols")).toBe("semantic");
    expect(classifyTool("grep")).toBe("textual");
    expect(classifyTool("find")).toBe("textual");
    expect(classifyTool("read")).toBe("orientation");
    expect(classifyTool("edit")).toBe("other");
    expect(classifyTool(undefined)).toBe("none");
  });

  it("classification stays consistent with the exported tool sets", () => {
    for (const name of SEMANTIC_TOOLS) expect(classifyTool(name)).toBe("semantic");
    for (const name of TEXTUAL_TOOLS) expect(classifyTool(name)).toBe("textual");
  });
});

describe("loadTaskSet", () => {
  const good = {
    tasks: [
      { id: "T1", category: "semantic", intent: "why", prompt: "what", expectedFirstClass: "semantic" },
    ],
  };

  it("accepts a well-formed task set", () => {
    expect(loadTaskSet(JSON.stringify(good), "t")).toEqual(good);
  });

  it("rejects empty task lists", () => {
    expect(() => loadTaskSet(JSON.stringify({ tasks: [] }), "t")).toThrow(/non-empty/);
  });

  it("rejects tasks with missing or empty fields", () => {
    const bad = { tasks: [{ id: "T1", category: "semantic", intent: "", prompt: "x", expectedFirstClass: "semantic" }] };
    expect(() => loadTaskSet(JSON.stringify(bad), "t")).toThrow(/"intent"/);
  });

  it("rejects duplicate task ids", () => {
    expect(() => loadTaskSet(JSON.stringify({ tasks: [good.tasks[0], good.tasks[0]] }), "t")).toThrow(/duplicate task id/);
  });
});
