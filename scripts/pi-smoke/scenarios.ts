/**
 * Scenario definitions for the real-Pi lifecycle smoke harness.
 *
 * Each invocation is one real `pi --mode json` process: Pi's own extension host,
 * session store, tool loop and lifecycle events run for real, while the model
 * service is the deterministic stub in `stub-provider.ts`. Expectations are
 * checked by `evaluate.ts` against the recorded evidence.
 */

import type { Expectation } from "./evaluate.ts";
import type { StubResponse } from "./stub-provider.ts";

export type Invocation = {
  /** Prompt handed to `pi -p`. */
  prompt: string;
  /** Stub responses, one per model request; the last entry repeats. */
  responses: StubResponse[];
  expectations: Expectation[];
};

export type Scenario = {
  id: string;
  title: string;
  /** Extension package directories, relative to the repository root. */
  extensions: string[];
  /** Reuse one Pi session across invocations instead of a fresh session each time. */
  reuseSession?: boolean;
  invocations: Invocation[];
};

/** Every Extension package in this repository. */
export const ALL_EXTENSIONS = [
  "packages/todo",
  "packages/question",
  "packages/statusline",
  "packages/subagents",
  "packages/lsp",
  "packages/model-compaction",
  "packages/web-fetch",
  "packages/web-search",
  "packages/model-presets",
];

const TODO_WRITE_TOOL_CALL: StubResponse = {
  kind: "toolCall",
  toolName: "todo_write",
  input: { todos: [{ content: "smoke step", status: "in_progress" }] },
};

export const SCENARIOS: Scenario[] = [
  {
    id: "extension-load",
    title: "all nine Extension packages load in Pi and advertise their tools",
    extensions: ALL_EXTENSIONS,
    invocations: [
      {
        prompt: "smoke: reply with the word ready",
        responses: [{ kind: "text", text: "ready" }],
        expectations: [
          { kind: "exit", code: 0, description: "Pi exits 0" },
          {
            kind: "stderrExcludes",
            pattern: "Failed to load extension",
            description: "no extension failed to load",
          },
          {
            kind: "event",
            type: "agent_settled",
            description: "the run settles instead of hanging",
          },
          { kind: "probe", name: "probe_loaded", description: "the probe extension loaded" },
          {
            kind: "probe",
            name: "session_start",
            payload: { reason: "startup" },
            description: "session_start reason=startup",
          },
          {
            kind: "probe",
            name: "session_shutdown",
            payload: { reason: "quit" },
            description: "session_shutdown reason=quit",
          },
          {
            kind: "requestTools",
            includes: [
              "todo_write",
              "todo_read",
              "question",
              "Agent",
              "stop_subagent",
              "get_subagent_result",
              "lsp_definition",
              "lsp_diagnostics",
              "web_fetch",
              "web_search",
            ],
            description: "extension tools reach the model request",
          },
        ],
      },
    ],
  },
  {
    id: "tool-call",
    title: "a real tool call round trip keeps the dual result contract",
    extensions: ["packages/todo"],
    invocations: [
      {
        prompt: "smoke: record one todo step",
        responses: [TODO_WRITE_TOOL_CALL, { kind: "text", text: "todo recorded" }],
        expectations: [
          { kind: "exit", code: 0, description: "Pi exits 0" },
          {
            kind: "stderrExcludes",
            pattern: "Failed to load extension",
            description: "the extension loaded",
          },
          {
            kind: "eventOrder",
            types: [
              "turn_start",
              "tool_execution_start",
              "tool_execution_end",
              "turn_end",
              "agent_settled",
            ],
            description: "tool execution happens inside the turn before settling",
          },
          {
            kind: "eventOrder",
            types: ["turn_start", "turn_end", "turn_start", "turn_end"],
            description: "the tool result drives a second turn",
          },
          {
            kind: "probe",
            name: "tool_call",
            payload: { toolName: "todo_write" },
            description: "tool_call fired for todo_write",
          },
          {
            kind: "probe",
            name: "tool_result",
            payload: { toolName: "todo_write" },
            description: "tool_result fired for todo_write",
          },
          {
            kind: "toolResult",
            toolName: "todo_write",
            textIncludes: "Current: smoke step",
            detailsKeys: ["items", "currentIndex"],
            isError: false,
            description: "todo_write returns plain text content plus structured details",
          },
          {
            kind: "requestRoles",
            roles: ["tool"],
            requestIndex: 1,
            description: "the follow-up request carries the tool result",
          },
        ],
      },
    ],
  },
  {
    id: "session-reuse",
    title: "a second Pi process reuses the earlier session branch",
    extensions: ["packages/todo"],
    reuseSession: true,
    invocations: [
      {
        prompt: "smoke: record one todo step",
        responses: [TODO_WRITE_TOOL_CALL, { kind: "text", text: "todo recorded" }],
        expectations: [
          { kind: "exit", code: 0, description: "first run exits 0" },
          {
            kind: "probe",
            name: "session_start",
            payload: { reason: "startup" },
            description: "first run reports session_start reason=startup",
          },
        ],
      },
      {
        prompt: "smoke: what is on the list?",
        responses: [{ kind: "text", text: "still one step" }],
        expectations: [
          { kind: "exit", code: 0, description: "second run exits 0" },
          {
            kind: "stderrExcludes",
            pattern: "Failed to load extension",
            description: "the extension loaded again",
          },
          {
            kind: "probe",
            name: "session_shutdown",
            payload: { reason: "quit" },
            description: "second run shuts its session down",
          },
          {
            kind: "requestRoles",
            roles: ["system", "user", "assistant", "tool"],
            requestIndex: 0,
            description: "the replayed branch carries the earlier tool result",
          },
        ],
      },
    ],
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}