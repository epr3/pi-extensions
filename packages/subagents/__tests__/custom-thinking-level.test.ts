// Per-custom-Subagent-type thinking: how a definition's `thinkingLevel`
// frontmatter and the shared `subagents.thinkingLevel` setting combine for a
// custom type's runs, observed at the SDK session-creation boundary (the same
// seam thinking-level.test.ts uses for the built-ins). Real definition files
// on disk; only the SDK session factory is stubbed.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";
import path from "node:path";

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: boundary.create,
    ModelRuntime: { create: async () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
    },
    SessionManager: { inMemory: () => ({}) },
  };
});

import subagentsExtension from "../index.ts";

let fixtureRoot: string;
let projectCwd: string;
let agentDir: string;
let realCwd: string;
let realHome: string | undefined;

beforeEach(() => {
  boundary.create.mockClear();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subagents-custom-thinking-"));
  projectCwd = path.join(fixtureRoot, "project");
  agentDir = path.join(fixtureRoot, "agent-dir");
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The global settings file is read from the real home directory: point HOME
  // at the fixture so the developer's own ~/.pi/agent/settings.json (which may
  // legitimately configure subagents thinking levels) cannot leak in.
  realHome = process.env.HOME;
  process.env.HOME = fixtureRoot;
  // The settings loader reads .pi/settings.json from the process cwd.
  realCwd = process.cwd();
  process.chdir(projectCwd);
});

afterEach(() => {
  process.chdir(realCwd);
  rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_SUBAGENT_EXPLORE_TOOLS;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

const parent = { provider: "test", id: "parent", reasoning: true };
const selected = { provider: "test", id: "selected", reasoning: true };
const nonReasoning = { provider: "test", id: "parent", reasoning: false };

function registryWith(...models: Array<Record<string, unknown>>) {
  return {
    find: (provider: string, modelId: string) =>
      models.find((m) => m.provider === provider && m.id === modelId) as never,
  };
}

function projectAgent(file: string, content: string) {
  const dir = path.join(projectCwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, "utf8");
}

function projectSettings(subagents: Record<string, unknown>) {
  mkdirSync(path.join(projectCwd, ".pi"), { recursive: true });
  writeFileSync(
    path.join(projectCwd, ".pi", "settings.json"),
    JSON.stringify({ subagents }),
    "utf8",
  );
}

// The harness registers a fresh extension per launch (settings are captured
// at registration) and launches a custom type foreground or background.
function harness(parentModel: Record<string, unknown> = parent) {
  const tools = new Map<string, any>();
  const notify = vi.fn();
  const updates = vi.fn();
  const ctx = {
    cwd: projectCwd,
    mode: "tui" as const,
    hasUI: true,
    signal: undefined,
    model: parentModel,
    modelRegistry: registryWith(parent, selected),
    ui: { notify },
  };
  subagentsExtension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    on: () => {},
    events: { emit: () => {} },
    getActiveTools: () => undefined,
  } as any);

  async function launch(
    type: string,
    background: boolean,
    paramsExtra: Record<string, unknown> = {},
  ) {
    const start = await tools.get("Agent").execute!(
      "call",
      {
        subagent_type: type,
        prompt: "task",
        description: "test task",
        ...(background ? { run_in_background: true } : {}),
        ...paramsExtra,
      } as never,
      undefined,
      updates,
      ctx,
    );
    const result = background
      ? await tools
          .get("get_subagent_result")
          .execute("poll", { agent_id: start.details.agent_id, wait: true } as never)
      : start;
    return { start, result, notify };
  }
  return { ctx, tools, notify, updates, launch };
}

beforeEach(() => {
  boundary.create.mockReset();
  boundary.create.mockImplementation(async (options: CreateAgentSessionOptions) => {
    let listener: ((event: any) => void) | undefined;
    return {
      session: {
        // Pi adapts the requested level to model capabilities at creation; the
        // fake repeats the SDK's clamp so tests observe effective levels through
        // the same onThinkingLevel reporting the extension uses.
        thinkingLevel: clampThinkingLevel(options.model as any, options.thinkingLevel ?? "medium"),
        subscribe: (handler: typeof listener) => {
          listener = handler;
          return () => {};
        },
        async prompt() {
          listener?.({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "answer" },
          });
        },
        messages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }],
        abort() {},
        dispose() {},
      },
    };
  });
});

// ─── Resolution at the launch boundary ──────────────────────────────────────

describe("custom Subagent definition thinkingLevel", () => {
  it("a definition thinkingLevel reaches session creation", async () => {
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\nthinkingLevel: low\n---\nBody.\n`,
    );
    const h = harness();

    await h.launch("reader", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("low");
  });

  it("the definition preference reaches background session creation too", async () => {
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\nthinkingLevel: minimal\n---\nBody.\n`,
    );
    const h = harness();

    const { result } = await h.launch("reader", true);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("minimal");
    expect((result.details as any).warnings ?? []).toEqual([]);
  });

  it("an explicit `off` is a preference, not omission — it overrides a shared enabled level", async () => {
    projectSettings({ thinkingLevel: "high" });
    projectAgent(
      "quiet.md",
      `---\nname: quiet\ndescription: D\nthinkingLevel: "off"\n---\nBody.\n`,
    );
    const h = harness();

    await h.launch("quiet", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("off");
  });

  it("an omitted definition thinkingLevel falls through to the shared setting", async () => {
    projectSettings({ thinkingLevel: "medium" });
    projectAgent("plain.md", `---\nname: plain\ndescription: D\n---\nBody.\n`);
    const h = harness();

    await h.launch("plain", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("medium");
  });

  it("omitting both the definition and the setting keeps the SDK/session default", async () => {
    projectAgent("plain.md", `---\nname: plain\ndescription: D\n---\nBody.\n`);
    const h = harness();

    await h.launch("plain", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options).not.toHaveProperty("thinkingLevel");
  });

  it("a defined preference wins over the shared setting and silences a broken shared value", async () => {
    projectSettings({ thinkingLevel: "bogus" });
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\nthinkingLevel: low\n---\nBody.\n`,
    );
    const h = harness();

    const { result, notify } = await h.launch("reader", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("low");
    expect((result.details as any).warnings ?? []).toEqual([]);
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining("subagents.thinkingLevel"),
      "warning",
    );
  });

  it("an omitted definition still surfaces a broken shared setting as a malformed warning", async () => {
    projectSettings({ thinkingLevel: 2 });
    projectAgent("plain.md", `---\nname: plain\ndescription: D\n---\nBody.\n`);
    const h = harness();

    const { result, notify } = await h.launch("plain", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options).not.toHaveProperty("thinkingLevel");
    expect((result.details as any).warnings).toEqual([
      expect.objectContaining({ setting: "subagents.thinkingLevel", type: "malformed" }),
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("subagents.thinkingLevel"),
      "warning",
    );
  });

  it("an invalid definition thinkingLevel is rejected at discovery — no session is created", async () => {
    projectAgent(
      "typoed.md",
      `---\nname: typoed\ndescription: D\nthinkingLevel: higg\n---\nBody.\n`,
    );
    const h = harness();

    await expect(h.launch("typoed", false)).rejects.toThrow(/higg/);
    expect(boundary.create).not.toHaveBeenCalled();
  });

  it("a valid-but-unsupported definition preference clamps after model resolution and reports the effective level", async () => {
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\nthinkingLevel: high\n---\nBody.\n`,
    );
    const h = harness(nonReasoning);

    const { result, notify } = await h.launch("reader", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.model).toBe(nonReasoning);
    expect(options.thinkingLevel).toBe("high");
    expect((result.details as any).warnings).toEqual([
      expect.objectContaining({
        scope: "definition",
        setting: `definition "reader" thinkingLevel`,
        type: "clamped",
        requested: "high",
        effective: "off",
      }),
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/definition "reader" thinkingLevel requested "high".*"off"/),
      "warning",
    );
  });

  it("thinking and model resolve independently: a definition thinkingLevel keeps configured model defaults", async () => {
    projectSettings({ defaultModel: "test/selected", thinkingLevel: "max" });
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\nthinkingLevel: low\n---\nBody.\n`,
    );
    const h = harness();

    await h.launch("reader", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("low");
    expect(options.model).toBe(selected);
  });

  it("thinking and model resolve independently: an invalid model preference does not discard valid thinking", async () => {
    projectSettings({ defaultModel: "not-a-model-ref", thinkingLevel: "medium" });
    projectAgent("plain.md", `---\nname: plain\ndescription: D\n---\nBody.\n`);
    const h = harness();

    const { result } = await h.launch("plain", false);
    const options = boundary.create.mock.calls[0][0] as CreateAgentSessionOptions;
    expect(options.thinkingLevel).toBe("medium");
    expect(options.model).toBe(parent);
    expect((result.details as any).warnings).toEqual([
      expect.objectContaining({ scope: "shared", reference: "not-a-model-ref", type: "malformed" }),
    ]);
  });
});