import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentParams, resultParams } from "../index.ts";
import { SAFETY_EXCLUDES } from "../agents.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Agent parameter shape — one-run-only contract
// ---------------------------------------------------------------------------

describe("Agent param shape", () => {
  it("has exactly 4 keys: subagent_type, prompt, description, run_in_background", () => {
    const props = agentParams.properties;
    const keys = Object.keys(props).sort();
    expect(keys).toEqual(["description", "prompt", "run_in_background", "subagent_type"]);
  });

  it("has correct types for each property", () => {
    const props = agentParams.properties;
    expect(props.subagent_type.type).toBe("string");
    // subagent_type is an enum/oneOf
    const hasEnum = Array.isArray((props.subagent_type as any).oneOf) ||
      Array.isArray((props.subagent_type as any).enum);
    expect(hasEnum).toBe(true);
    expect(props.prompt.type).toBe("string");
    expect(props.description.type).toBe("string");
    expect(props.run_in_background.type).toBe("boolean");
  });

  it("has no batch or aggregate params", () => {
    const props = agentParams.properties;
    const forbidden = ["tasks", "batch", "batch_size", "groupId", "group_id", "results",
      "aggregate", "calls", "parallel", "items", "prompts"];
    for (const key of forbidden) {
      expect(props).not.toHaveProperty(key);
    }
  });

  it("has correct required fields", () => {
    const required = (agentParams.required ?? []) as string[];
    expect([...required].sort()).toEqual(["description", "prompt", "subagent_type"]);
    expect(required).not.toContain("run_in_background");
  });
});

// ---------------------------------------------------------------------------
// get_subagent_result parameter shape
// ---------------------------------------------------------------------------

describe("result params", () => {
  it("has agent_id and wait with correct types", () => {
    const props = resultParams.properties;
    expect(Object.keys(props).sort()).toEqual(["agent_id", "wait"]);
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
// Subagent type enum — exactly 3 values
// ---------------------------------------------------------------------------

describe("subagent_type enum", () => {
  it("has exactly 2 values: explore, general", () => {
    const st = agentParams.properties.subagent_type;
    const values: string[] = [];
    if ((st as any).enum) {
      values.push(...(st as any).enum);
    } else if ((st as any).oneOf) {
      for (const s of (st as any).oneOf) values.push(s.const ?? s.enum?.[0]);
    }
    expect(values).toHaveLength(2);
    expect(values).toContain("explore");
    expect(values).toContain("general");
    expect(values).not.toContain("researcher");
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
  const indexPath = path.resolve(__dirname, "../index.ts");

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
  const readmePath = path.resolve(__dirname, "../README.md");

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
