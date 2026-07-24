import { describe, it, expect } from "vitest";
import {
  AGENTS,
  CORE_READ_TOOLS,
  SAFETY_EXCLUDES,
  exploreToolset,
  resolveAgentType,
} from "../agents.ts";

// ─── Toolset assertions ─────────────────────────────────────────────────────

describe("SAFETY_EXCLUDES", () => {
  it("prevents recursive Subagent spawning", () => {
    expect(SAFETY_EXCLUDES).toContain("Agent");
    expect(SAFETY_EXCLUDES).toContain("get_subagent_result");
  });

  it("prevents blocking on unanswered questions", () => {
    expect(SAFETY_EXCLUDES).toContain("question");
  });
});

describe("CORE_READ_TOOLS", () => {
  it("includes the basic read-only built-ins", () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      expect(CORE_READ_TOOLS).toContain(tool);
    }
  });

  it("does not include web tools", () => {
    expect(CORE_READ_TOOLS).not.toContain("web_search");
    expect(CORE_READ_TOOLS).not.toContain("web_fetch");
  });
});

describe("exploreToolset()", () => {
  it("returns core read tools by default", () => {
    const tools = exploreToolset([]);
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).toContain("find");
    expect(tools).toContain("ls");
  });

  it("does not include web tools by default", () => {
    const tools = exploreToolset([]);
    expect(tools).not.toContain("web_search");
    expect(tools).not.toContain("web_fetch");
  });

  it("includes extra tools when configured", () => {
    const tools = exploreToolset(["lsp_definition", "lsp_references"]);
    expect(tools).toContain("lsp_definition");
    expect(tools).toContain("lsp_references");
  });

  it("deduplicates tools", () => {
    const tools = exploreToolset(["read"]);
    const reads = tools.filter((t) => t === "read");
    expect(reads).toHaveLength(1);
  });

  it("honours env extras", () => {
    const tools = exploreToolset([], { PI_SUBAGENT_EXPLORE_TOOLS: "lsp_hover,lsp_diagnostics" });
    expect(tools).toContain("lsp_hover");
    expect(tools).toContain("lsp_diagnostics");
  });
});

describe("explore prompt", () => {
  const prompt = AGENTS.explore.systemPrompt!;

  it("does not mention web tools", () => {
    expect(prompt).not.toContain("web_search");
    expect(prompt).not.toContain("web_fetch");
  });
});

// ─── Agent config assertions ────────────────────────────────────────────────

describe("resolveAgentType()", () => {
  it('resolves "explore" prefix to explore', () => {
    expect(resolveAgentType("explore")).toBe("explore");
    expect(resolveAgentType("expl")).toBe("explore");
    expect(resolveAgentType("EXPLORE")).toBe("explore");
  });

  it("defaults unknown prefixes to general", () => {
    expect(resolveAgentType("anything_else")).toBe("general");
    expect(resolveAgentType("researcher")).toBe("general");
  });
});

describe("AGENTS", () => {
  it("explore is read-only", () => {
    expect(AGENTS.explore.readOnly).toBe(true);
  });

  it("general is not read-only", () => {
    expect(AGENTS.general.readOnly).toBe(false);
  });

  it("all types have descriptions", () => {
    for (const type of ["explore", "general"] as const) {
      expect(AGENTS[type].description.length).toBeGreaterThan(0);
    }
  });
});