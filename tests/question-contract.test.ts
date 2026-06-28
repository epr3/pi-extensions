/**
 * Question tool contract tests.
 *
 * Verifies tool metadata and the hard two-to-four preset option validation.
 *
 * Run: node_modules/.pnpm/node_modules/.bin/tsx tests/question-contract.test.ts
 */

import { strict as assert } from "node:assert";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import questionExtension from "../packages/question/index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
    on: () => {},
  } as unknown as ExtensionAPI;
}

function registerQuestion(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  questionExtension(makeFakeApi(tools));
  assert.strictEqual(tools.length, 1, "question registers exactly one tool");
  return tools[0]!;
}

function noUICtx(): ExtensionContext {
  return { hasUI: false } as ExtensionContext;
}

function testToolNameAndLabel() {
  const tool = registerQuestion();
  assert.strictEqual(tool.name, "question", "tool name is question");
  assert.strictEqual(tool.label, "Question", "label is Question");
  console.log("  Tool name and label correct ....................... PASS");
}

function testDescriptionMatchesContract() {
  const tool = registerQuestion();
  assert.ok(tool.description.includes("2-4"), "description mentions 2-4 options");
  assert.ok(
    tool.description.includes("free-prose") || tool.description.includes("free prose"),
    "description mentions free prose",
  );
  assert.ok(
    tool.description.includes("multiSelect") || tool.description.includes("multi-select"),
    "description mentions multi-select",
  );
  console.log("  Description matches contract ...................... PASS");
}

function testParameterSchemaEnforcesTwoToFour() {
  const tool = registerQuestion();
  const optionsSchema = (tool.parameters as any).properties.options;
  assert.strictEqual(optionsSchema.minItems, 2, "options schema requires at least 2");
  assert.strictEqual(optionsSchema.maxItems, 4, "options schema requires at most 4");
  assert.ok(optionsSchema.description.includes("2-4"), "options description mentions 2-4");
  console.log("  Parameter schema enforces 2-4 options ............. PASS");
}

async function executeWithOptions(options: Array<{ label: string }>) {
  const tool = registerQuestion();
  return tool.execute("tc", { question: "Pick one", options }, undefined, undefined, noUICtx());
}

async function testRejectsOneOption() {
  await assert.rejects(
    () => executeWithOptions([{ label: "Only" }]),
    /2-4 preset options/,
    "one preset option is rejected",
  );
  console.log("  Rejects one option ................................ PASS");
}

async function testRejectsFiveOptions() {
  await assert.rejects(
    () =>
      executeWithOptions([
        { label: "A" },
        { label: "B" },
        { label: "C" },
        { label: "D" },
        { label: "E" },
      ]),
    /2-4 preset options/,
    "five preset options are rejected",
  );
  console.log("  Rejects five options .............................. PASS");
}

async function testAcceptsTwoOptions() {
  const result = await executeWithOptions([{ label: "A" }, { label: "B" }]);
  assert.ok(Array.isArray(result.content), "result has content");
  assert.ok(
    result.content[0].text.includes("Pick one"),
    "non-interactive fallback surfaces the question",
  );
  assert.ok(result.content[0].text.includes("A"), "fallback includes option A");
  assert.ok(result.content[0].text.includes("B"), "fallback includes option B");
  console.log("  Accepts two options ............................... PASS");
}

async function main() {
  console.log("\nQuestion contract tests\n");

  testToolNameAndLabel();
  testDescriptionMatchesContract();
  testParameterSchemaEnforcesTwoToFour();
  await testRejectsOneOption();
  await testRejectsFiveOptions();
  await testAcceptsTwoOptions();

  console.log("\nAll tests PASS\n");
}

main();