import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

const boundary = vi.hoisted(() => ({
  global: {} as Record<string, unknown>,
  project: {} as Record<string, unknown>,
  create: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: (file: string) =>
    JSON.stringify({
      subagents: file.includes("/agent/settings.json") ? boundary.global : boundary.project,
    }),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: boundary.create,
  ModelRuntime: { create: async () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  SessionManager: { inMemory: () => ({}) },
  getAgentDir: () => "/fake/agent",
}));
import extension from "../index.ts";

const parent = { provider: "test", id: "parent", reasoning: true };
const selected = { provider: "test", id: "selected", reasoning: true };
function harness(hasUI = true, parentModel = parent) {
  const tools = new Map<string, any>();
  const notify = vi.fn();
  const updates = vi.fn();
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    events: { emit: () => {} },
  } as any);
  const ctx = {
    cwd: "/project",
    model: parentModel,
    thinkingLevel: "max",
    hasUI,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "test" && id === "selected" ? selected : undefined,
    },
    ui: { notify },
  };
  return {
    notify,
    updates,
    async launch(type = "explore", background = false) {
      const start = await tools.get("Agent").execute(
        "call",
        {
          subagent_type: type,
          prompt: "task",
          description: "test task",
          run_in_background: background,
        },
        undefined,
        updates,
        ctx,
      );
      const result = background
        ? await tools
            .get("get_subagent_result")
            .execute("poll", { agent_id: start.details.agent_id, wait: true })
        : start;
      return {
        start,
        result,
        options: boundary.create.mock.calls.at(-1)![0] as CreateAgentSessionOptions,
      };
    },
  };
}

beforeEach(() => {
  boundary.global = {};
  boundary.project = {};
  boundary.create.mockReset();
  boundary.create.mockImplementation(async (options: CreateAgentSessionOptions) => {
    let listener: ((event: any) => void) | undefined;
    return {
      session: {
        thinkingLevel: clampThinkingLevel(options.model as any, options.thinkingLevel ?? "medium"),
        subscribe: (handler: typeof listener) => {
          listener = handler;
          return () => {};
        },
        async prompt() {
          listener?.({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "secret reasoning" },
          });
          listener?.({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "answer" },
          });
        },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "secret reasoning" },
              { type: "text", text: "answer" },
            ],
          },
        ],
        abort() {},
        dispose() {},
      },
    };
  });
});

describe("shared Subagent thinking at the Agent session boundary", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "accepts Pi's %s preference",
    async (thinkingLevel) => {
      boundary.global = { thinkingLevel };
      const { options } = await harness().launch("general", true);
      expect(options.thinkingLevel).toBe(thinkingLevel);
    },
  );

  it("warns for malformed thinking without losing the selected model", async () => {
    boundary.global = { thinkingLevel: false, defaultModel: "test/selected" };
    const h = harness();
    const { options, result } = await h.launch();
    expect(options).not.toHaveProperty("thinkingLevel");
    expect(options.model).toBe(selected);
    expect(result.details.warnings).toEqual([
      expect.objectContaining({
        setting: "subagents.thinkingLevel",
        type: "malformed",
      }),
    ]);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("subagents.thinkingLevel"),
      "warning",
    );
    expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("reports Pi's effective level after model resolution, including background polling", async () => {
    boundary.global = { thinkingLevel: "max", defaultModel: "test/selected" };
    const h = harness();
    const { options, result } = await h.launch("general", true);
    expect(options.model).toBe(selected);
    expect(options.thinkingLevel).toBe("max");
    expect(result.details.warnings).toEqual([
      expect.objectContaining({
        setting: "subagents.thinkingLevel",
        type: "clamped",
        requested: "max",
        effective: "high",
      }),
    ]);
    expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/max.*high/), "warning");
    expect(result.content).toEqual([{ type: "text", text: "answer" }]);
  });

  describe.each(["explore", "general"])("%s", (type) => {
    describe.each([false, true])("background=%s", (background) => {
      it("uses project thinking over global while retaining global model selection", async () => {
        boundary.global = { thinkingLevel: "high", defaultModel: "test/selected" };
        boundary.project = { thinkingLevel: "off" };
        const { options, result } = await harness().launch(type, background);
        expect(options.thinkingLevel).toBe("off");
        expect(options.model).toBe(selected);
        expect(result.details.warnings ?? []).toEqual([]);
      });

      it("inherits global thinking when project settings only change the model", async () => {
        boundary.global = { thinkingLevel: "low" };
        boundary.project = { defaultModel: "test/selected" };
        const { options } = await harness().launch(type, background);
        expect(options.thinkingLevel).toBe("low");
        expect(options.model).toBe(selected);
      });

      it("omits the override instead of inheriting Parent thinking, even with model-only config", async () => {
        for (const config of [{}, { defaultModel: "test/selected" }]) {
          boundary.global = config;
          const { options, result } = await harness().launch(type, background);
          expect(options).not.toHaveProperty("thinkingLevel");
          expect(result.details.warnings ?? []).toEqual([]);
        }
      });

      it("retains valid thinking when model resolution fails", async () => {
        for (const defaultModel of ["malformed", "missing/model"]) {
          boundary.global = { defaultModel, thinkingLevel: "low" };
          const { options, result } = await harness(false).launch(type, background);
          expect(options.thinkingLevel).toBe("low");
          expect(options.model).toBe(parent);
          expect(result.details.warnings).toHaveLength(1);
        }
      });

      it.each([null, false, 2, "", "HIGH", " high ", [], {}, "bogus"])(
        "treats malformed project thinking %j as absent",
        async (thinkingLevel) => {
          boundary.global = { thinkingLevel: "low", defaultModel: "test/selected" };
          boundary.project = { thinkingLevel };
          const h = harness(false);
          const { options, result } = await h.launch(type, background);
          expect(options).not.toHaveProperty("thinkingLevel");
          expect(options.model).toBe(selected);
          expect(result.details.warnings).toEqual([expect.objectContaining({ type: "malformed" })]);
          expect(h.notify).not.toHaveBeenCalled();
        },
      );

      it("reports non-reasoning adaptation without switching models or leaking reasoning", async () => {
        boundary.global = { thinkingLevel: "high" };
        const nonReasoning = { ...parent, reasoning: false };
        const h = harness(true, nonReasoning);
        const { options, result } = await h.launch(type, background);
        expect(options.model).toBe(nonReasoning);
        expect(options.thinkingLevel).toBe("high");
        expect(result.details.warnings).toEqual([
          expect.objectContaining({
            type: "clamped",
            requested: "high",
            effective: "off",
          }),
        ]);
        expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/high.*off/), "warning");
        expect(result.content).toEqual([{ type: "text", text: "answer" }]);
        expect(JSON.stringify(h.updates.mock.calls)).not.toContain("secret reasoning");
        if (background) expect(h.updates).not.toHaveBeenCalled();
        else expect(h.updates).toHaveBeenCalled();
      });
    });
  });

  it("passes a thinking-only preference with the Parent model", async () => {
    boundary.global = { thinkingLevel: "low" };
    const { options } = await harness().launch();
    expect(options.thinkingLevel).toBe("low");
    expect(options.model).toBe(parent);
  });
});