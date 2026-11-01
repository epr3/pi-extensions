import { describe, it, expect } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  OUTCOME_RECORD_TYPE,
  reconstructBranchRuns,
  describeBranchRuns,
} from "../outcome-records.ts";
import type { OutcomeRecord } from "../outcome-records.ts";

// ---------------------------------------------------------------------------
// Focused Pi integration check (0.84.1): persistence + reload/branch-local
// reconstruction against Pi's REAL session and branch APIs — no live models
// or credentials. The persisted outcome is an append-only custom entry; the
// launch receipt is the real persisted toolResult with its details; the
// delivered completion is the real custom_message entry. Reconstruction
// reads only the current branch's history (getBranch).
// ---------------------------------------------------------------------------

const RECEIPT_TEXT =
  'Started background Subagent — general "refactor the parser" [run sa_1_ab] — ' +
  "status: queued. Retrieve the result with get_subagent_result, or stop the run with stop_subagent.";

const RECORD: OutcomeRecord = {
  runId: "sa_1_ab",
  type: "general",
  description: "refactor the parser",
  status: "completed",
  result: "the answer",
  tokens: 9,
  toolUses: 2,
  activity: [
    { type: "tool_start", name: "read" },
    { type: "tool_end", name: "read", error: false },
  ],
  activityOmitted: 0,
  persistedAt: new Date().toISOString(),
};

function buildSessionWithOutcome() {
  const sm = SessionManager.inMemory("/tmp");
  // 1. Background launch → the Agent tool result persists as an ordinary
  //    message entry: the launch receipt (identifiable by details.agent_id).
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "Agent",
    content: [{ type: "text", text: RECEIPT_TEXT }],
    details: {
      agent_id: "sa_1_ab",
      type: "general",
      description: "refactor the parser",
      status: "queued",
    },
  } as unknown as any);
  // 2. Terminal outcome settles → persistence appends the record entry.
  sm.appendCustomEntry(OUTCOME_RECORD_TYPE, RECORD);
  // 3. Delivery succeeded → the attributed completion persists as its own
  //    custom_message entry (it participates in LLM context in Pi; the
  //    record entry does not).
  sm.appendCustomMessageEntry(
    "subagent-outcome",
    "Subagent general (refactor the parser) completed [run sa_1_ab].\n\nthe answer",
    true,
    { agentId: "sa_1_ab", status: "completed" },
  );
  return sm;
}

describe("branch-local revisit over Pi's real session APIs", () => {
  it("the recording branch reconstructs its persisted outcome from reload-safe history", async () => {
    const sm = buildSessionWithOutcome();
    const runs = reconstructBranchRuns(sm.getBranch());
    expect(runs).toHaveLength(1);
    expect(runs[0].receipt?.runId).toBe("sa_1_ab");
    expect(runs[0].receipt?.type).toBe("general");
    expect(runs[0].record?.status).toBe("completed");
    expect(runs[0].record?.result).toBe("the answer");
    expect(runs[0].delivered).toBe(true);
    expect(runs[0].record?.activity).toEqual(RECORD.activity);
  });

  it("a sibling branched before the outcome shows only a receipt: outcome unavailable", async () => {
    const sm = buildSessionWithOutcome();
    const receiptEntry = sm
      .getBranch()
      .find((e) => e.type === "message" && (e.message as ToolResultMessage)?.toolName === "Agent");
    expect(receiptEntry).toBeDefined();
    // Branch from the launch receipt: the new branch contains the receipt
    // (shared ancestor) but never the completion recorded on the abandoned
    // branch — no completion is merely copied down for a sibling receipt.
    sm.branch(receiptEntry!.id);
    sm.appendMessage({ role: "user", content: "try a different approach" });

    const sibling = reconstructBranchRuns(sm.getBranch());
    expect(sibling).toHaveLength(1);
    expect(sibling[0].receipt?.runId).toBe("sa_1_ab");
    expect(sibling[0].record).toBeUndefined();
    expect(sibling[0].delivered).toBe(false);
    expect(describeBranchRuns(sibling)).toContain("outcome unavailable");
    expect(describeBranchRuns(sibling)).not.toContain("completed");
  });

  it("the original branch still shows its outcome — siblings do not cross-contaminate", async () => {
    const sm = buildSessionWithOutcome();
    const outcomeEntry = sm
      .getBranch()
      .find((e) => e.type === "custom" && e.customType === OUTCOME_RECORD_TYPE);
    expect(outcomeEntry).toBeDefined();
    sm.branch(outcomeEntry!.id); // sibling taken right after the record
    sm.appendMessage({ role: "user", content: "continuation" });

    const sibling = reconstructBranchRuns(sm.getBranch());
    expect(sibling[0].record?.runId).toBe("sa_1_ab"); // shared history up to the record
    expect(sibling[0].delivered).toBe(false); // the completion came after, only on the old branch
  });

  it("record entries stay out of the LLM context even when delivered messages enter it", () => {
    const sm = buildSessionWithOutcome();
    // Pi's real context builder: custom entries are dropped entirely (the
    // persisted activity tail lives only there), while the delivered
    // completion custom_message becomes a context message that carries the
    // bounded result text and never activity content.
    const ctx = sm.buildSessionContext();
    const serialized = JSON.stringify(ctx.messages);
    expect(
      ctx.messages.some((m) => m.role === "custom" && JSON.stringify(m).includes("the answer")),
    ).toBe(true);
    expect(serialized).not.toContain("tool_start");
    expect(serialized).not.toContain("activityOmitted");
  });
});