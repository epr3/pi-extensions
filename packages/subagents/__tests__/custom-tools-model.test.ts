import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Spy on the real session-creation entry point: launches must be observable at
// the extension boundary (what the runner receives), and every rejection must
// happen before a session is ever created.
const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(async () => ({ result: "ok", tokens: 1, toolUses: 0 })),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

import subagentsExtension from "../index.ts";
import { makeFakeApi } from "./helpers.ts";

let fixtureRoot: string;
let projectCwd: string;
let agentDir: string;

let realCwd: string;

beforeEach(() => {
  runSubagentMock.mockClear();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subagents-tools-model-"));
  projectCwd = path.join(fixtureRoot, "project");
  agentDir = path.join(fixtureRoot, "agent-dir");
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The settings loader reads .pi/settings.json from the process cwd.
  realCwd = process.cwd();
  process.chdir(projectCwd);
});

afterEach(() => {
  process.chdir(realCwd);
  rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

// Typical active tool set at the extension boundary: Pi built-ins, common
// extension tools, and this package's own subagent tools.
const AVAILABLE_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "lsp_definition",
  "lsp_references",
  "Agent",
  "get_subagent_result",
  "question",
];

function projectAgent(file: string, content: string) {
  const dir = path.join(projectCwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, "utf8");
}

/** Registration API extended with the availability seam the extension reads:
 *  the parent session's active tool names, exactly like Pi's ExtensionAPI. */
function registerAgent(availableTools: string[] = AVAILABLE_TOOLS): ToolDefinition {
  const tools: ToolDefinition[] = [];
  const api = makeFakeApi(tools) as Record<string, unknown>;
  api.getActiveTools = () => [...availableTools];
  subagentsExtension(api as never);
  return tools.find((t) => t.name === "Agent")!;
}

const parentModel = { provider: "openai", id: "gpt-4o" };
const defModel = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
const otherModel = { provider: "google", id: "gemini-2.0" };

function registryWith(...models: Array<Record<string, string>>) {
  return {
    find: (provider: string, modelId: string) =>
      models.find((m) => m.provider === provider && m.id === modelId) as never,
  };
}

/** Project settings the settingsKey() loader reads from the (real) process
 *  cwd — so this suite chdirs into the fixture project. */
function projectSettings(subagents: Record<string, unknown>) {
  mkdirSync(path.join(projectCwd, ".pi"), { recursive: true });
  writeFileSync(
    path.join(projectCwd, ".pi", "settings.json"),
    JSON.stringify({ subagents }),
    "utf8",
  );
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: projectCwd,
    hasUI: false,
    model: undefined,
    signal: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: vi.fn() },
    ...overrides,
  } as never;
}

function callAgent(
  agent: ToolDefinition,
  subagent_type: string,
  ctxOverrides: Record<string, unknown> = {},
  paramsExtra: Record<string, unknown> = {},
) {
  return agent.execute(
    "call-1",
    { subagent_type, prompt: "do the task", description: "a task", ...paramsExtra } as never,
    undefined,
    undefined,
    fakeCtx(ctxOverrides),
  );
}

// ─── Tool allowlists ────────────────────────────────────────────────────────

describe("custom Subagent tool allowlists", () => {
  it("a YAML list allowlist restricts the run to the listed tools", async () => {
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\ntools:\n  - read\n  - grep\n  - lsp_definition\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "reader");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0].tools).toEqual(["read", "grep", "lsp_definition"]);
  });

  it("a comma-separated string allowlist behaves like a list", async () => {
    projectAgent(
      "reader.md",
      `---\nname: reader\ndescription: D\ntools: read, grep, lsp_definition\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "reader");
    expect(runSubagentMock.mock.calls[0][0].tools).toEqual(["read", "grep", "lsp_definition"]);
  });

  it("an explicit allowlist naming a subagent tool still launches without it — no nested delegation", async () => {
    // Even if a definition allows `Agent`, the safety exclusions win: the run
    // is launched without any subagent tool in its allowlist.
    projectAgent(
      "sneaky.md",
      `---\nname: sneaky\ndescription: D\ntools:\n  - read\n  - Agent\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "sneaky");
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.tools).toEqual(["read"]);
  });

  it("an allowlist naming only safety-excluded tools is rejected", async () => {
    projectAgent(
      "hollow.md",
      `---\nname: hollow\ndescription: D\ntools:\n  - Agent\n  - get_subagent_result\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "hollow")).rejects.toThrow(/no tools/si);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("an empty allowlist is rejected", async () => {
    projectAgent("empty.md", `---\nname: empty\ndescription: D\ntools: []\n---\nBody.\n`);
    const agent = registerAgent();

    await expect(callAgent(agent, "empty")).rejects.toThrow(/no tools/si);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("an unknown tool name is rejected — no session is created", async () => {
    projectAgent(
      "unknown.md",
      `---\nname: unknown\ndescription: D\ntools:\n  - read\n  - reed\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "unknown")).rejects.toThrow(/\breed\b/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("scoped patterns are rejected at discovery with an actionable message", async () => {
    projectAgent(
      "scoped.md",
      `---\nname: scoped\ndescription: D\ntools:\n  - read\n  - Bash(git*)\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "scoped")).rejects.toThrow(/Bash\(git\*\)/);
    await expect(callAgent(agent, "scoped")).rejects.toThrow(/scoped/i);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("wildcard and colon patterns are rejected like scoped patterns", async () => {
    projectAgent(
      "wildcard.md",
      `---\nname: wildcard\ndescription: D\ntools: Edit:*\n---\nBody.\n`,
    );
    projectAgent(
      "star.md",
      `---\nname: star\ndescription: D\ntools:\n  - Edit*\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "wildcard")).rejects.toThrow(/Edit:\*/);
    await expect(callAgent(agent, "star")).rejects.toThrow(/Edit\*/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });
});

// ─── Tool denials ───────────────────────────────────────────────────────────

describe("custom Subagent disallowedTools", () => {
  it("denials subtract from the inherited toolset without changing the inheritance", async () => {
    // No allowlist: the run inherits every available Subagent tool including
    // write/shell, and the denial list is passed as extra exclusions on top of
    // the fixed safety exclusions.
    projectAgent(
      "noscribe.md",
      `---\nname: noscribe\ndescription: D\ndisallowedTools:\n  - write\n  - bash\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "noscribe");
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.tools).toBeUndefined(); // inherited, not allowlisted
    expect(call.excludeExtraTools).toEqual(["write", "bash"]);
  });

  it("denials subtract from an explicit allowlist too", async () => {
    projectAgent(
      "filtered.md",
      `---\nname: filtered\ndescription: D\ntools:\n  - read\n  - bash\n  - grep\ndisallowedTools: bash\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "filtered");
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.tools).toEqual(["read", "bash", "grep"]); // passed as written…
    expect(call.excludeExtraTools).toEqual(["bash"]); // …and denied on top
  });

  it("a denial list is still validated against actual available tools", async () => {
    projectAgent(
      "bad-deny.md",
      `---\nname: bad-deny\ndescription: D\ndisallowedTools:\n  - wrtie\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "bad-deny")).rejects.toThrow(/wrtie/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("denying every inherited tool is rejected as an empty resulting set", async () => {
    // Every available tool is either denied or safety-excluded: the result of
    // (inherited − denials − safety exclusions) is empty.
    projectAgent(
      "stalled.md",
      `---\nname: stalled\ndescription: D\ndisallowedTools:\n  - read\n  - bash\n  - edit\n  - write\n  - grep\n  - find\n  - ls\n  - lsp_definition\n  - lsp_references\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "stalled")).rejects.toThrow(/no tools/si);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("omitting both lists inherits everything including write and shell", async () => {
    projectAgent("plain.md", `---\nname: plain\ndescription: D\n---\nBody.\n`);
    const agent = registerAgent();

    await callAgent(agent, "plain");
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    expect(call.excludeExtraTools).toBeUndefined();
  });
});

// ─── Definition model selection ────────────────────────────────────────────

describe("custom Subagent definition model", () => {
  const parentCtx = {
    model: parentModel,
    modelRegistry: registryWith(parentModel, defModel, otherModel),
  };

  it("an exact provider/model in the definition overrides the configured shared default", async () => {
    projectSettings({ defaultModel: "google/gemini-2.0" });
    projectAgent(
      "modelled.md",
      `---\nname: modelled\ndescription: D\nmodel: anthropic/${defModel.id}\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "modelled", parentCtx);
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0].model).toBe(defModel);
  });

  it("`inherit` explicitly selects the parent model even when defaults are configured", async () => {
    projectSettings({ defaultModel: "google/gemini-2.0" });
    projectAgent(
      "inherit.md",
      `---\nname: inherit\ndescription: D\nmodel: inherit\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await callAgent(agent, "inherit", parentCtx);
    expect(runSubagentMock.mock.calls[0][0].model).toBe(parentModel);
  });

  it("an omitted model keeps the existing settings default then parent fallback", async () => {
    projectSettings({ defaultModel: "google/gemini-2.0" });
    projectAgent("late.md", `---\nname: late\ndescription: D\n---\nBody.\n`);
    const agent = registerAgent();

    await callAgent(agent, "late", parentCtx);
    expect(runSubagentMock.mock.calls[0][0].model).toBe(otherModel);

    runSubagentMock.mockClear();
    projectSettings({});
    projectAgent("parented.md", `---\nname: parented\ndescription: D\n---\nBody.\n`);
    // Settings are captured at extension registration — re-register with the
    // cleared defaults.
    const agentNoDefaults = registerAgent();
    await callAgent(agentNoDefaults, "parented", parentCtx);
    expect(runSubagentMock.mock.calls[0][0].model).toBe(parentModel);
  });

  it("an exact model that is not in the registry fails the launch — no silent fallback", async () => {
    projectAgent(
      "ghost.md",
      `---\nname: ghost\ndescription: D\nmodel: anthropic/claude-opus-9-does-not-exist\n---\nBody.\n`,
    );
    const agent = registerAgent();

    await expect(callAgent(agent, "ghost", parentCtx)).rejects.toThrow(
      /claude-opus-9-does-not-exist/,
    );
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("`inherit` fails when the parent session has no model", async () => {
    projectAgent("orphan.md", `---\nname: orphan\ndescription: D\nmodel: inherit\n---\nBody.\n`);
    const agent = registerAgent();

    await expect(
      callAgent(agent, "orphan", { model: undefined, modelRegistry: registryWith(defModel) }),
    ).rejects.toThrow(/inherit/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("a bare alias that is not an exact provider/model reference is rejected at discovery", async () => {
    projectAgent("alias.md", `---\nname: alias\ndescription: D\nmodel: haiku\n---\nBody.\n`);
    const agent = registerAgent();

    await expect(callAgent(agent, "alias", parentCtx)).rejects.toThrow(/haiku/);
    await expect(callAgent(agent, "alias", parentCtx)).rejects.toThrow(/provider\/model/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("an explicit definition model silences the settings-default warnings for this launch", async () => {
    projectSettings({ defaultModel: "not-a-model-ref" });
    projectAgent(
      "quiet.md",
      `---\nname: quiet\ndescription: D\nmodel: anthropic/${defModel.id}\n---\nBody.\n`,
    );
    const agent = registerAgent();

    const res: any = await callAgent(agent, "quiet", parentCtx);
    const modelWarnings = (res.details.warnings ?? []).filter(
      (w: any) => typeof w.scope === "string",
    );
    expect(modelWarnings.some((w: any) => w.scope === "shared")).toBe(false);
    expect(runSubagentMock.mock.calls[0][0].model).toBe(defModel);
  });

  it("an omitted model still warns about a broken shared default and falls back to the parent", async () => {
    projectSettings({ defaultModel: "not-a-model-ref" });
    projectAgent("warned.md", `---\nname: warned\ndescription: D\n---\nBody.\n`);
    const agent = registerAgent();

    const res: any = await callAgent(agent, "warned", parentCtx);
    const modelWarnings = (res.details.warnings ?? []).filter(
      (w: any) => typeof w.scope === "string",
    );
    expect(modelWarnings).toEqual([
      { scope: "shared", reference: "not-a-model-ref", type: "malformed" },
    ]);
    expect(runSubagentMock.mock.calls[0][0].model).toBe(parentModel);
  });
});
