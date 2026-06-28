/**
 * LSP tool guidance contract tests.
 *
 * Verifies that every registered LSP tool has precise metadata: name, label,
 * description, parameter descriptions, prompt snippet, and prompt guidelines.
 *
 * Run: node_modules/.pnpm/node_modules/.bin/tsx tests/lsp-tool-guidance.test.ts
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import lspExtension from "../packages/lsp/index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
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

async function testAllExpectedToolsRegistered() {
  const tools = await registerLsp();
  const names = tools.map((t) => t.name).toSorted();
  assert.deepStrictEqual(names, EXPECTED_TOOLS.toSorted(), "all expected LSP tools are registered");
  console.log("  All expected tools registered ..................... PASS");
}

async function testEachToolHasLabelAndDescription() {
  const tools = await registerLsp();
  for (const tool of tools) {
    assert.ok(tool.label.length > 0, `${tool.name} has a label`);
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.ok(!tool.description.includes("TODO"), `${tool.name} description has no placeholder`);
  }
  console.log("  Each tool has label and description ............... PASS");
}

async function testParameterDescriptionsArePresent() {
  const tools = await registerLsp();
  for (const tool of tools) {
    const props = (tool.parameters as any).properties;
    for (const [key, schema] of Object.entries(props)) {
      const desc = (schema as any).description;
      assert.ok(
        desc && typeof desc === "string" && desc.length > 0,
        `${tool.name}.${key} has a description`,
      );
    }
  }
  console.log("  Parameter descriptions are present ................ PASS");
}

async function testPositionParametersAreOneBased() {
  const tools = await registerLsp();
  for (const tool of tools) {
    const props = (tool.parameters as any).properties;
    if (props.line) {
      assert.ok(props.line.description.includes("1-based"), `${tool.name} line is 1-based`);
    }
    if (props.column) {
      assert.ok(props.column.description.includes("1-based"), `${tool.name} column is 1-based`);
    }
  }
  console.log("  Position parameters are documented as 1-based ..... PASS");
}

async function testPromptSnippetAndGuidelinesPresent() {
  const tools = await registerLsp();
  for (const tool of tools) {
    assert.ok(
      tool.promptSnippet && tool.promptSnippet.length > 0,
      `${tool.name} has a prompt snippet`,
    );
    assert.ok(
      Array.isArray(tool.promptGuidelines) && tool.promptGuidelines!.length > 0,
      `${tool.name} has prompt guidelines`,
    );
  }
  console.log("  Prompt snippets and guidelines present ............ PASS");
}

async function testWorkspaceSymbolsRoutingFileWording() {
  const tools = await registerLsp();
  const sym = tools.find((t) => t.name === "lsp_workspace_symbols")!;
  assert.ok(
    sym.description.includes("routes to the right server"),
    "workspace symbols file is a routing file",
  );
  const fileDesc = (sym.parameters as any).properties.file.description;
  assert.ok(
    fileDesc.includes("routes to the right server"),
    "workspace symbols file param is routing file",
  );
  console.log("  Workspace symbols routing file wording ............ PASS");
}

async function main() {
  console.log("\nLSP tool guidance contract tests\n");

  await testAllExpectedToolsRegistered();
  await testEachToolHasLabelAndDescription();
  await testParameterDescriptionsArePresent();
  await testPositionParametersAreOneBased();
  await testPromptSnippetAndGuidelinesPresent();
  await testWorkspaceSymbolsRoutingFileWording();

  console.log("\nAll tests PASS\n");
}

main();