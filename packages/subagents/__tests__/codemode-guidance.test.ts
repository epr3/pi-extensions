import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

const boundary = vi.hoisted(() => ({
  create: vi.fn(),
  loaderOptions: undefined as
    | { systemPromptOverride?: (base: string | undefined) => string | undefined }
    | undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: boundary.create,
  ModelRuntime: { create: async () => ({}) },
  DefaultResourceLoader: class {
    constructor(options: any) {
      boundary.loaderOptions = options;
    }
    async reload() {}
  },
  SessionManager: { inMemory: () => ({}) },
  getAgentDir: () => "/fake/agent",
}));

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: () => {
    throw new Error("no settings");
  },
}));

import { CODEMODE_GUIDANCE, DEFAULT_EXPLORE_TOOLS } from "../agents.ts";
import { runSubagent } from "../runner.ts";

function fakeSession() {
  return {
    session: {
      thinkingLevel: "high",
      subscribe: () => () => {},
      async prompt() {},
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      abort() {},
      dispose() {},
    },
  };
}

function promptOverride(base = "BASE PROMPT"): string | undefined {
  const override = boundary.loaderOptions?.systemPromptOverride;
  expect(override).toBeTypeOf("function");
  return override!(base);
}

beforeEach(() => {
  boundary.create.mockReset();
  boundary.loaderOptions = undefined;
  boundary.create.mockImplementation(async () => fakeSession());
});

describe("codemode preference guidance", () => {
  it("appends the guidance to general's inherited system prompt", async () => {
    await runSubagent({ type: "general", prompt: "p", cwd: "/project" });
    const prompt = promptOverride();
    expect(prompt).toContain("BASE PROMPT");
    expect(prompt).toContain(CODEMODE_GUIDANCE);
  });

  it("appends the guidance to a custom definition's body", async () => {
    await runSubagent({
      type: "reviewer",
      agentDef: {
        name: "reviewer",
        description: "review",
        systemPrompt: "CUSTOM BODY",
        skills: [],
        sourcePath: "/tmp/reviewer.md",
      } as any,
      prompt: "p",
      cwd: "/project",
    });
    const prompt = promptOverride(undefined);
    expect(prompt).toContain("CUSTOM BODY");
    expect(prompt).toContain(CODEMODE_GUIDANCE);
  });

  it("omits the guidance when codemode is not available", async () => {
    await runSubagent({
      type: "general",
      prompt: "p",
      cwd: "/project",
      codemodeAvailable: false,
    });
    expect(boundary.loaderOptions?.systemPromptOverride).toBeUndefined();
  });
});

describe("explore allowlist degradation", () => {
  it("keeps codemode when only an optional granted tool is rejected", async () => {
    boundary.create.mockImplementation(async (options: CreateAgentSessionOptions) => {
      if (options.tools?.includes("lsp_definition")) {
        throw new Error("Unknown tool in allowlist: lsp_definition");
      }
      return fakeSession();
    });
    await runSubagent({
      type: "explore",
      prompt: "p",
      cwd: "/project",
      tools: [...DEFAULT_EXPLORE_TOOLS, "lsp_definition"],
    });
    const lastTools = boundary.create.mock.calls.at(-1)![0].tools as string[];
    expect(lastTools).toContain("codemode");
    expect(lastTools).not.toContain("lsp_definition");
  });

  it("falls back to the core read tools when codemode itself is rejected", async () => {
    boundary.create.mockImplementation(async (options: CreateAgentSessionOptions) => {
      if (options.tools?.includes("codemode")) throw new Error("Unknown tool: codemode");
      return fakeSession();
    });
    await runSubagent({
      type: "explore",
      prompt: "p",
      cwd: "/project",
      tools: [...DEFAULT_EXPLORE_TOOLS],
    });
    const lastTools = boundary.create.mock.calls.at(-1)![0].tools as string[];
    expect(lastTools).toEqual(["read", "grep", "find", "ls"]);
  });
});