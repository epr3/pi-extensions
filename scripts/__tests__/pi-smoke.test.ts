/**
 * Deterministic unit tests for the real-Pi lifecycle smoke harness
 * (`scripts/pi-smoke/`). No Pi process, provider, or network is involved: these
 * cover the seam between recorded runtime evidence (Pi's `--mode json` session
 * stream, the probe extension's event log, and the stub provider's request log)
 * and the pass/fail findings the runner prints.
 *
 * Fixture values are copied from a real run so the parsers are exercised
 * against the shapes Pi actually emits, not imagined ones.
 */

import { describe, it, expect } from "vitest";
import {
  describeChatRequest,
  evaluateObservations,
  parseJsonl,
  parseProbeLog,
  summarize,
  toolResultsFromEvents,
  type Expectation,
  type Observations,
} from "../pi-smoke/evaluate.ts";
import { SCENARIOS } from "../pi-smoke/scenarios.ts";

const SESSION_STREAM = [
  '{"type":"session","version":3,"id":"01a1b1cd","cwd":"/tmp/pi-smoke"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"todo_write"}',
  '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"todo_write","isError":false}',
  '{"type":"turn_end","message":{"role":"assistant","stopReason":"toolUse"},"toolResults":[{"role":"toolResult","toolCallId":"call_1","toolName":"todo_write","content":[{"type":"text","text":"0/1 done\\nCurrent: smoke step\\n[~] smoke step"}],"details":{"items":[{"content":"smoke step","status":"in_progress"}],"currentIndex":0},"isError":false}]}',
  "^C",
  '{"type":"agent_settled","aborted":false}',
].join("\n");

const PROBE_LOG = [
  '{"name":"session_start","payload":{"reason":"startup","type":"session_start"}}',
  '{"name":"tool_call","payload":{"toolName":"todo_write"}}',
  '{"name":"session_shutdown","payload":{"reason":"quit","type":"session_shutdown"}}',
].join("\n");

const REQUESTS = [
  {
    call: 1,
    model: "smoke/smoke-model",
    messageRoles: ["system", "user"],
    toolNames: ["todo_write", "todo_read", "web_fetch"],
    lastUserText: "smoke: write a todo",
  },
  {
    call: 2,
    model: "smoke/smoke-model",
    messageRoles: ["system", "user", "assistant", "tool"],
    toolNames: ["todo_write", "todo_read", "web_fetch"],
    lastUserText: "smoke: write a todo",
  },
];

function observations(overrides: Partial<Observations> = {}): Observations {
  return {
    events: parseJsonl(SESSION_STREAM),
    probe: parseProbeLog(PROBE_LOG),
    requests: REQUESTS,
    exitCode: 0,
    stderr: "",
    ...overrides,
  };
}

describe("parseJsonl", () => {
  it("keeps well-formed records and drops malformed or blank lines", () => {
    expect(parseJsonl(SESSION_STREAM)).toHaveLength(7);
    expect(parseJsonl('{"type":"agent_start"}\n\nnot json\n{"type":')).toEqual([
      { type: "agent_start" },
    ]);
    expect(parseJsonl("")).toEqual([]);
  });
});

describe("parseProbeLog", () => {
  it("reads ordered extension lifecycle records", () => {
    expect(parseProbeLog(PROBE_LOG).map((r) => r.name)).toEqual([
      "session_start",
      "tool_call",
      "session_shutdown",
    ]);
  });

  it("skips malformed records and non-object payloads", () => {
    expect(parseProbeLog('{"name":"a","payload":{}}\n{oops\n{"payload":{}}')).toEqual([
      { name: "a", payload: {} },
    ]);
  });
});

describe("describeChatRequest", () => {
  const body = {
    model: "smoke-model",
    messages: [
      { role: "system", content: "you are a coding assistant" },
      { role: "user", content: [{ type: "text", text: "older prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "0/1 done" }],
      } as Record<string, unknown>,
    ],
    tools: [
      { type: "function", function: { name: "todo_write", parameters: {} } },
      { name: "web_fetch" },
    ],
  };

  it("captures call index, message roles and advertised tool names", () => {
    const request = describeChatRequest(body, 2);
    expect(request.call).toBe(2);
    expect(request.messageRoles).toEqual(["system", "user", "assistant", "toolResult"]);
    expect(request.toolNames).toEqual(["todo_write", "web_fetch"]);
    expect(request.lastUserText).toBe("older prompt");
  });

  it("tolerates an unrecognisable payload instead of throwing", () => {
    expect(describeChatRequest(null, 1)).toEqual({
      call: 1,
      model: "",
      messageRoles: [],
      toolNames: [],
      lastUserText: "",
    });
    expect(describeChatRequest({ messages: "nope", tools: "nope" }, 3).toolNames).toEqual([]);
  });
});

describe("toolResultsFromEvents", () => {
  it("flattens tool results carried by turn_end events", () => {
    const results = toolResultsFromEvents(parseJsonl(SESSION_STREAM));
    expect(results).toHaveLength(1);
    expect(results[0].toolName).toBe("todo_write");
    expect(results[0].isError).toBe(false);
    expect(results[0].text).toContain("Current: smoke step");
    expect(results[0].detailsKeys).toEqual(["items", "currentIndex"]);
  });

  it("returns nothing when turns carry no tool results", () => {
    expect(toolResultsFromEvents(parseJsonl('{"type":"turn_end","toolResults":[]}'))).toEqual([]);
  });
});

describe("evaluateObservations", () => {
  const passing: Expectation[] = [
    { kind: "exit", code: 0, description: "pi exits 0" },
    { kind: "event", type: "agent_settled", description: "agent settles" },
    {
      kind: "eventOrder",
      types: ["turn_start", "tool_execution_start", "agent_settled"],
      description: "tool runs inside the run",
    },
    {
      kind: "probe",
      name: "session_start",
      payload: { reason: "startup" },
      description: "startup session_start",
    },
    { kind: "probe", name: "session_shutdown", description: "shutdown observed" },
    {
      kind: "requestTools",
      includes: ["todo_write", "todo_read"],
      description: "extension tools reach the model",
    },
    {
      kind: "toolResult",
      toolName: "todo_write",
      textIncludes: "Current: smoke step",
      detailsKeys: ["items"],
      description: "todo_write keeps the dual result contract",
    },
  ];

  it("passes when the recorded evidence satisfies every expectation", () => {
    const findings = evaluateObservations(observations(), passing);
    expect(findings.map((f) => f.ok)).toEqual(passing.map(() => true));
  });

  it("fails with the observed value when evidence contradicts an expectation", () => {
    const broken: Expectation[] = [
      { kind: "exit", code: 1, description: "pi exits 1" },
      { kind: "event", type: "session_compact", description: "compaction event present" },
      { kind: "eventOrder", types: ["agent_settled", "turn_start"], description: "wrong order" },
      {
        kind: "probe",
        name: "session_start",
        payload: { reason: "resume" },
        description: "startup was a resume",
      },
      { kind: "requestTools", includes: ["lsp_diagnostics"], description: "lsp tool advertised" },
      { kind: "toolResult", toolName: "web_fetch", description: "web_fetch ran" },
      {
        kind: "toolResult",
        toolName: "todo_write",
        detailsKeys: ["missingKey"],
        description: "details key present",
      },
    ];
    const findings = evaluateObservations(observations(), broken);
    expect(findings.every((f) => !f.ok)).toBe(true);
    expect(findings[0].observed).toContain("0");
    expect(findings[1].observed).toContain("agent_settled");
    expect(findings[4].observed).toContain("todo_write");
    expect(findings[5].observed).toContain("no toolResult for web_fetch");
    expect(findings[6].observed).toContain("missingKey");
  });

  it("accepts requestRoles and stderrExcludes expectations", () => {
    const supported: Expectation[] = [
      {
        kind: "requestRoles",
        roles: ["tool"],
        requestIndex: 1,
        description: "second run replays the tool result",
      },
      {
        kind: "requestRoles",
        roles: ["system", "user"],
        description: "every request has system and user messages",
      },
      {
        kind: "stderrExcludes",
        pattern: "Failed to load extension",
        description: "no extension load failure",
      },
    ];
    expect(evaluateObservations(observations(), supported).map((f) => f.ok)).toEqual([
      true,
      true,
      true,
    ]);

    const failing: Expectation[] = [
      {
        kind: "requestRoles",
        roles: ["tool"],
        requestIndex: 0,
        description: "first request replays history",
      },
      {
        kind: "stderrExcludes",
        pattern: "Failed to load extension",
        description: "no extension load failure",
      },
    ];
    const findings = evaluateObservations(
      observations({ stderr: 'Error: Failed to load extension "/x/broken.ts": boom' }),
      failing,
    );
    expect(findings.map((f) => f.ok)).toEqual([false, false]);
    expect(findings[0].observed).toContain("system,user");
    expect(findings[1].observed).toContain("Failed to load extension");
  });

  it("reports a missing tool result rather than silently passing an empty stream", () => {
    const empty = observations({ events: [], probe: [], requests: [], exitCode: null });
    const findings = evaluateObservations(empty, passing);
    expect(findings.map((f) => f.ok)).toEqual([false, false, false, false, false, false, false]);
  });
});

describe("summarize", () => {
  it("counts passing and failing findings and lists the failures", () => {
    const summary = summarize([
      { ok: true, description: "a" },
      { ok: false, description: "b", observed: "saw c" },
    ]);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.text).toContain("1/2");
    expect(summary.text).toContain("saw c");
  });
});

describe("shipped scenarios", () => {
  it("have unique ids, a prompt, and at least one expectation per invocation", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of SCENARIOS) {
      expect(scenario.title.length).toBeGreaterThan(0);
      expect(scenario.invocations.length).toBeGreaterThan(0);
      for (const invocation of scenario.invocations) {
        expect(invocation.prompt.length).toBeGreaterThan(0);
        expect(invocation.expectations.length).toBeGreaterThan(0);
      }
    }
  });

  it("only reference extensions that exist in this repository", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.extensions.length).toBeGreaterThan(0);
      for (const dir of scenario.extensions) {
        expect(dir).toMatch(/^packages\/[a-z-]+$/);
      }
    }
  });
});