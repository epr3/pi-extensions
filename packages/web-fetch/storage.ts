// ─── Types ───────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DefaultProcessLiveness, type ProcessIdentity, type ProcessLiveness } from "./liveness.ts";

/**
 * Private extension-owned temporary area name. All downloads and Readable
 * artifacts live below `os.tmpdir()/<name>`, keyed by session, then run.
 */
export const ARTIFACT_AREA_NAME = "pi-web-fetch";

/** Readable artifact file kinds. */
export type ArtifactKind = "markdown" | "text";

/**
 * On-disk ownership record for one run directory.
 *
 * Kept for abandoned-run cleanup (ticket 0002): it records which session and
 * run created the files, which pid owned the run, and what was being written.
 */
export interface OwnerRecord {
  schema: 1;
  sessionId: string;
  runId: string;
  pid: number;
  /** ISO 8601 process start time for conservative PID-reuse detection. */
  pidStartTime?: string;
  createdAt: string;
  artifacts: { path: string; kind: ArtifactKind; complete: boolean }[];
  incomplete: string[];
}

/** Classification of an on-disk ownership record for cleanup decisions. */
type OwnerStatus = "live" | "abandoned" | "ambiguous";

/** Thrown when an in-flight call must stop because its owner left or was cancelled. */
export class AbandonedCallError extends Error {
  public readonly sessionId: string;
  public readonly runId: string;
  constructor(sessionId: string, runId: string, reason: string) {
    super(`web_fetch: abandoned call (${reason}) — no result published`);
    this.name = "AbandonedCallError";
    this.sessionId = sessionId;
    this.runId = runId;
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Sanitize an identity string for use as one path segment. */
function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Unique base name for a call's files (distinct across concurrent calls). */
function safeFileName(callId: string): string {
  return `${safeSegment(callId, "call")}-${randomUUID().slice(0, 8)}`;
}

/** Default extension-owned storage root: os.tmpdir()/pi-web-fetch. */
export function defaultStorageRoot(): string {
  return join(os.tmpdir(), ARTIFACT_AREA_NAME);
}

// ─── Sink writer (disk-backed download) ──────────────────────────────────────

/**
 * Writes response chunks to a download file, opening the handle lazily so a
 * call that fails before the first chunk leaves nothing behind.
 */
export class FileSink {
  private handle: FileHandle | undefined;
  constructor(private readonly path: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.handle) {
      this.handle = await open(this.path, "w");
    }
    await this.handle.write(chunk);
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
  }
}

// ─── Pending call ────────────────────────────────────────────────────────────

/**
 * One in-flight web_fetch call, bound to its creating run/session.
 *
 * A call can be abandoned (owner left) or cancelled (signal abort); both make
 * it defunct so late continuations cannot recreate files or publish artifact
 * paths into a different session.
 */
export class PendingCall {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  /** Per-call unique base used for download/artifact file names. */
  readonly baseName: string;
  readonly signal: AbortSignal | undefined;
  downloadPath: string | undefined;
  artifactPath: string | undefined;
  /** True once the artifact has been recorded as finalized in the ownership record. */
  artifactSettled = false;
  private abandoned = false;
  private abandonReason = "abandoned";
  private sink: FileSink | undefined;

  constructor(id: string, sessionId: string, runId: string, signal: AbortSignal | undefined) {
    this.id = id;
    this.sessionId = sessionId;
    this.runId = runId;
    this.baseName = safeFileName(id);
    this.signal = signal;
    this.abortController = new AbortController();
  }

  get defunct(): boolean {
    return this.abandoned;
  }

  private abortController: AbortController;

  /** Stop the call: no further writes or publication. */
  abandon(reason: string): void {
    this.abandoned = true;
    this.abandonReason = reason;
    this.abortController.abort();
  }

  attachSink(sink: FileSink): void {
    this.sink = sink;
  }

  async closeSink(): Promise<void> {
    if (this.sink) {
      await this.sink.close().catch(() => {});
      this.sink = undefined;
    }
  }

  assertActive(): void {
    if (this.abandoned) {
      throw new AbandonedCallError(this.sessionId, this.runId, this.abandonReason);
    }
    if (this.signal?.aborted || this.abortController.signal.aborted) {
      throw new DOMException("The web_fetch call was cancelled", "AbortError");
    }
  }

  /** Combined signal: caller signal plus call abandonment. */
  get combinedSignal(): AbortSignal {
    if (!this.signal) return this.abortController.signal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    this.abortController.signal.addEventListener("abort", onAbort, { once: true });
    if (this.signal.aborted || this.abortController.signal.aborted) {
      controller.abort();
    }
    return controller.signal;
  }
}

// ─── Session run ─────────────────────────────────────────────────────────────

/**
 * Files of one extension run for one session: a download temp dir plus the
 * finalized Readable artifacts, all under `<area>/<session>/<run>/`.
 *
 * A run directory may be recreated after a reload if the same session continues
 * under a fresh extension instance; `ensureDir` is idempotent and will rewrite
 * the ownership record. Crash/abandoned-run cleanup is ticket 0002.
 */
export class SessionRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly dir: string;
  readonly tmpDir: string;
  private record: OwnerRecord;
  private left = false;
  private liveness: ProcessLiveness;

  constructor(area: string, sessionId: string, runId: string, liveness: ProcessLiveness) {
    this.sessionId = sessionId;
    this.runId = runId;
    this.dir = join(area, safeSegment(sessionId, "session"), runId);
    this.tmpDir = join(this.dir, ".tmp");
    this.liveness = liveness;
    this.record = {
      schema: 1,
      sessionId,
      runId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      artifacts: [],
      incomplete: [],
    };
  }

  get recordPath(): string {
    return join(this.dir, "owner.json");
  }

  /** Create the run directory and persist the ownership record. */
  async ensureDir(): Promise<void> {
    if (this.left) {
      throw new AbandonedCallError(this.sessionId, this.runId, "run already left");
    }
    await mkdir(this.tmpDir, { recursive: true });
    const identity = await this.liveness.current();
    this.record.pidStartTime = identity.startTime;
    await this.persistRecord();
  }

  /** Tolerates a removed run dir: a left run must not be recreated. */
  private async persistRecord(): Promise<void> {
    if (this.left) return; // a left run must never recreate files
    try {
      const tmp = `${this.recordPath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.record, null, 2));
      await rename(tmp, this.recordPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /** Track a download file in the ownership record. */
  async registerDownload(path: string): Promise<void> {
    this.record.incomplete.push(path);
    await this.persistRecord();
  }

  /** Mark a download removed (raw download released after conversion). */
  async releaseDownload(path: string): Promise<void> {
    this.record.incomplete = this.record.incomplete.filter((p) => p !== path);
    await this.persistRecord();
    await rm(path, { force: true });
  }

  /** Forget a download path from the record (failure path); file removal is separate. */
  async forgetDownload(path: string): Promise<void> {
    this.record.incomplete = this.record.incomplete.filter((p) => p !== path);
    await this.persistRecord();
  }

  /** True when the run owns nothing useful (no artifacts, no pending downloads). */
  isEmpty(): boolean {
    return this.record.artifacts.length === 0 && this.record.incomplete.length === 0;
  }

  /** Record a finalized readable artifact. */
  async settleArtifact(path: string, kind: ArtifactKind, complete: boolean): Promise<void> {
    this.record.artifacts.push({ path, kind, complete });
    await this.persistRecord();
  }

  /** Abort every pending call of this run (owner left). */
  abandonCalls(): void {
    this.left = true;
  }

  get isLeft(): boolean {
    return this.left;
  }

  /** Remove this run's whole directory. Idempotent; tolerates missing files. */
  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

// ─── Artifact store ──────────────────────────────────────────────────────────

export interface CleanupErrorEntry {
  sessionId: string;
  error: Error;
}

/**
 * Session/run-owned storage for the extension instance.
 *
 * One store per extension load: it owns one run id for the process lifetime
 * and maps session ids to run directories. Deleting anything outside the
 * owned area is impossible by construction (paths always derive from `area`).
 */
export class ArtifactStore {
  readonly runId: string;
  readonly area: string;
  readonly liveness: ProcessLiveness;
  private runs = new Map<string, SessionRun>();
  private knownSessions = new Set<string>();
  private lastSessionId: string | undefined;
  private activeCalls = new Set<PendingCall>();
  /** Serializes run creation and session removal so a leave cannot race a
   *  pending mkdir/persist and a pending run cannot recreate removed files. */
  private lock: Promise<void> = Promise.resolve();

  /** Observable cleanup failures (test seam + diagnostics). */
  readonly cleanupErrors: CleanupErrorEntry[] = [];

  private initSweepPromise: Promise<void> | undefined;

  constructor(area?: string, liveness?: ProcessLiveness) {
    this.area = area ?? defaultStorageRoot();
    this.runId = randomUUID();
    this.liveness = liveness ?? new DefaultProcessLiveness();
    // Sweep once at extension init as an early opportunity to reclaim crash
    // leftovers. The first fetch also sweeps, so an init-sweep failure is
    // still retryable.
    this.initSweepPromise = this.sweepAbandoned().catch((err) => this.recordSweepError(err));
  }

  /** Test seam: await the init sweep started by the constructor. */
  async waitForInitSweep(): Promise<void> {
    if (this.initSweepPromise) {
      await this.initSweepPromise;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Remember a session as currently active. */
  observeSession(sessionId: string): void {
    if (sessionId) this.knownSessions.add(sessionId);
    if (sessionId) this.lastSessionId = sessionId;
  }

  /**
   * Begin a call in a session, creating (or reusing) that session's run.
   * The run directory is created lazily by `ensureRunDir`.
   *
   * This is serialized with session leave/reload so a call cannot be created
   * while the session is being abandoned. It also sweeps demonstrably
   * abandoned runs, making every fetch an opportunity to reclaim crash
   * leftovers.
   */
  async beginCall(
    sessionId: string,
    callId: string,
    signal: AbortSignal | undefined,
  ): Promise<PendingCall> {
    return this.withLock(async () => {
      // Wait for the init sweep once, then sweep again before creating work so
      // every fetch is an opportunity to reclaim abandoned runs.
      if (this.initSweepPromise) {
        await this.initSweepPromise;
        this.initSweepPromise = undefined;
      }
      await this.sweepAbandoned().catch((err) => this.recordSweepError(err));

      const key = sessionId || this.lastSessionId || `no-session-${this.runId}`;
      this.observeSession(key);
      let run = this.runs.get(key);
      // A left run (failed cleanup or reload) must not block fresh fetches in a
      // still-active session; start a fresh run directory for it.
      if (!run || run.isLeft) {
        run = new SessionRun(this.area, key, this.runId, this.liveness);
        this.runs.set(key, run);
      }
      const call = new PendingCall(callId, key, run.runId, signal);
      this.activeCalls.add(call);
      return call;
    });
  }

  /** Stop tracking a finished call (success, failure, or abandonment). */
  finishCall(call: PendingCall): void {
    this.activeCalls.delete(call);
  }

  /** Ensure `call`'s run directory exists; returns the run. */
  async ensureRunDir(call: PendingCall): Promise<SessionRun> {
    return this.withLock(async () => {
      const run = this.runs.get(call.sessionId);
      if (!run) throw new AbandonedCallError(call.sessionId, call.runId, "run missing");
      call.assertActive();
      await run.ensureDir();
      return run;
    });
  }

  /** Remove a downloaded temp file for a call once conversion released it. */
  async releaseDownload(call: PendingCall): Promise<void> {
    const run = this.runs.get(call.sessionId);
    if (!run || !call.downloadPath) return;
    await run.releaseDownload(call.downloadPath);
    call.downloadPath = undefined;
  }

  /** Record a finalized artifact for a call. */
  async settleArtifact(call: PendingCall, kind: ArtifactKind, complete: boolean): Promise<void> {
    const run = this.runs.get(call.sessionId);
    if (!run || !call.artifactPath) return;
    await run.settleArtifact(call.artifactPath, kind, complete);
    call.artifactSettled = true;
  }

  /**
   * Fail a call: close handles and remove its incomplete files. Never touches
   * other calls' files, so a failed concurrent call cannot harm a live one.
   * When this was the session's only remaining call and nothing useful was
   * finalized, the empty run directory (and its ownership record) is also
   * reclaimed.
   */
  async failCall(call: PendingCall): Promise<void> {
    await call.closeSink();
    const run = this.runs.get(call.sessionId);
    if (!run) return;
    if (call.downloadPath) {
      await run.forgetDownload(call.downloadPath).catch(() => {});
      await rm(call.downloadPath, { force: true }).catch(() => {});
    }
    // Only remove the artifact file if it was never finalized; a settled
    // artifact must remain available while its owner is active (e.g. when
    // releaseDownload or result composition fails after settleArtifact).
    if (call.artifactPath && !call.artifactSettled) {
      await rm(call.artifactPath, { force: true }).catch(() => {});
    }
    const othersActive = [...this.activeCalls].some(
      (c) => c !== call && c.sessionId === call.sessionId,
    );
    if (!othersActive && run.isEmpty()) {
      await run.cleanup().catch(() => {});
      if (this.runs.get(call.sessionId) === run) this.runs.delete(call.sessionId);
    }
  }

  /**
   * Abandon all pending work without removing files (used on reload: the
   * session continues, so its artifacts stay). No stale result may be
   * published afterwards.
   */
  abandonPending(): void {
    for (const call of this.activeCalls) {
      call.abandon("runtime reloaded");
    }
    for (const run of this.runs.values()) {
      run.abandonCalls();
    }
  }

  /** Absolute path of a session's owned area (guarded to stay inside it). */
  private sessionDir(sessionId: string): string {
    const dir = join(this.area, safeSegment(sessionId, "session"));
    const areaRoot = this.area.endsWith("/") ? this.area : `${this.area}/`;
    if (!dir.startsWith(areaRoot)) {
      throw new Error(`refusing path outside owned area: ${dir}`);
    }
    return dir;
  }

  /**
   * Leave a session: abandon its pending work, then remove the session's
   * whole owned directory (all runs of that session, including pre-reload
   * ones). Idempotent; removal failures are observable and keep the
   * ownership record on disk for the later retry/sweeping slice (ticket 0002).
   */
  async leaveSession(sessionId?: string): Promise<void> {
    await this.withLock(async () => {
      const targets =
        sessionId && this.knownSessions.has(sessionId) ? [sessionId] : [...this.knownSessions];
      for (const sid of targets) {
        const run = this.runs.get(sid);
        if (run) run.abandonCalls();
        for (const call of this.activeCalls) {
          if (call.sessionId === sid) call.abandon("owner left");
        }
        try {
          await rm(this.sessionDir(sid), { recursive: true, force: true });
          this.runs.delete(sid);
          this.knownSessions.delete(sid);
          if (this.lastSessionId === sid) this.lastSessionId = undefined;
        } catch (err) {
          const error = normalizeError(err);
          this.cleanupErrors.push({ sessionId: sid, error });
          // Ownership info stays on disk for the later retry/sweeping slice;
          // the next leave attempt retries the same directory.
          console.error(`web_fetch: artifact cleanup for session ${sid} failed: ${error.message}`);
        }
      }
    });
  }

  // ─── Crash/abandoned-run sweep ─────────────────────────────────────────────

  /**
   * Scan the extension-owned area for runs whose owning process is
   * demonstrably dead, and remove them. Runs owned by the current extension
   * instance, other live processes, or ambiguous owners are preserved.
   */
  private async sweepAbandoned(): Promise<void> {
    const current = await this.liveness.current();
    let sessionNames: string[];
    try {
      sessionNames = await readdir(this.area);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // storage area does not exist yet
      throw err;
    }

    for (const sessionName of sessionNames) {
      const sessionPath = join(this.area, sessionName);
      let runNames: string[];
      try {
        runNames = await readdir(sessionPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        throw err;
      }

      let anyPreserved = false;
      const abandonedRuns: string[] = [];
      for (const runName of runNames) {
        const runPath = join(sessionPath, runName);
        const status = await this.classifyRun(runPath, current);
        if (status === "abandoned") {
          abandonedRuns.push(runPath);
        } else {
          anyPreserved = true;
        }
      }

      for (const runPath of abandonedRuns) {
        try {
          await rm(runPath, { recursive: true, force: true });
        } catch (err) {
          const error = normalizeError(err);
          this.cleanupErrors.push({ sessionId: sessionName, error });
          console.error(`web_fetch: abandoned-run cleanup failed for ${runPath}: ${error.message}`);
          anyPreserved = true; // failed run still exists, so session is not empty
        }
      }

      // Only remove the session directory when every run inside it was
      // abandoned and successfully removed. This avoids deleting concurrent
      // live work or unknown/ambiguous directories.
      if (!anyPreserved) {
        try {
          await rm(sessionPath, { recursive: true, force: true });
        } catch (err) {
          const error = normalizeError(err);
          this.cleanupErrors.push({ sessionId: sessionName, error });
          console.error(
            `web_fetch: abandoned-session cleanup failed for ${sessionPath}: ${error.message}`,
          );
        }
      }
    }
  }

  private async classifyRun(runPath: string, current: ProcessIdentity): Promise<OwnerStatus> {
    const recordPath = join(runPath, "owner.json");
    let raw: string;
    try {
      raw = await readFile(recordPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A run directory without a readable ownership record may be brand-new
      // work from a concurrent process; preserve it rather than risk deletion.
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
        return "ambiguous";
      }
      throw err;
    }

    let record: OwnerRecord;
    try {
      record = JSON.parse(raw) as OwnerRecord;
    } catch {
      return "ambiguous";
    }

    // The current extension instance always owns runs created with its runId.
    if (record.runId === this.runId && record.pid === current.pid) {
      return "live";
    }

    // Same pid but a different runId means the owning extension instance is
    // gone (e.g. replaced/reloaded in the same process) — the run is abandoned.
    if (record.pid === current.pid) {
      return "abandoned";
    }

    // For remote pids, rely on the injected liveness checker. "unknown" is
    // treated as ambiguous and preserved; age alone never authorizes deletion.
    const verdict = await this.liveness.check(record.pid, record.pidStartTime);
    if (verdict === "dead") return "abandoned";
    if (verdict === "live") return "live";
    return "ambiguous";
  }

  private recordSweepError(err: unknown): void {
    const error = normalizeError(err);
    this.cleanupErrors.push({ sessionId: "__sweep__", error });
    console.error(`web_fetch: abandoned-run sweep failed: ${error.message}`);
  }
}

function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}