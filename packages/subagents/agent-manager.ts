import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentTypeConfig, SubagentRun, SubagentSettings } from "./types.ts";
import { resolveAgentType } from "./agent-types.ts";
import { runSubagent, type RunResult, type RunOptions } from "./agent-runner.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const CLEANUP_INTERVAL_MS = 60_000;

export interface SpawnOptions {
  description: string;
  prompt: string;
  subagentType: string;
  parentSystemPrompt: string;
  parentContext?: string;
  cwd: string;
  model?: Model<any>;
  modelName?: string;
  modelRegistry?: ModelRegistry;
  maxTurns?: number;
  inheritContext?: boolean;
  allowOutsideCwd?: boolean;
  signal?: AbortSignal;
  onUpdate?: (status: string) => void;
  saveTranscript?: boolean;
  parentId?: string;
  depth?: number;
}

type QueueItem = {
  run: SubagentRun;
  config: AgentTypeConfig;
  opts: SpawnOptions;
};

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;

  const controller = new AbortController();
  const abort = () => controller.abort();

  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }

  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export class AgentManager {
  private runs = new Map<string, SubagentRun>();
  private backgroundQueue: QueueItem[] = [];
  private activeBackground = 0;
  private counter = 0;
  private cleanupTimer: ReturnType<typeof setInterval>;
  private runner: (opts: RunOptions) => Promise<RunResult>;
  private settings: SubagentSettings;

  constructor(
    runner: (opts: RunOptions) => Promise<RunResult> = runSubagent,
    settings: SubagentSettings = DEFAULT_SETTINGS,
  ) {
    this.runner = runner;
    this.settings = settings;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  generateId(): string {
    this.counter++;
    return `subagent_${Date.now()}_${this.counter}`;
  }

  getRun(id: string): SubagentRun | undefined {
    return this.runs.get(id);
  }

  listRuns(status: "queued" | "running" | "completed" | "error" | "stopped" | "all" = "all"): SubagentRun[] {
    const runs = [...this.runs.values()].sort((a, b) => {
      const timeDiff = b.startedAt - a.startedAt;
      if (timeDiff !== 0) return timeDiff;
      return b.id > a.id ? 1 : -1; // tiebreaker: higher counter id first
    });
    if (status === "all") return runs;
    return runs.filter((run) => run.status === status);
  }

  getActiveCount(): number {
    return this.activeBackground;
  }

  getQueuedCount(): number {
    return this.backgroundQueue.length;
  }

  async spawnAndWait(opts: SpawnOptions): Promise<{ id: string; result: RunResult }> {
    const id = this.generateId();
    const { config, fallback } = resolveAgentType(opts.subagentType);

    const run = this.createRun(id, opts, config.name);
    if (fallback) run.requestedType = opts.subagentType;

    this.runs.set(id, run);
    opts.onUpdate?.("queued");

    const promise = this.executeRun(run, config, opts);
    run.promise = promise;

    try {
      const result = await promise;
      return { id, result };
    } finally {
      run.promise = promise;
    }
  }

  spawn(opts: SpawnOptions): string {
    if (this.backgroundQueue.length >= this.settings.maxQueueSize) {
      throw new Error(`Background queue is full (max ${this.settings.maxQueueSize}). Wait for running subagents to complete.`);
    }

    const id = this.generateId();
    const { config, fallback } = resolveAgentType(opts.subagentType);
    const run = this.createRun(id, opts, config.name);
    if (fallback) run.requestedType = opts.subagentType;

    this.runs.set(id, run);

    if (this.activeBackground < this.settings.maxConcurrency) {
      this.startBackground(run, config, opts);
    } else {
      this.backgroundQueue.push({ run, config, opts });
    }

    return id;
  }

  stop(id: string, reason?: string): { ok: boolean; message: string; run?: SubagentRun } {
    const run = this.runs.get(id);
    if (!run) {
      return { ok: false, message: `Unknown agent ID: ${id}. The subagent run may have expired or never existed.` };
    }

    if (run.status === "completed" || run.status === "error" || run.status === "stopped") {
      return { ok: true, message: `No-op: subagent is already ${run.status}.`, run };
    }

    const stopReason = reason?.trim() || "Stopped by user";

    if (run.status === "queued") {
      this.backgroundQueue = this.backgroundQueue.filter((item) => item.run.id !== run.id);
      run.status = "stopped";
      run.stopReason = stopReason;
      run.completedAt = Date.now();
      return { ok: true, message: `Stopped queued subagent ${id}.`, run };
    }

    run.stopReason = stopReason;
    run.abortController?.abort();
    if (run.session && typeof (run.session as any).abort === "function") {
      void (run.session as any).abort();
    }
    return { ok: true, message: `Stop requested for running subagent ${id}.`, run };
  }

  async steer(
    id: string,
    message: string,
    priority: "normal" | "urgent" = "normal",
  ): Promise<{ ok: boolean; message: string }> {
    const run = this.runs.get(id);
    if (!run) {
      return { ok: false, message: `Unknown agent ID: ${id}.` };
    }

    if (run.status === "queued") {
      return { ok: false, message: `Subagent ${id} is not running yet.` };
    }

    if (run.status !== "running") {
      return { ok: false, message: `Subagent ${id} is ${run.status}; only running subagents can be steered.` };
    }

    const steerFn = run.session && (run.session as any).steer;
    if (typeof steerFn !== "function") {
      return { ok: false, message: "Steering unsupported by current Pi SDK session API." };
    }

    await steerFn.call(run.session, message);
    run.steeringMessages.push({ at: Date.now(), message, priority });
    return { ok: true, message: `Steering delivered to subagent ${id}.` };
  }

  private createRun(id: string, opts: SpawnOptions, resolvedType: string): SubagentRun {
    return {
      id,
      requestedType: opts.subagentType,
      type: resolvedType,
      description: opts.description,
      status: "queued",
      startedAt: Date.now(),
      toolUses: 0,
      turnCount: 0,
      wasLimited: false,
      depth: opts.depth ?? 0,
      parentId: opts.parentId,
      model: opts.modelName,
      steeringMessages: [],
    };
  }

  private startBackground(run: SubagentRun, config: AgentTypeConfig, opts: SpawnOptions): void {
    this.activeBackground++;
    run.status = "running";
    const promise = this.executeRun(run, config, opts);
    run.promise = promise;
    promise.finally(() => {
      this.activeBackground--;
      this.processQueue();
    });
  }

  private async executeRun(run: SubagentRun, config: AgentTypeConfig, opts: SpawnOptions): Promise<RunResult> {
    run.status = "running";
    const abortController = new AbortController();
    run.abortController = abortController;

    try {
      const result = await this.runner({
        taskPrompt: opts.prompt,
        description: opts.description,
        config,
        parentSystemPrompt: opts.parentSystemPrompt,
        parentContext: opts.parentContext,
        cwd: opts.cwd,
        model: opts.model,
        modelRegistry: opts.modelRegistry,
        maxTurns: opts.maxTurns,
        inheritContext: opts.inheritContext ?? (config.name === "general-purpose"),
        allowOutsideCwd: opts.allowOutsideCwd ?? false,
        signal: mergeSignals(opts.signal, abortController.signal),
        onUpdate: opts.onUpdate,
        onSessionReady: (session: any) => {
          run.session = session;
        },
        onPartial: (text) => {
          run.partialOutput = text;
        },
      });

      run.turnCount = result.turnCount;
      run.wasLimited = result.wasLimited;
      run.result = result.text;
      run.partialOutput = result.text || run.partialOutput;

      if (result.error !== undefined) {
        run.status = run.stopReason ? "stopped" : "error";
        run.error = result.error;
      } else {
        run.status = "completed";
      }

      run.completedAt = Date.now();
      return result;
    } catch (err: any) {
      run.status = run.stopReason ? "stopped" : "error";
      run.error = String(err.message ?? err);
      run.completedAt = Date.now();
      throw err;
    } finally {
      run.session = undefined;
      run.abortController = undefined;
    }
  }

  private processQueue(): void {
    while (this.backgroundQueue.length > 0 && this.activeBackground < this.settings.maxConcurrency) {
      const next = this.backgroundQueue.shift();
      if (!next) break;

      if (next.run.status === "stopped") {
        continue;
      }

      this.startBackground(next.run, next.config, next.opts);
    }
  }

  shutdown(): void {
    clearInterval(this.cleanupTimer);
    for (const [, run] of this.runs) {
      if (run.status === "queued" || run.status === "running") {
        run.stopReason = run.stopReason || "Parent session shutting down";
        run.abortController?.abort();
        if (run.session && typeof (run.session as any).dispose === "function") {
          (run.session as any).dispose();
        }
        run.status = "stopped";
        run.completedAt = Date.now();
      }
    }
    this.backgroundQueue = [];
    this.activeBackground = 0;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      const isTerminal = run.status === "completed" || run.status === "error" || run.status === "stopped";
      if (isTerminal && run.completedAt && (now - run.completedAt) > this.settings.recordTtlMs) {
        if (run.session && typeof (run.session as any).dispose === "function") {
          (run.session as any).dispose();
        }
        this.runs.delete(id);
      }
    }
  }
}
