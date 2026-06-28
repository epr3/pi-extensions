/**
 * Subagent tool metadata contract tests.
 *
 * Verifies that the `Agent` tool name and parameter names remain stable while
 * all user-facing guidance (labels, descriptions, prompt snippets/guidelines)
 * uses the glossary term "Subagent" rather than "Sub-agent".
 *
 * Run: node_modules/.pnpm/node_modules/.bin/tsx tests/subagent-metadata.test.ts
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../packages/subagents/index.ts";

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

function testAgentToolNameUnchanged() {
  const tools = registerSubagents();
  const agent = tools.find((t) => t.name === "Agent");
  assert.ok(agent, "Agent tool is registered");
  assert.strictEqual(agent.name, "Agent", "tool name remains Agent");
  console.log("  Agent tool name unchanged ......................... PASS");
}

function testAgentLabelUsesGlossaryTerm() {
  const tools = registerSubagents();
  const agent = tools.find((t) => t.name === "Agent")!;
  assert.strictEqual(agent.label, "Subagent", "label uses glossary term Subagent");
  assert.ok(!agent.label.includes("Sub-agent"), "label does not use old Sub-agent form");
  console.log("  Agent label uses Subagent ......................... PASS");
}

function testAgentDescriptionUsesGlossaryTerm() {
  const tools = registerSubagents();
  const agent = tools.find((t) => t.name === "Agent")!;
  assert.ok(agent.description.includes("Subagent"), "description mentions Subagent");
  assert.ok(!/sub-agent/i.test(agent.description), "description does not use hyphenated sub-agent");
  console.log("  Agent description uses Subagent ................... PASS");
}

function testAgentPromptSnippetUsesGlossaryTerm() {
  const tools = registerSubagents();
  const agent = tools.find((t) => t.name === "Agent")!;
  assert.ok(agent.promptSnippet, "prompt snippet is present");
  assert.ok(agent.promptSnippet!.includes("Subagent"), "prompt snippet mentions Subagent");
  console.log("  Agent prompt snippet uses Subagent ................ PASS");
}

function testAgentParameterNamesStable() {
  const tools = registerSubagents();
  const agent = tools.find((t) => t.name === "Agent")!;
  const keys = Object.keys((agent.parameters as any).properties).toSorted();
  assert.deepStrictEqual(keys, ["description", "prompt", "run_in_background", "subagent_type"]);
  console.log("  Agent parameter names stable ...................... PASS");
}

function testResultToolMetadata() {
  const tools = registerSubagents();
  const resultTool = tools.find((t) => t.name === "get_subagent_result");
  assert.ok(resultTool, "get_subagent_result tool is registered");
  assert.strictEqual(resultTool!.label, "Subagent Result", "result label uses Subagent");
  assert.ok(resultTool!.description.includes("Subagent"), "result description uses Subagent");
  assert.ok(
    !/sub-agent/i.test(resultTool!.description),
    "result description avoids hyphenated form",
  );
  console.log("  get_subagent_result metadata uses Subagent ........ PASS");
}

function testPromptGuidelinesRejectBatchApi() {
  const tools = registerSubagents();
  const agent = tools.find((t) => t.name === "Agent")!;
  assert.ok(Array.isArray(agent.promptGuidelines), "prompt guidelines present");
  const text = agent.promptGuidelines!.join(" ");
  assert.ok(text.includes("same assistant turn"), "guidelines describe same-turn fan-out");
  assert.ok(text.includes("Do not use a batch parameter"), "guidelines reject batch parameter");
  assert.ok(
    text.includes("each call returns its own result"),
    "guidelines preserve independent results",
  );
  console.log("  Prompt guidelines reject batch API ................ PASS");
}

function main() {
  console.log("\nSubagent metadata contract tests\n");

  testAgentToolNameUnchanged();
  testAgentLabelUsesGlossaryTerm();
  testAgentDescriptionUsesGlossaryTerm();
  testAgentPromptSnippetUsesGlossaryTerm();
  testAgentParameterNamesStable();
  testResultToolMetadata();
  testPromptGuidelinesRejectBatchApi();

  console.log("\nAll tests PASS\n");
}

main();