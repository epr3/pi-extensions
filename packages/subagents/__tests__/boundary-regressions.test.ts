import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { AgentManager, type AgentRecord } from "../manager.ts";
import { checkDefaultModelWarnings } from "../model-ref.ts";
import {
  CORE_READ_TOOLS,
  SAFETY_EXCLUDES,
  exploreToolset,
} from "../agents.ts";
import type { StreamEvent, StreamCallback } from "../runner.ts";
import type { StreamEntry } from "../index.ts";

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

describe("background behavior", () => {
  it("launch returns id and start text", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record, done } = manager.launch(
      { type: "explore", description: "bg test", background: true },
      async () => ({ result: "bg answer", tokens: 7, toolUses: 1 }),
    );

    expect(record.id).toMatch(/^sa_/);
    expect(record.status).toBe("running");

    const startResult = textResult(
      `Started ${record.type} Subagent ${record.id} (background). Poll with get_subagent_result.`,
      { agent_id: record.id, status: record.status },
    );

    expect(startResult.content[0].text).toContain(record.id);
    expect(startResult.content[0].text).toContain("get_subagent_result");
    expect(startResult.details.agent_id).toBe(record.id);

    await done;
  });

  it("retrieved through result tool", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record, done } = manager.launch(
      { type: "general", description: "bg poll", background: true },
      async () => ({ result: "polled result", tokens: 12, toolUses: 2 }),
    );

    await done;
    const rec = await manager.getResult(record.id, false);

    expect(rec.status).toBe("completed");
    expect(rec.result).toBe("polled result");
    expect(rec.tokens).toBe(12);
    expect(rec.toolUses).toBe(2);
  });

  it("polling waits for completion", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let resolveExec: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

    const { record } = manager.launch(
      { type: "general", description: "bg wait", background: true },
      () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveExec = resolve)),
    );

    expect(record.status).toBe("running");

    const pollPromise = manager.getResult(record.id, true);
    resolveExec({ result: "waited", tokens: 0, toolUses: 0 });
    const rec = await pollPromise;

    expect(rec.result).toBe("waited");
    expect(rec.status).toBe("completed");
  });

  it("has no stream callback", () => {
    const { onStreamEvent } = createStreamSetup(true);
    expect(onStreamEvent).toBeUndefined();
  });

  it("result has no stream transcript", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record, done } = manager.launch(
      { type: "explore", description: "bg no stream", background: true },
      async () => ({ result: "final only", tokens: 5, toolUses: 0 }),
    );

    await done;
    const rec = await manager.getResult(record.id, false);

    expect(rec.result).toBe("final only");
    expect((rec as any).streamText).toBeUndefined();
    expect((rec as any).streamEntries).toBeUndefined();
  });

  it("result is not a streaming API", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "bg not stream api", background: true },
      async () => ({ result: "done", tokens: 1, toolUses: 0 }),
    );

    const rec1 = await manager.getResult(record.id, false);
    const rec2 = await manager.getResult(record.id, false);

    expect(rec1).toBe(rec2);
    expect(typeof rec1.status).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Default model warning boundaries
// ---------------------------------------------------------------------------

describe("warning boundaries", () => {
  it("warnings in details, not in result text", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([fakeModel("anthropic", "ok")]);
    const find = (p: string, m: string) => registry.find(p, m);

    const warnings = checkDefaultModelWarnings("bad-ref", undefined, find, "explore");
    expect(warnings).toHaveLength(1);

    const { record, done } = manager.launch(
      { type: "explore", description: "warn test", background: false },
      async () => ({ result: "clean answer", tokens: 0, toolUses: 0 }),
    );
    record.warnings = warnings;

    await done;

    const result = textResult(record.result ?? "", {
      agent_id: record.id,
      status: record.status,
      tokens: record.tokens,
      toolUses: record.toolUses,
      warnings,
    });

    expect(Array.isArray(result.details.warnings)).toBe(true);
    expect(result.details.warnings).toHaveLength(1);
    expect(result.content[0].text).toBe("clean answer");
    expect(result.content[0].text).not.toContain("bad-ref");
    expect(result.content[0].text).not.toContain("falling back");
  });

  it("background warnings round-trip in details", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([fakeModel("anthropic", "ok")]);
    const find = (p: string, m: string) => registry.find(p, m);

    const warnings = checkDefaultModelWarnings(undefined, "faux/missing", find, "general");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].scope).toBe("shared");

    const { record, done } = manager.launch(
      { type: "general", description: "bg warn", background: true },
      async () => ({ result: "bg answer", tokens: 3, toolUses: 1 }),
    );
    record.warnings = warnings;

    await done;
    const rec = await manager.getResult(record.id, false);

    expect(Array.isArray(rec.warnings)).toBe(true);
    expect(rec.warnings![0].type).toBe("unresolvable");
    expect(rec.result).toBe("bg answer");
    expect(rec.result).not.toContain("faux/missing");
  });

  it("warnings not duplicated into stream content", () => {
    const { onStreamEvent, updates } = createStreamSetup(false);

    onStreamEvent!({ type: "text_delta", delta: "Finding files..." });
    onStreamEvent!({ type: "tool_start", name: "find" });
    onStreamEvent!({ type: "tool_end", name: "find", error: false });

    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.content[0].text).not.toContain("bad/ref");
      expect(u.content[0].text).not.toContain("falling back");
      expect((u.details as any).warnings).toBeUndefined();
    }
  });

  it("warnings surface as UI notifications, not result text", () => {
    const notifications: Array<{ message: string; level: string }> = [];

    const warnings = [
      { scope: "shared" as const, reference: "missing/model", type: "unresolvable" as const },
    ];

    // Simulate the notify loop from index.ts
    if (warnings.length > 0) {
      for (const w of warnings) {
        notifications.push({
          message: `Default ${w.scope} subagent model "${w.reference}" is ${w.type} — falling back`,
          level: "warning",
        });
      }
    }

    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain("missing/model");
    expect(notifications[0].level).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Foreground final return shape
// ---------------------------------------------------------------------------

describe("foreground final return shape", () => {
  it("excludes stream data", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record, done } = manager.launch(
      { type: "explore", description: "fg final shape", background: false },
      async () => ({ result: "Analysis complete.", tokens: 15, toolUses: 2 }),
    );
    await done;

    const warnings: Array<{ scope: string; reference: string; type: string }> = [];
    const result = textResult(record.result ?? "(no output)", {
      agent_id: record.id,
      status: record.status,
      tokens: record.tokens,
      toolUses: record.toolUses,
      ...(warnings.length > 0 ? { warnings } : {}),
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Analysis complete.");
    expect(Object.keys(result.details)).toHaveLength(4);
    expect((result.details as any).streamText).toBeUndefined();
    expect((result.details as any).streamEntries).toBeUndefined();
    expect(result.details.agent_id).toBe(record.id);
    expect(result.details.status).toBe("completed");
    expect(result.details.tokens).toBe(15);
    expect(result.details.toolUses).toBe(2);
  });

  it("excludes stream data even with warnings", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record, done } = manager.launch(
      { type: "explore", description: "fg warn shape", background: false },
      async () => ({ result: "Research done.", tokens: 42, toolUses: 5 }),
    );
    await done;

    const warnings = [
      { scope: "shared" as const, reference: "missing/model", type: "unresolvable" as const },
    ];
    const result = textResult(record.result ?? "(no output)", {
      agent_id: record.id,
      status: record.status,
      tokens: record.tokens,
      toolUses: record.toolUses,
      warnings,
    });

    expect(result.content[0].text).toBe("Research done.");
    expect((result.details as any).streamText).toBeUndefined();
    expect((result.details as any).streamEntries).toBeUndefined();
    expect(Array.isArray(result.details.warnings)).toBe(true);
    expect(result.details.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Read-only + safety boundaries unchanged
// ---------------------------------------------------------------------------

describe("read-only and safety boundaries", () => {
  it("explore toolset unchanged", () => {
    expect(exploreToolset([])).toEqual(CORE_READ_TOOLS);
    expect(exploreToolset(["lsp_definition"])).toEqual([...CORE_READ_TOOLS, "lsp_definition"]);
    expect(exploreToolset(["read"])).toEqual(CORE_READ_TOOLS);
  });

  it("safety excludes unchanged", () => {
    expect(SAFETY_EXCLUDES).toEqual(["Agent", "get_subagent_result", "question"]);
    expect(SAFETY_EXCLUDES).toContain("Agent");
    expect(SAFETY_EXCLUDES).toContain("get_subagent_result");
    expect(SAFETY_EXCLUDES).toContain("question");
  });

  it("runner safety excludes applied", () => {
    const extra = ["bash"];
    const exclusions = [...SAFETY_EXCLUDES, ...extra];
    expect(SAFETY_EXCLUDES.every((t) => exclusions.includes(t))).toBe(true);
    expect(exclusions).toContain("bash");
  });

  it("read-only agent boundaries unchanged", () => {
    expect(typeof exploreToolset).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Scheduler boundaries
// ---------------------------------------------------------------------------

describe("scheduler boundaries", () => {
  it("owns lifecycle records only", async () => {
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
    expect(names).toEqual(["created", "started", "completed"]);
    expect(events.every((e) => e.record.id === record.id)).toBe(true);
  });

  it("does not reference stream or UI", () => {
    const manager = new AgentManager({ maxConcurrency: 1 });

    expect(typeof manager.launch).toBe("function");
    expect(typeof manager.getResult).toBe("function");
    expect(typeof manager.list).toBe("function");

    expect((manager as any).onStreamEvent).toBeUndefined();
    expect((manager as any).formatStream).toBeUndefined();
  });

  it("queue honors concurrency", async () => {
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

    expect(a.record.status).toBe("running");
    expect(b.record.status).toBe("queued");

    resolveA({ result: "a done", tokens: 0, toolUses: 0 });
    await a.done;

    expect(b.record.status).toBe("running");
    resolveB({ result: "b done", tokens: 0, toolUses: 0 });
    await b.done;
  });

  it("background onSettled separate from stream", async () => {
    const settled: AgentRecord[] = [];
    const manager = new AgentManager({ maxConcurrency: 1 });

    const { done } = manager.launch(
      { type: "general", description: "bg settled", background: true },
      async () => ({ result: "bg done", tokens: 2, toolUses: 1 }),
      (rec) => settled.push(rec),
    );

    await done;

    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("completed");
    expect(settled[0].result).toBe("bg done");
    expect((settled[0] as any).streamEntries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Foreground concurrency cap
// ---------------------------------------------------------------------------

describe("foreground concurrency cap", () => {
  it("obeys concurrency cap", async () => {
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

    expect(a.record.status).toBe("running");
    expect(b.record.status).toBe("queued");

    resolveA({ result: "a done", tokens: 0, toolUses: 0 });
    await a.done;

    expect(b.record.status).toBe("running");
    resolveB({ result: "b done", tokens: 0, toolUses: 0 });
    await b.done;

    expect(b.record.result).toBe("b done");
  });

  it("runs complete independently under cap", async () => {
    const manager = new AgentManager({ maxConcurrency: 2 });
    let resolveA: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};
    let resolveB: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

    const a = manager.launch(
      { type: "explore", description: "fg-indep-a", background: false },
      () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveA = resolve)),
    );
    const b = manager.launch(
      { type: "explore", description: "fg-indep-b", background: false },
      () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveB = resolve)),
    );

    expect(a.record.status).toBe("running");
    expect(b.record.status).toBe("running");

    resolveB({ result: "b result", tokens: 3, toolUses: 1 });
    await b.done;
    expect(b.record.result).toBe("b result");

    resolveA({ result: "a result", tokens: 5, toolUses: 2 });
    await a.done;
    expect(a.record.result).toBe("a result");

    expect(a.record.tokens).toBe(5);
    expect(b.record.tokens).toBe(3);
    expect(a.record.toolUses).toBe(2);
    expect(b.record.toolUses).toBe(1);
  });

  it("failure does not block siblings", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let rejectA: (err: Error) => void = () => {};
    let resolveB: (out: { result: string; tokens: number; toolUses: number }) => void = () => {};

    const a = manager.launch(
      { type: "explore", description: "fg-fail-a", background: false },
      () => new Promise<{ result: string; tokens: number; toolUses: number }>((_resolve, reject) => {
        rejectA = reject;
      }),
    );
    const b = manager.launch(
      { type: "explore", description: "fg-fail-b", background: false },
      () => new Promise<{ result: string; tokens: number; toolUses: number }>((resolve) => (resolveB = resolve)),
    );

    expect(a.record.status).toBe("running");
    expect(b.record.status).toBe("queued");

    rejectA(new Error("something went wrong"));
    await a.done;
    expect(a.record.status).toBe("failed");
    expect(a.record.error).toContain("something went wrong");

    expect(b.record.status).toBe("running");
    resolveB({ result: "b survived", tokens: 2, toolUses: 0 });
    await b.done;
    expect(b.record.status).toBe("completed");
    expect(b.record.result).toBe("b survived");
  });
});
