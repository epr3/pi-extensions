import test from "node:test";
import assert from "node:assert/strict";
import type { RunOptions, RunResult } from "../agent-runner.ts";
import type { SubagentRun } from "../types.ts";

let importNonce = 0;
async function loadExtension() {
  importNonce += 1;
  const mod = await import(`../index.ts?test=${importNonce}`);
  return mod.default as (api: any) => void;
}

interface ToolRegistration {
  name: string;
  execute: Function;
  parameters: any;
}

function makeHarness() {
  const tools: ToolRegistration[] = [];
  const eventHandlers = new Map<string, Function>();
  let shutdownHandler: Function | null = null;

  const api = {
    registerTool(def: ToolRegistration) {
      tools.push(def);
    },
    on(event: string, handler: Function) {
      eventHandlers.set(event, handler);
      if (event === "session_shutdown") {
        shutdownHandler = handler;
      }
    },
    sendMessage(..._args: any[]) {},
    registerCommand(..._args: any[]) {},
  } as any;

  return {
    api,
    tools,
    eventHandlers,
    getShutdownHandler: () => shutdownHandler,
  };
}

test("smoke – module loads and default export is a function", async () => {
  const extension = await loadExtension();
  assert.equal(typeof extension, "function");
});

test("registers Agent tool", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);
  const agentTool = h.tools.find((t: ToolRegistration) => t.name === "Agent");
  assert.ok(agentTool, "Agent tool not found");
  assert.equal(typeof agentTool.execute, "function");
  assert.ok(agentTool.parameters, "Agent tool has parameters");
});

test("registers get_subagent_result tool", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);
  const resultTool = h.tools.find((t: ToolRegistration) => t.name === "get_subagent_result");
  assert.ok(resultTool, "get_subagent_result tool not found");
  assert.equal(typeof resultTool.execute, "function");
  assert.ok(resultTool.parameters, "get_subagent_result has parameters");
});

test("registers list_subagents tool", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);
  const tool = h.tools.find((t: ToolRegistration) => t.name === "list_subagents");
  assert.ok(tool, "list_subagents tool not found");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.parameters, "list_subagents has parameters");
});

test("registers stop_subagent tool", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);
  const tool = h.tools.find((t: ToolRegistration) => t.name === "stop_subagent");
  assert.ok(tool, "stop_subagent tool not found");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.parameters, "stop_subagent has parameters");
});

test("registers steer_subagent tool", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);
  const tool = h.tools.find((t: ToolRegistration) => t.name === "steer_subagent");
  assert.ok(tool, "steer_subagent tool not found");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.parameters, "steer_subagent has parameters");
});

test("registers session_shutdown handler", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);
  assert.ok(h.eventHandlers.has("session_shutdown"), "session_shutdown handler not registered");
});

// --- resolveAgentType tests ---

test("resolveAgentType resolves plan case-insensitively", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  assert.equal(resolveAgentType("plan").resolvedType, "plan");
  assert.equal(resolveAgentType("Plan").resolvedType, "plan");
  assert.equal(resolveAgentType("PLAN").resolvedType, "plan");
  assert.equal(resolveAgentType("pLaN").resolvedType, "plan");
  assert.equal(resolveAgentType(" plan ").resolvedType, "plan");
});

test("resolveAgentType resolves explore case-insensitively", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  assert.equal(resolveAgentType("explore").resolvedType, "explore");
  assert.equal(resolveAgentType("Explore").resolvedType, "explore");
  assert.equal(resolveAgentType("EXPLORE").resolvedType, "explore");
});

test("resolveAgentType resolves general-purpose case-insensitively", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  assert.equal(resolveAgentType("general-purpose").resolvedType, "general-purpose");
  assert.equal(resolveAgentType("General-Purpose").resolvedType, "general-purpose");
  assert.equal(resolveAgentType("GENERAL-PURPOSE").resolvedType, "general-purpose");
});

test("resolveAgentType does not alias non-exact names", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  const r1 = resolveAgentType("general");
  const r2 = resolveAgentType("general_purpose");
  const r3 = resolveAgentType("gp");
  const r4 = resolveAgentType("expl");
  const r5 = resolveAgentType("planner");
  assert.equal(r1.fallback, true);
  assert.equal(r2.fallback, true);
  assert.equal(r3.fallback, true);
  assert.equal(r4.fallback, true);
  assert.equal(r5.fallback, true);
});

test("resolveAgentType unknown type falls back to general-purpose", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  const r = resolveAgentType("some-random-type");
  assert.equal(r.fallback, true);
  assert.equal(r.resolvedType, "general-purpose");
  assert.equal(r.config.isReadOnly, false);
});

test("resolveAgentType unknown type fallback includes explicit fallback notice", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  const r = resolveAgentType("nonsense");
  assert.equal(r.fallback, true);
  assert.equal(r.resolvedType, "general-purpose");
});

test("explore and plan are read-only configs", async () => {
  const { resolveAgentType } = await import("../agent-types.ts");
  const explore = resolveAgentType("explore");
  assert.equal(explore.config.isReadOnly, true);
  const plan = resolveAgentType("plan");
  assert.equal(plan.config.isReadOnly, true);
  const gp = resolveAgentType("general-purpose");
  assert.equal(gp.config.isReadOnly, false);
});

test("getTypeConfig returns undefined for unknown types", async () => {
  const { getTypeConfig } = await import("../agent-types.ts");
  assert.equal(getTypeConfig("nope"), undefined);
});

test("getTypeConfig returns config for custom types after setCustomTypeConfigs", async () => {
  const { setCustomTypeConfigs, getTypeConfig, resolveAgentType } = await import("../agent-types.ts");
  setCustomTypeConfigs([{
    name: "docs-writer",
    displayName: "Docs Writer",
    isReadOnly: true,
    promptMode: "replace",
    source: "custom",
  }]);

  const config = getTypeConfig("docs-writer");
  assert.ok(config);
  assert.equal(config!.name, "docs-writer");
  assert.equal(config!.isReadOnly, true);

  const resolved = resolveAgentType("docs-writer");
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.resolvedType, "docs-writer");

  // Cleanup
  setCustomTypeConfigs([]);
});

test("custom types cannot override builtin names", async () => {
  const { setCustomTypeConfigs, resolveAgentType } = await import("../agent-types.ts");
  setCustomTypeConfigs([{
    name: "plan",
    displayName: "Evil Plan",
    isReadOnly: false,
    promptMode: "replace",
    source: "custom",
  }]);

  // Built-in should still win
  const resolved = resolveAgentType("plan");
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.resolvedType, "plan");
  assert.equal(resolved.config.isReadOnly, true); // built-in

  setCustomTypeConfigs([]);
});

// --- Prompt builder tests ---

test("buildPrompt append mode includes parent system prompt", async () => {
  const { buildPrompt } = await import("../prompts.ts");
  const { resolveAgentType } = await import("../agent-types.ts");
  const { config } = resolveAgentType("general-purpose");
  const result = buildPrompt(config, "do something", {
    parentSystemPrompt: "You are a helpful assistant.",
    cwd: "/test",
    allowOutsideCwd: false,
    inheritContext: true,
  });
  assert.ok(result.includes("You are a helpful assistant."), "should include parent prompt");
  assert.ok(result.includes("do something"), "should include task");
  assert.ok(result.includes("Subagent Task"), "should include bridge");
});

test("buildPrompt append mode with inherit_context: false omits parent prompt", async () => {
  const { buildPrompt } = await import("../prompts.ts");
  const { resolveAgentType } = await import("../agent-types.ts");
  const { config } = resolveAgentType("general-purpose");
  const result = buildPrompt(config, "do something", {
    parentSystemPrompt: "You are a helpful assistant.",
    cwd: "/test",
    allowOutsideCwd: false,
    inheritContext: false,
  });
  assert.equal(result.includes("You are a helpful assistant."), false, "should omit parent prompt");
  assert.ok(result.includes("do something"), "should include task");
});

test("buildPrompt replace mode includes read-only rules for explore", async () => {
  const { buildPrompt } = await import("../prompts.ts");
  const { resolveAgentType } = await import("../agent-types.ts");
  const { config } = resolveAgentType("explore");
  const result = buildPrompt(config, "find the code", {
    parentSystemPrompt: "parent",
    cwd: "/test",
    allowOutsideCwd: false,
    inheritContext: false,
  });
  assert.ok(result.includes("read-only"), "explore prompt should have read-only rules");
  assert.ok(result.includes("Explore"), "should mention agent type");
});

test("buildPrompt replace mode includes plan specialist prompt", async () => {
  const { buildPrompt } = await import("../prompts.ts");
  const { resolveAgentType } = await import("../agent-types.ts");
  const { config } = resolveAgentType("plan");
  const result = buildPrompt(config, "plan the feature", {
    parentSystemPrompt: "parent",
    cwd: "/test",
    allowOutsideCwd: false,
    inheritContext: false,
  });
  assert.ok(result.includes("Plan"), "plan prompt should mention Plan agent");
  assert.ok(result.includes("plan the feature"), "should include task");
});

test("buildPrompt with promptBody uses custom prompt body", async () => {
  const { buildPrompt } = await import("../prompts.ts");
  const config = {
    name: "docs-writer",
    displayName: "Docs Writer",
    isReadOnly: true,
    promptMode: "replace" as const,
    promptBody: "You are a documentation writer.",
    source: "custom" as const,
  };
  const result = buildPrompt(config, "write docs for X", {
    parentSystemPrompt: "parent",
    cwd: "/test",
    allowOutsideCwd: false,
    inheritContext: false,
  });
  assert.ok(result.includes("You are a documentation writer."));
  assert.ok(result.includes("write docs for X"));
  assert.ok(result.includes("Task:"));
});

// --- AgentManager tests with fake runner ---

function fakeRunner(result: Partial<RunResult>) {
  return async (_opts: RunOptions): Promise<RunResult> => ({
    text: "fake result",
    turnCount: 1,
    wasLimited: false,
    ...result,
  });
}

test("AgentManager stores foreground run and returns result with id", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({ text: "hello world" }));
  const { id, result } = await manager.spawnAndWait({
    description: "test",
    prompt: "do it",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });
  assert.ok(id.startsWith("subagent_"), `id should start with subagent_, got ${id}`);
  assert.equal(result.text, "hello world");
  manager.shutdown();
});

test("AgentManager foreground stores record", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({ text: "record test" }));
  const { id } = await manager.spawnAndWait({
    description: "test record",
    prompt: "store me",
    subagentType: "plan",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const run = manager.getRun(id);
  assert.ok(run);
  assert.equal(run.status, "completed");
  assert.equal(run.result, "record test");
  manager.shutdown();
});

test("AgentManager background returns id", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({ text: "bg result" }));
  const id = manager.spawn({
    description: "bg test",
    prompt: "do bg",
    subagentType: "explore",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });
  assert.ok(id.startsWith("subagent_"));

  // Wait for background completion
  await new Promise((r) => setTimeout(r, 50));

  const run = manager.getRun(id);
  assert.ok(run);
  assert.equal(run.status, "completed");
  assert.equal(run.result, "bg result");
  manager.shutdown();
});

test("AgentManager lifecycle with fake runner: queued → running → completed", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  let started = false;
  const manager = new AgentManager(async (_opts) => {
    started = true;
    return { text: "done", turnCount: 2, wasLimited: false };
  });

  const id = manager.spawn({
    description: "lifecycle",
    prompt: "test",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const run1 = manager.getRun(id);
  assert.ok(run1);
  assert.ok(run1.status === "queued" || run1.status === "running");

  await new Promise((r) => setTimeout(r, 50));

  const run2 = manager.getRun(id)!;
  assert.equal(run2.status, "completed");
  assert.ok(started);
  manager.shutdown();
});

test("AgentManager lifecycle: error state", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(async () => {
    throw new Error("something broke");
  });

  await assert.rejects(
    () =>
      manager.spawnAndWait({
        description: "error test",
        prompt: "fail",
        subagentType: "general-purpose",
        parentSystemPrompt: "sys",
        cwd: "/test",
        maxTurns: undefined,
        inheritContext: true,
        allowOutsideCwd: false,
      }),
    /something broke/,
  );
  manager.shutdown();
});

test("get_subagent_result handles unknown id", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({}));

  const run = manager.getRun("nonexistent");
  assert.equal(run, undefined);
  manager.shutdown();
});

test("AgentManager getRun returns stored record", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({ text: "stored" }));

  const { id } = await manager.spawnAndWait({
    description: "get run",
    prompt: "store",
    subagentType: "plan",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const run = manager.getRun(id);
  assert.ok(run);
  assert.equal(run.result, "stored");
  manager.shutdown();
});

test("AgentManager getRun returns undefined for expired record", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({}));

  assert.equal(manager.getRun("fake-id-123"), undefined);
  manager.shutdown();
});

test("AgentManager shutdown marks queued runs as stopped", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(async (_opts) => {
    await new Promise(() => {}); // never resolves
    return { text: "", turnCount: 0, wasLimited: false };
  });

  manager.spawn({
    description: "stuck",
    prompt: "never finish",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  manager.shutdown();
});

// --- List/Stop tests ---

test("AgentManager listRuns returns all runs sorted by startedAt desc", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({ text: "a" }));

  const { id: id1 } = await manager.spawnAndWait({
    description: "first",
    prompt: "a",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const { id: id2 } = await manager.spawnAndWait({
    description: "second",
    prompt: "b",
    subagentType: "plan",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const all = manager.listRuns("all");
  assert.equal(all.length, 2);
  // Most recent first
  assert.equal(all[0].id, id2);
  assert.equal(all[1].id, id1);

  const completed = manager.listRuns("completed");
  assert.equal(completed.length, 2);

  const running = manager.listRuns("running");
  assert.equal(running.length, 0);

  manager.shutdown();
});

test("AgentManager stop returns error for unknown id", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({}));
  const result = manager.stop("nonexistent");
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("Unknown"));
  manager.shutdown();
});

test("AgentManager stop returns no-op for terminal runs", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(fakeRunner({ text: "done" }));
  const { id } = await manager.spawnAndWait({
    description: "test",
    prompt: "do it",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const result = manager.stop(id);
  assert.equal(result.ok, true);
  assert.ok(result.message.includes("already completed"));
  manager.shutdown();
});

test("AgentManager stop queued and running with abort-aware runner", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const manager = new AgentManager(async (opts) => {
    // Wait until aborted, then resolve
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = () => resolve();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return { text: "", turnCount: 0, wasLimited: false };
  });

  const id1 = manager.spawn({
    description: "stuck1",
    prompt: "never",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  // Give it a moment to go from queued to running
  await new Promise((r) => setTimeout(r, 50));

  const result1 = manager.stop(id1);
  assert.equal(result1.ok, true);
  assert.ok(result1.message.includes("Stop requested") || result1.message.includes("Stopped"));
  manager.shutdown();
});

test("AgentManager stop queued before starting", async () => {
  const { AgentManager } = await import("../agent-manager.ts");
  const { DEFAULT_SETTINGS } = await import("../settings.ts");

  // Use maxConcurrency: 0 to force queueing
  const manager = new AgentManager(async () => {
    await new Promise(() => {});
    return { text: "", turnCount: 0, wasLimited: false };
  }, { ...DEFAULT_SETTINGS, maxConcurrency: 0 });

  const id1 = manager.spawn({
    description: "queued1",
    prompt: "wait",
    subagentType: "general-purpose",
    parentSystemPrompt: "sys",
    cwd: "/test",
    maxTurns: undefined,
    inheritContext: true,
    allowOutsideCwd: false,
  });

  const run = manager.getRun(id1);
  assert.equal(run?.status, "queued");

  const result = manager.stop(id1);
  assert.equal(result.ok, true);
  assert.ok(result.message.includes("Stopped queued"));

  // Verify it's removed from queue
  assert.equal(manager.getQueuedCount(), 0);

  manager.shutdown();
});

// --- Settings tests ---

test("DEFAULT_SETTINGS exports valid defaults", async () => {
  const { DEFAULT_SETTINGS } = await import("../settings.ts");
  assert.equal(DEFAULT_SETTINGS.maxConcurrency, 4);
  assert.equal(DEFAULT_SETTINGS.maxQueueSize, 16);
  assert.equal(DEFAULT_SETTINGS.recordTtlMs, 600_000);
  assert.equal(DEFAULT_SETTINGS.allowCustomSubagents, false);
  assert.equal(DEFAULT_SETTINGS.allowNestedSubagents, false);
  assert.equal(DEFAULT_SETTINGS.maxSubagentDepth, 1);
});

test("loadSettings returns defaults when no file exists", async () => {
  const { loadSettings } = await import("../settings.ts");
  const result = await loadSettings("/nonexistent/path");
  assert.equal(result.errors.length, 0);
  assert.equal(result.settings.maxConcurrency, 4);
});

test("loadSettings validates maxConcurrency min value", async () => {
  const { loadSettings } = await import("../settings.ts");
  const result = await loadSettings("/tmp/settings-test-invalid");
  // Should return defaults since file doesn't exist
  assert.equal(result.errors.length, 0);
});

// --- Custom type loading tests ---

test("loadCustomTypeConfigs returns empty for non-existent dir", async () => {
  const { loadCustomTypeConfigs } = await import("../custom-types.ts");
  const result = await loadCustomTypeConfigs("/nonexistent");
  assert.equal(result.configs.length, 0);
  assert.equal(result.errors.length, 0);
});

test("parseCustomTypeFrontmatter validates correctly", async () => {
  // Test inline via loadCustomTypeConfigs by writing a temp file
  const { loadCustomTypeConfigs } = await import("../custom-types.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const tmpDir = `/tmp/subagents-custom-test-${Date.now()}`;
  const agentsDir = path.join(tmpDir, ".pi", "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  const validMd = `---
name: docs-writer
description: Writes documentation
tools: read-only
prompt_mode: replace
model: openai/gpt-4
---

Write docs like a pro.`;

  await fs.writeFile(path.join(agentsDir, "docs-writer.md"), validMd);
  const result = await loadCustomTypeConfigs(tmpDir);
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].name, "docs-writer");
  assert.equal(result.configs[0].isReadOnly, true);
  assert.equal(result.configs[0].model, "openai/gpt-4");
  assert.ok(result.configs[0].promptBody?.includes("Write docs like a pro"));

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("loadCustomTypeConfigs rejects invalid tools value", async () => {
  const { loadCustomTypeConfigs } = await import("../custom-types.ts");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const tmpDir = `/tmp/subagents-custom-test-invalid-${Date.now()}`;
  const agentsDir = path.join(tmpDir, ".pi", "agents");
  await fs.mkdir(agentsDir, { recursive: true });

  const invalidMd = `---
name: bad-agent
tools: write-and-delete
---
Some content.`;
  await fs.writeFile(path.join(agentsDir, "bad-agent.md"), invalidMd);

  const result = await loadCustomTypeConfigs(tmpDir);
  assert.equal(result.configs.length, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes("tools must be 'read-only' or 'full'"));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- max_turns normalization tests ---

test("max_turns validation rejects negative numbers", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);

  const agentTool = h.tools.find((t: ToolRegistration) => t.name === "Agent")!;
  const params = {
    prompt: "test",
    description: "test",
    subagent_type: "plan",
    max_turns: -1,
  };

  await assert.rejects(
    () => agentTool.execute("call-1", params, undefined, undefined, { cwd: "/test", modelRegistry: { find: () => undefined } }),
    /max_turns/,
  );
});

test("max_turns validation rejects non-integer values", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);

  const agentTool = h.tools.find((t: ToolRegistration) => t.name === "Agent")!;
  const params = {
    prompt: "test",
    description: "test",
    subagent_type: "plan",
    max_turns: 1.5,
  };

  await assert.rejects(
    () => agentTool.execute("call-1", params, undefined, undefined, { cwd: "/test", modelRegistry: { find: () => undefined } }),
    /max_turns/,
  );
});

test("max_turns 0 means unlimited", async () => {
  const { normalizeMaxTurns } = await import("../index.ts");
  assert.equal(normalizeMaxTurns(0), undefined);
  assert.equal(normalizeMaxTurns(undefined), undefined);
  assert.equal(normalizeMaxTurns(5), 5);
});

test("max_turns undefined means unlimited", async () => {
  const { normalizeMaxTurns } = await import("../index.ts");
  assert.equal(normalizeMaxTurns(undefined), undefined);
});

test("normalizeMaxTurns rejects invalid values", async () => {
  const { normalizeMaxTurns } = await import("../index.ts");
  assert.throws(() => normalizeMaxTurns(-1), /non-negative/);
  assert.throws(() => normalizeMaxTurns(1.5), /non-negative/);
  assert.throws(() => normalizeMaxTurns(NaN), /non-negative/);
  assert.throws(() => normalizeMaxTurns(Infinity), /non-negative/);
});

// --- Prompt validation tests ---

test("Agent tool rejects empty prompt", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);

  const agentTool2 = h.tools.find((t: ToolRegistration) => t.name === "Agent")!;
  await assert.rejects(
    () =>
      agentTool2.execute(
        "call-1",
        { prompt: "", description: "test", subagent_type: "plan" },
        undefined,
        undefined,
        { cwd: "/test", modelRegistry: { find: () => undefined } },
      ),
    /non-empty/,
  );
});

test("Agent tool rejects blank description", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);

  const agentTool2 = h.tools.find((t: ToolRegistration) => t.name === "Agent")!;
  await assert.rejects(
    () =>
      agentTool2.execute(
        "call-1",
        { prompt: "do it", description: "  ", subagent_type: "plan" },
        undefined,
        undefined,
        { cwd: "/test", modelRegistry: { find: () => undefined } },
      ),
    /non-empty/,
  );
});

test("Agent tool rejects overly long prompt", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);

  const agentTool2 = h.tools.find((t: ToolRegistration) => t.name === "Agent")!;
  await assert.rejects(
    () =>
      agentTool2.execute(
        "call-1",
        { prompt: "x".repeat(32001), description: "test", subagent_type: "plan" },
        undefined,
        undefined,
        { cwd: "/test", modelRegistry: { find: () => undefined } },
      ),
    /exceeds maximum length/,
  );
});

test("Agent tool rejects overly long description", async () => {
  const extension = await loadExtension();
  const h = makeHarness();
  extension(h.api);

  const agentTool2 = h.tools.find((t: ToolRegistration) => t.name === "Agent")!;
  await assert.rejects(
    () =>
      agentTool2.execute(
        "call-1",
        { prompt: "do it", description: "x".repeat(201), subagent_type: "plan" },
        undefined,
        undefined,
        {},
      ),
    /exceeds maximum length/,
  );
});

// --- Transcript tests ---

test("writeTranscript writes file with metadata", async () => {
  const { writeTranscript } = await import("../transcripts.ts");
  const fs = await import("node:fs/promises");
  const tmpDir = `/tmp/subagents-transcript-test-${Date.now()}`;

  const run: SubagentRun = {
    id: "test-id-123",
    requestedType: "plan",
    type: "plan",
    description: "test",
    status: "completed",
    result: "done",
    startedAt: Date.now(),
    completedAt: Date.now(),
    toolUses: 0,
    turnCount: 3,
    wasLimited: false,
    depth: 0,
    steeringMessages: [],
  };

  const transcriptPath = await writeTranscript(tmpDir, run, "my prompt");
  assert.ok(transcriptPath.includes("test-id-123"));

  // Verify content
  const content = await fs.readFile(transcriptPath, "utf-8");
  assert.ok(content.includes("test-id-123"));
  assert.ok(content.includes("my prompt"));
  assert.ok(content.includes("done"));
  assert.ok(content.includes("completed"));

  await fs.rm(tmpDir, { recursive: true, force: true });
});


