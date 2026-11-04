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
});
