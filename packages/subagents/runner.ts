/* oxlint-disable preserve-caught-error */
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  getAgentDir,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  AGENTS,
  CODEMODE_GUIDANCE,
  CORE_READ_TOOLS,
  DEFAULT_EXPLORE_TOOLS,
  SAFETY_EXCLUDES,
  type AgentDef,
  type AgentType,
} from "./agents.ts";
import type { CustomSubagentDef } from "./discovery.ts";
import type { PreloadedSkill } from "./skills.ts";
import { composeCustomSystemPrompt } from "./skills-prompt.ts";

type AnyModel = Model<any>;

// ─── Stream event types ────────────────────────────────────────────────────

/** Compact stream events from a foreground subagent run — UI-only progress. */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; name: string; callId?: string; args?: unknown }
  | { type: "tool_output"; name: string; callId: string; text: string }
  | { type: "tool_end"; name: string; callId?: string; error?: boolean; text?: string };

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
 * never promoted into a successful `RunResult`, but assistant text captured
 * before an abort or failure is attached to the thrown error as
 * `partialText` (assistant prose only — no tool transcripts, no hidden
 * reasoning) so a parent-facing stop can expose it as clearly incomplete.
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
  // Assistant text captured from deltas for error attachment. Tool lifecycle
  // events and thinking deltas are deliberately excluded: partial output is
  // assistant prose only.
  const capturedText: string[] = [];

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
          capturedText.push(msg.delta);
          onStream?.({ type: "text_delta", delta: msg.delta });
        }
        // thinking_delta deliberately ignored — model-internal reasoning
        break;
      }
      case "tool_execution_start":
        onStream?.({
          type: "tool_start",
          name: event.toolName,
          callId: event.toolCallId,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        onStream?.({
          type: "tool_output",
          name: event.toolName,
          callId: event.toolCallId,
          text: toolText(event.partialResult),
        });
        break;
      case "tool_execution_end":
        toolUses++;
        onStream?.({
          type: "tool_end",
          name: event.toolName,
          callId: event.toolCallId,
          error: event.isError,
          text: toolText(event.result),
        });
        break;
    }
  });

  const withPartial = (e: Error): Error => {
    if (capturedText.length > 0) (e as any).partialText = capturedText.join("");
    return e;
  };

  try {
    await session.prompt(prompt);
    const text = lastAssistantText(session.messages);
    const tokens = totalTokens(session.messages);
    return { result: text, tokens, toolUses };
  } catch (e: any) {
    // If the signal caused the abort, throw a clean error. Either way, hand
    // back whatever assistant text arrived before the failure — the caller
    // (and the manager) decides how to mark it incomplete.
    if (abortSignal?.aborted) throw withPartial(new Error("Subagent aborted"));
    throw withPartial(e instanceof Error ? e : new Error(String(e)));
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
  type: AgentType | string;
  /** Custom Subagent definition (exact resolved match); overrides `AGENTS[type]`. */
  agentDef?: CustomSubagentDef;
  /** Skills resolved and read at launch; preloaded into the initial context. */
  preloadedSkills?: PreloadedSkill[];
  prompt: string;
  cwd: string;
  model?: AnyModel;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** Observe Pi's effective level after session creation and capability adaptation. */
  onThinkingLevel?: (effective: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>) => void;
  /** Allowlist for the sub-session (explore). Custom Subagent types pass no
   *  allowlist: they inherit the available tools like `general`, minus the
   *  safety exclusions. */
  tools?: string[];
  /** Extra exclusions on top of SAFETY_EXCLUDES. */
  excludeExtraTools?: string[];
  /** Whether codemode reaches the sub-session. Defaults to deriving it from
   *  `tools` (allowlist case) or assuming it for inherited toolsets. */
  codemodeAvailable?: boolean;
  /** Callback for compact UI-only stream events during foreground runs. */
  onStreamEvent?: StreamCallback;
  /** When set, the child session is aborted if this signal fires. */
  abortSignal?: AbortSignal;
}): Promise<RunResult> {
  const def = opts.agentDef ?? (AGENTS as Record<string, AgentDef | undefined>)[opts.type];
  if (!def) throw new Error(`Unknown Subagent type "${opts.type}"`);

  // A custom definition's body plus any preloaded skills form the initial
  // context. Built-ins keep Pi's normal prompt (as the override's `base`).
  // Every Subagent with codemode gets the same preference guidance.
  const codemodeAvailable =
    opts.codemodeAvailable ?? (opts.tools ? opts.tools.includes("codemode") : true);
  const toolGuidance = codemodeAvailable ? CODEMODE_GUIDANCE : undefined;
  const composeIfNeeded =
    def.systemPrompt || opts.preloadedSkills?.length || toolGuidance
      ? (base: string | undefined) =>
          composeCustomSystemPrompt(def.systemPrompt ?? base, opts.preloadedSkills, toolGuidance)
      : undefined;

  const modelRuntime = await ModelRuntime.create();

  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    ...(composeIfNeeded ? { systemPromptOverride: (base) => composeIfNeeded(base) } : {}),
  });
  await loader.reload();

  const makeSession = (tools?: string[]) =>
    createAgentSession({
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
      ...(tools ? { tools } : {}),
      // Enforce one-level-deep: the loader discovers this very extension in the
      // sub-session, so without this a `general` sub-agent could recursively
      // spawn sub-agents. Also drop `question` — a sub-agent has no user to ask.
      excludeTools: [...SAFETY_EXCLUDES, ...(opts.excludeExtraTools ?? [])],
      sessionManager: SessionManager.inMemory(opts.cwd),
      modelRuntime,
      resourceLoader: loader,
    });

  let session;
  try {
    ({ session } = await makeSession(opts.tools));
  } catch (e) {
    // The explore allowlist names optional tools (e.g. lsp_* navigation) that
    // may not be installed. If this harness version rejects unknown allowlist
    // names rather than ignoring them, degrade instead of failing — but keep
    // codemode, which is a core default, and only then fall back to the bare
    // read-only floor if codemode itself is what got rejected.
    if (!("readOnly" in def) || !def.readOnly) throw e;
    const reduced = opts.tools
      ? opts.tools.filter((t) => DEFAULT_EXPLORE_TOOLS.includes(t))
      : CORE_READ_TOOLS;
    try {
      ({ session } = await makeSession(reduced));
    } catch {
      ({ session } = await makeSession(CORE_READ_TOOLS));
    }
  }

  if (opts.thinkingLevel !== undefined) opts.onThinkingLevel?.(session.thinkingLevel);

  return runSubagentSession({
    session,
    prompt: opts.prompt,
    onStreamEvent: opts.onStreamEvent,
    abortSignal: opts.abortSignal,
  });
}

function toolText(result: any): string {
  return Array.isArray(result?.content)
    ? result.content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
    : "";
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