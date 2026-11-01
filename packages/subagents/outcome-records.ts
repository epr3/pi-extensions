import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentRecord } from "./manager.ts";
import { isTerminalStatus } from "./manager.ts";
import type { ActivitySnapshot } from "./activity.ts";
import type { StreamEntry } from "./activity.ts";
import { isStaleContextError, OUTCOME_MESSAGE_TYPE, partialOutputBlock } from "./delivery.ts";
import type { TerminalStatus } from "./manager.ts";

/**
 * Persisted background outcomes for session revisit (ticket 0016).
 *
 * Each terminal background outcome — and its retained UI-only Activity tail,
 * bounded to 50 entries with its omission indicator — becomes one append-only
 * custom session entry, written through `pi.appendEntry` on the originating
 * session. On revisit the branch's history is the source of truth: a branch
 * shows only completions its own history contains, a receipt without a
 * persisted completion reads "outcome unavailable" (never active, failed, or
 * completed), and nothing about reconstruction redelivers or starts a model
 * turn — persistence and delivery are distinct operations.
 *
 * Not promised: these are best-effort writes. Shutdown, replacement, or a
 * crash can prevent one, leaving the receipt without a record; the 50-entry
 * bound is an entry count, not a byte guarantee — session storage contains
 * the retained tail's full entries.
 */

/** Session custom-entry type for persisted terminal background outcomes. */
export const OUTCOME_RECORD_TYPE = "subagent-outcome-record";

/** The terminal statuses used in persisted records — the manager's terminal
 *  members of the Status union. */
export type PersistedStatus = TerminalStatus;

/**
 * The persisted record for one terminal background outcome. Shaped for
 * reconstruction only — never model-facing: result/partial text is bounded
 * already, and the activity tail lives here, kept out of every content path
 * that reaches the parent model.
 */
export interface OutcomeRecord {
  runId: string;
  type: string;
  description: string;
  status: PersistedStatus;
  /** Completed runs only; already bounded by the shared result limit. */
  result?: string;
  /** Failed runs: the failure reason (outside the result limit). */
  error?: string;
  /** Stopped runs: why the run stopped. */
  stopReason?: string;
  /** Stopped/failed runs: assistant text captured before the terminal
   *  event, already bounded and clearly partial when shown. */
  partialText?: string;
  tokens: number;
  toolUses: number;
  /** Retained UI-only Activity tail (≤50 entries, chronological). */
  activity: StreamEntry[];
  /** How many earlier activity entries were dropped — the omission
   *  indicator's number; 0 means the indicator is absent. */
  activityOmitted: number;
  persistedAt: string;
}

/**
 * Build the persisted record from a settled record and its retained
 * Activity tail. Only terminal background outcomes persist — foreground runs
 * return inline and non-terminal states have no outcome.
 */
export function buildOutcomeRecord(rec: AgentRecord, activity: ActivitySnapshot): OutcomeRecord {
  if (!rec.background) {
    throw new Error(
      `Foreground run ${rec.id} returns inline and is not persisted; only terminal background outcomes are.`,
    );
  }
  if (!isTerminalStatus(rec.status)) {
    throw new Error(`Run ${rec.id} is ${rec.status}; only terminal outcomes are persisted.`);
  }
  const { entries, omitted } = activity;
  // Terminal checked above; isTerminalStatus is a type predicate, so
  // rec.status is already narrowed here.
  return {
    runId: rec.id,
    type: rec.type,
    description: rec.description,
    status: rec.status,
    ...(rec.status === "completed" && rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.stopReason ? { stopReason: rec.stopReason } : {}),
    ...(rec.partialText ? { partialText: rec.partialText } : {}),
    tokens: rec.tokens,
    toolUses: rec.toolUses,
    activity: entries.map((e) => ({ ...e })),
    activityOmitted: omitted,
    persistedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconstruction: revisit reads the CURRENT branch's history.
// ─────────────────────────────────────────────────────────────────────────────

/** The launch information visible on a branch's receipt row. */
export interface LaunchReceiptView {
  runId: string;
  type: string;
  description: string;
}

/** One background Subagent run as the current branch's history shows it. */
export interface BranchRunView {
  /** The branch's launch receipt, when one is present. */
  receipt?: LaunchReceiptView;
  /** The persisted terminal outcome, only when this branch's history
   *  recorded it — never copied from a sibling branch. */
  record?: OutcomeRecord;
  /** Whether the branch history also contains the delivered attributed
   *  completion message (persisted-but-undelivered stays distinguishable). */
  delivered: boolean;
}

type TerminalToolResult = ToolResultMessage<{ agent_id?: unknown }>;

/** The launch receipt's structured fields as the Agent launch result writes
 *  them: run id plus the type/description identity (dual result contract). */
interface ReceiptDetails {
  agent_id?: unknown;
  type?: unknown;
  description?: unknown;
}

/** Pull the run identity out of a persisted Agent tool result (the receipt).
 *  Reads the structured identity the launch result carries in `details` —
 *  never the row's display text. Details without type/description (legacy or
 *  hand-built history) degrade to "(unknown type)" / empty rather than being
 *  guessed; the run stays keyed by its agent_id either way. */
function receiptFromToolResult(message: ToolResultMessage): LaunchReceiptView | undefined {
  const details = (message.details ?? {}) as ReceiptDetails;
  if (typeof details.agent_id !== "string" || !details.agent_id) return undefined;
  return {
    runId: details.agent_id,
    type: typeof details.type === "string" && details.type ? details.type : "(unknown type)",
    description: typeof details.description === "string" ? details.description : "",
  };
}

/** Strictly read back our own record shape; anything malformed is ignored
 *  rather than guessed (a corrupt entry must not resurrect a status). */
function recordFromEntry(data: unknown): OutcomeRecord | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.runId !== "string" || !d.runId) return undefined;
  const status = (d.status as OutcomeRecord["status"]) ?? undefined;
  if (status !== "completed" && status !== "failed" && status !== "stopped") return undefined;
  if (!Array.isArray(d.activity)) return undefined;
  const [type, description, tokens, toolUses] = [d.type, d.description, d.tokens, d.toolUses];
  if (typeof type !== "string") return undefined;
  return {
    runId: d.runId,
    type,
    description: typeof description === "string" ? description : "",
    status,
    ...(typeof d.result === "string" ? { result: d.result } : {}),
    ...(typeof d.error === "string" ? { error: d.error } : {}),
    ...(typeof d.stopReason === "string" ? { stopReason: d.stopReason } : {}),
    ...(typeof d.partialText === "string" ? { partialText: d.partialText } : {}),
    tokens: typeof tokens === "number" ? tokens : 0,
    toolUses: typeof toolUses === "number" ? toolUses : 0,
    activity: (d.activity as StreamEntry[]).filter((e) => !!e && typeof e === "object"),
    activityOmitted: typeof d.activityOmitted === "number" ? d.activityOmitted : 0,
    persistedAt: typeof d.persistedAt === "string" ? d.persistedAt : "",
  };
}

/**
 * Reconstruct the background Subagent runs visible in one branch's history —
 * pass the entries of the CURRENT branch (`ctx.sessionManager.getBranch()`).
 * A branch shows only completions its own history contains; a sibling that
 * has only the receipt sees "outcome unavailable", never the other branch's
 * outcome. Pure and read-only: no delivery, no writes, no model turn.
 */
export function reconstructBranchRuns(entries: readonly SessionEntry[]): BranchRunView[] {
  const runs = new Map<string, BranchRunView>();
  // getBranch walks leaf→root; keep the caller's order as recording order.
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (
        message?.role === "toolResult" &&
        (message as TerminalToolResult).toolName === "Agent" &&
        (message as unknown as { details?: { agent_id?: unknown } }).details?.agent_id !== undefined
      ) {
        const receipt = receiptFromToolResult(message);
        if (receipt && !runs.has(receipt.runId))
          runs.set(receipt.runId, {
            receipt,
            delivered: false,
          });
      }
    } else if (entry.type === "custom") {
      if (entry.customType !== OUTCOME_RECORD_TYPE) continue;
      const record = recordFromEntry(entry.data);
      if (!record) continue;
      const view = runs.get(record.runId) ?? { receipt: undefined, delivered: false };
      if (!view.record) view.record = record;
      runs.set(record.runId, view);
    } else if (entry.type === "custom_message") {
      if (entry.customType !== OUTCOME_MESSAGE_TYPE) continue;
      const details = (entry.details ?? {}) as { agentId?: unknown };
      if (typeof details.agentId !== "string" || !details.agentId) continue;
      const view = runs.get(details.agentId) ?? { receipt: undefined, delivered: false };
      view.delivered = true;
      runs.set(details.agentId, view);
    }
  }
  return [...runs.values()];
}

/** Headline word for a view's outcome, or the "unavailable" wording. */
function outcomeSummary(view: BranchRunView): string {
  const rec = view.record;
  if (!rec) return "outcome unavailable";
  if (rec.status === "completed")
    return `completed: ${(rec.result ?? "(no output)").split("\n", 1)[0]}`;
  if (rec.status === "failed") return `failed: ${rec.error ?? "unknown error"}`;
  return `stopped \u2014 ${rec.stopReason ?? "stopped by request"}`;
}

/**
 * The UI listing for reconstructed runs — inspectable on revisit without a
 * model turn or redelivery. Delivery provenance is stated in words: a
 * persisted-but-undelivered outcome stays distinguishable. The receipt-only
 * case says "outcome unavailable" and never implies the run is still active
 * or that it failed; a record's retained activity is summarized by count and
 * omission indicator, never included in full.
 */
export function describeBranchRuns(views: readonly BranchRunView[]): string {
  if (views.length === 0) return "";
  return views
    .map((view) => {
      const id = view.receipt?.runId ?? view.record?.runId ?? "(unknown run)";
      const type = view.receipt?.type ?? view.record?.type ?? "(unknown type)";
      const desc = view.receipt?.description || view.record?.description || "";
      const delivery = view.delivered ? "delivered" : "not delivered to the conversation";
      const omitted = view.record?.activityOmitted ?? 0;
      const count = view.record?.activity.length ?? 0;
      const plural = (n: number) => (n === 1 ? "1 entry" : `${n} entries`);
      const activity =
        count || omitted
          ? `activity: ${plural(count)}${omitted ? ` (${omitted} earlier omitted)` : ""}`
          : "activity: unavailable";
      const parts = [
        `[run ${id}]`,
        `${type}${desc ? ` "${desc}"` : ""}`,
        outcomeSummary(view),
        delivery,
        activity,
      ];
      // A persisted but undelivered outcome stays inspectable through this
      // listing and explicit retrieval — nothing redelivers it here.
      if (!view.delivered && view.record) {
        parts.push("persisted outcome \u2014 explicit retrieval available");
      }
      return `- ${parts.join(" \u2014 ")}`;
    })
    .join("\n");
}

/**
 * Model-facing text for explicitly retrieving one reconstructed outcome
 * (never automatic: revisit itself delivers nothing). Carries the bounded
 * result or the marked/absent partial output; the retained activity is
 * summarized by counts only — its content stays UI-only.
 */
export function reconstructedRetrievalText(view: BranchRunView): string {
  const rec = view.record;
  const id = view.receipt?.runId ?? rec?.runId ?? "(unknown run)";
  const type = view.receipt?.type ?? rec?.type ?? "(unknown type)";
  const desc = view.receipt?.description ?? rec?.description ?? "";
  if (!rec) {
    return (
      `Run ${id} (${type}, "${desc}") has a launch receipt in this branch's history \u2014 ` +
      "outcome unavailable. No completion was recorded in this session's history. " +
      "The run is not known to be active; whether it finished and how cannot be shown from what " +
      "was recorded. The /subagents command lists what this branch recorded."
    );
  }
  const head =
    rec.status === "completed"
      ? `Run ${id} (${type}, "${desc}") — completed earlier in this session:`
      : rec.status === "failed"
        ? `Run ${id} (${type}, "${desc}") — failed: ${rec.error ?? "unknown error"}`
        : `Run ${id} (${type}, "${desc}") — stopped — ${rec.stopReason ?? "stopped by request"}`;
  const body =
    rec.status === "completed"
      ? (rec.result ?? "(no output)")
      : partialOutputBlock({ partialText: rec.partialText });
  const omitted = rec.activityOmitted;
  const activityNote =
    rec.activity.length || omitted
      ? `\n\nRetained activity is available in the run's UI presentation (${rec.activity.length} entries${omitted ? `, ${omitted} earlier omitted` : ""}); its content stays out of this result.`
      : "";
  return `${head}\n${body}${activityNote}`;
}

/** A persistence write failed for a reason other than session replacement. */
export interface PersistenceDiagnostic {
  kind: "persistence-error";
  runId: string;
  cause: unknown;
}

/**
 * Persists terminal background outcomes as append-only session entries.
 * Bound to the originating session like delivery, but distinct from it:
 * delivery may be withheld (busy queue cleared, mode, owner gone) while the
 * outcome still persists — and vice versa a crash can prevent the write.
 */
export class OutcomePersistence {
  private past = new Set<string>();
  private active = true;

  constructor(
    /** The session's append-only custom-entry writer (pi.appendEntry). */
    private appendEntry: (customType: string, data: OutcomeRecord) => void,
    private opts: { onError?: (diagnostic: PersistenceDiagnostic) => void } = {},
  ) {}

  /** Session shutdown/replacement: this persistence channel never writes again. */
  endSession(): void {
    this.active = false;
  }

  /** Best-effort, never throws: a failed write leaves the receipt saying
   *  "outcome unavailable" on revisit rather than a half-written entry. */
  record(rec: AgentRecord, activity: ActivitySnapshot): void {
    if (!this.active || !rec.background || !isTerminalStatus(rec.status)) return;
    if (this.past.has(rec.id)) return; // one entry per terminal outcome
    this.past.add(rec.id);
    try {
      this.appendEntry(OUTCOME_RECORD_TYPE, buildOutcomeRecord(rec, activity));
    } catch (e) {
      // Stale context: the originating session is gone — the record belongs
      // to no reachable session, so stay silent. Anything else is a real
      // write failure; surface it as a diagnostic instead of throwing into
      // the caller's settle path.
      if (!isStaleContextError(e)) {
        this.opts.onError?.({ kind: "persistence-error", runId: rec.id, cause: e });
      }
    }
  }
}