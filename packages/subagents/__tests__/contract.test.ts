import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentParams, resultParams } from "../index.ts";
import { SAFETY_EXCLUDES } from "../agents.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Agent parameter shape — one-run-only contract
// ---------------------------------------------------------------------------

describe("Agent param shape", () => {
  it("has exactly 4 keys: subagent_type, prompt, description, run_in_background", () => {
    const props = agentParams.properties;
    const keys = Object.keys(props).toSorted();
    expect(keys).toEqual(["description", "prompt", "run_in_background", "subagent_type"]);
  });

  it("has correct types for each property", () => {
    const props = agentParams.properties;
    // subagent_type is a documented string: fixed two-value enums cannot
    // address custom Subagent types, so valid custom names are surfaced in the
    // parameter description and validated at launch time instead.
    expect(props.subagent_type.type).toBe("string");
    const stDescription = (props.subagent_type as any).description;
    expect(typeof stDescription).toBe("string");
    expect(stDescription).toContain("explore");
    expect(stDescription).toContain("general");
    expect(stDescription).toContain("Custom");
    expect(props.prompt.type).toBe("string");
    expect(props.description.type).toBe("string");
    expect(props.run_in_background.type).toBe("boolean");
  });

  it("has no batch or aggregate params", () => {
    const props = agentParams.properties;
    const forbidden = [
      "tasks",
      "batch",
      "batch_size",
      "groupId",
      "group_id",
      "results",
      "aggregate",
      "calls",
      "parallel",
      "items",
      "prompts",
    ];
    for (const key of forbidden) {
      expect(props).not.toHaveProperty(key);
    }
  });

  it("has correct required fields", () => {
    const required = (agentParams.required ?? []) as string[];
    expect([...required].toSorted()).toEqual(["description", "prompt", "subagent_type"]);
    expect(required).not.toContain("run_in_background");
  });
});

// ---------------------------------------------------------------------------
// get_subagent_result parameter shape
// ---------------------------------------------------------------------------

describe("result params", () => {
  it("has agent_id and wait with correct types", () => {
    const props = resultParams.properties;
    expect(Object.keys(props).toSorted()).toEqual(["agent_id", "wait"]);
    expect(props.agent_id.type).toBe("string");
    expect(props.wait.type).toBe("boolean");
  });

  it("has no aggregate or batch keys", () => {
    const props = resultParams.properties;
    expect(props).not.toHaveProperty("agent_ids");
    expect(props).not.toHaveProperty("group");
  });
});

// ---------------------------------------------------------------------------
// Subagent type surface — built-ins documented, custom types not enumerable
// in the schema (they are discovered from agent definition directories and
// validated at launch time)
// ---------------------------------------------------------------------------

describe("subagent_type surface", () => {
  it("documents the built-in types and custom-type discovery", () => {
    const st = agentParams.properties.subagent_type;
    const stDescription = String((st as any).description ?? "");
    expect(stDescription).toContain("explore");
    expect(stDescription).toContain("general");
    // No retired built-in is represented as a valid value.
    expect(stDescription.toLowerCase()).not.toContain("'researcher'");
  });
});

// ---------------------------------------------------------------------------
// Safety exclusions unchanged
// ---------------------------------------------------------------------------

describe("SAFETY_EXCLUDES", () => {
  it("has the expected three tools", () => {
    expect(SAFETY_EXCLUDES).toEqual(["Agent", "get_subagent_result", "question"]);
  });

  it("prevents recursion into Agent and get_subagent_result", () => {
    expect(SAFETY_EXCLUDES).toContain("Agent");
    expect(SAFETY_EXCLUDES).toContain("get_subagent_result");
    expect(SAFETY_EXCLUDES).toContain("question");
  });
});

// ---------------------------------------------------------------------------
// Prompt guidelines say independent calls not batch
// ---------------------------------------------------------------------------

describe("prompt guidelines", () => {
  const indexPath = path.resolve(testDir, "../index.ts");

  it("describe same-turn fan-out as multiple Agent calls", () => {
    const source = readFileSync(indexPath, "utf-8");
    expect(source).toContain("multiple foreground Agent calls in the same assistant turn");
  });

  it("reject batch parameter usage", () => {
    const source = readFileSync(indexPath, "utf-8");
    expect(source).toContain("Do not use a batch parameter or aggregate result API");
  });

  it("say each call returns its own result", () => {
    const source = readFileSync(indexPath, "utf-8");
    expect(source).toContain("each call returns its own result");
  });

  it("do not suggest batching", () => {
    const source = readFileSync(indexPath, "utf-8");
    expect(source).not.toContain("run multiple prompts in one Agent call");
  });
});

// ---------------------------------------------------------------------------
// README documents one-run-only contract
// ---------------------------------------------------------------------------

describe("README", () => {
  const readmePath = path.resolve(testDir, "../README.md");

  it("states the Agent is not a batch API", () => {
    const readme = readFileSync(readmePath, "utf-8");
    const hasStatement = readme.includes("not a batch API") || readme.includes("Not a batch API");
    expect(hasStatement).toBe(true);
  });

  it("documents the one-run-only contract", () => {
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("The `Agent` contract stays one-run-only");
  });

  it("mentions no aggregate result", () => {
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("no aggregate result");
  });

  it("does not document a tasks parameter", () => {
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).not.toContain("tasks parameter");
  });

  it("explicitly says no tasks parameter", () => {
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("no `tasks` parameter");
  });

  it("documents same-turn fan-out as multiple Agent calls", () => {
    const readme = readFileSync(readmePath, "utf-8");
    const hasFanOut = readme.includes("Same-turn fan-out") || readme.includes("same-turn fan-out");
    expect(hasFanOut).toBe(true);
    expect(readme).toContain("multiple foreground `Agent` tool calls");
  });
});