import type { AgentRecord } from "./manager.ts";

/**
 * Automatic attributed completion delivery for background Subagent runs.
 *
 * Exactly one `subagent-outcome` custom message per run during normal
 * operation: it identifies the run (type, description, id), carries the
 * terminal status (completed / failed / stopped) and the bounded result —
 * or the clearly marked partial assistant text — and keeps structured
 * attribution in `details` (the dual result contract). It never contains live
 * activity, tool transcripts, or hidden reasoning.
 *
 * Delivery targets the originating parent session only. Busy parents get a
 * non-interrupting follow-up; idle parents get a turn-starting message.
 * Shutdown, queue clearing, cancellation, and crashes can prevent delivery —
 * no exactly-once guarantee is claimed — and explicit retrieval remains.
 */

/** Pi custom message type used for attributed background completions. */
export const OUTCOME_MESSAGE_TYPE = "subagent-outcome";

/** The message handed to `pi.sendMessage` for one run's terminal outcome. */
export interface OutcomeMessage {
  customType: string;
  content: string;
  /** Custom messages render in the transcript as ordinary entries. */
  display: boolean;
  /** Structured attribution (run id, type, status) — kept out of the text. */
  details: Record<string, unknown>;
}

/**
 * Explicit diagnostic for Pi modes whose process exits after the initial
 * prompt: automatic completion delivery cannot be promised there (it may
 * still land before disposal, but nothing guarantees the process lives long
 * enough). Deliberately keyed off the Pi *mode*, never off `hasUI` alone —
 * RPC is headless yet keeps the conversation running; print/json bind no
 * UI either but cannot promise continuation.
 */
export function modeDeliveryDiagnostic(mode?: string): string | undefined {
  if (mode !== "print" && mode !== "json") return undefined;
  return (
    `Automatic background completion delivery is not promised in ${mode} mode ` +
    `because ${mode} mode exits after the initial prompt and cannot guarantee a later turn. ` +
    `Retrieve background results explicitly with get_subagent_result.`
  );
}

/**
 * The parent-facing partial-output block for stopped/failed runs: assistant
 * text clearly marked incomplete, or an explicit statement that none is
 * available. Shared by explicit retrieval and automatic completions so both
 * use identical wording.
 */
export function partialOutputBlock(rec: AgentRecord): string {
  return rec.partialText
    ? `\n\nPartial assistant output (incomplete):\n${rec.partialText}`
    : "\n\nNo partial assistant output is available.";
}

/**
 * Compose the attributed completion message for one terminal outcome.
 * The result text is already bounded by the manager (shared result limit);
 * status words and the failure/stop reason sit outside that bound.
 */
export function outcomeMessage(rec: AgentRecord): OutcomeMessage {
  let head: string;
  if (rec.status === "completed") {
    head = `Subagent ${rec.type} (${rec.description}) completed [run ${rec.id}].`;
  } else if (rec.status === "failed") {
    head = `Subagent ${rec.type} (${rec.description}) failed [run ${rec.id}]: ${rec.error ?? "unknown error"}.`;
  } else {
    head = `Subagent ${rec.type} (${rec.description}) stopped [run ${rec.id}] — ${rec.stopReason ?? "stopped by request"}.`;
  }
  const body = rec.status === "completed" ? (rec.result ?? "(no output)") : partialOutputBlock(rec);
  const details: Record<string, unknown> = {
    agentId: rec.id,
    type: rec.type,
    description: rec.description,
    status: rec.status,
    tokens: rec.tokens,
    toolUses: rec.toolUses,
    ...(rec.error ? { error: rec.error } : {}),
    ...(rec.stopReason ? { stopReason: rec.stopReason } : {}),
  };
  if (rec.background === false) details.background = false;
  return {
    customType: OUTCOME_MESSAGE_TYPE,
    content: `${head}\n\n${body}`,
    display: true,
    details,
  };
}

/**
 * Tracks whether the parent session is inside an agent run. Busy = between
 * `agent_start` and `agent_settled` — never inferred from UI availability.
 * `agent_settled` resets the depth because Pi emits it only once nothing
 * (retries, compaction, queued continuations) remains.
 */
export class ParentBusyTracker {
  private depth = 0;
  onAgentStart(): void {
    this.depth++;
  }
  /** Fully settled: no continuation will run after this. */
  onAgentSettled(): void {
    this.depth = 0;
  }
  isBusy(): boolean {
    return this.depth > 0;
  }
}

/**
 * How a completion reaches the parent conversation. The decision (busy vs
 * idle) lives in the coordinator; the mechanism lives in the sink, which is
 * wired to the originating session's captured `pi` — accessors there throw
 * once that session is replaced, which the coordinator treats as
 * cancellation rather than failure.
 */
export interface DeliverySink {
  isParentBusy(): boolean;
  /** Busy parent: enqueue a follow-up that does not interrupt the turn. */
  queueFollowUp(msg: OutcomeMessage): void;
  /** Idle parent: deliver the message and start a parent turn. */
  startParentTurn(msg: OutcomeMessage): void;
}

/** A delivery attempt failed for a reason other than session replacement. */
export interface DeliveryDiagnostic {
  kind: "delivery-error";
  runId: string;
  cause: unknown;
}

/** True for Pi's stale-context errors ("This extension ctx is stale…"): the
 *  originating session was replaced or reloaded, so delivery must be
 *  abandoned, never retried into the replacement. */
export function isStaleContextError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("stale");
}

/**
 * Delivers at most one attributed completion per background run. Idempotent
 * on top of the manager's first-terminal-wins settle: repeat settles for the
 * same run id are dropped, so races cannot produce two completions.
 */
export class CompletionDelivery {
  private delivered = new Set<string>();
  private alive = true;

  constructor(
    private sink: DeliverySink,
    private opts: { onError?: (diagnostic: DeliveryDiagnostic) => void } = {},
  ) {}

  isDelivered(runId: string): boolean {
    return this.delivered.has(runId);
  }

  /** Session shutdown/replacement: this coordinator will never deliver again. */
  deactivate(): void {
    this.alive = false;
  }

  /** Fire-and-forget: never throws into the caller's settle path. */
  deliver(rec: AgentRecord): void {
    if (!this.alive) return;
    // Foreground runs return inline; they have no attributed completion.
    if (!rec.background || this.delivered.has(rec.id)) return;
    this.delivered.add(rec.id);
    const msg = outcomeMessage(rec);
    try {
      if (this.sink.isParentBusy()) this.sink.queueFollowUp(msg);
      else this.sink.startParentTurn(msg);
    } catch (e) {
      // Stale context: the run's owner is gone — cancel silently. Anything
      // else is a real delivery failure; surface it as a diagnostic instead
      // of corrupting the settle path with a throw.
      if (!isStaleContextError(e)) {
        this.opts.onError?.({ kind: "delivery-error", runId: rec.id, cause: e });
      }
    }
  }
}