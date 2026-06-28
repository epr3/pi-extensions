/**
 * Behavior tests for LSP navigation tool result rendering.
 *
 * Covers structured details rendering for:
 *   - Location-based results (definition, references, implementation)
 *   - Call hierarchy results (incoming_calls, outgoing_calls)
 *   - Empty results (no definitions found, etc.)
 *   - Fallback text rendering when structured details are absent
 *   - Compact call-row preservation (no result text leakage)
 *
 * Uses a plain theme that strips ANSI codes, so tests verify the visible
 * text contract without depending on exact styling.
 *
 * Run: node --experimental-strip-types tests/lsp-navigation-result-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import {
  renderLspNavigationResult,
} from "../packages/lsp/render-result.ts";
import type {
  LspNavigationDetails,
  LspLocationRecord,
  LspCallRecord,
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
// Location-based results (definition, references, implementation)
// ---------------------------------------------------------------------------

function testDefinitionWithLocationsCollapsed() {
  const result = {
    content: [{ type: "text" as const, text: "src/lib.ts:10:5  const x = 1" }],
    details: {
      resultKind: "definition",
      locations: [
        { file: "src/lib.ts", line: 10, column: 5, snippet: "const x = 1" },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("1 location"), "collapsed definition shows count");
  assert.ok(text.includes("src/lib.ts:10:5"), "collapsed definition shows first location");
  console.log("  Definition with locations (collapsed) ............. PASS");
}

function testDefinitionWithLocationsExpanded() {
  const result = {
    content: [{ type: "text" as const, text: "src/lib.ts:10:5  const x = 1" }],
    details: {
      resultKind: "definition",
      locations: [
        { file: "src/lib.ts", line: 10, column: 5, snippet: "const x = 1" },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("src/lib.ts:10:5"), "expanded definition shows location");
  assert.ok(text.includes("const x = 1"), "expanded definition shows snippet");
  console.log("  Definition with locations (expanded) .............. PASS");
}

function testReferencesMultipleLocations() {
  const result = {
    content: [{ type: "text" as const, text: "src/a.ts:5:3  foo()" }],
    details: {
      resultKind: "references",
      locations: [
        { file: "src/a.ts", line: 5, column: 3, snippet: "foo()" },
        { file: "src/b.ts", line: 12, column: 1, snippet: "bar()" },
        { file: "src/c.ts", line: 8, column: 7, snippet: "baz()" },
      ],
    } satisfies LspNavigationDetails,
  };
  const collapsed = resultText(result, { expanded: false });
  assert.ok(collapsed.includes("3 locations"), "collapsed references shows count");
  assert.ok(collapsed.includes("src/a.ts:5:3"), "collapsed references shows first loc");

  const expanded = resultText(result, { expanded: true });
  assert.ok(expanded.includes("src/a.ts:5:3"), "expanded shows first ref");
  assert.ok(expanded.includes("src/b.ts:12:1"), "expanded shows second ref");
  assert.ok(expanded.includes("src/c.ts:8:7"), "expanded shows third ref");
  assert.ok(expanded.includes("foo()"), "expanded shows first snippet");
  assert.ok(expanded.includes("baz()"), "expanded shows third snippet");
  console.log("  References multiple locations ..................... PASS");
}

function testImplementationWithLocations() {
  const result = {
    content: [{ type: "text" as const, text: "src/impl.ts:42:1  class Impl" }],
    details: {
      resultKind: "implementation",
      locations: [
        { file: "src/impl.ts", line: 42, column: 1, snippet: "class Impl implements Iface" },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("1 location"), "collapsed implementation shows count");
  console.log("  Implementation with locations ..................... PASS");
}

// ---------------------------------------------------------------------------
// Call hierarchy results (incoming, outgoing)
// ---------------------------------------------------------------------------

function testIncomingCallsCollapsed() {
  const result = {
    content: [{ type: "text" as const, text: "function caller  src/main.ts:20:3" }],
    details: {
      resultKind: "incomingCalls",
      calls: [
        { kind: "function", name: "caller", file: "src/main.ts", line: 20, column: 3 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: false });
  assert.ok(text.includes("1 caller"), "collapsed incoming shows count");
  assert.ok(text.includes("caller"), "collapsed incoming shows first call name");
  assert.ok(text.includes("src/main.ts:20:3"), "collapsed incoming shows location");
  console.log("  Incoming calls (collapsed) ........................ PASS");
}

function testIncomingCallsExpanded() {
  const result = {
    content: [{ type: "text" as const, text: "function caller  src/main.ts:20:3" }],
    details: {
      resultKind: "incomingCalls",
      calls: [
        { kind: "function", name: "caller", file: "src/main.ts", line: 20, column: 3 },
        { kind: "method", name: "runner", file: "src/lib.ts", line: 45, column: 7 },
      ],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result, { expanded: true });
  assert.ok(text.includes("function caller"), "expanded shows kind and name");
  assert.ok(text.includes("src/main.ts:20:3"), "expanded shows first location");
  assert.ok(text.includes("method runner"), "expanded shows second call");
  assert.ok(text.includes("src/lib.ts:45:7"), "expanded shows second location");
  console.log("  Incoming calls (expanded) ......................... PASS");
}

function testOutgoingCalls() {
  const result = {
    content: [{ type: "text" as const, text: "function callee  src/util.ts:5:1" }],
    details: {
      resultKind: "outgoingCalls",
      calls: [
        { kind: "function", name: "callee", file: "src/util.ts", line: 5, column: 1 },
      ],
    } satisfies LspNavigationDetails,
  };
  const collapsed = resultText(result, { expanded: false });
  assert.ok(collapsed.includes("1 call"), "collapsed outgoing shows count");
  assert.ok(collapsed.includes("callee"), "collapsed outgoing shows call name");

  const expanded = resultText(result, { expanded: true });
  assert.ok(expanded.includes("function callee"), "expanded outgoing shows kind and name");
  assert.ok(expanded.includes("src/util.ts:5:1"), "expanded outgoing shows location");
  console.log("  Outgoing calls .................................... PASS");
}

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

function testEmptyDefinition() {
  const result = {
    content: [{ type: "text" as const, text: "no definition found" }],
    details: {
      resultKind: "definition",
      locations: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no definition found"), "empty definition shows message");
  assert.ok(!text.includes("✓"), "no checkmark");
  console.log("  Empty definition .................................. PASS");
}

function testEmptyReferences() {
  const result = {
    content: [{ type: "text" as const, text: "no references found" }],
    details: {
      resultKind: "references",
      locations: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no references found"), "empty references shows message");
  console.log("  Empty references .................................. PASS");
}

function testEmptyImplementations() {
  const result = {
    content: [{ type: "text" as const, text: "no implementations found" }],
    details: {
      resultKind: "implementation",
      locations: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no implementations found"), "empty implementation shows message");
  console.log("  Empty implementations ............................. PASS");
}

function testEmptyCallers() {
  const result = {
    content: [{ type: "text" as const, text: "no callers found" }],
    details: {
      resultKind: "incomingCalls",
      calls: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no callers found"), "empty callers shows message");
  console.log("  Empty callers ..................................... PASS");
}

function testEmptyOutgoing() {
  const result = {
    content: [{ type: "text" as const, text: "no outgoing calls found" }],
    details: {
      resultKind: "outgoingCalls",
      calls: [],
    } satisfies LspNavigationDetails,
  };
  const text = resultText(result);
  assert.ok(text.includes("no outgoing calls found"), "empty outgoing shows message");
  console.log("  Empty outgoing calls .............................. PASS");
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

function testFallbackWhenDetailsHasNoLocationsOrCalls() {
  const result = {
    content: [{ type: "text" as const, text: "some plain text result" }],
    details: { resultKind: "definition" },
  };
  const text = resultText(result as any);
  assert.ok(text.includes("some plain text result"), "falls back when locations/calls missing");
  console.log("  Fallback when locations/calls absent .............. PASS");
}

// ---------------------------------------------------------------------------
// Compact call-row preservation (no result text leakage)
// ---------------------------------------------------------------------------

function testCallRowOmitsResultText() {
  // Verify that the existing renderLspCall still only shows the compact
  // call summary — no result text, no structured details.
  const component = renderLspCall("LSP Definition", "pos")(
    { file: "src/lib.ts", line: 10, column: 5 },
    plainTheme,
    undefined,
  );
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.ok(text.includes("LSP Definition"), "call row shows tool label");
  assert.ok(text.includes("src/lib.ts:10:5"), "call row shows compact file:line:col");
  assert.ok(!text.includes("1 location"), "no result summary in call row");
  assert.ok(!text.includes("const x = 1"), "no result snippet in call row");
  console.log("  Call row omits result text ........................ PASS");
}

// ---------------------------------------------------------------------------
// isPartial / expanded flags (graceful noop for collapsed rendering)
// ---------------------------------------------------------------------------

function testPartialFlagDoesNotChangeResult() {
  const result = {
    content: [{ type: "text" as const, text: "src/lib.ts:10:5  const x = 1" }],
    details: {
      resultKind: "definition",
      locations: [
        { file: "src/lib.ts", line: 10, column: 5, snippet: "const x = 1" },
      ],
    } satisfies LspNavigationDetails,
  };
  const collapsed = resultText(result, { expanded: false, isPartial: false });
  const partial = resultText(result, { expanded: false, isPartial: true });
  assert.strictEqual(partial, collapsed, "isPartial flag does not change rendering");
  console.log("  Partial flag does not change rendering ............ PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nLSP navigation result rendering tests\n");

  // Location-based results
  testDefinitionWithLocationsCollapsed();
  testDefinitionWithLocationsExpanded();
  testReferencesMultipleLocations();
  testImplementationWithLocations();

  // Call hierarchy results
  testIncomingCallsCollapsed();
  testIncomingCallsExpanded();
  testOutgoingCalls();

  // Empty results
  testEmptyDefinition();
  testEmptyReferences();
  testEmptyImplementations();
  testEmptyCallers();
  testEmptyOutgoing();

  // Fallback text rendering
  testFallbackWhenDetailsMissing();
  testFallbackWhenDetailsEmpty();
  testFallbackWhenDetailsHasNoLocationsOrCalls();

  // Compact call-row preservation
  testCallRowOmitsResultText();

  // Edge cases
  testPartialFlagDoesNotChangeResult();

  console.log("\nAll tests PASS\n");
}

main();
