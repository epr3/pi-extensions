import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { AGENTS, CORE_READ_TOOLS, SAFETY_EXCLUDES, type AgentType } from "./agents.ts";

type AnyModel = Model<any>;

// ─── Stream event types ────────────────────────────────────────────────────

/** Compact stream events from a foreground subagent run — UI-only progress. */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; error?: boolean };

export type StreamCallback = (event: StreamEvent) => void;

// ─── Public result shape ───────────────────────────────────────────────────

export interface RunResult {
  result: string;
  tokens: number;
  toolUses: number;
}

/** Minimal session surface used by `runSubagentSession`. SDK-agnostic. */
export interface SubagentSession {
  abort(): void;
  dispose(): void;
  subscribe(handler: (event: any) => void): () => void;
  prompt(text: string): Promise<void>;
  messages: any[];
}

/**
 * Run a subagent session to completion. This is the testable core of
 * `runSubagent`: it owns the event mapping, abort handling, cleanup, and final
 * result extraction, but it accepts an already-created session so tests can
 * drive it with a fake.
 *
 * When `abortSignal` fires, the session is aborted, stream forwarding stops,
 * and the promise rejects with "Subagent aborted". Partial stream text is
 * never promoted into the returned `RunResult`.
 */
export async function runSubagentSession(opts: {
  session: SubagentSession;
  prompt: string;
  /** Callback for compact UI-only stream events during foreground runs. */
  onStreamEvent?: StreamCallback;
  /** When set, the child session is aborted if this signal fires. */
  abortSignal?: AbortSignal;
}): Promise<RunResult> {
  const { session, prompt, onStreamEvent: onStream, abortSignal } = opts;
  let toolUses = 0;

  const onAbort = () => {
    session.abort();
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      session.dispose();
      throw new Error("Subagent aborted");
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const unsubscribe = session.subscribe((event) => {
    // Stop forwarding events once the parent aborts — the session is winding
    // down and any late events must not produce further UI updates.
    if (abortSignal?.aborted) return;
    switch (event.type) {
      case "message_update": {
        const msg = event.assistantMessageEvent;
        if (msg?.type === "text_delta" && msg.delta) {
          onStream?.({ type: "text_delta", delta: msg.delta });
        }
        // thinking_delta deliberately ignored — model-internal reasoning
        break;
      }
      case "tool_execution_start":
        onStream?.({ type: "tool_start", name: event.toolName });
        break;
      case "tool_execution_end":
        toolUses++;
        onStream?.({ type: "tool_end", name: event.toolName, error: event.isError });
        break;
    }
  });

  try {
    await session.prompt(prompt);
    const text = lastAssistantText(session.messages);
    const tokens = totalTokens(session.messages);
    return { result: text, tokens, toolUses };
  } catch (e: any) {
    // If the signal caused the abort, throw a clean error.
    if (abortSignal?.aborted) throw new Error("Subagent aborted");
    throw e;
  } finally {
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}

/**
 * Run one sub-agent to completion in an isolated in-memory session and return
 * its final text. This is a real Pi sub-session via the SDK — no stub.
 *
 * - `explore` gets a read-only toolset + a tailored read-only prompt.
 * - `general` inherits the normal toolset and system prompt for `cwd`
 *   (AGENTS.md, skills, conventions), so it behaves like the parent.
 *
 * When `onStreamEvent` is provided, the runner maps child SDK session events
 * into compact `StreamEvent` values and delivers them synchronously as they
 * arrive. Only assistant text deltas and tool lifecycle events are forwarded;
 * thinking deltas are ignored.
 *
 * When `abortSignal` is provided and fires during the run, the child session
 * is aborted and the promise rejects with the abort reason.
 */
export async function runSubagent(opts: {
  type: AgentType;
  prompt: string;
  cwd: string;
  model?: AnyModel;
  /** Allowlist for the sub-session (explore). Undefined = everything discovered (general). */
  tools?: string[];
  /** Extra exclusions on top of SAFETY_EXCLUDES. */
  excludeExtraTools?: string[];
  /** Callback for compact UI-only stream events during foreground runs. */
  onStreamEvent?: StreamCallback;
  /** When set, the child session is aborted if this signal fires. */
  abortSignal?: AbortSignal;
}): Promise<RunResult> {
  const def = AGENTS[opts.type];

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    ...(def.systemPrompt ? { systemPromptOverride: () => def.systemPrompt! } : {}),
  });
  await loader.reload();

  const makeSession = (tools?: string[]) =>
    createAgentSession({
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(tools ? { tools } : {}),
      // Enforce one-level-deep: the loader discovers this very extension in the
      // sub-session, so without this a `general` sub-agent could recursively
      // spawn sub-agents. Also drop `question` — a sub-agent has no user to ask.
      excludeTools: [...SAFETY_EXCLUDES, ...(opts.excludeExtraTools ?? [])],
      sessionManager: SessionManager.inMemory(opts.cwd),
      authStorage,
      modelRegistry,
      resourceLoader: loader,
    });

  let session;
  try {
    ({ session } = await makeSession(opts.tools));
  } catch (e) {
    // The explore allowlist names lsp_* tools that may not be installed. If
    // this harness version rejects unknown allowlist names rather than
    // ignoring them, degrade to the core read-only tools instead of failing.
    if (!def.readOnly) throw e;
    ({ session } = await makeSession(CORE_READ_TOOLS));
  }

  return runSubagentSession({
    session,
    prompt: opts.prompt,
    onStreamEvent: opts.onStreamEvent,
    abortSignal: opts.abortSignal,
  });
}

function lastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const text = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "(subagent produced no text output)";
}

function totalTokens(messages: any[]): number {
  let max = 0;
  for (const m of messages) {
    const t = m?.usage?.totalTokens ?? m?.usage?.inputTokens ?? 0;
    if (typeof t === "number" && t > max) max = t;
  }
  return max;
}