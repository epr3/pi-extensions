import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.ok(SAFETY_EXCLUDES.includes("Agent"));
    assert.ok(SAFETY_EXCLUDES.includes("get_subagent_result"));
  });

  it("prevents blocking on unanswered questions", () => {
    assert.ok(SAFETY_EXCLUDES.includes("question"));
  });
});

describe("RESEARCH_TOOLS", () => {
  it("includes web_search", () => {
    assert.ok(RESEARCH_TOOLS.includes("web_search"));
  });

  it("includes web_fetch", () => {
    assert.ok(RESEARCH_TOOLS.includes("web_fetch"));
  });
});

describe("CORE_READ_TOOLS", () => {
  it("includes the basic read-only built-ins", () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      assert.ok(CORE_READ_TOOLS.includes(tool));
    }
  });

  it("does not include web tools", () => {
    assert.ok(!CORE_READ_TOOLS.includes("web_search"));
    assert.ok(!CORE_READ_TOOLS.includes("web_fetch"));
  });
});

describe("exploreToolset()", () => {
  it("returns core read tools by default", () => {
    const tools = exploreToolset([]);
    assert.ok(tools.includes("read"));
    assert.ok(tools.includes("grep"));
    assert.ok(tools.includes("find"));
    assert.ok(tools.includes("ls"));
  });

  it("does not include web tools by default", () => {
    const tools = exploreToolset([]);
    assert.ok(!tools.includes("web_search"));
    assert.ok(!tools.includes("web_fetch"));
  });

  it("includes extra tools when configured", () => {
    const tools = exploreToolset(["lsp_definition", "lsp_references"]);
    assert.ok(tools.includes("lsp_definition"));
    assert.ok(tools.includes("lsp_references"));
  });

  it("deduplicates tools", () => {
    const tools = exploreToolset(["read"]);
    const reads = tools.filter((t) => t === "read");
    assert.equal(reads.length, 1);
  });

  it("honours env extras", () => {
    const tools = exploreToolset([], { PI_SUBAGENT_EXPLORE_TOOLS: "lsp_hover,lsp_diagnostics" });
    assert.ok(tools.includes("lsp_hover"));
    assert.ok(tools.includes("lsp_diagnostics"));
  });
});

describe("researcherToolset()", () => {
  it("includes web_search and web_fetch", () => {
    const tools = researcherToolset([]);
    assert.ok(tools.includes("web_search"));
    assert.ok(tools.includes("web_fetch"));
  });

  it("includes core read tools", () => {
    const tools = researcherToolset([]);
    for (const tool of CORE_READ_TOOLS) {
      assert.ok(tools.includes(tool));
    }
  });

  it("does not include safety-excluded tools", () => {
    const tools = researcherToolset([]);
    for (const excluded of SAFETY_EXCLUDES) {
      assert.ok(!tools.includes(excluded));
    }
  });

  it("includes extra tools when configured", () => {
    const tools = researcherToolset(["my_custom_tool"]);
    assert.ok(tools.includes("my_custom_tool"));
  });

  it("deduplicates when web tools are also in extras", () => {
    const tools = researcherToolset(["web_search"]);
    const webSearches = tools.filter((t) => t === "web_search");
    assert.equal(webSearches.length, 1);
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
    assert.ok(found, "Expected prompt to mention breaking research into multiple facets/angles");
  });

  it("prefers official docs and primary sources over lower-quality sources", () => {
    const sourceIndicators = ["official", "primary source", "authoritative", "canonical"];
    const found = sourceIndicators.some((word) => prompt.toLowerCase().includes(word));
    assert.ok(
      found,
      "Expected prompt to prefer official docs and primary sources",
    );
  });

  it("instructs to check /llms.txt on likely documentation hosts", () => {
    assert.ok(
      prompt.includes("/llms.txt"),
      "Expected prompt to mention checking /llms.txt on likely official documentation hosts",
    );
  });

  it("allows discovered llms-full.txt and llms-all.txt variants", () => {
    const hasFull = prompt.includes("llms-full.txt");
    const hasAll = prompt.includes("llms-all.txt");
    assert.ok(
      hasFull || hasAll,
      "Expected prompt to mention llms-full.txt or llms-all.txt variants",
    );
  });

  it("requires verifying LLM docs claims against official source pages", () => {
    const verifyIndicators = ["verif", "confirm", "cross-check", "corroborat", "validate"];
    const found = verifyIndicators.some((word) => prompt.toLowerCase().includes(word));
    assert.ok(
      found,
      "Expected prompt to require verifying important claims from LLM docs sources against official source pages",
    );
  });

  it("instructs to fetch the most promising URLs rather than relying only on snippets", () => {
    const fetchIndicators = ["fetch", "retrieve", "open", "visit"];
    const found = fetchIndicators.some((word) => prompt.toLowerCase().includes(word));
    assert.ok(
      found,
      "Expected prompt to instruct fetching promising URLs rather than relying on snippets alone",
    );
  });

  it("requires final answers to include citations, source rationale, and gaps", () => {
    const hasCite = prompt.toLowerCase().includes("cit");
    const hasSource = prompt.toLowerCase().includes("source");
    const hasGap = prompt.toLowerCase().includes("gap");
    assert.ok(
      hasCite && hasSource && hasGap,
      "Expected prompt to require citations, source rationale, and gaps in final answers",
    );
  });
});

describe("explore prompt", () => {
  const prompt = AGENTS.explore.systemPrompt!;

  it("does not mention web tools", () => {
    assert.ok(!prompt.includes("web_search"));
    assert.ok(!prompt.includes("web_fetch"));
    assert.ok(!prompt.includes("web_search"));
  });
});

// ─── Agent config assertions ────────────────────────────────────────────────

describe("resolveAgentType()", () => {
  it('resolves "explore" prefix to explore', () => {
    assert.equal(resolveAgentType("explore"), "explore");
    assert.equal(resolveAgentType("expl"), "explore");
    assert.equal(resolveAgentType("EXPLORE"), "explore");
  });

  it('resolves "researcher" prefix to researcher', () => {
    assert.equal(resolveAgentType("researcher"), "researcher");
    assert.equal(resolveAgentType("rese"), "researcher");
    assert.equal(resolveAgentType("RESEARCHER"), "researcher");
  });

  it("defaults unknown prefixes to general", () => {
    assert.equal(resolveAgentType("anything_else"), "general");
  });
});

describe("AGENTS", () => {
  it("explore is read-only", () => {
    assert.equal(AGENTS.explore.readOnly, true);
  });

  it("researcher is read-only", () => {
    assert.equal(AGENTS.researcher.readOnly, true);
  });

  it("general is not read-only", () => {
    assert.equal(AGENTS.general.readOnly, false);
  });

  it("all types have descriptions", () => {
    for (const type of ["explore", "researcher", "general"] as const) {
      assert.ok(AGENTS[type].description.length > 0);
    }
  });
});
