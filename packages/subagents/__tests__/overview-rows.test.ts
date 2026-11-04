import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../manager.ts";
import type { OutcomeRecord } from "../outcome-records.ts";
import { buildOverviewRows, overviewRowLine } from "../overview-rows.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal outcome record for reconstruction-history fixtures. */
function persistedRecord(over: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    runId: "sa_1_ab",
    type: "general",
    description: "",
    status: "completed",
    tokens: 0,
    toolUses: 0,
    activity: [],
    activityOmitted: 0,
    persistedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

/** Minimal live record fixture — only overview-relevant fields are asserted. */
function liveRecord(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: "sa_1_ab",
    type: "general",
    description: "do something",
    status: "queued",
    background: true,
    tokens: 0,
    toolUses: 0,
    ...over,
  } as AgentRecord;
}

/** Field assertion over the rows in overview order: [runId | state]. */
function outline(rows: { runId: string; state: string; active: boolean }[]): string[] {
  return rows.map((r) => `${r.active ? "active" : "done"} ${r.runId} ${r.state}`);
}

// ---------------------------------------------------------------------------
// buildOverviewRows: live current-session runs combined with branch history
// ---------------------------------------------------------------------------

describe("buildOverviewRows", () => {
  it("shows live runs active-first, newest first within each group", () => {
    // manager.list() order is creation order, oldest → newest.
    const live = [
      liveRecord({ id: "sa_1_old", status: "completed" }),
      liveRecord({ id: "sa_2_new", status: "completed" }),
      liveRecord({ id: "sa_3_run", status: "running" }),
      liveRecord({ id: "sa_4_queued", status: "queued" }),
    ];
    expect(outline(buildOverviewRows(live, []))).toEqual([
      "active sa_4_queued queued",
      "active sa_3_run running",
      "done sa_2_new completed",
      "done sa_1_old completed",
    ]);
  });

  it("reads a run's terminal state from the current branch's history", () => {
    const views = [
      {
        receipt: { runId: "sa_1_ab", type: "general", description: "refactor the parser" },
        record: persistedRecord({ description: "refactor the parser" }),
        delivered: true,
      },
    ];
    expect(outline(buildOverviewRows([], views))).toEqual(["done sa_1_ab completed"]);
  });

  it("marks a receipt without an available outcome as not active, never running", () => {
    const views = [
      {
        receipt: { runId: "sa_1_ab", type: "explore", description: "locate the bug" },
        delivered: false,
      },
    ];
    const rows = buildOverviewRows([], views);
    expect(outline(rows)).toEqual([expect.stringMatching(/^done sa_1_ab /)] as string[]);
    // Unavailable is stated in words — and never suggests the run is active.
    expect(rows[0]!.state).toBe("outcome unavailable");
  });

  it("deduplicates a run present in both live records and branch history, keeping the live state", () => {
    const live = [liveRecord({ id: "sa_1_ab", status: "completed", description: "fresh state" })];
    const views = [
      {
        receipt: { runId: "sa_1_ab", type: "general", description: "stale description" },
        record: persistedRecord({ status: "failed", error: "boom" }),
        delivered: true,
      },
    ];
    const rows = buildOverviewRows(live, views);
    expect(outline(rows)).toEqual(["done sa_1_ab completed"]);
    expect(overviewRowLine(rows[0]!)).toContain("fresh state");
  });

  it("keeps runs from separate run ids — live and history rows never merge", () => {
    const live = [liveRecord({ id: "sa_7_live", status: "completed" })];
    const views = [
      {
        receipt: { runId: "sa_1_ab", type: "general", description: "earlier" },
        record: persistedRecord({ status: "stopped", stopReason: "Session ended" }),
        delivered: false,
      },
    ];
    expect(outline(buildOverviewRows(live, views))).toEqual([
      "done sa_7_live completed",
      "done sa_1_ab stopped",
    ]);
  });

  it("orders combined history rows newest first after live rows", () => {
    // Branch recording order is chronological, oldest → newest.
    const views = [
      {
        receipt: { runId: "sa_1_first", type: "explore", description: "first" },
        record: persistedRecord({ runId: "sa_1_first" }),
        delivered: true,
      },
      {
        receipt: { runId: "sa_2_second", type: "general", description: "second" },
        record: persistedRecord({ runId: "sa_2_second", status: "failed", error: "nope" }),
        delivered: true,
      },
    ];
    expect(outline(buildOverviewRows([], views))).toEqual([
      "done sa_2_second failed",
      "done sa_1_first completed",
    ]);
  });
});

describe("overviewRowLine", () => {
  it("shows the run id, type, description, and textual state", () => {
    const [row] = buildOverviewRows(
      [liveRecord({ id: "sa_1_ab", type: "explore", description: "locate the bug", status: "running" })],
      [],
    );
    const line = overviewRowLine(row!);
    expect(line).toContain("[run sa_1_ab]");
    expect(line).toContain("explore");
    expect(line).toContain("locate the bug");
    expect(line).toContain("running");
  });

  it("falls back to the outcome-unavailable state wording for a receipt-only run", () => {
    const [row] = buildOverviewRows([], [
      { receipt: { runId: "sa_1_ab", type: "general", description: "desc" }, delivered: false },
    ]);
    expect(row!.state).toBe("outcome unavailable");
  });
});
