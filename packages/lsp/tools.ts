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
      client = new LspClient({ cmd: def.cmd, args: def.args ?? [], languageId: langId, rootPath: this.rootPath });
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

const toLsp = (line: number, col: number) => ({ line: Math.max(0, line - 1), character: Math.max(0, col - 1) });
const arr = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

async function locLabel(loc: any): Promise<{ location: string; snippet: string }> {
  const uri = loc.uri ?? loc.targetUri;
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
  const fp = fileURLToPath(uri);
  const line0 = range.start.line;
  let snippet = "";
  try {
    const text = await readFile(fp, "utf8");
    snippet = (text.split(/\r?\n/)[line0] ?? "").trim();
  } catch {
    /* virtual file */
  }
  return { location: `${path.relative(process.cwd(), fp)}:${line0 + 1}:${range.start.character + 1}`, snippet };
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
  run: (args: LspArgs) => Promise<string>;
}

export interface LspToolOptions {
  /** How long to wait after didOpen for the server to publish diagnostics. */
  diagnosticsDelayMs?: number;
}

export function lspToolSpecs(getManager: () => Promise<LspManager>, opts: LspToolOptions = {}): LspToolSpec[] {
  const diagnosticsDelayMs = opts.diagnosticsDelayMs ?? 600;
  const openAt = async (a: LspArgs) => {
    const manager = await getManager();
    const client = await manager.clientForFile(a.file);
    const uri = await client.ensureOpen(a.file);
    return { client, uri };
  };

  const callHierarchy = async (a: LspArgs, direction: "incoming" | "outgoing"): Promise<string> => {
    const { client, uri } = await openAt(a);
    const { line, character } = toLsp(a.line!, a.column!);
    const items = arr(await client.prepareCallHierarchy(uri, line, character));
    if (!items.length) return "no callable symbol at that position";
    const calls = arr(
      direction === "incoming" ? await client.incomingCalls(items[0]) : await client.outgoingCalls(items[0]),
    );
    if (!calls.length) return direction === "incoming" ? "no callers found" : "no outgoing calls found";
    const out = await Promise.all(
      calls.map(async (c: any) => {
        const item = c.from ?? c.to;
        const { location } = await locLabel({ uri: item.uri, range: item.selectionRange ?? item.range });
        return `${SYMBOL_KINDS[item.kind] ?? "symbol"} ${item.name}  ${location}`;
      }),
    );
    return out.join("\n");
  };

  return [
    {
      name: "lsp_definition",
      label: "LSP Definition",
      description: "Go to the definition of the symbol at file:line:column (1-based). Prefer over grep for typed languages.",
      promptSnippet: "Find the definition of a symbol via the language server",
      promptGuidelines: ["Use lsp_definition instead of grep to find where a symbol is defined in a typed language."],
      paramKind: "pos",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const out = await Promise.all(arr(await client.definition(uri, line, character)).map(locLabel));
        return out.length ? out.map((o) => `${o.location}  ${o.snippet}`).join("\n") : "no definition found";
      },
    },
    {
      name: "lsp_references",
      label: "LSP References",
      description: "Find all references to the symbol at file:line:column (1-based).",
      promptSnippet: "Find all references to a symbol via the language server",
      promptGuidelines: ["Use lsp_references instead of grep to find all call sites of a symbol in a typed language."],
      paramKind: "ref",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const out = await Promise.all(arr(await client.references(uri, line, character, a.includeDeclaration ?? true)).map(locLabel));
        return out.length ? out.map((o) => `${o.location}  ${o.snippet}`).join("\n") : "no references found";
      },
    },
    {
      name: "lsp_hover",
      label: "LSP Hover",
      description: "Type / signature / doc for the symbol at file:line:column (1-based).",
      paramKind: "pos",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const res: any = await client.hover(uri, line, character);
        if (!res || !res.contents) return "no hover info";
        const c = res.contents;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((x: any) => (typeof x === "string" ? x : x.value)).join("\n");
        return c.value ?? "no hover info";
      },
    },
    {
      name: "lsp_document_symbols",
      label: "LSP Symbols",
      description: "Outline of a file: classes, functions, methods, with line numbers.",
      paramKind: "file",
      async run(a) {
        const { client, uri } = await openAt(a);
        const flat: string[] = [];
        const walk = (sym: any, depth = 0) => {
          const range = sym.selectionRange ?? sym.range ?? sym.location?.range;
          const ln = range ? range.start.line + 1 : "?";
          flat.push(`${"  ".repeat(depth)}${SYMBOL_KINDS[sym.kind] ?? "symbol"} ${sym.name}  (line ${ln})`);
          for (const ch of sym.children ?? []) walk(ch, depth + 1);
        };
        for (const s of arr(await client.documentSymbols(uri))) walk(s);
        return flat.length ? flat.join("\n") : "no symbols";
      },
    },
    {
      name: "lsp_implementation",
      label: "LSP Implementation",
      description:
        "Concrete implementations of the interface/abstract symbol at file:line:column (1-based) — where definition gives the declaration, this gives the code that runs.",
      paramKind: "pos",
      async run(a) {
        const { client, uri } = await openAt(a);
        const { line, character } = toLsp(a.line!, a.column!);
        const out = await Promise.all(arr(await client.implementation(uri, line, character)).map(locLabel));
        return out.length ? out.map((o) => `${o.location}  ${o.snippet}`).join("\n") : "no implementations found";
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
            const { location } = await locLabel(sym.location ?? sym);
            return `${SYMBOL_KINDS[sym.kind] ?? "symbol"} ${sym.name}  ${location}`;
          }),
        );
        return out.length ? out.join("\n") : "no symbols found";
      },
    },
    {
      name: "lsp_incoming_calls",
      label: "LSP Incoming Calls",
      description: "Call hierarchy: who calls the function at file:line:column (1-based).",
      paramKind: "pos",
      async run(a) {
        return callHierarchy(a, "incoming");
      },
    },
    {
      name: "lsp_outgoing_calls",
      label: "LSP Outgoing Calls",
      description: "Call hierarchy: what the function at file:line:column (1-based) calls.",
      paramKind: "pos",
      async run(a) {
        return callHierarchy(a, "outgoing");
      },
    },
    {
      name: "lsp_diagnostics",
      label: "LSP Diagnostics",
      description: "Compiler/linter diagnostics for a file \u2014 ground-truth errors and warnings.",
      promptSnippet: "Get compiler/linter diagnostics for a file",
      promptGuidelines: ["Use lsp_diagnostics to verify a file compiles cleanly after edits, instead of guessing."],
      paramKind: "file",
      async run(a) {
        const { client, uri } = await openAt(a);
        await new Promise((r) => setTimeout(r, diagnosticsDelayMs)); // diagnostics arrive async after didOpen
        const diags = client.getDiagnostics(uri);
        if (!diags.length) return "no diagnostics";
        return diags
          .map((d: any) => `${SEVERITY[d.severity] ?? "diag"} ${a.file}:${d.range.start.line + 1}:${d.range.start.character + 1}  ${d.message}`)
          .join("\n");
      },
    },
  ];
}
