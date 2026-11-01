import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** A captured pi.sendMessage call: the attributed message and its options. */
export interface CapturedSend {
  message: {
    customType: string;
    content: string | { type: "text"; text: string }[];
    display: boolean;
    details?: unknown;
  };
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

/** Event name → handler, so tests can fire Pi lifecycle events at the seam. */
export type CapturedHandlers = Map<string, (event: any, ctx?: any) => any>;

/** One `pi.appendEntry` call: the extension's persisted custom entry. */
export interface CapturedEntry {
  customType: string;
  data: unknown;
}

/** A registered `/command` with its handler, invokable from tests. */
export interface CapturedCommand {
  name: string;
  handler: (args: string | undefined, ctx: any) => any;
}

/**
 * Capture the tools an extension registers through a minimal fake ExtensionAPI.
 * Optional captures record `sendMessage` calls and `on` handlers so delivery
 * and lifecycle behavior can be exercised at the extension registration seam.
 */
export function makeFakeApi(
  captured: ToolDefinition[],
  o?: {
    sends?: CapturedSend[];
    handlers?: CapturedHandlers;
    messageRenderers?: Map<string, Function>;
    appendEntries?: CapturedEntry[];
    commands?: CapturedCommand[];
  },
): ExtensionAPI {
  return {
    registerTool: (tool) => captured.push(tool as ToolDefinition),
    on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
      o?.handlers?.set(event, handler);
    },
    registerMessageRenderer: (customType: string, renderer: Function) => {
      o?.messageRenderers?.set(customType, renderer);
    },
    registerCommand: (name: string, command: { handler: CapturedCommand["handler"] }) => {
      o?.commands?.push({ name, handler: command.handler });
    },
    appendEntry: (customType: string, data?: unknown) => {
      o?.appendEntries?.push({ customType, data });
    },
    sendMessage: (message: never, options?: never) => {
      o?.sends?.push({ message, options } as unknown as CapturedSend);
    },
    events: { emit: () => {} },
  } as unknown as ExtensionAPI;
}