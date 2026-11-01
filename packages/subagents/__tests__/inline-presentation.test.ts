import { describe, it, expect } from "vitest";

/** Strip lifecycle symbols: assertions must hold on words alone, never on
 *  color- or symbol-only signals. */
function stripSymbols(s: string): string {
  return s.replace(/[▶✓✗⟳]/g, "");
}

import {
  renderAgentCall,
  renderAgentResult,
  formatExpandedStream,
  backgroundReceiptText,
  EXPANDED_TAIL_LIMIT,
  type StreamEntry,
} from "../index.ts";
import {
  OUTCOME_MESSAGE_TYPE,
  outcomeMessage,
  renderOutcomeMessage,
  type OutcomeMessage,
} from "../delivery.ts";
import { default as subagentsExtension } from "../index.ts";
import { makeFakeApi } from "./helpers.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Plain theme — no ANSI codes, just passes text through.
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function renderedCall(args: { subagent_type: string; description: string }, width = 80): string {
  return renderAgentCall(args as any, plainTheme)
    .render(width)
    .join("\n");
}

function renderPartial(
  entries: StreamEntry[],
  options: { expanded: boolean; agentId?: string },
): string {
  return renderAgentResult(
    {
      content: [{ type: "text" as const, text: "" }],
      details: { streamEntries: entries, agentId: options.agentId },
    } as any,
    { expanded: options.expanded, isPartial: true },
    plainTheme,
    undefined,
  )
    .render(80)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Compact active row (collapsed partial): textual state, latest tool marker,
// run id where needed — never live assistant prose.
// ---------------------------------------------------------------------------

describe("compact active row — textual state and latest tool marker", () => {
  it("names the running state plus the latest started tool in words", () => {
    const text = renderPartial(
      [
        { type: "text", text: "Let me look at the source." }, // never shown compact
        { type: "tool_start", name: "grep" },
      ],
      { expanded: false },
    );
    expect(text).toContain("running");
    expect(text).toContain("grep");
    expect(text).toContain("started");
    expect(text).toContain("▶");
    // No live assistant prose on compact active rows.
    expect(text).not.toContain("Let me look");
  });

  it("marks a finished tool with success wording, not a symbol alone", () => {
    const text = renderPartial(
      [
        { type: "tool_start", name: "read" },
        { type: "tool_end", name: "read", error: false },
      ],
      { expanded: false },
    );
    expect(text).toContain("running");
    expect(text).toContain("✓");
    expect(text).toContain("read");
    expect(text).toContain("finished");
    expect(text).not.toContain("failed");
    expect(text).not.toContain("started");
  });

  it("marks a failed tool with failure wording, distinct from success", () => {
    const text = renderPartial(
      [
        { type: "tool_start", name: "bash" },
        { type: "tool_end", name: "bash", error: true },
      ],
      { expanded: false },
    );
    expect(text).toContain("running");
    expect(text).toContain("✗");
    expect(text).toContain("bash");
    expect(text).toContain("failed");
    expect(text).not.toContain("finished");
  });

  it("ignores trailing assistant text and keeps the last tool marker", () => {
    const text = renderPartial(
      [
        { type: "tool_start", name: "read" },
        { type: "tool_end", name: "read", error: false },
        { type: "text", text: "Almost done here." },
      ],
      { expanded: false },
    );
    expect(text).toContain("finished read");
    expect(text).not.toContain("Almost done");
  });

  it("shows the neutral running state with no assistant prose when only text arrived", () => {
    const text = renderPartial(
      [
        { type: "text", text: "Thinking about the problem..." },
        { type: "text", text: "Still thinking." },
      ],
      { expanded: false },
    );
    expect(text.trim()).toBe("running");
    expect(text).not.toContain("Thinking");
  });

  it("relsays the state purely in text, understandable without any symbol or color", () => {
    const started = stripSymbols(
      renderPartial([{ type: "tool_start", name: "grep" }], { expanded: false }),
    );
    expect(started).toContain("running");
    expect(started).toContain("grep");
    expect(started).toContain("started");

    const errored = stripSymbols(
      renderPartial(
        [
          { type: "tool_start", name: "bash" },
          { type: "tool_end", name: "bash", error: true },
        ],
        { expanded: false },
      ),
    );
    expect(errored).toContain("failed");
    expect(errored).not.toContain("finished");
  });

  it("renders empty when no entries have arrived yet", () => {
    expect(renderPartial([], { expanded: false })).toBe("");
    const nullish = renderAgentResult(
      { content: [], details: {} } as any,
      { expanded: false, isPartial: true },
      plainTheme,
      undefined,
    );
    expect(nullish.render(80)).toEqual([]);
  });
});

describe("compact active row — concurrent runs remain distinguishable", () => {
  it("includes the run id when it is known", () => {
    const text = renderPartial([{ type: "tool_start", name: "grep" }], {
      expanded: false,
      agentId: "sa_1_abc",
    });
    expect(text).toContain("sa_1_abc");
    expect(text).toContain("running");
  });

  it("omits the run id when unknown instead of rendering a placeholder lie", () => {
    const text = renderPartial([{ type: "tool_start", name: "grep" }], { expanded: false });
    expect(text).not.toContain("run ");
    expect(text).not.toContain("undefined");
  });

  it("renders two concurrent runs with their own ids, not a shared one", () => {
    const a = renderPartial([{ type: "tool_start", name: "grep" }], {
      expanded: false,
      agentId: "sa_1_aaa",
    });
    const b = renderPartial([{ type: "tool_start", name: "bash" }], {
      expanded: false,
      agentId: "sa_2_bbb",
    });
    expect(a).toContain("sa_1_aaa");
    expect(a).not.toContain("sa_2_bbb");
    expect(b).toContain("sa_2_bbb");
    expect(b).not.toContain("sa_1_aaa");
  });
});

// ---------------------------------------------------------------------------
// Expanded activity tail: at most 50 chronological entries + omission indicator.
// ---------------------------------------------------------------------------

function toolPair(i: number): StreamEntry[] {
  return [
    { type: "tool_start", name: `tool_${i}` },
    { type: "tool_end", name: `tool_${i}`, error: false },
  ];
}

describe("expanded activity tail — 50-entry bound with omission indicator", () => {
  it("shows an omission indicator when earlier entries are dropped", () => {
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 120; i++) entries.push(...toolPair(i));
    const text = renderPartial(entries, { expanded: true });
    // 240 entries total, the last 50 are kept.
    expect(text).toContain("190 earlier entries not shown");
    expect(text).not.toContain("▶ tool_1\n");
    expect(text).not.toContain("240 earlier");
  });

  it("keeps exactly the last 50 entries", () => {
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 120; i++) entries.push(...toolPair(i));
    const text = renderPartial(entries, { expanded: true });
    expect(text).toContain("▶ started tool_120");
    expect(text).toContain("✓ finished tool_120");
    // The kept 50 entries are the 25 final pairs: tools 96..120.
    expect(text).toContain("▶ started tool_96");
    expect(text).not.toContain("▶ started tool_95\b");
    expect(text).not.toContain("tool_95\n");
  });

  it("shows no omission indicator at or under the limit", () => {
    const atLimit: StreamEntry[] = Array.from(
      { length: EXPANDED_TAIL_LIMIT },
      (_, i): StreamEntry => ({ type: "tool_start", name: `single_${i + 1}` }),
    );
    const atText = renderPartial(atLimit, { expanded: true });
    expect(atText).not.toContain("earlier entries not shown");
    expect(atText).toContain("single_50");
    expect(atText).toContain("single_1");

    const under: StreamEntry[] = [
      toolPair(1),
      { type: "text", text: "text" },
    ].flat() as StreamEntry[];
    expect(renderPartial(under, { expanded: true })).not.toContain("not shown");
  });

  it("merges adjacent text entries inside the tail", () => {
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 80; i++) entries.push(...toolPair(i));
    entries.push({ type: "text", text: "Final analysis: " });
    entries.push({ type: "text", text: "all clear." });
    const text = renderPartial(entries, { expanded: true });
    expect(text).toContain("Final analysis: all clear.");
  });

  it("is UI-only: nothing about the tail reaches model-facing content shape", () => {
    // The expanded tail is rendered by renderAgentResult from `details`;
    // formatExpandedStream only ever produces display text.
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 60; i++) entries.push(...toolPair(i));
    const text = formatExpandedStream(entries);
    expect(typeof text).toBe("string");
    expect(text).toContain("earlier entries not shown");
  });
});

// ---------------------------------------------------------------------------
// Run row identity: custom types are not displayed as built-ins.
// ---------------------------------------------------------------------------

describe("renderAgentCall — custom-type resolution fix", () => {
  it("displays a custom name that starts like a built-in alias as itself", () => {
    // Regression: `renderAgentCall("explorer")` used the speculative `expl`
    // alias and displayed the custom type as `explore`.
    const text = renderedCall({ subagent_type: "explorer", description: "Review the diff" });
    expect(text).toContain("explorer");
    expect(text).not.toMatch(/explore\b/);
  });

  it("displays any other custom name exactly as requested", () => {
    for (const name of ["code-reviewer", "reactionary-optimizer", "Explorer"]) {
      const text = renderedCall({ subagent_type: name, description: "Task" });
      expect(text).toContain(name);
    }
  });

  it("still canonicalizes exact built-in names case-insensitively", () => {
    expect(renderedCall({ subagent_type: "EXPLORE", description: "x" })).toContain("explore");
    expect(renderedCall({ subagent_type: "general", description: "x" })).toContain("general");
  });

  it("still starts with the tool name, never with a bare type", () => {
    const text = renderedCall({ subagent_type: "explore", description: "short task" }).trim();
    expect(text.startsWith("Agent")).toBe(true);
  });

  it("marks background call rows in words", () => {
    const bg = renderedCall({
      subagent_type: "general",
      description: "long task",
      run_in_background: true,
    } as any);
    expect(bg).toContain("background");
    const fg = renderedCall({ subagent_type: "general", description: "long task" });
    expect(fg).not.toContain("background");
  });

  it("preserve identity at narrow widths (wrapping keeps the type and description words)", () => {
    const text = renderedCall(
      { subagent_type: "code-reviewer", description: "Review authentication changes" },
      30,
    );
    expect(text).toContain("code-reviewer");
    expect(text).toContain("Review");
  });
});

// ---------------------------------------------------------------------------
// Compact and expanded rows keep identity at narrow widths.
// ---------------------------------------------------------------------------

describe("narrow widths — identity and outcome survive wrapping", () => {
  it("compact active row keeps state, tool, and run id at narrow width", () => {
    const text = renderPartial(
      [
        { type: "tool_start", name: "grep" },
        { type: "tool_end", name: "grep", error: false },
      ],
      { expanded: false, agentId: "sa_3_narrow" },
    );
    const narrow = renderAgentResult(
      {
        content: [],
        details: {
          streamEntries: [{ type: "tool_end" as const, name: "grep", error: false }],
          agentId: "sa_3_narrow",
        },
      } as any,
      { expanded: false, isPartial: true },
      plainTheme,
      undefined,
    )
      .render(32)
      .join("\n");
    expect(narrow).toContain("running");
    expect(narrow).toContain("grep");
    expect(narrow).toContain("sa_3_narrow");
    expect(narrow).toContain("finished");
    void text;
  });

  it("expanded tail keeps the omission indicator at narrow width", () => {
    const entries: StreamEntry[] = [];
    for (let i = 1; i <= 90; i++) entries.push(...toolPair(i));
    const component = renderAgentResult(
      { content: [], details: { streamEntries: entries } } as any,
      { expanded: true, isPartial: true },
      plainTheme,
      undefined,
    );
    const narrow = component.render(28).join("\n").replace(/\s+/g, " ");
    expect(narrow).toContain("earlier entries not shown");
    expect(narrow).toContain("tool_90");
  });
});

// ---------------------------------------------------------------------------
// Background launch receipt: identifiable, textual queued state.
// ---------------------------------------------------------------------------

describe("background launch receipt", () => {
  it("names type, description, run id, and the textual queued state", () => {
    const text = backgroundReceiptText({
      type: "general",
      description: "refactor the parser",
      id: "sa_7_zzz",
    });
    expect(text).toContain("general");
    expect(text).toContain("refactor the parser");
    expect(text).toContain("sa_7_zzz");
    expect(text).toContain("queued");
    expect(text).toContain("get_subagent_result");
    expect(text).toContain("stop_subagent");
  });

  it("appends the mode delivery diagnostic when the mode cannot promise delivery", () => {
    const text = backgroundReceiptText(
      { type: "explore", description: "scan", id: "sa_8_yyy" },
      "Automatic background completion delivery is not promised in print mode.",
    );
    expect(text).toContain("not promised in print mode");
  });

  it("wires the receipt through the Agent tool's background launch", async () => {
    const tools: ToolDefinition[] = [];
    subagentsExtension(makeFakeApi(tools) as unknown as ExtensionAPI);
    const agent = tools.find((t) => t.name === "Agent")!;
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      mode: "tui",
      model: undefined,
      signal: undefined,
      modelRegistry: { find: () => undefined },
      ui: { notify: () => {} },
    } as any;
    const res = (await agent.execute!(
      "call-1",
      {
        subagent_type: "general",
        prompt: "work",
        description: "long task",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    )) as any;
    const text = res.content[0].text as string;
    expect(res.details.agent_id).toBeTypeOf("string");
    expect(text).toContain("general");
    expect(text).toContain("long task");
    expect(text).toContain(res.details.agent_id);
    expect(text).toContain("queued");
    expect(text).toContain("get_subagent_result");
  });
});

// ---------------------------------------------------------------------------
// Attributed completion message renderer (subagent-outcome custom message).
// ---------------------------------------------------------------------------

function renderOutcome(msg: OutcomeMessage, expanded: boolean, width = 80): string {
  const component = renderOutcomeMessage(msg as any, { expanded, outputPad: 0 }, plainTheme);
  if (!component) throw new Error("outcome renderer returned undefined");
  return component.render(width).join("\n");
}

describe("renderOutcomeMessage — authoritative attributed completion", () => {
  const base = {
    id: "sa_1_out",
    type: "explore",
    description: "find auth helpers",
  } as const;

  it("compact: one identifiable line that names type, task, run id, and textual status", () => {
    const msg = outcomeMessage({
      ...base,
      status: "completed",
      background: true,
      result: "the bounded answer",
      tokens: 4,
      toolUses: 2,
    });
    const text = renderOutcome(msg, false);
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    expect(text).toContain("explore");
    expect(text).toContain("find auth helpers");
    expect(text).toContain("sa_1_out");
    expect(text).toContain("completed");
  });

  it("compact hides the result body; expanded shows the authoritative full content", () => {
    const msg = outcomeMessage({
      ...base,
      status: "completed",
      background: true,
      result: "the bounded answer body",
      tokens: 4,
      toolUses: 2,
    });
    const compact = renderOutcome(msg, false);
    expect(compact).not.toContain("the bounded answer body");
    const expanded = renderOutcome(msg, true);
    expect(expanded).toContain("the bounded answer body");
    expect(expanded).toContain("sa_1_out");
    expect(expanded).toContain("completed");
  });

  it("failed runs expose the failure reason distinctly from completion", () => {
    const msg = outcomeMessage({
      ...base,
      status: "failed",
      background: true,
      error: "provider 500",
      partialText: "draft so far",
      tokens: 1,
      toolUses: 0,
    });
    const compact = renderOutcome(msg, false);
    expect(compact).toContain("failed");
    expect(compact).toContain("provider 500");
    expect(compact).not.toContain("completed");
    const expanded = renderOutcome(msg, true);
    expect(expanded).toContain("Partial assistant output (incomplete)");
    expect(expanded).toContain("draft so far");
    expect(expanded).toContain("provider 500");
  });

  it("stopped runs without output are explicitly distinct from failures", () => {
    const msg = outcomeMessage({
      ...base,
      status: "stopped",
      background: true,
      stopReason: "Stopped by request",
      tokens: 0,
      toolUses: 1,
    });
    const expanded = renderOutcome(msg, true);
    expect(expanded).toContain("stopped");
    expect(expanded).toContain("Stopped by request");
    expect(expanded).toContain("No partial assistant output is available.");
    expect(expanded).not.toContain("failed");
  });

  it("shows a truncation notice carried in the content on failure and stop paths too", () => {
    const msg = outcomeMessage({
      ...base,
      status: "failed",
      background: true,
      error: "boom",
      partialText: "short draft\n[Truncated: original 25,000 bytes, showing first 20,000]",
      tokens: 0,
      toolUses: 0,
    });
    const expanded = renderOutcome(msg, true);
    expect(expanded).toContain("[Truncated:");
  });

  it("attributes each concurrent run to its own identity — never a cross-attribution", () => {
    const a = outcomeMessage({
      ...base,
      status: "completed",
      background: true,
      result: "alpha result",
      tokens: 1,
      toolUses: 0,
    });
    const b = outcomeMessage({
      id: "sa_2_out",
      type: "general",
      description: "second task",
      status: "completed",
      background: true,
      result: "beta result",
      tokens: 1,
      toolUses: 0,
    });
    const compactA = renderOutcome(a, false);
    const compactB = renderOutcome(b, false);
    expect(compactA).toContain("sa_1_out");
    expect(compactA).toContain("find auth helpers");
    expect(compactA).not.toContain("second task");
    expect(compactA).not.toContain("sa_2_out");
    expect(compactB).toContain("sa_2_out");
    expect(compactB).toContain("second task");
    expect(compactB).not.toContain("sa_1_out");
    expect(compactB).not.toContain("find auth helpers");
  });

  it("never surfaces hidden reasoning or tool activity even if someone stashes them in details", () => {
    const msg: OutcomeMessage = {
      ...outcomeMessage({
        ...base,
        status: "completed",
        background: true,
        result: "answer",
        tokens: 1,
        toolUses: 0,
      }),
      details: {
        agentId: "sa_1_out",
        type: "explore",
        description: "find auth helpers",
        status: "completed",
        thinking_delta: "secret chain of thought",
        streamEntries: [{ type: "tool_start", name: "bash" }],
      },
    };
    const expanded = renderOutcome(msg, true);
    expect(expanded).not.toContain("secret chain of thought");
    expect(expanded).not.toContain("thinking");
    expect(expanded).not.toContain("streamEntries");
    expect(expanded).not.toContain("tool_start");
  });

  it("is understandable at narrow width — status, type, and run id survive wrapping", () => {
    const msg = outcomeMessage({
      ...base,
      status: "failed",
      background: true,
      error: "provider 500",
      partialText: undefined,
      tokens: 0,
      toolUses: 0,
    });
    const narrow = renderOutcome(msg, false, 30);
    expect(narrow).toContain("explore");
    expect(narrow).toContain("failed");
    expect(narrow).toContain("sa_1_out");
  });

  it("falls back to the message content when details are missing, still one readable line", () => {
    const text = renderOutcome(
      {
        customType: OUTCOME_MESSAGE_TYPE,
        content: "Subagent general (task) completed [run sa_9_qq].\n\nthe answer",
        display: true,
        details: undefined,
      },
      false,
    );
    expect(text).toContain("completed");
    expect(text).not.toContain("the answer");
    expect(text).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Registration: the extension installs the renderer for its custom type.
// ---------------------------------------------------------------------------

describe("extension registration — subagent-outcome message renderer", () => {
  it("registers a message renderer under the subagent-outcome custom type", () => {
    const tools: ToolDefinition[] = [];
    const renderers = new Map<string, unknown>();
    subagentsExtension(
      makeFakeApi(tools, { messageRenderers: renderers }) as unknown as ExtensionAPI,
    );
    const renderer = renderers.get("subagent-outcome");
    expect(typeof renderer).toBe("function");
  });

  it("the registered renderer renders a completed outcome both compact and expanded", () => {
    const tools: ToolDefinition[] = [];
    const renderers = new Map<string, (msg: any, opts: any, theme: any) => unknown>();
    subagentsExtension(
      makeFakeApi(tools, { messageRenderers: renderers as any }) as unknown as ExtensionAPI,
    );
    const renderer = renderers.get("subagent-outcome")!;
    const msg = outcomeMessage({
      id: "sa_5_rr",
      type: "general",
      description: "wire the schema",
      status: "completed",
      background: true,
      result: "schema wired",
      tokens: 2,
      toolUses: 1,
    });
    const compact = renderer(msg, { expanded: false, outputPad: 0 }, plainTheme) as any;
    const expanded = renderer(msg, { expanded: true, outputPad: 0 }, plainTheme) as any;
    const compactText = compact.render(80).join("\n");
    const expandedText = expanded.render(80).join("\n");
    expect(compactText).toContain("general");
    expect(compactText).toContain("sa_5_rr");
    expect(compactText).not.toContain("schema wired");
    expect(expandedText).toContain("schema wired");
  });
});