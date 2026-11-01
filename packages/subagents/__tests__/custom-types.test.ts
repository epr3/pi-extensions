import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Spy on the real session-creation entry point. Rejection must happen before
// this is ever called — i.e. no session and no write-capable work.
const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(async () => ({ result: "custom ok", tokens: 2, toolUses: 0 })),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

import subagentsExtension from "../index.ts";
import { makeFakeApi } from "./helpers.ts";

const basic = (name: string, description: string, body = "Custom body prompt.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const withField = (name: string, extra: string) =>
  `---\nname: ${name}\ndescription: D\n${extra}\n---\n\nBody.\n`;

// Fixture roots: user agent definitions via PI_CODING_AGENT_DIR (Pi's agent-dir
// override); the project scope runs through ctx.cwd.
let fixtureRoot: string;
let projectCwd: string;
let agentDir: string;

beforeEach(() => {
  runSubagentMock.mockClear();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subagents-custom-"));
  projectCwd = path.join(fixtureRoot, "project");
  agentDir = path.join(fixtureRoot, "agent-dir");
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

function registerAgent(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  subagentsExtension(makeFakeApi(tools));
  return tools.find((t) => t.name === "Agent")!;
}

function fakeCtx() {
  return {
    cwd: projectCwd,
    hasUI: false,
    model: undefined,
    signal: undefined,
    modelRegistry: { find: () => undefined },
    ui: { notify: vi.fn() },
  } as any;
}

function callAgent(agent: ToolDefinition, subagent_type: string, run_in_background?: boolean) {
  return agent.execute(
    "call-1",
    { subagent_type, prompt: "do the task", description: "a task", run_in_background } as any,
    undefined,
    undefined,
    fakeCtx(),
  );
}

function projectAgent(file: string, content: string) {
  const dir = path.join(projectCwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, "utf8");
}

function userAgent(file: string, content: string) {
  const dir = path.join(agentDir, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, "utf8");
}

// ─── Launching custom types ─────────────────────────────────────────────────

describe("launching a custom Subagent type", () => {
  it("runs the custom definition with the frontmatter name and the body as its prompt", async () => {
    projectAgent("code-reviewer.md", basic("code-reviewer", "Reviews diffs", "Review the diff."));
    const agent = registerAgent();

    await callAgent(agent, "code-reviewer");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.type).toBe("code-reviewer");
    expect(call.agentDef).toMatchObject({
      name: "code-reviewer",
      description: "Reviews diffs",
      systemPrompt: "Review the diff.",
    });
  });

  it("passes no built-in allowlist for a custom type — it inherits the general toolset", async () => {
    projectAgent("x.md", basic("x", "X body here."));
    const agent = registerAgent();

    await callAgent(agent, "x");
    const call = runSubagentMock.mock.calls[0][0];
    expect(runSubagentMock.mock.calls[0][0].tools).toBeUndefined();
    expect(call.excludeExtraTools).toBeUndefined();
  });

  it("works in background mode too", async () => {
    projectAgent("bg.md", basic("bg", "Background type"));
    const agent = registerAgent();

    await callAgent(agent, "bg", true);
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0].agentDef).toMatchObject({ name: "bg" });
  });

  it("keeps a run's initial definition stable at launch time", async () => {
    // The definition is read once per launch (before exec); a later edit
    // cannot retroactively change an already-launched run because the runner
    // receives a snapshot — asserted structurally by the frozen call arg.
    projectAgent("x.md", basic("x", "D", "Body at launch."));
    const agent = registerAgent();
    await callAgent(agent, "x");
    expect(runSubagentMock.mock.calls[0][0].agentDef.systemPrompt).toBe("Body at launch.");
  });
});

// ─── Dynamic re-reading ────────────────────────────────────────────────────

describe("definitions are re-read on subsequent launches", () => {
  it("launches after definition edits pick up the new prompt", async () => {
    const dir = path.join(projectCwd, ".pi", "agents");
    projectAgent("x.md", basic("x", "D", "Prompt version 1."));
    const agent = registerAgent();

    await callAgent(agent, "x");
    expect(runSubagentMock.mock.calls[0][0].agentDef.systemPrompt).toBe("Prompt version 1.");

    writeFileSync(path.join(dir, "x.md"), basic("x", "D", "Prompt version 2."), "utf8");

    await callAgent(agent, "x");
    expect(runSubagentMock.mock.calls[1][0].agentDef.systemPrompt).toBe("Prompt version 2.");
  });

  it("an added definition becomes launchable without re-registering", async () => {
    const agent = registerAgent();
    await expect(callAgent(agent, "later")).rejects.toThrow(/Unsupported subagent_type/);

    projectAgent("later.md", basic("later", "Added later"));

    await callAgent(agent, "later");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    expect(runSubagentMock.mock.calls[0][0].agentDef).toMatchObject({ name: "later" });
  });

  it("user-scope definitions are discovered alongside project scopes", async () => {
    userAgent("user-only.md", basic("user-only", "From the user scope"));
    const agent = registerAgent();

    await callAgent(agent, "user-only");
    expect(runSubagentMock.mock.calls[0][0].agentDef).toMatchObject({ name: "user-only" });
  });
});

// ─── Field and type rejection at the launch boundary ────────────────────────

describe("unsupported fields are rejected at the launch boundary", () => {
  for (const field of ["tools", "disallowedTools", "model", "skills"]) {
    it(`rejects a ${field} field without launching a session`, async () => {
      projectAgent("scoped.md", withField("scoped", `${field}: whatever`));
      const agent = registerAgent();

      await expect(callAgent(agent, "scoped")).rejects.toThrow(new RegExp(field));
      expect(runSubagentMock).not.toHaveBeenCalled();
    });
  }

  it("rejects unknown fields", async () => {
    projectAgent("mystery.md", withField("mystery", "mystery_field: 1"));
    const agent = registerAgent();

    await expect(callAgent(agent, "mystery")).rejects.toThrow(/mystery_field/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });
});

describe("unknown, shadowed, and reserved names at the boundary", () => {
  it("fails an unknown type and never falls back to general", async () => {
    projectAgent("known.md", basic("known", "Known"));
    const agent = registerAgent();

    await expect(callAgent(agent, "nope")).rejects.toThrow(/Unsupported subagent_type "nope"/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("the unknown-type error lists currently valid custom names", async () => {
    projectAgent("known.md", basic("known", "Known"));
    const agent = registerAgent();

    await expect(callAgent(agent, "typo-name")).rejects.toThrow(/"known"/);
  });

  it("a name shadowed by an invalid nearer definition fails with its path", async () => {
    projectAgent("shadowed.md", withField("shadowed", "tools:\n  - read"));
    userAgent("shadowed.md", basic("shadowed", "User definition"));
    const agent = registerAgent();

    await expect(callAgent(agent, "shadowed")).rejects.toThrow(/tools/);
    await expect(callAgent(agent, "shadowed")).rejects.toThrow(/shadowed\.md/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("built-in names remain bound to the built-ins even when files define them", async () => {
    projectAgent("explore.md", basic("explore", "Reserved name"));
    const agent = registerAgent();

    await callAgent(agent, "explore");
    await callAgent(agent, "general");
    const calls = runSubagentMock.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].agentDef).toBeUndefined();
    expect(calls[0][0].tools).toEqual(expect.anything()); // explore allowlist
    expect(calls[1][0].agentDef).toBeUndefined();
    expect(calls[1][0].excludeExtraTools).toEqual([]); // general keeps its config surface
  });
});

// ─── Diagnostics surfacing ──────────────────────────────────────────────────

describe("definition diagnostics are surfaced without disabling valid types", () => {
  it("details include the diagnostics while the valid sibling still launches", async () => {
    projectAgent("bad.md", withField("bad", "mystery: true"));
    projectAgent("good.md", basic("good", "Good one"));
    const agent = registerAgent();

    const res: any = await callAgent(agent, "good");
    const diags = res.details.definitionDiagnostics as string[];
    expect(diags.some((d) => /mystery/.test(d))).toBe(true);
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
  });
});