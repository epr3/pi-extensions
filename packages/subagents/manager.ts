import type { AgentType } from "./agents.ts";
import { appendTruncationNotice } from "./result-limit.ts";

// Deep module: a concurrency-limited scheduler that owns sub-agent records,
// the queue, the running count, and lifecycle notifications. Callers see only
// launch / stop / getResult / list. It knows nothing about cwd, models, or Pi
// — the caller hands it an opaque `exec` thunk that accepts the job's abort
// signal — so it is unit-testable with a fake exec and has no reason to change
// when the runner or Pi APIs change.

export type Status = "queued" | "running" | "completed" | "failed" | "stopped";

/** Terminal states: once a run reaches one, no later stop may change it. */
export type TerminalStatus = "completed" | "failed" | "stopped";

/** Type predicate — narrows a Status to its terminal members. */
export function isTerminalStatus(status: Status): status is TerminalStatus {
  return status === "completed" || status === "failed" || status === "stopped";
}

export interface RunOutput {
  result: string;
  tokens: number;
  toolUses: number;
}

export interface AgentRecord {
  id: string;
  /** Built-in name (explore/general) or a resolved custom Subagent type name. */
  type: AgentType | string;
  description: string;
  status: Status;
  /** True when the run was launched with run_in_background. */
  background: boolean;
  result?: string;
  error?: string;
  /** Why the run stopped (stop_subagent); never set for completed/failed. */
  stopReason?: string;
  /** Assistant text captured before a stop or failure for stopped/failed
   *  runs, already bounded with the shared result limit. Undefined when no
   *  assistant text was available. */
  partialText?: string;
  tokens: number;
  toolUses: number;
  /** Extension-specific warnings (e.g. unresolvable model refs). */
  warnings?: ReadonlyArray<{ scope: string; reference: string; type: string }>;
}

export interface LaunchTask {
  type: AgentType | string;
  description: string;
  background?: boolean;
}

export interface ManagerOptions {
  maxConcurrency?: number;
  /** Lifecycle bus: "created" | "started" | "completed" | "failed" | "stopped". */
  onEvent?: (name: string, record: AgentRecord) => void;
}

/** Result of a parent-facing stop of a background run. */
export interface StopOutcome {
  /** "stopped": the stop changed the run; "unchanged": already terminal. */
  action: "stopped" | "unchanged";
  record: AgentRecord;
}

interface Job {
  record: AgentRecord;
  exec: (signal: AbortSignal) => Promise<RunOutput>;
  onSettled?: (record: AgentRecord) => void;
  resolve: (record: AgentRecord) => void;
  done: Promise<AgentRecord>;
  /** Abort source for stop_subagent; wired into the run's exec signal. */
  controller: AbortController;
  /** Set once a stop request reached a not-yet-terminal job. */
  stopRequested: boolean;
  /** Set when shutdown stops this job; wins over stop_subagent's wording. */
  shutdownReason?: string;
  /** True once the first terminal outcome has been applied. */
  terminal: boolean;
}

export class AgentManager {
  private records = new Map<string, AgentRecord>();
  private jobs = new Map<string, Job>();
  private backgroundQueue: Job[] = [];
  private foregroundQueue: Job[] = [];
  private running = 0;
  private seq = 0;
  private maxConcurrency: number;
  private onEvent: (name: string, record: AgentRecord) => void;
  private shuttingDown = false;

  constructor(opts: ManagerOptions = {}) {
    this.maxConcurrency = opts.maxConcurrency && opts.maxConcurrency > 0 ? opts.maxConcurrency : 4;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Launch a sub-agent. Returns its record and a `done` promise that resolves
   * when the job settles. Foreground jobs enter a priority queue ahead of
   * background jobs; both are subject to the same concurrency cap. The exec
   * thunk receives the job's abort signal: aborting it stops the child run.
   */
  launch(
    task: LaunchTask,
    exec: (signal: AbortSignal) => Promise<RunOutput>,
    onSettled?: (record: AgentRecord) => void,
  ): { record: AgentRecord; done: Promise<AgentRecord> } {
    if (this.shuttingDown) {
      throw new Error(
        "Cannot launch a Subagent after session shutdown or replacement — " +
          "this session's run registry is closed.",
      );
    }
    const record: AgentRecord = {
      id: `sa_${(++this.seq).toString(36)}_${Date.now().toString(36).slice(-4)}`,
      type: task.type,
      description: task.description,
      status: "queued",
      background: !!task.background,
      tokens: 0,
      toolUses: 0,
    };
    this.records.set(record.id, record);
    this.onEvent("created", record);

    let resolveDone!: (record: AgentRecord) => void;
    const done = new Promise<AgentRecord>((resolve) => {
      resolveDone = resolve;
    });
    const job: Job = {
      record,
      exec,
      onSettled,
      resolve: resolveDone,
      done,
      controller: new AbortController(),
      stopRequested: false,
      terminal: false,
    };
    this.jobs.set(record.id, job);
    if (task.background) {
      this.backgroundQueue.push(job);
    } else {
      this.foregroundQueue.push(job);
    }
    this.pump();
    return { record, done };
  }

  /**
   * Stop one queued or running background run. A queued run is removed from
   * the queue and settles as stopped without ever starting; a running run's
   * abort signal fires and its exec rejects, settling the run as stopped with
   * any partial assistant text. Stopping an already-terminal run is a no-op
   * that reports ("unchanged") — the first terminal outcome always wins.
   * Foreground runs are refused: the parent's own cancellation stops them.
   */
  async stop(id: string): Promise<StopOutcome> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No subagent ${id}`);
    if (!job.record.background) {
      throw new Error(
        `Subagent ${id} is a foreground run. Only background runs can be stopped; ` +
          `a foreground run stops when the parent's tool call is cancelled.`,
      );
    }
    if (isTerminalStatus(job.record.status)) {
      return { action: "unchanged", record: job.record };
    }
    if (job.record.status === "queued") {
      this.unqueue(job);
      this.settleTerminal(job, {
        status: "stopped",
        stopReason: "Stopped by request before it started",
      });
      return { action: "stopped", record: job.record };
    }
    // Running: request the stop and let the exec's rejection (or an already
    // resolved completion) settle the record — whichever lands first wins.
    job.stopRequested = true;
    job.controller.abort();
    const record = await job.done;
    return {
      action: record.status === "stopped" ? "stopped" : "unchanged",
      record,
    };
  }

  /**
   * Stop every queued and running run: the originating session is shutting
   * down or being replaced (session_shutdown for quit/reload/new/resume/fork).
   * Queued runs settle as stopped without ever starting; running runs are
   * aborted. Delivery is withheld for shutdown-stopped runs (the owner is
   * gone), so callers deactivate their delivery channel before this. Safe to
   * call repeatedly: the second call is a no-op.
   */
  shutdown(reason = "Session ended"): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const job of this.jobs.values()) {
      if (job.terminal) continue;
      job.stopRequested = true;
      if (job.record.status === "queued") {
        this.unqueue(job);
        this.settleTerminal(job, {
          status: "stopped" satisfies Status,
          stopReason: reason,
        });
      } else {
        job.shutdownReason = reason;
        job.controller.abort();
        // Abort now, settle now: a shutdown-stopped run never claims output
        // it did not capture, and an exec that ignores its signal cannot
        // leave the registry holding a live-looking record. A later exec
        // rejection is a no-op (terminal already applied).
        this.settleTerminal(job, {
          status: "stopped" satisfies Status,
          stopReason: reason,
        });
      }
    }
  }

  async getResult(
    id: string,
    wait = false,
    onProgress?: (record: AgentRecord) => void,
  ): Promise<AgentRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`No subagent ${id}`);
    if (wait) {
      // Report the pre-wait state once, then each poll transition, so a
      // blocking retrieval can show live status instead of an idle row.
      let seen = "";
      const report = () => {
        const key = `${record.status}:${record.tokens}:${record.toolUses}`;
        if (key === seen) return;
        seen = key;
        onProgress?.(record);
      };
      report();
      while (record.status === "queued" || record.status === "running") {
        await new Promise((r) => setTimeout(r, 150));
        report();
      }
    }
    return record;
  }

  list(): AgentRecord[] {
    return [...this.records.values()];
  }

  private unqueue(job: Job): void {
    this.backgroundQueue = this.backgroundQueue.filter((j) => j !== job);
    this.foregroundQueue = this.foregroundQueue.filter((j) => j !== job);
  }

  /** Apply the first terminal outcome; later candidates are ignored. */
  private settleTerminal(job: Job, patch: Partial<AgentRecord> & { status: Status }): void {
    if (job.terminal) return;
    job.terminal = true;
    Object.assign(job.record, patch);
    // The status string doubles as the lifecycle event name, keeping the
    // "completed" and "failed" names already in use.
    this.onEvent(patch.status, job.record);
    job.onSettled?.(job.record);
    job.resolve(job.record);
    this.pump();
  }

  private async run(job: Job): Promise<void> {
    this.running++;
    job.record.status = "running";
    this.onEvent("started", job.record);
    try {
      const out = await job.exec(job.controller.signal);
      // Bound result text here, once, so every consumer of the record —
      // foreground return, explicit retrieval, and later automatic delivery —
      // sees the same bounded text. The truncation notice is composed outside
      // the limit; failure reasons are never bounded.
      this.settleTerminal(job, {
        status: "completed" satisfies Status,
        result: appendTruncationNotice(out?.result ?? ""),
        tokens: out?.tokens ?? 0,
        toolUses: out?.toolUses ?? 0,
      });
    } catch (e: any) {
      // Assistant text captured before the failure becomes the stopped/failed
      // partial output, bounded with the shared limit like any result text.
      const partial = typeof e?.partialText === "string" ? e.partialText : undefined;
      const partialPatch = partial ? { partialText: appendTruncationNotice(partial) } : {};
      if (job.stopRequested) {
        // The first terminal outcome is "stopped" — either stop_subagent or
        // session shutdown won the race with the run's own completion.
        this.settleTerminal(job, {
          status: "stopped" satisfies Status,
          stopReason: job.shutdownReason ?? "Stopped by request while running",
          ...partialPatch,
        });
      } else {
        this.settleTerminal(job, {
          status: "failed" satisfies Status,
          error: e?.message ?? String(e),
          ...partialPatch,
        });
      }
    } finally {
      this.running--;
      this.pump();
    }
  }

  private pump(): void {
    // Shutdown closed the registry: settle-out must not spawn new work.
    if (this.shuttingDown) return;
    while (this.running < this.maxConcurrency) {
      // Foreground has priority; only drain background when no foreground jobs.
      const job = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
      if (!job) break;
      void this.run(job);
    }
  }
}