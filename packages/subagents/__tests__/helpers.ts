import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Capture the tools an extension registers through a minimal fake ExtensionAPI. */
export function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
    on: () => {},
    registerCommand: () => {},
    events: { emit: () => {} },
  } as unknown as ExtensionAPI;
}