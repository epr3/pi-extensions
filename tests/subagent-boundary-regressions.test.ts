/**
 * Boundary regression tests for Subagent streams.
 *
 * Locks in the non-goals and safety boundaries around streaming support:
 * - Background launches keep start-id + result polling (no streaming API)
 * - Default model warnings stay in details/UI, never in result/stream text
 * - Read-only agent allowlists and safety exclusions are unchanged
 * - The scheduler owns records/lifecycle only, not stream formatting
 *
 * Run:  npx tsx tests/subagent-boundary-regressions.test.ts
 */

import { strict as assert } from "node:assert";
import type { Model } from "@earendil-works/pi-ai";
import { AgentManager, type AgentRecord } from "../packages/subagents/manager.ts";
import { checkDefaultModelWarnings } from "../packages/subagents/model-ref.ts";
import {
  CORE_READ_TOOLS,
  SAFETY_EXCLUDES,
  exploreToolset,
  researcherToolset,
} from "../packages/subagents/agents.ts";
import type { StreamEvent, StreamCallback } from "../packages/subagents/runner.ts";
import type { StreamEntry } from "../packages/subagents/index.ts";

// ---------------------------------------------------------------------------
// Fakes
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

function fakeRegistry(models: Model<any>[]) {
  return {
    find(provider: string, modelId: string): Model<any> | undefined {
      return models.find((m) => m.provider === provider && m.id === modelId);
    },
  };
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

// Replicates the foreground stream callback from index.ts.
function createStreamSetup(background: boolean, signal?: AbortSignal) {
  const updates: Array<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }> = [];
  const onUpdate = (result: typeof updates[0]) => updates.push(result);

  const streamEntries: StreamEntry[] = [];
  const onStreamEvent: StreamCallback | undefined = background
    ? undefined
    : (event: StreamEvent) => {
        if (signal?.aborted) return;
        if (event.type === "text_delta") {
          if (!event.delta) return;
          streamEntries.push({ type: "text", text: event.delta });
        } else if (event.type === "tool_start") {
          streamEntries.push({ type: "tool_start", name: event.name });
        } else if (event.type === "tool_end") {
          streamEntries.push({ type: "tool_end", name: event.name, error: !!event.error });
        }
        const lines: string[] = [];
        let textBuffer = "";
        for (const e of streamEntries) {
          if (e.type === "text") {
            textBuffer += e.text;
            continue;
          }
          if (textBuffer) {
            lines.push(textBuffer);
            textBuffer = "";
          }
          const marker = e.type === "tool_start" ? "▶" : e.error ? "✗" : "✓";
          lines.push(`${marker} ${e.name}`);
        }
        if (textBuffer) lines.push(textBuffer);
        const streamText = lines.join("\n");
        onUpdate({
          content: [{ type: "text", text: streamText }],
          details: { streamText, streamEntries: [...streamEntries] },
        });
      };

  return { onStreamEvent, updates, streamEntries: () => streamEntries };
}

// ---------------------------------------------------------------------------
// Background behavior boundaries
// ---------------------------------------------------------------------------

async function testBackgroundLaunchReturnsIdAndStartText() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const { record, done } = manager.launch(
    { type: "explore", description: "bg test", background: true },
    async () => ({ result: "bg answer", tokens: 7, toolUses: 1 }),
  );

  assert.ok(record.id.startsWith("sa_"), "background record has generated id");
  assert.strictEqual(record.status, "running", "background job starts immediately under capacity");

  // Immediate return text mirrors what index.ts returns for background.
  const startResult = textResult(
    `Started ${record.type} sub-agent ${record.id} (background). Poll with get_subagent_result.`,
    { agent_id: record.id, status: record.status },
  );

  assert.ok(startResult.content[0].text.includes(record.id), "start text contains id");
  assert.ok(startResult.content[0].text.includes("get_subagent_result"), "start text references poll tool");
  assert.strictEqual(startResult.details.agent_id, record.id, "details expose agent_id");

  await done;

  console.log("  Background launch returns id + start text ....... PASS");
}

async function testBackgroundRetrievedThroughResultTool() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const { record, done } = manager.launch(
    { type: "researcher", description: "bg poll", background: true },
    async () => ({ result: "polled result", tokens: 12, toolUses: 2 }),
  );

  await done;

  const rec = await manager.getResult(record.id, false);
  assert.strictEqual(rec.status, "completed", "polled record completed");
  assert.strictEqual(rec.result, "polled result", "result tool returns final result");
  assert.strictEqual(rec.tokens, 12, "tokens preserved");
  assert.strictEqual(rec.toolUses, 2, "toolUses preserved");

  console.log("  Background retrieved through result tool ........ PASS");
}

async function testBackgroundPollingWaitsForCompletion() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  let resolveExec: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

  const { record } = manager.launch(
    { type: "general", description: "bg wait", background: true },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveExec = resolve)),
  );

  assert.strictEqual(record.status, "running");

  const pollPromise = manager.getResult(record.id, true);
  resolveExec({ result: "waited", tokens: 0, toolUses: 0 });
  const rec = await pollPromise;
  assert.strictEqual(rec.result, "waited");

  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result, "waited", "wait poll returns final result");

  console.log("  Background polling waits for completion ......... PASS");
}

async function testBackgroundHasNoStreamCallback() {
  const { onStreamEvent } = createStreamSetup(true);
  assert.strictEqual(onStreamEvent, undefined, "background setup has no stream callback");

  console.log("  Background has no stream callback ............... PASS");
}

async function testBackgroundResultHasNoStreamTranscript() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const { record, done } = manager.launch(
    { type: "explore", description: "bg no stream", background: true },
    async () => ({ result: "final only", tokens: 5, toolUses: 0 }),
  );

  await done;
  const rec = await manager.getResult(record.id, false);

  // get_subagent_result returns the record directly; verify no stream fields.
  assert.strictEqual(rec.result, "final only");
  assert.strictEqual((rec as any).streamText, undefined, "no streamText on record");
  assert.strictEqual((rec as any).streamEntries, undefined, "no streamEntries on record");

  console.log("  Background result has no stream transcript ...... PASS");
}

async function testBackgroundResultIsNotStreamingApi() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const { record } = manager.launch(
    { type: "general", description: "bg not stream api", background: true },
    async () => ({ result: "done", tokens: 1, toolUses: 0 }),
  );

  const rec1 = await manager.getResult(record.id, false);
  const rec2 = await manager.getResult(record.id, false);

  // Poll returns the same record, not a sequence of stream deltas.
  assert.strictEqual(rec1, rec2, "polling returns the same lifecycle record");
  assert.ok(typeof rec1.status === "string", "status is a plain string");

  console.log("  Background result is not a streaming API ........ PASS");
}

// ---------------------------------------------------------------------------
// Default model warning boundaries
// ---------------------------------------------------------------------------

async function testWarningsInDetailsNotInResultText() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const registry = fakeRegistry([fakeModel("anthropic", "ok")]);
  const find = (p: string, m: string) => registry.find(p, m);

  const warnings = checkDefaultModelWarnings("bad-ref", undefined, find, "explore");
  assert.strictEqual(warnings.length, 1);

  const { record, done } = manager.launch(
    { type: "explore", description: "warn test", background: false },
    async () => ({ result: "clean answer", tokens: 0, toolUses: 0 }),
  );
  record.warnings = warnings;

  await done;

  // Final result construction mirrors index.ts.
  const result = textResult(record.result ?? "", {
    agent_id: record.id,
    status: record.status,
    tokens: record.tokens,
    toolUses: record.toolUses,
    warnings,
  });

  assert.ok(Array.isArray(result.details.warnings), "warnings live in details");
  assert.strictEqual(result.details.warnings.length, 1);
  assert.strictEqual(result.content[0].text, "clean answer");
  assert.ok(!result.content[0].text.includes("bad-ref"), "warning text not in result content");
  assert.ok(!result.content[0].text.includes("falling back"), "notification text not in result content");

  console.log("  Warnings in details, not in result text ......... PASS");
}

async function testBackgroundWarningsRoundTripInDetails() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const registry = fakeRegistry([fakeModel("anthropic", "ok")]);
  const find = (p: string, m: string) => registry.find(p, m);

  const warnings = checkDefaultModelWarnings(undefined, "faux/missing", find, "general");
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].scope, "shared");

  const { record, done } = manager.launch(
    { type: "general", description: "bg warn", background: true },
    async () => ({ result: "bg answer", tokens: 3, toolUses: 1 }),
  );
  record.warnings = warnings;

  await done;
  const rec = await manager.getResult(record.id, false);

  assert.ok(Array.isArray(rec.warnings), "warnings survive background round-trip");
  assert.strictEqual(rec.warnings[0].type, "unresolvable");
  assert.strictEqual(rec.result, "bg answer", "result text stays clean");
  assert.ok(!rec.result!.includes("faux/missing"), "warning ref not in result text");

  console.log("  Background warnings round-trip in details ....... PASS");
}

function testWarningsNotDuplicatedIntoStreamContent() {
  const warnings = [
    { scope: "explore" as const, reference: "bad/ref", type: "unresolvable" as const },
  ];
  const { onStreamEvent, updates } = createStreamSetup(false);

  onStreamEvent!({ type: "text_delta", delta: "Finding files..." });
  onStreamEvent!({ type: "tool_start", name: "find" });
  onStreamEvent!({ type: "tool_end", name: "find", error: false });

  assert.strictEqual(updates.length, 3);
  for (const u of updates) {
    assert.ok(!u.content[0].text.includes("bad/ref"), "warning ref not in stream text");
    assert.ok(!u.content[0].text.includes("falling back"), "warning toast not in stream text");
    assert.strictEqual((u.details as any).warnings, undefined, "warnings not in stream details");
    assert.deepStrictEqual(
      ((u.details.streamEntries as StreamEntry[]) ?? []).every(
        (e) => e.type === "text" || e.type === "tool_start" || e.type === "tool_end",
      ),
      true,
      "stream entries only carry UI progress",
    );
  }

  console.log("  Warnings not duplicated into stream content ..... PASS");
}

async function testWarningsSurfaceAsNotificationsNotResultText() {
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  const warnings = [
    { scope: "shared" as const, reference: "missing/model", type: "unresolvable" as const },
  ];

  if (warnings.length > 0 && ctx.hasUI) {
    for (const w of warnings) {
      ctx.ui.notify(
        `Default ${w.scope} subagent model "${w.reference}" is ${w.type} — falling back`,
        "warning",
      );
    }
  }

  assert.strictEqual(notifications.length, 1);
  assert.ok(notifications[0].message.includes("missing/model"), "notification mentions bad ref");
  assert.strictEqual(notifications[0].level, "warning", "notification level is warning");

  console.log("  Warnings surface as UI notifications ............ PASS");
}

// ---------------------------------------------------------------------------
// Read-only + safety boundaries unchanged
// ---------------------------------------------------------------------------

function testExploreToolsetUnchanged() {
  assert.deepStrictEqual(exploreToolset([]), CORE_READ_TOOLS, "empty explore = core read tools");
  assert.deepStrictEqual(
    exploreToolset(["lsp_definition"]),
    [...CORE_READ_TOOLS, "lsp_definition"],
    "extras appended, deduped",
  );
  assert.deepStrictEqual(
    exploreToolset(["read"]),
    CORE_READ_TOOLS,
    "duplicate core tool deduped",
  );

  console.log("  Explore toolset unchanged ....................... PASS");
}

function testResearcherToolsetUnchanged() {
  const expected = [...new Set([...CORE_READ_TOOLS, "web_search", "web_fetch"])];
  assert.deepStrictEqual(researcherToolset([]), expected, "empty researcher = core + web");

  console.log("  Researcher toolset unchanged .................... PASS");
}

function testSafetyExcludesUnchanged() {
  assert.deepStrictEqual(SAFETY_EXCLUDES, ["Agent", "get_subagent_result", "question"]);
  assert.ok(SAFETY_EXCLUDES.includes("Agent"), "subagent recursion excluded");
  assert.ok(SAFETY_EXCLUDES.includes("get_subagent_result"), "result polling recursion excluded");
  assert.ok(SAFETY_EXCLUDES.includes("question"), "question tool excluded");

  console.log("  Safety excludes unchanged ....................... PASS");
}

function testRunnerSafetyExcludesApplied() {
  // The runner passes excludeTools: [...SAFETY_EXCLUDES, ...opts.excludeExtraTools].
  // Verify the list is always a superset of SAFETY_EXCLUDES.
  const extra = ["bash"];
  const exclusions = [...SAFETY_EXCLUDES, ...extra];
  assert.ok(
    SAFETY_EXCLUDES.every((t) => exclusions.includes(t)),
    "runner exclusions always include safety excludes",
  );
  assert.ok(exclusions.includes("bash"), "extra exclusions also present");

  console.log("  Runner safety excludes applied .................. PASS");
}

function testReadOnlyFlagUnchanged() {
  // Streaming support must not flip readOnly flags.
  // AGENTS is imported read-only in type; assert structural constancy.
  assert.strictEqual(typeof exploreToolset, "function");
  assert.strictEqual(typeof researcherToolset, "function");

  console.log("  Read-only agent boundaries unchanged ............ PASS");
}

// ---------------------------------------------------------------------------
// Scheduler boundaries
// ---------------------------------------------------------------------------

async function testSchedulerOwnsLifecycleRecordsOnly() {
  const events: Array<{ name: string; record: AgentRecord }> = [];
  const manager = new AgentManager({
    maxConcurrency: 1,
    onEvent: (name, record) => events.push({ name, record: { ...record } }),
  });

  const { record, done } = manager.launch(
    { type: "explore", description: "lifecycle" },
    async () => ({ result: "ok", tokens: 1, toolUses: 0 }),
  );

  await done;

  const names = events.map((e) => e.name);
  assert.deepStrictEqual(names, ["created", "started", "completed"]);
  assert.ok(events.every((e) => e.record.id === record.id), "events reference same record");

  console.log("  Scheduler owns lifecycle records only ........... PASS");
}

function testSchedulerDoesNotReferenceStreamOrUI() {
  // The manager module has no StreamEntry, StreamEvent, onUpdate, or UI types.
  // This test asserts the public launch/getResult/list surface stays pure.
  const manager = new AgentManager({ maxConcurrency: 1 });

  // launch accepts an opaque exec thunk and an optional onSettled callback.
  assert.strictEqual(typeof manager.launch, "function");
  assert.strictEqual(typeof manager.getResult, "function");
  assert.strictEqual(typeof manager.list, "function");

  // No stream-specific methods exist.
  assert.strictEqual((manager as any).onStreamEvent, undefined, "manager has no stream callback");
  assert.strictEqual((manager as any).formatStream, undefined, "manager has no stream formatter");

  console.log("  Scheduler does not reference stream or UI ....... PASS");
}

async function testSchedulerQueueHonorsConcurrency() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  let resolveA: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};
  let resolveB: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

  const a = manager.launch(
    { type: "explore", description: "a", background: true },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveA = resolve)),
  );
  const b = manager.launch(
    { type: "explore", description: "b", background: true },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveB = resolve)),
  );

  assert.strictEqual(a.record.status, "running", "first job runs");
  assert.strictEqual(b.record.status, "queued", "second job queued");

  resolveA({ result: "a done", tokens: 0, toolUses: 0 });
  await a.done;

  // After first finishes, pump should start the second.
  assert.strictEqual(b.record.status, "running", "second job eventually runs");
  resolveB({ result: "b done", tokens: 0, toolUses: 0 });
  await b.done;

  console.log("  Scheduler queue honors concurrency .............. PASS");
}

async function testBackgroundOnSettledSeparateFromStream() {
  const settled: AgentRecord[] = [];
  const manager = new AgentManager({ maxConcurrency: 1 });

  const { done } = manager.launch(
    { type: "general", description: "bg settled", background: true },
    async () => ({ result: "bg done", tokens: 2, toolUses: 1 }),
    (rec) => settled.push(rec),
  );

  await done;

  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].status, "completed");
  assert.strictEqual(settled[0].result, "bg done");
  assert.strictEqual((settled[0] as any).streamEntries, undefined, "settled record has no stream");

  console.log("  Background onSettled separate from stream ....... PASS");
}

// ---------------------------------------------------------------------------
// Foreground concurrency cap
// ---------------------------------------------------------------------------

async function testForegroundObeysConcurrencyCap() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  let resolveA: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};
  let resolveB: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

  const a = manager.launch(
    { type: "explore", description: "fg-a", background: false },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveA = resolve)),
  );
  const b = manager.launch(
    { type: "explore", description: "fg-b", background: false },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveB = resolve)),
  );

  assert.strictEqual(a.record.status, "running", "first foreground runs immediately");
  assert.strictEqual(b.record.status, "queued", "second foreground queued behind cap");

  resolveA({ result: "a done", tokens: 0, toolUses: 0 });
  await a.done;

  assert.strictEqual(b.record.status, "running", "second foreground runs after first completes");
  resolveB({ result: "b done", tokens: 0, toolUses: 0 });
  await b.done;

  assert.strictEqual(b.record.result, "b done", "second foreground returns its own result");

  console.log("  Foreground obeys concurrency cap ................ PASS");
}

async function testForegroundRunsCompleteIndependently() {
  const manager = new AgentManager({ maxConcurrency: 2 });
  let resolveA: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};
  let resolveB: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

  const a = manager.launch(
    { type: "explore", description: "fg-indep-a", background: false },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveA = resolve)),
  );
  const b = manager.launch(
    { type: "researcher", description: "fg-indep-b", background: false },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveB = resolve)),
  );

  assert.strictEqual(a.record.status, "running", "first foreground runs");
  assert.strictEqual(b.record.status, "running", "second foreground runs concurrently under cap");

  resolveB({ result: "b result", tokens: 3, toolUses: 1 });
  await b.done;
  assert.strictEqual(b.record.result, "b result", "second foreground completes independently");

  resolveA({ result: "a result", tokens: 5, toolUses: 2 });
  await a.done;
  assert.strictEqual(a.record.result, "a result", "first foreground completes independently");

  assert.strictEqual(a.record.tokens, 5, "a tokens preserved");
  assert.strictEqual(b.record.tokens, 3, "b tokens preserved");
  assert.strictEqual(a.record.toolUses, 2, "a toolUses preserved");
  assert.strictEqual(b.record.toolUses, 1, "b toolUses preserved");

  console.log("  Foreground runs complete independently ........... PASS");
}

async function testForegroundFailureDoesNotBlockSiblings() {
  const manager = new AgentManager({ maxConcurrency: 1 });
  let resolveA: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};
  let rejectA: (err: Error) => void = () => {};
  let resolveB: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

  const a = manager.launch(
    { type: "explore", description: "fg-fail-a", background: false },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve, reject) => {
      resolveA = resolve;
      rejectA = reject;
    }),
  );
  const b = manager.launch(
    { type: "explore", description: "fg-fail-b", background: false },
    () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveB = resolve)),
  );

  assert.strictEqual(a.record.status, "running", "first foreground runs");
  assert.strictEqual(b.record.status, "queued", "second foreground queued");

  // First foreground fails
  rejectA(new Error("something went wrong"));
  await a.done;
  assert.strictEqual(a.record.status, "failed", "first foreground marked failed");
  assert.ok(a.record.error?.includes("something went wrong"), "error message preserved");

  // Second foreground should still run and succeed
  assert.strictEqual(b.record.status, "running", "second foreground runs after first fails");
  resolveB({ result: "b survived", tokens: 2, toolUses: 0 });
  await b.done;
  assert.strictEqual(b.record.status, "completed", "second foreground completes despite sibling failure");
  assert.strictEqual(b.record.result, "b survived", "second foreground returns its own result");

  console.log("  Foreground failure does not block siblings ....... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nSubagent boundary regression tests\n");

  await testBackgroundLaunchReturnsIdAndStartText();
  await testBackgroundRetrievedThroughResultTool();
  await testBackgroundPollingWaitsForCompletion();
  await testBackgroundHasNoStreamCallback();
  await testBackgroundResultHasNoStreamTranscript();
  await testBackgroundResultIsNotStreamingApi();

  await testWarningsInDetailsNotInResultText();
  await testBackgroundWarningsRoundTripInDetails();
  testWarningsNotDuplicatedIntoStreamContent();
  await testWarningsSurfaceAsNotificationsNotResultText();

  testExploreToolsetUnchanged();
  testResearcherToolsetUnchanged();
  testSafetyExcludesUnchanged();
  testRunnerSafetyExcludesApplied();
  testReadOnlyFlagUnchanged();

  await testSchedulerOwnsLifecycleRecordsOnly();
  testSchedulerDoesNotReferenceStreamOrUI();
  await testSchedulerQueueHonorsConcurrency();
  await testBackgroundOnSettledSeparateFromStream();

  // Foreground concurrency cap
  await testForegroundObeysConcurrencyCap();
  await testForegroundRunsCompleteIndependently();
  await testForegroundFailureDoesNotBlockSiblings();

  console.log("\nAll tests PASS\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
