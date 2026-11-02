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
}

export interface LspClientOptions {
  cmd: string;
  args?: string[];
  languageId: string;
  rootPath: string;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private diagnostics = new Map<string, any[]>();
  private openDocs = new Set<string>();
  /** Monotonically increasing version per opened document, for didOpen/didChange. */
  private versions = new Map<string, number>();
  /** Last-seen on-disk state of opened documents, for saved-edit freshness. */
  private onDisk = new Map<string, { text: string; mtimeMs: number | null; size: number | null }>();
  private buffer = Buffer.alloc(0);

  private opts: LspClientOptions;

  constructor(opts: LspClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(this.opts.cmd, this.opts.args ?? [], {
      cwd: this.opts.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (c: Buffer) => this.onData(c));
    this.proc.stderr.on("data", () => {});
    this.proc.on("exit", (code) => {
      for (const { reject } of this.pending.values())
        reject(new Error(`language server exited (${code})`));
      this.pending.clear();
      this.proc = null;
    });

    const rootUri = pathToFileURL(this.opts.rootPath).href;
    await this.request("initialize", {
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
    });
    this.notify("initialized", {});
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

  getDiagnostics(uri: string): any[] {
    return this.diagnostics.get(uri) ?? [];
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
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request '${method}' timed out`));
        }
      }, 20000);
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(obj: unknown): void {
    if (!this.proc) throw new Error("language server not running");
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
      if (msg.error) p.reject(new Error(msg.error.message || "LSP error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
      return;
    }
    // Answer server-initiated requests minimally so it doesn't stall.
    if (msg.id !== undefined && msg.method) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
}