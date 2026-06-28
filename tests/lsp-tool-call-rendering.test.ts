/**
 * Behavior tests for LSP tool call-summary rendering.
 *
 * Covers every LSP parameter shape (position, reference, file, query) and
 * verifies the visible call row stays compact: caller path and 1-based
 * positions only. No language-server stdout, stderr, protocol frames,
 * progress logs, or final result text leaks into the summary.
 *
 * Run: npx tsx tests/lsp-tool-call-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import {
  formatLspCallSummary,
  renderLspCall,
} from "../packages/lsp/render-call.ts";
import type { ParamKind } from "../packages/lsp/tools.ts";

// ---------------------------------------------------------------------------
// Plain theme — strips ANSI so tests assert visible text, not styling.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedCall(label: string, kind: ParamKind, args: any): string {
  const component = renderLspCall(label, kind)(args, plainTheme, undefined);
  return component.render(80).join("\n");
}

// ---------------------------------------------------------------------------
// formatLspCallSummary
// ---------------------------------------------------------------------------

function testPositionSummary() {
  const summary = formatLspCallSummary("pos", {
    file: "src/lib.ts",
    line: 12,
    column: 5,
  });
  assert.strictEqual(summary, "src/lib.ts:12:5", "position summary keeps 1-based line:column");
  console.log("  Position summary .................................. PASS");
}

function testReferenceSummary() {
  const summary = formatLspCallSummary("ref", {
    file: "src/lib.ts",
    line: 7,
    column: 3,
    includeDeclaration: true,
  });
  assert.strictEqual(summary, "src/lib.ts:7:3", "reference summary keeps 1-based line:column");
  console.log("  Reference summary ................................. PASS");
}

function testFileSummary() {
  const summary = formatLspCallSummary("file", { file: "src/lib.ts" });
  assert.strictEqual(summary, "src/lib.ts", "file summary renders path only");
  console.log("  File summary ...................................... PASS");
}

function testQuerySummary() {
  const summary = formatLspCallSummary("query", {
    query: "LspManager",
    file: "packages/lsp/tools.ts",
  });
  assert.ok(summary.includes("LspManager"), "query summary includes the symbol query");
  assert.ok(summary.includes("packages/lsp/tools.ts"), "query summary includes the routing file");
  assert.ok(summary.includes(" via "), "query summary separates query from routing file");
  console.log("  Query summary ..................................... PASS");
}

function testQueryRoutingFileIsNotScope() {
  const summary = formatLspCallSummary("query", {
    query: "formatLspCallSummary",
    file: "packages/lsp/render-call.ts",
  });
  // The routing file chooses the language server; the search is project-wide.
  assert.ok(!summary.startsWith("packages/lsp/render-call.ts"), "routing file is not presented as the search scope");
  assert.ok(summary.startsWith("formatLspCallSummary"), "query leads the summary");
  console.log("  Query routing file is not scope ................... PASS");
}

function testSummaryFormatIsCompactAndHasNoExtraMetadata() {
  // The formatter must only echo caller-supplied args; it must not prepend
  // language-server labels, protocol names, or result text.
  assert.strictEqual(
    formatLspCallSummary("pos", { file: "src/a.ts", line: 3, column: 7 }),
    "src/a.ts:3:7",
  );
  assert.strictEqual(
    formatLspCallSummary("ref", { file: "src/b.ts", line: 4, column: 8 }),
    "src/b.ts:4:8",
  );
  assert.strictEqual(formatLspCallSummary("file", { file: "src/c.ts" }), "src/c.ts");
  assert.strictEqual(
    formatLspCallSummary("query", { query: "foo", file: "src/d.ts" }),
    "foo via src/d.ts",
  );
  console.log("  Summary format is compact and has no extra metadata  PASS");
}

// ---------------------------------------------------------------------------
// renderLspCall
// ---------------------------------------------------------------------------

function testRenderCallReturnsRenderable() {
  const component = renderLspCall("LSP Definition", "pos")(
    { file: "src/lib.ts", line: 1, column: 1 },
    plainTheme,
    undefined,
  );
  assert.ok(typeof component.render === "function", "returns a renderable component");
  const lines = component.render(80);
  assert.ok(Array.isArray(lines), "render() returns an array");
  assert.ok(lines.length > 0, "render() returns at least one line");
  console.log("  renderLspCall returns renderable component ........ PASS");
}

function testRenderCallShowsLabel() {
  const text = renderedCall("LSP Definition", "pos", {
    file: "src/lib.ts",
    line: 10,
    column: 2,
  });
  assert.ok(text.includes("LSP Definition"), "call row shows tool label");
  console.log("  renderLspCall shows tool label .................... PASS");
}

function testRenderCallPosition() {
  const text = renderedCall("LSP Definition", "pos", {
    file: "src/lib.ts",
    line: 10,
    column: 2,
  });
  assert.ok(text.includes("src/lib.ts:10:2"), "position call row includes path and 1-based position");
  console.log("  renderLspCall position ............................ PASS");
}

function testRenderCallReference() {
  const text = renderedCall("LSP References", "ref", {
    file: "src/lib.ts",
    line: 20,
    column: 8,
  });
  assert.ok(text.includes("src/lib.ts:20:8"), "reference call row includes path and 1-based position");
  console.log("  renderLspCall reference ........................... PASS");
}

function testRenderCallFile() {
  const text = renderedCall("LSP Symbols", "file", { file: "src/lib.ts" });
  assert.ok(text.includes("src/lib.ts"), "file call row includes path");
  assert.ok(!text.includes(":"), "file call row has no line/column");
  console.log("  renderLspCall file ................................ PASS");
}

function testRenderCallQuery() {
  const text = renderedCall("LSP Workspace Symbols", "query", {
    query: "LspManager",
    file: "packages/lsp/tools.ts",
  });
  assert.ok(text.includes("LspManager"), "workspace-symbol call row includes query");
  assert.ok(text.includes("packages/lsp/tools.ts"), "workspace-symbol call row includes routing file");
  assert.ok(text.includes(" via "), "workspace-symbol call row separates query and routing file");
  console.log("  renderLspCall query ............................... PASS");
}

function testRenderCallDoesNotSurfaceResultText() {
  const text = renderedCall("LSP Hover", "pos", {
    file: "src/lib.ts",
    line: 5,
    column: 1,
  });
  assert.ok(!text.includes("no hover info"), "no final result text in call row");
  assert.ok(!text.includes("stdout"), "no stdout label");
  assert.ok(!text.includes("stderr"), "no stderr label");
  console.log("  renderLspCall omits result text and LS logs ....... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nLSP tool call rendering tests\n");

  testPositionSummary();
  testReferenceSummary();
  testFileSummary();
  testQuerySummary();
  testQueryRoutingFileIsNotScope();
  testSummaryFormatIsCompactAndHasNoExtraMetadata();

  testRenderCallReturnsRenderable();
  testRenderCallShowsLabel();
  testRenderCallPosition();
  testRenderCallReference();
  testRenderCallFile();
  testRenderCallQuery();
  testRenderCallDoesNotSurfaceResultText();

  console.log("\nAll tests PASS\n");
}

main();
