// Active Subagent footer: a summary of the current session's active (queued
// or running) Subagent runs, rendered into Pi's keyed footer status space.
//
// The summary is a UI affordance, never a durable record or a model-facing
// result — the conversation's Launch receipts, Attributed completions, and
// persisted outcomes remain authoritative. It claims its own status key so
// existing footer information from other extensions is never displaced.
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "./manager.ts";

/** Exclusive footer status key of this package ("do not displace other"). */
export const FOOTER_STATUS_KEY = "subagents";

/**
 * Conservative width budget for the summary. The built-in footer joins every
 * extension's status on one line and truncates from the right with an
 * ellipsis, so a too-wide entry risks being misleadingly cut. Keeping our
 * text within this budget bounds the damage: under crowding the type
 * breakdown abbreviates first and the accurate total always leads the line.
 */
export const DEFAULT_ACTIVE_RUN_WIDTH = 60;

export interface ActiveRunCounts {
  /** Queued plus running runs. */
  total: number;
  running: number;
  queued: number;
  /** Count per requested Subagent type, in first-appearance order. */
  groups: ReadonlyArray<{ type: string; count: number }>;
}

/**
 * Current-session Subagent runs that occupy the footer: queued or running
 * ones. Foreground and background runs count alike; terminal runs are gone.
 */
export function activeRunCounts(runs: readonly AgentRecord[]): ActiveRunCounts | undefined {
  let running = 0;
  let queued = 0;
  const groups: Array<{ type: string; count: number }> = [];
  // One grouping pass over the runs: membership in the footer (queued or
  // running), the running/queued split, and the per-type groups all fall out
  // of the same traversal; terminal runs are gone.
  for (const run of runs) {
    if (run.status !== "queued" && run.status !== "running") continue;
    if (run.status === "running") running += 1;
    else queued += 1;
    const group = groups.find((g) => g.type === run.type);
    if (group) group.count += 1;
    else groups.push({ type: run.type, count: 1 });
  }
  if (running + queued === 0) return undefined;
  return { total: running + queued, running, queued, groups };
}

/**
 * One-line footer summary, or undefined when no run is active (the caller
 * clears its status key). The accurate total always leads; under a narrow
 * `maxWidth` the type breakdown abbreviates group by group before the
 * running/queued split — never the total, so crowding cannot mislead.
 */
export function activeRunSummary(
  runs: readonly AgentRecord[],
  maxWidth: number = DEFAULT_ACTIVE_RUN_WIDTH,
): string | undefined {
  const counts = activeRunCounts(runs);
  if (!counts) return undefined;

  const lead = `Subagents ${counts.total}`;
  const state =
    counts.running > 0 && counts.queued > 0
      ? `(${counts.running} running, ${counts.queued} queued)`
      : counts.running > 0
        ? `(${counts.running} running)`
        : `(${counts.queued} queued)`;
  const groupTexts = counts.groups.map((g) => `${g.count} ${g.type}`);

  // Candidate summaries, widest first: what gets dropped stays covered
  // by the leading total, so abbreviating never misleads.
  const candidates: string[] = [];
  for (let keep = groupTexts.length; keep >= 1; keep--) {
    candidates.push(`${lead} ${state} — ${groupTexts.slice(0, keep).join(", ")}`);
  }
  candidates.push(`${lead} ${state}`, lead);
  return candidates.find((candidate) => visibleWidth(candidate) <= maxWidth) ?? lead;
}

/** The piece of the extension UI the footer renders through. */
export interface FooterUIContext {
  hasUI: boolean;
  ui: { setStatus(key: string, text: string | undefined): void };
}

/**
 * Footer owner for one session's run registry. The extension attaches the
 * latest context it sees (tool execution carries one) and re-renders on
 * every run lifecycle event, so counts track state transitions.
 */
export class ActiveRunFooter {
  private stopped = false;
  private ctx?: FooterUIContext;

  constructor(private readonly maxWidth: number = DEFAULT_ACTIVE_RUN_WIDTH) {}

  /** Remember the most recent context; later run events render there. */
  attach(ctx: FooterUIContext): void {
    if (this.stopped) return;
    this.ctx = ctx;
  }

  /** Re-render from the current run state; undefined clears the status. */
  refresh(runs: readonly AgentRecord[]): void {
    if (this.stopped) return;
    const ctx = this.ctx;
    if (!ctx || !ctx.hasUI) return;
    ctx.ui.setStatus?.(FOOTER_STATUS_KEY, activeRunSummary(runs, this.maxWidth));
  }

  /**
   * Session shutdown or replacement: clear through the still-live shutdown
   * context and stop serving this session's run registry. Later lifecycle
   * events — including the synchronous settle of shutdown-stopped runs —
   * never reach a replacement session's footer, and this session's summary
   * cannot pass its state to any successor.
   */
  deactivate(ctx?: FooterUIContext): void {
    this.stopped = true;
    const target = ctx ?? this.ctx;
    this.ctx = undefined;
    if (!target?.hasUI) return;
    try {
      target.ui.setStatus?.(FOOTER_STATUS_KEY, undefined);
    } catch {
      // Stale context after replacement: the footer target is gone, and the
      // successor session's statuses are its own — nothing to clear here.
    }
  }
}