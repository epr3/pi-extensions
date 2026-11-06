/**
 * Lifecycle probe extension for the real-Pi smoke harness.
 *
 * Pi loads this like any other extension and calls the handlers below as its
 * own lifecycle progresses, so the log is first-hand runtime evidence rather
 * than a simulated event stream. Records land as JSONL at `$PI_SMOKE_LOG`.
 *
 * Extend `EVENTS` when a dependent investigation needs an event that is not
 * listed yet; the file is harness code, not a product extension.
 */

import { appendFileSync } from "node:fs";

/** The one Extension API method the probe needs; kept structural so this file
 * loads through Pi's extension loader without depending on package installs. */
type ProbeApi = {
  on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void): unknown;
};

const EVENTS = [
  // Startup and session lifecycle
  "project_trust",
  "resources_discover",
  "session_start",
  "session_shutdown",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_before_tree",
  "session_tree",
  // Run lifecycle
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_before_settle",
  "agent_settled",
  "ui_prompt_start",
  "ui_prompt_end",
  "turn_start",
  "turn_end",
  // Messages and model selection
  "message_start",
  "message_update",
  "message_end",
  "model_select",
  "thinking_level_select",
  // Tools and input
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "input",
  "user_bash",
] as const;

/** Field names worth keeping verbatim; everything else is reduced to its keys. */
const KEEP_FIELDS = [
  "reason",
  "type",
  "role",
  "toolName",
  "toolCallId",
  "isError",
  "aborted",
  "provider",
  "model",
  "message",
] as const;

function summarize(eventName: string, event: unknown) {
  if (typeof event !== "object" || event === null) return { value: String(event) };
  const record = event as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const field of KEEP_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (field === "message" && typeof value === "object" && value !== null) {
      const message = value as Record<string, unknown>;
      summary.role = message.role;
      summary.stopReason = message.stopReason;
      continue;
    }
    summary[field] = value;
  }
  if (Object.keys(summary).length === 0) summary.fields = Object.keys(record).toSorted();
  if (eventName === "message_update") delete summary.fields;
  return summary;
}

export default function probe(pi: ProbeApi) {
  const logPath = process.env.PI_SMOKE_LOG;
  if (!logPath) return;

  const record = (name: string, payload: unknown) => {
    try {
      appendFileSync(logPath, `${JSON.stringify({ name, payload })}\n`);
    } catch {
      // A probe must never break the run it is observing.
    }
  };

  record("probe_loaded", { piVersion: process.env.PI_SMOKE_PI_VERSION ?? null });

  for (const name of EVENTS) {
    pi.on(name, async (event: unknown) => {
      record(name, summarize(name, event));
    });
  }
}