import { describe, expect, it, vi } from "vitest";

// Resolve the runner at the SDK boundary only: runSubagent builds a real Pi
// sub-session (models, credentials) — not observable deterministically.
vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: vi.fn() };
});

import extension from "../index.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runSubagent } from "../runner.ts";
import {
  launchParams,
  makeFakeApi,
  tuiCtx,
  toolCtx,
  type CapturedCommand,
  type CapturedHandlers,
  type OpenedOverlay,
} from "./helpers.ts";

const runSubagentMock = vi.mocked(runSubagent);

/** Raw terminal byte sequences the TUI sends a focused component. */
const KEYS = {
  escape: "\x1b",
  enter: "\r",
  down: "\x1b[B",
  up: "\x1b[A",
  pageDown: "\x1b[6~",
  pageUp: "\x1b[5~",
} as const;

// ---------------------------------------------------------------------------
// Session-history fixtures — hand-built branch entries (receipt + record), as
// in revisit tests: an Agent toolResult launch receipt and a persisted
// subagent-outcome-record.
// ---------------------------------------------------------------------------

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

function recordEntry(
  runId: string,
  status: "completed" | "failed" | "stopped",
  extra: object = {},
) {
  return {
    type: "custom",
    customType: "subagent-outcome-record",
    data: {
      runId,
      type: "general",
      description: "refactor the parser",
      status,
      tokens: 3,
      toolUses: 2,
      activity: [],
      activityOmitted: 0,
      persistedAt: "2026-11-01T00:00:00.000Z",
      ...(status === "completed" ? { result: "the answer" } : {}),
      ...extra,
    },
  } as any;
}

// ---------------------------------------------------------------------------
// The fake interactive ctx is the shared helper: it records what /subagents
// shows and captures the overlay component the command hands to ctx.ui.custom
// so tests drive and observe user-visible rendering and input at the seam.
// ---------------------------------------------------------------------------

function registerCommand() {
  const seam = setupSession();
  return subagentsCommand(seam);
}

/** The joined text a captured overlay component renders at the given width. */
function rendered(overlay: OpenedOverlay, width = 80): string {
  return overlay.component.render(width).join("\n");
}

// ---------------------------------------------------------------------------
// A real session at the seam: the extension registered, its Agent tool
// available for launching live runs (runner mocked — SDK boundary only).
// ---------------------------------------------------------------------------

interface Seam {
  agentTool: ToolDefinition;
  commands: CapturedCommand[];
  handlers: CapturedHandlers;
}

type Execute = NonNullable<ToolDefinition["execute"]>;

function setupSession(): Seam {
  const captured: ToolDefinition[] = [];
  const commands: CapturedCommand[] = [];
  const handlers: CapturedHandlers = new Map();
  extension(makeFakeApi(captured, { handlers, commands } as never));
  const agentTool = captured.find((t) => t.name === "Agent");
  if (!agentTool?.execute) throw new Error("extension did not register the Agent tool");
  return { agentTool, commands, handlers };
}

/** Launch one background run whose work resolves immediately; returns its id. */
async function launchBackground(seam: Seam, over: Record<string, unknown> = {}): Promise<string> {
  runSubagentMock.mockImplementation(async () => ({ result: "done", tokens: 3, toolUses: 2 }));
  const result = await (seam.agentTool.execute as Execute)(
    "t1",
    launchParams({ run_in_background: true, ...over }),
    undefined,
    undefined,
    toolCtx(),
  );
  const details = result.details as { agent_id?: string; agentId?: string };
  return String(details.agentId ?? details.agent_id);
}

function subagentsCommand(seam: Seam): CapturedCommand {
  const command = seam.commands.find((c) => c.name === "subagents");
  if (!command) throw new Error("/subagents was not registered");
  return command;
}

// ---------------------------------------------------------------------------
// /subagents in the TUI opens the read-only, scrollable Subagent overview.
// ---------------------------------------------------------------------------

describe("/subagents — Subagent overview overlay", () => {
  it("opens a scrollable overlay instead of a notification in the TUI", async () => {
    const command = registerCommand();
    const { ctx, notified, customCalls } = tuiCtx([]);
    await command.handler(undefined, ctx);
    expect(notified).toEqual([]);
    expect(customCalls).toHaveLength(1);
    expect(customCalls[0]!.overlayOptions).toEqual(expect.objectContaining({ overlay: true }));
  });

  it("renders the overview rows with type, description, textual state, and run id", async () => {
    const command = registerCommand();
    const { ctx, customCalls } = tuiCtx([
      receiptEntry("sa_1_ab"),
      recordEntry("sa_1_ab", "completed"),
    ]);
    await command.handler(undefined, ctx);
    const text = rendered(customCalls[0]!);
    expect(text).toContain("Subagent overview");
    expect(text).toContain("[run sa_1_ab]");
    expect(text).toContain("general");
    expect(text).toContain("refactor the parser");
    expect(text).toContain("completed");
  });

  it("shows an explicit empty state when neither live runs nor branch history exist", async () => {
    const command = registerCommand();
    const { ctx, customCalls } = tuiCtx([]);
    await command.handler(undefined, ctx);
    const text = rendered(customCalls[0]!);
    expect(text).toMatch(/no subagent runs/i);
  });

  it("reads a receipt without a recorded outcome as outcome unavailable, not running", async () => {
    const command = registerCommand();
    const { ctx, customCalls } = tuiCtx([receiptEntry("sa_9_rc")]);
    await command.handler(undefined, ctx);
    const text = rendered(customCalls[0]!);
    expect(text).toContain("[run sa_9_rc]");
    expect(text).toContain("outcome unavailable");
    expect(text).not.toMatch(/running/);
  });

  it("never shows outcomes from a sibling branch — only the current branch's records", async () => {
    const command = registerCommand();
    // Sibling branch: only the launch receipt, never the recorded outcome.
    const { ctx, customCalls } = tuiCtx([receiptEntry("sa_1_ab")]);
    await command.handler(undefined, ctx);
    const text = rendered(customCalls[0]!);
    expect(text).toContain("outcome unavailable");
    expect(text).not.toContain("the answer");
  });

  it("lists a completed live run deduped against the same run's branch history", async () => {
    const seam = setupSession();
    const liveId = await launchBackground(seam);
    const command = subagentsCommand(seam);
    // The branch has recorded the same run: receipt plus persisted record.
    const { ctx, customCalls } = tuiCtx([receiptEntry(liveId), recordEntry(liveId, "completed")]);
    await command.handler(undefined, ctx);
    const text = rendered(customCalls[0]!);
    // One row for the run — the live state, not a duplicated history row.
    expect(text.split(`[run ${liveId}]`)).toHaveLength(2);
    expect(text).toContain(`${liveId}] — general "d" — completed`);
  });

  it("shows live current-session runs and runs from branch history with distinct ids", async () => {
    const seam = setupSession();
    // One active live run: the mocked run never settles, so it stays running.
    runSubagentMock.mockImplementation(() => new Promise(() => {}));
    await (seam.agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      undefined,
      toolCtx(),
    );
    const command = subagentsCommand(seam);
    const { ctx, customCalls } = tuiCtx([
      receiptEntry("sa_1_ab"),
      recordEntry("sa_1_ab", "completed"),
    ]);
    await command.handler(undefined, ctx);
    const text = rendered(customCalls[0]!);
    expect(text).toContain("running");
    expect(text).toContain("[run sa_1_ab]");
  });

  it("dismisses on Escape", async () => {
    const command = registerCommand();
    const { ctx, customCalls } = tuiCtx([]);
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;
    expect(overlay.result.doneCalled).toBe(false);
    overlay.component.handleInput(KEYS.escape);
    expect(overlay.result.doneCalled).toBe(true);
  });

  it("dismisses on Enter", async () => {
    const command = registerCommand();
    const { ctx, customCalls } = tuiCtx([]);
    await command.handler(undefined, ctx);
    const overlay = customCalls[0]!;
    overlay.component.handleInput(KEYS.enter);
    expect(overlay.result.doneCalled).toBe(true);
  });

  it("keeps the textual notification fallback outside the TUI — no overlay", async () => {
    const command = registerCommand();
    const { ctx, notified, customCalls } = tuiCtx(
      [receiptEntry("sa_1_ab"), recordEntry("sa_1_ab", "completed")],
      { mode: "rpc" },
    );
    await command.handler(undefined, ctx);
    expect(customCalls).toEqual([]);
    const text = notified.join("\n");
    expect(text).toContain("sa_1_ab");
    expect(text).toContain("general");
    expect(text).toContain("completed");
    expect(text).toContain("the answer");
  });

  it("scrolls a long list with page keys and clamps at the ends", async () => {
    const command = registerCommand();
    // Enough branch history that the list outgrows a small viewport.
    const entries = Array.from({ length: 12 }, (_, i) => [
      receiptEntry(`sa_h_${i}`),
      recordEntry(`sa_h_${i}`, "completed"),
    ]).flat();
    const { ctx, customCalls } = tuiCtx(entries);
    await command.handler(undefined, ctx);
    const component = customCalls[0]!.component;
    // Emulate the TUI's layout of the overlay at a small viewport height:
    // content height is the full rendered line count, the viewport a few rows.
    const contentHeight = rendered(customCalls[0]!, 80).split("\n").length;
    component.updateLayout(contentHeight, 5, () => {});
    expect(component.scrollTop).toBe(0);
    component.handleInput(KEYS.pageDown);
    expect(component.scrollTop).toBeGreaterThan(0);
    // The window stays inside the content: at the end, further keys clamp.
    component.handleInput(KEYS.pageDown);
    component.handleInput(KEYS.pageDown);
    expect(component.scrollTop).toBe(contentHeight - 5);
    component.handleInput(KEYS.pageUp);
    expect(component.scrollTop).toBeLessThan(contentHeight - 5);
  });

  it("scrolls a long list one line at a time with the up and down keys", async () => {
    const command = registerCommand();
    const entries = Array.from({ length: 12 }, (_, i) => [
      receiptEntry(`sa_h_${i}`),
      recordEntry(`sa_h_${i}`, "completed"),
    ]).flat();
    const { ctx, customCalls } = tuiCtx(entries);
    await command.handler(undefined, ctx);
    const component = customCalls[0]!.component;
    component.updateLayout(rendered(customCalls[0]!, 80).split("\n").length, 5, () => {});
    // Down steps one line from the top; further down steps climb exactly that
    // fast — a line at a time, not a viewport at a time.
    component.handleInput(KEYS.down);
    expect(component.scrollTop).toBe(1);
    component.handleInput(KEYS.down);
    expect(component.scrollTop).toBe(2);
    // Up steps back down the same way, and clamps without going above the top.
    component.handleInput(KEYS.up);
    expect(component.scrollTop).toBe(1);
    component.handleInput(KEYS.up);
    component.handleInput(KEYS.up);
    expect(component.scrollTop).toBe(0);
  });
});