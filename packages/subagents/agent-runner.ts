import {
  createAgentSession,
  createReadOnlyTools,
  createCodingTools,
  SessionManager,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentTypeConfig } from "./types.ts";
import { buildPrompt } from "./prompts.ts";

export interface RunOptions {
  taskPrompt: string;
  description: string;
  config: AgentTypeConfig;
  parentSystemPrompt: string;
  parentContext?: string;
  cwd: string;
  model: Model<any> | undefined;
  modelRegistry?: ModelRegistry;
  maxTurns: number | undefined;
  inheritContext: boolean;
  allowOutsideCwd: boolean;
  signal?: AbortSignal;
  onUpdate?: (status: string) => void;
  onSessionReady?: (session: any) => void;
  onPartial?: (text: string) => void;
}

export interface RunResult {
  text: string;
  turnCount: number;
  wasLimited: boolean;
  error?: string;
}


function collectMessages(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (texts) parts.push(texts);
    }
  }
  return parts.join("\n\n");
}

export async function runSubagent(options: RunOptions): Promise<RunResult> {
  const {
    taskPrompt,
    config,
    parentSystemPrompt,
    parentContext,
    cwd,
    model,
    modelRegistry,
    maxTurns,
    inheritContext,
    allowOutsideCwd,
    signal,
    onUpdate,
  } = options;

  onUpdate?.("starting");

  const systemPrompt = buildPrompt(config, taskPrompt, {
    parentSystemPrompt,
    parentContext,
    cwd,
    allowOutsideCwd,
    inheritContext,
  });

  const tools = config.isReadOnly
    ? createReadOnlyTools(cwd)
    : createCodingTools(cwd);

  onUpdate?.("creating session");

  const { session } = await createAgentSession({
    cwd,
    model: model ?? undefined,
    modelRegistry,
    tools,
    sessionManager: SessionManager.inMemory(cwd),
  });

  session.agent.setSystemPrompt(systemPrompt);

  let turnCount = 0;
  let wasLimited = false;
  let abortReason: string | undefined;

  options.onSessionReady?.(session);

  const emitPartial = () => {
    try {
      options.onPartial?.(collectMessages(session.messages));
    } catch {
      // best effort only
    }
  };

  const unsubscribe = session.agent.subscribe((event: any) => {
    if (event.type === "turn_end") {
      turnCount++;
      emitPartial();
      if (maxTurns !== undefined && maxTurns > 0 && turnCount >= maxTurns) {
        wasLimited = true;
        abortReason = `max_turns (${maxTurns}) reached`;
        session.abort();
      }
    }
  });

  try {
    onUpdate?.("running");
    const effectiveSignal = signal ?? options.signal;

    if (effectiveSignal) {
      effectiveSignal.addEventListener("abort", () => {
        session.abort();
      }, { once: true });
    }

    await session.prompt(taskPrompt);
    emitPartial();
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.message?.includes("abort")) {
      if (!abortReason) {
        abortReason = "aborted";
      }
      emitPartial();
    } else {
      unsubscribe();
      session.dispose();
      return {
        text: collectMessages(session.messages),
        turnCount,
        wasLimited,
        error: String(err.message ?? err),
      };
    }
  }

  unsubscribe();

  const text = collectMessages(session.messages);
  session.dispose();

  return { text, turnCount, wasLimited, error: abortReason };
}
