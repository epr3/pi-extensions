import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { runSubagent, type SubagentSession } from "../runner.ts";

/**
 * Fake sub-session that mirrors how the installed Pi SDK ends an aborted run.
 *
 * Real Pi encodes the abort in the terminal assistant message and lets
 * `agent.prompt()` resolve — `runAgentLoop` emits `turn_end`/`agent_end` and
 * returns when `message.stopReason === "aborted"` rather than throwing
 * (`@earendil-works/pi-agent-core@0.84.1` `dist/agent-loop.js`), and
 * `AgentSession.prompt()` awaits that loop with no abort-related catch. Driving
 * the SDK's own `Agent` with a fake provider stream confirms it at runtime:
 * the prompt resolves, and the terminal assistant message carries
 * `stopReason: "aborted"` plus the text streamed before the abort. Tests
 * driven through this fake therefore exercise the resolution semantics the
 * extension actually meets in Pi, instead of a hand-picked rejection.
 *
 * `emitText` streams assistant deltas (what the runner captures as partial
 * text); `abort()` ends the run the way the SDK does (aborted terminal message,
 * prompt resolves); `finish()` ends it as a genuine completion.
 */
export function sdkAbortResolvingSession() {
  let handler: ((event: any) => void) | undefined;
  let resolvePrompt: (() => void) | undefined;
  let promptSettled = false;
  const promptPromise = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  const messages: any[] = [];
  const streamed: string[] = [];
  let aborted = false;
  let disposed = false;

  const terminate = (stopReason: "end" | "aborted", text: string) => {
    if (promptSettled) return;
    promptSettled = true;
    messages.push({
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      timestamp: 0,
    });
    resolvePrompt?.();
  };

  const session: SubagentSession & {
    emitText: (delta: string) => void;
    finish: (text: string) => void;
  } = {
    get aborted() {
      return aborted;
    },
    get disposed() {
      return disposed;
    },
    abort() {
      if (aborted) return;
      aborted = true;
      terminate("aborted", streamed.join(""));
    },
    dispose() {
      disposed = true;
    },
    subscribe(h) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    prompt() {
      return promptPromise;
    },
    get messages() {
      return messages;
    },
    emitText(delta: string) {
      streamed.push(delta);
      handler?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
    },
    finish(text: string) {
      terminate("end", text);
    },
  };
  return session;
}

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
// ---------------------------------------------------------------------------
// Fixtures shared by the footer and overview tests: a pass-through theme, the
// tool-level launch context, launch params, a hanging runner queue, and the
// fake TUI ctx that captures `/subagents` overlays.
// ---------------------------------------------------------------------------

/** Plain theme — no ANSI codes, just passes text through. */
export const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

/** Tool-level ctx for launching live runs (no UI, TUI mode). */
export function toolCtx() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: "tui" as const,
    signal: undefined,
    model: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: () => {} },
  };
}

type Execute = NonNullable<ToolDefinition["execute"]>;

/** Contextual params the Agent tool accepts, minimal shape. */
export function launchParams(over: Record<string, unknown> = {}) {
  return { subagent_type: "general", prompt: "do it", description: "d", ...over };
}

/**
 * Queue of manually released sub-session executions (hangs until released),
 * keyed in launch order. The mock only stubs the SDK boundary — the extension
 * builds the real run around it. `launch` is available when the caller passes
 * the session's Agent tool; tests that launch runs directly need only release.
 */
export function hangingRunner(seam?: { agentTool?: ToolDefinition }) {
  const pending: Array<(o: unknown) => void> = [];
  (runSubagent as any).mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const done = { result: "done", tokens: 1, toolUses: 0 };
  return {
    /** Launch one hanging background run through the Agent tool. */
    launch: (over: Record<string, unknown> = {}) => {
      const execute = seam?.agentTool?.execute as Execute | undefined;
      if (!execute) throw new Error("hangingRunner needs the session's Agent tool to launch");
      return execute(
        "t",
        launchParams({ run_in_background: true, ...over }),
        undefined,
        undefined,
        toolCtx(),
      );
    },
    /** Settle one hanging run (launch order); settles all when omitted. */
    release: (which?: number) => {
      if (which === undefined) {
        for (const resolve of pending.splice(0)) resolve(done);
        return;
      }
      pending.splice(which, 1)[0]?.(done);
    },
  };
}

/** One `/subagents` overlay the fake TUI opened: the component plus dismissal. */
export interface OpenedOverlay {
  component: any;
  overlayOptions: any;
  /** Whether the component called done() — how dismissal is observed. */
  result: { doneCalled: boolean };
}

/**
 * The fake interactive TUI ctx: records `/subagents` notifications, captures
 * the overlay components the command hands to ctx.ui.custom (driven later via
 * handleInput / render), and reads the given branch entries.
 */
export function tuiCtx(
  branchEntries: readonly unknown[] = [],
  options: { mode?: string } = {},
): { ctx: any; notified: string[]; customCalls: OpenedOverlay[] } {
  const notified: string[] = [];
  const customCalls: OpenedOverlay[] = [];
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const tui = { requestRender: () => {} };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify: (message: string) => {
        notified.push(message);
      },
      custom: async (factory: Function, opts: unknown) => {
        const result: OpenedOverlay["result"] = { doneCalled: false };
        const component = await factory(tui, plainTheme, keybindings, () => {
          result.doneCalled = true;
        });
        customCalls.push({ component, overlayOptions: opts, result });
        return undefined;
      },
    },
    sessionManager: { getBranch: () => branchEntries },
  };
  return { ctx, notified, customCalls };
}