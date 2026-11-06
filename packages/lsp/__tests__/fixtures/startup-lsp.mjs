// Deterministic Language server fixture for `LspManager` startup coordination.
//
// Usage: node startup-lsp.mjs <start-log-path> <fail-once-marker-path>
//
// Each process appends one JSON line to <start-log-path> before reading any
// input, so a test can count how many server processes a burst of concurrent
// tool calls actually spawned — an observation at the server boundary rather
// than inside the client.
//
// Failure mode: while <fail-once-marker-path> does not exist, the process
// creates it and answers `initialize` with a JSON-RPC error, then exits. Later
// processes therefore start successfully, which makes "startup fails, then a
// retry succeeds" deterministic across separate server processes.

import fs from "node:fs";
import process from "node:process";

const startLogPath = process.argv[2];
const failMarkerPath = process.argv[3];

fs.appendFileSync(startLogPath, JSON.stringify({ event: "start", pid: process.pid }) + "\n");

let failStartup = false;
try {
  fs.writeFileSync(failMarkerPath, "first startup failed\n", { flag: "wx" });
  failStartup = true;
} catch {
  /* marker already present: this startup succeeds */
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString("utf8");
    buffer = buffer.subarray(start + len);
    handle(JSON.parse(body));
  }
});

process.stdin.on("error", () => {});
process.on("uncaughtException", (err) => {
  process.stderr.write(`startup-lsp crashed: ${err?.stack ?? err}\n`);
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

function handle(msg) {
  if (msg.method === "initialize") {
    if (failStartup) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: "fixture language server startup failed" },
      });
      setTimeout(() => process.exit(1), 10);
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: { textDocumentSync: 1, textDocument: { definition: {} } },
      },
    });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") process.exit(0);
  if (msg.id !== undefined && msg.id !== null) {
    if (msg.method === "textDocument/definition") {
      const uri = msg.params.textDocument.uri;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: [
          { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        ],
      });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: [] });
  }
}