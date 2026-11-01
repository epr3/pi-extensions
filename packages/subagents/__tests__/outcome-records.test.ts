import { describe, it, expect } from "vitest";
import { AgentManager, type AgentRecord } from "../manager.ts";
import type { ActivitySnapshot } from "../activity.ts";
import {
  OUTCOME_RECORD_TYPE,
  buildOutcomeRecord,
  OutcomePersistence,
  type PersistenceDiagnostic,
} from "../outcome-records.ts";

// ---------------------------------------------------------------------------
// Records built from a settled run + its retained activity tail: these are
// the data persisted as append-only custom session entries. They carry the
// outcome AND the retained UI-only activity tail (≤50 + omission count), but
// activity never becomes model-facing content — reconstructors decide that.
// ---------------------------------------------------------------------------

function settleRecord(patch: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "sa_1_ab",
    type: "general",
    description: "refactor the parser",
    status: "completed",
    background: true,
    result: "done answer",
    tokens: 42,
    toolUses: 3,
    ...patch,
  } as AgentRecord;
}

const emptyTail: ActivitySnapshot = { entries: [], omitted: 0 };

function setup() {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const diagnostics: PersistenceDiagnostic[] = [];
  const catchAppend = (customType: string, data: unknown) => {
    appended.push({ customType, data });
  };
  return { appended, diagnostics, catchAppend };
}

describe("buildOutcomeRecord", () => {
  it("records the run identity, terminal status, and bounded result", () => {
    const rec = settleRecord();
    const out = buildOutcomeRecord(rec, emptyTail);
    expect(out.runId).toBe("sa_1_ab");
    expect(out.type).toBe("general");
    expect(out.description).toBe("refactor the parser");
    expect(out.status).toBe("completed");
    expect(out.result).toBe("done answer");
  });

  it("records failed runs with their reason and any marked partial text", () => {
    const rec = settleRecord({
      status: "failed",
      error: "boom",
      partialText: "half-written code",
    });
    const out = buildOutcomeRecord(rec, emptyTail);
    expect(out.status).toBe("failed");
    expect(out.error).toBe("boom");
    expect(out.partialText).toBe("half-written code");
    expect(out.result).toBeUndefined();
  });

  it("records stopped runs with their stop reason, not a failure", () => {
    const rec = settleRecord({ status: "stopped", stopReason: "Stopped by request while running" });
    const out = buildOutcomeRecord(rec, emptyTail);
    expect(out.status).toBe("stopped");
    expect(out.stopReason).toBe("Stopped by request while running");
  });

  it("carries the retained activity tail and its omission indicator", () => {
    const activity: ActivitySnapshot = {
      entries: [
        { type: "tool_start", name: "grep" },
        { type: "text", text: "partial thought" },
      ],
      omitted: 7,
    };
    const out = buildOutcomeRecord(settleRecord(), activity);
    expect(out.activity).toEqual(activity.entries);
    expect(out.activityOmitted).toBe(7);
  });

  it("absent result text persists as absence — JSON has no undefined", () => {
    const out = buildOutcomeRecord(settleRecord({ result: undefined }), emptyTail);
    expect(out).not.toHaveProperty("result");
    expect(out.tokens).toBe(42);
    expect(out.toolUses).toBe(3);
  });

  it("refuses non-terminal or foreground runs — there is nothing terminal to persist", () => {
    expect(() => buildOutcomeRecord(settleRecord({ status: "queued" }), emptyTail)).toThrow();
    expect(() => buildOutcomeRecord(settleRecord({ status: "running" }), emptyTail)).toThrow();
    expect(() => buildOutcomeRecord(settleRecord({ background: false }), emptyTail)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Persistence: each terminal background outcome becomes one append-only
// custom session entry via pi.appendEntry. Persistence and delivery are
// distinct; persistence ends with the owning session and never throws into
// the caller's settle path.
// ---------------------------------------------------------------------------

describe("OutcomePersistence", () => {
  it("appends one record entry for a terminal background outcome", () => {
    const { catchAppend, appended, diagnostics } = setup();
    const persistence = new OutcomePersistence(catchAppend, {
      onError: (d) => diagnostics.push(d),
    });
    persistence.record(settleRecord(), emptyTail);
    expect(appended).toHaveLength(1);
    expect(appended[0].customType).toBe(OUTCOME_RECORD_TYPE);
    expect(appended[0].data).toMatchObject({ runId: "sa_1_ab", status: "completed" });
    expect(diagnostics).toHaveLength(0);
  });

  it("never persists foreground runs — they return inline", () => {
    const { catchAppend, appended } = setup();
    const persistence = new OutcomePersistence(catchAppend, { onError: () => {} });
    persistence.record(settleRecord({ background: false }), emptyTail);
    expect(appended).toHaveLength(0);
  });

  it("records a second run as a second entry — append-only history, one per terminal outcome", () => {
    const { catchAppend, appended } = setup();
    const persistence = new OutcomePersistence(catchAppend, { onError: () => {} });
    persistence.record(settleRecord({ id: "sa_1_a" }), emptyTail);
    persistence.record(settleRecord({ id: "sa_1_a" }), emptyTail); // same run re-settled: dropped
    persistence.record(settleRecord({ id: "sa_2_b" }), emptyTail);
    expect(appended).toHaveLength(2);
    expect(appended.map((a) => (a.data as { runId: string }).runId)).toEqual(["sa_1_a", "sa_2_b"]);
  });

  it("stays silent for stale-context errors after session replacement — owner gone, not a failure", () => {
    const appended: Array<{ customType: string; data: unknown }> = [];
    const diagnostics: PersistenceDiagnostic[] = [];
    const persistence = new OutcomePersistence(
      () => {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi...",
        );
      },
      { onError: (d) => diagnostics.push(d) },
    );
    persistence.record(settleRecord(), emptyTail);
    expect(appended).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("surfaces other write failures as diagnostics instead of corrupting the settle path", () => {
    const diagnostics: PersistenceDiagnostic[] = [];
    const persistence = new OutcomePersistence(
      () => {
        throw new Error("disk full");
      },
      { onError: (d) => diagnostics.push(d) },
    );
    persistence.record(settleRecord(), emptyTail);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe("persistence-error");
    expect(diagnostics[0].runId).toBe("sa_1_ab");
  });

  it("stops persisting once the owning session has ended, and ending twice is safe", () => {
    const { catchAppend, appended } = setup();
    const persistence = new OutcomePersistence(catchAppend, { onError: () => {} });
    persistence.endSession();
    persistence.endSession();
    persistence.record(settleRecord(), emptyTail);
    expect(appended).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Queue clearing: runs cleared from the background queue by session shutdown
// settle as stopped; if the owning session can still write, that terminal
// outcome is persisted too — a receipt on revisit then has its real outcome,
// not "unavailable". If the write cannot happen, persistence is documented
// as interruptible.
// ---------------------------------------------------------------------------

describe("queue clearing persists the queued run's stopped outcome", () => {
  it("a queued run cleared by shutdown settles stopped and persists while the session can still write", async () => {
    const { catchAppend, appended } = setup();
    const persistence = new OutcomePersistence(catchAppend, { onError: () => {} });
    const manager = new AgentManager({ maxConcurrency: 1 });
    manager.launch(
      { type: "general", description: "never starts", background: true },
      async () => ({ result: "never", tokens: 0, toolUses: 0 }),
      (rec) => persistence.record(rec, { entries: [], omitted: 0 }),
    );
    manager.shutdown("Session shutdown or replacement");
    // The queue was cleared without starting: status is stopped with no
    // generated output, stop reason named, entry persisted.
    expect(appended).toHaveLength(1);
    const data = appended[0].data as { status: string; stopReason?: string; result?: string };
    expect(data.status).toBe("stopped");
    expect(data.stopReason).toBe("Session shutdown or replacement");
    expect(data.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reconstruction: revisit reads the CURRENT branch's history. A branch shows
// only completions its own history contains — never a sibling's completion —
// and a receipt without a persisted completion reads "outcome unavailable",
// never active, failed, or completed. Nothing here redelivers.
// ---------------------------------------------------------------------------

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  reconstructBranchRuns,
  describeBranchRuns,
  reconstructedRetrievalText,
  type BranchRunView,
} from "../outcome-records.ts";

type TestEntry = Omit<SessionEntry, "id" | "parentId" | "timestamp"> &
  Partial<Pick<SessionEntry, "id" | "parentId" | "timestamp">>;

let entrySeq = 0;
function makeEntry(e: TestEntry): SessionEntry {
  const n = ++entrySeq;
  return {
    id: `e${n}`,
    parentId: `e${n - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    ...e,
  } as SessionEntry;
}

function receiptEntry(text: string, runId: string, type?: string, description?: string) {
  return makeEntry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: `c${entrySeq}`,
      toolName: "Agent",
      content: [{ type: "text", text }],
      details: {
        agent_id: runId,
        status: "queued",
        ...(type ? { type } : {}),
        ...(description ? { description } : {}),
      },
    } as unknown as ToolResultMessage,
  });
}

function recordEntry(data: OutcomeRecord) {
  return makeEntry({ type: "custom", customType: OUTCOME_RECORD_TYPE, data });
}

function deliveredEntry(runId: string) {
  return makeEntry({
    type: "custom_message",
    customType: "subagent-outcome",
    content: `Subagent outcome [run ${runId}]`,
    display: true,
    details: { agentId: runId, status: "completed" },
  });
}

const RECEIPT_TEXT =
  'Started background Subagent — general "refactor the parser" [run sa_1_ab] — status: queued. ' +
  "Retrieve the result with get_subagent_result, or stop the run with stop_subagent.";

function completedRecord(): OutcomeRecord {
  return {
    runId: "sa_1_ab",
    type: "general",
    description: "refactor the parser",
    status: "completed",
    result: "the answer",
    tokens: 5,
    toolUses: 1,
    activity: [{ type: "tool_start", name: "read" }],
    activityOmitted: 0,
    persistedAt: new Date().toISOString(),
  };
}

describe("reconstructBranchRuns", () => {
  it("pairs a launch receipt with its persisted completion on the same branch", () => {
    const runs = reconstructBranchRuns([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
      recordEntry(completedRecord()),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].receipt).toEqual({
      runId: "sa_1_ab",
      type: "general",
      description: "refactor the parser",
    });
    expect(runs[0].record?.status).toBe("completed");
    expect(runs[0].record?.result).toBe("the answer");
    expect(runs[0].record?.activityOmitted).toBe(0);
    expect(runs[0].delivered).toBe(false);
  });

  it("marks a run delivered when the attributed completion message is in the branch history", () => {
    const runs = reconstructBranchRuns([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
      recordEntry(completedRecord()),
      deliveredEntry("sa_1_ab"),
    ]);
    expect(runs[0].delivered).toBe(true);
  });

  it("reads chronologically: the branch order of receipts is the view order", () => {
    const runs = reconstructBranchRuns([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
      recordEntry(completedRecord()),
      receiptEntry(
        'Started background Subagent — explore "read the docs" [run sa_2_cd] — status: queued.',
        "sa_2_cd",
        "explore",
        "read the docs",
      ),
    ]);
    expect(runs.map((r) => r.receipt?.runId)).toEqual(["sa_1_ab", "sa_2_cd"]);
  });

  it("a receipt without a persisted completion yields no record — outcome unavailable", () => {
    const runs = reconstructBranchRuns([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].record).toBeUndefined();
  });

  it("a receipt whose details lack type/description still keys the run — graceful fallback", () => {
    // Legacy or hand-built history may carry only details.agent_id: the run
    // stays keyed by id and the identity fields degrade to unknown/empty
    // instead of being reparsed from the display text.
    const runs = reconstructBranchRuns([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab"),
      recordEntry(completedRecord()),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].receipt).toEqual({
      runId: "sa_1_ab",
      type: "(unknown type)",
      description: "",
    });
  });

  it("ignores entries that are not this extension's receipts or records", () => {
    const runs = reconstructBranchRuns([
      makeEntry({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "cx",
          toolName: "bash",
          content: [{ type: "text", text: "ls output" }],
        } as unknown as ToolResultMessage,
      }),
      makeEntry({ type: "custom", customType: "other-extension", data: { runId: "sa_9" } }),
      makeEntry({
        type: "custom_message",
        customType: "other-extension",
        content: "other",
        display: true,
      }),
    ]);
    expect(runs).toHaveLength(0);
  });

  it("does not resurrect a completed status from a malformed record", () => {
    const runs = reconstructBranchRuns([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
      makeEntry({
        type: "custom",
        customType: OUTCOME_RECORD_TYPE,
        data: { runId: "sa_1_ab", status: "totally-unknown" },
      }),
    ]);
    expect(runs[0].record).toBeUndefined();
  });
});

describe("revisit presentation", () => {
  it("completed outcome lists the run, its status, and the retained activity", () => {
    const line = describeBranchRuns(
      reconstructBranchRuns([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
        recordEntry(completedRecord()),
      ]),
    );
    expect(line).toContain("sa_1_ab");
    expect(line).toContain("completed");
    expect(line).toContain("the answer");
    expect(line).toContain("1 entry");
    expect(line).not.toContain("outcome unavailable");
  });

  it("a receipt-only run says outcome unavailable, never active, failed, or completed", () => {
    const line = describeBranchRuns(
      reconstructBranchRuns([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
      ]),
    );
    expect(line).toContain("outcome unavailable");
    expect(line).toContain("sa_1_ab");
    expect(line).not.toContain("completed");
    expect(line).not.toContain("failed");
    expect(line).not.toMatch(/running|active|failed/);
  });

  it("a persisted but undelivered outcome is distinguishable from a delivered one", () => {
    const undelivered = describeBranchRuns(
      reconstructBranchRuns([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
        recordEntry(completedRecord()),
      ]),
    );
    const delivered = describeBranchRuns(
      reconstructBranchRuns([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
        recordEntry(completedRecord()),
        deliveredEntry("sa_1_ab"),
      ]),
    );
    expect(undelivered).toContain("not delivered");
    expect(delivered).toContain("delivered");
    expect(delivered).not.toContain("not delivered");
  });

  it("empty branch history renders nothing", () => {
    expect(describeBranchRuns(reconstructBranchRuns([]))).toBe("");
  });

  it("the omission indicator number survives reconstruction", () => {
    const rec = completedRecord();
    rec.activityOmitted = 9;
    const line = describeBranchRuns(
      reconstructBranchRuns([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
        recordEntry(rec),
      ]),
    );
    expect(line).toContain("9 earlier");
  });
});

function viewOf(entries: SessionEntry[]): BranchRunView | undefined {
  return reconstructBranchRuns(entries)[0];
}

describe("reconstructedRetrievalText (model-facing, explicit retrieval only)", () => {
  it("returns the bounded result text for a persisted completed outcome", () => {
    const view = viewOf([
      receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
      recordEntry(completedRecord()),
    ]);
    const text = reconstructedRetrievalText(view);
    expect(text).toContain("completed");
    expect(text).toContain("the answer");
    // Activity content never rides in model-facing retrieval.
    expect(text).not.toContain("started read");
  });

  it("failed and stopped records carry their reason and marked partial or none", () => {
    const failed = completedRecord();
    Object.assign(failed, { status: "failed", error: "boom", partialText: "half" });
    delete (failed as { result?: string }).result;
    const text = reconstructedRetrievalText(
      viewOf([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
        recordEntry(failed),
      ]),
    );
    expect(text).toContain("failed");
    expect(text).toContain("boom");
    expect(text).toContain("Partial assistant output (incomplete)");

    const stopped = completedRecord();
    Object.assign(stopped, { status: "stopped", stopReason: "Stopped by request" });
    delete (stopped as { result?: string }).result;
    const text2 = reconstructedRetrievalText(
      viewOf([
        receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser"),
        recordEntry(stopped),
      ]),
    );
    expect(text2).toContain("stopped");
    expect(text2).toContain("No partial assistant output is available.");
  });

  it("a run with only a receipt answers unavailable without implying active or failed", () => {
    const text = reconstructedRetrievalText(
      viewOf([receiptEntry(RECEIPT_TEXT, "sa_1_ab", "general", "refactor the parser")]),
    );
    expect(text).toContain("outcome unavailable");
    expect(text).toContain("sa_1_ab");
    expect(text).not.toContain("failed");
    expect(text).not.toContain("running");
  });

  it("a record without a receipt still reconstructs — the run id carries the association", () => {
    const text = reconstructedRetrievalText(viewOf([recordEntry(completedRecord())]));
    expect(text).toContain("the answer");
  });
});