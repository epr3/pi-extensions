import { describe, expect, it } from "vitest";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { default as subagentsExtension } from "../index.ts";
import { makeFakeApi, type CapturedCommand } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

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

function recordEntry(runId: string, status: "completed" | "failed" | "stopped", extra: object = {}) {
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
// The fake interactive ctx: records what /subagents shows, and captures the
// overlay component the command hands to ctx.ui.custom so tests drive and
// observe user-visible rendering and input at the seam.
// ---------------------------------------------------------------------------

interface OpenedOverlay {
  component: any;
  overlayOptions: any;
  /** Resolved with the value the component passed to done(). */
  result: { value: unknown };
}

function tuiCtx(
  branchEntries: readonly unknown[] = [],
  options: { mode?: string } = {},
): { ctx: any; notified: string[]; customCalls: OpenedOverlay[] } {
  const notified: string[] = [];
  const customCalls: OpenedOverlay[] = [];
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const tui = { requestRender: () => {} };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify: (message: string) => {
        notified.push(message);
      },
      custom: async (factory: Function, opts: unknown) => {
        const result: OpenedOverlay["result"] = { value: undefined };
        const component = await factory(tui, plainTheme, keybindings, (v: unknown) => {
          result.value = v;
        });
        customCalls.push({ component, overlayOptions: opts, result });
        return undefined;
      },
    },
    sessionManager: { getBranch: () => branchEntries },
  };
  return { ctx, notified, customCalls };
}

function registerCommand(): CapturedCommand {
  const captured: ToolDefinition[] = [];
  const commands: CapturedCommand[] = [];
  subagentsExtension(makeFakeApi(captured, { commands } as never) as unknown as ExtensionAPI);
  const command = commands.find((c) => c.name === "subagents")!;
  if (!command) throw new Error("/subagents was not registered");
  return command;
}

/** The joined text a captured overlay component renders at the given width. */
function rendered(overlay: OpenedOverlay, width = 80): string {
  return overlay.component.render(width).join("\n");
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
});
