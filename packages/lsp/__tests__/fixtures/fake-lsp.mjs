// Deterministic minimal Language server fixture for the `lsp_*` tool tests.
// Implements stdio Content-Length framing and keeps per-document text from
// `textDocument/didOpen` / `textDocument/didChange` — exactly the state a real
// Language server holds. Answers and diagnostics are computed from that held
// text, so a test can observe whether the server sees the current on-disk
// contents.
//
// Usage: node fake-lsp.mjs <message-log-path> [publish-mode] [publish-delay-ms]
// Appends one JSON line per received didOpen/didChange to <message-log-path>
// (a test-side channel; nothing in the client knows about it).
//
// Publish modes (after each accepted didOpen/didChange, following an optional
// delay):
//   versioned         — textDocument/publishDiagnostics WITH the document version
//   unversioned       — publishDiagnostics WITHOUT any version field
//   silent            — never publishes diagnostics at all
//   stale-then-current — publishes for the PREVIOUS document state first (older
//                        version, previous text), then for the current one after
//                        the delay
//   stale-only        — publishes only for the previous document state, never
//                        catching up with the current version

import fs from "node:fs";
import process from "node:process";

const logPath = process.argv[2];
const publishMode = process.argv[3] ?? "versioned";
const publishDelayMs = Number(process.argv[4] ?? 10);

// uri -> document text currently held by the server
const docs = new Map();

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
  process.stderr.write(`fake-lsp crashed: ${err?.stack ?? err}\n`);
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

function log(entry) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

// Diagnostics derived from the held document text: each "FIXME" marker line
// reports an error, so an edit removing them yields an empty diagnostic set.
function diagnosticsFor(uri) {
  const text = docs.get(uri) ?? "";
  return text.split(/\r?\n/).reduce((acc, lineText, line) => {
    const m = /FIXME/.exec(lineText);
    if (m) {
      acc.push({
        severity: 1,
        message: `synthetic error: ${lineText.trim()}`,
        range: {
          start: { line, character: m.index },
          end: { line, character: lineText.length },
        },
      });
    }
    return acc;
  }, []);
}

function publish(uri, version) {
  const params = { uri, diagnostics: diagnosticsFor(uri) };
  if (publishMode !== "unversioned") params.version = version;
  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params });
}

// Diagnostics for a document state the server analyzed BEFORE the current one:
// the previous version and its previous text (empty on first open).
function publishStale(uri, version, previousText) {
  const diagnostics = (previousText ?? "").split(/\r?\n/).reduce((acc, lineText, line) => {
    const m = /FIXME/.exec(lineText);
    if (m) {
      acc.push({
        severity: 1,
        message: `synthetic error: ${lineText.trim()}`,
        range: { start: { line, character: m.index }, end: { line, character: lineText.length } },
      });
    }
    return acc;
  }, []);
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics, version: Math.max(0, version - 1) },
  });
}

// Top-level `function NAME` lines, zero-based index by position in held text.
function functionSymbols(uri) {
  const text = docs.get(uri) ?? "";
  return text.split(/\r?\n/).reduce((acc, lineText, line) => {
    const m = /^\s*function\s+([A-Za-z_$][\w$]*)/.exec(lineText);
    if (m) {
      const range = { start: { line, character: 0 }, end: { line, character: m[0].length } };
      acc.push({ name: m[1], kind: 12, range, selectionRange: range });
    }
    return acc;
  }, []);
}

// Publish per the configured mode: an immediate stale publish (previous state)
// for the lagging modes, then the current-state publish after the delay.
function schedule(uri, version, previousText) {
  if (publishMode === "silent") return;
  if (publishMode === "stale-then-current" || publishMode === "stale-only") {
    setTimeout(() => publishStale(uri, version, previousText), 0);
  }
  if (publishMode === "stale-only") return;
  setTimeout(() => publish(uri, version), publishDelayMs);
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          textDocument: { documentSymbol: {}, definition: {} },
        },
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
  if (msg.method === "textDocument/didOpen") {
    const td = msg.params.textDocument;
    docs.set(td.uri, td.text);
    log({ method: "didOpen", version: td.version, text: td.text });
    schedule(td.uri, td.version, undefined);
    return;
  }
  if (msg.method === "textDocument/didChange") {
    const td = msg.params.textDocument;
    const previousText = docs.get(td.uri);
    const text = msg.params.contentChanges.at(-1).text;
    docs.set(td.uri, text);
    log({ method: "didChange", version: td.version, text });
    schedule(td.uri, td.version, previousText);
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    if (msg.method === "textDocument/documentSymbol") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: functionSymbols(msg.params.textDocument.uri),
      });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: [] });
  }
}