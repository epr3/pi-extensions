import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../manager.ts";
import { BoundedResultText, RESULT_TEXT_LIMIT, createBoundedTextCapture } from "../result-limit.ts";

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

/** Reject like the runner does: assistant text captured as a bounded capture. */
function rejectWithCapture(partialCapture: BoundedResultText): () => Promise<any> {
  return () => {
    const err: any = new Error("Subagent aborted");
    err.partialCapture = partialCapture;
    return Promise.reject(err);
  };
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

describe("bounded partial output at the manager seam", () => {
  it("reports a truncated capture's original and retained byte counts", async () => {
    const capture = createBoundedTextCapture();
    capture.append("a".repeat(25_000)); // one long delta, cut at the limit
    const rec = await launchAndWait(rejectWithCapture(capture.snapshot()));
    expect(rec.status).toBe("failed");
    // The capture already dropped 5,000 bytes during the run; the record must
    // still report the original count rather than re-measuring the prefix.
    expect(rec.partialText!.startsWith("a".repeat(RESULT_TEXT_LIMIT))).toBe(true);
    expect(rec.partialText).toContain("[Truncated: showing the first 20,000 of 25,000 bytes.]");
  });

  it("leaves a capture below the limit unchanged with no notice", async () => {
    const capture = createBoundedTextCapture();
    capture.append("half-finished answer");
    const rec = await launchAndWait(rejectWithCapture(capture.snapshot()));
    expect(rec.status).toBe("failed");
    expect(rec.partialText).toBe("half-finished answer");
  });

  it("omits partial output when the capture retained no text", async () => {
    const rec = await launchAndWait(rejectWithCapture(createBoundedTextCapture().snapshot()));
    expect(rec.status).toBe("failed");
    expect(rec.partialText).toBeUndefined();
  });

  it("still bounds a plain partial-text string from an exec thunk", async () => {
    const rec = await launchAndWait(() => {
      const err: any = new Error("Subagent aborted");
      err.partialText = "b".repeat(20_050);
      return Promise.reject(err);
    });
    expect(rec.status).toBe("failed");
    expect(rec.partialText!.startsWith("b".repeat(RESULT_TEXT_LIMIT))).toBe(true);
    expect(rec.partialText).toContain("[Truncated: showing the first 20,000 of 20,050 bytes.]");
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
    // The retrieval now names the run, then the bounded result verbatim.
    expect(text).toContain(`[run ${agentId}]`);
    expect(text).toContain(`completed:\n\n${"a".repeat(RESULT_TEXT_LIMIT)}`);
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
    // Failure reason outside the limit, plus the explicit no-partial
    // statement so absence of output is not ambiguous.
    expect(contentText(res)).toContain("failed: boom");
    expect(contentText(res)).toContain("No partial assistant output is available.");
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