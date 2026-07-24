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
    if (!langId) throw new Error(`no language server configured for ${path.extname(filePath)}`);
    let client = this.clients.get(langId);
    if (!client) {
      const def = this.servers[langId]!;
      client = new LspClient({
        cmd: def.cmd,
        args: def.args ?? [],
        languageId: langId,
        rootPath: this.rootPath,
      });
      await client.start();
      this.clients.set(langId, client);
    }
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
  const openAt = async (a: LspArgs) => {
    const manager = await getManager();
    const client = await manager.clientForFile(a.file);
    const uri = await client.ensureOpen(a.file);
    return { client, uri };
  };

  const resultKind = (d: "incoming" | "outgoing") =>
    d === "incoming" ? ("incomingCalls" as const) : ("outgoingCalls" as const);

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
        const { location, file, line, column } = await locLabel({
          uri: item.uri,
          range: item.selectionRange ?? item.range,
        });
        const kind = SYMBOL_KINDS[item.kind] ?? "symbol";
        return {
          text: `${kind} ${item.name}  ${location}`,
          record: { kind, name: item.name, file, line, column },
        };
      }),
    );
    return {
      text: out.map((o) => o.text).join("\n"),
      details: { resultKind: resultKind(direction), calls: out.map((o) => o.record) },
    };
  };

  return [
    {
      name: "lsp_definition",
      label: "LSP Definition",
      description:
        "Go to the definition of the symbol at file:line:column (1-based). Prefer over grep for typed languages.",
      promptSnippet: "Find the definition of a symbol via the language server",
      promptGuidelines: [
        "Use lsp_definition instead of grep to find where a symbol is defined in a typed language.",
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
      description: "Find all references to the symbol at file:line:column (1-based).",
      promptSnippet: "Find all references to a symbol via the language server",
      promptGuidelines: [
        "Use lsp_references instead of grep to find all call sites of a symbol in a typed language.",
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
      description: "Type / signature / doc for the symbol at file:line:column (1-based).",
      promptSnippet: "Get type, signature, or documentation for a symbol via the language server",
      promptGuidelines: [
        "Use lsp_hover to inspect a symbol's type, signature, or docs without opening the file.",
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
      description: "Outline of a file: classes, functions, methods, with line numbers.",
      promptSnippet: "List the symbols in a file via the language server",
      promptGuidelines: [
        "Use lsp_document_symbols to get an outline of a file before reading the whole thing.",
      ],
      paramKind: "file",
      async run(a) {
        const { client, uri } = await openAt(a);
        const flat: string[] = [];
        const records: Array<{ name: string; kind: string; line: number; children?: any[] }> = [];
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
        "Concrete implementations of the interface/abstract symbol at file:line:column (1-based) — where definition gives the declaration, this gives the code that runs.",
      promptSnippet:
        "Find concrete implementations of an interface/abstract symbol via the language server",
      promptGuidelines: [
        "Use lsp_implementation instead of grep to find concrete implementations in a typed language.",
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
        "Find where something is defined by name across the whole workspace, without knowing the file. `file` is any file of the target language (routes to the right server).",
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
      description: "Call hierarchy: who calls the function at file:line:column (1-based).",
      promptSnippet: "Find callers of a function via the language server",
      promptGuidelines: ["Use lsp_incoming_calls to see who calls a function in a typed language."],
      paramKind: "pos",
      async run(a) {
        return callHierarchy(a, "incoming");
      },
    },
    {
      name: "lsp_outgoing_calls",
      label: "LSP Outgoing Calls",
      description: "Call hierarchy: what the function at file:line:column (1-based) calls.",
      promptSnippet: "Find functions called by a function via the language server",
      promptGuidelines: [
        "Use lsp_outgoing_calls to see what a function calls in a typed language.",
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
        "Compiler/linter diagnostics for a file \u2014 ground-truth errors and warnings.",
      promptSnippet: "Get compiler/linter diagnostics for a file",
      promptGuidelines: [
        "Use lsp_diagnostics to verify a file compiles cleanly after edits, instead of guessing.",
      ],
      paramKind: "file",
      async run(a) {
        const { client, uri } = await openAt(a);
        await new Promise((r) => setTimeout(r, diagnosticsDelayMs)); // diagnostics arrive async after didOpen
        const raw = client.getDiagnostics(uri);
        if (!raw.length)
          return {
            text: "no diagnostics",
            details: { resultKind: "diagnostics" as const, diagnostics: [] },
          };
        const diags = raw.map((d: any) => ({
          severity: (SEVERITY[d.severity] ?? "info") as "error" | "warning" | "info" | "hint",
          message: d.message,
          file: a.file,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
        }));
        return {
          text: diags
            .map((d: any) => `${d.severity} ${d.file}:${d.line}:${d.column}  ${d.message}`)
            .join("\n"),
          details: { resultKind: "diagnostics" as const, diagnostics: diags },
        };
      },
    },
  ];
}