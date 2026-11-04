import type { AgentRecord } from "./manager.ts";
import type { BranchRunView } from "./outcome-records.ts";

/**
 * Overview row model for `/subagents` (Subagent overview).
 *
 * One row per **Subagent run**, combining the current session's live records
 * with the current branch's reconstructed history:
 *
 * - Dedup by run id — a run appearing in both stays one row, live state wins.
 * - Active runs (queued/running) first; terminal runs — and receipts whose
 *   outcome is unavailable, which are never classified active — afterward.
 * - Newest first within each group. Live records are ordered by the
 *   manager's creation order (oldest → newest), history views by branch
 *   recording order (same direction); both are reversed for display.
 *
 * Pure and read-only: building rows never touches delivery, persistence, or
 * the conversation.
 */

/** The textual state of one run as the overview row states it. */
export type OverviewState =
  | AgentRecord["status"]
  // A branch receipt whose outcome could not be reconstructed: state unknown,
  // never active (the run may have finished or been lost from its outcome).
  | "outcome unavailable";

/** One Subagent run in the Subagent overview. */
export interface OverviewRow {
  runId: string;
  type: string;
  description: string;
  state: OverviewState;
  /** True only for queued/running runs; receipt-only rows are never active. */
  active: boolean;
}

const ACTIVE_STATES = new Set(["queued", "running"]);

function rowFromRecord(rec: AgentRecord): OverviewRow {
  return {
    runId: rec.id,
    type: rec.type,
    description: rec.description,
    state: rec.status,
    active: ACTIVE_STATES.has(rec.status),
  };
}

function rowFromView(view: BranchRunView): OverviewRow {
  const rec = view.record;
  const state: OverviewState = rec ? rec.status : "outcome unavailable";
  return {
    runId: view.receipt?.runId ?? rec?.runId ?? "(unknown run)",
    type: view.receipt?.type ?? rec?.type ?? "(unknown type)",
    description: view.receipt?.description || rec?.description || "",
    state,
    active: false,
  };
}

/**
 * Build the overview rows: live current-session runs combined with available
 * reconstructed current-branch history. Dedup is by run id — the live
 * record's state is authoritative for a run both sources know; history never
 * shadows or duplicates it. Rows order active first then terminal, newest
 * first within each group.
 */
export function buildOverviewRows(
  live: readonly AgentRecord[],
  views: readonly BranchRunView[],
): OverviewRow[] {
  const historyOnly: OverviewRow[] = [];
  for (let i = views.length - 1; i >= 0; i--) {
    const row = rowFromView(views[i]!);
    // Live records outrank history for the same run — never duplicate a run.
    if (live.some((rec) => rec.id === row.runId)) continue;
    historyOnly.push(row);
  }
  // Live records: active group first (reverse creation order), then terminal.
  const rows = [...live]
    .toReversed()
    .toSorted((a, b) => Number(rowFromRecord(b).active) - Number(rowFromRecord(a).active));
  return rows.map(rowFromRecord).concat(historyOnly);
}

/** One user-visible overview row: run id, type, description, textual state. */
export function overviewRowLine(row: OverviewRow): string {
  return `[run ${row.runId}] — ${row.type}${row.description ? ` "${row.description}"` : ""} — ${row.state}`;
}