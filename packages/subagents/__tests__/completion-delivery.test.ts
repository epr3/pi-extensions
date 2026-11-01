import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentManager, type AgentRecord } from "../manager.ts";
import type { RunResult } from "../runner.ts";
import { RESULT_TEXT_LIMIT } from "../result-limit.ts";
import {
  CompletionDelivery,
  OUTCOME_MESSAGE_TYPE,
  ParentBusyTracker,
  modeDeliveryDiagnostic,
  outcomeMessage,
  type DeliverySink,
  type DeliveryDiagnostic,
} from "../delivery.ts";

/** Never-settling exec that still observes the abort signal. */
const observeSignal = (signal: AbortSignal): Promise<RunResult> =>
  new Promise<RunResult>(() => {
    void signal;
  });

/** Same, in the extension exec-args shape ({ abortSignal }): rejects on abort. */
function backgroundAbortableExec(partialText?: string): (opts: any) => Promise<RunResult> {
  return (opts: any) =>
    new Promise((_resolve, reject) => {
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

/** Exec that rejects the way runSubagentSession does when its signal aborts. */
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

function record(patch: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "sa_1_test",
    type: "explore",
    description: "find auth helpers",
    status: "completed",
    background: true,
    result: "the bounded answer",
    tokens: 4,
    toolUses: 2,
    ...patch,
  } as AgentRecord;
}

/** Recording DeliverySink for coordinator unit tests. */
function recordingSink(): DeliverySink & {
  queued: unknown[];
  started: unknown[];
  busy: boolean;
  failWith?: unknown;
} {
  const sink = {
    busy: false,
    queued: [] as unknown[],
    started: [] as unknown[],
    failWith: undefined as unknown,
    isParentBusy() {
      return sink.busy;
    },
    queueFollowUp(msg: unknown) {
      if (sink.failWith) throw sink.failWith;
      sink.queued.push(msg);
    },
    startParentTurn(msg: unknown) {
      if (sink.failWith) throw sink.failWith;
      sink.started.push(msg);
    },
  };
  return sink;
}

// ---------------------------------------------------------------------------
// delivery.ts — attributed outcome message composition
// ---------------------------------------------------------------------------

describe("outcomeMessage — one attributed completion per run's outcome", () => {
  it("identifies the run (type, description, id) and carries the bounded result", () => {
    const msg = outcomeMessage(record({ result: "the bounded answer" }));
    expect(msg.customType).toBe(OUTCOME_MESSAGE_TYPE);
    expect(msg.content).toContain("explore");
    expect(msg.content).toContain("find auth helpers");
    expect(msg.content).toContain("sa_1_test");
    expect(msg.content).toContain("the bounded answer");
    expect(msg.content).toContain("completed");
    expect(msg.details).toMatchObject({
      agentId: "sa_1_test",
      type: "explore",
      status: "completed",
    });
  });

  it("names failed runs with the failure reason and marks partial output incomplete", () => {
    const msg = outcomeMessage(
      record({ status: "failed", error: "provider 500", result: undefined, partialText: "draft" }),
    );
    expect(msg.content).toContain("failed");
    expect(msg.content).toContain("provider 500");
    expect(msg.content).toContain("draft");
    expect(msg.content).toContain("incomplete");
    expect(msg.details).toMatchObject({ status: "failed", error: "provider 500" });
  });

  it("names stopped runs with the reason and explicit no-output wording", () => {
    const msg = outcomeMessage(
      record({ status: "stopped", stopReason: "Stopped by request", result: undefined }),
    );
    expect(msg.content).toContain("stopped");
    expect(msg.content).toContain("Stopped by request");
    expect(msg.content).toContain("No partial assistant output is available.");
    expect(msg.details).toMatchObject({ status: "stopped" });
  });

  it("does not include tool activity or thinking payloads", () => {
    const msg = outcomeMessage(record());
    expect(JSON.stringify(msg)).not.toMatch(/streamEntries|tool_execution|thinking/);
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — mode capability diagnostic (keyed off ctx.mode, never hasUI)
// ---------------------------------------------------------------------------

describe("modeDeliveryDiagnostic", () => {
  it("diagnoses print mode as unable to promise later continuation", () => {
    const diag = modeDeliveryDiagnostic("print")!;
    expect(diag).toContain("print");
    expect(diag).toMatch(/cannot promise|not guaranteed|not promised/i);
    expect(diag).toContain("get_subagent_result");
  });

  it("diagnoses json mode the same way", () => {
    expect(modeDeliveryDiagnostic("json")).toBeDefined();
  });

  it("leaves conversation-capable modes promised", () => {
    expect(modeDeliveryDiagnostic("tui")).toBeUndefined();
    expect(modeDeliveryDiagnostic("rpc")).toBeUndefined();
    expect(modeDeliveryDiagnostic(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — parent busy tracking (without hidden inference from UI state)
// ---------------------------------------------------------------------------

describe("ParentBusyTracker", () => {
  it("tracks agent_start through agent_settled as busy", () => {
    const tracker = new ParentBusyTracker();
    expect(tracker.isBusy()).toBe(false);
    tracker.onAgentStart();
    expect(tracker.isBusy()).toBe(true);
    tracker.onAgentStart(); // nested/steered turns still end at one settled
    expect(tracker.isBusy()).toBe(true);
    tracker.onAgentSettled();
    expect(tracker.isBusy()).toBe(false);
    tracker.onAgentStart();
    expect(tracker.isBusy()).toBe(true);
    tracker.onAgentSettled();
    expect(tracker.isBusy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// delivery.ts — completion delivery coordinator (busy/idle, unique, cancel)
// ---------------------------------------------------------------------------

describe("CompletionDelivery — busy/idle delivery choice", () => {
  it("busy parent: queues a non-interrupting follow-up, never starts a turn", () => {
    const sink = recordingSink();
    const delivery = new CompletionDelivery(sink);
    sink.busy = true;
    delivery.deliver(record());
    expect(sink.queued).toHaveLength(1);
    expect(sink.started).toHaveLength(0);
  });

  it("idle parent: starts a parent turn, never a queue insert", () => {
    const sink = recordingSink();
    const delivery = new CompletionDelivery(sink);
    delivery.deliver(record());
    expect(sink.started).toHaveLength(1);
    expect(sink.queued).toHaveLength(0);
  });
});

describe("CompletionDelivery — at most one delivery per run", () => {
  it("delivers each run once; repeat settles are ignored", () => {
    const sink = recordingSink();
    const delivery = new CompletionDelivery(sink);
    const rec = record();
    delivery.deliver(rec);
    delivery.deliver(rec);
    expect(sink.started).toHaveLength(1);
  });

  it("delivers distinct runs distinctly", () => {
    const sink = recordingSink();
    const delivery = new CompletionDelivery(sink);
    delivery.deliver(record({ id: "sa_1_a" }));
    delivery.deliver(record({ id: "sa_2_b", description: "second" }));
    expect(sink.started).toHaveLength(2);
  });

  it("ignores foreground runs (they return inline)", () => {
    const sink = recordingSink();
    const delivery = new CompletionDelivery(sink);
    delivery.deliver(record({ background: false }));
    expect(sink.started).toHaveLength(0);
    expect(sink.queued).toHaveLength(0);
  });
});

describe("CompletionDelivery — stale sessions and deactivation guards", () => {
  it("deactivation drops further deliveries silently", () => {
    const sink = recordingSink();
    const delivery = new CompletionDelivery(sink);
    delivery.deactivate();
    delivery.deliver(record());
    delivery.deliver(record({ id: "sa_2_x" }));
    expect(sink.started).toHaveLength(0);
    expect(sink.queued).toHaveLength(0);
    expect(delivery.isDelivered("sa_1_test")).toBe(false);
  });

  it("swallows the 0.84.1 stale-context error without rethrow or diagnostic", () => {
    const sink = recordingSink();
    sink.failWith = new Error(
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession()",
    );
    const onErrors: DeliveryDiagnostic[] = [];
    const delivery = new CompletionDelivery(sink, { onError: (d) => onErrors.push(d) });
    expect(() => delivery.deliver(record())).not.toThrow();
    expect(onErrors).toHaveLength(0);
  });

  it("reports non-stale sink failures through the diagnostic channel", () => {
    const sink = recordingSink();
    sink.failWith = new Error("something else");
    const onErrors: DeliveryDiagnostic[] = [];
    const delivery = new CompletionDelivery(sink, { onError: (d) => onErrors.push(d) });
    expect(() => delivery.deliver(record())).not.toThrow();
    expect(onErrors).toHaveLength(1);
    expect(onErrors[0]).toMatchObject({ runId: "sa_1_test" });
  });
});

// ---------------------------------------------------------------------------
// AgentManager — session shutdown stops queued and running work (idempotent)
// ---------------------------------------------------------------------------

describe("AgentManager.shutdown — stop everything, own the session", () => {
  it("stops a queued run before it ever starts", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    manager.launch(
      { type: "general", description: "a", background: true },
      () => new Promise<RunResult>(() => {}),
    );
    let started = false;
    const queued = manager.launch(
      { type: "general", description: "b", background: true },
      (signal: AbortSignal) => {
        started = true;
        return observeSignal(signal);
      },
    );
    manager.shutdown("Session ended");
    expect(queued.record.status).toBe("stopped");
    expect(queued.record.background).toBe(true);
    expect(queued.record.stopReason).toContain("Session ended");
    expect(started).toBe(false);
  });

  it("aborts the running run and does not start the next queued one", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    let abortObserved: AbortSignal | undefined;
    const running = manager.launch(
      { type: "general", description: "a", background: true },
      (signal: AbortSignal) => {
        abortObserved = signal;
        return new Promise<RunResult>((_resolve) => {
          signal.addEventListener("abort", () => void 0, { once: true });
          // Exec never rejects on its own; shutdown's abort is the only exit.
          return observeSignal(signal);
        });
      },
    );
    manager.launch({ type: "general", description: "b", background: true }, (signal: AbortSignal) =>
      observeSignal(signal),
    );
    manager.shutdown("Session ended");
    expect(abortObserved?.aborted).toBe(true);
    // The queued successor is stopped by the same shutdown and never starts,
    // even after a tick.
    await new Promise((r) => setTimeout(r, 20));
    const successor = manager.list().find((r) => r.description === "b")!;
    expect(successor.status).toBe("stopped");
    expect(running.record.status).toBe("stopped");
  });

  it("is idempotent: a second shutdown changes nothing further", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const events: string[] = [];
    const mgr = new AgentManager({
      maxConcurrency: 1,
      onEvent: (name) => events.push(name),
    });
    mgr.launch(
      { type: "general", description: "a", background: true },
      abortableExec("partial") as (signal: AbortSignal) => Promise<RunResult>,
    );
    mgr.shutdown("Session ended");
    const after = JSON.stringify(mgr.list());
    mgr.shutdown("Session ended");
    expect(JSON.stringify(mgr.list())).toBe(after);
    expect(events.filter((n) => n === "stopped").length).toBeLessThanOrEqual(1);
    void manager;
  });

  it("refuses launches after shutdown instead of queueing forever", () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    manager.shutdown("Session ended");
    expect(() =>
      manager.launch(
        { type: "general", description: "late", background: true },
        () => new Promise<RunResult>(() => {}),
      ),
    ).toThrow(/shutdown/i);
  });
});

// ---------------------------------------------------------------------------
// Extension seam: full wiring through fake pi (sendMessage captured)
// ---------------------------------------------------------------------------

import { default as subagentsExtension } from "../index.ts";
import { makeFakeApi, type CapturedHandlers, type CapturedSend } from "./helpers.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

interface Seam {
  tools: Map<string, ToolDefinition>;
  sends: CapturedSend[];
  handlers: CapturedHandlers;
}

function registerSeam(api?: ExtensionAPI): Seam {
  const tools: ToolDefinition[] = [];
  const sends: CapturedSend[] = [];
  const handlers: CapturedHandlers = new Map();
  subagentsExtension(api ?? makeFakeApi(tools, { sends, handlers }));
  return { tools: new Map(tools.map((t) => [t.name, t as ToolDefinition])), sends, handlers };
}

let seam: Seam;
beforeEach(() => {
  runSubagentMock.mockReset();
  seam = registerSeam();
});

function fakeCtx(patch: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: "tui",
    model: undefined,
    signal: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => "sess-1" },
    ...patch,
  } as any;
}

function sendText(send: CapturedSend): string {
  const content = send.message.content;
  return typeof content === "string" ? content : content.map((c) => c.text).join("\n");
}

/** Launch a background run; returns the tool result (details.agent_id). */
async function launchBackground(
  bgExec: (opts: any) => Promise<any>,
  ctxPatch: Record<string, unknown> = {},
  callId = "call-1",
): Promise<any> {
  runSubagentMock.mockImplementation(bgExec);
  return (await seam.tools
    .get("Agent")!
    .execute(
      callId,
      { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
      undefined,
      undefined,
      fakeCtx(ctxPatch),
    )) as any;
}

async function launchBackgroundId(
  bgExec: (opts: any) => Promise<any>,
  ctxPatch: Record<string, unknown> = {},
): Promise<string> {
  const res = await launchBackground(bgExec, ctxPatch);
  expect(res.details.agent_id).toBeTypeOf("string");
  return res.details.agent_id as string;
}

function fire(event: string, payload: Record<string, unknown> = {}) {
  return seam.handlers.get(event)?.(payload, fakeCtx());
}

const busyTurn = {
  start: () => fire("agent_start", { type: "agent_start" }),
  settled: () => fire("agent_settled", { type: "agent_settled" }),
};

describe("extension wiring — background completions deliver one attributed message", () => {
  it("delivers the completed result bounded by the shared result limit", async () => {
    const huge = "x".repeat(RESULT_TEXT_LIMIT + 500);
    const id = await launchBackgroundId(async () => ({ result: huge, tokens: 9, toolUses: 3 }));
    await seam.tools.get("get_subagent_result")!.execute("call-2", { agent_id: id, wait: true });

    expect(seam.sends).toHaveLength(1);
    const text = sendText(seam.sends[0]);
    expect(text).toContain("[Truncated:");
    expect(text).toContain("20,000");
    expect(text.length).toBeLessThan(huge.length + 200);
  });

  it("busy parent, then retrieval: one subagent-outcome message with attribution", async () => {
    busyTurn.start();
    const id = await launchBackgroundId(async () => ({
      result: "found it",
      tokens: 2,
      toolUses: 1,
    }));
    await seam.tools.get("get_subagent_result")!.execute("call-2", { agent_id: id, wait: true });

    expect(seam.sends).toHaveLength(1);
    const send = seam.sends[0];
    expect(send.message.customType).toBe("subagent-outcome");
    expect(send.options?.triggerTurn).toBe(true);
    const text = sendText(send);
    expect(text).toContain("general");
    expect(text).toContain("task");
    expect(text).toContain(id);
    expect(text).toContain("found it");
    expect(text).toContain("completed");
    expect(send.options?.deliverAs).toBe("followUp");
    expect(send.message.details).toMatchObject({
      agentId: id,
      status: "completed",
      type: "general",
    });
    expect(text).not.toMatch(/tool_execution|thinking|streamEntries/);
    busyTurn.settled();
  });

  it("idle parent: delivers and sets the turn-start option", async () => {
    const id = await launchBackgroundId(async () => ({
      result: "done idle",
      tokens: 1,
      toolUses: 0,
    }));
    await seam.tools.get("get_subagent_result")!.execute("call-2", { agent_id: id, wait: true });
    expect(seam.sends).toHaveLength(1);
    expect(seam.sends[0].options?.triggerTurn).toBe(true);
    expect(seam.sends[0].options?.deliverAs).toBeUndefined();
  });

  it("stopped run delivers exactly one stopped completion with marked partial output", async () => {
    const id = await launchBackgroundId(backgroundAbortableExec("draft text"));
    await seam.tools.get("stop_subagent")!.execute("call-2", { agent_id: id });
    expect(seam.sends).toHaveLength(1);
    const text = sendText(seam.sends[0]);
    expect(text).toContain("stopped");
    expect(text).toContain("draft text");
    expect(text).toContain("incomplete");
    expect((seam.sends[0].message.details as any).status).toBe("stopped");
  });

  it("failed run delivers one failed completion with the reason", async () => {
    const id = await launchBackgroundId(async () => {
      const err = new Error("model unavailable");
      (err as any).partialText = "draft so far";
      throw err;
    });
    await seam.tools.get("get_subagent_result")!.execute("call-2", { agent_id: id, wait: true });
    expect(seam.sends).toHaveLength(1);
    const text = sendText(seam.sends[0]);
    expect(text).toContain("failed");
    expect(text).toContain("model unavailable");
    expect(text).toContain("draft so far");
  });

  it("explicit retrieval never re-delivers", async () => {
    const id = await launchBackgroundId(async () => ({ result: "found", tokens: 1, toolUses: 0 }));
    await seam.tools.get("get_subagent_result")!.execute("call-2", { agent_id: id, wait: true });
    expect(seam.sends).toHaveLength(1);
    await seam.tools.get("get_subagent_result")!.execute("call-3", { agent_id: id });
    await seam.tools.get("get_subagent_result")!.execute("call-4", { agent_id: id });
    expect(seam.sends).toHaveLength(1);
  });

  it("does not deliver foreground results", async () => {
    runSubagentMock.mockImplementation(async () => ({ result: "fg", tokens: 1, toolUses: 0 }));
    await seam.tools
      .get("Agent")!
      .execute(
        "call-1",
        { subagent_type: "general", prompt: "work", description: "fast" },
        undefined,
        undefined,
        fakeCtx(),
      );
    expect(seam.sends).toHaveLength(0);
  });
});

describe("extension wiring — mode diagnostics on background launches", () => {
  it("print mode: launch result reports automatic delivery is not promised", async () => {
    const res = await launchBackground(async () => ({ result: "r", tokens: 1, toolUses: 0 }), {
      mode: "print",
    });
    expect(res.details.delivery).toMatchObject({ promised: false, mode: "print" });
    expect(String(res.content[0].text)).toMatch(/not promised|cannot/i);
  });

  it("json mode: same diagnostic despite hasUI false; tui/rpc stay quiet", async () => {
    runSubagentMock.mockImplementation(async () => ({ result: "r", tokens: 1, toolUses: 0 }));
    const jsonRes = (await seam.tools
      .get("Agent")!
      .execute(
        "call-1",
        { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
        undefined,
        undefined,
        fakeCtx({ mode: "json", hasUI: false }),
      )) as any;
    expect(jsonRes.details.delivery).toMatchObject({ promised: false, mode: "json" });
    expect(String(jsonRes.content[0].text)).toMatch(/not promised|cannot/i);

    for (const [mode, hasUI] of [
      ["tui", true],
      ["tui", false],
      ["rpc", true],
    ] as const) {
      const res = (await seam.tools
        .get("Agent")!
        .execute(
          "call-x",
          {
            subagent_type: "general",
            prompt: "work",
            description: "task",
            run_in_background: true,
          },
          undefined,
          undefined,
          fakeCtx({ mode, hasUI }),
        )) as any;
      expect(res.details.delivery).toBeUndefined();
      expect(String(res.content[0].text)).not.toMatch(/not promised|cannot/i);
      await seam.tools
        .get("get_subagent_result")!
        .execute("call-x2", { agent_id: res.details.agent_id, wait: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Extension seam: session shutdown, replacement, cross-session safety
// ---------------------------------------------------------------------------

describe("extension wiring — session shutdown stops runs and never delivers", () => {
  it("session_shutdown aborts running work and stops queued work; nothing is delivered", async () => {
    const busyRunId = await launchBackgroundId(() => new Promise(() => {}));
    const queuedId = await launchBackgroundId(() => new Promise(() => {}));
    fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

    await new Promise((r) => setTimeout(r, 30));
    const result = seam.tools.get("get_subagent_result")!;
    const busyRec = (await result.execute("call-1", { agent_id: busyRunId })) as any;
    const queuedRec = (await result.execute("call-2", { agent_id: queuedId })) as any;
    expect(busyRec.details.status).toBe("stopped");
    expect(queuedRec.details.status).toBe("stopped");
    expect(seam.sends).toHaveLength(0);
  });

  it("launches after shutdown are refused", async () => {
    fire("session_shutdown", { type: "session_shutdown", reason: "new" });
    runSubagentMock.mockImplementation(async () => ({ result: "r", tokens: 1, toolUses: 0 }));
    await expect(
      seam.tools
        .get("Agent")!
        .execute(
          "call-1",
          {
            subagent_type: "general",
            prompt: "work",
            description: "task",
            run_in_background: true,
          },
          undefined,
          undefined,
          fakeCtx(),
        ),
    ).rejects.toThrow(/shutdown|replacement/i);
    expect(seam.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stale-context guarding at the sink (0.84.1 throws on captured pi/ctx)
// ---------------------------------------------------------------------------

function staleApi(tools: ToolDefinition[], handlers: CapturedHandlers): ExtensionAPI {
  const base = makeFakeApi(tools, { handlers });
  return {
    ...base,
    sendMessage: () => {
      throw new Error(
        "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession()",
      );
    },
  } as unknown as ExtensionAPI;
}

describe("extension wiring — stale sink failures are guarded", () => {
  it("a stale pi does not break the launch or the settle path; no bogus sends", async () => {
    const tools: ToolDefinition[] = [];
    const handlers: CapturedHandlers = new Map();
    subagentsExtension(staleApi(tools, handlers));
    const newSeam: Seam = {
      tools: new Map(tools.map((t) => [t.name, t as ToolDefinition])),
      sends: [],
      handlers,
    };
    runSubagentMock.mockImplementation(async () => ({ result: "r", tokens: 1, toolUses: 0 }));
    const res = (await newSeam.tools
      .get("Agent")!
      .execute(
        "call-1",
        { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
        undefined,
        undefined,
        fakeCtx(),
      )) as any;
    expect(res.details.agent_id).toBeTypeOf("string");
    // Retrieval still works after a failed delivery attempt.
    const got = (await newSeam.tools
      .get("get_subagent_result")!
      .execute("call-2", { agent_id: res.details.agent_id, wait: true })) as any;
    expect(got.details.status).toBe("completed");
    expect(got.details.result).toBe("r");
  });
});