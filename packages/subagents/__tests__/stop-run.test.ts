import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentManager, type StopOutcome } from "../manager.ts";
import { RESULT_TEXT_LIMIT } from "../result-limit.ts";
import { runSubagentSession, type RunResult } from "../runner.ts";
import { sdkAbortResolvingSession } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fake exec thunks
// ---------------------------------------------------------------------------

/**
 * An exec that rejects the way `runSubagentSession` does: when the manager's
 * stop signal fires, it rejects with "Subagent aborted" and — when the mock
 * captured assistant text — that text attached as `partialText`.
 */
function abortableExec(partialText?: string): (signal: AbortSignal) => Promise<RunResult> {
  return (signal: AbortSignal) =>
    new Promise<RunResult>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const err = new Error("Subagent aborted");
          if (partialText) (err as any).partialText = partialText;
          reject(err);
        },
        { once: true },
      );
    });
}

/** Never-settling exec that still observes the abort signal (queued-start guard). */
let observeSignal: (signal: AbortSignal) => Promise<RunResult> = (signal) =>
  new Promise<RunResult>(() => {
    void signal;
  });

import { default as subagentsExtension } from "../index.ts";
import { makeFakeApi } from "./helpers.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Manager seam: stop a queued background run
// ---------------------------------------------------------------------------

describe("AgentManager.stop — queued run", () => {
  it("stops a queued background run without ever starting it", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let started = false;

    // The busy slot keeps job B queued until A settles.
    const a = manager.launch(
      { type: "general", description: "a", background: true },
      () => new Promise<RunResult>(() => {}),
    );
    const b = manager.launch(
      { type: "general", description: "b", background: true },
      (signal: AbortSignal) => {
        started = true;
        return observeSignal(signal);
      },
    );

    expect(a.record.status).toBe("running");
    expect(b.record.status).toBe("queued");

    const outcome: StopOutcome = await manager.stop(b.record.id);

    expect(outcome.action).toBe("stopped");
    expect(b.record.status).toBe("stopped");
    expect(b.record.stopReason).toBeTruthy();
    expect(started).toBe(false);
    expect(b.record.partialText).toBeUndefined();

    // Even after later slot pressure, the stopped job must not start.
    await expect(manager.getResult(b.record.id, true)).resolves.toMatchObject({
      status: "stopped",
    });
    expect(started).toBe(false);
  });

  it("resolves the queued run's done promise with the stopped record", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    manager.launch(
      { type: "general", description: "a", background: true },
      () => new Promise<RunResult>(() => {}),
    );
    const b = manager.launch(
      { type: "general", description: "b", background: true },
      () => new Promise<RunResult>(() => {}),
    );
    await manager.stop(b.record.id);

    await expect(b.done).resolves.toMatchObject({ status: "stopped" });
  });
});

// ---------------------------------------------------------------------------
// Manager seam: stop a running background run
// ---------------------------------------------------------------------------

describe("AgentManager.stop — running run", () => {
  it("aborts the run and settles it as stopped with partial assistant text", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let observedSignal: AbortSignal | undefined;
    const abortable = abortableExec("half-finished answer");
    const { record, done } = manager.launch(
      { type: "general", description: "task", background: true },
      (signal: AbortSignal) => {
        observedSignal = signal;
        return abortable(signal);
      },
    );
    expect(record.status).toBe("running");

    const outcome = await manager.stop(record.id);
    await done;

    expect(observedSignal?.aborted).toBe(true);
    expect(outcome.action).toBe("stopped");
    expect(record.status).toBe("stopped");
    expect(record.stopReason).toBeTruthy();
    expect(record.partialText).toBe("half-finished answer");
    expect(record.result).toBeUndefined();
  });

  it("marks a stopped run with no captured text as stopped without partial output", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec() as any,
    );
    await manager.stop(record.id);
    expect(record.status).toBe("stopped");
    expect(record.partialText).toBeUndefined();
  });

  it("bounds captured partial text with the shared result limit and notice", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const huge = "b".repeat(RESULT_TEXT_LIMIT + 50);
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec(huge) as any,
    );
    await manager.stop(record.id);
    expect(record.partialText?.startsWith("b".repeat(RESULT_TEXT_LIMIT))).toBe(true);
    expect(record.partialText).toContain("[Truncated: showing the first 20,000 of 20,050 bytes.]");
  });
});

// ---------------------------------------------------------------------------
// Manager seam: races and already-terminal stops
// ---------------------------------------------------------------------------

describe("AgentManager.stop — races and terminal runs", () => {
  it("does not change a completed run; the first terminal outcome wins", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let resolveExec!: (out: RunResult) => void;
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      () => new Promise<RunResult>((resolve) => (resolveExec = resolve)),
    );
    resolveExec({ result: "finished in time", tokens: 3, toolUses: 1 });
    await manager.getResult(record.id, true);

    const outcome: StopOutcome = await manager.stop(record.id);
    expect(outcome.action).toBe("unchanged");
    expect(record.status).toBe("completed");
    expect(record.result).toContain("finished in time");
  });

  it("does not overwrite a completed record when completion and stop race", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let fired = false;
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      (signal: AbortSignal) =>
        new Promise<RunResult>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            // Race: the run had already resolved successfully; the first
            // (completion) outcome must win over the stop.
            if (!fired) {
              fired = true;
              resolve({ result: "completed anyway", tokens: 1, toolUses: 0 });
            } else {
              reject(new Error("Subagent aborted"));
            }
          });
        }),
    );
    const outcome = await manager.stop(record.id);
    expect(record.status).toBe("completed");
    expect(record.result).toContain("completed anyway");
    expect(outcome.action).toBe("unchanged");
  });

  it("leaves a failed run unchanged and reports it", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      () => Promise.reject(new Error("boom")),
    );
    await manager.getResult(record.id, true);
    const outcome = await manager.stop(record.id);
    expect(outcome.action).toBe("unchanged");
    expect(record.status).toBe("failed");
    expect(record.error).toContain("boom");
  });

  it("rejects for an unknown id without touching anything", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    await expect(manager.stop("nope")).rejects.toThrow(/No subagent nope/);
  });

  it("keeps a completed record addressable for later stops", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      () => Promise.resolve({ result: "done", tokens: 1, toolUses: 0 }),
    );
    await manager.getResult(record.id, true);
    const outcome = await manager.stop(record.id);
    expect(outcome.record.result).toContain("done");
  });
});

// ---------------------------------------------------------------------------
// Manager seam: stop/completion interleavings and first-terminal-outcome rules
// ---------------------------------------------------------------------------

describe("AgentManager.stop — stop/completion interleavings", () => {
  it("settles a completion that was already resolved when the stop arrived", async () => {
    const names: string[] = [];
    const manager = new AgentManager({
      maxConcurrency: 1,
      onEvent: (name) => names.push(name),
    });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      () => Promise.resolve({ result: "finished", tokens: 2, toolUses: 1 }),
    );
    // Same tick as the launch: the exec has resolved but the manager has not
    // applied it yet, so the record still reads "running". The completion is
    // therefore the outcome that lands first.
    expect(record.status).toBe("running");

    const outcome = await manager.stop(record.id);

    expect(outcome.action).toBe("unchanged");
    expect(record.status).toBe("completed");
    expect(record.result).toContain("finished");
    expect(record.stopReason).toBeUndefined();
    expect(record.partialText).toBeUndefined();
    expect(names.filter((n) => n === "completed")).toHaveLength(1);
    expect(names).not.toContain("stopped");
  });

  it("applies exactly one terminal outcome for concurrent stop requests", async () => {
    const names: string[] = [];
    const manager = new AgentManager({
      maxConcurrency: 1,
      onEvent: (name) => names.push(name),
    });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec("captured text"),
    );

    const [first, second] = await Promise.all([manager.stop(record.id), manager.stop(record.id)]);

    expect(first.action).toBe("stopped");
    expect(second.action).toBe("stopped");
    expect(second.record.status).toBe("stopped");
    expect(second.record.stopReason).toBe(first.record.stopReason);
    expect(second.record.partialText).toBe("captured text");
    expect(names.filter((n) => n === "stopped")).toHaveLength(1);
    expect(names.filter((n) => n === "completed" || n === "failed")).toHaveLength(0);
  });

  it("reports a second stop after a stopped outcome as unchanged", async () => {
    const names: string[] = [];
    const manager = new AgentManager({
      maxConcurrency: 1,
      onEvent: (name) => names.push(name),
    });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec("half"),
    );
    const first = await manager.stop(record.id);
    const reason = record.stopReason;

    const second = await manager.stop(record.id);

    expect(first.action).toBe("stopped");
    expect(second.action).toBe("unchanged");
    expect(record.status).toBe("stopped");
    expect(record.stopReason).toBe(reason);
    expect(record.partialText).toBe("half");
    expect(names.filter((n) => n === "stopped")).toHaveLength(1);
  });

  it("reports the stopped outcome to a blocking retrieval already waiting", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec("waiting text"),
    );
    const waiting = manager.getResult(record.id, true);

    await manager.stop(record.id);

    await expect(waiting).resolves.toMatchObject({
      status: "stopped",
      partialText: "waiting text",
    });
    expect(record.status).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// Manager seam: the abort semantics real Pi exhibits (see helpers fixture)
// ---------------------------------------------------------------------------

describe("AgentManager.stop — Pi abort semantics", () => {
  it("settles a stopped run as stopped when the session resolves its aborted prompt", async () => {
    // The composed manager + runner path: Pi resolves prompt() for an aborted
    // run, so the stop outcome must come from the runner's abort handling, not
    // from an exec rejection the SDK never produces.
    const manager = new AgentManager({ maxConcurrency: 1 });
    const session = sdkAbortResolvingSession();
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      (signal: AbortSignal) => runSubagentSession({ session, prompt: "work", abortSignal: signal }),
    );
    session.emitText("half-written findings");

    const outcome = await manager.stop(record.id);

    expect(outcome.action).toBe("stopped");
    expect(record.status).toBe("stopped");
    expect(record.result).toBeUndefined();
    expect(record.stopReason).toBeTruthy();
    expect(record.partialText).toBe("half-written findings");
  });

  it("still completes a run the session finished before any stop", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const session = sdkAbortResolvingSession();
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      (signal: AbortSignal) => runSubagentSession({ session, prompt: "work", abortSignal: signal }),
    );
    session.finish("complete answer");
    await manager.getResult(record.id, true);

    const outcome = await manager.stop(record.id);

    expect(outcome.action).toBe("unchanged");
    expect(record.status).toBe("completed");
    expect(record.result).toBe("complete answer");
  });
});

// ---------------------------------------------------------------------------
// Manager seam: foreground interruption behavior is preserved
// ---------------------------------------------------------------------------

describe("AgentManager.stop — foreground untouched", () => {
  it("refuses to stop a foreground run", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "fg", background: false },
      abortableExec() as any,
    );
    expect(record.background).toBe(false);
    await expect(manager.stop(record.id)).rejects.toThrow(/foreground/);
    expect(record.status).toBe("running");
  });

  it("retains parent-signal foreground failure with no partial promotion", async () => {
    // A foreground run aborted by the parent's tool-call signal rejects with
    // "Subagent aborted" and — by the runner contract — no partialText when
    // nothing was captured. The 0012 foreground contract stays intact: the
    // record is failed, and the extension still surfaces it as a thrown error.
    const manager = new AgentManager({ maxConcurrency: 1 });
    const controller = new AbortController();
    const { record, done } = manager.launch(
      { type: "general", description: "fg", background: false },
      (signal: AbortSignal) =>
        new Promise<RunResult>((_resolve, reject) => {
          // Real wiring passes the parent's signal into runSubagent; here the
          // exec rejects from the parent abort directly.
          controller.signal.addEventListener("abort", () => {
            void signal;
            reject(new Error("Subagent aborted"));
          });
        }),
    );
    controller.abort();
    await done;
    expect(record.status).toBe("failed");
    expect(record.error).toContain("aborted");
    expect(record.partialText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Manager seam: records and lifecycle events
// ---------------------------------------------------------------------------

describe("AgentManager.stop — records and events", () => {
  it("getResult without wait returns the stopped record", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec() as any,
    );
    await manager.stop(record.id);
    const rec = await manager.getResult(record.id);
    expect(rec.status).toBe("stopped");
  });

  it("emits a stopped lifecycle event", async () => {
    const names: string[] = [];
    const manager = new AgentManager({
      maxConcurrency: 1,
      onEvent: (name) => names.push(name),
    });
    const { record } = manager.launch(
      { type: "general", description: "task", background: true },
      abortableExec("text") as any,
    );
    await manager.stop(record.id);
    expect(names).toContain("stopped");
    expect(names[names.length - 1]).toBe("stopped");
  });

  it("emits one event for a queued stop", async () => {
    const names: string[] = [];
    const manager = new AgentManager({
      maxConcurrency: 1,
      onEvent: (name) => names.push(name),
    });
    manager.launch(
      { type: "general", description: "a", background: true },
      () => new Promise<RunResult>(() => {}),
    );
    const b = manager.launch(
      { type: "general", description: "b", background: true },
      () => new Promise<RunResult>(() => {}),
    );
    await manager.stop(b.record.id);
    expect(names.filter((n) => n === "stopped").length).toBe(1);
    expect(b.record.stopReason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Extension seam: stop_subagent tool and partial-aware retrieval
// ---------------------------------------------------------------------------

const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

function registerTools(): Map<string, ToolDefinition> {
  const tools: ToolDefinition[] = [];
  subagentsExtension(makeFakeApi(tools));
  return new Map(tools.map((t) => [t.name, t as ToolDefinition]));
}

function contentText(res: any): string {
  return res.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function fakeCtx(signal?: AbortSignal) {
  return {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    signal,
    modelRegistry: { find: () => undefined },
    ui: { notify: () => {} },
  } as any;
}

/** Launch a background run and return its tool result (details.agent_id). */
async function launchBackground(bgExec: (opts: any) => Promise<any>): Promise<string> {
  runSubagentMock.mockImplementation(bgExec);
  const agent = toolsRef!.get("Agent")!;
  const res = (await agent.execute(
    "call-1",
    { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
    undefined,
    undefined,
    fakeCtx(),
  )) as any;
  expect(res.details.agent_id).toBeTypeOf("string");
  return res.details.agent_id as string;
}

/**
 * Launch a background run end-to-end through the extension with the real
 * runner over a fake session that ends aborts the way Pi does (`seed` streams
 * assistant text once the run has subscribed).
 */
async function launchBackgroundWithSession(
  seed: (session: ReturnType<typeof sdkAbortResolvingSession>) => void,
): Promise<string> {
  const session = sdkAbortResolvingSession();
  runSubagentMock.mockImplementation((opts: any) => {
    const run = runSubagentSession({ session, prompt: "work", abortSignal: opts.abortSignal });
    seed(session);
    return run;
  });
  const res = (await toolsRef!
    .get("Agent")!
    .execute(
      "call-1",
      { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
      undefined,
      undefined,
      fakeCtx(),
    )) as any;
  expect(res.details.agent_id).toBeTypeOf("string");
  return res.details.agent_id as string;
}

/** Exec that rejects on abort with captured partial text, like runSubagentSession. */
function backgroundAbortableExec(partialText?: string) {
  return (opts: any) =>
    new Promise((_, reject) => {
      opts.abortSignal?.addEventListener(
        "abort",
        () => {
          const err = new Error("Subagent aborted");
          if (partialText) (err as any).partialText = partialText;
          reject(err);
        },
        { once: true },
      );
    });
}

let toolsRef: Map<string, ToolDefinition> | undefined;

function toolRefs(): { agent: ToolDefinition; stop: ToolDefinition; result: ToolDefinition } {
  return {
    agent: toolsRef!.get("Agent")!,
    stop: toolsRef!.get("stop_subagent")!,
    result: toolsRef!.get("get_subagent_result")!,
  };
}

beforeEach(() => {
  runSubagentMock.mockReset();
  toolsRef = registerTools();
});

describe("stop_subagent tool — registration", () => {
  it("registers stop_subagent with an agent_id-only parameter", () => {
    const stop = toolsRef!.get("stop_subagent");
    expect(stop).toBeDefined();
    expect(Object.keys((stop!.parameters as any).properties)).toEqual(["agent_id"]);
  });

  it("is excluded from sub-sessions as a mandatory safety exclusion", async () => {
    const { SAFETY_EXCLUDES } = await import("../agents.ts");
    expect(SAFETY_EXCLUDES).toContain("stop_subagent");
  });
});

describe("stop_subagent tool — queued and running stops", () => {
  it("stops a queued run: reports it will not start and no output exists", async () => {
    const { agent, stop, result } = toolRefs();
    // Occupy the concurrency cap (default 4) so the next launch stays queued.
    for (let i = 0; i < 4; i++) await launchBackground(() => new Promise(() => {}));
    const queuedId = await launchBackground(() => new Promise(() => {}));
    const queuedRec = await result.execute("call-9", { agent_id: queuedId });
    expect((queuedRec.details as any).status).toBe("queued");

    const res = (await stop.execute("call-10", { agent_id: queuedId })) as any;
    expect(contentText(res)).toMatch(/will not start|before it started/i);
    expect(contentText(res)).toMatch(/no .*output|no assistant output/i);
    expect(res.details.status).toBe("stopped");
    void agent;
  });

  it("stops a running run: reports stopped with partial assistant output marked incomplete", async () => {
    const { stop, result } = toolRefs();
    const id = await launchBackground(backgroundAbortableExec("half-finished answer"));
    const res = (await stop.execute("call-2", { agent_id: id })) as any;
    expect(res.details.status).toBe("stopped");
    const text = contentText(res);
    expect(text).toMatch(/stopped/i);
    expect(text).toContain("Partial assistant output (incomplete):");
    expect(text).toContain("half-finished answer");
    // The completion path cannot double-report a stopped run as completed.
    const retrieved = (await result.execute("call-3", { agent_id: id })) as any;
    expect((retrieved.details as any).status).toBe("stopped");
    expect(contentText(retrieved)).toContain("Partial assistant output (incomplete):");
  });

  it("bounds a large partial output in the stop response with the shared limit", async () => {
    const { stop } = toolRefs();
    const huge = "c".repeat(RESULT_TEXT_LIMIT + 10);
    const id = await launchBackground(backgroundAbortableExec(huge));
    const res = (await stop.execute("call-2", { agent_id: id })) as any;
    const text = contentText(res);
    expect(text).toContain("[Truncated:");
    expect(text).toContain("20,000");
    expect(text).toContain("20,010");
  });

  it("explicitly states no output when a stopped run produced none", async () => {
    const { stop, result } = toolRefs();
    const id = await launchBackground(backgroundAbortableExec());
    const res = (await stop.execute("call-2", { agent_id: id })) as any;
    expect(contentText(res)).toMatch(/no assistant output is available|no partial/i);
    const retrieved = (await result.execute("call-3", { agent_id: id })) as any;
    expect(contentText(retrieved)).toContain("No partial assistant output is available.");
  });
});

describe("stop_subagent tool — unknown and already-terminal runs", () => {
  it("refuses an unknown id with actionable guidance and without changes", async () => {
    const { stop } = toolRefs();
    await expect(stop.execute("call-2", { agent_id: "missing" })).rejects.toThrow(
      /Unknown Subagent id "missing"/,
    );
  });

  it("refuses to stop a foreground run with actionable guidance", async () => {
    const { agent, stop } = toolRefs();
    const res = (await agent.execute(
      "call-1",
      { subagent_type: "general", prompt: "work", description: "task" },
      undefined,
      undefined,
      fakeCtx(),
    )) as any;
    // The finished foreground run exposes its id in the result details.
    const fgId = res.details.agent_id as string;
    await expect(stop.execute("call-2", { agent_id: fgId })).rejects.toThrow(/foreground/i);
  });

  it("reports that a completed run is unchanged without altering its outcome", async () => {
    const { stop, result } = toolRefs();
    const id = await launchBackground(async () => ({
      result: "shipped it",
      tokens: 2,
      toolUses: 1,
    }));
    await result.execute("call-5", { agent_id: id, wait: true });
    const res = (await stop.execute("call-6", { agent_id: id })) as any;
    expect(res.details.status).toBe("completed");
    const text = contentText(res);
    expect(text).toMatch(/already completed|unchanged|did not change/i);
    const retrieved = (await result.execute("call-7", { agent_id: id })) as any;
    expect(contentText(retrieved)).toContain("shipped it");
  });

  it("reports that a failed run is unchanged, including its reason", async () => {
    const { stop, result } = toolRefs();
    const id = await launchBackground(async () => {
      throw new Error("model unavailable");
    });
    await result.execute("call-5", { agent_id: id, wait: true });
    const res = (await stop.execute("call-6", { agent_id: id })) as any;
    expect(res.details.status).toBe("failed");
    expect(contentText(res)).toContain("model unavailable");
  });
});

describe("stop_subagent tool — stop/completion race reporting", () => {
  it("reports a completion that landed during the stop without claiming it came first", async () => {
    const { stop, result } = toolRefs();
    // The run resolves *on* the abort: the completion lands while the stop is
    // being applied, so the response reports the terminal outcome (completed)
    // and that the stop changed nothing — but the tool cannot know whether the
    // completion preceded the request, so it must not assert that ordering.
    const id = await launchBackground(
      (opts: any) =>
        new Promise((resolve) => {
          opts.abortSignal?.addEventListener(
            "abort",
            () => resolve({ result: "finished during the stop", tokens: 1, toolUses: 0 }),
            { once: true },
          );
        }),
    );

    const res = (await stop.execute("call-2", { agent_id: id })) as any;

    expect(res.details.status).toBe("completed");
    expect(res.details.changed).toBe(false);
    const text = contentText(res);
    expect(text).not.toMatch(/before the stop request/);
    expect(text).toMatch(/completed/);
    expect(text).toMatch(/did not change the outcome/i);
    // The completed outcome is intact for later retrieval.
    const retrieved = (await result.execute("call-3", { agent_id: id })) as any;
    expect((retrieved.details as any).status).toBe("completed");
    expect(contentText(retrieved)).toContain("finished during the stop");
  });

  it("reports a Pi-semantics stop as stopped with partial output, never completed", async () => {
    const { stop, result } = toolRefs();
    // A fake session that ends an aborted run the way Pi's agent loop does:
    // stopReason "aborted" and a resolved prompt rather than a rejection.
    const id = await launchBackgroundWithSession((session) => session.emitText("draft findings"));

    const res = (await stop.execute("call-2", { agent_id: id })) as any;

    expect(res.details.status).toBe("stopped");
    expect(res.details.changed).toBe(true);
    const text = contentText(res);
    expect(text).toMatch(/^Stopped /);
    expect(text).toContain("Partial assistant output (incomplete):");
    expect(text).toContain("draft findings");
    const retrieved = (await result.execute("call-3", { agent_id: id })) as any;
    expect((retrieved.details as any).status).toBe("stopped");
  });
});

describe("get_subagent_result — stopped and failed partial composition", () => {
  it("marks failed runs partial output as incomplete and includes the failure reason", async () => {
    const { result } = toolRefs();
    const id = await launchBackground(async () => {
      const err = new Error("provider 500");
      (err as any).partialText = "draft so far";
      throw err;
    });
    const res = (await result.execute("call-3", { agent_id: id, wait: true })) as any;
    expect(res.details.status).toBe("failed");
    const text = contentText(res);
    expect(text).toContain("failed: provider 500");
    expect(text).toContain("Partial assistant output (incomplete):");
    expect(text).toContain("draft so far");
  });

  it("states no partial output exists for a failed run without one", async () => {
    const { result } = toolRefs();
    const id = await launchBackground(async () => {
      throw new Error("quiet failure");
    });
    const res = (await result.execute("call-3", { agent_id: id, wait: true })) as any;
    expect(contentText(res)).toContain("failed: quiet failure");
    expect(contentText(res)).toContain("No partial assistant output is available.");
  });

  it("excludes tool transcripts and thinking from partial output", async () => {
    const { stop, result } = toolRefs();
    // Only assistant text may appear — a shape test of the composed record:
    // the partial string is exactly what the runner captured.
    const id = await launchBackground(
      backgroundAbortableExec("assistant prose only — no tool logs"),
    );
    await stop.execute("call-2", { agent_id: id });
    const res = (await result.execute("call-3", { agent_id: id })) as any;
    const text = contentText(res);
    expect(text).toContain("assistant prose only — no tool logs");
    expect(text).not.toMatch(/tool_execution|thinking/);
  });
});

describe("extension wiring — foreground interruption preserved, background abortable", () => {
  it("still aborts a foreground run when the parent signal fires", async () => {
    const agent = toolsRef!.get("Agent")!;
    const controller = new AbortController();
    runSubagentMock.mockImplementation(
      (opts: any) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener("abort", () => reject(new Error("Subagent aborted")), {
            once: true,
          });
        }),
    );
    const call = agent.execute(
      "call-1",
      { subagent_type: "general", prompt: "work", description: "task" },
      undefined,
      undefined,
      fakeCtx(controller.signal),
    );
    controller.abort();
    await expect(call).rejects.toThrow(/Subagent failed: Subagent aborted/);
  });

  it("a foreground failure carries any captured partial assistant text, marked incomplete", async () => {
    const agent = toolsRef!.get("Agent")!;
    runSubagentMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          const err = new Error("Model stream failed");
          (err as any).partialText = "half-written answer";
          reject(err);
        }),
    );
    const call = agent.execute(
      "call-2",
      { subagent_type: "general", prompt: "work", description: "task" },
      undefined,
      undefined,
      fakeCtx(),
    );
    await expect(call).rejects.toThrow(/Subagent failed: Model stream failed/);
    // Shared wording: the partial text is clearly marked incomplete, and an
    // absent partial is stated explicitly rather than left ambiguous.
    await expect(call).rejects.toThrow(
      new RegExp("Partial assistant output \\(incomplete\\):\nhalf-written answer", "s"),
    );
  });

  it("a foreground failure without partial output says none is available", async () => {
    const agent = toolsRef!.get("Agent")!;
    runSubagentMock.mockImplementation(() => Promise.reject(new Error("boom before any text")));
    const call = agent.execute(
      "call-3",
      { subagent_type: "general", prompt: "work", description: "task" },
      undefined,
      undefined,
      fakeCtx(),
    );
    await expect(call).rejects.toThrow(/failed: boom before any text/);
    await expect(call).rejects.toThrow(/No partial assistant output is available\./);
  });

  it("gives background runs an abort signal stop_subagent can fire", async () => {
    const observed: Array<AbortSignal | undefined> = [];
    await launchBackground((opts: any) => {
      observed.push(opts.abortSignal);
      return new Promise(() => {});
    });
    expect(observed[0]).toBeInstanceOf(AbortSignal);
  });
});