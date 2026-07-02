/**
 * LSP tool guidance contract tests — Vitest.
 *
 * Verifies that every registered LSP tool has precise metadata: name, label,
 * description, parameter descriptions, prompt snippet, and prompt guidelines.
 * In particular, this is the position-tool guidance contract (1-based line and
 * column) and the workspace-symbol query guidance contract (the `file`
 * parameter is a routing file, not a search scope).
 */

import { describe, it, expect } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import lspExtension from "../index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
	return {
		registerTool: (tool) => {
			captured.push(tool as ToolDefinition);
		},
		on: () => {},
	} as unknown as ExtensionAPI;
}

async function registerLsp(): Promise<ToolDefinition[]> {
	const tools: ToolDefinition[] = [];
	await lspExtension(makeFakeApi(tools));
	return tools;
}

const EXPECTED_TOOLS = [
	"lsp_definition",
	"lsp_references",
	"lsp_hover",
	"lsp_document_symbols",
	"lsp_implementation",
	"lsp_workspace_symbols",
	"lsp_incoming_calls",
	"lsp_outgoing_calls",
	"lsp_diagnostics",
];

describe("LSP tool registration", () => {
	it("registers the expected LSP tool set", async () => {
		const tools = await registerLsp();
		const names = tools.map((t) => t.name).toSorted();
		expect(names).toEqual(EXPECTED_TOOLS.toSorted());
	});

	it("each tool has a non-empty label and description with no placeholders", async () => {
		const tools = await registerLsp();
		for (const tool of tools) {
			expect(tool.label.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.description.includes("TODO")).toBe(false);
		}
	});

	it("every parameter has a description", async () => {
		const tools = await registerLsp();
		for (const tool of tools) {
			const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
			for (const [key, schema] of Object.entries(props)) {
				const desc = (schema as { description?: unknown }).description;
				expect(
					typeof desc === "string" && desc.length > 0,
					`${tool.name}.${key} should have a description`,
				).toBe(true);
			}
		}
	});
});

describe("position tool guidance (1-based line and column)", () => {
	it("every position-style tool documents line and column as 1-based", async () => {
		const tools = await registerLsp();
		for (const tool of tools) {
			const props = (tool.parameters as { properties: Record<string, { description?: string }> })
				.properties;
			if (props.line) {
				expect(
					props.line.description?.includes("1-based"),
					`${tool.name} line should be documented as 1-based`,
				).toBe(true);
			}
			if (props.column) {
				expect(
					props.column.description?.includes("1-based"),
					`${tool.name} column should be documented as 1-based`,
				).toBe(true);
			}
		}
	});
});

describe("prompt guidance", () => {
	it("every tool has a prompt snippet and prompt guidelines", async () => {
		const tools = await registerLsp();
		for (const tool of tools) {
			expect(tool.promptSnippet && tool.promptSnippet.length > 0).toBe(true);
			expect(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines!.length > 0).toBe(
				true,
			);
		}
	});
});

describe("workspace symbol query guidance (routing file wording)", () => {
	it("lsp_workspace_symbols description and `file` parameter call out the routing-file role", async () => {
		const tools = await registerLsp();
		const sym = tools.find((t) => t.name === "lsp_workspace_symbols");
		expect(sym).toBeDefined();
		expect(sym!.description.includes("routes to the right server")).toBe(true);
		const fileDesc = (sym!.parameters as { properties: { file: { description: string } } })
			.properties.file.description;
		expect(fileDesc.includes("routes to the right server")).toBe(true);
	});
});
