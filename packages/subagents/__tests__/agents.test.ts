import { describe, it, expect } from "vitest";
import {
  AGENTS,
  CORE_READ_TOOLS,
  RESEARCH_TOOLS,
  SAFETY_EXCLUDES,
  exploreToolset,
  researcherToolset,
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

describe("RESEARCH_TOOLS", () => {
  it("includes web_search", () => {
    expect(RESEARCH_TOOLS).toContain("web_search");
  });

  it("includes web_fetch", () => {
    expect(RESEARCH_TOOLS).toContain("web_fetch");
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

describe("researcherToolset()", () => {
  it("includes web_search and web_fetch", () => {
    const tools = researcherToolset([]);
    expect(tools).toContain("web_search");
    expect(tools).toContain("web_fetch");
  });

  it("includes core read tools", () => {
    const tools = researcherToolset([]);
    for (const tool of CORE_READ_TOOLS) {
      expect(tools).toContain(tool);
    }
  });

  it("does not include safety-excluded tools", () => {
    const tools = researcherToolset([]);
    for (const excluded of SAFETY_EXCLUDES) {
      expect(tools).not.toContain(excluded);
    }
  });

  it("includes extra tools when configured", () => {
    const tools = researcherToolset(["my_custom_tool"]);
    expect(tools).toContain("my_custom_tool");
  });

  it("deduplicates when web tools are also in extras", () => {
    const tools = researcherToolset(["web_search"]);
    const webSearches = tools.filter((t) => t === "web_search");
    expect(webSearches).toHaveLength(1);
  });
});

// ─── Prompt content assertions ──────────────────────────────────────────────

describe("researcher prompt", () => {
  const prompt = AGENTS.researcher.systemPrompt!;

  it("instructs to break research into multiple searchable facets", () => {
    const facetIndicators = [
      "facet",
      "angle",
      "aspect",
      "dimension",
      "search",
      "vary",
      "multiple",
    ];
    const found = facetIndicators.some((word) => prompt.toLowerCase().includes(word));
    expect(found).toBe(true);
  });

  it("prefers official docs and primary sources over lower-quality sources", () => {
    const sourceIndicators = ["official", "primary source", "authoritative", "canonical"];
    const found = sourceIndicators.some((word) => prompt.toLowerCase().includes(word));
    expect(found).toBe(true);
  });

  it("instructs to check /llms.txt on likely documentation hosts", () => {
    expect(prompt).toContain("/llms.txt");
  });

  it("allows discovered llms-full.txt and llms-all.txt variants", () => {
    const hasFull = prompt.includes("llms-full.txt");
    const hasAll = prompt.includes("llms-all.txt");
    expect(hasFull || hasAll).toBe(true);
  });

  it("requires verifying LLM docs claims against official source pages", () => {
    const verifyIndicators = ["verif", "confirm", "cross-check", "corroborat", "validate"];
    const found = verifyIndicators.some((word) => prompt.toLowerCase().includes(word));
    expect(found).toBe(true);
  });

  it("instructs to fetch the most promising URLs rather than relying only on snippets", () => {
    const fetchIndicators = ["fetch", "retrieve", "open", "visit"];
    const found = fetchIndicators.some((word) => prompt.toLowerCase().includes(word));
    expect(found).toBe(true);
  });

  it("requires final answers to include citations, source rationale, and gaps", () => {
    const hasCite = prompt.toLowerCase().includes("cit");
    const hasSource = prompt.toLowerCase().includes("source");
    const hasGap = prompt.toLowerCase().includes("gap");
    expect(hasCite && hasSource && hasGap).toBe(true);
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

  it('resolves "researcher" prefix to researcher', () => {
    expect(resolveAgentType("researcher")).toBe("researcher");
    expect(resolveAgentType("rese")).toBe("researcher");
    expect(resolveAgentType("RESEARCHER")).toBe("researcher");
  });

  it("defaults unknown prefixes to general", () => {
    expect(resolveAgentType("anything_else")).toBe("general");
  });
});

describe("AGENTS", () => {
  it("explore is read-only", () => {
    expect(AGENTS.explore.readOnly).toBe(true);
  });

  it("researcher is read-only", () => {
    expect(AGENTS.researcher.readOnly).toBe(true);
  });

  it("general is not read-only", () => {
    expect(AGENTS.general.readOnly).toBe(false);
  });

  it("all types have descriptions", () => {
    for (const type of ["explore", "researcher", "general"] as const) {
      expect(AGENTS[type].description.length).toBeGreaterThan(0);
    }
  });
});
