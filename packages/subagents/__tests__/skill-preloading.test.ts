import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The launch boundary under test: `Agent.execute` must resolve the
// definition's `skills` list through normal Pi skill discovery before any
// session exists. Rejection must happen before a run is launched.
const { runSubagentMock } = vi.hoisted(() => ({
  runSubagentMock: vi.fn(async () => ({ result: "custom ok", tokens: 2, toolUses: 0 })),
}));

vi.mock("../runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.ts")>();
  return { ...actual, runSubagent: runSubagentMock };
});

import subagentsExtension from "../index.ts";
import { resolveSkillPreloads } from "../skills.ts";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { makeFakeApi } from "./helpers.ts";

// ─── Fixture plumbing ──────────────────────────────────────────────────────

let fixtureRoot: string;
let projectCwd: string;
let agentDir: string;

beforeEach(() => {
  runSubagentMock.mockClear();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "subagents-skills-"));
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

/** A Pi definition file's exact content. */
const basic = (name: string, description: string, body = "Custom body prompt.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

const withSkills = (name: string, skills: string[], body = "Skill-driven body.") =>
  `---\nname: ${name}\ndescription: D\nskills:\n${skills.map((s) => `  - ${s}`).join("\n")}\n---\n\n${body}\n`;

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

/** Creates a skill directory (`SKILL.md` inside) — Pi's own skill layout. */
function projectSkill(name: string, content: string) {
  const dir = path.join(projectCwd, ".pi", "skills", name);
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  writeFileSync(p, content, "utf8");
  return p;
}

function userSkill(name: string, content: string) {
  const dir = path.join(agentDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  writeFileSync(p, content, "utf8");
  return p;
}

const skillDoc = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

// ─── Successful preloading through the launch boundary ─────────────────────

describe("preloading named skills into a custom Subagent run", () => {
  it("resolves a listed skill through Pi discovery and preloads its complete SKILL.md", async () => {
    const skillPath = projectSkill(
      "code-review",
      skillDoc("code-review", "How to review", "REVIEW STEPS: 1) read the diff 2) report."),
    );
    projectAgent("reviewer.md", withSkills("reviewer", ["code-review"]));
    const agent = registerAgent();

    await callAgent(agent, "reviewer");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.preloadedSkills).toEqual([
      {
        name: "code-review",
        filePath: skillPath,
        content: skillDoc(
          "code-review",
          "How to review",
          "REVIEW STEPS: 1) read the diff 2) report.",
        ),
      },
    ]);
  });

  it("keeps the requested order and preloads each declared skill once", async () => {
    projectSkill("beta", skillDoc("beta", "Beta", "BETA instructions."));
    projectSkill("alpha", skillDoc("alpha", "Alpha", "ALPHA instructions."));
    projectAgent("grab-bag.md", withSkills("grab-bag", ["beta", "alpha", "beta"]));
    const agent = registerAgent();

    await callAgent(agent, "grab-bag");
    const names = runSubagentMock.mock.calls[0][0].preloadedSkills.map((s: any) => s.name);
    expect(names).toEqual(["beta", "alpha"]);
  });

  it("launches with no skill preloading when the definition lists none", async () => {
    projectAgent("plain.md", basic("plain", "No skills"));
    userAgent("with-skill.md", withSkills("with-skill", ["ghost-skill"]));
    const agent = registerAgent();

    await callAgent(agent, "plain");
    const call = runSubagentMock.mock.calls[0][0];
    expect(call.preloadedSkills).toBeUndefined();
  });

  it("re-reads skill content fresh on each launch, like definitions", async () => {
    const skillDir = path.join(projectCwd, ".pi", "skills", "iterating");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), skillDoc("iterating", "I", "version-1"), "utf8");
    projectAgent("it.md", withSkills("it", ["iterating"]));
    const agent = registerAgent();

    await callAgent(agent, "it");
    expect(runSubagentMock.mock.calls[0][0].preloadedSkills[0].content).toContain("version-1");

    writeFileSync(path.join(skillDir, "SKILL.md"), skillDoc("iterating", "I", "version-2"), "utf8");
    await callAgent(agent, "it");
    expect(runSubagentMock.mock.calls[1][0].preloadedSkills[0].content).toContain("version-2");
  });

  it("works in background mode too", async () => {
    projectSkill("delayed", skillDoc("delayed", "D", "BG skill."));
    projectAgent("bg.md", withSkills("bg", ["delayed"]));
    const agent = registerAgent();

    await callAgent(agent, "bg", true);
    expect(runSubagentMock.mock.calls[0][0].preloadedSkills).toHaveLength(1);
  });

  it("matches Pi's resolved skill names, not directory names", async () => {
    // Directory "cr-tags" but frontmatter name "code-review-tags": Pi's
    // discovery exposes the frontmatter name, and preloading resolves by it.
    projectSkill("cr-tags", skillDoc("code-review-tags", "T", "TAG RULES: use repo tags."));
    projectAgent("tagger.md", withSkills("tagger", ["code-review-tags"]));
    const agent = registerAgent();

    await callAgent(agent, "tagger");
    expect(runSubagentMock.mock.calls[0][0].preloadedSkills[0]).toMatchObject({
      name: "code-review-tags",
    });
  });

  it("applies Pi's own precedence when user and project scopes collide", async () => {
    // Preloading resolves through the same resource loader as the sub-session,
    // so Pi's normal project-over-user skill precedence applies: the project
    // skill's content wins for a collided name.
    userSkill("shared", skillDoc("shared", "Shared skill", "USER-SCOPE content."));
    projectSkill("shared", skillDoc("shared", "Shared skill", "PROJECT-SCOPE content."));
    projectAgent("consumer.md", withSkills("consumer", ["shared"]));
    const agent = registerAgent();

    await callAgent(agent, "consumer");
    expect(runSubagentMock.mock.calls[0][0].preloadedSkills[0].content).toContain(
      "PROJECT-SCOPE content.",
    );
  });
});

// ─── Failing resolution through the launch boundary ─────────────────────────

describe("missing or unreadable skills fail that run, not unrelated types", () => {
  it("fails the launch with an actionable diagnostic naming the missing skill", async () => {
    projectAgent("wishful.md", withSkills("wishful", ["code-review", "does-not-exist"]));
    const agent = registerAgent();

    await expect(callAgent(agent, "wishful")).rejects.toThrow(
      /Cannot launch Subagent type "wishful"[\s\S]*skill "does-not-exist" was not found/,
    );
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("names the existing skills it did resolve and never preloads a partial set", async () => {
    // Only the failure is reported; partial preloading never reaches a run.
    projectSkill("present", skillDoc("present", "P", "PRESENT."));
    projectAgent("half.md", withSkills("half", ["present", "absent"]));
    const agent = registerAgent();

    await expect(callAgent(agent, "half")).rejects.toThrow(/skill "absent" was not found/);
    expect(runSubagentMock).not.toHaveBeenCalled();
  });

  it("reports a discovered skill whose file cannot be read for preloading", async () => {
    // Pi's own discovery swallows an unreadable SKILL.md into its warnings
    // (the skill then resolves as missing). The remaining unreadable failure
    // mode is the skill read at resolution time — exercised here on the seam
    // where the extension asks the loader for the skill and then reads it.
    const skillPath = projectSkill("locked", skillDoc("locked", "L", "SECRET BODY."));
    chmodSync(skillPath, 0o000);
    const stubLoader = {
      reload: async () => {},
      getSkills: () => ({
        skills: [
          {
            name: "locked",
            description: "L",
            filePath: skillPath,
            baseDir: path.dirname(skillPath),
          },
        ],
        diagnostics: [],
      }),
    } as unknown as ResourceLoader;

    try {
      const result = await resolveSkillPreloads({
        cwd: projectCwd,
        skillNames: ["locked"],
        createSkillsLoader: () => stubLoader,
      });
      expect(result.problems[0].kind).toBe("unreadable");
      expect(result.problems[0].message).toMatch(/locked.*unreadable/);
    } finally {
      chmodSync(skillPath, 0o644); // restore so cleanup can remove it
    }
  });

  it("keeps unrelated definitions usable while one definition's skills are unresolvable", async () => {
    projectAgent("broken-skills.md", withSkills("broken-skills", ["missing-skill"]));
    projectAgent("healthy.md", withSkills("healthy", ["fine-skill"]));
    projectSkill("fine-skill", skillDoc("fine-skill", "F", "FINE."));
    const agent = registerAgent();

    await expect(callAgent(agent, "broken-skills")).rejects.toThrow(/missing-skill/);
    await callAgent(agent, "healthy");
    expect(runSubagentMock).toHaveBeenCalledTimes(1);
  });

  it("mentions Pi's searched skill locations in the missing-skill diagnostic", async () => {
    projectAgent("where.md", withSkills("where", ["vanished"]));
    const agent = registerAgent();

    await expect(callAgent(agent, "where")).rejects.toThrow(
      new RegExp(`${agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/skills`),
    );
  });
});