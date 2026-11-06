/**
 * Pure evaluation helpers for the real-Pi lifecycle smoke harness.
 *
 * The runner records three kinds of evidence from one real Pi invocation:
 *   - `events`: Pi's `--mode json` session stream (stdout JSONL)
 *   - `probe`: extension lifecycle events logged by `scripts/pi-smoke/probe.ts`
 *   - `requests`: model-request payloads captured by the stub provider
 *
 * Everything here is pure so the pass/fail logic can be unit tested against
 * recorded evidence without starting Pi (see `scripts/__tests__/pi-smoke.test.ts`).
 */

export type JsonRecord = Record<string, unknown>;

export type PiEvent = { type: string } & JsonRecord;

export type ProbeRecord = { name: string; payload: JsonRecord };

export type StubRequest = {
  call: number;
  model: string;
  messageRoles: string[];
  toolNames: string[];
  lastUserText: string;
};

export type ToolResultView = {
  toolName: string;
  text: string;
  detailsKeys: string[];
  isError: boolean;
};

export type Observations = {
  events: PiEvent[];
  probe: ProbeRecord[];
  requests: StubRequest[];
  exitCode: number | null;
  stderr: string;
};

export type Finding = { ok: boolean; description: string; observed?: string };

export type Expectation =
  | { kind: "exit"; code: number; description: string }
  | { kind: "event"; type: string; description: string }
  | { kind: "eventOrder"; types: string[]; description: string }
  | { kind: "probe"; name: string; payload?: JsonRecord; description: string }
  | { kind: "requestTools"; includes: string[]; description: string }
  | { kind: "requestRoles"; roles: string[]; requestIndex?: number; description: string }
  | { kind: "stderrExcludes"; pattern: string; description: string }
  | {
      kind: "toolResult";
      toolName: string;
      textIncludes?: string;
      detailsKeys?: string[];
      isError?: boolean;
      description: string;
    };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse newline-delimited JSON, dropping blank and malformed lines. */
export function parseJsonl(text: string): PiEvent[] {
  const records: PiEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.type === "string") records.push(parsed as PiEvent);
    } catch {
      // Pi diagnostics and truncated writes are not evidence; skip them.
    }
  }
  return records;
}

/** Parse the probe extension's event log. */
export function parseProbeLog(text: string): ProbeRecord[] {
  const records: ProbeRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed) || typeof parsed.name !== "string") continue;
      records.push({ name: parsed.name, payload: isRecord(parsed.payload) ? parsed.payload : {} });
    } catch {
      // A partial final line means the process died mid-write; ignore it.
    }
  }
  return records;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** Summarize one captured chat-completions request payload. */
export function describeChatRequest(body: unknown, call: number): StubRequest {
  const record = isRecord(body) ? body : {};
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const tools = Array.isArray(record.tools) ? record.tools : [];

  const messageRoles = messages
    .map((message) => (isRecord(message) && typeof message.role === "string" ? message.role : ""))
    .filter((role) => role.length > 0);

  const userMessages = messages.filter((message) => isRecord(message) && message.role === "user");
  const lastUser = userMessages.at(-1);

  return {
    call,
    model: typeof record.model === "string" ? record.model : "",
    messageRoles,
    toolNames: tools
      .map((tool) => {
        if (!isRecord(tool)) return "";
        if (isRecord(tool.function) && typeof tool.function.name === "string")
          return tool.function.name;
        return typeof tool.name === "string" ? tool.name : "";
      })
      .filter((name) => name.length > 0),
    lastUserText: isRecord(lastUser) ? textOf(lastUser.content) : "",
  };
}

/** Flatten the tool results Pi reports in `turn_end` events. */
export function toolResultsFromEvents(events: PiEvent[]): ToolResultView[] {
  const results: ToolResultView[] = [];
  for (const event of events) {
    if (event.type !== "turn_end") continue;
    const raw = event.toolResults;
    if (!Array.isArray(raw)) continue;
    for (const result of raw) {
      if (!isRecord(result)) continue;
      const details = isRecord(result.details) ? result.details : {};
      results.push({
        toolName: typeof result.toolName === "string" ? result.toolName : "",
        text: textOf(result.content),
        detailsKeys: Object.keys(details),
        isError: result.isError === true,
      });
    }
  }
  return results;
}

function containsInOrder(sequence: string[], expected: string[]): boolean {
  let index = 0;
  for (const value of sequence) {
    if (value === expected[index]) index += 1;
    if (index === expected.length) return true;
  }
  return index === expected.length;
}

function payloadMatches(actual: JsonRecord, expected: JsonRecord): boolean {
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
  );
}

function evaluateExpectation(observations: Observations, expectation: Expectation): Finding {
  const eventTypes = observations.events.map((event) => event.type);

  switch (expectation.kind) {
    case "exit": {
      const observed = `exit code ${observations.exitCode}`;
      return {
        ok: observations.exitCode === expectation.code,
        description: expectation.description,
        observed,
      };
    }
    case "event": {
      const count = eventTypes.filter((type) => type === expectation.type).length;
      return {
        ok: count > 0,
        description: expectation.description,
        observed:
          count > 0
            ? `${count}× ${expectation.type}`
            : `no ${expectation.type}; saw ${eventTypes.join(" ") || "no events"}`,
      };
    }
    case "eventOrder": {
      const ok = containsInOrder(eventTypes, expectation.types);
      return {
        ok,
        description: expectation.description,
        observed: ok ? expectation.types.join(" → ") : `saw ${eventTypes.join(" ") || "no events"}`,
      };
    }
    case "probe": {
      const matches = observations.probe.filter(
        (record) =>
          record.name === expectation.name &&
          (!expectation.payload || payloadMatches(record.payload, expectation.payload)),
      );
      const seen = observations.probe.map(
        (record) => `${record.name}(${JSON.stringify(record.payload)})`,
      );
      return {
        ok: matches.length > 0,
        description: expectation.description,
        observed:
          matches.length > 0
            ? `${matches.length}× ${expectation.name}`
            : `no matching ${expectation.name}; saw ${seen.join(" ") || "no events"}`,
      };
    }
    case "requestTools": {
      const missing = new Set<string>();
      for (const request of observations.requests) {
        for (const name of expectation.includes) {
          if (!request.toolNames.includes(name)) missing.add(`${name} (request ${request.call})`);
        }
      }
      if (observations.requests.length === 0) missing.add("no captured requests");
      const seen = observations.requests
        .map((request) => `request ${request.call}: ${request.toolNames.join(",") || "no tools"}`)
        .join("; ");
      return {
        ok: missing.size === 0,
        description: expectation.description,
        observed:
          missing.size === 0
            ? `all requests advertise ${expectation.includes.join(", ")}`
            : `missing ${[...missing].join(", ")}; saw ${seen}`,
      };
    }
    case "requestRoles": {
      const requestIndex = expectation.requestIndex;
      const targets =
        requestIndex === undefined
          ? observations.requests
          : observations.requests.filter((request) => request.call === requestIndex + 1);
      const missing: string[] = [];
      for (const request of targets) {
        for (const role of expectation.roles) {
          if (!request.messageRoles.includes(role))
            missing.push(`${role} (request ${request.call})`);
        }
      }
      if (targets.length === 0) missing.push(`no captured request ${requestIndex}`);
      const seen = targets
        .map(
          (request) =>
            `request ${request.call}: ${request.messageRoles.join(",") || "no messages"}`,
        )
        .join("; ");
      return {
        ok: missing.length === 0,
        description: expectation.description,
        observed:
          missing.length === 0
            ? `roles present in ${targets.length} request(s)`
            : `missing ${missing.join(", ")}; saw ${seen}`,
      };
    }
    case "stderrExcludes": {
      const lines = observations.stderr
        .split("\n")
        .filter((line) => line.includes(expectation.pattern));
      return {
        ok: lines.length === 0,
        description: expectation.description,
        observed:
          lines.length === 0
            ? `no line matching ${JSON.stringify(expectation.pattern)}`
            : lines[0].trim(),
      };
    }
    case "toolResult": {
      const results = toolResultsFromEvents(observations.events);
      const candidates = results.filter((result) => result.toolName === expectation.toolName);
      const mismatches = (result: ToolResultView): string[] => {
        const reasons: string[] = [];
        if (expectation.isError !== undefined && result.isError !== expectation.isError) {
          reasons.push(`isError=${result.isError}`);
        }
        if (
          expectation.textIncludes !== undefined &&
          !result.text.includes(expectation.textIncludes)
        ) {
          reasons.push(`text lacks ${JSON.stringify(expectation.textIncludes)}`);
        }
        const missingDetails = (expectation.detailsKeys ?? []).filter(
          (key) => !result.detailsKeys.includes(key),
        );
        if (missingDetails.length > 0) reasons.push(`details missing ${missingDetails.join(",")}`);
        return reasons;
      };
      if (candidates.some((result) => mismatches(result).length === 0)) {
        return {
          ok: true,
          description: expectation.description,
          observed: `${expectation.toolName} result matched`,
        };
      }
      if (candidates.length === 0) {
        const seen = results.map((result) => result.toolName).join(", ") || "none";
        return {
          ok: false,
          description: expectation.description,
          observed: `no toolResult for ${expectation.toolName}; saw ${seen}`,
        };
      }
      const seen = candidates
        .map(
          (result) =>
            `[${mismatches(result).join("; ")}] text=${JSON.stringify(result.text).slice(0, 120)} details=[${result.detailsKeys.join(",")}]`,
        )
        .join(" | ");
      return {
        ok: false,
        description: expectation.description,
        observed: `${expectation.toolName} results did not match: ${seen}`,
      };
    }
  }
}

/** Evaluate every expectation against one invocation's recorded evidence. */
export function evaluateObservations(
  observations: Observations,
  expectations: Expectation[],
): Finding[] {
  return expectations.map((expectation) => evaluateExpectation(observations, expectation));
}

export type Summary = { total: number; passed: number; failed: number; text: string };

export function summarize(findings: Finding[]): Summary {
  const passed = findings.filter((finding) => finding.ok).length;
  const failed = findings.length - passed;
  const lines = [`${passed}/${findings.length} checks passed`];
  for (const finding of findings) {
    lines.push(
      `  ${finding.ok ? "✓" : "✗"} ${finding.description}${finding.observed ? ` — ${finding.observed}` : ""}`,
    );
  }
  return { total: findings.length, passed, failed, text: lines.join("\n") };
}