import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { createCatalog, type ModelPresetCatalog } from "../catalog.ts";

// ─── Fake Pi API ─────────────────────────────────────────────────────────────

interface FakePiState {
  setModelCalls: Array<{ id: string; provider: string }>;
  setThinkingLevelCalls: string[];
  currentThinkingLevel: string;
  eventHandlers: Record<string, Function>;
  commands: Array<{
    name: string;
    description?: string;
    handler: Function;
  }>;
  shortcuts: Array<{
    shortcut: string;
    description?: string;
    handler: Function;
  }>;
}

function makeFakePi(): { api: ExtensionAPI; state: FakePiState } {
  const state: FakePiState = {
    setModelCalls: [],
    setThinkingLevelCalls: [],
    currentThinkingLevel: "off",
    eventHandlers: {},
    commands: [],
    shortcuts: [],
  };

  const api = {
    setModel: async (model: any) => {
      state.setModelCalls.push({ id: model.id, provider: model.provider });
      return true;
    },
    setThinkingLevel: (level: string) => {
      state.setThinkingLevelCalls.push(level);
      state.currentThinkingLevel = level;
    },
    getThinkingLevel: () => state.currentThinkingLevel,
    registerCommand: (name: string, opts: any) => {
      state.commands.push({ name, ...opts });
    },
    registerShortcut: (shortcut: string, opts: any) => {
      state.shortcuts.push({ shortcut, ...opts });
    },
    on: (event: string, handler: Function) => {
      state.eventHandlers[event] = handler;
    },
  } as unknown as ExtensionAPI;

  return { api, state };
}

function makeFakeCtx(overrides?: Record<string, any>): any {
  return {
    model: undefined,
    modelRegistry: {
      find: () => undefined,
    },
    ui: {
      notify: () => {},
      select: async () => undefined,
      setStatus: () => {},
    },
    hasUI: true,
    ...overrides,
  };
}

interface FakeUiState {
  notifyCalls: Array<{ message: string; type: string }>;
  setStatusCalls: Array<{ key: string; text: string | undefined }>;
}

function makeFakeCtxWithTracking(): { ctx: any; uiState: FakeUiState } {
  const uiState: FakeUiState = {
    notifyCalls: [],
    setStatusCalls: [],
  };
  const ctx = makeFakeCtx({
    ui: {
      notify: (message: string, type: string) => {
        uiState.notifyCalls.push({ message, type });
      },
      select: async () => undefined,
      setStatus: (key: string, text: string | undefined) => {
        uiState.setStatusCalls.push({ key, text });
      },
    },
  });
  return { ctx, uiState };
}

// ─── Test catalog ────────────────────────────────────────────────────────────

const testCatalog: ModelPresetCatalog = createCatalog({
  cycle: ["default", "fast-codex", "coding-fallback", "deep-reasoning"],
  presets: {
    default: {
      label: "GPT 5.5 medium",
      provider: "openai-codex",
      model: "gpt-5.5",
      thinkingLevel: "medium",
      repairDefault: true,
    },
    "fast-codex": {
      label: "Codex Spark low",
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      thinkingLevel: "low",
    },
    "coding-fallback": {
      label: "MiniMax M3 high",
      provider: "opencode-go",
      model: "minimax-m3",
      thinkingLevel: "high",
    },
    "deep-reasoning": {
      label: "DeepSeek V4 Pro high",
      provider: "opencode-go",
      model: "deepseek-v4-pro",
      thinkingLevel: "high",
    },
  },
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("model-presets extension wiring", () => {
  it("registers the /model-preset command", () => {
    const { api, state } = makeFakePi();
    extension(api);
    const cmd = state.commands.find((c) => c.name === "model-preset");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBeDefined();
  });

  it("registers the ctrl+shift+m shortcut", () => {
    const { api, state } = makeFakePi();
    extension(api);
    const shortcut = state.shortcuts.find((s) => s.shortcut === "ctrl+shift+m");
    expect(shortcut).toBeDefined();
    expect(shortcut!.description).toBeDefined();
  });

  it("registers a model_select event listener", () => {
    const { api, state } = makeFakePi();
    extension(api);
    expect(state.eventHandlers["model_select"]).toBeDefined();
  });

  it("command with a preset name activates it through setModel and setThinkingLevel", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const cmd = state.commands.find((c) => c.name === "model-preset")!;

    const fakeModel = { id: "gpt-5.5", provider: "openai-codex" };
    const ctx = makeFakeCtx({
      modelRegistry: {
        find: () => fakeModel,
      },
    });

    await cmd.handler("default", ctx);

    expect(state.setModelCalls).toHaveLength(1);
    expect(state.setModelCalls[0]).toEqual({ id: "gpt-5.5", provider: "openai-codex" });
    expect(state.setThinkingLevelCalls).toContain("medium");
  });

  it("command without args opens a selector when presets exist", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const cmd = state.commands.find((c) => c.name === "model-preset")!;

    let selectCalled = false;
    const ctx = makeFakeCtx({
      ui: {
        notify: () => {},
        select: async (_title: string, options: string[]) => {
          selectCalled = true;
          expect(options.length).toBeGreaterThan(0);
          expect(options[0]).toMatch(/GPT 5.5 medium/);
          return options[0];
        },
        setStatus: () => {},
      },
      modelRegistry: {
        find: () => ({ id: "gpt-5.3-codex-spark", provider: "openai-codex" }),
      },
    });

    await cmd.handler("", ctx);

    expect(selectCalled).toBe(true);
    // Selected preset should be activated
    expect(state.setModelCalls).toHaveLength(1);
  });

  it("shortcut cycles to the next preset in the cycle order", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const shortcut = state.shortcuts.find((s) => s.shortcut === "ctrl+shift+m")!;

    const ctx = makeFakeCtx({
      model: { id: "gpt-5.5", provider: "openai-codex" },
      modelRegistry: {
        find: (_p: string, _m: string) => ({ id: _m, provider: _p }),
      },
    });

    await shortcut.handler(ctx);

    // Should cycle from default (gpt-5.5) to fast-codex (gpt-5.3-codex-spark)
    expect(state.setModelCalls).toHaveLength(1);
    expect(state.setModelCalls[0].id).toBe("gpt-5.3-codex-spark");
    expect(state.setThinkingLevelCalls).toContain("low");
  });

  it("warns when no presets configured", async () => {
    const { api, state } = makeFakePi();
    extension(api); // no catalog = empty
    const shortcut = state.shortcuts.find((s) => s.shortcut === "ctrl+shift+m")!;

    const warnings: string[] = [];
    const ctx = makeFakeCtx({
      ui: {
        notify: (msg: string) => warnings.push(msg),
        setStatus: () => {},
      },
    });

    await shortcut.handler(ctx);
    // Empty catalog → warning, no activation
    expect(warnings.some((w) => w.includes("No model presets"))).toBe(true);
    expect(state.setModelCalls).toHaveLength(0);
  });

  it("model_select event re-applies thinking level for matching preset (repair)", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const handler = state.eventHandlers["model_select"];
    expect(handler).toBeDefined();

    // Set thinking level to a known state
    state.currentThinkingLevel = "high";

    const ctx = makeFakeCtx({
      modelRegistry: {
        find: () => undefined, // not used during repair
      },
    });

    // Fire model_select with a model matching "default" preset (openai-codex/gpt-5.5 → medium)
    await handler({ model: { provider: "openai-codex", id: "gpt-5.5" } }, ctx);

    // Should repair thinking level to medium
    expect(state.setThinkingLevelCalls).toContain("medium");
  });

  it("model_select match updates status indicator", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const handler = state.eventHandlers["model_select"];
    expect(handler).toBeDefined();

    const { ctx, uiState } = makeFakeCtxWithTracking();

    // Fire model_select matching "default" preset (openai-codex/gpt-5.5 -> medium)
    await handler({ model: { provider: "openai-codex", id: "gpt-5.5" } }, ctx);

    // Status should be updated with the preset label
    expect(uiState.setStatusCalls).toHaveLength(1);
    expect(uiState.setStatusCalls[0]).toEqual({
      key: "model-presets",
      text: "GPT 5.5 medium",
    });
  });

  it("model_select no match does not touch thinking level or status", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const handler = state.eventHandlers["model_select"];
    expect(handler).toBeDefined();

    const { ctx, uiState } = makeFakeCtxWithTracking();

    // Fire model_select with a completely unknown provider/model
    await handler({ model: { provider: "nonexistent", id: "ghost-model" } }, ctx);

    // No calls to any Pi API or UI
    expect(state.setThinkingLevelCalls).toHaveLength(0);
    expect(uiState.notifyCalls).toHaveLength(0);
    expect(uiState.setStatusCalls).toHaveLength(0);
  });

  it("model_select clamped thinking level warns the user", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const handler = state.eventHandlers["model_select"];
    expect(handler).toBeDefined();

    // Override getThinkingLevel to simulate clamping: always returns "low"
    (api as any).getThinkingLevel = () => "low";

    const { ctx, uiState } = makeFakeCtxWithTracking();

    // Fire model_select for "coding-fallback" which has thinkingLevel: "high"
    // But the fake model clamps to "low"
    await handler({ model: { provider: "opencode-go", id: "minimax-m3" } }, ctx);

    // The setThinkingLevel was called
    expect(state.setThinkingLevelCalls).toContain("high");

    // A warning notification was issued about clamping
    expect(uiState.notifyCalls.length).toBeGreaterThanOrEqual(1);
    const clampWarning = uiState.notifyCalls.find(
      (n) => n.message.includes("clamped") && n.type === "warning",
    );
    expect(clampWarning).toBeDefined();
  });

  it("model_select duplicate provider/model without repairDefault does not repair", async () => {
    const dupCatalog = createCatalog({
      cycle: ["low", "high"],
      presets: {
        low: {
          provider: "openai-codex",
          model: "gpt-5.5",
          thinkingLevel: "low",
        },
        high: {
          provider: "openai-codex",
          model: "gpt-5.5",
          thinkingLevel: "high",
        },
      },
    });

    const { api, state } = makeFakePi();
    extension(api, dupCatalog);
    const handler = state.eventHandlers["model_select"];
    expect(handler).toBeDefined();

    const { ctx, uiState } = makeFakeCtxWithTracking();

    // Both presets match openai-codex/gpt-5.5, neither is repairDefault
    await handler({ model: { provider: "openai-codex", id: "gpt-5.5" } }, ctx);

    // Ambiguous match — no repair
    expect(state.setThinkingLevelCalls).toHaveLength(0);
    expect(uiState.notifyCalls).toHaveLength(0);
    expect(uiState.setStatusCalls).toHaveLength(0);
  });

  it("model_select repair never calls setModel", async () => {
    const { api, state } = makeFakePi();
    extension(api, testCatalog);
    const handler = state.eventHandlers["model_select"];
    expect(handler).toBeDefined();

    const { ctx } = makeFakeCtxWithTracking();

    // Fire model_select matching "default" preset
    await handler({ model: { provider: "openai-codex", id: "gpt-5.5" } }, ctx);

    // Repair only touches thinking level, never the model
    expect(state.setThinkingLevelCalls.length).toBeGreaterThan(0);
    expect(state.setModelCalls).toHaveLength(0);
  });
});
