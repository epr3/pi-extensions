/**
 * Behavior tests for the Agent tool call/result rendering contract.
 *
 * Verifies that every Agent call visibly identifies the subagent type and
 * description in the tool call row, and that the result text stays clean
 * (no UI-only type prefix).
 *
 * Uses a plain theme that strips ANSI codes, so tests verify the visible
 * text contract without depending on exact styling.
 *
 * Run:  npx tsx tests/agent-tool-row-rendering.test.ts
 */

import { strict as assert } from "node:assert";
import { renderAgentCall, renderAgentResult, type StreamEntry } from "../packages/subagents/index.ts";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through. This lets tests
// verify the visible string contract without depending on exact styling.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderText(type: string, description: string): string[] {
  const component = renderAgentCall({ subagent_type: type, description }, plainTheme);
  return component.render(80);
}

function renderedText(type: string, description: string): string {
  return renderText(type, description).join("\n");
}

// ---------------------------------------------------------------------------
// renderAgentCall tests
// ---------------------------------------------------------------------------

function testShowsToolName() {
  for (const type of ["explore", "researcher", "general"] as const) {
    const text = renderedText(type, "Some task");
    assert.ok(text.includes("Agent"), `Agent tool name visible for ${type}`);
  }
  console.log("  Shows tool name .................................... PASS");
}

function testShowsSubagentType() {
  const cases: Array<{ type: string; label: string }> = [
    { type: "explore", label: "explore" },
    { type: "researcher", label: "researcher" },
    { type: "general", label: "general" },
  ];
  for (const { type, label } of cases) {
    const text = renderedText(type, "Any description");
    assert.ok(text.includes(label), `type "${label}" appears in rendered call`);
  }
  console.log("  Shows subagent type ............................... PASS");
}

function testShowsDescription() {
  const desc = "Explore the codebase for patterns";
  const text = renderedText("explore", desc);
  assert.ok(text.includes(desc), "description appears in rendered call");
  console.log("  Shows description ................................. PASS");
}

function testAllTypesRenderCorrectly() {
  const descriptions = {
    explore: "Read-only codebase discovery",
    researcher: "Read-only web research (web + read)",
    general: "Scoped read/write work off the main context",
  } as const;

  for (const [type, desc] of Object.entries(descriptions)) {
    const text = renderedText(type, desc);
    assert.ok(text.includes(type), `type "${type}" in rendered call`);
    assert.ok(text.includes(desc), `description for "${type}" in rendered call`);
    assert.ok(text.includes("Agent"), `Agent name for "${type}" in rendered call`);
  }
  console.log("  All types render correctly ........................ PASS");
}

function testReturnsRenderable() {
  const component = renderAgentCall(
    { subagent_type: "explore", description: "test" },
    plainTheme,
  );
  // Duck-type check: must have a render() method
  assert.ok(typeof component.render === "function", "returns a renderable component");
  const lines = component.render(80);
  assert.ok(Array.isArray(lines), "render() returns an array");
  assert.ok(lines.length > 0, "render() returns at least one line");
  console.log("  Returns renderable component ...................... PASS");
}

function testTypeNotFirstWord() {
  // Structural: the rendered call row starts with the tool name, not a bare
  // type string. This ensures the type label only appears in the call row
  // and never leaks as a standalone prefix into the result area.
  const text = renderedText("explore", "short task");
  const trimmed = text.trim();
  assert.ok(trimmed.startsWith("Agent"), "call row starts with tool name, not bare type");
  assert.ok(!trimmed.startsWith("explore"), "type is not the first word in call row");
  console.log("  Type not first word ............................... PASS");
}

// ---------------------------------------------------------------------------
// renderAgentResult tests
// ---------------------------------------------------------------------------

function renderResultText(result: any, options: { expanded: boolean; isPartial: boolean }): string {
  const component = renderAgentResult(result, options, plainTheme, undefined);
  return component.render(80).join("\n");
}

function makePartialResult(entries: StreamEntry[]) {
  const lines: string[] = [];
  let textBuffer = "";
  for (const e of entries) {
    if (e.type === "text") {
      textBuffer += e.text;
      continue;
    }
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = "";
    }
    const marker = e.type === "tool_start" ? "▶" : e.error ? "✗" : "✓";
    lines.push(`${marker} ${e.name}`);
  }
  if (textBuffer) lines.push(textBuffer);
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { streamEntries: entries, streamText: lines.join("\n") },
  };
}

function testFinalResultRendersCleanAnswer() {
  const result = {
    content: [{ type: "text" as const, text: "Clean final answer." }],
    details: { agent_id: "sa_abc", status: "completed", tokens: 10, toolUses: 1 },
  };
  const text = renderResultText(result, { expanded: false, isPartial: false });
  assert.ok(text.includes("Clean final answer."), "final answer rendered");
  assert.ok(!text.includes("▶"), "no tool markers in final result");
  assert.ok(!text.includes("streamText"), "no stream metadata in final result");
  console.log("  Final result renders clean answer ................. PASS");
}

function testExpandedStreamInterleavesTextAndTools() {
  const entries: StreamEntry[] = [
    { type: "text", text: "Looking..." },
    { type: "tool_start", name: "read" },
    { type: "tool_end", name: "read", error: false },
    { type: "text", text: "Found it." },
  ];
  const text = renderResultText(makePartialResult(entries), { expanded: true, isPartial: true });
  assert.ok(text.includes("Looking..."), "assistant text appears");
  assert.ok(text.includes("▶ read"), "tool start marker appears");
  assert.ok(text.includes("✓ read"), "tool success marker appears");
  assert.ok(text.includes("Found it."), "later text appears");
  console.log("  Expanded stream interleaves text and tools ........ PASS");
}

function testExpandedStreamShowsToolError() {
  const entries: StreamEntry[] = [
    { type: "tool_start", name: "bash" },
    { type: "tool_end", name: "bash", error: true },
  ];
  const text = renderResultText(makePartialResult(entries), { expanded: true, isPartial: true });
  assert.ok(text.includes("▶ bash"), "tool start marker appears");
  assert.ok(text.includes("✗ bash"), "tool error marker appears");
  assert.ok(!text.includes("✓ bash"), "no success marker for failed tool");
  console.log("  Expanded stream shows tool error marker ........... PASS");
}

function testCollapsedStreamShowsLatestToolStart() {
  const entries: StreamEntry[] = [
    { type: "text", text: "Starting search." },
    { type: "tool_start", name: "grep" },
  ];
  const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
  assert.strictEqual(text.trim(), "▶ grep", "collapsed row shows latest tool start");
  console.log("  Collapsed stream shows latest tool start .......... PASS");
}

function testCollapsedStreamShowsLatestToolEnd() {
  const entries: StreamEntry[] = [
    { type: "tool_start", name: "read" },
    { type: "tool_end", name: "read", error: false },
  ];
  const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
  assert.strictEqual(text.trim(), "✓ read", "collapsed row shows latest tool end");
  console.log("  Collapsed stream shows latest tool end ............ PASS");
}

function testCollapsedStreamShowsLatestToolError() {
  const entries: StreamEntry[] = [
    { type: "tool_start", name: "bash" },
    { type: "tool_end", name: "bash", error: true },
  ];
  const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
  assert.strictEqual(text.trim(), "✗ bash", "collapsed row shows latest tool error");
  console.log("  Collapsed stream shows latest tool error .......... PASS");
}

function testCollapsedStreamFallsBackToLatestText() {
  const entries: StreamEntry[] = [
    { type: "tool_start", name: "read" },
    { type: "tool_end", name: "read", error: false },
    { type: "text", text: "Almost done." },
  ];
  const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
  assert.strictEqual(text.trim(), "Almost done.", "collapsed row shows latest text when no tool is last");
  console.log("  Collapsed stream falls back to latest text ........ PASS");
}

function testCollapsedStreamTruncatesLongText() {
  const longLine = "a".repeat(80);
  const entries: StreamEntry[] = [{ type: "text", text: longLine }];
  const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
  assert.strictEqual(text.trim().length, 61, "collapsed tail is 60 chars + ellipsis");
  assert.ok(text.trim().startsWith("…"), "collapsed tail is prefixed with ellipsis");
  console.log("  Collapsed stream truncates long text .............. PASS");
}

function testRendererIgnoresUnknownEntryTypes() {
  // The runner never forwards thinking_delta, so the renderer should only see
  // text/tool entries. This test guards against a stray unknown entry crashing
  // the renderer.
  const entries = [
    { type: "text", text: "Hello " },
    { type: "unknown", name: "bad" },
    { type: "text", text: "world" },
  ] as unknown as StreamEntry[];
  const text = renderResultText(makePartialResult(entries), { expanded: true, isPartial: true });
  assert.ok(text.includes("Hello "), "text before unknown entry rendered");
  assert.ok(text.includes("world"), "text after unknown entry rendered");
  console.log("  Renderer tolerates unknown entry types ............ PASS");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function main() {
  console.log("\nAgent tool row rendering tests\n");

  testShowsToolName();
  testShowsSubagentType();
  testShowsDescription();
  testAllTypesRenderCorrectly();
  testReturnsRenderable();
  testTypeNotFirstWord();

  // Result rendering
  testFinalResultRendersCleanAnswer();
  testExpandedStreamInterleavesTextAndTools();
  testExpandedStreamShowsToolError();
  testCollapsedStreamShowsLatestToolStart();
  testCollapsedStreamShowsLatestToolEnd();
  testCollapsedStreamShowsLatestToolError();
  testCollapsedStreamFallsBackToLatestText();
  testCollapsedStreamTruncatesLongText();
  testRendererIgnoresUnknownEntryTypes();

  console.log("\nAll tests PASS\n");
}

main();
