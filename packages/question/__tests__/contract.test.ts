/**
 * Question tool contract tests — Vitest.
 *
 * Verifies tool metadata, the 2-4 preset option validation rule, and the
 * non-interactive fallback behaviour.
 */

import { describe, it, expect } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import questionExtension from "../index.ts";

function makeFakeApi(captured: ToolDefinition[]): ExtensionAPI {
  return {
    registerTool: (tool) => {
      captured.push(tool as ToolDefinition);
    },
    on: () => {},
  } as unknown as ExtensionAPI;
}

function registerQuestion(): ToolDefinition {
  const tools: ToolDefinition[] = [];
  questionExtension(makeFakeApi(tools));
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

function noUICtx(): ExtensionContext {
  return { hasUI: false } as ExtensionContext;
}

/** Queue-based fake UI: each select/editor call returns the next scripted response. */
function scriptedCtx(responses: { select?: string; editor?: string }[]): ExtensionContext {
  const queue = [...responses];
  const ui = {
    select: async () => queue.shift()?.select,
    editor: async () => queue.shift()?.editor,
  } as unknown as ExtensionUIContext;
  return { hasUI: true, ui } as ExtensionContext;
}

describe("question tool contract", () => {
  it("registers under the name 'question' with the 'Question' label", () => {
    const tool = registerQuestion();
    expect(tool.name).toBe("question");
    expect(tool.label).toBe("Question");
  });

  it("description advertises 2-4 options, free prose, and multi-select", () => {
    const tool = registerQuestion();
    expect(tool.description).toMatch(/2-4/);
    expect(tool.description).toMatch(/free[- ]prose/);
    expect(tool.description).toMatch(/multi[- ]?select/i);
  });

  it("parameter schema enforces exactly 2-4 preset options", () => {
    const tool = registerQuestion();
    const optionsSchema = (
      tool.parameters as {
        properties: { options: { minItems: number; maxItems: number; description: string } };
      }
    ).properties.options;
    expect(optionsSchema.minItems).toBe(2);
    expect(optionsSchema.maxItems).toBe(4);
    expect(optionsSchema.description).toMatch(/2-4/);
  });

  it("rejects a single preset option", async () => {
    const tool = registerQuestion();
    await expect(
      tool.execute(
        "tc",
        { question: "Pick one", options: [{ label: "Only" }] },
        undefined,
        undefined,
        noUICtx(),
      ),
    ).rejects.toThrow(/2-4 preset options/);
  });

  it("rejects five preset options", async () => {
    const tool = registerQuestion();
    await expect(
      tool.execute(
        "tc",
        {
          question: "Pick one",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }],
        },
        undefined,
        undefined,
        noUICtx(),
      ),
    ).rejects.toThrow(/2-4 preset options/);
  });

  it("accepts exactly two preset options and surfaces a non-interactive fallback", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      undefined,
      undefined,
      noUICtx(),
    );
    expect(Array.isArray(result.content)).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Pick one");
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  it("non-interactive fallback reports interaction: 'nonInteractive' and empty selectedLabels", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      { question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      undefined,
      undefined,
      noUICtx(),
    );
    const details = result.details as {
      interaction: string;
      selectedLabels: string[];
      options: unknown[];
    };
    expect(details.interaction).toBe("nonInteractive");
    expect(details.selectedLabels).toEqual([]);
    expect(details.options).toHaveLength(2);
  });

  it("single-select returns the selected label and interaction: 'preset'", async () => {
    const tool = registerQuestion();
    // Display strings: 'Right  (recommended) — feels right' etc.
    const result = await tool.execute(
      "tc",
      {
        question: "Pick one",
        header: "Size",
        options: [
          { label: "Right", description: "feels right", recommended: true },
          { label: "Wrong", description: "feels off" },
        ],
      },
      undefined,
      undefined,
      scriptedCtx([{ select: "Right  (recommended) — feels right" }]),
    );
    const details = result.details as { interaction: string; selectedLabels: string[] };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["Right"]);
  });

  it("recommended option is shown first in the select list", async () => {
    const tool = registerQuestion();
    const seen: string[][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          seen.push(options);
          return options[0];
        },
      },
    } as unknown as ExtensionContext;
    await tool.execute(
      "tc",
      {
        question: "Pick one",
        options: [{ label: "Second" }, { label: "First", recommended: true }],
      },
      undefined,
      undefined,
      ctx,
    );
    const firstSelectOptions = seen[0]!;
    // First option in the displayed list is the recommended one
    expect(firstSelectOptions[0]).toMatch(/First/);
    expect(firstSelectOptions[0]).toMatch(/recommended/);
  });

  it("single-select free prose returns the typed answer and interaction: 'freeProse'", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      {
        question: "What now?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      undefined,
      undefined,
      scriptedCtx([
        { select: "✎ Type your answer — Write a custom response" },
        { editor: "  something custom  " },
      ]),
    );
    const details = result.details as {
      interaction: string;
      freeText?: string;
      selectedLabels: string[];
    };
    expect(details.interaction).toBe("freeProse");
    expect(details.freeText).toBe("something custom");
    expect(details.selectedLabels).toEqual([]);
  });

  it("multi-select collects several preset picks and reports interaction: 'preset'", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      {
        question: "Pick any",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      },
      undefined,
      undefined,
      scriptedCtx([{ select: "A" }, { select: "B" }, { select: "✓ Done" }]),
    );
    const details = result.details as { interaction: string; selectedLabels: string[] };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["A", "B"]);
  });

  it("multi-select with free prose includes the typed answer alongside preset labels", async () => {
    const tool = registerQuestion();
    const result = await tool.execute(
      "tc",
      {
        question: "Pick any",
        multiSelect: true,
        options: [{ label: "A" }, { label: "B" }],
      },
      undefined,
      undefined,
      scriptedCtx([
        { select: "✎ Type your answer — Write a custom response" },
        { editor: "my own" },
        { select: "A" },
        { select: "✓ Done" },
      ]),
    );
    const details = result.details as {
      interaction: string;
      selectedLabels: string[];
      freeText?: string;
    };
    expect(details.interaction).toBe("preset");
    expect(details.selectedLabels).toEqual(["A"]);
    expect(details.freeText).toBe("my own");
  });
});