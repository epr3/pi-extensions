import { describe, expect, it, vi } from "vitest";

// Resolve the runner at the SDK boundary only: runSubagent builds a real Pi
// sub-session (models, credentials) — not observable deterministically.
vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: vi.fn() };
});

import extension from "../index.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  hangingRunner,
  makeFakeApi,
  tuiCtx,
  type CapturedCommand,
  type CapturedEntry,
  type CapturedHandlers,
  type OpenedOverlay,
} from "./helpers.ts";

// Session-history fixtures — hand-built branch entries (receipt + record), as
// in the overlay tests: an Agent toolResult launch receipt and a persisted
// subagent-outcome-record.

function recordAsEntry(data: Record<string, unknown>) {
  return {
    type: "custom",
    customType: "subagent-outcome-record",
    data,
  } as any;
}

function receiptEntry(runId: string, description = "refactor the parser") {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: `tc_${runId}`,
      toolName: "Agent",
      content: [{ type: "text", text: `Subagent general "${description}" [run ${runId}]` }],
      details: { agent_id: runId, agentId: runId, type: "general", description, status: "queued" },
    },
  } as any;
}

interface Seam {
  agentTool: ToolDefinition;
  commands: CapturedCommand[];
  handlers: CapturedHandlers;
}

/** A real session at the seam: the extension registered (runner mocked). */
function setupSession(extra: { appendEntries?: CapturedEntry[] } = {}): Seam {
  const captured: ToolDefinition[] = [];
  const commands: CapturedCommand[] = [];
  const handlers: CapturedHandlers = new Map();
  extension(
    makeFakeApi(captured, {
      handlers,
      commands,
      appendEntries: extra.appendEntries,
    } as never),
  );
  const agentTool = captured.find((t) => t.name === "Agent");
  if (!agentTool?.execute) throw new Error("extension did not register the Agent tool");
  return { agentTool, commands, handlers };
}

// ---------------------------------------------------------------------------
// The fake interactive ctx comes from the shared helpers: it opens the
// /subagents overlay at the command seam and keeps the component so tests can
// re-render it — exactly how the open overview is observed while runs change.
// ---------------------------------------------------------------------------

function subagentsCommand(seam: Seam): CapturedCommand {
  const command = seam.commands.find((c) => c.name === "subagents");
  if (!command) throw new Error("/subagents was not registered");
  return command;
}

/** The joined text a captured overlay component renders at the given width. */
function rendered(overlay: OpenedOverlay, width = 80): string {
  return overlay.component.render(width).join("\n");
}

function launchedRunId(receipt: any): string {
  return String(receipt.details.agentId ?? receipt.details.agent_id);
}

// ---------------------------------------------------------------------------
// The open /subagents overview stays current while runs change: the same
// component re-renders on run lifecycle transitions, keeps active runs first
// and terminal runs newest-first, and shows the empty state again when the
// last run settles — all without closing and reopening the overview.
// ---------------------------------------------------------------------------

describe("/subagents — live Subagent overview at the extension UI seam", () => {
  it("updates an open overview from running to completed without reopening it", async () => {
    const seam = setupSession();
    const runner = hangingRunner(seam);
    const receipt = await runner.launch({ description: "watch me" });
    const command = subagentsCommand(seam);
    const { ctx, customCalls } = tuiCtx([]);
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;
    const initial = rendered(overlay);
    expect(initial).toMatch(/running/);
    expect(initial).not.toMatch(/completed/);
    expect(initial).toContain("watch me");

    runner.release();
    await receipt;
    await vi.waitFor(() => {
      const text = rendered(overlay);
      expect(text).toMatch(/completed/);
      expect(text).not.toMatch(/running/);
      expect(text).toContain("watch me");
    });
  });

  it("updates a queued run to running as queued work starts", async () => {
    process.env.PI_SUBAGENT_CONCURRENCY = "1";
    try {
      const seam = setupSession();
      const runner = hangingRunner(seam);
      const command = subagentsCommand(seam);
      const { ctx, customCalls } = tuiCtx([]);
      // Open the overview before anything is launched: empty for now.
      await command.handler(undefined, ctx);
      const overlay = customCalls[0]!;
      expect(rendered(overlay)).not.toMatch(/running/);

      const first = await runner.launch({ description: "a" });
      const second = await runner.launch({ description: "b" });
      // Under the cap of 1 one run starts; the other waits queued — and the
      // open overview tracks that without being reopened.
      await vi.waitFor(() => {
        const text = rendered(overlay);
        expect(text).toMatch(/running/);
        expect(text).toMatch(/queued/);
      });

      runner.release(0);
      await first;
      // The queued work starts as the slot frees; nothing is queued anymore.
      await vi.waitFor(() => {
        const text = rendered(overlay);
        expect(text).not.toMatch(/queued/);
        expect(text).toMatch(/running/);
      });

      runner.release(0);
      await second;
      await vi.waitFor(() => {
        const text = rendered(overlay);
        expect(text).toMatch(/completed/);
        expect(text).not.toMatch(/running/);
      });
    } finally {
      delete process.env.PI_SUBAGENT_CONCURRENCY;
    }
  });

  it("reorders an open overview as runs settle — active first, terminal newest first", async () => {
    const seam = setupSession();
    const runner = hangingRunner(seam);
    const command = subagentsCommand(seam);
    const { ctx, customCalls } = tuiCtx([]);
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;

    const first = await runner.launch({ description: "first" });
    const second = await runner.launch({ description: "second" });
    const third = await runner.launch({ description: "third" });
    const firstId = launchedRunId(first);
    const secondId = launchedRunId(second);
    const thirdId = launchedRunId(third);
    // Running runs are newest first.
    await vi.waitFor(() => {
      const text = rendered(overlay);
      expect(text.indexOf(`[run ${thirdId}]`)).toBeLessThan(text.indexOf(`[run ${secondId}]`));
      expect(text.indexOf(`[run ${secondId}]`)).toBeLessThan(text.indexOf(`[run ${firstId}]`));
    });

    // Settle the OLDEST run: it must drop behind the still-active ones.
    runner.release(0);
    await first;
    await vi.waitFor(() => {
      const text = rendered(overlay);
      expect(text.indexOf(`[run ${thirdId}]`)).toBeLessThan(text.indexOf(`[run ${secondId}]`));
      expect(text.indexOf(`[run ${secondId}]`)).toBeLessThan(text.indexOf(`[run ${firstId}]`));
    });
  });

  it("replaces the empty state with rows as runs appear while the overview is open", async () => {
    const seam = setupSession();
    const runner = hangingRunner(seam);
    const command = subagentsCommand(seam);
    const { ctx, customCalls } = tuiCtx([]);
    // Nothing is running and the branch is empty: the explicit empty state.
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;
    const before = rendered(overlay);
    expect(before).toMatch(/no subagent runs/i);
    expect(before).not.toMatch(/\[run /);

    // A run appears: the open overview leaves the empty state behind.
    const receipt = await runner.launch({ description: "only one" });
    await vi.waitFor(() => {
      const text = rendered(overlay);
      expect(text).toMatch(/running/);
      expect(text).toContain(`[run ${launchedRunId(receipt)}]`);
      expect(text).not.toMatch(/no subagent runs/i);
    });

    // It settles: the row remains, now in its terminal state.
    runner.release();
    await receipt;
    await vi.waitFor(() => expect(rendered(overlay)).toMatch(/completed/));
  });

  it("never duplicates a run when its outcome becomes available while the overview is open", async () => {
    const appendEntries: CapturedEntry[] = [];
    const seam = setupSession({ appendEntries });
    const branchEntries: unknown[] = [];
    const runner = hangingRunner(seam);
    const command = subagentsCommand(seam);
    const { ctx, customCalls } = tuiCtx(branchEntries);

    // One live running run, open overview, empty branch history.
    const receiptA = await runner.launch({ description: "settle me" });
    const idA = launchedRunId(receiptA);
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;
    expect(rendered(overlay).split(`[run ${idA}]`)).toHaveLength(2);

    // The run settles: its branch-local outcome becomes available while the
    // overview stays open (launch receipt in history plus the persisted
    // outcome record written on settle).
    runner.release();
    await receiptA;
    await vi.waitFor(() => expect(appendEntries.length).toBeGreaterThan(0));
    const outcome = appendEntries.at(-1)!.data as Record<string, unknown>;
    expect(outcome.runId).toBe(idA);
    branchEntries.push(receiptEntry(idA), recordAsEntry(outcome));

    // A further run lifecycle event rebuilds the rows — the run whose outcome
    // became available must still appear exactly once, not once live and once
    // reconstructed.
    const receiptB = await runner.launch({ description: "another" });
    await vi.waitFor(() => {
      const text = rendered(overlay);
      expect(text.split(`[run ${idA}]`)).toHaveLength(2);
      expect(text).toContain(`[run ${launchedRunId(receiptB)}]`);
      expect(text).toContain(`[run ${idA}] — general "settle me" — completed`);
    });
  });

  it("never takes a dying session's shutdown update into its open overview", async () => {
    const seam = setupSession();
    const branchEntries: unknown[] = [];
    const runner = hangingRunner(seam);
    const command = subagentsCommand(seam);
    const { ctx, customCalls } = tuiCtx(branchEntries);

    const receipt = await runner.launch({ description: "mine" });
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;
    expect(rendered(overlay)).toMatch(/running/);

    // Session shutdown or replacement settles this session's runs to stopped
    // — but the open overview is keyed to the dying session: none of those
    // settles may re-render it (nothing stale may appear in the replacement
    // session's own view).
    const callsBeforeShutdown = rendered(overlay);
    seam.handlers.get("session_shutdown")!({}, { hasUI: true, mode: "tui" });
    await receipt;
    await new Promise((r) => setTimeout(r, 50));

    expect(rendered(overlay)).toBe(callsBeforeShutdown);
    expect(rendered(overlay)).toMatch(/running/);
    expect(rendered(overlay)).not.toMatch(/stopped/);

    // The run registry belongs to its session: a successor context launches
    // nothing through the dying session's manager.
    await expect(runner.launch({ description: "too late" })).rejects.toThrow(
      /shutdown|replacement/,
    );
  });
});