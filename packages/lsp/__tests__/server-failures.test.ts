/**
 * Server-failure behavior of the registered LSP tools — Vitest.
 *
 * Verifies that unavailable language servers and server-level errors reach the
 * model as actionable text results through the registered tool seam
 * (`lspToolSpecs`), instead of throwing or crashing the process. Deterministic:
 * no network, no real language servers — only a command that does not exist on
 * PATH and a tiny node fixture script.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LspManager, lspToolSpecs, type LspToolSpec, type ServerDef } from "../tools.ts";

const MISSING_CMD = "definitely-not-an-lsp-server-4f9d2";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "lsp-fail-"));
}

function specsFor(servers: Record<string, ServerDef>, rootPath: string): LspToolSpec[] {
  const manager = new LspManager(servers, rootPath);
  return lspToolSpecs(() => Promise.resolve(manager), { diagnosticsDelayMs: 10 });
}

describe("missing language server executable", () => {
  it("returns an actionable text result instead of crashing", async () => {
    const dir = tempDir();
    const file = path.join(dir, "sample.fake");
    writeFileSync(file, "const x = 1;");

    const specs = specsFor({ fake: { cmd: MISSING_CMD, extensions: [".fake"] } }, dir);
    const def = specs.find((s) => s.name === "lsp_definition")!;

    const result = await def.run({ file, line: 1, column: 1 });

    expect(typeof result).toBe("object");
    const { text } = result as { text: string };
    expect(text).toContain(MISSING_CMD);
    expect(text).toContain("PATH");
    expect(text).toContain("lsp.servers");
  });

  it("a follow-up call neither hangs nor crashes", async () => {
    const dir = tempDir();
    const file = path.join(dir, "sample.fake");
    writeFileSync(file, "const x = 1;");

    const specs = specsFor(
      { fake: { cmd: MISSING_CMD, args: ["--stdio"], extensions: [".fake"] } },
      dir,
    );
    const hover = specs.find((s) => s.name === "lsp_hover")!;

    const first = await hover.run({ file, line: 1, column: 1 });
    const second = await hover.run({ file, line: 1, column: 1 });

    expect((first as { text: string }).text).toContain(MISSING_CMD);
    expect((second as { text: string }).text).toContain(MISSING_CMD);
  });
});

describe("unsupported file type", () => {
  it("returns an understandable text result naming the extension", async () => {
    const dir = tempDir();
    // An extension no shipped server mapping owns.
    const file = path.join(dir, "sample.unknownext");
    writeFileSync(file, "hello");

    const specs = specsFor({}, dir);
    const diag = specs.find((s) => s.name === "lsp_diagnostics")!;

    const result = await diag.run({ file });

    expect(typeof result).toBe("object");
    const { text } = result as { text: string };
    expect(text).toContain("no language server configured");
    expect(text).toContain(".unknownext");
  });
});

describe("server error response", () => {
  // Fixture: a node script that answers `initialize` with a JSON-RPC error so
  // the client's dispatch error path runs end-to-end without a real server.
  const fixture = `
let buf = Buffer.alloc(0);
process.stdin.setEncoding("binary");
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, Buffer.from(c, "binary")]);
  for (;;) {
    const i = buf.indexOf("\\r\\n\\r\\n");
    if (i === -1) return;
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.subarray(0, i).toString("ascii"));
    if (!m) { buf = buf.subarray(i + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < i + 4 + len) return;
    const body = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString("utf8"));
    buf = buf.subarray(i + 4 + len);
    if (body.method === "initialize") {
      const res = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "fixture language server rejected initialize" },
        }),
        "utf8",
      );
      process.stdout.write("Content-Length: " + res.length + "\\r\\n\\r\\n");
      process.stdout.write(res);
    }
  }
});
`;

  it("surfaces the server error as a text result", async () => {
    const dir = tempDir();
    const serverScript = path.join(dir, "failing-server.mjs");
    writeFileSync(serverScript, fixture);
    const file = path.join(dir, "sample.fake");
    writeFileSync(file, "const x = 1;");

    const specs = specsFor(
      { fake: { cmd: process.execPath, args: [serverScript], extensions: [".fake"] } },
      dir,
    );
    const def = specs.find((s) => s.name === "lsp_definition")!;

    const result = await def.run({ file, line: 1, column: 1 });

    expect(typeof result).toBe("object");
    const { text } = result as { text: string };
    expect(text).toContain("fixture language server rejected initialize");
  });
});