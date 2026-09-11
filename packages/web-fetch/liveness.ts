// ─── Process identity and liveness for abandoned-run cleanup ─────────────────

import { execFile } from "node:child_process";

/** Liveness verdict for an ownership record's process. */
export type Liveness = "live" | "dead" | "unknown";

/** Identity of the process that created an ownership record. */
export interface ProcessIdentity {
  pid: number;
  /** ISO 8601 start time, when available, for PID-reuse detection. */
  startTime?: string;
}

/**
 * Pluggable process liveness check.
 *
 * The default implementation is conservative: it can prove a remote pid is
 * dead (no such process) and can prove the current process is live, but for
 * other live processes it relies on an optional start-time comparison. When
 * start time is unavailable the verdict is "unknown", which cleanup treats as
 * ambiguous and preserves.
 */
export interface ProcessLiveness {
  /** Identity of the current process/extension instance. */
  current(): Promise<ProcessIdentity>;
  /**
   * Check whether the process identified by `pid` is live.
   * `recordStartTime` is the start time stored in the ownership record.
   */
  check(pid: number, recordStartTime?: string): Promise<Liveness>;
}

/** Round a start time to whole seconds so platform differences stay stable. */
function normalizeStartTime(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Try to read a process start time from `ps` (Unix-like systems only).
 *
 * On Windows this returns `undefined`, so remote pids are classified as
 * ambiguous and preserved. The `lstart` format is locale-dependent; an
 * unparseable result is treated the same as an unavailable one.
 */
function processStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "lstart="], (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const text = stdout.trim();
      const d = text ? new Date(text) : new Date(NaN);
      resolve(Number.isNaN(d.getTime()) ? undefined : d.toISOString());
    });
  });
}

/** Test process existence using signal 0 (portable best-effort). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means a process exists but we cannot signal it.
    if (code === "EPERM") return true;
    return false;
  }
}

/** Production liveness checker. */
export class DefaultProcessLiveness implements ProcessLiveness {
  private cachedIdentity: ProcessIdentity | undefined;
  private startTimeCache = new Map<number, string | undefined>();

  async current(): Promise<ProcessIdentity> {
    if (this.cachedIdentity) return this.cachedIdentity;
    const startTime = await this.getStartTime(process.pid);
    this.cachedIdentity = { pid: process.pid, startTime };
    return this.cachedIdentity;
  }

  async check(pid: number, recordStartTime?: string): Promise<Liveness> {
    if (pid === process.pid) {
      return "live";
    }
    if (!processExists(pid)) {
      return "dead";
    }
    if (!recordStartTime) {
      return "unknown";
    }
    const liveStart = await this.getStartTime(pid);
    if (!liveStart) {
      return "unknown";
    }
    return normalizeStartTime(liveStart) === normalizeStartTime(recordStartTime)
      ? "live"
      : "dead";
  }

  private async getStartTime(pid: number): Promise<string | undefined> {
    const cached = this.startTimeCache.get(pid);
    if (cached !== undefined || this.startTimeCache.has(pid)) {
      return cached;
    }
    const startTime = await processStartTime(pid);
    this.startTimeCache.set(pid, startTime);
    return startTime;
  }
}

/** Test-only liveness checker with deterministic answers. */
export class FakeProcessLiveness implements ProcessLiveness {
  private currentIdentity: ProcessIdentity;
  private answers = new Map<number, Liveness>();
  private startTimes = new Map<number, string | undefined>();

  constructor(currentIdentity: ProcessIdentity) {
    this.currentIdentity = currentIdentity;
  }

  setAnswer(pid: number, verdict: Liveness, liveStartTime?: string): void {
    this.answers.set(pid, verdict);
    this.startTimes.set(pid, liveStartTime);
  }

  async current(): Promise<ProcessIdentity> {
    return { ...this.currentIdentity };
  }

  async check(pid: number, recordStartTime?: string): Promise<Liveness> {
    if (pid === this.currentIdentity.pid) {
      return "live";
    }
    const answer = this.answers.get(pid);
    const recordedStart = this.startTimes.get(pid);
    if (recordStartTime !== undefined && recordedStart !== undefined) {
      return normalizeStartTime(recordedStart) === normalizeStartTime(recordStartTime)
        ? "live"
        : "dead";
    }
    return answer ?? "unknown";
  }
}