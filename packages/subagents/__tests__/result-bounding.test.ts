import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../manager.ts";
import { RESULT_TEXT_LIMIT } from "../result-limit.ts";

const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

import subagentsExtension from "../index.ts";
import { makeFakeApi } from "./helpers.ts";

function registerTools(): { agent: ToolDefinition; resultTool: ToolDefinition } {
  const tools: ToolDefinition[] = [];
  subagentsExtension(makeFakeApi(tools));
  return {
    agent: tools.find((t) => t.name === "Agent")!,
    resultTool: tools.find((t) => t.name === "get_subagent_result")!,
  };
}

function contentText(res: any): string {
  return res.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

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

// ---------------------------------------------------------------------------
// Bounded record results at the manager seam
// ---------------------------------------------------------------------------

const bigText = "a".repeat(RESULT_TEXT_LIMIT + 100);

function launchAndWait(exec: () => Promise<any>): Promise<any> {
  const manager = new AgentManager({ maxConcurrency: 1 });
  const { done } = manager.launch({ type: "general", description: "task" }, exec);
  return done;
}

describe("bounded record results at the manager seam", () => {
  it("bounds a completed record's result text to 20,000 bytes with a truncation notice", async () => {
    const rec = await launchAndWait(() =>
      Promise.resolve({ result: bigText, tokens: 1, toolUses: 0 }),
    );
    expect(rec.status).toBe("completed");
    const encoded = new TextEncoder().encode(rec.result);
    // Notice is outside the limit, so total text may exceed it — but bounded
    // result text may not.
    expect(encoded.length).toBeGreaterThan(RESULT_TEXT_LIMIT);
    expect(rec.result.startsWith(bigText.slice(0, 20_000))).toBe(true);
    expect(rec.result).toContain("[Truncated:");
    expect(rec.result).toContain("20,000");
    expect(rec.result).toContain("20,100");
  });

  it("leaves a short result text unchanged with no notice", async () => {
    const rec = await launchAndWait(() =>
      Promise.resolve({ result: "done", tokens: 1, toolUses: 0 }),
    );
    expect(rec.status).toBe("completed");
    expect(rec.result).toBe("done");
  });

  it("keeps the failure reason outside the result-text limit", async () => {
    const reason = "E".repeat(RESULT_TEXT_LIMIT + 7);
    const rec = await launchAndWait(() => Promise.reject(new Error(reason)));
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Bounded results at the tool seams (extension registration with fake Pi)
// ---------------------------------------------------------------------------

describe("bounded results at the Agent tool seam", () => {
  beforeEach(() => {
    runSubagentMock.mockReset();
  });

  it("bounds a foreground result and reports truncation outside the limit", async () => {
    const { agent } = registerTools();
    runSubagentMock.mockResolvedValue({ result: bigText, tokens: 42, toolUses: 3 });
    const res = await agent.execute(
      "call-1",
      { subagent_type: "general", prompt: "work", description: "task" },
      undefined,
      undefined,
      fakeCtx(),
    );
    const text = contentText(res);
    expect(text.startsWith("a".repeat(RESULT_TEXT_LIMIT))).toBe(true);
    expect(text).toContain("[Truncated: showing the first 20,000 of 20,100 bytes.]");
    expect(text).toContain("write its output to a file");
    // Status stays visible outside the result-text limit.
    expect(res.details.status).toBe("completed");
    expect(res.details.tokens).toBe(42);
    expect(res.details.toolUses).toBe(3);
  });

  it("returns a short foreground result unchanged with no truncation notice", async () => {
    const { agent } = registerTools();
    runSubagentMock.mockResolvedValue({ result: "all done", tokens: 1, toolUses: 0 });
    const res = await agent.execute(
      "call-1",
      { subagent_type: "explore", prompt: "look", description: "look" },
      undefined,
      undefined,
      fakeCtx(),
    );
    expect(contentText(res)).toBe("all done");
    expect(res.details.status).toBe("completed");
  });
});

describe("bounded results at the get_subagent_result seam", () => {
  beforeEach(() => {
    runSubagentMock.mockReset();
  });

  it("bounds an explicitly retrieved result and reports truncation", async () => {
    const { agent, resultTool } = registerTools();
    runSubagentMock.mockResolvedValue({ result: bigText, tokens: 7, toolUses: 1 });
    const started = await agent.execute(
      "call-1",
      { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
      undefined,
      undefined,
      fakeCtx(),
    );
    const agentId = started.details.agent_id;
    const res = await resultTool.execute("call-2", { agent_id: agentId, wait: true });
    const text = contentText(res);
    expect(text.startsWith("a".repeat(RESULT_TEXT_LIMIT))).toBe(true);
    expect(text).toContain("[Truncated: showing the first 20,000 of 20,100 bytes.]");
    expect(res.details.status).toBe("completed");
  });

  it("reports a failed retrieval's reason outside the result-text limit", async () => {
    const { agent, resultTool } = registerTools();
    runSubagentMock.mockRejectedValue(new Error("boom"));
    const started = await agent.execute(
      "call-1",
      { subagent_type: "general", prompt: "work", description: "task", run_in_background: true },
      undefined,
      undefined,
      fakeCtx(),
    );
    const res = await resultTool.execute("call-2", {
      agent_id: started.details.agent_id,
      wait: true,
    });
    expect(contentText(res)).toBe("failed: boom");
    expect(res.details.status).toBe("failed");
  });
});

describe("large-deliverable guidance", () => {
  it("tells the parent to have Subagents write large deliverables to files", () => {
    const { agent } = registerTools();
    const guidelines = agent.promptGuidelines!.join(" ");
    expect(guidelines).toContain("file");
  });
});