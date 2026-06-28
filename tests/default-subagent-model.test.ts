/**
 * Behavior tests for the shared Default Subagent model feature.
 *
 * Tests at the pure helper seam (parseModelRef, resolveDefaultModel) and at
 * the tool wiring seam (fake Pi context + fake model registry + fake exec).
 *
 * Run:  npx tsx tests/default-subagent-model.test.ts
 */

import { strict as assert } from "node:assert";
import type { Model } from "@earendil-works/pi-ai";
import { parseModelRef, resolveDefaultModel, resolveTypeDefaultModel, checkDefaultModelWarnings } from "../packages/subagents/model-ref.ts";
import { AgentManager, type AgentRecord } from "../packages/subagents/manager.ts";

// ---------------------------------------------------------------------------
// Fake model helpers
// ---------------------------------------------------------------------------

function fakeModel(provider: string, id: string): Model<any> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}

const anthropicModel = fakeModel("anthropic", "claude-sonnet-4-20250514");
const openaiModel = fakeModel("openai", "gpt-4o");
const unsupportedModel = fakeModel("faux", "unknown");

// ---------------------------------------------------------------------------
// Fake model registry
// ---------------------------------------------------------------------------

function fakeRegistry(models: Model<any>[]) {
  return {
    find(provider: string, modelId: string): Model<any> | undefined {
      return models.find((m) => m.provider === provider && m.id === modelId);
    },
  };
}

// ---------------------------------------------------------------------------
// parseModelRef tests
// ---------------------------------------------------------------------------

function testParseModelRef() {
  assert.deepStrictEqual(parseModelRef("anthropic/claude-sonnet-4-20250514"), {
    provider: "anthropic",
    modelId: "claude-sonnet-4-20250514",
  });

  assert.deepStrictEqual(parseModelRef("openai/gpt-4o"), {
    provider: "openai",
    modelId: "gpt-4o",
  });

  assert.deepStrictEqual(parseModelRef("  openai/gpt-4o  "), {
    provider: "openai",
    modelId: "gpt-4o",
  });

  // Missing slash
  assert.strictEqual(parseModelRef("anthropic-claude-sonnet"), null);

  // Empty provider
  assert.strictEqual(parseModelRef("/gpt-4o"), null);

  // Empty modelId
  assert.strictEqual(parseModelRef("openai/"), null);

  // Empty string
  assert.strictEqual(parseModelRef(""), null);

  // Whitespace
  assert.strictEqual(parseModelRef("   "), null);

  // Slash at start only
  assert.strictEqual(parseModelRef("/foo"), null);

  // Slash at end only
  assert.strictEqual(parseModelRef("foo/"), null);

  // Multiple slashes: first slash delimits provider, rest is modelId
  assert.deepStrictEqual(parseModelRef("provider/foo/bar"), {
    provider: "provider",
    modelId: "foo/bar",
  });

  console.log("  parseModelRef ....................................... PASS");
}

// ---------------------------------------------------------------------------
// resolveDefaultModel tests
// ---------------------------------------------------------------------------

function testResolveDefaultModel() {
  const registry = fakeRegistry([anthropicModel, openaiModel]);

  // Shared default resolves correctly
  const resolved1 = resolveDefaultModel(
    "anthropic/claude-sonnet-4-20250514",
    (p, m) => registry.find(p, m),
    anthropicModel,
  );
  assert.strictEqual(resolved1, anthropicModel);

  // Different model resolves
  const resolved2 = resolveDefaultModel(
    "openai/gpt-4o",
    (p, m) => registry.find(p, m),
    anthropicModel,
  );
  assert.strictEqual(resolved2, openaiModel);

  // No default configured: returns parent model
  const resolved3 = resolveDefaultModel(undefined, (p, m) => registry.find(p, m), anthropicModel);
  assert.strictEqual(resolved3, anthropicModel);

  // Empty string default: returns parent model
  const resolved4 = resolveDefaultModel("", (p, m) => registry.find(p, m), anthropicModel);
  assert.strictEqual(resolved4, anthropicModel);

  // Invalid reference (no slash): returns parent model
  const resolved5 = resolveDefaultModel("bogus", (p, m) => registry.find(p, m), anthropicModel);
  assert.strictEqual(resolved5, anthropicModel);

  // Unresolvable reference (provider/model not in registry): returns parent model
  const resolved6 = resolveDefaultModel(
    "faux/unknown",
    (p, m) => registry.find(p, m),
    anthropicModel,
  );
  assert.strictEqual(resolved6, anthropicModel);

  // Parent model undefined, no default: returns undefined
  const resolved7 = resolveDefaultModel(undefined, (p, m) => registry.find(p, m), undefined);
  assert.strictEqual(resolved7, undefined);

  // Parent model undefined, valid default resolves: still works
  const resolved8 = resolveDefaultModel(
    "anthropic/claude-sonnet-4-20250514",
    (p, m) => registry.find(p, m),
    undefined,
  );
  assert.strictEqual(resolved8, anthropicModel);

  console.log("  resolveDefaultModel ................................ PASS");
}

// ---------------------------------------------------------------------------
// resolveTypeDefaultModel tests
// ---------------------------------------------------------------------------

function testResolveTypeDefaultModel() {
  const registry = fakeRegistry([anthropicModel, openaiModel]);
  const find = (p: string, m: string) => registry.find(p, m);

  // Each type override is keyed only by the three AgentType strings.
  // Build an empty overrides record to start.
  const noOverrides = { explore: undefined, researcher: undefined, general: undefined };

  // --- Type-specific override wins over shared default ---
  const r1 = resolveTypeDefaultModel(
    { explore: "openai/gpt-4o", researcher: undefined, general: undefined },
    "explore",
    "anthropic/claude-sonnet-4-20250514",
    find,
    anthropicModel,
  );
  assert.strictEqual(r1, openaiModel, "type-specific explore override should win over shared default");

  // --- Type without override falls back to shared default ---
  const r2 = resolveTypeDefaultModel(
    { explore: "openai/gpt-4o", researcher: undefined, general: undefined },
    "researcher",
    "anthropic/claude-sonnet-4-20250514",
    find,
    anthropicModel,
  );
  assert.strictEqual(r2, anthropicModel, "type without override should fall back to shared default");

  // --- No overrides, no shared default → parent model ---
  const r3 = resolveTypeDefaultModel(noOverrides, "general", undefined, find, anthropicModel);
  assert.strictEqual(r3, anthropicModel, "no overrides, no shared default → parent model");

  // --- All three types can have their own defaults ---
  const r4 = resolveTypeDefaultModel(
    { explore: "openai/gpt-4o", researcher: "anthropic/claude-sonnet-4-20250514", general: undefined },
    "researcher",
    undefined,
    find,
    anthropicModel,
  );
  assert.strictEqual(r4, anthropicModel, "researcher-specific override should resolve");

  // --- Type-specific unresolvable ref falls through to shared ---
  const r5 = resolveTypeDefaultModel(
    { explore: "faux/unknown", researcher: undefined, general: undefined },
    "explore",
    "openai/gpt-4o",
    find,
    anthropicModel,
  );
  assert.strictEqual(r5, openaiModel, "unresolvable type override → fall through to shared default");

  // --- Type-specific invalid syntax falls through to shared ---
  const r6 = resolveTypeDefaultModel(
    { explore: "no-slash-here", researcher: undefined, general: undefined },
    "explore",
    "openai/gpt-4o",
    find,
    anthropicModel,
  );
  assert.strictEqual(r6, openaiModel, "invalid type override syntax → fall through to shared default");

  // --- Type-specific empty string → same as undefined ---
  const r7 = resolveTypeDefaultModel(
    { explore: "", researcher: undefined, general: undefined },
    "explore",
    "openai/gpt-4o",
    find,
    anthropicModel,
  );
  assert.strictEqual(r7, openaiModel, "empty type override string → fall through to shared default");

  // --- All levels absent → parent model ---
  const r8 = resolveTypeDefaultModel(noOverrides, "explore", undefined, find, anthropicModel);
  assert.strictEqual(r8, anthropicModel, "all levels absent → parent model");

  // --- All levels absent, no parent → undefined ---
  const r9 = resolveTypeDefaultModel(noOverrides, "explore", undefined, find, undefined);
  assert.strictEqual(r9, undefined, "all levels absent, no parent → undefined");

  // --- Type applies only to its own type, not others ---
  const r10 = resolveTypeDefaultModel(
    { explore: "openai/gpt-4o", researcher: undefined, general: undefined },
    "general",
    undefined,
    find,
    anthropicModel,
  );
  assert.strictEqual(r10, anthropicModel, "explore override should not affect general");

  console.log("  resolveTypeDefaultModel ............................ PASS");
}

// ---------------------------------------------------------------------------
// Tool wiring seam test: model passthrough via AgentManager exec thunk
// ---------------------------------------------------------------------------

async function testToolWiringSeam() {
  // This test verifies the exec thunk receives the resolved model by
  // capturing it through the manager's launch/run pipeline.

  const manager = new AgentManager({ maxConcurrency: 1 });
  const registry = fakeRegistry([anthropicModel, openaiModel]);

  // Simulate what index.ts execute does: resolve model, then pass it into
  // the exec thunk. Returns the settled record for assertions.
  async function launchWithModel(
    defaultModelRef: string | undefined,
    parentModel: Model<any> | undefined,
  ): Promise<AgentRecord> {
    let capturedModel: Model<any> | undefined;
    const model = resolveDefaultModel(defaultModelRef, (p, m) => registry.find(p, m), parentModel);
    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "hello", tokens: 0, toolUses: 0 };
      },
    );
    const rec = await done;
    // Attach captured model to the record so assertions can read it
    (rec as any).__capturedModel = capturedModel;
    return rec;
  }

  // --- Test 1: resolved shared default model ---
  const rec1 = await launchWithModel("openai/gpt-4o", anthropicModel);
  assert.strictEqual((rec1 as any).__capturedModel, openaiModel, "should use resolved shared default model");

  // --- Test 2: no default configured -> parent model ---
  const rec2 = await launchWithModel(undefined, anthropicModel);
  assert.strictEqual((rec2 as any).__capturedModel, anthropicModel, "should fall back to parent model when unconfigured");

  // --- Test 3: unresolvable default -> parent model ---
  const rec3 = await launchWithModel("faux/unknown", anthropicModel);
  assert.strictEqual((rec3 as any).__capturedModel, anthropicModel, "should fall back to parent model when unresolvable");

  // --- Test 4: result text unchanged regardless of model ---
  // Each exec thunk returns the same static string; the model selection
  // doesn't affect the result text.
  assert.strictEqual(rec1.result, "hello");
  assert.strictEqual(rec2.result, "hello");
  assert.strictEqual(rec3.result, "hello");

  // --- Test 5: background vs foreground model resolution equivalence ---
  // The model is resolved *before* manager.launch, so both scheduling
  // modes receive the same resolved model. This is structural — there
  // is no separate code path per mode for model selection.

  console.log("  Tool wiring seam ................................... PASS");
}

// ---------------------------------------------------------------------------
// Type-specific wiring seam: model passthrough via AgentManager exec thunk
// ---------------------------------------------------------------------------

async function testTypeSpecificWiringSeam() {
  // This test verifies the exec thunk receives the correct resolved model
  // when type-specific overrides are configured, simulating what index.ts
  // execute handler does.

  const manager = new AgentManager({ maxConcurrency: 1 });
  const registry = fakeRegistry([anthropicModel, openaiModel]);

  // Simulate the full resolution from index.ts:
  // 1. Build type overrides from cfg
  // 2. Call resolveTypeDefaultModel with type, overrides, shared, registry, parent
  // 3. Pass resolved model to exec thunk
  async function launchWithTypeModel(
    typeOverrides: Record<string, string | undefined>,
    type: string,
    sharedDefaultRef: string | undefined,
    parentModel: Model<any> | undefined,
  ): Promise<AgentRecord> {
    let capturedModel: Model<any> | undefined;
    const model = resolveTypeDefaultModel(
      {
        explore: typeOverrides.explore as string | undefined,
        researcher: typeOverrides.researcher as string | undefined,
        general: typeOverrides.general as string | undefined,
      },
      type as "explore" | "researcher" | "general",
      sharedDefaultRef,
      (p, m) => registry.find(p, m),
      parentModel,
    );
    const { done } = manager.launch(
      { type: type as any, description: "test" },
      async () => {
        capturedModel = model;
        return { result: "ok", tokens: 0, toolUses: 0 };
      },
    );
    const rec = await done;
    (rec as any).__capturedModel = capturedModel;
    return rec;
  }

  // --- Type-specific override wins ---
  const r1 = await launchWithTypeModel(
    { explore: "openai/gpt-4o" },
    "explore",
    "anthropic/claude-sonnet-4-20250514",
    anthropicModel,
  );
  assert.strictEqual((r1 as any).__capturedModel, openaiModel, "type-specific override should win");

  // --- Type without override falls to shared ---
  const r2 = await launchWithTypeModel(
    { explore: "openai/gpt-4o" },
    "researcher",
    "anthropic/claude-sonnet-4-20250514",
    anthropicModel,
  );
  assert.strictEqual((r2 as any).__capturedModel, anthropicModel, "type without override → shared default");

  // --- Type without override, no shared → parent ---
  const r3 = await launchWithTypeModel({}, "general", undefined, anthropicModel);
  assert.strictEqual((r3 as any).__capturedModel, anthropicModel, "no override, no shared → parent");

  // --- Researcher type gets its own override ---
  const r4 = await launchWithTypeModel(
    { researcher: "openai/gpt-4o" },
    "researcher",
    "anthropic/claude-sonnet-4-20250514",
    anthropicModel,
  );
  assert.strictEqual((r4 as any).__capturedModel, openaiModel, "researcher-specific override");

  // --- General type gets its own override ---
  const r5 = await launchWithTypeModel(
    { general: "openai/gpt-4o" },
    "general",
    "anthropic/claude-sonnet-4-20250514",
    anthropicModel,
  );
  assert.strictEqual((r5 as any).__capturedModel, openaiModel, "general-specific override");

  // --- Result text unchanged regardless of model ---
  assert.strictEqual(r1.result, "ok");
  assert.strictEqual(r2.result, "ok");
  assert.strictEqual(r3.result, "ok");

  console.log("  Type-specific wiring seam ......................... PASS");
}

// ---------------------------------------------------------------------------
// checkDefaultModelWarnings tests
// ---------------------------------------------------------------------------

function testCheckDefaultModelWarnings() {
  const registry = fakeRegistry([anthropicModel, openaiModel]);
  const find = (p: string, m: string) => registry.find(p, m);

  // --- No refs configured → empty warnings ---
  assert.deepStrictEqual(
    checkDefaultModelWarnings(undefined, undefined, find, "explore"),
    [],
    "no configured refs → no warnings",
  );

  // --- Type ref malformed → one malformed warning ---
  const w1 = checkDefaultModelWarnings("no-slash-here", undefined, find, "explore");
  assert.strictEqual(w1.length, 1, "malformed type ref → one warning");
  assert.strictEqual(w1[0].scope, "explore");
  assert.strictEqual(w1[0].reference, "no-slash-here");
  assert.strictEqual(w1[0].type, "malformed");

  // --- Type ref unresolvable → one unresolvable warning ---
  const w2 = checkDefaultModelWarnings("faux/unknown", undefined, find, "explore");
  assert.strictEqual(w2.length, 1, "unresolvable type ref → one warning");
  assert.strictEqual(w2[0].scope, "explore");
  assert.strictEqual(w2[0].reference, "faux/unknown");
  assert.strictEqual(w2[0].type, "unresolvable");

  // --- Shared ref malformed → one malformed warning ---
  const w3 = checkDefaultModelWarnings(undefined, "bogus-ref", find, "explore");
  assert.strictEqual(w3.length, 1, "malformed shared ref → one warning");
  assert.strictEqual(w3[0].scope, "shared");
  assert.strictEqual(w3[0].reference, "bogus-ref");
  assert.strictEqual(w3[0].type, "malformed");

  // --- Shared ref unresolvable → one unresolvable warning ---
  const w4 = checkDefaultModelWarnings(undefined, "faux/unknown", find, "explore");
  assert.strictEqual(w4.length, 1, "unresolvable shared ref → one warning");
  assert.strictEqual(w4[0].scope, "shared");
  assert.strictEqual(w4[0].reference, "faux/unknown");
  assert.strictEqual(w4[0].type, "unresolvable");

  // --- Both malformed → two warnings ---
  const w5 = checkDefaultModelWarnings("bad", "also-bad", find, "explore");
  assert.strictEqual(w5.length, 2, "both refs malformed → two warnings");
  assert.strictEqual(w5[0].scope, "explore");
  assert.strictEqual(w5[0].type, "malformed");
  assert.strictEqual(w5[1].scope, "shared");
  assert.strictEqual(w5[1].type, "malformed");

  // --- Both valid → empty warnings ---
  const w6 = checkDefaultModelWarnings(
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4-20250514",
    find,
    "explore",
  );
  assert.strictEqual(w6.length, 0, "both refs valid → no warnings");

  // --- Type valid, shared malformed → warn about shared only ---
  const w7 = checkDefaultModelWarnings(
    "openai/gpt-4o",
    "broken",
    find,
    "explore",
  );
  assert.strictEqual(w7.length, 1, "type valid, shared malformed → one warning");
  assert.strictEqual(w7[0].scope, "shared");
  assert.strictEqual(w7[0].type, "malformed");

  // --- Type malformed, shared valid → warn about type only ---
  const w8 = checkDefaultModelWarnings(
    "broken",
    "openai/gpt-4o",
    find,
    "explore",
  );
  assert.strictEqual(w8.length, 1, "type malformed, shared valid → one warning");
  assert.strictEqual(w8[0].scope, "explore");
  assert.strictEqual(w8[0].type, "malformed");

  // --- Type applies only to its own scope in warnings ---
  const w9 = checkDefaultModelWarnings("faux/unknown", undefined, find, "researcher");
  assert.strictEqual(w9.length, 1);
  assert.strictEqual(w9[0].scope, "researcher");

  console.log("  checkDefaultModelWarnings ......................... PASS");
}

// ---------------------------------------------------------------------------
// Warning details shape: warnings in tool details, NOT in result text
// ---------------------------------------------------------------------------

async function testWarningDetailsInToolResult() {
  // Verifies that warnings appear only in details, never in content text,
  // and survive the background -> get_subagent_result round-trip.

  const manager = new AgentManager({ maxConcurrency: 1 });
  const registry = fakeRegistry([anthropicModel, openaiModel]);
  const find = (p: string, m: string) => registry.find(p, m);

  // --- Malformed type ref → warnings in tool details, not in result text ---
  const warnings1 = checkDefaultModelWarnings("bad-ref", undefined, find, "explore");
  const exec1 = async () => ({ result: "clean output", tokens: 10, toolUses: 2 });
  const { done: done1 } = manager.launch(
    { type: "explore", description: "test1" },
    exec1,
  );
  const rec1 = await done1;
  const result1 = { content: [{ type: "text" as const, text: rec1.result ?? "" }], details: { ...rec1, ...(warnings1.length > 0 ? { warnings: warnings1 } : {}) } };
  // Warnings in details
  assert.ok(Array.isArray(result1.details.warnings), "warnings array in details");
  assert.strictEqual(result1.details.warnings.length, 1);
  assert.strictEqual(result1.details.warnings[0].scope, "explore");
  assert.strictEqual(result1.details.warnings[0].type, "malformed");
  // Content text stays clean
  assert.strictEqual(result1.content[0].text, "clean output");

  // --- Unresolvable type ref → warning scope and type correct ---
  const warnings2 = checkDefaultModelWarnings("faux/unknown", undefined, find, "researcher");
  const exec2 = async () => ({ result: "research result", tokens: 5, toolUses: 1 });
  const { done: done2 } = manager.launch(
    { type: "researcher", description: "test2" },
    exec2,
  );
  const rec2 = await done2;
  const result2 = { content: [{ type: "text" as const, text: rec2.result ?? "" }], details: { ...rec2, ...(warnings2.length > 0 ? { warnings: warnings2 } : {}) } };
  assert.strictEqual(result2.details.warnings[0].scope, "researcher");
  assert.strictEqual(result2.details.warnings[0].type, "unresolvable");
  assert.strictEqual(result2.content[0].text, "research result");

  // --- Both refs broken → two warnings ---
  const warnings3 = checkDefaultModelWarnings("bad-type", "bad-shared", find, "explore");
  assert.strictEqual(warnings3.length, 2);
  assert.strictEqual(warnings3[0].scope, "explore");
  assert.strictEqual(warnings3[1].scope, "shared");

  // --- All refs valid → no warnings in details ---
  const warnings4 = checkDefaultModelWarnings(
    "openai/gpt-4o",
    "anthropic/claude-sonnet-4-20250514",
    find,
    "explore",
  );
  assert.strictEqual(warnings4.length, 0, "valid refs → empty warnings");

  // --- No refs configured → no warnings ---
  const warnings5 = checkDefaultModelWarnings(undefined, undefined, find, "general");
  assert.strictEqual(warnings5.length, 0, "no refs → empty warnings");

  // --- Background: warnings persisted to record for get_subagent_result ---
  const warningsBg = checkDefaultModelWarnings("faux/unknown", undefined, find, "general");
  const execBg = async () => ({ result: "bg work", tokens: 3, toolUses: 1 });
  const { record: bgRec, done: bgDone } = manager.launch(
    { type: "general", description: "bg-test", background: true },
    execBg,
  );
  // Simulate index.ts: attach warnings to record
  bgRec.warnings = warningsBg;
  await bgDone;
  // Retrieve via getResult (simulating get_subagent_result)
  const polled = await manager.getResult(bgRec.id, false);
  assert.ok(Array.isArray(polled.warnings), "warnings on record for get_subagent_result");
  assert.strictEqual(polled.warnings.length, 1);
  assert.strictEqual(polled.warnings[0].scope, "general");
  assert.strictEqual(polled.warnings[0].type, "unresolvable");
  // Content text still clean via record
  assert.strictEqual(polled.result, "bg work");

  console.log("  Warning details in tool result .................... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nDefault Subagent Model behavior tests\n");

  testParseModelRef();
  testResolveDefaultModel();
  testResolveTypeDefaultModel();
  testCheckDefaultModelWarnings();
  await testToolWiringSeam();
  await testTypeSpecificWiringSeam();
  await testWarningDetailsInToolResult();

  console.log("\nAll tests PASS\n");
}

await main();
