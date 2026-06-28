import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject } from "typebox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager, lspToolSpecs, type ParamKind, type ServerDef } from "./tools.ts";
import { renderLspCall } from "./render-call.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

function textResult(text: string, details?: Record<string, unknown>) {
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
    file: Type.String({ description: "Path to the file" }),
    line: Type.Number({ description: "1-based line number" }),
    column: Type.Number({ description: "1-based column number" }),
  }),
  ref: Type.Object({
    file: Type.String({ description: "Path to the file" }),
    line: Type.Number({ description: "1-based line number" }),
    column: Type.Number({ description: "1-based column number" }),
    includeDeclaration: Type.Optional(Type.Boolean()),
  }),
  file: Type.Object({ file: Type.String({ description: "Path to the file" }) }),
  query: Type.Object({
    query: Type.String({ description: "Symbol name (or prefix) to search for" }),
    file: Type.String({ description: "Any file of the target language — routes to the right server" }),
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
  const shipped = JSON.parse(await readFile(path.join(here, "servers.json"), "utf8")) as Record<string, ServerDef>;
  const raw = settingsKey();
  const servers = { ...shipped, ...((raw.servers ?? {}) as Record<string, ServerDef>) };
  const diagnosticsDelayMs = Number(raw.diagnosticsDelayMs) > 0 ? Number(raw.diagnosticsDelayMs) : 600;

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
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      ...(spec.promptSnippet ? { promptSnippet: spec.promptSnippet } : {}),
      ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {}),
      parameters: SCHEMAS[spec.paramKind],
      renderCall: renderLspCall(spec.label, spec.paramKind),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        currentCwd = ctx.cwd;
        return textResult(await spec.run(params as any));
      },
    });
  }

  pi.on("session_shutdown", async () => {
    await manager?.stopAll();
    manager = null;
  });
}
