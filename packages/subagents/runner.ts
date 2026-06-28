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

export interface RunResult {
  result: string;
  tokens: number;
  toolUses: number;
}

/**
 * Run one sub-agent to completion in an isolated in-memory session and return
 * its final text. This is a real Pi sub-session via the SDK — no stub.
 *
 * - `explore` gets a read-only toolset + a tailored read-only prompt.
 * - `general` inherits the normal toolset and system prompt for `cwd`
 *   (AGENTS.md, skills, conventions), so it behaves like the parent.
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

  let toolUses = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end") toolUses++;
  });

  try {
    await session.prompt(opts.prompt);
    const text = lastAssistantText(session.messages);
    const tokens = totalTokens(session.messages);
    return { result: text, tokens, toolUses };
  } finally {
    unsubscribe();
    session.dispose();
  }
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
  return "(sub-agent produced no text output)";
}

function totalTokens(messages: any[]): number {
  let max = 0;
  for (const m of messages) {
    const t = m?.usage?.totalTokens ?? m?.usage?.inputTokens ?? 0;
    if (typeof t === "number" && t > max) max = t;
  }
  return max;
}