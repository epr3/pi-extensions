import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient } from "./client.ts";

export interface ServerDef {
  cmd: string;
  args?: string[];
  extensions: string[];
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  /** In-flight startup per language, so concurrent first requests share one server. */
  private starting = new Map<string, Promise<LspClient>>();
  private extIndex = new Map<string, string>();

  private servers: Record<string, ServerDef>;
  private rootPath: string;

  constructor(servers: Record<string, ServerDef>, rootPath: string) {
    this.servers = servers;
    this.rootPath = rootPath;
    for (const [langId, def] of Object.entries(servers)) {
      if (langId.startsWith("//")) continue;
      for (const ext of def.extensions ?? []) this.extIndex.set(ext, langId);
    }
  }

  langForFile(filePath: string): string | null {
    return this.extIndex.get(path.extname(filePath).toLowerCase()) ?? null;
  }

  async clientForFile(filePath: string): Promise<LspClient> {
    const langId = this.langForFile(filePath);
    if (!langId)
      throw new Error(
        `no language server configured for '${path.extname(filePath)}' files: ` +
          `no 'lsp.servers' entry owns this extension. Add or fix a mapping under 'lsp.servers' in ` +
          `settings.json, or fall back to grep-based tools for this file type.`,
      );
    const running = this.clients.get(langId);
    // A server that exited mid-session is discarded; the next tool call spawns it again.
    if (running) {
      if (running.running) return running;
      this.clients.delete(langId);
    }
    // Concurrent first requests share one startup instead of racing to spawn
    // duplicate servers — the client is cached only after initialize completes.
    const inFlight = this.starting.get(langId);
    if (inFlight) return inFlight;
    const startup = this.startServer(langId);
    this.starting.set(langId, startup);
    try {
      return await startup;
    } finally {
      this.starting.delete(langId);
    }
  }

  private async startServer(langId: string): Promise<LspClient> {
    const def = this.servers[langId]!;
    const client = new LspClient({
      cmd: def.cmd,
      args: def.args ?? [],
      languageId: langId,
      rootPath: this.rootPath,
    });
    try {
      await client.start();
    } catch (e) {
      // Failed startup leaves nothing cached: the next request retries cleanly
      // instead of reusing a client that never finished its handshake.
      await client.stop().catch(() => {});
      throw e;
    }
    this.clients.set(langId, client);
    return client;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }
}

const toLsp = (line: number, col: number) => ({
  line: Math.max(0, line - 1),
  character: Math.max(0, col - 1),
});
const arr = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

function resultKind(d: "incoming" | "outgoing"): "incomingCalls" | "outgoingCalls" {
  return d === "incoming" ? "incomingCalls" : "outgoingCalls";
}

async function locLabel(loc: any): Promise<{
  location: string;
  snippet: string;
  file: string;
  line: number;
  column: number;
}> {
  const uri = loc.uri ?? loc.targetUri;
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
  const fp = fileURLToPath(uri);
  const line0 = range.start.line;
  const col0 = range.start.character;
  let snippet = "";
  try {
    const text = await readFile(fp, "utf8");
    snippet = (text.split(/\r?\n/)[line0] ?? "").trim();
  } catch {
    /* virtual file */
  }
  return {
    location: `${path.relative(process.cwd(), fp)}:${line0 + 1}:${col0 + 1}`,
    snippet,
    file: path.relative(process.cwd(), fp),
    line: line0 + 1,
    column: col0 + 1,
  };
}

const SYMBOL_KINDS: Record<number, string> = {
  5: "class",
  6: "method",
  9: "constructor",
  11: "interface",
  12: "function",
  13: "variable",
  23: "struct",
};
const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

/** Which parameter shape a tool takes; index.ts maps this to a typebox schema. */
export type ParamKind = "pos" | "ref" | "file" | "query";

export interface LspArgs {
  file: string;
  line?: number;
  column?: number;
  includeDeclaration?: boolean;
  query?: string;
}

/** Cross-cutting semantic-navigation guidance shared by every lsp tool.
 * Pi's system prompt dedupes identical guideline strings, so each of these
 * appears once however many lsp tools are active in the session. */
export const SHARED_NAVIGATION_GUIDELINES = [
  // LSP-first preference, plus the permissions that keep it from blocking
  // basic orientation (locate a symbol/position first) and textual questions.
  "Try the appropriate lsp_* tool first for supported semantic navigation — " +
    "definitions, references, implementations, workspace symbols, document " +
    "outlines, hover info, and call relationships. Using grep, find, or read " +
    "to locate an identifier and its position first is fine; use them directly " +
    "for textual questions such as comments, strings, config values, logs, and " +
    "non-code files.",
  // Practical fallback + consequential uncertainty.
  "When an lsp_* tool reports an error, times out, the language server is " +
    "unavailable, or the answer is unhelpful, fall back to grep, find, or read — " +
    "and state uncertainty that matters to the task in your answer (for example, " +
    "that a more complete answer might exist later).",
  // Empty results are potentially inconclusive; verification is selective.
  "Empty lsp results are potentially inconclusive — the language server may " +
    "not cover the file or symbol. Verify with text search when completeness " +
    "matters or the result looks implausible, not automatically after every " +
    "empty result.",
];

/** A complete tool definition as data — the single source of truth for the
 * LSP tool set. index.ts iterates this to register; nothing is declared twice. */
export interface LspToolSpec {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  paramKind: ParamKind;
  run: (args: LspArgs) => Promise<string | { text: string; details: Record<string, unknown> }>;
}

export interface LspToolOptions {
  /** How long to wait after didOpen for the server to publish diagnostics. */
  diagnosticsDelayMs?: number;
}

export function lspToolSpecs(
  getManager: () => Promise<LspManager>,
  opts: LspToolOptions = {},
): LspToolSpec[] {
  const diagnosticsDelayMs = opts.diagnosticsDelayMs ?? 600;
  // Server failures (missing executable, exited server, protocol error,
  // timeout) are recoverable-with-fallback conditions, not crashes: they reach
  // the model as actionable text with the original structured result slot
  // empty, so the model can switch tools instead of blowing up the turn.
  const recoverable =
    (run: LspToolSpec["run"]): LspToolSpec["run"] =>
    async (args) => {
      try {
        return await run(args);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { text: message, details: { error: message } };
      }
    };
  const openAt = async (a: LspArgs) => {
    const manager = await getManager();
    const client = await manager.clientForFile(a.file);
    const uri = await client.ensureOpen(a.file);
    return { client, uri };
  };

  const callHierarchy = async (
    a: LspArgs,
    direction: "incoming" | "outgoing",
  ): Promise<string | { text: string; details: Record<string, unknown> }> => {
    const { client, uri } = await openAt(a);
    const { line, character } = toLsp(a.line!, a.column!);
    const items = arr(await client.prepareCallHierarchy(uri, line, character));
    if (!items.length)
      return {
        text: "no callable symbol at that position",
        details: { resultKind: resultKind(direction), calls: [] },
      };
    const calls = arr(
      direction === "incoming"
        ? await client.incomingCalls(items[0])
        : await client.outgoingCalls(items[0]),
    );
    if (!calls.length) {
      const text = direction === "incoming" ? "no callers found" : "no outgoing calls found";
      return { text, details: { resultKind: resultKind(direction), calls: [] } };
    }
    const out = await Promise.all(
      calls.map(async (c: any) => {
        const item = c.from ?? c.to;
        const {
          location,
          file,
          line: itemLine,
          column,
        } = await locLabel({
          uri: item.uri,
          range: item.selectionRange ?? item.range,
        });
        const kind = SYMBOL_KINDS[item.kind] ?? "symbol";
        return {
          text: `${kind} ${item.name}  ${location}`,
          record: { kind, name: item.name, file, line: itemLine, column },
        };
      }),
    );
    return {
      text: out.map((o) => o.text).join("\n"),
      details: { resultKind: resultKind(direction), calls: out.map((o) => o.record) },
    };
  };

  // Each tool's own guideline states what it is preferred over; the shared
  // guidelines add the cross-tool preference, fallback, and empty-result
  // contract. Keeping this a return-boundary wrapper keeps the catalog literal
  // unchanged.
  const specs: LspToolSpec[] = [
    {
      name: "lsp_definition",
      label: "LSP Definition",
      description:
        "Go to the definition of the symbol at file:line:column (1-based). Prefer over grep for typed languages.",
      promptSnippet: "Find the definition of a symbol via the language server",
      promptGuidelines: [
        "Try lsp_definition first instead of grep to find where a symbol is defined in a typed language.",
      ],
      paramKind: "pos",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const out = await Promise.all(
          arr(await client.definition(uri, line, character)).map(locLabel),
        );
        if (!out.length) {
          return {
            text: "no definition found",
            details: { resultKind: "definition", locations: [] },
          };
        }
        return {
          text: out.map((o) => `${o.location}  ${o.snippet}`).join("\n"),
          details: {
            resultKind: "definition",
            locations: out.map((o) => ({
              file: o.file,
              line: o.line,
              column: o.column,
              snippet: o.snippet,
            })),
          },
        };
      },
    },
    {
      name: "lsp_references",
      label: "LSP References",
      description:
        "Find all references to the symbol at file:line:column (1-based). Prefer over grep for usages, and run it before renaming or changing a signature.",
      promptSnippet: "Find all references to a symbol via the language server",
      promptGuidelines: [
        "Try lsp_references first instead of grep to find all usages of a symbol in a typed language, and to assess affected code before a rename or signature change.",
      ],
      paramKind: "ref",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const out = await Promise.all(
          arr(await client.references(uri, line, character, a.includeDeclaration ?? true)).map(
            locLabel,
          ),
        );
        if (!out.length) {
          return {
            text: "no references found",
            details: { resultKind: "references", locations: [] },
          };
        }
        return {
          text: out.map((o) => `${o.location}  ${o.snippet}`).join("\n"),
          details: {
            resultKind: "references",
            locations: out.map((o) => ({
              file: o.file,
              line: o.line,
              column: o.column,
              snippet: o.snippet,
            })),
          },
        };
      },
    },
    {
      name: "lsp_hover",
      label: "LSP Hover",
      description:
        "Type / signature / doc for the symbol at file:line:column (1-based). Prefer over reading the file to infer a symbol's type.",
      promptSnippet: "Get type, signature, or documentation for a symbol via the language server",
      promptGuidelines: [
        "Try lsp_hover first to inspect a symbol's type, signature, or docs instead of reading the file to infer them.",
      ],
      paramKind: "pos",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const res: any = await client.hover(uri, line, character);
        if (!res || !res.contents) {
          return {
            text: "no hover info",
            details: { resultKind: "hover" as const, hover: { found: false } },
          };
        }
        const c = res.contents;
        let content: string;
        if (typeof c === "string") {
          content = c;
        } else if (Array.isArray(c)) {
          content = c.map((x: any) => (typeof x === "string" ? x : x.value)).join("\n");
        } else {
          content = c.value ?? "no hover info";
        }
        if (!content || content === "no hover info") {
          return {
            text: content,
            details: { resultKind: "hover" as const, hover: { found: false } },
          };
        }
        return {
          text: content,
          details: { resultKind: "hover" as const, hover: { found: true, content } },
        };
      },
    },
    {
      name: "lsp_document_symbols",
      label: "LSP Symbols",
      description:
        "Outline of a file: classes, functions, methods, with line numbers. Prefer over reading the whole file to orient.",
      promptSnippet: "List the symbols in a file via the language server",
      promptGuidelines: [
        "Try lsp_document_symbols first to get an outline of a file before reading the whole thing.",
      ],
      paramKind: "file",
      async run(a) {
        const { client, uri } = await openAt(a);
        const flat: string[] = [];
        const walk = (
          sym: any,
          depth = 0,
        ): { name: string; kind: string; line: number; children?: any[] } | null => {
          const range = sym.selectionRange ?? sym.range ?? sym.location?.range;
          if (!range) return null;
          const ln = range.start.line + 1;
          const kind = SYMBOL_KINDS[sym.kind] ?? "symbol";
          flat.push(`${"  ".repeat(depth)}${kind} ${sym.name}  (line ${ln})`);
          const children = (sym.children ?? [])
            .map((ch: any) => walk(ch, depth + 1))
            .filter(Boolean);
          const record: any = { name: sym.name, kind, line: ln };
          if (children.length) record.children = children;
          return record;
        };
        const symbols = arr(await client.documentSymbols(uri))
          .map((s) => walk(s, 0))
          .filter(Boolean);
        if (!symbols.length)
          return {
            text: "no symbols",
            details: { resultKind: "documentSymbols" as const, symbols: [] },
          };
        return {
          text: flat.join("\n"),
          details: { resultKind: "documentSymbols" as const, symbols },
        };
      },
    },
    {
      name: "lsp_implementation",
      label: "LSP Implementation",
      description:
        "Concrete implementations of the interface/abstract symbol at file:line:column (1-based) — where definition gives the declaration, this gives the code that runs. Prefer over grepping for implementors.",
      promptSnippet:
        "Find concrete implementations of an interface/abstract symbol via the language server",
      promptGuidelines: [
        "Try lsp_implementation first instead of grep to find concrete implementations in a typed language.",
      ],
      paramKind: "pos",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const out = await Promise.all(
          arr(await client.implementation(uri, line, character)).map(locLabel),
        );
        if (!out.length) {
          return {
            text: "no implementations found",
            details: { resultKind: "implementation", locations: [] },
          };
        }
        return {
          text: out.map((o) => `${o.location}  ${o.snippet}`).join("\n"),
          details: {
            resultKind: "implementation",
            locations: out.map((o) => ({
              file: o.file,
              line: o.line,
              column: o.column,
              snippet: o.snippet,
            })),
          },
        };
      },
    },
    {
      name: "lsp_workspace_symbols",
      label: "LSP Workspace Symbols",
      description:
        "Find where something is defined by name across the whole workspace, without knowing the file. Prefer over grepping for the name. `file` is any file of the target language (routes to the right server).",
      promptSnippet: "Find a symbol by name across the workspace",
      promptGuidelines: [
        "Use lsp_workspace_symbols to locate a symbol by name when you don't know which file defines it, instead of grepping.",
      ],
      paramKind: "query",
      async run(a) {
        const { client } = await openAt(a);
        const results = arr(await client.workspaceSymbols(a.query!));
        const out = await Promise.all(
          results.slice(0, 30).map(async (sym: any) => {
            const loc = sym.location ?? sym;
            const fp = fileURLToPath(loc.uri);
            const line0 = loc.range?.start.line ?? 0;
            const file = path.relative(process.cwd(), fp);
            const line = line0 + 1;
            const kind = SYMBOL_KINDS[sym.kind] ?? "symbol";
            return {
              text: `${kind} ${sym.name}  ${file}:${line}`,
              record: { name: sym.name, kind, line },
            };
          }),
        );
        const records = out.map((o) => o.record);
        if (!records.length)
          return {
            text: "no symbols found",
            details: { resultKind: "workspaceSymbols" as const, symbols: [] },
          };
        return {
          text: out.map((o) => o.text).join("\n"),
          details: { resultKind: "workspaceSymbols" as const, symbols: records },
        };
      },
    },
    {
      name: "lsp_incoming_calls",
      label: "LSP Incoming Calls",
      description:
        "Call hierarchy: who calls the function at file:line:column (1-based). Prefer over grepping for callers, which over-matches common names.",
      promptSnippet: "Find callers of a function via the language server",
      promptGuidelines: [
        "Try lsp_incoming_calls first to see who calls a function in a typed language.",
      ],
      paramKind: "pos",
      async run(a) {
        return callHierarchy(a, "incoming");
      },
    },
    {
      name: "lsp_outgoing_calls",
      label: "LSP Outgoing Calls",
      description:
        "Call hierarchy: what the function at file:line:column (1-based) calls. Prefer over grepping for use sites.",
      promptSnippet: "Find functions called by a function via the language server",
      promptGuidelines: [
        "Try lsp_outgoing_calls first to see what a function calls in a typed language.",
      ],
      paramKind: "pos",
      async run(a) {
        return callHierarchy(a, "outgoing");
      },
    },
    {
      name: "lsp_diagnostics",
      label: "LSP Diagnostics",
      description:
        "Compiler/linter diagnostics for a file, with a confidence state: only `current` diagnostics \u2014 version-correlated with the file's saved contents \u2014 are conclusive. `pending` (the server has not published yet) and `uncertain` (freshness could not be established) results say nothing about whether the file is clean. Prefer over guessing whether a file compiles.",
      promptSnippet: "Get compiler/linter diagnostics for a file, with a confidence state",
      promptGuidelines: [
        "Use lsp_diagnostics to verify a file compiles cleanly after edits, instead of guessing.",
        "Read the confidence lsp_diagnostics reports before trusting the result: only `current` is conclusive, while `pending` (nothing published yet) and `uncertain` (freshness not established) are not evidence the file is clean \u2014 re-run after saving when cleanliness matters.",
      ],
      paramKind: "file",
      async run(a) {
        const { client, uri } = await openAt(a);
        // Bounded budget — a timeout is never proof of current diagnostics.
        // A publish for an older document version does not end the wait: keep
        // looking for one correlated with the current version until it arrives
        // or the budget expires, then report the state. A publish with no
        // version at all ends the wait, since that server cannot correlate.
        await client.waitForDiagnostics(uri, diagnosticsDelayMs);
        const { state, diagnostics: raw, sinceVersion } = client.getDiagnostics(uri);
        const toRecord = (d: any) => ({
          severity: (SEVERITY[d.severity] ?? "info") as "error" | "warning" | "info" | "hint",
          message: d.message,
          file: a.file,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
        });
        if (state === "pending")
          return {
            text:
              `diagnostics not available yet — the language server has not published ` +
              `diagnostics for this file since it was opened (waited ${diagnosticsDelayMs}ms); ` +
              `an empty result here is NOT evidence the file is clean`,
            details: {
              resultKind: "diagnostics" as const,
              confidence: "pending" as const,
              diagnostics: [],
              sinceVersion: null,
            },
          };
        if (!raw.length && state === "current")
          // The server published an empty set for the current version.
          return {
            text: "no diagnostics",
            details: {
              resultKind: "diagnostics" as const,
              confidence: "current" as const,
              diagnostics: [],
              sinceVersion,
            },
          };
        if (!raw.length)
          return {
            text:
              `the language server reported no diagnostics, but freshness could not be ` +
              `established (no document version correlated with the latest saved contents) — ` +
              `the file may not be clean`,
            details: {
              resultKind: "diagnostics" as const,
              confidence: "uncertain" as const,
              diagnostics: [],
              sinceVersion,
            },
          };
        const diags = raw.map(toRecord);
        const lines = diags
          .map((d: any) => `${d.severity} ${d.file}:${d.line}:${d.column}  ${d.message}`)
          .join("\n");
        const note =
          state === "uncertain"
            ? "\nNote: freshness could not be established (no document version correlated with " +
              "the latest saved contents) — these diagnostics may not reflect the latest saved contents."
            : "";
        return {
          text: lines + note,
          details: {
            resultKind: "diagnostics" as const,
            confidence: state,
            diagnostics: diags,
            sinceVersion,
          },
        };
      },
    },
  ];
  return specs.map((spec) => ({
    ...spec,
    promptGuidelines: [...(spec.promptGuidelines ?? []), ...SHARED_NAVIGATION_GUIDELINES],
    run: recoverable(spec.run),
  }));
}