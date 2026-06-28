import type { AgentType } from "./agents.ts";

// Deep module: a concurrency-limited scheduler that owns sub-agent records,
// the queue, the running count, and lifecycle notifications. Callers see only
// launch / getResult / list. It knows nothing about cwd, models, or Pi — the
// caller hands it an opaque `exec` thunk — so it is unit-testable with a fake
// exec and has no reason to change when the runner or Pi APIs change.

export type Status = "queued" | "running" | "completed" | "failed";

export interface RunOutput {
  result: string;
  tokens: number;
  toolUses: number;
}

export interface AgentRecord {
  id: string;
  type: AgentType;
  description: string;
  status: Status;
  result?: string;
  error?: string;
  tokens: number;
  toolUses: number;
  /** Extension-specific warnings (e.g. unresolvable model refs). */
  warnings?: ReadonlyArray<{ scope: string; reference: string; type: string }>;
}

export interface LaunchTask {
  type: AgentType;
  description: string;
  background?: boolean;
}

export interface ManagerOptions {
  maxConcurrency?: number;
  /** Lifecycle bus: "created" | "started" | "completed" | "failed". */
  onEvent?: (name: string, record: AgentRecord) => void;
}

interface Job {
  record: AgentRecord;
  exec: () => Promise<RunOutput>;
  onSettled?: (record: AgentRecord) => void;
  resolve: (record: AgentRecord) => void;
}

export class AgentManager {
  private records = new Map<string, AgentRecord>();
  private backgroundQueue: Job[] = [];
  private foregroundQueue: Job[] = [];
  private running = 0;
  private seq = 0;
  private maxConcurrency: number;
  private onEvent: (name: string, record: AgentRecord) => void;

  constructor(opts: ManagerOptions = {}) {
    this.maxConcurrency = opts.maxConcurrency && opts.maxConcurrency > 0 ? opts.maxConcurrency : 4;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Launch a sub-agent. Returns its record and a `done` promise that resolves
   * when the job settles. Foreground jobs enter a priority queue ahead of
   * background jobs; both are subject to the same concurrency cap.
   */
  launch(
    task: LaunchTask,
    exec: () => Promise<RunOutput>,
    onSettled?: (record: AgentRecord) => void,
  ): { record: AgentRecord; done: Promise<AgentRecord> } {
    const record: AgentRecord = {
      id: `sa_${(++this.seq).toString(36)}_${Date.now().toString(36).slice(-4)}`,
      type: task.type,
      description: task.description,
      status: "queued",
      tokens: 0,
      toolUses: 0,
    };
    this.records.set(record.id, record);
    this.onEvent("created", record);

    const done = new Promise<AgentRecord>((resolve) => {
      const job: Job = { record, exec, onSettled, resolve };
      if (task.background) {
        this.backgroundQueue.push(job);
      } else {
        this.foregroundQueue.push(job);
      }
      this.pump();
    });
    return { record, done };
  }

  async getResult(id: string, wait = false): Promise<AgentRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`No subagent ${id}`);
    if (wait) {
      while (record.status === "queued" || record.status === "running") {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return record;
  }

  list(): AgentRecord[] {
    return [...this.records.values()];
  }

  private async run(job: Job): Promise<void> {
    this.running++;
    job.record.status = "running";
    this.onEvent("started", job.record);
    try {
      const out = await job.exec();
      Object.assign(job.record, { ...out, status: "completed" satisfies Status });
      this.onEvent("completed", job.record);
    } catch (e: any) {
      Object.assign(job.record, { error: e?.message ?? String(e), status: "failed" satisfies Status });
      this.onEvent("failed", job.record);
    } finally {
      this.running--;
      job.onSettled?.(job.record);
      job.resolve(job.record);
      this.pump();
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrency) {
      // Foreground has priority; only drain background when no foreground jobs.
      const job = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
      if (!job) break;
      void this.run(job);
    }
  }
}
