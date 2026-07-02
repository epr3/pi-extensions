import { describe, it, expect, beforeAll } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
    on: () => {},
    registerCommand: () => {},
    events: { emit: () => {} },
  } as unknown as ExtensionAPI;
}

function registerSubagents(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  subagentsExtension(makeFakeApi(tools));
  return tools;
}

describe("Agent tool metadata", () => {
  let tools: ToolDefinition[];
  let agent: ToolDefinition;

  beforeAll(() => {
    tools = registerSubagents();
    agent = tools.find((t) => t.name === "Agent")!;
  });

  it("tool name is Agent (unchanged)", () => {
    expect(agent).toBeDefined();
    expect(agent.name).toBe("Agent");
  });

  it("label uses glossary term Subagent (not Sub-agent)", () => {
    expect(agent.label).toBe("Subagent");
    expect(agent.label).not.toContain("Sub-agent");
  });

  it("description mentions Subagent without hyphens", () => {
    expect(agent.description).toContain("Subagent");
    expect(agent.description).not.toMatch(/sub-agent/i);
  });

  it("prompt snippet mentions Subagent", () => {
    expect(agent.promptSnippet).toBeDefined();
    expect(agent.promptSnippet!).toContain("Subagent");
  });

  it("parameter names are stable", () => {
    const keys = Object.keys((agent.parameters as any).properties).toSorted();
    expect(keys).toEqual(["description", "prompt", "run_in_background", "subagent_type"]);
  });
});

describe("get_subagent_result tool metadata", () => {
  let tools: ToolDefinition[];
  let resultTool: ToolDefinition;

  beforeAll(() => {
    tools = registerSubagents();
    resultTool = tools.find((t) => t.name === "get_subagent_result")!;
  });

  it("is registered", () => {
    expect(resultTool).toBeDefined();
  });

  it("label uses Subagent", () => {
    expect(resultTool!.label).toBe("Subagent Result");
  });

  it("description mentions Subagent without hyphens", () => {
    expect(resultTool!.description).toContain("Subagent");
    expect(resultTool!.description).not.toMatch(/sub-agent/i);
  });
});

describe("prompt guidelines", () => {
  let tools: ToolDefinition[];
  let agent: ToolDefinition;

  beforeAll(() => {
    tools = registerSubagents();
    agent = tools.find((t) => t.name === "Agent")!;
  });

  it("reject batch API", () => {
    expect(Array.isArray(agent.promptGuidelines)).toBe(true);
    const text = agent.promptGuidelines!.join(" ");
    expect(text).toContain("same assistant turn");
    expect(text).toContain("Do not use a batch parameter");
    expect(text).toContain("each call returns its own result");
  });
});
