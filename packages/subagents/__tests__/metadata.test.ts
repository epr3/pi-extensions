import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../index.ts";
import { makeFakeApi } from "./helpers.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// Package metadata — the description a user sees before installing
// ---------------------------------------------------------------------------

describe("package metadata", () => {
  const packageJsonPath = path.resolve(testDir, "../package.json");
  const description: string = JSON.parse(readFileSync(packageJsonPath, "utf-8")).description;
  let tools: ToolDefinition[];

  beforeAll(() => {
    tools = registerSubagents();
  });

  it("registers exactly the three documented tools (contract unchanged)", () => {
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "Agent",
      "get_subagent_result",
      "stop_subagent",
    ]);
  });

  it("description names every registered tool", () => {
    const registered = tools.map((t) => t.name);
    const missing = registered.filter((name) => !description.includes(name));
    expect(missing, `description omits registered tool(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("description carries no stale tool identifier", () => {
    // Snake_case tokens in the description are Pi tool names (types such as
    // explore/general are prose), so each one must still be registered.
    const named = [...description.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]!);
    const registered = new Set(tools.map((t) => t.name));
    const stale = named.filter((name) => !registered.has(name));
    expect(stale, `description names unregistered tool(s): ${stale.join(", ")}`).toEqual([]);
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