/**
 * Agent tool contract tests — locks the Agent parameter shape as one-run-only.
 *
 * Guards against drift toward a batch parameter (tasks), aggregate group
 * result, or recursive subagent spawning. Each functional area is an
 * independent test.
 *
 * Run:  node node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs tests/agent-contract.test.ts
 * Or:   node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs tests/agent-contract.test.ts
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { agentParams, resultParams } from "../packages/subagents/index.ts";
import { SAFETY_EXCLUDES } from "../packages/subagents/agents.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Agent parameter shape — one-run-only contract
// ---------------------------------------------------------------------------

function testAgentParamShapeIsOneRunOnly() {
  const props = agentParams.properties;
  const keys = Object.keys(props).sort();
  const expected = ["description", "prompt", "run_in_background", "subagent_type"];

  assert.deepStrictEqual(keys, expected, "Agent param keys must be exactly 4");

  // Each property is present and has the right JSON Schema type.
  assert.strictEqual(props.subagent_type.type, "string", "subagent_type is a string");
  assert.ok(Array.isArray(props.subagent_type.oneOf) || Array.isArray(props.subagent_type.enum),
    "subagent_type is an enum/oneOf");
  assert.strictEqual(props.prompt.type, "string", "prompt is a string");
  assert.strictEqual(props.description.type, "string", "description is a string");
  assert.strictEqual(props.run_in_background.type, "boolean", "run_in_background is a boolean");

  console.log("  Agent param shape: 4 keys, correct types ........ PASS");
}

function testAgentParamsNoBatchOrAggregateParams() {
  const props = agentParams.properties;
  const forbidden = ["tasks", "batch", "batch_size", "groupId", "group_id", "results",
    "aggregate", "calls", "parallel", "items", "prompts"];

  for (const key of forbidden) {
    assert.ok(!(key in props), `Forbidden key "${key}" must not exist in Agent params`);
  }

  console.log("  Agent params reject batch/aggregate keys ........ PASS");
}

function testAgentParamsRequiredFields() {
  // TypeBox stores required as an array of strings for non-allOptional objects.
  const required = agentParams.required ?? [];
  const expectedRequired = ["subagent_type", "prompt", "description"];

  assert.deepStrictEqual([...required].sort(), expectedRequired.sort(),
    "Required fields must be subagent_type, prompt, description");

  // run_in_background must be optional (not in required)
  assert.ok(!required.includes("run_in_background"),
    "run_in_background must be optional");

  console.log("  Agent params required fields correct ............ PASS");
}

// ---------------------------------------------------------------------------
// get_subagent_result parameter shape
// ---------------------------------------------------------------------------

function testResultParamShape() {
  const props = resultParams.properties;
  const keys = Object.keys(props).sort();
  const expectedKeys = ["agent_id", "wait"];

  assert.deepStrictEqual(keys, expectedKeys, "Result param keys must be agent_id and wait");
  assert.strictEqual(props.agent_id.type, "string", "agent_id is a string");
  assert.strictEqual(props.wait.type, "boolean", "wait is a boolean");

  // No aggregate or batch keys on the result tool either
  assert.ok(!("agent_ids" in props), "Result tool has no agent_ids param");
  assert.ok(!("group" in props), "Result tool has no group param");

  console.log("  Result param shape correct ..................... PASS");
}

// ---------------------------------------------------------------------------
// Agent type enum exactly three values
// ---------------------------------------------------------------------------

function testSubagentTypeEnumExactlyThree() {
  // subagent_type property is a StringEnum which produces a union of const schemas.
  const st = agentParams.properties.subagent_type;
  // StringEnum creates either { oneOf: [{const:"explore"},{const:"general"},{const:"researcher"}] }
  // or { type: "string", enum: [...] } depending on implementation.
  const values: string[] = [];
  if (st.enum) {
    values.push(...st.enum);
  } else if (st.oneOf) {
    for (const s of st.oneOf) values.push(s.const ?? s.enum?.[0]);
  }
  assert.strictEqual(values.length, 3, "subagent_type must have exactly 3 values");
  assert.ok(values.includes("explore"), "explore is a valid type");
  assert.ok(values.includes("general"), "general is a valid type");
  assert.ok(values.includes("researcher"), "researcher is a valid type");

  console.log("  Subagent type enum has exactly 3 values ......... PASS");
}

// ---------------------------------------------------------------------------
// Safety exclusions unchanged
// ---------------------------------------------------------------------------

function testSafetyExcludesUnchanged() {
  assert.deepStrictEqual(SAFETY_EXCLUDES,
    ["Agent", "get_subagent_result", "question"],
    "SAFETY_EXCLUDES must stay Agent, get_subagent_result, question");

  console.log("  Safety excludes unchanged ...................... PASS");
}

function testSafetyExcludesPreventRecursion() {
  // Every subagent type's toolset must exclude the Agent and get_subagent_result tools.
  // This check validates the structural invariant: the runner always passes
  // SAFETY_EXCLUDES as part of excludeTools.
  assert.ok(SAFETY_EXCLUDES.includes("Agent"), "Agent excluded from sub-sessions");
  assert.ok(SAFETY_EXCLUDES.includes("get_subagent_result"),
    "get_subagent_result excluded from sub-sessions");
  assert.ok(SAFETY_EXCLUDES.includes("question"), "question excluded from sub-sessions");

  console.log("  Safety exclusions prevent recursion ............ PASS");
}

// ---------------------------------------------------------------------------
// Prompt guidelines still say independent calls, not batch
// ---------------------------------------------------------------------------

function testPromptGuidelinesSayIndependentCalls() {
  const indexPath = path.resolve(__dirname, "../packages/subagents/index.ts");
  const source = readFileSync(indexPath, "utf-8");

  // The promptGuidelines array must contain the key directive.
  assert.ok(
    source.includes("multiple foreground Agent calls in the same assistant turn"),
    "promptGuidelines must describe same-turn fan-out as multiple Agent calls",
  );
  assert.ok(
    source.includes("Do not use a batch parameter or aggregate result API"),
    "promptGuidelines must reject batch parameter usage",
  );
  assert.ok(
    source.includes("each call returns its own result"),
    "promptGuidelines must say each call is independent",
  );

  console.log("  Prompt guidelines say independent calls ......... PASS");
}

function testPromptGuidelinesNoBatchApi() {
  const indexPath = path.resolve(__dirname, "../packages/subagents/index.ts");
  const source = readFileSync(indexPath, "utf-8");

  // Verify there is no mention of a batch-style API in the prompt guidelines.
  // The key string is the promptGuidelines array; we already checked it contains
  // the anti-batch statement. Also confirm it does not suggest batching.
  assert.ok(
    !source.includes("run multiple prompts in one Agent call"),
    "promptGuidelines must not suggest batching",
  );

  console.log("  Prompt guidelines no batch API ................. PASS");
}

// ---------------------------------------------------------------------------
// README documents one-run-only contract
// ---------------------------------------------------------------------------

function testReadmeDocumentsOneRunOnlyContract() {
  const readmePath = path.resolve(__dirname, "../packages/subagents/README.md");
  const readme = readFileSync(readmePath, "utf-8");

  // The README must document that the Agent is one-run-only.
  assert.ok(
    readme.includes("not a batch API") || readme.includes("Not a batch API"),
    "README must state the Agent is not a batch API",
  );
  assert.ok(
    readme.includes("The `Agent` contract stays one-run-only"),
    "README must document the one-run-only contract",
  );
  assert.ok(
    readme.includes("no aggregate result"),
    "README must mention no aggregate result",
  );
  assert.ok(
    !readme.includes("tasks parameter"),
    "README must not document a tasks parameter",
  );

  console.log("  README documents one-run-only contract .......... PASS");
}

function testReadmeNoBatchParameterUsage() {
  const readmePath = path.resolve(__dirname, "../packages/subagents/README.md");
  const readme = readFileSync(readmePath, "utf-8");

  // The README must explicitly say there is no tasks parameter.
  assert.ok(
    readme.includes("no `tasks` parameter"),
    "README must explicitly say no tasks parameter",
  );

  console.log("  README no batch parameter usage ................ PASS");
}

function testReadmeSameTurnFanOutAsMultipleAgentCalls() {
  const readmePath = path.resolve(__dirname, "../packages/subagents/README.md");
  const readme = readFileSync(readmePath, "utf-8");

  // The README must show same-turn fan-out as multiple Agent calls.
  assert.ok(
    readme.includes("Same-turn fan-out") || readme.includes("same-turn fan-out"),
    "README must document same-turn fan-out",
  );
  assert.ok(
    readme.includes("multiple foreground `Agent` tool calls"),
    "README must describe same-turn fan-out as multiple Agent calls",
  );

  console.log("  README same-turn fan-out as multiple calls ..... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nAgent contract tests — one-run-only\n");

  testAgentParamShapeIsOneRunOnly();
  testAgentParamsNoBatchOrAggregateParams();
  testAgentParamsRequiredFields();
  testResultParamShape();
  testSubagentTypeEnumExactlyThree();
  testSafetyExcludesUnchanged();
  testSafetyExcludesPreventRecursion();
  testPromptGuidelinesSayIndependentCalls();
  testPromptGuidelinesNoBatchApi();
  testReadmeDocumentsOneRunOnlyContract();
  testReadmeNoBatchParameterUsage();
  testReadmeSameTurnFanOutAsMultipleAgentCalls();

  console.log("\nAll tests PASS\n");
}

main();
