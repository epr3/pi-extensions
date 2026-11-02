// Minimal, dependency-free LSP client over stdio. Implements initialize,
// Content-Length framing, request/response correlation, notifications, and a
// per-file diagnostics cache. LSP positions are zero-based; the tool layer
// converts from 1-based line/column.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function statOrUndefined(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface LspClientOptions {
  cmd: string;
  args?: string[];
  languageId: string;
  rootPath: string;
}

// ─── Diagnostics confidence (ticket 0002) ──────────────────────────────────

/** How the last published diagnostics relate to the opened document state. */
export type DiagnosticsConfidence = "pending" | "current" | "uncertain";

/**
 * Confidence-tagged diagnostics for one document, derived from version
 * correlation — never from elapsed time.
 *
 * - `"pending"`: the Language server has not published diagnostics for the
 *   document at all since it was last opened or synchronized with the latest
 *   saved contents. An empty result is NOT evidence the file is clean.
 * - `"current"`: the server published diagnostics whose document version
 *   matches the version opened/synchronized here; an empty set may be
 *   reported as a clean file.
 * - `"uncertain"`: publishes exist but cannot be correlated with the latest
 *   saved contents (the server omitted `version`, or published for an older
 *   version). Diagnostics may be shown, but the file is never confirmed clean.
 */
export interface DiagnosticsStatus {
  state: DiagnosticsConfidence;
  diagnostics: any[];
  /** Document version the published diagnostics correspond to, if correlated or attached; null when unknown. */
  sinceVersion: number | null;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  /** Last `textDocument/publishDiagnostics` state per document. */
  private publishState = new Map<string, { diagnostics: any[]; version: number | null }>();
  /** Publish waiters per document, resolved whenever a publish arrives. */
  private diagWaiters = new Map<string, Set<() => void>>();
  private openDocs = new Set<string>();
  /** Monotonically increasing version per opened document, for didOpen/didChange. */
  private versions = new Map<string, number>();
  /** Last-seen on-disk state of opened documents, for saved-edit freshness. */
  private onDisk = new Map<string, { text: string; mtimeMs: number | null; size: number | null }>();
  private buffer = Buffer.alloc(0);
  /** Reject hook for the `initialize` request that {@link start} awaits. */
  private startReject: ((e: Error) => void) | null = null;

  private opts: LspClientOptions;

  constructor(opts: LspClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const failure = new Promise<never>((_, reject) => {
      this.startReject = reject;
    });
    const proc = spawn(this.opts.cmd, this.opts.args ?? [], {
      cwd: this.opts.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc as ChildProcessWithoutNullStreams;
    proc.stdout.on("data", (c: Buffer) => this.onData(c));
    proc.stderr.on("data", () => {});
    // The child never started (e.g. ENOENT): stdin writes would error async on
    // the pipe; swallow them — pending requests are rejected below instead.
    proc.stdin.on("error", () => {});
    proc.on("error", (err: NodeJS.ErrnoException) => this.onProcError(err));
    proc.on("exit", (code) => {
      this.failPending(new Error(`language server '${this.opts.cmd}' exited (${code})`));
    });

    try {
      const rootUri = pathToFileURL(this.opts.rootPath).href;
      await Promise.race([
        this.request("initialize", {
          processId: process.pid,
          rootUri,
          capabilities: {
            textDocument: {
              definition: {},
              implementation: {},
              references: {},
              hover: { contentFormat: ["plaintext", "markdown"] },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              callHierarchy: {},
              publishDiagnostics: {},
            },
            workspace: { symbol: {} },
          },
          workspaceFolders: [{ uri: rootUri, name: "root" }],
        }),
        failure,
      ]);
      this.notify("initialized", {});
    } catch (e) {
      this.proc = null;
      throw e;
    } finally {
      this.startReject = null;
    }
  }

  /** True while the server process is up (initialize handshake included). */
  get running(): boolean {
    return this.proc !== null;
  }

  private onProcError(err: NodeJS.ErrnoException): void {
    const message =
      err.code === "ENOENT"
        ? `language server '${this.opts.cmd}' (${this.opts.languageId}) failed to start: command not found (ENOENT). Install '${this.opts.cmd}' on PATH or fix the 'lsp.servers' entry for '${this.opts.languageId}' in settings, then retry.`
        : `language server '${this.opts.cmd}' (${this.opts.languageId}) process error (${err.code ?? "unknown"}): ${err.message}. Check the 'lsp.servers' entry for '${this.opts.languageId}' in settings.`;
    this.failPending(new Error(message));
    // Reject the in-flight initialize await, if start() is still running.
    this.startReject?.(new Error(message));
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // State from the dead process is meaningless to a respawned one; clearing
    // openDocs makes the next ensureOpen re-send didOpen to the fresh server.
    this.openDocs.clear();
    this.diagnostics.clear();
    this.proc = null;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      /* ignore */
    }
    this.proc.kill();
    this.proc = null;
  }

  /**
   * Open the document with the language server, or resynchronize it if it was
   * opened earlier and the saved on-disk contents have changed since.
   *
   * Freshness boundary: only saved on-disk content is visible here. Unsaved
   * in-editor buffers live in the editor and are outside this client's view —
   * callers must save the file before expecting navigation to see the edit.
   */
  async ensureOpen(filePath: string): Promise<string> {
    const uri = pathToFileURL(filePath).href;
    if (this.openDocs.has(uri)) {
      const prev = this.onDisk.get(uri)!;
      const fileStat = await statOrUndefined(filePath);
      if (!fileStat || fileStat.mtimeMs !== prev.mtimeMs || fileStat.size !== prev.size) {
        // Stat diverged from last time; only a content difference warrants a didChange.
        const text = (await readFile(filePath, "utf8").catch(() => prev.text)) ?? prev.text;
        if (text !== prev.text) {
          const version = (this.versions.get(uri) ?? 1) + 1;
          this.versions.set(uri, version);
          // Any previously published diagnostics predate the synchronization.
          this.publishState.delete(uri);
          this.notify("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text }],
          });
        }
        this.onDisk.set(uri, {
          text,
          mtimeMs: fileStat?.mtimeMs ?? null,
          size: fileStat?.size ?? null,
        });
      }
      return uri;
    }
    const text = await readFile(filePath, "utf8");
    this.openDocs.add(uri);
    this.versions.set(uri, 1);
    const fileStat = await statOrUndefined(filePath);
    this.onDisk.set(uri, {
      text,
      mtimeMs: fileStat?.mtimeMs ?? null,
      size: fileStat?.size ?? null,
    });
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: this.opts.languageId, version: 1, text },
    });
    return uri;
  }

  // ─── Diagnostics confidence (ticket 0002) ────────────────────────────────

  /**
   * Confidence-tagged view of the diagnostics published for a document after
   * the last open/saved-file synchronization.
   *
   * State is derived from version correlation with the opened document
   * version, never from elapsed time. Use waitForDiagnostics() to bound the
   * wait for a server response.
   */
  getDiagnostics(uri: string): DiagnosticsStatus {
    const pub = this.publishState.get(uri);
    if (!pub) return { state: "pending", diagnostics: [], sinceVersion: null };
    const docVersion = this.versions.get(uri);
    if (pub.version === null || pub.version !== docVersion) {
      return { state: "uncertain", diagnostics: pub.diagnostics, sinceVersion: pub.version };
    }
    return { state: "current", diagnostics: pub.diagnostics, sinceVersion: docVersion! };
  }

  /**
   * Wait up to `budgetMs` for the server to publish diagnostics that answer
   * the document's current state, resolving early when one arrives. The
   * budget is only a timeout, never evidence of a current result: after the
   * wait, callers must read getDiagnostics() and honor its state — a publish
   * may still be pending or unverifiable (unversioned server).
   */
  async waitForDiagnostics(uri: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    for (;;) {
      if (this.getDiagnostics(uri).state !== "pending") return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        // Publishing resolves early and cancels the timeout; timeout expiry
        // removes itself from the waiter set.
        const waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.diagWaiters.get(uri)?.delete(waiter);
          resolve();
        }, remaining);
        this.diagWaiters.set(uri, (this.diagWaiters.get(uri) ?? new Set()).add(waiter));
      });
    }
  }

  definition(uri: string, line: number, character: number) {
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }
  references(uri: string, line: number, character: number, includeDeclaration = true) {
    return this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
  }
  hover(uri: string, line: number, character: number) {
    return this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }
  documentSymbols(uri: string) {
    return this.request("textDocument/documentSymbol", { textDocument: { uri } });
  }
  implementation(uri: string, line: number, character: number) {
    return this.request("textDocument/implementation", {
      textDocument: { uri },
      position: { line, character },
    });
  }
  workspaceSymbols(query: string) {
    return this.request("workspace/symbol", { query });
  }
  prepareCallHierarchy(uri: string, line: number, character: number) {
    return this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position: { line, character },
    });
  }
  incomingCalls(item: unknown) {
    return this.request("callHierarchy/incomingCalls", { item });
  }
  outgoingCalls(item: unknown) {
    return this.request("callHierarchy/outgoingCalls", { item });
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          if (p.timer) clearTimeout(p.timer);
          reject(new Error(`LSP request '${method}' timed out`));
        }
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(obj: unknown): void {
    if (!this.proc)
      throw new Error(
        `language server '${this.opts.cmd}' is not running (it may have exited); the next tool call spawns it again`,
      );
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1]!, 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        /* ignore malformed */
      }
    }
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "LSP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const { uri } = msg.params;
      if (this.openDocs.has(uri)) {
        this.publishState.set(uri, {
          diagnostics: msg.params.diagnostics ?? [],
          version: msg.params.version ?? null,
        });
        this.resolveDiagWaiters(uri);
      }
      return;
    }
    // Answer server-initiated requests minimally so it doesn't stall.
    if (msg.id !== undefined && msg.method) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }

  private resolveDiagWaiters(uri: string): void {
    const set = this.diagWaiters.get(uri);
    if (!set) return;
    this.diagWaiters.set(uri, new Set());
    for (const resolve of set) resolve();
  }
}