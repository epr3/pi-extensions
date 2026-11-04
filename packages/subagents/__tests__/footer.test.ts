import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Resolve the runner at the SDK boundary only: runSubagent builds a real Pi
// sub-session. The footer behavior above it is exercised for real here.
vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: vi.fn() };
});

import extension from "../index.ts";
import { FOOTER_STATUS_KEY } from "../footer.ts";
import { makeFakeApi, type CapturedHandlers } from "./helpers.ts";
import { runSubagent } from "../runner.ts";

const runSubagentMock = vi.mocked(runSubagent);

function setupSession() {
  const captured: ToolDefinition[] = [];
  const handlers: CapturedHandlers = new Map();
  extension(makeFakeApi(captured, { handlers }));
  const agentTool = captured.find((t) => t.name === "Agent");
  if (!agentTool) throw new Error("extension did not register the Agent tool");
  return { agentTool, handlers };
}

/** UI-capable context whose footer statuses are captured on a vi.fn. */
function uiToolCtx() {
  return {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui" as const,
    signal: undefined,
    model: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

/** Latest footer text the fake UI last displayed for our status key. */
function lastFooterText(ctx: ReturnType<typeof uiToolCtx>): string | undefined {
  const calls = ctx.ui.setStatus.mock.calls.filter(([key]) => key === FOOTER_STATUS_KEY);
  return calls.at(-1)?.[1];
}

/** Contextual params the Agent tool accepts, minimal shape. */
function launchParams(over: Record<string, unknown> = {}) {
  return { subagent_type: "explore", prompt: "do it", description: "d", ...over };
}

type Execute = NonNullable<ToolDefinition["execute"]>;

/** Queue of manually released sub-session executions (hangs until released). */
function hangingRunner() {
  const pending: Array<(o: unknown) => void> = [];
  runSubagentMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const done = { result: "done", tokens: 1, toolUses: 0 };
  return {
    /** Settle one hanging run (launch order); settles all when omitted. */
    release: (which?: number) => {
      if (which === undefined) {
        for (const resolve of pending.splice(0)) resolve(done);
        return;
      }
      const resolve = pending.splice(which, 1)[0];
      resolve?.(done);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// The footer counts active (queued or running) Subagent runs of the current
// session and clears itself the moment no run is active.
// ──────────────────────────────────────────────────────────────────────────

describe("active Subagent footer at the extension seam", () => {
  it("shows a launched background run and clears when it settles", async () => {
    const { agentTool } = setupSession();
    let release!: () => void;
    runSubagentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ result: "done", tokens: 1, toolUses: 0 });
        }),
    );
    const ctx = uiToolCtx();

    const receipt = (agentTool.execute as Execute)(
      "t1",
      launchParams({ run_in_background: true }),
      undefined,
      undefined,
      ctx as never,
    );

    // While the run is active the footer shows it…
    await vi.waitFor(() => {
      expect(lastFooterText(ctx)).toMatch(/Subagents 1\b/);
    });
    expect(lastFooterText(ctx)).toContain("explore");

    // …and when it settles the footer is cleared, not left stale.
    release();
    await receipt;
    await vi.waitFor(() => expect(lastFooterText(ctx)).toBeUndefined());
  });

  it("counts concurrent runs grouped by requested type, foreground and background alike, and tracks them down to idle", async () => {
    const { agentTool } = setupSession();
    const runner = hangingRunner();
    const ctx = uiToolCtx();

    // Same-turn fan-out: two background explores, one background general …
    const bgs = [
      (agentTool.execute as Execute)(
        "b1",
        launchParams({ run_in_background: true, description: "a" }),
        undefined,
        undefined,
        ctx as never,
      ),
      (agentTool.execute as Execute)(
        "b2",
        launchParams({
          subagent_type: "general",
          run_in_background: true,
          description: "b",
        }),
        undefined,
        undefined,
        ctx as never,
      ),
    ];
    // …plus one foreground explore the parent is still awaiting.
    const fg = (agentTool.execute as Execute)(
      "f1",
      launchParams({ description: "c" }),
      undefined,
      undefined,
      ctx as never,
    );

    await vi.waitFor(() => {
      const text = lastFooterText(ctx);
      expect(text).toMatch(/Subagents 3\b/);
      expect(text).toContain("2 explore");
      expect(text).toContain("1 general");
    });

    // Runs leave the footer as they settle; no run, no status.
    runner.release();
    await Promise.all(bgs);
    await fg;
    await vi.waitFor(() => expect(lastFooterText(ctx)).toBeUndefined());
  });

  it("combines concurrent runs of one type into a single group", async () => {
    const { agentTool } = setupSession();
    hangingRunner();
    const ctx = uiToolCtx();
    await Promise.all([
      (agentTool.execute as Execute)(
        "b1",
        launchParams({ run_in_background: true, description: "a" }),
        undefined,
        undefined,
        ctx as never,
      ),
      (agentTool.execute as Execute)(
        "b2",
        launchParams({ run_in_background: true, description: "b" }),
        undefined,
        undefined,
        ctx as never,
      ),
    ]);
    await vi.waitFor(() => {
      expect(lastFooterText(ctx)).toContain("Subagents 2");
      expect(lastFooterText(ctx)).toContain("2 explore");
    });
  });

  it("counts queued runs and updates as they start under the concurrency cap", async () => {
    const previousEnv = process.env.PI_SUBAGENT_CONCURRENCY;
    process.env.PI_SUBAGENT_CONCURRENCY = "1";
    try {
      const { agentTool } = setupSession();
      const runner = hangingRunner();
      const ctx = uiToolCtx();

      // The cap lets one run start; the second waits queued.
      const first = (agentTool.execute as Execute)(
        "b1",
        launchParams({ run_in_background: true, description: "a" }),
        undefined,
        undefined,
        ctx as never,
      );
      const second = (agentTool.execute as Execute)(
        "b2",
        launchParams({ run_in_background: true, description: "b" }),
        undefined,
        undefined,
        ctx as never,
      );
      await vi.waitFor(() => {
        expect(lastFooterText(ctx)).toContain("(1 running, 1 queued)");
      });

      // A queued run counts like a running one; transitions keep the total
      // exact as the queued work starts.
      runner.release(0);
      await first;
      await vi.waitFor(() => {
        expect(lastFooterText(ctx)).toContain("(1 running)");
        expect(lastFooterText(ctx)).not.toContain("queued");
      });

      runner.release(0);
      await second;
      await vi.waitFor(() => expect(lastFooterText(ctx)).toBeUndefined());
    } finally {
      if (previousEnv === undefined) delete process.env.PI_SUBAGENT_CONCURRENCY;
      else process.env.PI_SUBAGENT_CONCURRENCY = previousEnv;
    }
  });

  it("clears on session shutdown or replacement and never updates again after it", async () => {
    const { agentTool, handlers } = setupSession();
    hangingRunner();
    const ctx = uiToolCtx();

    const receipt = (agentTool.execute as Execute)(
      "b1",
      launchParams({ run_in_background: true, description: "a" }),
      undefined,
      undefined,
      ctx as never,
    );
    await vi.waitFor(() => expect(lastFooterText(ctx)).toContain("Subagents 1"));

    // The replacement/shutdown context is a DIFFERENT ui (fresh recorder):
    // the dying session's clear must flow through the still-live ctx.
    const shutdownCtx = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui" as const,
      signal: undefined,
      model: undefined,
      modelRegistry: { find: () => undefined },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    const toolCtxCallsBeforeShutdown = ctx.ui.setStatus.mock.calls.length;
    handlers.get("session_shutdown")!({}, shutdownCtx);
    await receipt;

    expect(shutdownCtx.ui.setStatus).toHaveBeenCalledWith(FOOTER_STATUS_KEY, undefined);

    // The shutdown clear is the last footer write through the dying session's
    // ui too: shutdown settles runs synchronously and none of those terminal
    // events may re-render the summary — a replacement session never inherits
    // it (no cross-session leakage).
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.ui.setStatus.mock.calls.length).toBe(toolCtxCallsBeforeShutdown);
    const shutdownFooterCalls = shutdownCtx.ui.setStatus.mock.calls.filter(
      ([key]) => key === FOOTER_STATUS_KEY,
    );
    expect(shutdownFooterCalls.at(-1)).toEqual([FOOTER_STATUS_KEY, undefined]);

    // The run registry belongs to its session: no new runs after shutdown.
    await expect(
      (agentTool.execute as Execute)(
        "b2",
        launchParams({ run_in_background: true, description: "b" }),
        undefined,
        undefined,
        ctx as never,
      ),
    ).rejects.toThrow(/shutdown|replacement/);
  });
});
