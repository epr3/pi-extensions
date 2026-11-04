import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Resolve the runner at the SDK boundary only: runSubagent builds a real Pi
// sub-session (models, credentials) — not observable deterministically.
vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: vi.fn() };
});

import extension from "../index.ts";
import { runSubagent } from "../runner.ts";
import { makeFakeApi, type CapturedCommand, type CapturedHandlers } from "./helpers.ts";

const runSubagentMock = vi.mocked(runSubagent);

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// Session-history fixtures — hand-built branch entries (receipt + record), as
// in the overlay tests: an Agent toolResult launch receipt and a persisted
// subagent-outcome-record.

interface Seam {
  agentTool: ToolDefinition;
  commands: CapturedCommand[];
  handlers: CapturedHandlers;
}

type Execute = NonNullable<ToolDefinition["execute"]>;

/** A real session at the seam: the extension registered (runner mocked). */
function setupSession(): Seam {
  const captured: ToolDefinition[] = [];
  const commands: CapturedCommand[] = [];
  const handlers: CapturedHandlers = new Map();
  extension(makeFakeApi(captured, { handlers, commands } as never));
  const agentTool = captured.find((t) => t.name === "Agent");
  if (!agentTool?.execute) throw new Error("extension did not register the Agent tool");
  return { agentTool, commands, handlers };
}

/** Tool-level ctx for launching live runs. */
function toolCtx() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: "tui" as const,
    signal: undefined,
    model: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: () => {} },
  };
}

function launchParams(over: Record<string, unknown> = {}) {
  return { subagent_type: "general", prompt: "do it", description: "d", ...over };
}

// ---------------------------------------------------------------------------
// The fake interactive ctx: opens the /subagents overlay at the command seam
// and keeps the component so tests can re-render it — that is exactly how the
// open overview is observed while runs change under it.
// ---------------------------------------------------------------------------

interface OpenedOverlay {
  component: any;
  overlayOptions: any;
  /** Whether the component called done() — how dismissal is observed. */
  result: { doneCalled: boolean };
}

function tuiCtx(branchEntries: readonly unknown[] = []): { ctx: any; customCalls: OpenedOverlay[] } {
  const customCalls: OpenedOverlay[] = [];
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const tui = { requestRender: () => {} };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify: () => {},
      custom: async (factory: Function, opts: unknown) => {
        const result: OpenedOverlay["result"] = { doneCalled: false };
        const component = await factory(tui, plainTheme, keybindings, () => {
          result.doneCalled = true;
        });
        customCalls.push({ component, overlayOptions: opts, result });
        return undefined;
      },
    },
    sessionManager: { getBranch: () => branchEntries },
  };
  return { ctx, customCalls };
}

/**
 * Queue of manually released sub-session executions (hangs until released),
 * keyed in launch order — the same pattern the footer tests use.
 */
function hangingLauncher(seam: Seam) {
  const pending: Array<(o: unknown) => void> = [];
  runSubagentMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const done = { result: "done", tokens: 1, toolUses: 0 };
  return {
    /** Launch one hanging background run; resolves its receipt details. */
    launch: (over: Record<string, unknown> = {}) =>
      (seam.agentTool.execute as Execute)(
        "t",
        launchParams({ run_in_background: true, ...over }),
        undefined,
        undefined,
        toolCtx(),
      ),
    /** Settle one hanging run (launch order); settles all when omitted. */
    release: (which?: number) => {
      if (which === undefined) {
        for (const resolve of pending.splice(0)) resolve(done);
        return;
      }
      pending.splice(which, 1)[0]?.(done);
    },
  };
}

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
    const runner = hangingLauncher(seam);
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
      const runner = hangingLauncher(seam);
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
    const runner = hangingLauncher(seam);
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
    const runner = hangingLauncher(seam);
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
});

