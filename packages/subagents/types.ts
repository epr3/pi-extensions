import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { RunResult } from "./agent-runner.ts";

export type AgentStatus = "queued" | "running" | "completed" | "error" | "stopped";

export type PromptMode = "append" | "replace";

export interface AgentTypeConfig {
  name: string;
  displayName: string;
  isReadOnly: boolean;
  promptMode: PromptMode;
  model?: string;
  promptBody?: string;
  source: "builtin" | "custom";
}

export interface SubagentSettings {
  maxConcurrency: number;
  maxQueueSize: number;
  recordTtlMs: number;
  defaultBackground: boolean;
  allowCustomSubagents: boolean;
  allowNestedSubagents: boolean;
  maxSubagentDepth: number;
  allowOutsideCwdDefault: boolean;
  saveTranscriptsDefault: boolean;
}

export interface SubagentRun {
  id: string;
  requestedType: string;
  type: string;
  description: string;
  status: AgentStatus;
  result?: string;
  error?: string;
  stopReason?: string;
  startedAt: number;
  completedAt?: number;
  toolUses: number;
  turnCount: number;
  wasLimited: boolean;
  partialOutput?: string;
  parentId?: string;
  depth: number;
  model?: string;
  transcriptPath?: string;
  steeringMessages: Array<{
    at: number;
    message: string;
    priority: "normal" | "urgent";
  }>;
  promise?: Promise<RunResult>;
  session?: AgentSession;
  abortController?: AbortController;
}

export interface AgentParams {
  prompt: string;
  description: string;
  subagent_type: string;
  run_in_background?: boolean;
  max_turns?: number;
  inherit_context?: boolean;
  model?: string;
  allow_outside_cwd?: boolean;
  save_transcript?: boolean;
}

export interface GetSubagentResultParams {
  agent_id: string;
  wait?: boolean;
  wait_ms?: number;
  include_partial?: boolean;
  verbose?: boolean;
}

export interface ListSubagentsParams {
  status?: "queued" | "running" | "completed" | "error" | "stopped" | "all";
  verbose?: boolean;
}

export interface StopSubagentParams {
  agent_id: string;
  reason?: string;
}

export interface SteerSubagentParams {
  agent_id: string;
  message: string;
  priority?: "normal" | "urgent";
}
