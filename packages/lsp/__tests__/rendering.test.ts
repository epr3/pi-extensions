/**
 * LSP rendering tests — Vitest.
 *
 * Covers the user-facing presentation of LSP tool calls and results:
 *   - formatLspCallSummary + renderLspCall (tool invocation summary)
 *   - renderLspNavigationResult for locations / call hierarchy
 *   - renderLspNavigationResult for document + workspace symbols
 *   - renderLspNavigationResult for hover
 *   - renderLspNavigationResult for diagnostics
 *   - Fallback when structured details are absent
 *   - Compact call-row preservation (no result text leakage)
 *
 * Uses a plain theme that strips ANSI codes, so tests verify the visible
 * text contract without depending on exact styling. No real language servers
 * are spawned.
 */

import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatLspCallSummary, renderLspCall } from "../render-call.ts";
import { renderLspNavigationResult } from "../render-result.ts";
import type { ParamKind } from "../tools.ts";
import type {
	LspCallRecord,
	LspDiagnosticRecord,
	LspHoverRecord,
	LspLocationRecord,
	LspNavigationDetails,
	LspSymbolRecord,
} from "../render-result.ts";

// Plain theme: pass-through, no styling.
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedCall(label: string, kind: ParamKind, args: Record<string, unknown>): string {
	const component = renderLspCall(label, kind)(args, plainTheme, undefined);
	return component.render(80).join("\n");
}

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
// formatLspCallSummary — tool invocation summary
// ---------------------------------------------------------------------------

describe("formatLspCallSummary", () => {
	it("position summary keeps 1-based line:column", () => {
		const summary = formatLspCallSummary("pos", {
			file: "src/lib.ts",
			line: 12,
			column: 5,
		});
		expect(summary).toBe("src/lib.ts:12:5");
	});

	it("reference summary keeps 1-based line:column", () => {
		const summary = formatLspCallSummary("ref", {
			file: "src/lib.ts",
			line: 7,
			column: 3,
			includeDeclaration: true,
		});
		expect(summary).toBe("src/lib.ts:7:3");
	});

	it("file summary renders path only", () => {
		expect(formatLspCallSummary("file", { file: "src/lib.ts" })).toBe("src/lib.ts");
	});

	it("query summary joins query and routing file with ' via '", () => {
		const summary = formatLspCallSummary("query", {
			query: "LspManager",
			file: "packages/lsp/tools.ts",
		});
		expect(summary).toContain("LspManager");
		expect(summary).toContain("packages/lsp/tools.ts");
		expect(summary).toContain(" via ");
	});

	it("query summary leads with the query, not the routing file", () => {
		// The routing file chooses the language server; the search is project-wide.
		const summary = formatLspCallSummary("query", {
			query: "formatLspCallSummary",
			file: "packages/lsp/render-call.ts",
		});
		expect(summary.startsWith("formatLspCallSummary")).toBe(true);
		expect(summary.startsWith("packages/lsp/render-call.ts")).toBe(false);
	});

	it("summary format is compact and echoes only caller-supplied args", () => {
		expect(
			formatLspCallSummary("pos", { file: "src/a.ts", line: 3, column: 7 }),
		).toBe("src/a.ts:3:7");
		expect(
			formatLspCallSummary("ref", { file: "src/b.ts", line: 4, column: 8 }),
		).toBe("src/b.ts:4:8");
		expect(formatLspCallSummary("file", { file: "src/c.ts" })).toBe("src/c.ts");
		expect(formatLspCallSummary("query", { query: "foo", file: "src/d.ts" })).toBe(
			"foo via src/d.ts",
		);
	});
});

// ---------------------------------------------------------------------------
// renderLspCall — call row
// ---------------------------------------------------------------------------

describe("renderLspCall", () => {
	it("returns a renderable component producing at least one line", () => {
		const component = renderLspCall("LSP Definition", "pos")(
			{ file: "src/lib.ts", line: 1, column: 1 },
			plainTheme,
			undefined,
		);
		expect(typeof component.render).toBe("function");
		const lines = component.render(80);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("position call row shows tool label and 1-based path:line:col", () => {
		const text = renderedCall("LSP Definition", "pos", {
			file: "src/lib.ts",
			line: 10,
			column: 2,
		});
		expect(text).toContain("LSP Definition");
		expect(text).toContain("src/lib.ts:10:2");
	});

	it("reference call row shows tool label and 1-based path:line:col", () => {
		const text = renderedCall("LSP References", "ref", {
			file: "src/lib.ts",
			line: 20,
			column: 8,
		});
		expect(text).toContain("LSP References");
		expect(text).toContain("src/lib.ts:20:8");
	});

	it("file call row shows path with no line/column", () => {
		const text = renderedCall("LSP Symbols", "file", { file: "src/lib.ts" });
		expect(text).toContain("LSP Symbols");
		expect(text).toContain("src/lib.ts");
		expect(text).not.toContain(":");
	});

	it("workspace-symbol call row shows query and routing file with ' via '", () => {
		const text = renderedCall("LSP Workspace Symbols", "query", {
			query: "LspManager",
			file: "packages/lsp/tools.ts",
		});
		expect(text).toContain("LSP Workspace Symbols");
		expect(text).toContain("LspManager");
		expect(text).toContain("packages/lsp/tools.ts");
		expect(text).toContain(" via ");
	});

	it("call row omits result text and any language-server log labels", () => {
		const text = renderedCall("LSP Hover", "pos", {
			file: "src/lib.ts",
			line: 5,
			column: 1,
		});
		expect(text).not.toContain("no hover info");
		expect(text).not.toContain("stdout");
		expect(text).not.toContain("stderr");
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — locations (definition, references, implementation)
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — locations", () => {
	it("collapsed definition shows count and first location", () => {
		const result = {
			content: [{ type: "text" as const, text: "src/lib.ts:10:5  const x = 1" }],
			details: {
				resultKind: "definition",
				locations: [
					{ file: "src/lib.ts", line: 10, column: 5, snippet: "const x = 1" } satisfies LspLocationRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("1 location");
		expect(text).toContain("src/lib.ts:10:5");
	});

	it("expanded definition shows every location and snippet", () => {
		const result = {
			content: [{ type: "text" as const, text: "src/lib.ts:10:5  const x = 1" }],
			details: {
				resultKind: "definition",
				locations: [
					{ file: "src/lib.ts", line: 10, column: 5, snippet: "const x = 1" } satisfies LspLocationRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("src/lib.ts:10:5");
		expect(text).toContain("const x = 1");
	});

	it("references: collapsed shows count and first; expanded shows every ref", () => {
		const result = {
			content: [{ type: "text" as const, text: "src/a.ts:5:3  foo()" }],
			details: {
				resultKind: "references",
				locations: [
					{ file: "src/a.ts", line: 5, column: 3, snippet: "foo()" } satisfies LspLocationRecord,
					{ file: "src/b.ts", line: 12, column: 1, snippet: "bar()" } satisfies LspLocationRecord,
					{ file: "src/c.ts", line: 8, column: 7, snippet: "baz()" } satisfies LspLocationRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const collapsed = resultText(result, { expanded: false });
		expect(collapsed).toContain("3 locations");
		expect(collapsed).toContain("src/a.ts:5:3");

		const expanded = resultText(result, { expanded: true });
		expect(expanded).toContain("src/a.ts:5:3");
		expect(expanded).toContain("src/b.ts:12:1");
		expect(expanded).toContain("src/c.ts:8:7");
		expect(expanded).toContain("foo()");
		expect(expanded).toContain("baz()");
	});

	it("collapsed implementation shows count", () => {
		const result = {
			content: [{ type: "text" as const, text: "src/impl.ts:42:1  class Impl" }],
			details: {
				resultKind: "implementation",
				locations: [
					{
						file: "src/impl.ts",
						line: 42,
						column: 1,
						snippet: "class Impl implements Iface",
					} satisfies LspLocationRecord,
				],
			} satisfies LspNavigationDetails,
		};
		expect(resultText(result, { expanded: false })).toContain("1 location");
	});

	it("empty definition shows 'no definition found' and no checkmark", () => {
		const result = {
			content: [{ type: "text" as const, text: "no definition found" }],
			details: {
				resultKind: "definition",
				locations: [],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result);
		expect(text).toContain("no definition found");
		expect(text).not.toContain("✓");
	});

	it("empty references shows 'no references found'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no references found" }],
			details: { resultKind: "references", locations: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no references found");
	});

	it("empty implementations shows 'no implementations found'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no implementations found" }],
			details: { resultKind: "implementation", locations: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no implementations found");
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — call hierarchy (incoming, outgoing)
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — call hierarchy", () => {
	it("incoming calls: collapsed shows count, name, and location", () => {
		const result = {
			content: [{ type: "text" as const, text: "function caller  src/main.ts:20:3" }],
			details: {
				resultKind: "incomingCalls",
				calls: [
					{ kind: "function", name: "caller", file: "src/main.ts", line: 20, column: 3 } satisfies LspCallRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("1 caller");
		expect(text).toContain("caller");
		expect(text).toContain("src/main.ts:20:3");
	});

	it("incoming calls: expanded shows kind, name, and location for each", () => {
		const result = {
			content: [{ type: "text" as const, text: "function caller  src/main.ts:20:3" }],
			details: {
				resultKind: "incomingCalls",
				calls: [
					{ kind: "function", name: "caller", file: "src/main.ts", line: 20, column: 3 } satisfies LspCallRecord,
					{ kind: "method", name: "runner", file: "src/lib.ts", line: 45, column: 7 } satisfies LspCallRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("function caller");
		expect(text).toContain("src/main.ts:20:3");
		expect(text).toContain("method runner");
		expect(text).toContain("src/lib.ts:45:7");
	});

	it("outgoing calls: collapsed shows count and name; expanded shows kind+name+location", () => {
		const result = {
			content: [{ type: "text" as const, text: "function callee  src/util.ts:5:1" }],
			details: {
				resultKind: "outgoingCalls",
				calls: [
					{ kind: "function", name: "callee", file: "src/util.ts", line: 5, column: 1 } satisfies LspCallRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const collapsed = resultText(result, { expanded: false });
		expect(collapsed).toContain("1 call");
		expect(collapsed).toContain("callee");
		const expanded = resultText(result, { expanded: true });
		expect(expanded).toContain("function callee");
		expect(expanded).toContain("src/util.ts:5:1");
	});

	it("empty incoming calls shows 'no callers found'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no callers found" }],
			details: { resultKind: "incomingCalls", calls: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no callers found");
	});

	it("empty outgoing calls shows 'no outgoing calls found'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no outgoing calls found" }],
			details: { resultKind: "outgoingCalls", calls: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no outgoing calls found");
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — document + workspace symbols
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — document symbols", () => {
	it("collapsed shows top-level count, kind, name, and line", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "class Foo  (line 1)\n  function bar  (line 5)" },
			],
			details: {
				resultKind: "documentSymbols",
				symbols: [
					{
						name: "Foo",
						kind: "class",
						line: 1,
						children: [
							{ name: "bar", kind: "function", line: 5 } satisfies LspSymbolRecord,
						],
					} satisfies LspSymbolRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("1 symbol");
		expect(text).toContain("class Foo");
		expect(text).toContain("(line 1)");
	});

	it("expanded shows parent and indented child", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "class Foo  (line 1)\n  function bar  (line 5)" },
			],
			details: {
				resultKind: "documentSymbols",
				symbols: [
					{
						name: "Foo",
						kind: "class",
						line: 1,
						children: [
							{ name: "bar", kind: "function", line: 5 } satisfies LspSymbolRecord,
						],
					} satisfies LspSymbolRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("class Foo");
		expect(text).toContain("(line 1)");
		expect(text).toContain("function bar");
		expect(text).toContain("(line 5)");
		const lines = text.split("\n");
		const barLine = lines.find((l) => l.includes("bar"));
		expect(barLine?.startsWith("  ")).toBe(true);
	});

	it("flat (no children) list collapses to count and shows both entries expanded", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "function a  (line 1)\nfunction b  (line 5)" },
			],
			details: {
				resultKind: "documentSymbols",
				symbols: [
					{ name: "a", kind: "function", line: 1 } satisfies LspSymbolRecord,
					{ name: "b", kind: "function", line: 5 } satisfies LspSymbolRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const collapsed = resultText(result, { expanded: false });
		expect(collapsed).toContain("2 symbols");
		expect(collapsed).toContain("function a");
		const expanded = resultText(result, { expanded: true });
		expect(expanded).toContain("function a");
		expect(expanded).toContain("function b");
	});

	it("empty document symbols shows 'no symbols'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no symbols" }],
			details: { resultKind: "documentSymbols", symbols: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no symbols");
	});
});

describe("renderLspNavigationResult — workspace symbols", () => {
	it("collapsed shows count, kind+name, and line", () => {
		const result = {
			content: [{ type: "text" as const, text: "class LspManager  packages/lsp/tools.ts:10" }],
			details: {
				resultKind: "workspaceSymbols",
				symbols: [{ name: "LspManager", kind: "class", line: 10 } satisfies LspSymbolRecord],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("1 symbol");
		expect(text).toContain("class LspManager");
		expect(text).toContain("(line 10)");
	});

	it("expanded shows every symbol and its line", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				resultKind: "workspaceSymbols",
				symbols: [
					{ name: "LspManager", kind: "class", line: 10 } satisfies LspSymbolRecord,
					{ name: "connect", kind: "method", line: 42 } satisfies LspSymbolRecord,
					{ name: "disconnect", kind: "method", line: 100 } satisfies LspSymbolRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("class LspManager");
		expect(text).toContain("method connect");
		expect(text).toContain("method disconnect");
		expect(text).toContain("(line 10)");
		expect(text).toContain("(line 100)");
	});

	it("empty workspace symbols shows 'no symbols found'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no symbols found" }],
			details: { resultKind: "workspaceSymbols", symbols: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no symbols found");
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — hover
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — hover", () => {
	it("collapsed shows 'hover' keyword and the first line of content", () => {
		const result = {
			content: [{ type: "text" as const, text: "const x: number" }],
			details: {
				resultKind: "hover",
				hover: { found: true, content: "const x: number" } satisfies LspHoverRecord,
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("hover");
		expect(text).toContain("const x: number");
	});

	it("expanded shows the full hover content", () => {
		const result = {
			content: [
				{ type: "text" as const, text: "const x: number\n\nThe value of x, default 42." },
			],
			details: {
				resultKind: "hover",
				hover: {
					found: true,
					content: "const x: number\n\nThe value of x, default 42.",
				} satisfies LspHoverRecord,
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("const x: number");
		expect(text).toContain("The value of x");
	});

	it("hover not found shows 'no hover info'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no hover info" }],
			details: {
				resultKind: "hover",
				hover: { found: false } satisfies LspHoverRecord,
			} satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no hover info");
	});

	it("hover with empty content falls back to 'no hover info'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no hover info" }],
			details: {
				resultKind: "hover",
				hover: { found: true, content: "" } satisfies LspHoverRecord,
			} satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no hover info");
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — diagnostics
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — diagnostics", () => {
	it("collapsed mixes errors, warnings, and the rest count", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				resultKind: "diagnostics",
				diagnostics: [
					{
						severity: "error",
						message: "Type 'X' is not assignable",
						file: "src/a.ts",
						line: 10,
						column: 5,
					} satisfies LspDiagnosticRecord,
					{
						severity: "error",
						message: "Cannot find name 'Y'",
						file: "src/a.ts",
						line: 15,
						column: 3,
					} satisfies LspDiagnosticRecord,
					{
						severity: "warning",
						message: "Variable 'z' is unused",
						file: "src/a.ts",
						line: 20,
						column: 7,
					} satisfies LspDiagnosticRecord,
					{
						severity: "info",
						message: "Missing return type",
						file: "src/a.ts",
						line: 25,
						column: 1,
					} satisfies LspDiagnosticRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("4 diagnostics");
		expect(text).toContain("2 err");
		expect(text).toContain("1 warn");
		expect(text).toContain("1 more");
	});

	it("collapsed with errors only shows the error count and skips zero warnings", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				resultKind: "diagnostics",
				diagnostics: [
					{
						severity: "error",
						message: "Type mismatch",
						file: "src/a.ts",
						line: 5,
						column: 1,
					} satisfies LspDiagnosticRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: false });
		expect(text).toContain("1 diagnostic");
		expect(text).toContain("1 err");
		expect(text).not.toContain("0 warn");
	});

	it("expanded shows severity, location, and message for every diagnostic", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				resultKind: "diagnostics",
				diagnostics: [
					{
						severity: "error",
						message: "Type 'X' is not assignable",
						file: "src/a.ts",
						line: 10,
						column: 5,
					} satisfies LspDiagnosticRecord,
					{
						severity: "warning",
						message: "Unused variable 'z'",
						file: "src/a.ts",
						line: 20,
						column: 7,
					} satisfies LspDiagnosticRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("err");
		expect(text).toContain("warn");
		expect(text).toContain("err src/a.ts:10:5");
		expect(text).toContain("Type 'X' is not assignable");
		expect(text).toContain("src/a.ts:20:7");
		expect(text).toContain("Unused variable 'z'");
	});

	it("empty diagnostics shows 'no diagnostics'", () => {
		const result = {
			content: [{ type: "text" as const, text: "no diagnostics" }],
			details: { resultKind: "diagnostics", diagnostics: [] } satisfies LspNavigationDetails,
		};
		expect(resultText(result)).toContain("no diagnostics");
	});

	it("expanded shows info and hint severities", () => {
		const result = {
			content: [{ type: "text" as const, text: "" }],
			details: {
				resultKind: "diagnostics",
				diagnostics: [
					{
						severity: "info",
						message: "Missing return type annotation",
						file: "src/b.ts",
						line: 3,
						column: 1,
					} satisfies LspDiagnosticRecord,
					{
						severity: "hint",
						message: "Consider using const",
						file: "src/b.ts",
						line: 7,
						column: 5,
					} satisfies LspDiagnosticRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const text = resultText(result, { expanded: true });
		expect(text).toContain("info src/b.ts:3:1");
		expect(text).toContain("hint src/b.ts:7:5");
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — fallback when structured details are absent
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — fallback text", () => {
	it("falls back to content text when details are missing", () => {
		const result = { content: [{ type: "text" as const, text: "some plain text result" }] };
		expect(resultText(result as Parameters<typeof renderLspNavigationResult>[0])).toContain(
			"some plain text result",
		);
	});

	it("falls back to content text when details are empty", () => {
		const result = {
			content: [{ type: "text" as const, text: "some plain text result" }],
			details: {},
		};
		expect(resultText(result as Parameters<typeof renderLspNavigationResult>[0])).toContain(
			"some plain text result",
		);
	});

	it("falls back when details have no locations, calls, symbols, hover, or diagnostics", () => {
		const result = {
			content: [{ type: "text" as const, text: "some plain text result" }],
			details: { resultKind: "definition" as const },
		};
		expect(resultText(result as Parameters<typeof renderLspNavigationResult>[0])).toContain(
			"some plain text result",
		);
	});
});

// ---------------------------------------------------------------------------
// renderLspNavigationResult — collapsed view ignores isPartial
// ---------------------------------------------------------------------------

describe("renderLspNavigationResult — isPartial", () => {
	it("does not change collapsed rendering when isPartial is true", () => {
		const result = {
			content: [{ type: "text" as const, text: "src/lib.ts:10:5  const x = 1" }],
			details: {
				resultKind: "definition",
				locations: [
					{ file: "src/lib.ts", line: 10, column: 5, snippet: "const x = 1" } satisfies LspLocationRecord,
				],
			} satisfies LspNavigationDetails,
		};
		const collapsed = resultText(result, { expanded: false, isPartial: false });
		const partial = resultText(result, { expanded: false, isPartial: true });
		expect(partial).toBe(collapsed);
	});
});

// ---------------------------------------------------------------------------
// Compact call-row preservation (no result text leakage into renderLspCall)
// ---------------------------------------------------------------------------

describe("renderLspCall — no result text leakage", () => {
	it("definition call row shows label and position only, no result summary", () => {
		const component = renderLspCall("LSP Definition", "pos")(
			{ file: "src/lib.ts", line: 10, column: 5 },
			plainTheme,
			undefined,
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("LSP Definition");
		expect(text).toContain("src/lib.ts:10:5");
		expect(text).not.toContain("1 location");
		expect(text).not.toContain("const x = 1");
	});

	it("symbols call row shows label and file only, no symbol result word", () => {
		const text = renderedCall("LSP Symbols", "file", { file: "src/lib.ts" });
		expect(text).toContain("LSP Symbols");
		expect(text).toContain("src/lib.ts");
		expect(text).not.toContain("symbol");
	});

	it("diagnostics call row shows label and file only, no err/warn labels", () => {
		const text = renderedCall("LSP Diagnostics", "file", { file: "src/a.ts" });
		expect(text).toContain("LSP Diagnostics");
		expect(text).toContain("src/a.ts");
		expect(text).not.toContain("err");
		expect(text).not.toContain("warn");
	});

	it("workspace-symbols call row shows label, query, and routing file only", () => {
		const text = renderedCall("LSP Workspace Symbols", "query", {
			query: "LspManager",
			file: "packages/lsp/tools.ts",
		});
		expect(text).toContain("LSP Workspace Symbols");
		expect(text).toContain("LspManager");
		expect(text).toContain("packages/lsp/tools.ts");
		expect(text).toContain(" via ");
		expect(text).not.toContain("symbol");
	});
});
