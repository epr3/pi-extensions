/**
 * Behavior tests for LSP symbol, hover, and diagnostics result rendering.
 *
 * Covers structured details rendering for:
 *   - Document symbol results (collapsed, expanded with tree)
 *   - Workspace symbol results (collapsed, expanded, routing-file wording)
 *   - Hover results (collapsed, expanded, no-hover state)
 *   - Diagnostics results (collapsed severity summary, expanded, empty)
 *   - Fallback text rendering when structured details are absent
 *   - Compact call-row preservation (no result text leakage)
 *
 * Uses a plain theme that strips ANSI codes, so tests verify the visible
 * text contract without depending on exact styling.
 *
 * Run: npx tsx tests/lsp-symbol-hover-diagnostics-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import {
  renderLspNavigationResult,
} from "../packages/lsp/render-result.ts";
import type {
  LspNavigationDetails,
  LspSymbolRecord,
  LspHoverRecord,
  LspDiagnosticRecord,
} from "../packages/lsp/render-result.ts";
import { renderLspCall } from "../packages/lsp/render-call.ts";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedResult(
  result: Parameters<typeof renderLspNavigationResult>[0],
  options?: { isPartial?: boolean; expanded?: boolean },
): string[] {
  const component = renderLspNavigationResult(
    result,
    { isPartial: false, expanded: false, ...options },
    plainTheme,
    undefined,
  );
  return component.render(80);
}

function resultText(
  result: Parameters<typeof renderLspNavigationResult>[0],
  options?: { isPartial?: boolean; expanded?: boolean },
): string {
  return renderedResult(result, options).join("\n");
}

// ---------------------------------------------------------------------------
// Document symbol results
// ---------------------------------------------------------------------------

function testDocumentSymbolsCollapsed() {
  const result = {
    content: [{ type: "text" as const, text: "class Foo  (line 1)\n  function bar  (line 5)" }],
    details: {
      resultKind: "documentSymbols",
      symbols: [
        { name: "Foo", kind: "class", line: 1, children: [
          { name: "bar", kind: "function", line: 5 },
        ]},
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  // Top-level count: 1 class Foo with children
  assert.ok(text.includes("1 symbol"), "collapsed document symbols shows top-level count");
  assert.ok(text.includes("class Foo"), "collapsed document symbols shows first symbol kind and name");
  assert.ok(text.includes("(line 1)"), "collapsed document symbols shows first symbol line");
  console.log("  Document symbols collapsed ......................... PASS");
}

function testDocumentSymbolsExpanded() {
  const result = {
    content: [{ type: "text" as const, text: "class Foo  (line 1)\n  function bar  (line 5)" }],
    details: {
      resultKind: "documentSymbols",
      symbols: [
        { name: "Foo", kind: "class", line: 1, children: [
          { name: "bar", kind: "function", line: 5 },
        ]},
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("class Foo"), "expanded shows class name");
  assert.ok(text.includes("(line 1)"), "expanded shows class line");
  assert.ok(text.includes("function bar"), "expanded shows child function");
  assert.ok(text.includes("(line 5)"), "expanded shows child line");
  // Children are indented
  const lines = text.split("\n");
  const barLine = lines.find((l) => l.includes("bar"))!;
  assert.ok(barLine.startsWith("  "), "child symbol is indented");
  console.log("  Document symbols expanded .......................... PASS");
}

function testDocumentSymbolsFlat() {
  // Flat list (no children) still works as single-level tree
  const result = {
    content: [{ type: "text" as const, text: "function a  (line 1)\nfunction b  (line 5)" }],
    details: {
      resultKind: "documentSymbols",
      symbols: [
        { name: "a", kind: "function", line: 1 },
        { name: "b", kind: "function", line: 5 },
      ],
    } satisfies LspNavigationDetails,
  };
  const collapsed = resultText(result, { expanded: false });
  assert.ok(collapsed.includes("2 symbols"), "collapsed flat symbols shows count");
  assert.ok(collapsed.includes("function a"), "collapsed flat symbols shows first");

  const expanded = resultText(result, { expanded: true });
  assert.ok(expanded.includes("function a"), "expanded flat shows first");
  assert.ok(expanded.includes("function b"), "expanded flat shows second");
  console.log("  Document symbols flat .............................. PASS");
}

function testEmptyDocumentSymbols() {
  const result = {
    content: [{ type: "text" as const, text: "no symbols" }],
    details: {
      resultKind: "documentSymbols",
      symbols: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no symbols"), "empty document symbols shows message");
  console.log("  Empty document symbols ............................ PASS");
}

// ---------------------------------------------------------------------------
// Workspace symbol results
// ---------------------------------------------------------------------------

function testWorkspaceSymbolsCollapsed() {
  const result = {
    content: [{ type: "text" as const, text: "class LspManager  packages/lsp/tools.ts:10" }],
    details: {
      resultKind: "workspaceSymbols",
      symbols: [
        { name: "LspManager", kind: "class", line: 10 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("1 symbol"), "collapsed workspace symbols shows count");
  assert.ok(text.includes("class LspManager"), "collapsed workspace symbols shows first");
  assert.ok(text.includes("(line 10)"), "collapsed workspace symbols shows line");
  console.log("  Workspace symbols collapsed ........................ PASS");
}

function testWorkspaceSymbolsExpanded() {
  const result = {
    content: [{ type: "text" as const, text: "" }],
    details: {
      resultKind: "workspaceSymbols",
      symbols: [
        { name: "LspManager", kind: "class", line: 10 },
        { name: "connect", kind: "method", line: 42 },
        { name: "disconnect", kind: "method", line: 100 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("class LspManager"), "expanded shows first");
  assert.ok(text.includes("method connect"), "expanded shows second");
  assert.ok(text.includes("method disconnect"), "expanded shows third");
  assert.ok(text.includes("(line 10)"), "expanded shows line for first");
  assert.ok(text.includes("(line 100)"), "expanded shows line for third");
  console.log("  Workspace symbols expanded ......................... PASS");
}

function testEmptyWorkspaceSymbols() {
  const result = {
    content: [{ type: "text" as const, text: "no symbols found" }],
    details: {
      resultKind: "workspaceSymbols",
      symbols: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no symbols found"), "empty workspace symbols shows message");
  console.log("  Empty workspace symbols ........................... PASS");
}

// ---------------------------------------------------------------------------
// Hover results
// ---------------------------------------------------------------------------

function testHoverCollapsed() {
  const result = {
    content: [{ type: "text" as const, text: "const x: number" }],
    details: {
      resultKind: "hover",
      hover: { found: true, content: "const x: number" },
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("hover"), "collapsed hover shows keyword");
  assert.ok(text.includes("const x: number"), "collapsed hover shows first line of content");
  console.log("  Hover collapsed .................................... PASS");
}

function testHoverExpanded() {
  const result = {
    content: [{ type: "text" as const, text: "const x: number\n\nThe value of x, default 42." }],
    details: {
      resultKind: "hover",
      hover: { found: true, content: "const x: number\n\nThe value of x, default 42." },
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("const x: number"), "expanded hover shows first line");
  assert.ok(text.includes("The value of x"), "expanded hover shows doc text");
  console.log("  Hover expanded ..................................... PASS");
}

function testHoverNotFound() {
  const result = {
    content: [{ type: "text" as const, text: "no hover info" }],
    details: {
      resultKind: "hover",
      hover: { found: false },
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no hover info"), "hover not found shows message");
  console.log("  Hover not found .................................... PASS");
}

function testHoverWithEmptyContent() {
  const result = {
    content: [{ type: "text" as const, text: "no hover info" }],
    details: {
      resultKind: "hover",
      hover: { found: true, content: "" },
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no hover info"), "hover with empty content shows fallback message");
  console.log("  Hover with empty content ........................... PASS");
}

// ---------------------------------------------------------------------------
// Diagnostics results
// ---------------------------------------------------------------------------

function testDiagnosticsCollapsedWithErrorsAndWarnings() {
  const result = {
    content: [{ type: "text" as const, text: "" }],
    details: {
      resultKind: "diagnostics",
      diagnostics: [
        { severity: "error", message: "Type 'X' is not assignable", file: "src/a.ts", line: 10, column: 5 },
        { severity: "error", message: "Cannot find name 'Y'", file: "src/a.ts", line: 15, column: 3 },
        { severity: "warning", message: "Variable 'z' is unused", file: "src/a.ts", line: 20, column: 7 },
        { severity: "info", message: "Missing return type", file: "src/a.ts", line: 25, column: 1 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("4 diagnostics"), "collapsed diagnostics shows total count");
  assert.ok(text.includes("2 err"), "collapsed diagnostics shows error count");
  assert.ok(text.includes("1 warn"), "collapsed diagnostics shows warning count");
  assert.ok(text.includes("1 more"), "collapsed diagnostics shows rest count");
  console.log("  Diagnostics collapsed with errors and warnings ..... PASS");
}

function testDiagnosticsCollapsedErrorsOnly() {
  const result = {
    content: [{ type: "text" as const, text: "" }],
    details: {
      resultKind: "diagnostics",
      diagnostics: [
        { severity: "error", message: "Type mismatch", file: "src/a.ts", line: 5, column: 1 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("1 diagnostic"), "collapsed diagnostics with one error shows count");
  assert.ok(text.includes("1 err"), "collapsed diagnostics shows error count");
  assert.ok(!text.includes("0 warn"), "no zero-count warnings shown");
  console.log("  Diagnostics collapsed errors only .................. PASS");
}

function testDiagnosticsExpanded() {
  const result = {
    content: [{ type: "text" as const, text: "" }],
    details: {
      resultKind: "diagnostics",
      diagnostics: [
        { severity: "error", message: "Type 'X' is not assignable", file: "src/a.ts", line: 10, column: 5 },
        { severity: "warning", message: "Unused variable 'z'", file: "src/a.ts", line: 20, column: 7 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("err"), "expanded shows error severity label");
  assert.ok(text.includes("warn"), "expanded shows warning severity label");
  assert.ok(text.includes("err src/a.ts:10:5"), "expanded shows error location");
  assert.ok(text.includes("Type 'X' is not assignable"), "expanded shows error message");
  assert.ok(text.includes("src/a.ts:20:7"), "expanded shows warning location");
  assert.ok(text.includes("Unused variable 'z'"), "expanded shows warning message");
  console.log("  Diagnostics expanded ............................... PASS");
}

function testEmptyDiagnostics() {
  const result = {
    content: [{ type: "text" as const, text: "no diagnostics" }],
    details: {
      resultKind: "diagnostics",
      diagnostics: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no diagnostics"), "empty diagnostics shows message");
  console.log("  Empty diagnostics ................................. PASS");
}

function testDiagnosticsWithHintAndInfo() {
  const result = {
    content: [{ type: "text" as const, text: "" }],
    details: {
      resultKind: "diagnostics",
      diagnostics: [
        { severity: "info", message: "Missing return type annotation", file: "src/b.ts", line: 3, column: 1 },
        { severity: "hint", message: "Consider using const", file: "src/b.ts", line: 7, column: 5 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("info src/b.ts:3:1"), "expanded shows info diagnostic");
  assert.ok(text.includes("hint src/b.ts:7:5"), "expanded shows hint diagnostic");
  console.log("  Diagnostics with hint and info .................... PASS");
}

// ---------------------------------------------------------------------------
// Fallback text rendering (no structured details)
// ---------------------------------------------------------------------------

function testFallbackWhenDetailsMissing() {
  const result = {
    content: [{ type: "text" as const, text: "some plain text result" }],
  };
  const text = resultText(result as any);
  assert.ok(text.includes("some plain text result"), "falls back to content text");
  console.log("  Fallback when details missing ..................... PASS");
}

function testFallbackWhenDetailsEmpty() {
  const result = {
    content: [{ type: "text" as const, text: "some plain text result" }],
    details: {},
  };
  const text = resultText(result as any);
  assert.ok(text.includes("some plain text result"), "falls back when details empty");
  console.log("  Fallback when details empty ....................... PASS");
}

function testFallbackWhenDetailsHasNoRelevantKey() {
  const result = {
    content: [{ type: "text" as const, text: "some plain text result" }],
    details: { resultKind: "hover" },
  };
  const text = resultText(result as any);
  assert.ok(text.includes("some plain text result"), "falls back when details has no relevant data");
  console.log("  Fallback when relevant key absent ................. PASS");
}

// ---------------------------------------------------------------------------
// Compact call-row preservation (no result text leakage)
// ---------------------------------------------------------------------------

function testCallRowOmitsResultText() {
  // Verify that the existing renderLspCall still only shows the compact
  // call summary — no result text, no structured details.
  const component = renderLspCall("LSP Hover", "pos")(
    { file: "src/lib.ts", line: 10, column: 5 },
    plainTheme,
    undefined,
  );
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.ok(text.includes("LSP Hover"), "call row shows tool label");
  assert.ok(text.includes("src/lib.ts:10:5"), "call row shows compact file:line:col");
  assert.ok(!text.includes("hover"), "no result keyword in call row");
  assert.ok(!text.includes("const x"), "no result content in call row");
  console.log("  Call row omits result text ........................ PASS");
}

function testSymbolsCallRowOmitsResultText() {
  const component = renderLspCall("LSP Symbols", "file")(
    { file: "src/lib.ts" },
    plainTheme,
    undefined,
  );
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.ok(text.includes("LSP Symbols"), "call row shows tool label");
  assert.ok(text.includes("src/lib.ts"), "call row shows file");
  assert.ok(!text.includes("symbol"), "no result symbol word in call row");
  console.log("  Symbols call row omits result text ................ PASS");
}

function testDiagnosticsCallRowOmitsResultText() {
  const component = renderLspCall("LSP Diagnostics", "file")(
    { file: "src/a.ts" },
    plainTheme,
    undefined,
  );
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.ok(text.includes("LSP Diagnostics"), "call row shows tool label");
  assert.ok(text.includes("src/a.ts"), "call row shows file");
  assert.ok(!text.includes("err"), "no result diagnostic label in call row");
  assert.ok(!text.includes("warn"), "no result warning label in call row");
  console.log("  Diagnostics call row omits result text ............. PASS");
}

function testWorkspaceSymbolsCallRowOmitsResultText() {
  const component = renderLspCall("LSP Workspace Symbols", "query")(
    { query: "LspManager", file: "packages/lsp/tools.ts" },
    plainTheme,
    undefined,
  );
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.ok(text.includes("LSP Workspace Symbols"), "call row shows tool label");
  assert.ok(text.includes("LspManager"), "call row shows query");
  assert.ok(text.includes("packages/lsp/tools.ts"), "call row shows routing file");
  assert.ok(text.includes(" via "), "call row shows via separator");
  assert.ok(!text.includes("symbol"), "no result symbol word in call row");
  console.log("  Workspace symbols call row omits result text ....... PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nLSP symbol, hover, and diagnostics rendering tests\n");

  // Document symbols
  testDocumentSymbolsCollapsed();
  testDocumentSymbolsExpanded();
  testDocumentSymbolsFlat();
  testEmptyDocumentSymbols();

  // Workspace symbols
  testWorkspaceSymbolsCollapsed();
  testWorkspaceSymbolsExpanded();
  testEmptyWorkspaceSymbols();

  // Hover
  testHoverCollapsed();
  testHoverExpanded();
  testHoverNotFound();
  testHoverWithEmptyContent();

  // Diagnostics
  testDiagnosticsCollapsedWithErrorsAndWarnings();
  testDiagnosticsCollapsedErrorsOnly();
  testDiagnosticsExpanded();
  testEmptyDiagnostics();
  testDiagnosticsWithHintAndInfo();

  // Fallback text rendering
  testFallbackWhenDetailsMissing();
  testFallbackWhenDetailsEmpty();
  testFallbackWhenDetailsHasNoRelevantKey();

  // Compact call-row preservation
  testCallRowOmitsResultText();
  testSymbolsCallRowOmitsResultText();
  testDiagnosticsCallRowOmitsResultText();
  testWorkspaceSymbolsCallRowOmitsResultText();

  console.log("\nAll tests PASS\n");
}

main();
