import { describe, it, expect } from "vitest";
import { renderAgentCall, renderAgentResult, type StreamEntry } from "../index.ts";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderedText(type: string, description: string): string {
  const component = renderAgentCall({ subagent_type: type, description }, plainTheme);
  return component.render(80).join("\n");
}

function renderResultText(result: any, options: { expanded: boolean; isPartial: boolean }): string {
  const component = renderAgentResult(result, options, plainTheme, undefined);
  return component.render(80).join("\n");
}

function makePartialResult(entries: StreamEntry[]) {
  const lines: string[] = [];
  let textBuffer = "";
  for (const e of entries) {
    if (e.type === "text") {
      textBuffer += e.text;
      continue;
    }
    if (textBuffer) {
      lines.push(textBuffer);
      textBuffer = "";
    }
    const marker = e.type === "tool_start" ? "▶" : e.error ? "✗" : "✓";
    lines.push(`${marker} ${e.name}`);
  }
  if (textBuffer) lines.push(textBuffer);
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { streamEntries: entries, streamText: lines.join("\n") },
  };
}

// ---------------------------------------------------------------------------
// renderAgentCall tests
// ---------------------------------------------------------------------------

describe("renderAgentCall", () => {
  it("shows tool name for all types", () => {
    for (const type of ["explore", "general"] as const) {
      const text = renderedText(type, "Some task");
      expect(text).toContain("Agent");
    }
  });

  it("shows subagent type", () => {
    const cases: Array<{ type: string; label: string }> = [
      { type: "explore", label: "explore" },
      { type: "general", label: "general" },
    ];
    for (const { type, label } of cases) {
      const text = renderedText(type, "Any description");
      expect(text).toContain(label);
    }
  });

  it("shows description", () => {
    const desc = "Explore the codebase for patterns";
    const text = renderedText("explore", desc);
    expect(text).toContain(desc);
  });

  it("renders all types correctly", () => {
    const descriptions = {
      explore: "Read-only codebase discovery",
      general: "Scoped read/write work off the main context",
    } as const;

    for (const [type, desc] of Object.entries(descriptions)) {
      const text = renderedText(type, desc);
      expect(text).toContain(type);
      expect(text).toContain(desc);
      expect(text).toContain("Agent");
    }
  });

  it("returns a renderable component", () => {
    const component = renderAgentCall(
      { subagent_type: "explore", description: "test" },
      plainTheme,
    );
    expect(typeof component.render).toBe("function");
    const lines = component.render(80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("starts with tool name, not bare type", () => {
    const text = renderedText("explore", "short task");
    const trimmed = text.trim();
    expect(trimmed.startsWith("Agent")).toBe(true);
    expect(trimmed.startsWith("explore")).toBe(false);
  });

  it("renders an unsupported type as requested without throwing", () => {
    const text = renderedText("researcher", "stale task");
    expect(text).toContain("Agent");
    expect(text).toContain("researcher");
    expect(text).toContain("stale task");
  });
});

// ---------------------------------------------------------------------------
// renderAgentResult — final result (isPartial: false)
// ---------------------------------------------------------------------------

describe("renderAgentResult — final", () => {
  it("renders clean answer with no tool markers", () => {
    const result = {
      content: [{ type: "text" as const, text: "Clean final answer." }],
      details: { agent_id: "sa_abc", status: "completed", tokens: 10, toolUses: 1 },
    };
    const text = renderResultText(result, { expanded: false, isPartial: false });
    expect(text).toContain("Clean final answer.");
    expect(text).not.toContain("▶");
    expect(text).not.toContain("streamText");
  });

  it("ignores stream entries leaked in details", () => {
    const entries: StreamEntry[] = [
      { type: "tool_start", name: "bash" },
      { type: "tool_end", name: "bash", error: true },
      { type: "text", text: "leaked stream text" },
    ];
    const result = {
      content: [{ type: "text" as const, text: "Clean answer." }],
      details: {
        agent_id: "sa_abc",
        status: "completed" as const,
        tokens: 10,
        toolUses: 1,
        streamEntries: entries,
        streamText: "▶ bash\n✗ bash\nleaked stream text",
      },
    };
    const text = renderResultText(result, { expanded: false, isPartial: false });
    expect(text.startsWith("Clean answer.")).toBe(true);
    expect(text).not.toContain("▶");
    expect(text).not.toContain("✗");
    expect(text).not.toContain("leaked stream");
  });

  it("never emits tool markers in final output", () => {
    const answers = [
      "Research complete. Found 3 sources.",
      "Codebase analysis done.",
      "No issues found.",
      "Error: file not found. Checked src/ -- nothing.",
    ];
    for (const answer of answers) {
      const result = {
        content: [{ type: "text" as const, text: answer }],
        details: { agent_id: "sa_x", status: "completed" as const, tokens: 1, toolUses: 0 },
      };
      const rendered = renderResultText(result, { expanded: false, isPartial: false });
      expect(rendered.startsWith(answer)).toBe(true);
      expect(rendered).not.toContain("▶");
      expect(rendered).not.toContain("✓");
      expect(rendered).not.toContain("✗");
    }
  });
});

// ---------------------------------------------------------------------------
// renderAgentResult — partial (streaming) expanded
// ---------------------------------------------------------------------------

describe("renderAgentResult — partial expanded", () => {
  it("interleaves text and tool markers", () => {
    const entries: StreamEntry[] = [
      { type: "text", text: "Looking..." },
      { type: "tool_start", name: "read" },
      { type: "tool_end", name: "read", error: false },
      { type: "text", text: "Found it." },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: true, isPartial: true });
    expect(text).toContain("Looking...");
    expect(text).toContain("▶ read");
    expect(text).toContain("✓ read");
    expect(text).toContain("Found it.");
  });

  it("bounded tail merges adjacent text entries", () => {
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 49; i++) {
      entries.push({ type: "tool_start", name: `tool_${i}` });
      entries.push({ type: "tool_end", name: `tool_${i}`, error: false });
    }
    entries.push({ type: "text", text: "Final analysis: " });
    entries.push({ type: "text", text: "all tests pass." });
    entries.push({ type: "tool_start", name: "tool_50" });
    entries.push({ type: "tool_end", name: "tool_50", error: false });

    const text = renderResultText(
      { content: [], details: { streamEntries: entries } },
      { expanded: true, isPartial: true },
    );

    // Early tool should not appear
    expect(text).not.toMatch(/▶ tool_1(?!\d)/);

    // Combined text from adjacent entries
    expect(text).toContain("Final analysis: all tests pass.");

    // Last tool markers in bounded tail
    expect(text).toMatch(/▶ tool_50\b/);
    expect(text).toMatch(/✓ tool_50\b/);
  });

  it("fewer than limit shows all", () => {
    const entries: StreamEntry[] = [
      { type: "tool_start", name: "read" },
      { type: "tool_end", name: "read", error: false },
      { type: "tool_start", name: "grep" },
      { type: "tool_end", name: "grep", error: false },
      { type: "tool_start", name: "bash" },
      { type: "tool_end", name: "bash", error: true },
    ];

    const text = renderResultText(
      { content: [], details: { streamEntries: entries } },
      { expanded: true, isPartial: true },
    );

    expect(text).toMatch(/▶ read\b/);
    expect(text).toMatch(/✓ read\b/);
    expect(text).toMatch(/▶ grep\b/);
    expect(text).toMatch(/✓ grep\b/);
    expect(text).toMatch(/▶ bash\b/);
    expect(text).toMatch(/✗ bash\b/);
  });

  it("bounded to tail when exceeding limit", () => {
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 100; i++) {
      entries.push({ type: "tool_start", name: `tool_${i}` });
      entries.push({ type: "tool_end", name: `tool_${i}`, error: false });
    }

    const text = renderResultText(
      { content: [], details: { streamEntries: entries } },
      { expanded: true, isPartial: true },
    );

    // First tool excluded
    expect(text).not.toMatch(/▶ tool_1(?!\d)/);
    expect(text).not.toMatch(/✓ tool_1(?!\d)/);

    // Last tool included
    expect(text).toMatch(/▶ tool_100\b/);
    expect(text).toMatch(/✓ tool_100\b/);

    // Fewer markers than total entries
    const markers = (text.match(/[▶✓✗]/g) || []).length;
    expect(markers).toBeGreaterThan(0);
    expect(markers).toBeLessThan(200);
  });

  it("shows tool error marker", () => {
    const entries: StreamEntry[] = [
      { type: "tool_start", name: "bash" },
      { type: "tool_end", name: "bash", error: true },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: true, isPartial: true });
    expect(text).toContain("▶ bash");
    expect(text).toContain("✗ bash");
    expect(text).not.toContain("✓ bash");
  });

  it("tolerates unknown entry types", () => {
    const entries = [
      { type: "text", text: "Hello " },
      { type: "unknown", name: "bad" },
      { type: "text", text: "world" },
    ] as unknown as StreamEntry[];
    const text = renderResultText(makePartialResult(entries), { expanded: true, isPartial: true });
    expect(text).toContain("Hello ");
    expect(text).toContain("world");
  });
});

// ---------------------------------------------------------------------------
// renderAgentResult — partial (streaming) collapsed
// ---------------------------------------------------------------------------

describe("renderAgentResult — partial collapsed", () => {
  it("shows latest tool start", () => {
    const entries: StreamEntry[] = [
      { type: "text", text: "Starting search." },
      { type: "tool_start", name: "grep" },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
    expect(text.trim()).toBe("▶ grep");
  });

  it("shows latest tool end (success)", () => {
    const entries: StreamEntry[] = [
      { type: "tool_start", name: "read" },
      { type: "tool_end", name: "read", error: false },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
    expect(text.trim()).toBe("✓ read");
  });

  it("shows latest tool error", () => {
    const entries: StreamEntry[] = [
      { type: "tool_start", name: "bash" },
      { type: "tool_end", name: "bash", error: true },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
    expect(text.trim()).toBe("✗ bash");
  });

  it("ignores trailing text — shows latest tool marker", () => {
    const entries: StreamEntry[] = [
      { type: "tool_start", name: "read" },
      { type: "tool_end", name: "read", error: false },
      { type: "text", text: "Almost done." },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
    expect(text.trim()).toBe("✓ read");
  });

  it("shows neutral running status when only text entries exist", () => {
    const entries: StreamEntry[] = [{ type: "text", text: "Thinking..." }];
    const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
    expect(text.trim()).toBe("⟳ running…");
  });

  it("shows neutral status for multiple text-only entries", () => {
    const entries: StreamEntry[] = [
      { type: "text", text: "Let me think about this..." },
      { type: "text", text: "Still working..." },
    ];
    const text = renderResultText(makePartialResult(entries), { expanded: false, isPartial: true });
    expect(text.trim()).toBe("⟳ running…");
  });

  it("renders empty text when no entries", () => {
    const noEntries = renderResultText(
      { content: [], details: {} },
      { expanded: false, isPartial: true },
    );
    expect(noEntries).toBe("");

    const emptyArray = renderResultText(
      { content: [], details: { streamEntries: [] } },
      { expanded: false, isPartial: true },
    );
    expect(emptyArray).toBe("");

    const nullEntries = renderResultText(
      { content: [], details: { streamEntries: null } },
      { expanded: false, isPartial: true },
    );
    expect(nullEntries).toBe("");
  });
});