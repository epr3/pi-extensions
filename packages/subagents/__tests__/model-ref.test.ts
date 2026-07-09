import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
  parseModelRef,
  resolveDefaultModel,
  resolveTypeDefaultModel,
  checkDefaultModelWarnings,
} from "../model-ref.ts";
import { AgentManager } from "../manager.ts";

// ---------------------------------------------------------------------------
// Fake model helpers
// ---------------------------------------------------------------------------

function fakeModel(provider: string, id: string): Model<any> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}

const anthropicModel = fakeModel("anthropic", "claude-sonnet-4-20250514");
const openaiModel = fakeModel("openai", "gpt-4o");

function fakeRegistry(models: Model<any>[]) {
  return {
    find(provider: string, modelId: string): Model<any> | undefined {
      return models.find((m) => m.provider === provider && m.id === modelId);
    },
  };
}

// ---------------------------------------------------------------------------
// parseModelRef tests
// ---------------------------------------------------------------------------

describe("parseModelRef", () => {
  it("parses provider/model correctly", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-20250514")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    expect(parseModelRef("openai/gpt-4o")).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("trims whitespace", () => {
    expect(parseModelRef("  openai/gpt-4o  ")).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("returns null for missing slash", () => {
    expect(parseModelRef("anthropic-claude-sonnet")).toBeNull();
  });

  it("returns null for empty provider", () => {
    expect(parseModelRef("/gpt-4o")).toBeNull();
  });

  it("returns null for empty modelId", () => {
    expect(parseModelRef("openai/")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseModelRef("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parseModelRef("   ")).toBeNull();
  });

  it("returns null for slash at start only", () => {
    expect(parseModelRef("/foo")).toBeNull();
  });

  it("returns null for slash at end only", () => {
    expect(parseModelRef("foo/")).toBeNull();
  });

  it("handles multiple slashes (first slash delimits provider)", () => {
    expect(parseModelRef("provider/foo/bar")).toEqual({
      provider: "provider",
      modelId: "foo/bar",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultModel tests
// ---------------------------------------------------------------------------

describe("resolveDefaultModel", () => {
  const registry = fakeRegistry([anthropicModel, openaiModel]);
  const find = (p: string, m: string) => registry.find(p, m);

  it("resolves shared default model", () => {
    const resolved = resolveDefaultModel(
      "anthropic/claude-sonnet-4-20250514",
      find,
      anthropicModel,
    );
    expect(resolved).toBe(anthropicModel);
  });

  it("resolves different model", () => {
    const resolved = resolveDefaultModel("openai/gpt-4o", find, anthropicModel);
    expect(resolved).toBe(openaiModel);
  });

  it("returns parent model when no default configured", () => {
    expect(resolveDefaultModel(undefined, find, anthropicModel)).toBe(anthropicModel);
  });

  it("returns parent model for empty string", () => {
    expect(resolveDefaultModel("", find, anthropicModel)).toBe(anthropicModel);
  });

  it("returns parent model for invalid reference", () => {
    expect(resolveDefaultModel("bogus", find, anthropicModel)).toBe(anthropicModel);
  });

  it("returns parent model for unresolvable reference", () => {
    expect(resolveDefaultModel("faux/unknown", find, anthropicModel)).toBe(anthropicModel);
  });

  it("returns undefined when parent undefined and no default", () => {
    expect(resolveDefaultModel(undefined, find, undefined)).toBeUndefined();
  });

  it("resolves valid default even when parent is undefined", () => {
    expect(resolveDefaultModel("anthropic/claude-sonnet-4-20250514", find, undefined))
      .toBe(anthropicModel);
  });
});

// ---------------------------------------------------------------------------
// resolveTypeDefaultModel tests
// ---------------------------------------------------------------------------

describe("resolveTypeDefaultModel", () => {
  const registry = fakeRegistry([anthropicModel, openaiModel]);
  const find = (p: string, m: string) => registry.find(p, m);
  const none = { explore: undefined, general: undefined };

  it("type-specific override wins over shared default", () => {
    const r = resolveTypeDefaultModel(
      { explore: "openai/gpt-4o", general: undefined },
      "explore",
      "anthropic/claude-sonnet-4-20250514",
      find,
      anthropicModel,
    );
    expect(r).toBe(openaiModel);
  });

  it("type without override falls back to shared default", () => {
    const r = resolveTypeDefaultModel(
      { explore: "openai/gpt-4o", general: undefined },
      "general",
      "anthropic/claude-sonnet-4-20250514",
      find,
      anthropicModel,
    );
    expect(r).toBe(anthropicModel);
  });

  it("no overrides, no shared default → parent model", () => {
    expect(resolveTypeDefaultModel(none, "general", undefined, find, anthropicModel))
      .toBe(anthropicModel);
  });

  it("unresolvable type override → fall through to shared default", () => {
    const r = resolveTypeDefaultModel(
      { explore: "faux/unknown", general: undefined },
      "explore",
      "openai/gpt-4o",
      find,
      anthropicModel,
    );
    expect(r).toBe(openaiModel);
  });

  it("invalid type override syntax → fall through to shared default", () => {
    const r = resolveTypeDefaultModel(
      { explore: "no-slash-here", general: undefined },
      "explore",
      "openai/gpt-4o",
      find,
      anthropicModel,
    );
    expect(r).toBe(openaiModel);
  });

  it("empty type override string → fall through to shared default", () => {
    const r = resolveTypeDefaultModel(
      { explore: "", general: undefined },
      "explore",
      "openai/gpt-4o",
      find,
      anthropicModel,
    );
    expect(r).toBe(openaiModel);
  });

  it("all levels absent → parent model", () => {
    expect(resolveTypeDefaultModel(none, "explore", undefined, find, anthropicModel))
      .toBe(anthropicModel);
  });

  it("all levels absent, no parent → undefined", () => {
    expect(resolveTypeDefaultModel(none, "explore", undefined, find, undefined)).toBeUndefined();
  });

  it("type override applies only to its own type", () => {
    const r = resolveTypeDefaultModel(
      { explore: "openai/gpt-4o", general: undefined },
      "general",
      undefined,
      find,
      anthropicModel,
    );
    expect(r).toBe(anthropicModel);
  });
});

// ---------------------------------------------------------------------------
// Tool wiring seam: model passthrough via AgentManager exec thunk
// ---------------------------------------------------------------------------

describe("tool wiring seam", () => {
  it("passes resolved shared default model to exec thunk", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    let capturedModel: Model<any> | undefined;
    const model = resolveDefaultModel("openai/gpt-4o", find, anthropicModel);
    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "hello", tokens: 0, toolUses: 0 };
      },
    );
    await done;
    expect(capturedModel).toBe(openaiModel);
  });

  it("falls back to parent model when unconfigured", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    let capturedModel: Model<any> | undefined;
    const model = resolveDefaultModel(undefined, find, anthropicModel);
    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "hello", tokens: 0, toolUses: 0 };
      },
    );
    await done;
    expect(capturedModel).toBe(anthropicModel);
  });

  it("falls back to parent model when unresolvable", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    let capturedModel: Model<any> | undefined;
    const model = resolveDefaultModel("faux/unknown", find, anthropicModel);
    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "hello", tokens: 0, toolUses: 0 };
      },
    );
    await done;
    expect(capturedModel).toBe(anthropicModel);
  });
});

// ---------------------------------------------------------------------------
// Type-specific wiring seam
// ---------------------------------------------------------------------------

describe("type-specific wiring seam", () => {
  it("type-specific override wins", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    let capturedModel: Model<any> | undefined;
    const model = resolveTypeDefaultModel(
      { explore: "openai/gpt-4o", general: undefined },
      "explore",
      "anthropic/claude-sonnet-4-20250514",
      find,
      anthropicModel,
    );
    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "ok", tokens: 0, toolUses: 0 };
      },
    );
    await done;
    expect(capturedModel).toBe(openaiModel);
  });

  it("type without override → shared default", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    let capturedModel: Model<any> | undefined;
    const model = resolveTypeDefaultModel(
      { explore: "openai/gpt-4o", general: undefined },
      "general",
      "anthropic/claude-sonnet-4-20250514",
      find,
      anthropicModel,
    );
    const { done } = manager.launch(
      { type: "general", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "ok", tokens: 0, toolUses: 0 };
      },
    );
    await done;
    expect(capturedModel).toBe(anthropicModel);
  });

  it("no override, no shared → parent", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    let capturedModel: Model<any> | undefined;
    const model = resolveTypeDefaultModel(
      { explore: undefined, general: undefined },
      "general",
      undefined,
      find,
      anthropicModel,
    );
    const { done } = manager.launch(
      { type: "general", description: "test" },
      async () => {
        capturedModel = model;
        return { result: "ok", tokens: 0, toolUses: 0 };
      },
    );
    await done;
    expect(capturedModel).toBe(anthropicModel);
  });

  it("result text unchanged regardless of model", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    const _model = resolveTypeDefaultModel(
      { explore: "openai/gpt-4o", general: undefined },
      "explore",
      "anthropic/claude-sonnet-4-20250514",
      find,
      anthropicModel,
    );
    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => ({
        result: "ok",
        tokens: 0,
        toolUses: 0,
      }),
    );
    const rec = await done;
    expect(rec.result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// checkDefaultModelWarnings tests
// ---------------------------------------------------------------------------

describe("checkDefaultModelWarnings", () => {
  const registry = fakeRegistry([anthropicModel, openaiModel]);
  const find = (p: string, m: string) => registry.find(p, m);

  it("no configured refs → no warnings", () => {
    expect(checkDefaultModelWarnings(undefined, undefined, find, "explore")).toEqual([]);
  });

  it("malformed type ref → one malformed warning", () => {
    const w = checkDefaultModelWarnings("no-slash-here", undefined, find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("explore");
    expect(w[0].reference).toBe("no-slash-here");
    expect(w[0].type).toBe("malformed");
  });

  it("unresolvable type ref → one unresolvable warning", () => {
    const w = checkDefaultModelWarnings("faux/unknown", undefined, find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("explore");
    expect(w[0].reference).toBe("faux/unknown");
    expect(w[0].type).toBe("unresolvable");
  });

  it("malformed shared ref → one malformed warning", () => {
    const w = checkDefaultModelWarnings(undefined, "bogus-ref", find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("shared");
    expect(w[0].reference).toBe("bogus-ref");
    expect(w[0].type).toBe("malformed");
  });

  it("unresolvable shared ref → one unresolvable warning", () => {
    const w = checkDefaultModelWarnings(undefined, "faux/unknown", find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("shared");
    expect(w[0].reference).toBe("faux/unknown");
    expect(w[0].type).toBe("unresolvable");
  });

  it("both malformed → two warnings", () => {
    const w = checkDefaultModelWarnings("bad", "also-bad", find, "explore");
    expect(w).toHaveLength(2);
    expect(w[0].scope).toBe("explore");
    expect(w[0].type).toBe("malformed");
    expect(w[1].scope).toBe("shared");
    expect(w[1].type).toBe("malformed");
  });

  it("both valid → no warnings", () => {
    const w = checkDefaultModelWarnings(
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-20250514",
      find,
      "explore",
    );
    expect(w).toHaveLength(0);
  });

  it("type valid, shared malformed → warn about shared only", () => {
    const w = checkDefaultModelWarnings("openai/gpt-4o", "broken", find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("shared");
    expect(w[0].type).toBe("malformed");
  });

  it("type malformed, shared valid → warn about type only", () => {
    const w = checkDefaultModelWarnings("broken", "openai/gpt-4o", find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("explore");
    expect(w[0].type).toBe("malformed");
  });

  it("type applies only to its own scope in warnings", () => {
    const w = checkDefaultModelWarnings("faux/unknown", undefined, find, "explore");
    expect(w).toHaveLength(1);
    expect(w[0].scope).toBe("explore");
  });
});

// ---------------------------------------------------------------------------
// Warning details shape
// ---------------------------------------------------------------------------

describe("warning details in tool result", () => {
  it("warnings appear in details, not in result text", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    const warnings = checkDefaultModelWarnings("bad-ref", undefined, find, "explore");
    expect(warnings).toHaveLength(1);

    const { done } = manager.launch(
      { type: "explore", description: "test" },
      async () => ({ result: "clean output", tokens: 10, toolUses: 2 }),
    );
    const rec = await done;
    const result = {
      content: [{ type: "text" as const, text: rec.result ?? "" }],
      details: { ...rec, ...(warnings.length > 0 ? { warnings } : {}) },
    };

    expect(Array.isArray(result.details.warnings)).toBe(true);
    expect(result.details.warnings).toHaveLength(1);
    expect(result.details.warnings[0].scope).toBe("explore");
    expect(result.details.warnings[0].type).toBe("malformed");
    expect(result.content[0].text).toBe("clean output");
  });

  it("background warnings survive round-trip", async () => {
    const manager = new AgentManager({ maxConcurrency: 1 });
    const registry = fakeRegistry([anthropicModel, openaiModel]);
    const find = (p: string, m: string) => registry.find(p, m);

    const warnings = checkDefaultModelWarnings("faux/unknown", undefined, find, "general");
    expect(warnings).toHaveLength(1);

    const { record: bgRec, done: bgDone } = manager.launch(
      { type: "general", description: "bg-test", background: true },
      async () => ({ result: "bg work", tokens: 3, toolUses: 1 }),
    );
    bgRec.warnings = warnings;
    await bgDone;

    const polled = await manager.getResult(bgRec.id, false);
    expect(Array.isArray(polled.warnings)).toBe(true);
    expect(polled.warnings).toHaveLength(1);
    expect(polled.warnings[0].scope).toBe("general");
    expect(polled.warnings[0].type).toBe("unresolvable");
    expect(polled.result).toBe("bg work");
  });
});
