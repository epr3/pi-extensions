import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Spy on the real session-creation entry point. Rejection must happen before
// this is ever called — i.e. no session and no write-capable work.
const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(async () => ({ result: "ok", tokens: 1, toolUses: 0 })),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

import subagentsExtension from "../index.ts";
import { makeFakeApi } from "./helpers.ts";

function registerAgent(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  subagentsExtension(makeFakeApi(tools));
  return tools.find((t) => t.name === "Agent")!;
}

/** Minimal ExtensionContext: model resolution falls through to no parent model. */
function fakeCtx() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    signal: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: () => {} },
  } as any;
}

function callAgent(
  agent: ToolDefinition,
  subagent_type: string,
  run_in_background?: boolean,
): Promise<unknown> {
  return agent.execute(
    "call-1",
    { subagent_type, prompt: "do the task", description: "a task", run_in_background } as any,
    undefined,
    undefined,
    fakeCtx(),
  );
}

describe("retired researcher type rejection at the Agent launch boundary", () => {
  let agent: ToolDefinition;

  beforeEach(() => {
    runSubagentMock.mockClear();
    agent = registerAgent();
  });

  it("rejects a foreground researcher call with an actionable error", async () => {
    await expect(callAgent(agent, "researcher")).rejects.toThrow(
      /Unsupported subagent_type "researcher"/,
    );
    await expect(callAgent(agent, "researcher")).rejects.toThrow(/Supported types/);
    await expect(callAgent(agent, "researcher")).rejects.toThrow(/was retired/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("rejects a background researcher call without launching a session", async () => {
    await expect(callAgent(agent, "researcher", true)).rejects.toThrow(
      /Unsupported subagent_type "researcher"/,
    );
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("never aliases researcher to a supported type", async () => {
    for (const background of [false, true]) {
      await expect(callAgent(agent, "researcher", background)).rejects.toThrow();
    }
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("rejects other unknown types too, not just researcher", async () => {
    await expect(callAgent(agent, "plan")).rejects.toThrow(/Unsupported subagent_type "plan"/);
    await expect(callAgent(agent, "plan")).rejects.not.toThrow(/researcher/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("dispatches a supported foreground explore call", async () => {
    await callAgent(agent, "explore");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0]).toMatchObject({ type: "explore" });
  });

  it("dispatches a supported foreground general call", async () => {
    await callAgent(agent, "general");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0]).toMatchObject({ type: "general" });
  });

  it("dispatches a supported background general call", async () => {
    await callAgent(agent, "general", true);
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0]).toMatchObject({ type: "general" });
  });
});