import { describe, it, expect } from "vitest";
import {
  AGENTS,
  CORE_READ_TOOLS,
  DEFAULT_EXPLORE_TOOLS,
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
    expect(CORE_READ_TOOLS).not.toContain("codemode");
  });
});

describe("DEFAULT_EXPLORE_TOOLS", () => {
  it("adds codemode to the core read tools", () => {
    expect(DEFAULT_EXPLORE_TOOLS).toEqual([...CORE_READ_TOOLS, "codemode"]);
  });
});

describe("exploreToolset()", () => {
  it("returns core read tools and codemode by default", () => {
    const tools = exploreToolset([]);
    for (const tool of ["read", "grep", "find", "ls", "codemode"]) {
      expect(tools).toContain(tool);
    }
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

  it("mentions codemode as an allowlist-only batching tool", () => {
    expect(prompt).toContain("codemode");
    expect(prompt).toContain("allowlist");
  });
});

describe("explore semantic navigation guidance", () => {
  const prompt = AGENTS.explore.systemPrompt!.toLowerCase();

  it("expresses the LSP-first preference for semantic navigation", () => {
    expect(/lsp_/.test(prompt)).toBe(true);
    expect(/prefer/.test(prompt)).toBe(true);
    expect(/grep|\bread\b|\bfind\b/.test(prompt)).toBe(true);
  });

  it("permits locating an identifier or position with text tools first and directs textual questions to them", () => {
    expect(/locate|find/.test(prompt)).toBe(true);
    expect(/position|identifier/.test(prompt)).toBe(true);
    expect(/comments/.test(prompt)).toBe(true);
    expect(/non-code/.test(prompt)).toBe(true);
  });

  it("supports fallback when the language server cannot help and names uncertainty", () => {
    expect(/fallback|fall back/.test(prompt)).toBe(true);
    expect(/unavailable|fails|times out/.test(prompt)).toBe(true);
    expect(/uncertain/.test(prompt)).toBe(true);
  });

  it("treats empty semantic results as inconclusive with selective verification", () => {
    expect(/empty/.test(prompt)).toBe(true);
    expect(/inconclusive/.test(prompt)).toBe(true);
    expect(/verify/.test(prompt)).toBe(true);
    expect(/not automatically/.test(prompt)).toBe(true);
  });

  it("keeps access framed as configuration — extra tools are granted, allowlist-only codemode stays", () => {
    expect(prompt).toContain("granted");
    expect(prompt).toContain("allowlist");
  });

  it("explore access to lsp tools remains configuration, not default", () => {
    expect(DEFAULT_EXPLORE_TOOLS).not.toContain("lsp_definition");
    expect(exploreToolset(["lsp_definition"]).includes("lsp_definition")).toBe(true);
    expect(
      exploreToolset([], { PI_SUBAGENT_EXPLORE_TOOLS: "lsp_references" }).includes(
        "lsp_references",
      ),
    ).toBe(true);
  });
});

// ─── Agent config assertions ────────────────────────────────────────────────

describe("resolveAgentType()", () => {
  it('resolves "explore" prefix to explore', () => {
    expect(resolveAgentType("explore")).toBe("explore");
    expect(resolveAgentType("expl")).toBe("explore");
    expect(resolveAgentType("EXPLORE")).toBe("explore");
  });

  it("rejects unsupported types instead of normalizing to general", () => {
    expect(() => resolveAgentType("anything_else")).toThrow(/Unsupported subagent_type/);
    expect(() => resolveAgentType("researcher")).toThrow(/Unsupported subagent_type/);
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