import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject } from "typebox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager, lspToolSpecs, type ParamKind, type ServerDef } from "./tools.ts";
import { renderLspCall } from "./render-call.ts";
import { renderLspNavigationResult } from "./render-result.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

function textResult(text: string, details?: any): AgentToolResult<any> {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/**
 * LSP extension. Precise code navigation via real language servers instead of
 * grep guesses. The tool catalog (names, descriptions, handlers) is the single
 * source of truth in tools.ts; this file maps each spec's param-kind to a
 * schema and registers it in a loop. One server per language, spawned lazily,
 * keyed by file extension in servers.json. Dependency-free (node: built-ins);
 * requires the language servers on PATH.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const SCHEMAS: Record<ParamKind, TObject> = {
  pos: Type.Object({
    file: Type.String({ description: "Path to the file containing the symbol" }),
    line: Type.Number({ description: "1-based line number" }),
    column: Type.Number({ description: "1-based column number" }),
  }),
  ref: Type.Object({
    file: Type.String({ description: "Path to the file containing the symbol" }),
    line: Type.Number({ description: "1-based line number" }),
    column: Type.Number({ description: "1-based column number" }),
    includeDeclaration: Type.Optional(
      Type.Boolean({ description: "Include the declaration site in reference results" }),
    ),
  }),
  file: Type.Object({
    file: Type.String({ description: "Path to the file to outline or check diagnostics" }),
  }),
  query: Type.Object({
    query: Type.String({ description: "Symbol name (or prefix) to search for" }),
    file: Type.String({
      description: "Any file of the target language — routes to the right server",
    }),
  }),
};

// Settings: this extension reads its own top-level "lsp" key from Pi's
// settings files (global then project; project wins), inline and self-contained
// — no shared loader. Env vars override on top.
function settingsKey(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of [
    path.join(homedir(), ".pi", "agent", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
  ]) {
    try {
      Object.assign(out, JSON.parse(readFileSync(f, "utf8"))["lsp"] ?? {});
    } catch {
      /* missing or malformed file: defaults stand */
    }
  }
  return out;
}

export default async function (pi: ExtensionAPI) {
  // servers.json ships the defaults; the `lsp.servers` key in Pi's
  // settings.json adds or overrides languages without editing the extension dir.
  const shipped = JSON.parse(await readFile(path.join(here, "servers.json"), "utf8")) as Record<
    string,
    ServerDef
  >;
  const raw = settingsKey();
  const servers = { ...shipped, ...((raw.servers ?? {}) as Record<string, ServerDef>) };
  const diagnosticsDelayMs =
    Number(raw.diagnosticsDelayMs) > 0 ? Number(raw.diagnosticsDelayMs) : 600;

  // The manager is bound to the *session's* cwd, lazily on first tool use, and
  // rebuilt if the session moves to a different project (e.g. /resume) —
  // process.cwd() at extension load is not the right root.
  let manager: LspManager | null = null;
  let managerRoot = "";
  const getManagerFor = async (cwd: string): Promise<LspManager> => {
    if (manager && managerRoot === cwd) return manager;
    if (manager) await manager.stopAll();
    manager = new LspManager(servers, cwd);
    managerRoot = cwd;
    return manager;
  };

  // The provider used by tool handlers; rebound per call below.
  let currentCwd = process.cwd();
  const getManager = () => getManagerFor(currentCwd);

  for (const spec of lspToolSpecs(getManager, { diagnosticsDelayMs })) {
    const hasRenderResult = ["lsp_definition", "lsp_references", "lsp_implementation", "lsp_incoming_calls", "lsp_outgoing_calls", "lsp_document_symbols", "lsp_workspace_symbols", "lsp_hover", "lsp_diagnostics"].includes(spec.name);

    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      ...(spec.promptSnippet ? { promptSnippet: spec.promptSnippet } : {}),
      ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {}),
      parameters: SCHEMAS[spec.paramKind],
      renderCall: renderLspCall(spec.label, spec.paramKind),
      ...(hasRenderResult ? { renderResult: renderLspNavigationResult } : {}),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        currentCwd = ctx.cwd;
        const result = await spec.run(params as any);
        if (typeof result === "string") return textResult(result);
        return textResult(result.text, result.details);
      },
    });
  }

  pi.on("session_shutdown", async () => {
    await manager?.stopAll();
    manager = null;
  });
}