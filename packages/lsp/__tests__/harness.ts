/**
 * Registered-tool test harness for diagnostics-confidence tests: one fresh
 * workspace + fake Language server (extras/fixture via fixtures/fake-lsp.mjs)
 * per test. Mirrors the startWorkspace helper in freshness.test.ts but adds
 * per-test publish-mode and delay configuration.
 */

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager, lspToolSpecs, type ServerDef } from "../tools.ts";

export const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

export interface LogEntry {
  method: "didOpen" | "didChange";
  version?: number;
  text?: string;
}

export type PublishMode =
  | "versioned"
  | "unversioned"
  | "silent"
  | "stale-then-current"
  | "stale-only";

export interface WsOptions {
  publishMode?: PublishMode;
  publishDelayMs?: number;
  /** Diagnostics wait budget passed to lspToolSpecs(). Defaults to 10ms. */
  diagnosticsDelayMs?: number;
}

export function startWorkspace(opts: WsOptions = {}) {
  const { publishMode = "versioned", publishDelayMs = 10, diagnosticsDelayMs = 10 } = opts;
  const dir = mkdtempSync(path.join(os.tmpdir(), "lsp-diag-conf-"));
  const logPath = path.join(dir, "messages.ndjson");
  const manager = new LspManager(
    {
      typescript: {
        cmd: process.execPath,
        args: [FIXTURE_PATH, logPath, publishMode, String(publishDelayMs)],
        extensions: [".ts"],
      } satisfies ServerDef,
    },
    dir,
  );
  const specs = lspToolSpecs(() => Promise.resolve(manager), { diagnosticsDelayMs });
  const tool = (name: string) => specs.find((s) => s.name === name)!;
  const watched = (method: LogEntry["method"]) =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LogEntry)
      .filter((e) => e.method === method);
  const writeSample = (body: string) => {
    const sample = path.join(dir, "sample.ts");
    writeFileSync(sample, body);
    return sample;
  };
  return {
    dir,
    manager,
    tool,
    watched,
    writeSample,
    /** The already-started client for the sample workspace (typescript server). */
    client: () => manager.clientForFile(path.join(dir, "sample.ts")),
    dispose: async () => {
      await manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Workspace = ReturnType<typeof startWorkspace>;

/** Result payload type of every lsp_* tool run. */
export interface ToolResult {
  text: string;
  details: Record<string, unknown>;
}