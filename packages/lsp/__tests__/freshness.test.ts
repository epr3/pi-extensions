/**
 * Saved-file navigation freshness — Vitest.
 *
 * Exercises the registered LSP tools (lspToolSpecs) end-to-end against a fake
 * Language server (packages/lsp/__tests__/fixtures/fake-lsp.mjs) spawned like a
 * real server over stdio. The fake server answers textDocument/documentSymbol
 * from the document text it holds via didOpen/didChange, so tool results
 * reveal whether the server is answering from the current on-disk contents.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect } from "vitest";
import { LspManager, lspToolSpecs, type ServerDef } from "../tools.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));

interface LogEntry {
  method: "didOpen" | "didChange";
  version?: number;
  text?: string;
}

/** One fresh workspace + fake Language server per test. */
function startWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lsp-freshness-"));
  const logPath = path.join(dir, "messages.ndjson");
  const manager = new LspManager(
    {
      typescript: {
        cmd: process.execPath,
        args: [FIXTURE_PATH, logPath],
        extensions: [".ts"],
      } satisfies ServerDef,
    },
    dir,
  );
  const specs = lspToolSpecs(() => Promise.resolve(manager), {
    diagnosticsDelayMs: 10,
  });
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
    dispose: async () => {
      await manager.stopAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("saved-file navigation freshness", () => {
  let ws: ReturnType<typeof startWorkspace>;
  afterEach(async () => {
    await ws?.dispose();
  });

  it("navigates current contents after a saved edit", async () => {
    ws = startWorkspace();
    const sample = ws.writeSample("function alpha() {}\n");

    const before = (await ws.tool("lsp_document_symbols").run({ file: sample })) as {
      text: string;
    };
    expect(before.text).toContain("function alpha  (line 1)");

    // Save an edit to disk: a new function appears below the first one.
    ws.writeSample("function alpha() {}\nfunction beta() {}\n");

    const after = (await ws.tool("lsp_document_symbols").run({ file: sample })) as {
      text: string;
    };
    expect(after.text).toContain("function alpha  (line 1)");
    expect(after.text).toContain("function beta  (line 2)");
  });

  it("sends didChange only when saved contents changed, with a monotonic version and full text", async () => {
    ws = startWorkspace();
    const sample = ws.writeSample("function gamma() {}\n");

    await ws.tool("lsp_document_symbols").run({ file: sample });
    await ws.tool("lsp_document_symbols").run({ file: sample }); // unchanged — no resync
    expect(ws.watched("didChange")).toEqual([]);

    const saved = "function gamma() {}\nfunction delta() {}\n";
    ws.writeSample(saved);
    await ws.tool("lsp_document_symbols").run({ file: sample });

    const changes = ws.watched("didChange");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.version).toBe(2); // didOpen was version 1
    expect(changes[0]!.text).toBe(saved);

    await ws.tool("lsp_document_symbols").run({ file: sample }); // still fresh
    expect(ws.watched("didChange")).toHaveLength(1);
  });

  it("opens exactly once per file, at version 1, with full saved text", async () => {
    ws = startWorkspace();
    const sample = ws.writeSample("function epsilon() {}\n");
    await ws.tool("lsp_document_symbols").run({ file: sample });

    const opens = ws.watched("didOpen");
    expect(opens).toHaveLength(1);
    expect(opens[0]!.version).toBe(1);
    expect(opens[0]!.text).toBe("function epsilon() {}\n");
  });
});

// Keep the fixture itself checkable without spinning the real harness.
describe("fake language server fixture", () => {
  it("is valid node script", () => {
    expect(() =>
      execFileSync(process.execPath, ["--check", FIXTURE_PATH], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});