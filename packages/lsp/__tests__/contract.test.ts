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

/** Registered Tool guidance = description + snippet + guidelines. */
function guidanceOf(tool: ToolDefinition): string {
  return [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])].join("\n");
}

function allGuidance(tools: ToolDefinition[]): string {
  return tools.map(guidanceOf).join("\n");
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
      expect(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines!.length > 0).toBe(true);
    }
  });
});

describe("semantic navigation preference guidance", () => {
  it("every tool expresses the LSP-first preference over text tools", async () => {
    const tools = await registerLsp();
    for (const tool of tools) {
      const guidance = guidanceOf(tool).toLowerCase();
      expect(
        /first|prefer/.test(guidance),
        `${tool.name} guidance should express trying LSP first/preference`,
      ).toBe(true);
      expect(
        /grep|\bfind\b|\bread\b/.test(guidance),
        `${tool.name} guidance should reference the text tools it is preferred over`,
      ).toBe(true);
    }
  });

  it("guidance permits text search or inspection to locate an identifier or position", async () => {
    const tools = await registerLsp();
    const guidance = allGuidance(tools).toLowerCase();
    expect(/locate|find/.test(guidance)).toBe(true);
    expect(/position|identifier/.test(guidance)).toBe(true);
  });

  it("guidance directs textual and non-code questions to textual tools", async () => {
    const tools = await registerLsp();
    const guidance = allGuidance(tools).toLowerCase();
    expect(/comments/.test(guidance)).toBe(true);
    expect(/non-code/.test(guidance)).toBe(true);
    expect(/grep|\bread\b|\bfind\b/.test(guidance)).toBe(true);
  });

  it("guidance supports fallback on unavailable, failed, timed-out, or unhelpful responses and names consequential uncertainty", async () => {
    const tools = await registerLsp();
    const guidance = allGuidance(tools).toLowerCase();
    expect(/fallback|fall back/.test(guidance)).toBe(true);
    expect(/unavailable|fails|times out|error/.test(guidance)).toBe(true);
    expect(/unhelpful/.test(guidance)).toBe(true);
    expect(/uncertain/.test(guidance)).toBe(true);
  });

  it("guidance treats empty semantic results as potentially inconclusive with selective, not automatic, text verification", async () => {
    const tools = await registerLsp();
    const guidance = allGuidance(tools).toLowerCase();
    expect(/empty/.test(guidance)).toBe(true);
    expect(/inconclusive/.test(guidance)).toBe(true);
    expect(/verify/.test(guidance)).toBe(true);
    expect(/not automatically/.test(guidance)).toBe(true);
  });

  it("guidance stays compact — at most 5 guideline entries per tool, none empty", async () => {
    const tools = await registerLsp();
    for (const tool of tools) {
      for (const g of tool.promptGuidelines ?? []) {
        expect(g.trim().length).toBeGreaterThan(0);
      }
      expect(tool.promptGuidelines!.length).toBeGreaterThan(0);
      expect(tool.promptGuidelines!.length).toBeLessThanOrEqual(5);
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