import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

// Resolve the runner at the SDK boundary only: runSubagent builds a real Pi
// sub-session (models, credentials) — not observable deterministically.
// Everything the extension layer does above it is exercised for real here.
vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: vi.fn() };
});

import extension from "../index.ts";
import { OUTCOME_RECORD_TYPE } from "../outcome-records.ts";
import type { OutcomeRecord } from "../outcome-records.ts";
import {
  makeFakeApi,
  type CapturedHandlers,
  type CapturedEntry,
  type CapturedSend,
  type CapturedCommand,
} from "./helpers.ts";
import { runSubagent } from "../runner.ts";

const runSubagentMock = vi.mocked(runSubagent);

function setupSession() {
  const captured: ToolDefinition[] = [];
  const handlers: CapturedHandlers = new Map();
  const appendEntries: CapturedEntry[] = [];
  const sends: CapturedSend[] = [];
  const commands: CapturedCommand[] = [];
  extension(makeFakeApi(captured, { handlers, appendEntries, sends, commands }));
  const agentTool = captured.find((t) => t.name === "Agent");
  if (!agentTool) throw new Error("extension did not register the Agent tool");
  return { agentTool, handlers, appendEntries, sends, commands };
}

function toolCtx() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: "tui" as const,
    signal: undefined,
    model: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: vi.fn() },
  };
}

/** Contextual params the tool accepts: built-in "general", minimal shape. */
function launchParams(over: Record<string, unknown> = {}) {
  return { subagent_type: "general", prompt: "do it", description: "d", ...over };
}

type Execute = NonNullable<ToolDefinition["execute"]>;

// ---------------------------------------------------------------------------
// Persistence: each terminal background outcome appends one record entry
// through the originating session's pi.appendEntry.
// ---------------------------------------------------------------------------

describe("background outcome persistence at the extension seam", () => {
  it("a settled background run persists its outcome with the captured activity tail", async () => {
    const { agentTool, appendEntries } = setupSession();
    runSubagentMock.mockImplementation(async (opts) => {
      opts.onStreamEvent?.({ type: "text_delta", delta: "working" });
      opts.onStreamEvent?.({ type: "tool_start", name: "grep" });
      opts.onStreamEvent?.({ type: "tool_end", name: "grep", error: false });
      return { result: "done", tokens: 3, toolUses: 2 };
    });
    // onUpdate present: a background run must never emit live updates.
    const onUpdate = vi.fn();
    const result = await (agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      onUpdate as never,
      toolCtx() as never,
    );
    expect(onUpdate).not.toHaveBeenCalled(); // activity stayed UI-only, off-context

    await vi.waitFor(() => expect(appendEntries).toHaveLength(1));
    const entry = appendEntries[0];
    expect(entry.customType).toBe(OUTCOME_RECORD_TYPE);
    const data = entry.data as OutcomeRecord;
    expect(data.runId).toBe((result as { details: { agent_id: string } }).details.agent_id);
    expect(data.status).toBe("completed");
    expect(data.result).toBe("done");
    expect(data.activity).toEqual([
      { type: "text", text: "working" },
      { type: "tool_start", name: "grep" },
      { type: "tool_end", name: "grep", error: false },
    ]);
    expect(data.activityOmitted).toBe(0);
  });

  it("a long background run persists the bounded 50-entry tail with its omission count", async () => {
    const { agentTool, appendEntries } = setupSession();
    runSubagentMock.mockImplementation(async (opts) => {
      for (let i = 0; i < 60; i++) opts.onStreamEvent?.({ type: "tool_start", name: `t${i}` });
      return { result: "out", tokens: 1, toolUses: 60 };
    });
    await (agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      undefined,
      toolCtx() as never,
    );
    await vi.waitFor(() => expect(appendEntries).toHaveLength(1));
    const data = appendEntries[0].data as OutcomeRecord;
    expect(data.activity).toHaveLength(50);
    expect(data.activityOmitted).toBe(10);
    expect(data.activity[0]).toEqual({ type: "tool_start", name: "t10" });
  });

  it("a completed background run still delivers once — persistence and delivery coexist", async () => {
    const { agentTool, sends, appendEntries } = setupSession();
    runSubagentMock.mockResolvedValue({ result: "done", tokens: 1, toolUses: 0 });
    await (agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      undefined,
      toolCtx() as never,
    );
    await vi.waitFor(() => expect(appendEntries).toHaveLength(1));
    // The delivered completion names the run and result; activity content
    // (and no other built-ins) never enters model-facing text.
    await vi.waitFor(() => expect(sends.length).toBeGreaterThanOrEqual(1));
    const text = JSON.stringify(sends[0].message.content);
    expect(text).toContain("done");
    expect(text).not.toContain("tool_start");
  });

  it("foreground runs are never persisted — they return inline", async () => {
    const { agentTool, appendEntries } = setupSession();
    runSubagentMock.mockResolvedValue({ result: "fg answer", tokens: 2, toolUses: 1 });
    const result = await (agentTool.execute as Execute)(
      "t1",
      launchParams(),
      undefined,
      undefined,
      toolCtx() as never,
    );
    expect((result as { content: [{ text: string }] }).content[0].text).toBe("fg answer");
    // settle is synchronous for the in-memory fake; give the hook a beat
    await Promise.resolve();
    await Promise.resolve();
    expect(appendEntries).toHaveLength(0);
  });

  it("a failed background run persists reason and marked partial text", async () => {
    const { agentTool, appendEntries } = setupSession();
    runSubagentMock.mockImplementation(async (opts) => {
      opts.onStreamEvent?.({ type: "text_delta", delta: "started but" });
      const e = new Error("provider exploded");
      Object.assign(e, { partialText: "started but" });
      throw e;
    });
    await (agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      undefined,
      toolCtx() as never,
    );
    await vi.waitFor(() => expect(appendEntries).toHaveLength(1));
    const data = appendEntries[0].data as OutcomeRecord;
    expect(data.status).toBe("failed");
    expect(data.error).toBe("provider exploded");
    expect(data.partialText).toBe("started but");
  });
});

// ---------------------------------------------------------------------------
// Session ownership and shutdown ordering: delivery is deactivated before the
// manager stops runs, so shutdown-stopped runs never deliver to a dying or
// replaced session, while a still-writable owning session persists their
// stopped outcome (best-effort). After shutdown nothing launches or persists.
// ---------------------------------------------------------------------------

describe("session ownership over the run lifecycle", () => {
  it("shutdown stops a running background run, persists it as stopped, and never delivers it", async () => {
    const { agentTool, handlers, appendEntries, sends } = setupSession();
    runSubagentMock.mockImplementation(() => new Promise(() => {})); // hangs until aborted
    const launchPromise = (agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      undefined,
      toolCtx() as never,
    );
    // Wait until the run is actually running, then replace/quit the session.
    await vi.waitFor(() => {
      expect((runSubagentMock.mock.calls[0]?.[0] as undefined) !== undefined).toBe(true);
    });
    const shutdown = handlers.get("session_shutdown");
    expect(shutdown).toBeDefined();
    shutdown!({}, undefined);
    await launchPromise; // receipt returned before shutdown; settle stops the run

    await vi.waitFor(() => expect(appendEntries).toHaveLength(1));
    const data = appendEntries[0].data as OutcomeRecord;
    expect(data.status).toBe("stopped");
    expect(data.stopReason).toMatch(/shutdown|Session ended|replacement/i);
    expect(sends).toHaveLength(0); // owner is gone: no attributed completion
  });

  it("launching after session shutdown fails — the registry is closed with its owner", async () => {
    const { agentTool, handlers } = setupSession();
    handlers.get("session_shutdown")!({}, undefined);
    await expect(
      (agentTool.execute as Execute)(
        "t1",
        launchParams({ run_in_background: true }),
        undefined,
        undefined,
        toolCtx() as never,
      ),
    ).rejects.toThrow();
    runSubagentMock.mockClear();
    expect(runSubagentMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Revisit: the current branch's history reconstructs outcomes; the /subagents
// command shows them without redelivering anything or starting a model turn.
// ---------------------------------------------------------------------------

const RECEIPT_TEXT =
  'Started background Subagent — general "refactor the parser" [run sa_1_ab] — status: queued.';

function receiptEntry(runId: string) {
  return {
    type: "message",
    id: "r1",
    parentId: "r0",
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "Agent",
      content: [{ type: "text", text: RECEIPT_TEXT }],
      details: { agent_id: runId, status: "queued" },
    } as unknown as ToolResultMessage,
  };
}

function recordEntry(data: OutcomeRecord) {
  return {
    type: "custom",
    id: "c1",
    parentId: "r1",
    timestamp: new Date().toISOString(),
    customType: OUTCOME_RECORD_TYPE,
    data,
  };
}

const PERSISTED: OutcomeRecord = {
  runId: "sa_1_ab",
  type: "general",
  description: "refactor the parser",
  status: "completed",
  result: "the answer",
  tokens: 4,
  toolUses: 2,
  activity: [{ type: "tool_start", name: "read" }],
  activityOmitted: 0,
  persistedAt: new Date().toISOString(),
};

describe("revisit presentation over reconstructed branch history", () => {
  it("the /subagents command lists the reloaded outcome without redelivery or a model turn", () => {
    const { commands, sends } = setupSession();
    const command = commands.find((c) => c.name === "subagents");
    expect(command).toBeDefined();
    const notified: string[] = [];
    command!.handler(undefined, {
      ui: { notify: (msg: string) => notified.push(msg) },
      sessionManager: { getBranch: () => [receiptEntry("sa_1_ab"), recordEntry(PERSISTED)] },
    });
    const text = notified.join("\n");
    expect(text).toContain("sa_1_ab");
    expect(text).toContain("completed");
    expect(text).toContain("the answer");
    // Revisit delivers nothing: no redelivery, no turn-starting message.
    expect(sends).toHaveLength(0);
  });

  it("a receipt on the branch without a recorded outcome reads outcome unavailable", () => {
    const { commands } = setupSession();
    const command = commands.find((c) => c.name === "subagents")!;
    const notified: string[] = [];
    command.handler(undefined, {
      ui: { notify: (msg: string) => notified.push(msg) },
      sessionManager: { getBranch: () => [receiptEntry("sa_1_ab")] },
    });
    const text = notified.join("\n");
    expect(text).toContain("outcome unavailable");
    expect(text).not.toMatch(/running|failed/);
  });
});